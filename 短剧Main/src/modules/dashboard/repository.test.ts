import assert from "node:assert/strict";
import test from "node:test";
import { DrizzleDashboardRepository, isPublicUnitPriceRecord } from "./repository.js";

const inaccessibleDatabase = new Proxy({}, {
  get() {
    throw new Error("无效单价不应访问数据库");
  },
});

test("global unit prices must be positive integer fen values", async () => {
  const repository = new DrizzleDashboardRepository(inaccessibleDatabase as never);
  for (const unitPriceFen of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      repository.replaceUnitPrice("user-1", {
        provider: "ark",
        model: "seedream-test",
        mediaKind: "image",
        billingUnit: "image",
        unitPriceFen,
        currency: "CNY",
      }),
      (error: unknown) => hasError(error, "invalid_request", 400),
    );
  }
});

test("global unit price billing units must match the media kind", async () => {
  const repository = new DrizzleDashboardRepository(inaccessibleDatabase as never);
  await assert.rejects(
    repository.replaceUnitPrice("user-1", {
      provider: "ark",
      model: "seedance-test",
      mediaKind: "video",
      billingUnit: "image",
      unitPriceFen: 80,
      currency: "CNY",
    }),
    (error: unknown) => hasError(error, "invalid_request", 400),
  );
});

test("登录可读的全站单价投影隐藏 S58 历史 active 推算行", () => {
  assert.equal(isPublicUnitPriceRecord({
    metadata: {
      price_source_kind: "官方牌价×加成率(推算)",
      capability_tier: { status: "active" },
    },
  }), false);
  assert.equal(isPublicUnitPriceRecord({
    metadata: {
      price_source_kind: "实测",
      capability_tier: { status: "active" },
    },
  }), true);
  assert.equal(isPublicUnitPriceRecord({ metadata: {} }), true);
});

test("listUnitPrices 不返回数据库里残留 active 的 S58 推算行", async () => {
  const now = new Date("2026-07-27T00:00:00.000Z");
  const base = {
    provider: "ark",
    model: "doubao-seedream-5-0-pro-260628",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 60,
    currency: "CNY",
    source: "seed:s58:scripts/seed-pricing-tiers.mts",
    active: true,
    effectiveFrom: now,
    effectiveTo: null,
    createdAt: now,
    updatedAt: now,
  };
  const rows = [
    {
      ...base,
      id: "stale-inferred",
      metadata: { price_source_kind: "官方牌价×加成率(推算)" },
    },
    {
      ...base,
      id: "legacy-actual",
      metadata: { price_source_kind: "实测" },
    },
  ];
  const database = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  };
  const repository = new DrizzleDashboardRepository(database as never);

  assert.deepEqual((await repository.listUnitPrices()).map((row) => row.id), ["legacy-actual"]);
});

function hasError(error: unknown, code: string, statusCode: number): boolean {
  return error instanceof Error
    && "code" in error
    && "statusCode" in error
    && error.code === code
    && error.statusCode === statusCode;
}
