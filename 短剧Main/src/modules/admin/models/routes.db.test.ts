import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { asc, eq } from "drizzle-orm";
import Fastify from "fastify";
import { createDatabase } from "../../../db/client.js";
import { pricingRules } from "../../../db/schema.js";
import { registerAdminModelRoutes } from "./routes.js";

const databaseUrl = process.env.ADMIN_MODELS_TEST_DATABASE_URL;

test("管理员追加新价格会关闭旧行并完整保留旧价格历史", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const model = `admin-model-${randomUUID()}`;
  const oldId = randomUUID();
  const oldEffectiveFrom = new Date("2026-07-20T00:00:00.000Z");
  const adminId = "11111111-1111-4111-8111-111111111111";
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: adminId, username: "model.admin", displayName: "模型管理员" };
  });

  try {
    await handle.db.insert(pricingRules).values({
      id: oldId,
      provider: "ark",
      model,
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 60,
      currency: "CNY",
      source: "original-contract",
      active: true,
      effectiveFrom: oldEffectiveFrom,
      effectiveTo: null,
      metadata: { source_record: "original" },
      createdAt: oldEffectiveFrom,
      updatedAt: oldEffectiveFrom,
    });
    await registerAdminModelRoutes(app, () => handle.db, { adminUsernames: ["model.admin"] });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pricing-rules",
      payload: {
        provider: "ark",
        model,
        media_kind: "image",
        billing_unit: "image",
        unit_price_fen: 70,
        currency: "CNY",
        expected_active_rule_id: oldId,
        source: "new-contract",
      },
    });
    assert.equal(created.statusCode, 201, created.body);

    const rows = await handle.db.select().from(pricingRules)
      .where(eq(pricingRules.model, model))
      .orderBy(asc(pricingRules.effectiveFrom));
    assert.equal(rows.length, 2);
    const replacementEffectiveFrom = rows[1]?.effectiveFrom;
    assert.ok(replacementEffectiveFrom);
    assert.deepEqual({
      id: rows[0]?.id,
      unitPriceFen: rows[0]?.unitPriceFen,
      currency: rows[0]?.currency,
      source: rows[0]?.source,
      metadata: rows[0]?.metadata,
      active: rows[0]?.active,
      effectiveTo: rows[0]?.effectiveTo?.toISOString(),
    }, {
      id: oldId,
      unitPriceFen: 60,
      currency: "CNY",
      source: "original-contract",
      metadata: { source_record: "original" },
      active: false,
      effectiveTo: replacementEffectiveFrom.toISOString(),
    });
    assert.equal(rows[1]?.unitPriceFen, 70);
    assert.equal(rows[1]?.active, true);
    assert.equal(rows[1]?.source, "new-contract");
    assert.deepEqual(rows[1]?.metadata, { updated_by_user_id: adminId });

    const history = await app.inject({ method: "GET", url: "/api/v1/admin/pricing-rules" });
    assert.equal(history.statusCode, 200, history.body);
    const matching = history.json().data.items.filter((item: { model: string }) => item.model === model);
    assert.equal(matching.length, 2);
    assert.deepEqual(matching.map((item: { unit_price_fen: number; active: boolean }) => [
      item.unit_price_fen,
      item.active,
    ]), [[70, true], [60, false]]);

    const staleWrite = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pricing-rules",
      payload: {
        provider: "ark",
        model,
        media_kind: "image",
        billing_unit: "image",
        unit_price_fen: 75,
        currency: "CNY",
        expected_active_rule_id: oldId,
      },
    });
    assert.equal(staleWrite.statusCode, 409, staleWrite.body);
    const unchangedRows = await handle.db.select().from(pricingRules).where(eq(pricingRules.model, model));
    assert.equal(unchangedRows.length, 2);
    assert.equal(unchangedRows.find((row) => row.active)?.unitPriceFen, 70);
  } finally {
    await handle.db.delete(pricingRules).where(eq(pricingRules.model, model)).catch(() => undefined);
    await app.close();
    await handle.pool.end();
  }
});
