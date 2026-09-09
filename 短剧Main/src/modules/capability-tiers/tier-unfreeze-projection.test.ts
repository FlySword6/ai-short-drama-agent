import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityTierFromPricingRule,
  capabilityTiersFromPricingRules,
} from "./repository.js";
import type { ActivePricingRuleRecord } from "./types.js";

const at = new Date("2026-08-06T00:00:00.000Z");

test("tier-unfreeze:能力档接口同时投影可用档和带中文冻结原因的灰档", () => {
  const available = capabilityTierFromPricingRule(rule({
    id: "available",
    active: true,
    unitPriceFen: 40,
    metadata: {
      activation_scope: "dev_smoke_only",
      price_source_kind: "待核",
      capability_tier: {
        tier_id: "vid-seedance20fast-169-480p",
        params: {
          aspect_ratio: "16:9",
          resolution: "480p",
          duration_seconds: 4,
          watermark: false,
          generate_audio: false,
          quantity: 1,
        },
        status: "active",
      },
    },
  }));
  assert.equal(available?.status, "experimental");
  assert.equal(available?.availability, "dev_smoke_only");
  assert.match(available?.availabilityReason ?? "", /不能进入普通用户报价链/);

  const frozen = capabilityTierFromPricingRule(rule({
    id: "frozen",
    active: false,
    unitPriceFen: 40,
    metadata: {
      price_source_kind: "官方牌价×加成率(推算)",
      capability_tier: {
        tier_id: "vid-seedance20fast-916-480p",
        params: {
          aspect_ratio: "9:16",
          resolution: "480p",
          watermark: false,
          generate_audio: false,
          quantity: 1,
        },
        status: "experimental",
      },
    },
  }));
  assert.equal(frozen?.status, "experimental");
  assert.equal(frozen?.availability, "billing_unverified");
  assert.match(frozen?.availabilityReason ?? "", /账单核对/);
});

test("tier-unfreeze:供应商未开通与参数矩阵未核分别投影，不再共用布尔值", () => {
  const providerBlocked = capabilityTierFromPricingRule(rule({
    provider: "newapi",
    model: "gpt-image-2",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 0,
    active: false,
    metadata: {
      capability_tier: {
        tier_id: "img-newapi-gptimage2-11-1k-low",
        params: { aspect_ratio: "1:1", resolution: "1K", quantity: 1 },
        status: "experimental",
      },
    },
  }));
  assert.equal(providerBlocked?.availability, "provider_not_enabled");
  assert.equal(providerBlocked?.availabilityReason, "该供应商未开通公司账户");

  const arkBillingPending = capabilityTierFromPricingRule(rule({
    model: "doubao-seedance-2-0-260128",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 50,
    active: false,
    metadata: {
      capability_tier: {
        tier_id: "vid-seedance20-169-480p",
        params: {
          aspect_ratio: "16:9",
          resolution: "480p",
          duration_seconds: 4,
          generate_audio: false,
          watermark: false,
          quantity: 1,
        },
        status: "experimental",
      },
    },
  }));
  assert.equal(arkBillingPending?.availability, "billing_unverified");
  assert.equal(
    arkBillingPending?.availabilityReason,
    "官方价格已匹配，尚未完成本档实测与账单核对",
  );

  const arkPriceDrift = capabilityTierFromPricingRule(rule({
    model: "doubao-seedance-2-0-260128",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 180,
    active: false,
    metadata: {
      capability_tier: {
        tier_id: "vid-seedance20-169-480p",
        params: {
          aspect_ratio: "16:9",
          resolution: "480p",
          watermark: false,
          generate_audio: false,
          quantity: 1,
        },
        status: "experimental",
      },
    },
  }));
  assert.equal(arkPriceDrift?.availability, "pricing_unverified");
  assert.match(arkPriceDrift?.availabilityReason ?? "", /应为 50 积分/);

  const matrixPending = capabilityTierFromPricingRule(rule({
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 60,
    active: false,
    metadata: {
      capability_tier: {
        tier_id: "img-seedream5pro-916-2k-1",
        params: {
          aspect_ratio: "9:16",
          resolution: "4K",
          watermark: false,
          sequential_image_generation: "disabled",
          quantity: 1,
        },
        status: "experimental",
      },
    },
  }));
  assert.equal(matrixPending?.availability, "parameter_matrix_unverified");
});

test("tier-unfreeze:默认档只在 active 集合内选择，便宜灰档不会抢默认", () => {
  const tiers = capabilityTiersFromPricingRules([
    rule({
      id: "frozen-cheap",
      active: false,
      unitPriceFen: 1,
      metadata: {
        tier_availability: { code: "pricing_unverified", reason: "尚未定价" },
        capability_tier: {
          tier_id: "img-unknown-cheap",
          params: { quantity: 1 },
          status: "experimental",
          is_default: true,
        },
      },
    }),
    rule({
      id: "active-legacy",
      model: "doubao-seedream-5-0-pro-260628",
      mediaKind: "image",
      billingUnit: "image",
      active: true,
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
    }),
  ]);
  assert.equal(tiers.length, 2);
  assert.equal(tiers.find((tier) => tier.status === "active")?.isDefault, true);
  assert.equal(tiers.find((tier) => tier.status !== "active")?.isDefault, false);
});

test("尾帧延长废案档不投影给任何调用方", () => {
  const retired = capabilityTierFromPricingRule(rule({
    id: "retired-tail-frame",
    metadata: {
      price_source_kind: "实测",
      capability_tier: {
        tier_id: "vid-seedance20fast-916-720p-4s-lf",
        params: {
          aspect_ratio: "9:16",
          resolution: "720p",
          duration_seconds: 4,
          watermark: false,
          quantity: 1,
        },
        status: "active",
      },
    },
  }));
  assert.equal(retired, null);
});

function rule(overrides: Partial<ActivePricingRuleRecord> = {}): ActivePricingRuleRecord {
  return {
    id: "rule",
    provider: "ark",
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
    active: true,
    metadata: {},
    effectiveFrom: at,
    ...overrides,
  };
}
