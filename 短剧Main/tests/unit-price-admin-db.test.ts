import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { pricingRules, sessions, users } from "../src/db/schema.js";
import { hashSessionToken } from "../src/modules/auth/service.js";

const databaseUrl = process.env.UNIT_PRICE_ADMIN_TEST_DATABASE_URL;

test("只有显式管理员能修改正数全局单价", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const db = handle.db;
  const now = new Date();
  const adminId = randomUUID();
  const regularId = randomUUID();
  const adminToken = `price-admin-${randomUUID()}`;
  const regularToken = `price-user-${randomUUID()}`;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;

  try {
    await db.insert(users).values([
      userValues(adminId, "price-admin", now),
      userValues(regularId, "price-user", now),
    ]);
    await db.insert(sessions).values([
      sessionValues(adminId, adminToken, now),
      sessionValues(regularId, regularToken, now),
    ]);
    app = await createApp({ databaseHandle: handle, logger: false, startGenerationWorker: false });

    const input = {
      provider: "ark",
      model: "seedream-admin-test",
      media_kind: "image",
      billing_unit: "image",
      unit_price_fen: 25,
      currency: "CNY",
    };

    const regular = await put(app, regularToken, input);
    assert.equal(regular.statusCode, 403, regular.body);
    assert.equal((await db.select().from(pricingRules)).length, 0);

    const zero = await put(app, adminToken, { ...input, unit_price_fen: 0 });
    assert.equal(zero.statusCode, 400, zero.body);
    assert.equal((await db.select().from(pricingRules)).length, 0);

    const valid = await put(app, adminToken, input);
    assert.equal(valid.statusCode, 200, valid.body);
    assert.equal((await db.select().from(pricingRules)).length, 1);
  } finally {
    await app?.close();
    await handle.pool.end();
  }
});

function userValues(id: string, username: string, now: Date) {
  return {
    id,
    username,
    displayName: username,
    passwordHash: "test-only-hash",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

function sessionValues(userId: string, token: string, now: Date) {
  return {
    id: randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    credentialSource: "web" as const,
    agentType: null,
    userAgent: "unit-price-admin-db-test",
    credentialLabel: null,
    issuedBySessionId: null,
    expiresAt: new Date(now.getTime() + 60 * 60_000),
    revokedAt: null,
    createdAt: now,
  };
}

function put(
  app: Awaited<ReturnType<typeof createApp>>,
  token: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/cost-settings/unit-prices",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
