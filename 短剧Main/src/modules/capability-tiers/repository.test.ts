import assert from "node:assert/strict";
import test from "node:test";
import { capabilityTierFromPricingRule, capabilityTiersFromPricingRules } from "./repository.js";
import type { ActivePricingRuleRecord } from "./types.js";

const now = new Date("2026-07-23T00:00:00.000Z");

test("能力档从当前 pricing_rules 元数据投影，价格不复制进第二套配置", () => {
  const tier = capabilityTierFromPricingRule(rule({
    provider: "ark",
    model: "doubao-seedream-5-0-pro-260628",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 60,
    metadata: {
      price_source_kind: "实测",
      capability_tier: {
        tier_id: "img-seedream5pro-169-2k-1",
        params: {
          aspect_ratio: "16:9",
          resolution: "2K",
          watermark: false,
          sequential_image_generation: "disabled",
          quantity: 1,
        },
        status: "active",
      },
    },
  }));
  assert.deepEqual(tier, {
    tierId: "img-seedream5pro-169-2k-1",
    mediaType: "image",
    displayName: "seedream 5 0 pro",
    providerLabel: "火山方舟",
    modelLabel: "seedream 5 0 pro",
    isDefault: false,
    availability: "available",
    availabilityReason: "已完成官方价格核验、逐档实测与账单核对",
    capabilities: ["image", "aspect_ratio", "resolution", "sequential_image_generation"],
    officialPriceSource: "https://www.volcengine.com/docs/82379/1544106",
    params: {
      aspect_ratio: "16:9",
      resolution: "2K",
      watermark: false,
      sequential_image_generation: "disabled",
      quantity: 1,
    },
    price: { unit: "per_image", points: 60 },
    status: "active",
  });
});

test("实验档带冻结原因投影，缺元数据和媒体计费不匹配仍拒绝", () => {
  const frozen = capabilityTierFromPricingRule(rule({
    metadata: { capability_tier: { tier_id: "img-hidden", params: {}, status: "experimental" } },
  }));
  assert.equal(frozen?.status, "experimental");
  assert.equal(frozen?.availability, "pricing_unverified");
  assert.equal(capabilityTierFromPricingRule(rule({ metadata: {} })), null);
  assert.equal(capabilityTierFromPricingRule(rule({ mediaKind: "video", billingUnit: "image" })), null);
});

test("异常重叠的当前价格规则按查询顺序保留最新档，避免同一 tier 重复返回", () => {
  const metadata = {
    price_source_kind: "实测",
    capability_tier: {
      tier_id: "vid-seedance20fast-916-720p-4s",
      params: {
        aspect_ratio: "9:16",
        resolution: "720p",
        duration_seconds: 4,
        watermark: false,
        quantity: 1,
      },
      status: "active",
    },
  };
  const tiers = capabilityTiersFromPricingRules([
    rule({
      id: "new",
      provider: "ark",
      model: "doubao-seedance-2-0-fast-260128",
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 80,
      metadata,
    }),
    rule({
      id: "old",
      provider: "ark",
      model: "doubao-seedance-2-0-fast-260128",
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 90,
      metadata,
    }),
  ]);
  assert.equal(tiers.length, 1);
  assert.equal(tiers[0]?.price.points, 80);
});

test("音频能力档只接受按秒计费，并保持 per_second 对外语义", () => {
  const tier = capabilityTierFromPricingRule(rule({
    provider: "openspeech",
    model: "seed-audio-1.0",
    mediaKind: "audio",
    billingUnit: "second",
    unitPriceFen: 12,
    metadata: {
      price_source_kind: "内部定价",
      capability_tier: {
        tier_id: "aud-seedaudio10-30s",
        params: { original_duration_seconds: 30 },
        status: "active",
      },
    },
  }));
  assert.deepEqual(tier, {
    tierId: "aud-seedaudio10-30s",
    mediaType: "audio",
    displayName: "seed audio 1.0",
    providerLabel: "火山语音",
    modelLabel: "seed audio 1.0",
    isDefault: false,
    availability: "available",
    availabilityReason: "已完成官方价格核验、逐档实测与账单核对",
    capabilities: ["audio", "original_duration_seconds"],
    params: { original_duration_seconds: 30 },
    price: { unit: "per_second", points: 12 },
    status: "active",
  });
  assert.equal(capabilityTierFromPricingRule(rule({ mediaKind: "audio", billingUnit: "image" })), null);
});

function rule(overrides: Partial<ActivePricingRuleRecord> = {}): ActivePricingRuleRecord {
  return {
    id: "rule-id",
    provider: "ark",
    model: "doubao-seedream-5-0-pro-260628",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 60,
    metadata: {
      capability_tier: { tier_id: "img-seedream5pro-169-2k-1", params: {}, status: "active" },
    },
    effectiveFrom: now,
    ...overrides,
  };
}
