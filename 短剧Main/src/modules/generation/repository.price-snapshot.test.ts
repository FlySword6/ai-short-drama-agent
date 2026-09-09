import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  attemptViewTierId,
  isLegacyUnpricedSnapshot,
  LEGACY_UNPRICED_TIER_ID,
  retryTierIdFromSnapshot,
} from "./repository.js";

const validSnapshot = {
  tierId: "img-seedream5pro-169-1k-1",
  pricingRuleId: "pricing-rule-1",
  provider: "ark",
  model: "doubao-seedream-5-0-pro-260628",
  mediaKind: "image",
  billingUnit: "image",
  unitPriceFen: 30,
  billableUnits: 1,
  estimatedCostFen: 30,
  currency: "CNY",
};

test("历史 attempt 的空 price_snapshot 可读，但不虚构档位或价格", () => {
  assert.equal(attemptViewTierId({}), LEGACY_UNPRICED_TIER_ID);
  assert.equal(isLegacyUnpricedSnapshot({}), true);
});

test("现行 attempt 仍从完整冻结快照读取真实 tier_id", () => {
  assert.equal(attemptViewTierId(validSnapshot), validSnapshot.tierId);
});

test("非空但损坏的 attempt price_snapshot 仍 fail closed", () => {
  assert.throws(
    () => attemptViewTierId({ tierId: validSnapshot.tierId }),
    /Generation quote price snapshot is invalid/,
  );
});

test("历史空快照不可进入付费重试，并返回可操作的受控冲突", () => {
  assert.throws(
    () => retryTierIdFromSnapshot({}),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "GENERATION_STATE_CONFLICT");
      assert.equal((error as { statusCode?: unknown }).statusCode, 409);
      return true;
    },
  );
  assert.equal(retryTierIdFromSnapshot(validSnapshot), validSnapshot.tierId);
});

test("付费提交必须原子赢得 created 到 submitting，旧空快照不得进入 worker", async () => {
  const source = await readFile(new URL("./repository.ts", import.meta.url), "utf8");
  assert.match(source, /row\.attempt\.phase !== "created"/);
  assert.match(source, /eq\(generationAttempts\.phase, "created"\)/);
  assert.match(source, /generationAttempts\.priceSnapshot\} <> '\{\}'::jsonb/);
});
