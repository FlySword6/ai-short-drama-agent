import assert from "node:assert/strict";
import test from "node:test";
import {
  ARK_TIER_PRICE_CATALOG_VERSION,
  arkTierPriceDefinition,
  assessTierPricingRule,
  pricingVerificationMetadata,
} from "./tierPricingGuard.js";

const ACTIVE_EVIDENCE = {
  batch_id: "ark-common-cheapest-v1",
  evidence_sha256: "a".repeat(64),
  provider_task_fingerprint: "b".repeat(16),
  artifact_sha256: "c".repeat(64),
  provider_billing_reference: "ark-billing:reviewed-row-1",
  guard_deployed_commit: "d".repeat(40),
  smoke_completed_at: "2026-08-06T02:00:00.000Z",
  account_checked_at: "2026-08-06T02:10:00.000Z",
  platform_list_price_fen: 160,
  provider_billed_fen: 148.65,
};

test("tier-unfreeze:低于旧 80 分的 Fast 480p 按官方逐档公式通过", () => {
  const definition = arkTierPriceDefinition("vid-seedance20fast-169-480p");
  assert.ok(definition);
  assert.equal(definition.catalogVersion, ARK_TIER_PRICE_CATALOG_VERSION);
  assert.equal(definition.officialCostFenPerUnit, 37.1628);
  assert.equal(definition.platformUnitPriceFen, 40);

  const result = assessTierPricingRule(fast480Rule({
    price_source_kind: "实测",
    pricing_verification: pricingVerificationMetadata(definition),
    activation_evidence: ACTIVE_EVIDENCE,
  }));
  assert.deepEqual(result, {
    code: "available",
    reason: "已完成官方价格核验、逐档实测与账单核对",
    quoteable: true,
    expectedUnitPriceFen: 40,
    officialCostFenPerUnit: 37.1628,
    priceCatalogVersion: ARK_TIER_PRICE_CATALOG_VERSION,
  });
});

test("tier-unfreeze:同一 tier 自报低价、错模型或缺实测账证均 fail-closed", () => {
  const wrongPrice = assessTierPricingRule({ ...fast480Rule(), unitPriceFen: 39 });
  assert.equal(wrongPrice.quoteable, false);
  assert.equal(wrongPrice.code, "pricing_unverified");
  assert.equal(wrongPrice.expectedUnitPriceFen, 40);

  const wrongModel = assessTierPricingRule({
    ...fast480Rule(),
    model: "doubao-seedance-2-0-mini-260615",
  });
  assert.equal(wrongModel.quoteable, false);
  assert.equal(wrongModel.code, "parameter_matrix_unverified");

  const missingEvidence = assessTierPricingRule(fast480Rule({
    price_source_kind: "实测",
  }));
  assert.equal(missingEvidence.quoteable, false);
  assert.equal(missingEvidence.code, "billing_unverified");
});

test("tier-unfreeze:推算价不因 active 标志误入报价，开发冒烟例外仍受官方目录约束", () => {
  const inferred = assessTierPricingRule(fast480Rule({
    price_source_kind: "官方牌价×加成率(推算)",
  }));
  assert.equal(inferred.quoteable, false);
  assert.equal(inferred.code, "billing_unverified");

  const devSmoke = assessTierPricingRule(fast480Rule({
    price_source_kind: "待核",
    activation_scope: "dev_smoke_only",
  }), { allowDevSmoke: true });
  assert.equal(devSmoke.quoteable, true);
  assert.equal(devSmoke.code, "dev_smoke_only");

  const ordinaryRuntime = assessTierPricingRule(fast480Rule({
    price_source_kind: "待核",
    activation_scope: "dev_smoke_only",
  }));
  assert.equal(ordinaryRuntime.quoteable, false);
  assert.equal(ordinaryRuntime.code, "dev_smoke_only");

  const fakeDevSmoke = assessTierPricingRule({
    ...fast480Rule({
      price_source_kind: "待核",
      activation_scope: "dev_smoke_only",
    }),
    unitPriceFen: 1,
  }, { allowDevSmoke: true });
  assert.equal(fakeDevSmoke.quoteable, false);
  assert.equal(fakeDevSmoke.code, "pricing_unverified");
});

