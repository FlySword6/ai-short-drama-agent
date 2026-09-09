import assert from "node:assert/strict";
import test from "node:test";
import {
  requireTierMatchesInput,
  resolveTierFromPricingRule,
  resolveTierFromPricingRules,
  type ResolvedGenerationTier,
  type TierPricingRule,
} from "./capabilityTiers.js";
import type { TierPricingGuardContext } from "./tierPricingGuard.js";

const audioTier: ResolvedGenerationTier = {
  tierId: "aud-seedaudio10-12s",
  rule: {
    id: "audio-rule",
    provider: "openspeech",
    model: "deployment-selected-audio-model",
    mediaKind: "audio",
    billingUnit: "second",
    unitPriceFen: 23,
    metadata: {},
  },
  parameters: {
    originalDurationSeconds: 12,
    format: "mp3",
    sampleRate: 24_000,
    enableSubtitle: true,
    aigcMetadataEnabled: true,
    aigcWatermarkEnabled: false,
  },
  quantity: 1,
};

test("音频档固定计费/格式，仍允许用户调整声音滑杆和音色", () => {
  assert.doesNotThrow(() => requireTierMatchesInput(audioTier, {
    tierId: audioTier.tierId,
    mediaKind: "audio",
    model: audioTier.rule.model,
    quantity: 1,
    parameters: {
      ...audioTier.parameters,
      speakerId: "voice-catalog-id",
      speechRate: 37,
      loudnessRate: -12,
      pitchRate: 4,
    },
  }));

  assert.throws(() => requireTierMatchesInput(audioTier, {
    tierId: audioTier.tierId,
    mediaKind: "audio",
    model: audioTier.rule.model,
    quantity: 1,
    parameters: { ...audioTier.parameters, originalDurationSeconds: 13 },
  }), /参数必须与所选档位完全一致/);
});

test("同模型最新行为历史推算档时,仍按 tier_id 选中旧实测档", () => {
  const model = "doubao-seedance-2-0-fast-260128";
  const staleInferred: TierPricingRule = {
    id: "newer-stale-inferred",
    provider: "ark",
    model,
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
    metadata: {
      price_source_kind: "官方牌价×加成率(推算)",
      capability_tier: {
        tier_id: "vid-seedance20fast-169-720p",
        params: { aspect_ratio: "16:9", resolution: "720p", quantity: 1, watermark: false },
        status: "active",
      },
    },
  };
  const legacyActual: TierPricingRule = {
    id: "older-legacy-actual",
    provider: "ark",
    model,
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
    metadata: {
      price_source_kind: "实测",
      capability_tier: {
        tier_id: "vid-seedance20fast-916-720p-4s",
        params: {
          aspect_ratio: "9:16",
          resolution: "720p",
          duration_seconds: 4,
          quantity: 1,
          watermark: false,
        },
        status: "active",
      },
    },
  };

  const selected = resolveTierFromPricingRules(
    [staleInferred, legacyActual],
    { model, tierId: "vid-seedance20fast-916-720p-4s" },
  );
  assert.equal(selected?.rule.id, "older-legacy-actual");
  assert.equal(selected?.tierId, "vid-seedance20fast-916-720p-4s");
  assert.equal(resolveTierFromPricingRules([staleInferred], { model }), null);
});

test("尾帧延长废案档即使数据库残留 active 行也不能进入报价", () => {
  const retired: TierPricingRule = {
    id: "retired-tail-frame",
    provider: "ark",
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
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
  };
  assert.equal(
    resolveTierFromPricingRules([retired], { tierId: "vid-seedance20fast-916-720p-4s-lf" }),
    null,
  );
});

/* happyhorse 预览集成 §2.1 + 2026-08-19 参数化裁定:预览档 params 里的 preview=true 经
   providerParameters 成为 GenerationParameters 合法字段;预览视频档（params.preview=true）
   走 sameVideoPreviewTierParameters——preview/watermark 冻结，比例/清晰度/时长可在快乐马
   能力内调整（上游 normalizeV01Parameters 已按 VIDEO_CAPABILITIES 校验）；正式档仍严格全量比对。 */
const previewGuardContext: TierPricingGuardContext = { companyProviderAllowlist: ["happyhorse"] };

