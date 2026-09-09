import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../../db/client.js";
import { pricingRules } from "../../db/schema.js";
import { DrizzleCapabilityTierRepository } from "./repository.js";
import { CapabilityTierService } from "./service.js";

const databaseUrl = process.env.CAPABILITY_TIERS_TEST_DATABASE_URL;

test("能力档仓储只读取当前有效价格行，并由同一行 metadata 投影参数和状态", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const prefix = `capability-tier-${randomUUID()}`;
  const at = new Date("2026-07-23T00:00:00.000Z");
  const createdIds: string[] = [];

  const insert = async (input: {
    mediaKind: "image" | "video";
    model: string;
    billingUnit: "image" | "second";
    unitPriceFen: number;
    active: boolean;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    metadata: Record<string, unknown>;
  }) => {
    const id = randomUUID();
    createdIds.push(id);
    await handle.db.insert(pricingRules).values({
      id,
      provider: "ark",
      model: input.model,
      mediaKind: input.mediaKind,
      billingUnit: input.billingUnit,
      unitPriceFen: input.unitPriceFen,
      currency: "CNY",
      source: "capability-tier-db-test",
      active: input.active,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      metadata: input.metadata,
      createdAt: at,
      updatedAt: at,
    });
  };

  try {
    await insert({
      mediaKind: "image",
      model: `${prefix}-image`,
      billingUnit: "image",
      unitPriceFen: 60,
      active: true,
      effectiveFrom: new Date("2026-07-22T00:00:00.000Z"),
      metadata: {
        capability_tier: {
          tier_id: "img-seedream5-169-2k-1",
          params: { aspect_ratio: "16:9", resolution: "2K", quantity: 1 },
          status: "active",
        },
      },
    });
    await insert({
      mediaKind: "image",
      model: `${prefix}-experimental`,
      billingUnit: "image",
      unitPriceFen: 70,
      active: true,
      effectiveFrom: new Date("2026-07-22T00:00:00.000Z"),
      metadata: {
        capability_tier: { tier_id: "img-experimental", params: {}, status: "experimental" },
      },
    });
    await insert({
      mediaKind: "image",
      model: `${prefix}-expired`,
      billingUnit: "image",
      unitPriceFen: 99,
      active: true,
      effectiveFrom: new Date("2026-07-20T00:00:00.000Z"),
      effectiveTo: new Date("2026-07-21T00:00:00.000Z"),
      metadata: {
        capability_tier: { tier_id: "img-expired", params: {}, status: "active" },
      },
    });
    await insert({
      mediaKind: "video",
      model: `${prefix}-video`,
      billingUnit: "second",
      unitPriceFen: 80,
      active: true,
      effectiveFrom: new Date("2026-07-22T00:00:00.000Z"),
      metadata: {
        capability_tier: { tier_id: "vid-seedance20fast-916-720p-4s", params: { duration_seconds: 4 }, status: "active" },
      },
    });

    const tiers = await new CapabilityTierService(new DrizzleCapabilityTierRepository(handle.db)).listActive("image", at);
    assert.deepEqual(tiers, [{
      tierId: "img-seedream5-169-2k-1",
      mediaType: "image",
      displayName: `${prefix} image`,
      providerLabel: "火山方舟",
      modelLabel: `${prefix} image`,
      isDefault: true,
      availability: "available",
      capabilities: ["image", "aspect_ratio", "resolution"],
      params: { aspect_ratio: "16:9", resolution: "2K", quantity: 1 },
      price: { unit: "per_image", points: 60 },
      status: "active",
    }]);
  } finally {
    for (const id of createdIds) {
      await handle.db.delete(pricingRules).where(eq(pricingRules.id, id)).catch(() => undefined);
    }
    await handle.pool.end();
  }
});