test("tier-unfreeze:正式档逐项缺失账证时保持冻结", () => {
  for (const key of [
    "provider_task_fingerprint",
    "artifact_sha256",
    "provider_billing_reference",
    "guard_deployed_commit",
  ] as const) {
    const activationEvidence: Record<string, unknown> = { ...ACTIVE_EVIDENCE };
    delete activationEvidence[key];
    const result = assessTierPricingRule(fast480Rule({
      price_source_kind: "实测",
      activation_evidence: activationEvidence,
    }));
    assert.equal(result.quoteable, false, key);
    assert.equal(result.code, "billing_unverified", key);
  }
});

test("tier-unfreeze:档位 ID 与官方参数矩阵不一致时保持冻结，不猜价", () => {
  const result = assessTierPricingRule({
    provider: "ark",
    model: "doubao-seedream-5-0-pro-260628",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 60,
    active: true,
    metadata: {
      price_source_kind: "实测",
      activation_evidence: ACTIVE_EVIDENCE,
      capability_tier: {
        tier_id: "img-seedream5pro-916-2k-1",
        status: "active",
        params: {
          aspect_ratio: "9:16",
          resolution: "4K",
          watermark: false,
          sequential_image_generation: "disabled",
          quantity: 1,
        },
      },
    },
  });
  assert.equal(result.quoteable, false);
  assert.equal(result.code, "parameter_matrix_unverified");
});

test("tier-unfreeze:旧正式档继续按自身目录价兼容，不把 80 分抬到其他 tier", () => {
  const legacy = assessTierPricingRule({
    provider: "ark",
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
    active: true,
    metadata: {
      price_source_kind: "实测",
      capability_tier: {
        tier_id: "vid-seedance20fast-916-720p-4s",
        status: "active",
        params: {
          aspect_ratio: "9:16",
          resolution: "720p",
          duration_seconds: 4,
          watermark: false,
          generate_audio: false,
          quantity: 1,
        },
      },
    },
  });
  assert.equal(legacy.quoteable, true);
  assert.equal(legacy.expectedUnitPriceFen, 80);
});

test("tier-unfreeze:Ark 护栏不反向冻结既有非 Ark 公司档", () => {
  const existingSeedAudio = assessTierPricingRule({
    provider: "openspeech",
    model: "seed-audio-existing-deployment",
    mediaKind: "audio",
    billingUnit: "second",
    unitPriceFen: 23,
    active: true,
    metadata: {
      capability_tier: {
        tier_id: "aud-seed-audio-existing-2s",
        status: "active",
        params: {
          original_duration_seconds: 2,
          format: "mp3",
          sample_rate: 24000,
          quantity: 1,
        },
      },
    },
  });
  assert.equal(existingSeedAudio.quoteable, true);
  assert.equal(existingSeedAudio.code, "available");

  const inferred = assessTierPricingRule({
    ...existingSeedAudioRule(),
    metadata: {
      ...existingSeedAudioRule().metadata,
      price_source_kind: "官方牌价×加成率(推算)",
    },
  });
  assert.equal(inferred.quoteable, false);
  assert.equal(inferred.code, "billing_unverified");

  const unknown = assessTierPricingRule({
    ...existingSeedAudioRule(),
    provider: "unknown-provider",
  });
  assert.equal(unknown.quoteable, false);
  assert.equal(unknown.code, "provider_not_enabled");
});

function fast480Rule(extraMetadata: Record<string, unknown> = {}) {
  return {
    provider: "ark",
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video" as const,
    billingUnit: "second",
    unitPriceFen: 40,
    active: true,
    metadata: {
      capability_tier: {
        tier_id: "vid-seedance20fast-169-480p",
        status: "active",
        params: {
          aspect_ratio: "16:9",
          resolution: "480p",
          duration_seconds: 4,
          watermark: false,
          generate_audio: false,
          quantity: 1,
        },
      },
      ...extraMetadata,
    },
  };
}

function existingSeedAudioRule() {
  return {
    provider: "openspeech",
    model: "seed-audio-existing-deployment",
    mediaKind: "audio" as const,
    billingUnit: "second",
    unitPriceFen: 23,
    active: true,
    metadata: {
      capability_tier: {
        tier_id: "aud-seed-audio-existing-2s",
        status: "active" as const,
        params: {
          original_duration_seconds: 2,
          format: "mp3",
          sample_rate: 24000,
          quantity: 1,
        },
      },
    },
  };
}