const previewTierRule: TierPricingRule = {
  id: "happyhorse-preview-rule",
  provider: "happyhorse",
  model: "happyhorse-1.1-r2v",
  mediaKind: "video",
  billingUnit: "second",
  unitPriceFen: 8,
  metadata: {
    price_source_kind: "实测",
    capability_tier: {
      tier_id: "happyhorse-preview-480p-5s",
      params: {
        resolution: "480p",
        aspect_ratio: "9:16",
        duration_seconds: 5,
        watermark: false,
        preview: true,
        quantity: 1,
      },
      status: "active",
    },
  },
};

test("预览档 params 带 preview 时 providerParameters 把 preview 编译进档参数", () => {
  const tier = resolveTierFromPricingRule(previewTierRule, previewGuardContext);
  assert.ok(tier, "预览档应可解析");
  assert.equal(tier!.parameters.preview, true);
  assert.equal(tier!.parameters.resolution, "480p");
  assert.equal(tier!.parameters.ratio, "9:16");
});

test("requireTierMatchesInput:预览视频档走宽松比对——比例/清晰度/时长可覆盖,preview/watermark 冻结", () => {
  const tier = resolveTierFromPricingRule(previewTierRule, previewGuardContext)!;
  const base = {
    tierId: tier.tierId,
    mediaKind: tier.rule.mediaKind,
    model: tier.rule.model,
    quantity: tier.quantity,
  } as const;
  const fullParams = {
    preview: true,
    ratio: "9:16",
    resolution: "480p",
    durationSeconds: 5,
    watermark: false,
    generateAudio: true,
  };

  assert.doesNotThrow(() => requireTierMatchesInput(tier, {
    ...base,
    parameters: fullParams,
  }), "预览档 + 全参数一致（含 preview）通过");

  assert.doesNotThrow(() => requireTierMatchesInput(tier, {
    ...base,
    parameters: { ...fullParams, resolution: "720p" },
  }), "预览清晰度可覆盖为 720p（快乐马能力内）");

  assert.doesNotThrow(() => requireTierMatchesInput(tier, {
    ...base,
    parameters: { ...fullParams, ratio: "4:5" },
  }), "预览画幅可覆盖为 4:5（快乐马能力内）");

  assert.doesNotThrow(() => requireTierMatchesInput(tier, {
    ...base,
    parameters: { ...fullParams, durationSeconds: 8 },
  }), "预览时长可覆盖为 8 秒（3–15 能力内）");

  assert.throws(() => requireTierMatchesInput(tier, {
    ...base,
    parameters: { ...fullParams, preview: undefined },
  }), (error: unknown) => {
    if (typeof error !== "object" || error === null || !("statusCode" in error)) return false;
    assert.equal(error.statusCode, 422);
    return error instanceof Error && error.message.includes("生成参数必须与所选档位完全一致");
  }, "省略 preview → 422:预览身份只能来自预览档自身 params,不靠客户端在正式档上追加");

  assert.throws(() => requireTierMatchesInput(tier, {
    ...base,
    parameters: { ...fullParams, watermark: true },
  }), (error: unknown) => {
    if (typeof error !== "object" || error === null || !("statusCode" in error)) return false;
    assert.equal(error.statusCode, 422);
    return error instanceof Error && error.message.includes("生成参数必须与所选档位完全一致");
  }, "watermark 改动 → 422:内容标识属平台,预览档锁定,不随参数化放开");
});

test("requireTierMatchesInput:正式（非预览）视频档仍严格全量比对", () => {
  const tier = resolveTierFromPricingRule(previewTierRule, previewGuardContext)!;
  const strictTier: ResolvedGenerationTier = {
    ...tier,
    parameters: { ...tier.parameters, preview: false },
  };
  const base = {
    tierId: strictTier.tierId,
    mediaKind: strictTier.rule.mediaKind,
    model: strictTier.rule.model,
    quantity: strictTier.quantity,
  } as const;
  const fullParams = {
    preview: false,
    ratio: "9:16",
    resolution: "480p",
    durationSeconds: 5,
    watermark: false,
    generateAudio: true,
  };

  assert.doesNotThrow(() => requireTierMatchesInput(strictTier, {
    ...base,
    parameters: fullParams,
  }), "正式档 + 全参数一致通过");

  assert.throws(() => requireTierMatchesInput(strictTier, {
    ...base,
    parameters: { ...fullParams, resolution: "720p" },
  }), (error: unknown) => {
    if (typeof error !== "object" || error === null || !("statusCode" in error)) return false;
    assert.equal(error.statusCode, 422);
    return error instanceof Error && error.message.includes("生成参数必须与所选档位完全一致");
  }, "正式档清晰度改动仍 422（不享受预览档参数化豁免）");
});
