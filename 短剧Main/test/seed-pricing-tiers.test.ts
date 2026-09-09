import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFable007PromotionAllowed,
  assertPromotionDatabaseIdentity,
  assertSgoal04P2PromotionAllowed,
  assertPricingTierSeedSchema,
  createFable007DevPromotionSeeds,
  createRetiredFable007MinimaxDevPromotionSeeds,
  createSgoal04P2DevPromotionSeeds,
  metadataFor,
  parsePricingTierSeedArgs,
  planPricingTierSeed,
  planPricingTierSeedWithSgoal04Promotion,
  pricingSeedDatabaseIdentitySha256,
  PRICING_TIER_SEEDS,
  type ExistingPricingRuleRow,
  type PricingTierSeed,
} from "../scripts/seed-pricing-tiers.mjs";
import { capabilityTierFromPricingRule } from "../src/modules/capability-tiers/repository.js";
import { resolveTierFromPricingRule } from "../src/modules/generation/capabilityTiers.js";
import { estimateGenerationCost } from "../src/modules/generation/cost.js";

const LEGACY_IMAGE_SEED_ID = "00000000-5470-4000-8000-000000000001";
const LEGACY_VIDEO_SEED_ID = "00000000-5470-4000-8000-000000000002";
const imageSeed = PRICING_TIER_SEEDS.find((seed) => seed.id === LEGACY_IMAGE_SEED_ID)!;
const videoSeed = PRICING_TIER_SEEDS.find((seed) => seed.id === LEGACY_VIDEO_SEED_ID)!;
const s58ResearchSeeds = PRICING_TIER_SEEDS.filter(
  (seed) => seed.source.startsWith("seed:s58:")
    && seed.id !== LEGACY_IMAGE_SEED_ID
    && seed.id !== LEGACY_VIDEO_SEED_ID,
);

/**
 * Lite 批次二两档按任务书登记为 active,报价守卫目录(tierPricingGuard.ts
 * PRICE_DEFINITIONS)已于 2026-08-08 收录(协调者收口),但逐档实测激活证据未落:
 * 当前必须投影为 experimental/billing_unverified 且报价链 fail-closed,
 * 等 tier-unfreeze 流程补实测与账单证据后,这两条档才回到「active 即可报价」
 * 的既有断言路径。
 */
const LITE_B2_PENDING_ACTIVATION_TIER_IDS = new Set([
  "vid-seedance25-ep-916-720p-4s",
]);

function seedByTierId(tierId: string): PricingTierSeed {
  const seed = PRICING_TIER_SEEDS.find((candidate) => candidate.tier.tierId === tierId);
  assert.ok(seed, `seed 不存在:${tierId}`);
  return seed;
}

function existingRow(seed: PricingTierSeed, overrides: Partial<ExistingPricingRuleRow> = {}): ExistingPricingRuleRow {
  return {
    id: seed.id,
    provider: seed.provider,
    model: seed.model,
    mediaKind: seed.mediaKind,
    billingUnit: seed.billingUnit,
    unitPriceFen: seed.unitPriceFen,
    currency: seed.currency,
    active: seed.active,
    source: seed.source,
    metadata: metadataFor(seed),
    ...overrides,
  };
}

function metadataWithout(seed: PricingTierSeed, key: string): Record<string, unknown> {
  const metadata = metadataFor(seed);
  delete metadata[key];
  return metadata;
}

test("seed 播种 126 档(40 既有 + 1 Lite 批次二 + 70 公司图片网关 + 1 快乐马预览 + 14 音频参数档);两个旧档对齐集成栈现行行形状", () => {
  assert.equal(PRICING_TIER_SEEDS.length, 126);
  assert.equal(s58ResearchSeeds.length, 28);
  assert.equal(new Set(PRICING_TIER_SEEDS.map((seed) => seed.id)).size, 126);
  assert.equal(new Set(PRICING_TIER_SEEDS.map((seed) => seed.tier.tierId)).size, 126);

  // 旧图片档:价格/tier_id/模型不动,params 对齐真源形状
  assert.equal(imageSeed.model, "doubao-seedream-5-0-pro-260628");
  assert.equal(imageSeed.billingUnit, "image");
  assert.equal(imageSeed.unitPriceFen, 60);
  assert.equal(imageSeed.tier.tierId, "img-seedream5pro-169-2k-1");
  assert.equal(imageSeed.priceSourceKind, "实测");
  assert.deepEqual(imageSeed.tier.params, {
    aspect_ratio: "16:9",
    resolution: "2K",
    watermark: false,
    sequential_image_generation: "disabled",
    quantity: 1,
  });

  // 旧视频档:80 分只保护无输入视频固定档,不得借此开放视频参考
  assert.equal(videoSeed.model, "doubao-seedance-2-0-fast-260128");
  assert.equal(videoSeed.billingUnit, "second");
  assert.equal(videoSeed.unitPriceFen, 80);
  assert.equal(videoSeed.tier.tierId, "vid-seedance20fast-916-720p-4s");
  assert.equal(videoSeed.priceSourceKind, "实测");
  assert.deepEqual(videoSeed.tier.params, {
    aspect_ratio: "9:16",
    resolution: "720p",
    duration_seconds: 4,
    watermark: false,
    quantity: 1,
  });
  const videoMetadata = metadataFor(videoSeed);
  assert.equal("supports_input_video" in videoMetadata, false);
  assert.equal(videoMetadata.price_source_kind, "实测");

  // 28 个推算档只登记实验候选,不得进入公共投影或报价
  for (const seed of s58ResearchSeeds) {
    assert.equal(seed.active, false, seed.tier.tierId);
    assert.equal(seed.tier.status, "experimental", seed.tier.tierId);
    assert.equal(seed.priceSourceKind, "官方牌价×加成率(推算)", seed.tier.tierId);
    assert.equal(seed.provider, "ark", seed.tier.tierId);
    assert.equal(seed.currency, "CNY", seed.tier.tierId);
    assert.match(seed.source, /^seed:s58:/, seed.tier.tierId);
    const metadata = metadataFor(seed);
    assert.equal(metadata.price_source_kind, "官方牌价×加成率(推算)", seed.tier.tierId);
    if (seed.mediaKind === "video") {
      // 新视频档:时长 4-15 秒不拆档(params 不含 duration_seconds),不授权视频参考
      assert.equal("duration_seconds" in seed.tier.params, false, seed.tier.tierId);
    }
    assert.equal(seed.supportsInputVideo, undefined, seed.tier.tierId);
    assert.equal("supports_input_video" in metadata, false, seed.tier.tierId);
  }

  assert.equal(PRICING_TIER_SEEDS.filter((seed) => seed.active).length, 90);
  assert.equal(PRICING_TIER_SEEDS.filter((seed) => !seed.active).length, 36);
  assert.equal(PRICING_TIER_SEEDS.filter((seed) => seed.mediaKind === "video").length, 28);
  assert.equal(PRICING_TIER_SEEDS.filter((seed) => seed.mediaKind === "audio").length, 18);
  const newapiSeeds = PRICING_TIER_SEEDS.filter((seed) => seed.provider === "newapi");
  assert.equal(newapiSeeds.length, 2);
  assert.ok(newapiSeeds.every((seed) => (
    seed.active === false
    && seed.tier.status === "experimental"
    && seed.priceSourceKind === "待核"
    && seed.unitPriceFen === 0
  )));
  assert.deepEqual(newapiSeeds.map((seed) => seed.model), [
    "gpt-image-2",
    "gemini-3.1-pro-image",
  ]);
  assert.match(newapiSeeds[0]!.valueSources.unit_price_fen, /不代表免费.*\$0\.006/);
  assert.match(newapiSeeds[1]!.valueSources.model, /alias.*gemini-3-pro-image/);
  assert.equal(
    PRICING_TIER_SEEDS.filter((seed) => seed.mediaKind === "video" && seed.supportsInputVideo === true).length,
    0,
  );

  // 4k 三档带官方限流提示,并落入 metadata.rate_limit_hint
  for (const tierId of ["vid-seedance20-169-4k", "vid-seedance20-916-4k", "vid-seedance20-11-4k"]) {
    const seed = seedByTierId(tierId);
    assert.match(seed.rateLimitHint ?? "", /4K 官方限流:并发 1 \/ RPM 15/);
    assert.equal(metadataFor(seed).rate_limit_hint, seed.rateLimitHint);
  }
});

test("Seed Audio 16 档按 3 积分/秒计价:音质/格式/时长维度全部落在真实原子档", () => {
  const audioSeeds = PRICING_TIER_SEEDS.filter(
    (seed) => seed.mediaKind === "audio" && seed.provider === "openspeech",
  );
  assert.equal(audioSeeds.length, 16);
  assert.deepEqual(
    [...audioSeeds]
      .sort((a, b) => (
        a.model.localeCompare(b.model)
        || (a.tier.params.sample_rate as number) - (b.tier.params.sample_rate as number)
        || String(a.tier.params.format).localeCompare(String(b.tier.params.format))
        || (a.tier.params.original_duration_seconds as number) - (b.tier.params.original_duration_seconds as number)
      ))
      .map((seed) => ({
      tierId: seed.tier.tierId,
      provider: seed.provider,
      model: seed.model,
      billingUnit: seed.billingUnit,
      unitPriceFen: seed.unitPriceFen,
      active: seed.active,
      status: seed.tier.status,
      displayName: seed.tier.displayName,
      providerLabel: seed.tier.providerLabel,
      modelLabel: seed.tier.modelLabel,
      capabilities: seed.tier.capabilities,
      sampleRate: seed.tier.params.sample_rate,
      format: seed.tier.params.format,
      durationSeconds: seed.tier.params.original_duration_seconds,
    })),
    [
      // 基础模型 8 档(2 音质 × 2 格式 × 2 时长,扣除已有 48k/mp3/3s)
      { tierId: "aud-seedaudio10-32k-mp3-3s", provider: "openspeech", model: "seed-audio-1.0", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0", capabilities: ["text_to_speech"], sampleRate: 32000, format: "mp3", durationSeconds: 3 },
      { tierId: "aud-seedaudio10-32k-mp3-10s", provider: "openspeech", model: "seed-audio-1.0", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0", capabilities: ["text_to_speech"], sampleRate: 32000, format: "mp3", durationSeconds: 10 },
      { tierId: "aud-seedaudio10-32k-wav-3s", provider: "openspeech", model: "seed-audio-1.0", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0", capabilities: ["text_to_speech"], sampleRate: 32000, format: "wav", durationSeconds: 3 },
      { tierId: "aud-seedaudio10-32k-wav-10s", provider: "openspeech", model: "seed-audio-1.0", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0", capabilities: ["text_to_speech"], sampleRate: 32000, format: "wav", durationSeconds: 10 },
      { tierId: "aud-seedaudio10-3s", provider: "openspeech", model: "seed-audio-1.0", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0", capabilities: ["text_to_speech"], sampleRate: 48000, format: "mp3", durationSeconds: 3 },
      { tierId: "aud-seedaudio10-48k-mp3-10s", provider: "openspeech", model: "seed-audio-1.0", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0", capabilities: ["text_to_speech"], sampleRate: 48000, format: "mp3", durationSeconds: 10 },
      { tierId: "aud-seedaudio10-48k-wav-3s", provider: "openspeech", model: "seed-audio-1.0", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0", capabilities: ["text_to_speech"], sampleRate: 48000, format: "wav", durationSeconds: 3 },
      { tierId: "aud-seedaudio10-48k-wav-10s", provider: "openspeech", model: "seed-audio-1.0", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0", capabilities: ["text_to_speech"], sampleRate: 48000, format: "wav", durationSeconds: 10 },
      // 多语言模型 8 档(同样矩阵,扣除已有 48k/mp3/3s)
      { tierId: "aud-seedaudio10-multilingual-32k-mp3-3s", provider: "openspeech", model: "seed-audio-1.0-multilingual", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0 多语言", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0 多语言", capabilities: ["text_to_speech"], sampleRate: 32000, format: "mp3", durationSeconds: 3 },
      { tierId: "aud-seedaudio10-multilingual-32k-mp3-10s", provider: "openspeech", model: "seed-audio-1.0-multilingual", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0 多语言", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0 多语言", capabilities: ["text_to_speech"], sampleRate: 32000, format: "mp3", durationSeconds: 10 },
      { tierId: "aud-seedaudio10-multilingual-32k-wav-3s", provider: "openspeech", model: "seed-audio-1.0-multilingual", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0 多语言", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0 多语言", capabilities: ["text_to_speech"], sampleRate: 32000, format: "wav", durationSeconds: 3 },
      { tierId: "aud-seedaudio10-multilingual-32k-wav-10s", provider: "openspeech", model: "seed-audio-1.0-multilingual", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0 多语言", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0 多语言", capabilities: ["text_to_speech"], sampleRate: 32000, format: "wav", durationSeconds: 10 },
      { tierId: "aud-seedaudio10-multilingual-3s", provider: "openspeech", model: "seed-audio-1.0-multilingual", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0 多语言", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0 多语言", capabilities: ["text_to_speech"], sampleRate: 48000, format: "mp3", durationSeconds: 3 },
      { tierId: "aud-seedaudio10-multilingual-48k-mp3-10s", provider: "openspeech", model: "seed-audio-1.0-multilingual", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0 多语言", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0 多语言", capabilities: ["text_to_speech"], sampleRate: 48000, format: "mp3", durationSeconds: 10 },
      { tierId: "aud-seedaudio10-multilingual-48k-wav-3s", provider: "openspeech", model: "seed-audio-1.0-multilingual", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0 多语言", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0 多语言", capabilities: ["text_to_speech"], sampleRate: 48000, format: "wav", durationSeconds: 3 },
      { tierId: "aud-seedaudio10-multilingual-48k-wav-10s", provider: "openspeech", model: "seed-audio-1.0-multilingual", billingUnit: "second", unitPriceFen: 3, active: true, status: "active", displayName: "Seed Audio 1.0 多语言", providerLabel: "火山引擎", modelLabel: "Seed Audio 1.0 多语言", capabilities: ["text_to_speech"], sampleRate: 48000, format: "wav", durationSeconds: 10 },
    ],
  );

  for (const seed of audioSeeds) {
    const resolved = resolveTierFromPricingRule({
      id: seed.id,
      provider: seed.provider,
      model: seed.model,
      mediaKind: seed.mediaKind,
      billingUnit: seed.billingUnit,
      unitPriceFen: seed.unitPriceFen,
      metadata: metadataFor(seed),
    }, { allowDevSmoke: true });
    assert.ok(resolved, seed.tier.tierId);
    const estimate = estimateGenerationCost(resolved.rule, {
      tierId: resolved.tierId,
      mediaKind: seed.mediaKind,
      model: seed.model,
      quantity: resolved.quantity,
      parameters: resolved.parameters,
      referenceAssetSnapshots: [],
    });
    const seconds = seed.tier.params.original_duration_seconds;
    assert.equal(estimate.billableUnits, seconds);
    assert.equal(estimate.estimatedCostFen, 3 * seconds);
  }
});

test("Lite 批次二仅保留 2.5 接入点档，尾帧延长档不再播种", () => {
  assert.equal(
    PRICING_TIER_SEEDS.some((seed) => seed.tier.tierId === "vid-seedance20fast-916-720p-4s-lf"),
    false,
  );
  const seedance25 = seedByTierId("vid-seedance25-ep-916-720p-4s");
  assert.equal(seedance25.provider, "ark");
  assert.equal(seedance25.model, "ep-20260807153339-f6bp4");
  assert.equal(seedance25.billingUnit, "second");
  assert.equal(seedance25.unitPriceFen, 155);
  assert.equal(seedance25.currency, "CNY");
  assert.equal(seedance25.active, true);
  assert.equal(seedance25.priceSourceKind, "内部定价");
  assert.equal(seedance25.tier.status, "active");
  assert.deepEqual(seedance25.tier.params, {
    aspect_ratio: "9:16",
    resolution: "720p",
    duration_seconds: 4,
    watermark: false,
    quantity: 1,
  });
  assert.equal(seedance25.supportsInputVideo, undefined);
  // 折算链整段留痕,供 DC 确认时复核:0.07 元/千 token → 151.2 分/秒 → 取整 155
  assert.match(seedance25.valueSources.unit_price_fen, /0\.07 元\/千 token/);
  assert.match(seedance25.valueSources.unit_price_fen, /21,600 token\/秒 × 70 元\/百万 = 151\.2 分\/秒/);
  assert.match(seedance25.valueSources.unit_price_fen, /DC 确认前按此登记/);

  // 播种计划机制与既有档同口径:空库插入、一致重放跳过、价格漂移冲突(绝不静默改价)。
  const [insertSeedance25] = planPricingTierSeed([seedance25], []);
  assert.equal(insertSeedance25?.kind, "insert");
  const [skipSeedance25] = planPricingTierSeed([seedance25], [
    existingRow(seedance25),
  ]);
  assert.equal(skipSeedance25?.kind, "skip");
  const [conflictSeedance25] = planPricingTierSeed([seedance25], [
    existingRow(seedance25, { unitPriceFen: 150 }),
  ]);
  assert.equal(conflictSeedance25?.kind, "conflict");

  // 守卫目录(tierPricingGuard.ts)已收录但实测激活证据未落,估价链对该档
  // 仍 fail-closed——不是免费,也不可报价;冻结原因是缺实测与账单核对证据。
  assert.throws(() => estimateGenerationCost(
    {
      id: seedance25.id,
      provider: seedance25.provider,
      model: seedance25.model,
      mediaKind: "video",
      billingUnit: seedance25.billingUnit,
      unitPriceFen: seedance25.unitPriceFen,
      metadata: metadataFor(seedance25),
    },
    {
      mediaKind: "video",
      model: seedance25.model,
      quantity: 1,
      parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
      referenceAssetSnapshots: [],
    },
  ), /尚缺本档实测与账单核对证据/);
});

test("apply 必须显式声明并匹配 POSTGRES_SCHEMA,database URL 不暗中切换 schema", () => {
  assert.deepEqual(
    parsePricingTierSeedArgs([
      "--database-url",
      "postgresql://example.invalid/shortdrama",
      "--apply",
      "--schema",
      "app",
    ]),
    {
      apply: true,
      databaseUrl: "postgresql://example.invalid/shortdrama",
      schema: "app",
      promoteSgoal04P2: false,
      confirmSgoal04P2: false,
      promoteFable007: false,
      confirmFable007: false,
    },
  );
  assert.doesNotThrow(() => assertPricingTierSeedSchema({ apply: false }, "app"));
  assert.doesNotThrow(() => assertPricingTierSeedSchema({ apply: true, schema: "app" }, "app"));
  assert.throws(
    () => assertPricingTierSeedSchema({ apply: true }, "app"),
    /--apply 需要显式声明 --schema/,
  );
  assert.throws(
    () => assertPricingTierSeedSchema({ apply: true, schema: "common" }, "app"),
    /POSTGRES_SCHEMA 实为 app/,
  );
});

test("公司图片网关 70 档逐模型保留参数值域与 10/8/10 分核账价", () => {
  const suchuang = PRICING_TIER_SEEDS.filter((seed) => seed.provider === "suchuang");
  const gpt = suchuang.filter((seed) => seed.model === "gpt-image-2-suchuang");
  const lite = suchuang.filter((seed) => seed.model === "nanobanana-lite");
  const nano2 = suchuang.filter((seed) => seed.model === "nanobanana-2");

  assert.deepEqual([suchuang.length, gpt.length, lite.length, nano2.length], [70, 14, 11, 45]);
  assert.ok(gpt.every((seed) => (
    seed.unitPriceFen === 10
    && !("resolution" in seed.tier.params)
    && typeof seed.tier.params.aspect_ratio === "string"
  )));
  assert.ok(lite.every((seed) => (
    seed.unitPriceFen === 8
    && seed.tier.params.resolution === "1K"
  )));
  assert.deepEqual(
    [...new Set(nano2.map((seed) => seed.tier.params.resolution))],
    ["1K", "2K", "4K"],
  );
  assert.equal(lite.some((seed) => seed.tier.params.aspect_ratio === "1:8"), false);
  assert.equal(nano2.some((seed) => seed.tier.params.aspect_ratio === "1:8"), true);

  for (const seed of suchuang) {
    assert.equal(seed.active, true);
    assert.equal(seed.tier.status, "active");
    assert.match(seed.tier.displayName ?? "", /按 1 张计价；这不是模型能力上限$/);
    const resolved = resolveTierFromPricingRule({
      id: seed.id,
      provider: seed.provider,
      model: seed.model,
      mediaKind: seed.mediaKind,
      billingUnit: seed.billingUnit,
      unitPriceFen: seed.unitPriceFen,
      metadata: metadataFor(seed),
    }, { companyProviderAllowlist: ["ark", "suchuang"] });
    assert.ok(resolved, seed.tier.tierId);
  }
});

test("S-goal-04 只在 dev 双确认后启用 7 个可见档位", () => {
  assert.throws(
    () => assertSgoal04P2PromotionAllowed({
      target: "dev",
      promoteSgoal04P2: true,
      confirmSgoal04P2: false,
    }, "app"),
    /同时声明启用与确认参数/,
  );
  assert.throws(
    () => assertSgoal04P2PromotionAllowed({
      target: "test",
      promoteSgoal04P2: true,
      confirmSgoal04P2: true,
    }, "app"),
    /只允许在 dev 环境/,
  );
  assert.throws(
    () => assertSgoal04P2PromotionAllowed({
      target: "dev",
      promoteSgoal04P2: true,
      confirmSgoal04P2: true,
    }, "shortdrama_prod"),
    /生产 schema 不能启用/,
  );
  assert.doesNotThrow(() => assertSgoal04P2PromotionAllowed({
    target: "dev",
    promoteSgoal04P2: true,
    confirmSgoal04P2: true,
  }, "app"));

  const promoted = createSgoal04P2DevPromotionSeeds();
  assert.equal(promoted.length, 7);
  assert.deepEqual(promoted.map((seed) => seed.tier.tierId).sort(), [
    "img-seedream5pro-11-2k-1",
    "img-seedream5pro-169-1k-1",
    "img-seedream5pro-916-2k-1",
    "vid-seedance20-169-1080p",
    "vid-seedance20-916-720p",
    "vid-seedance20fast-169-720p",
    "vid-seedance20mini-916-720p",
  ]);
  for (const seed of promoted) {
    assert.equal(seed.active, true);
    assert.equal(seed.tier.status, "active");
    assert.equal(seed.priceSourceKind, "待核");
    assert.equal(seed.activationScope, "dev_smoke_only");
    assert.equal(metadataFor(seed).activation_scope, "dev_smoke_only");
  }
  assert.equal(
    promoted.find((seed) => seed.tier.tierId === "vid-seedance20fast-169-720p")
      ?.tier.params.duration_seconds,
    8,
  );
});

test("FABLE-016 后 FABLE-007 只在 dev 双确认后启用 Ark，MiniMax/newapi 均不进入 promotion", () => {
  assert.throws(() => assertFable007PromotionAllowed({
    target: "dev",
    promoteFable007: true,
    confirmFable007: false,
  }, "app"), /同时声明启用与确认参数/);
  assert.throws(() => assertFable007PromotionAllowed({
    target: "prod",
    promoteFable007: true,
    confirmFable007: true,
  }, "app"), /只允许在 dev 环境/);
  assert.doesNotThrow(() => assertFable007PromotionAllowed({
    target: "dev",
    promoteFable007: true,
    confirmFable007: true,
  }, "app"));

  const promoted = createFable007DevPromotionSeeds();
  assert.equal(promoted.length, 2);
  assert.ok(promoted.every((seed) => seed.active && seed.tier.status === "active"));
  assert.ok(promoted.every((seed) => seed.activationScope === "dev_smoke_only"));
  assert.deepEqual([...new Set(promoted.map((seed) => seed.provider))], ["ark"]);
  const cheapestArkImage = promoted.find(
    (seed) => seed.tier.tierId === "img-seedream5pro-169-1k-1",
  );
  assert.ok(cheapestArkImage);
  assert.equal(cheapestArkImage.unitPriceFen, 30);
  assert.equal(cheapestArkImage.tier.isDefault, true);
  assert.equal(cheapestArkImage.tier.params.resolution, "1K");
  assert.equal(promoted.some((seed) => seed.provider === "minimax"), false);
  assert.equal(promoted.some((seed) => seed.provider === "newapi"), false);
});

test("开发档 promotion 拒绝 URL 自报，并绑定独立的 dev 数据库身份指纹", () => {
  const databaseUrl = "postgresql://shortdrama_app:secret@dev-db.example.test:5432/shortdrama";
  const expectedSha256 = pricingSeedDatabaseIdentitySha256(databaseUrl);
  const promotion = {
    promoteSgoal04P2: false,
    promoteFable007: true,
  };

  assert.doesNotThrow(() => assertPromotionDatabaseIdentity(promotion, {
    databaseUrl,
    expectedSha256,
    appEnvironment: "development",
  }));
  assert.throws(() => assertPromotionDatabaseIdentity({
    ...promotion,
    databaseUrl: "postgresql://prod.invalid/shortdrama",
  }, {
    databaseUrl,
    expectedSha256,
    appEnvironment: "development",
  }), /不接受 --database-url 覆盖/);
  assert.throws(() => assertPromotionDatabaseIdentity(promotion, {
    databaseUrl: "postgresql://shortdrama_app:secret@prod-db.example.test:5432/shortdrama",
    expectedSha256,
    appEnvironment: "development",
  }), /不是已批准的 dev 定价目标/);
  assert.throws(() => assertPromotionDatabaseIdentity(promotion, {
    databaseUrl,
    expectedSha256,
    appEnvironment: "production",
  }), /只允许 development 运行时/);
  assert.throws(() => assertPromotionDatabaseIdentity(promotion, {
    databaseUrl,
    appEnvironment: "development",
  }), /缺少部署侧 dev 数据库身份指纹/);
});

test("S-goal-04 只允许完整 S58 基线过渡为开发档，重复执行幂等，漂移拒绝", () => {
  const promotions = createSgoal04P2DevPromotionSeeds();
  const promotedById = new Map(promotions.map((seed) => [seed.id, seed]));
  const desired = PRICING_TIER_SEEDS.map((seed) => promotedById.get(seed.id) ?? seed);
  const baselineRows = PRICING_TIER_SEEDS.map((seed) => existingRow(seed));

  const firstPlan = planPricingTierSeedWithSgoal04Promotion(desired, baselineRows);
  assert.equal(firstPlan.filter((action) => action.kind === "update").length, 7);
  assert.equal(firstPlan.filter((action) => action.kind === "skip").length, 119);
  assert.equal(firstPlan.filter((action) => action.kind === "conflict").length, 0);

  const promotedRows = desired.map((seed) => existingRow(seed));
  assert.deepEqual(
    planPricingTierSeedWithSgoal04Promotion(desired, promotedRows).map((action) => action.kind),
    desired.map(() => "skip"),
  );

  const target = promotions[0]!;
  const driftedRows = baselineRows.map((row) => row.id === target.id
    ? { ...row, unitPriceFen: row.unitPriceFen + 1 }
    : row);
  const driftedPlan = planPricingTierSeedWithSgoal04Promotion(desired, driftedRows);
  assert.equal(driftedPlan.find((action) => action.seed.id === target.id)?.kind, "conflict");
});

test("FABLE-007 MiniMax 音频只把精确 48kHz dev 旧快照迁为 32kHz", () => {
  const desired = createRetiredFable007MinimaxDevPromotionSeeds()
    .filter((seed) => seed.provider === "minimax" && seed.mediaKind === "audio");
  assert.equal(desired.length, 2);
  const legacyRows = desired.map((seed) => {
    const legacySeed: PricingTierSeed = {
      ...seed,
      tier: {
        ...seed.tier,
        params: {
          ...seed.tier.params,
          sample_rate: 48_000,
        },
      },
      valueSources: {
        ...seed.valueSources,
        params: seed.valueSources.params.replace("MP3/32kHz", "MP3/48kHz"),
      },
    };
    return existingRow(legacySeed);
  });

  const plan = planPricingTierSeedWithSgoal04Promotion(desired, legacyRows);
  assert.deepEqual(plan.map((action) => action.kind), ["update", "update"]);
  assert.ok(plan.every((action) => action.seed.tier.params.sample_rate === 32_000));

  const driftedPriceRows = legacyRows.map((row, index) => (
    index === 0 ? { ...row, unitPriceFen: row.unitPriceFen + 1 } : row
  ));
  const priceDriftPlan = planPricingTierSeedWithSgoal04Promotion(desired, driftedPriceRows);
  assert.equal(priceDriftPlan[0]?.kind, "conflict");
  assert.equal(priceDriftPlan[1]?.kind, "update");

  const driftedMetadataRows = legacyRows.map((row, index) => (
    index === 1
      ? { ...row, metadata: { ...row.metadata, activation_scope: "unexpected" } }
      : row
  ));
  const metadataDriftPlan = planPricingTierSeedWithSgoal04Promotion(desired, driftedMetadataRows);
  assert.equal(metadataDriftPlan[0]?.kind, "update");
  assert.equal(metadataDriftPlan[1]?.kind, "conflict");
});

test("FABLE-016 只把完整已知 MiniMax dev 快照退回 inactive，任何漂移都拒绝覆盖", () => {
  const retiredPromotions = createRetiredFable007MinimaxDevPromotionSeeds();
  assert.equal(retiredPromotions.length, 6);
  assert.ok(retiredPromotions.every((seed) => seed.active && seed.tier.status === "active"));
  const desired = PRICING_TIER_SEEDS;
  const currentRows = PRICING_TIER_SEEDS.map((seed) => {
    const retired = retiredPromotions.find((candidate) => candidate.id === seed.id);
    return existingRow(retired ?? seed);
  });

  const plan = planPricingTierSeedWithSgoal04Promotion(desired, currentRows, {
    retireFable007Minimax: true,
  });
  const retiredActions = plan.filter((action) => action.seed.provider === "minimax");
  assert.equal(retiredActions.length, 6);
  assert.ok(retiredActions.every((action) => (
    action.kind === "update"
    && action.seed.active === false
    && action.seed.tier.status === "experimental"
  )));
  assert.equal(plan.filter((action) => action.kind === "conflict").length, 0);

  const target = retiredPromotions[0]!;
  const driftedRows = currentRows.map((row) => row.id === target.id
    ? { ...row, metadata: { ...row.metadata, unexpected: "must-not-overwrite" } }
    : row);
  const driftedPlan = planPricingTierSeedWithSgoal04Promotion(desired, driftedRows, {
    retireFable007Minimax: true,
  });
  assert.equal(driftedPlan.find((action) => action.seed.id === target.id)?.kind, "conflict");
});

test("空库计划插入 126 档;完全一致时 126 档全跳过;同键多档按各自 tier_id 匹配互不串", () => {
  const inserts = planPricingTierSeed(PRICING_TIER_SEEDS, []);
  assert.equal(inserts.filter((action) => action.kind === "insert").length, 126);

  const skips = planPricingTierSeed(PRICING_TIER_SEEDS, PRICING_TIER_SEEDS.map((seed) => existingRow(seed)));
  assert.deepEqual(skips.map((action) => action.kind), PRICING_TIER_SEEDS.map(() => "skip"));
  // 6 个图片档共享 (ark, seedream, image, image):每个 seed 必须匹配到自己 tier_id 的行
  for (const action of skips) {
    assert.equal(action.kind, "skip");
    if (action.kind === "skip") assert.equal(action.existingId, action.seed.id);
  }
});

test("同自然键多档按 tier_id 匹配:缺哪档插哪档,不误配同模型其他档", () => {
  const missing = seedByTierId("img-seedream5pro-169-1k-1");
  const rows = PRICING_TIER_SEEDS
    .filter((seed) => seed.id !== missing.id)
    .map((seed) => existingRow(seed));
  const actions = planPricingTierSeed(PRICING_TIER_SEEDS, rows);
  assert.equal(actions.find((action) => action.seed.id === missing.id)?.kind, "insert");
  assert.equal(actions.filter((action) => action.kind === "skip").length, 125);
  assert.equal(actions.filter((action) => action.kind === "conflict").length, 0);
});

test("价格或档位元数据漂移时冲突,绝不静默覆盖已有付费价格", () => {
  // 某档价格被改 → 恰 1 个 conflict,其余 111 个 skip
  const target = seedByTierId("vid-seedance20mini-169-720p");
  const actions = planPricingTierSeed(PRICING_TIER_SEEDS, PRICING_TIER_SEEDS.map(
    (seed) => existingRow(seed, seed.id === target.id ? { unitPriceFen: 22 } : {}),
  ));
  const conflicts = actions.filter((action) => action.kind === "conflict");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.seed.id, target.id);
  assert.match((conflicts[0] as { differences: string[] }).differences.join(","), /22 ≠ seed 50/);
  assert.equal(actions.filter((action) => action.kind === "skip").length, 125);

  // capability_tier.params 漂移 → conflict
  const driftedParams = planPricingTierSeed([imageSeed], [
    existingRow(imageSeed, {
      metadata: {
        ...metadataFor(imageSeed),
        capability_tier: {
          tier_id: imageSeed.tier.tierId,
          status: "active",
          params: { ...imageSeed.tier.params, watermark: true },
        },
      },
    }),
  ]);
  assert.equal(driftedParams[0]?.kind, "conflict");
  assert.match((driftedParams[0] as { differences: string[] }).differences.join(","), /capability_tier/);

  // supports_input_video 漂移(seed 期望无此能力位,旧行却为 true)→ conflict
  const driftedFlag = planPricingTierSeed([videoSeed], [
    existingRow(videoSeed, { metadata: { ...metadataFor(videoSeed), supports_input_video: true } }),
  ]);
  assert.equal(driftedFlag[0]?.kind, "conflict");
  assert.match((driftedFlag[0] as { differences: string[] }).differences.join(","), /supports_input_video/);

  // S58-era 推算档若已误写 active/status=active/supports_input_video=true,必须显式冲突。
  const inferred = seedByTierId("vid-seedance20mini-169-720p");
  const [staleActive] = planPricingTierSeed([inferred], [
    existingRow(inferred, {
      active: true,
      metadata: {
        ...metadataFor(inferred),
        supports_input_video: true,
        capability_tier: {
          tier_id: inferred.tier.tierId,
          status: "active",
          params: inferred.tier.params,
        },
      },
    }),
  ]);
  assert.equal(staleActive?.kind, "conflict");
  assert.match(
    (staleActive as { differences: string[] }).differences.join(","),
    /active.*capability_tier.*supports_input_video/,
  );

  // active 标志漂移 → conflict
  const driftedActive = planPricingTierSeed([imageSeed], [existingRow(imageSeed, { active: false })]);
  assert.equal(driftedActive[0]?.kind, "conflict");
  assert.match((driftedActive[0] as { differences: string[] }).differences.join(","), /active/);

  // rate_limit_hint 漂移双向:4k 档行内缺 hint → conflict;无期望档行内多 hint → conflict
  const fourK = seedByTierId("vid-seedance20-169-4k");
  const missingHint = planPricingTierSeed([fourK], [
    existingRow(fourK, { metadata: metadataWithout(fourK, "rate_limit_hint") }),
  ]);
  assert.equal(missingHint[0]?.kind, "conflict");
  assert.match((missingHint[0] as { differences: string[] }).differences.join(","), /rate_limit_hint/);

  const extraHint = planPricingTierSeed([imageSeed], [
    existingRow(imageSeed, { metadata: { ...metadataFor(imageSeed), rate_limit_hint: "RPM 1" } }),
  ]);
  assert.equal(extraHint[0]?.kind, "conflict");
  assert.match((extraHint[0] as { differences: string[] }).differences.join(","), /rate_limit_hint/);

  // seed 未声明的任意顶层 metadata 也属于漂移，不能在 update 时被整包静默抹掉。
  const unknownTopLevel = planPricingTierSeed([imageSeed], [
    existingRow(imageSeed, {
      metadata: { ...metadataFor(imageSeed), future_extension: { owner: "other-writer" } },
    }),
  ]);
  assert.equal(unknownTopLevel[0]?.kind, "conflict");
  assert.match(
    (unknownTopLevel[0] as { differences: string[] }).differences.join(","),
    /完整快照.*未声明字段/,
  );
});

test("固定 ID 的身份与审计来源漂移均 conflict,不把错行当成已播种", () => {
  const mismatches: Array<{
    row: ExistingPricingRuleRow;
    expected: RegExp;
  }> = [
    { row: existingRow(imageSeed, { provider: "openspeech" }), expected: /provider/ },
    { row: existingRow(imageSeed, { model: "wrong-model" }), expected: /model/ },
    { row: existingRow(imageSeed, { mediaKind: "video" }), expected: /media_kind/ },
    { row: existingRow(imageSeed, { billingUnit: "second" }), expected: /billing_unit/ },
    { row: existingRow(imageSeed, { source: "seed:unknown" }), expected: /source/ },
    {
      row: existingRow(imageSeed, {
        metadata: { ...metadataFor(imageSeed), price_source_kind: "待核" },
      }),
      expected: /price_source_kind/,
    },
    {
      row: existingRow(imageSeed, {
        metadata: { ...metadataFor(imageSeed), value_sources: { model: "漂移" } },
      }),
      expected: /value_sources/,
    },
  ];

  for (const mismatch of mismatches) {
    const [action] = planPricingTierSeed([imageSeed], [mismatch.row]);
    assert.equal(action?.kind, "conflict");
    assert.match((action as { differences: string[] }).differences.join(","), mismatch.expected);
  }
});

test("重复自然键或正确自然键与错误固定 ID 并存时 conflict,不忽略第二行", () => {
  const duplicateNatural = planPricingTierSeed([imageSeed], [
    existingRow(imageSeed),
    existingRow(imageSeed, { id: "11111111-1111-4111-8111-111111111111" }),
  ]);
  assert.equal(duplicateNatural[0]?.kind, "conflict");
  assert.match(
    (duplicateNatural[0] as { differences: string[] }).differences.join(","),
    /重复匹配行/,
  );

  const correctNaturalAndWrongFixed = planPricingTierSeed([imageSeed], [
    existingRow(imageSeed, { id: "22222222-2222-4222-8222-222222222222" }),
    existingRow(imageSeed, {
      active: false,
      model: "wrong-fixed-id-model",
    }),
  ]);
  assert.equal(correctNaturalAndWrongFixed[0]?.kind, "conflict");
  assert.match(
    (correctNaturalAndWrongFixed[0] as { differences: string[] }).differences.join(","),
    /重复匹配行/,
  );
});

test("待核档机制(active=false、status=experimental、priceSourceKind=待核):插入/重跑跳过/漂移冲突", () => {
  // 合成待核 seed:mini 1080p 官方未确认支持,不进 SEEDS,仅验证机制
  const pendingSeed: PricingTierSeed = {
    id: "00000000-5580-4000-8000-000000000099",
    provider: "ark",
    model: "doubao-seedance-2-0-mini-260615",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 75,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: "seed:s58:scripts/seed-pricing-tiers.mts",
    tier: {
      tierId: "vid-seedance20mini-916-1080p",
      params: { aspect_ratio: "9:16", resolution: "1080p", watermark: false, quantity: 1 },
      status: "experimental",
    },
    valueSources: {
      model: "待核:mini 是否支持 1080p 未经官方确认",
      unit_price_fen: "待核:无官方刊例,价格未定",
      params: "待核",
      tier_id: "待核档命名预留",
    },
  };

  // 库中无此行 → insert,且插入值 active=false、status=experimental
  const [insertAction] = planPricingTierSeed([pendingSeed], []);
  assert.equal(insertAction?.kind, "insert");
  if (insertAction?.kind === "insert") {
    assert.equal(insertAction.seed.active, false);
    const metadata = metadataFor(insertAction.seed);
    assert.equal((metadata.capability_tier as { status: string }).status, "experimental");
    assert.equal(metadata.price_source_kind, "待核");
    assert.equal("supports_input_video" in metadata, false);
  }

  // 重跑幂等的关键:行已存在且 inactive 一致 → skip(经固定 id 抓回 inactive 行)
  const [skipAction] = planPricingTierSeed([pendingSeed], [existingRow(pendingSeed)]);
  assert.equal(skipAction?.kind, "skip");
  if (skipAction?.kind === "skip") assert.equal(skipAction.existingId, pendingSeed.id);

  // inactive 行价格漂移 → conflict
  const [conflictAction] = planPricingTierSeed([pendingSeed], [
    existingRow(pendingSeed, { unitPriceFen: 1 }),
  ]);
  assert.equal(conflictAction?.kind, "conflict");
  assert.match((conflictAction as { differences: string[] }).differences.join(","), /1 ≠ seed 75/);
});

test("公共目录按公司账户白名单投影，suchuang 已开通后与其他 active 档同口径", () => {
  const at = new Date("2026-07-27T00:00:00.000Z");
  const projected = new Map<string, number>();
  for (const seed of PRICING_TIER_SEEDS) {
    const tier = capabilityTierFromPricingRule({
      id: seed.id,
      provider: seed.provider,
      model: seed.model,
      mediaKind: seed.mediaKind,
      billingUnit: seed.billingUnit,
      unitPriceFen: seed.unitPriceFen,
      metadata: metadataFor(seed),
      effectiveFrom: at,
      active: seed.active,
    }, { companyProviderAllowlist: ["ark", "suchuang", "happyhorse"] });
    // 本用例的前提就是「suchuang 已开通」,白名单必须由用例自己声明,
    // 不能省略参数去读部署配置——CI 上没有 .env,读到的是默认名单(只有 ark),
    // 70 个 suchuang 档会全部解析失败。同文件其他用例都显式传这份名单。
    const resolved = resolveTierFromPricingRule({
      id: seed.id,
      provider: seed.provider,
      model: seed.model,
      mediaKind: seed.mediaKind,
      billingUnit: seed.billingUnit,
      unitPriceFen: seed.unitPriceFen,
      metadata: metadataFor(seed),
    }, { companyProviderAllowlist: ["ark", "suchuang", "happyhorse"] });
    if (!seed.active) {
      assert.ok(tier, `实验档应带冻结原因投影:${seed.tier.tierId}`);
      assert.equal(tier.status, "experimental", seed.tier.tierId);
      assert.notEqual(tier.availability, "available", seed.tier.tierId);
      assert.equal(resolved, null, `实验档不应报价:${seed.tier.tierId}`);
      continue;
    }
    if (LITE_B2_PENDING_ACTIVATION_TIER_IDS.has(seed.tier.tierId)) {
      // 守卫目录已收录但激活证据未落:投影必须带 billing_unverified 冻结原因,报价解析拒绝。
      assert.ok(tier, `登记档应带冻结原因投影:${seed.tier.tierId}`);
      assert.equal(tier.status, "experimental", seed.tier.tierId);
      assert.equal(tier.availability, "billing_unverified", seed.tier.tierId);
      assert.equal(resolved, null, `实测激活证据落地前不得报价:${seed.tier.tierId}`);
      continue;
    }
    assert.ok(tier, `active 档投影失败:${seed.tier.tierId}`);
    assert.ok(resolved, `active 档报价解析失败:${seed.tier.tierId}`);
    assert.equal(tier.tierId, seed.tier.tierId);
    assert.equal("modelId" in tier, false, "公共能力档不得暴露供应商真实模型 ID");
    assert.equal(tier.price.points, seed.unitPriceFen);
    assert.equal(tier.status, "active");
    projected.set(tier.tierId, tier.price.points);
  }
  // 18 个方舟/语音档(4 既有 + 14 音频参数档) + 70 个公司图片网关档 + 1 快乐马预览档。
  // 产品 2026-08-08 拍板开通 suchuang,它的档位从「因未开通而冻结」变成与其他 active 档同一条口径,不再单独放行。
  assert.equal(projected.size, 89);
  assert.equal(
    [...projected.keys()].filter((tierId) => tierId.startsWith("img-suchuang-")).length,
    70,
  );

  // 两个旧档完整投影形状(含对齐后的 params)
  const imageTier = capabilityTierFromPricingRule({
    id: imageSeed.id,
    provider: imageSeed.provider,
    model: imageSeed.model,
    mediaKind: "image",
    billingUnit: imageSeed.billingUnit,
    unitPriceFen: imageSeed.unitPriceFen,
    metadata: metadataFor(imageSeed),
    effectiveFrom: at,
  });
  assert.deepEqual(imageTier, {
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

  const videoTier = capabilityTierFromPricingRule({
    id: videoSeed.id,
    provider: videoSeed.provider,
    model: videoSeed.model,
    mediaKind: "video",
    billingUnit: videoSeed.billingUnit,
    unitPriceFen: videoSeed.unitPriceFen,
    metadata: metadataFor(videoSeed),
    effectiveFrom: at,
  });
  assert.deepEqual(videoTier, {
    tierId: "vid-seedance20fast-916-720p-4s",
    mediaType: "video",
    displayName: "seedance 2 0 fast",
    providerLabel: "火山方舟",
    modelLabel: "seedance 2 0 fast",
    isDefault: false,
    availability: "available",
    availabilityReason: "已完成官方价格核验、逐档实测与账单核对",
    capabilities: ["video", "aspect_ratio", "duration_seconds", "resolution"],
    officialPriceSource: "https://www.volcengine.com/docs/82379/1544106",
    params: {
      aspect_ratio: "9:16",
      resolution: "720p",
      duration_seconds: 4,
      watermark: false,
      quantity: 1,
    },
    price: { unit: "per_second", points: 80 },
    status: "active",
  });

  // S58 历史误写若仍残留 active/status=active,推算来源也必须 fail-closed。
  const staleInferredMetadata = {
    ...metadataFor(imageSeed),
    price_source_kind: "官方牌价×加成率(推算)",
  };
  const staleInferredTier = capabilityTierFromPricingRule({
    id: "stale-inferred-public",
    provider: "ark",
    model: imageSeed.model,
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: imageSeed.unitPriceFen,
    metadata: staleInferredMetadata,
    effectiveFrom: at,
    active: true,
  });
  assert.equal(staleInferredTier?.status, "experimental");
  assert.equal(staleInferredTier?.availability, "billing_unverified");
  assert.equal(resolveTierFromPricingRule({
    id: "stale-inferred-quote",
    provider: "ark",
    model: imageSeed.model,
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: imageSeed.unitPriceFen,
    metadata: staleInferredMetadata,
  }), null);
});

test("开发冒烟档只供受控脚本解析，不进入普通目录或报价", () => {
  const at = new Date("2026-07-30T00:00:00.000Z");
  const promotions = createSgoal04P2DevPromotionSeeds();
  const activeSeeds = [...PRICING_TIER_SEEDS.filter((seed) => seed.active), ...promotions];
  assert.equal(activeSeeds.length, 97);
  for (const seed of activeSeeds) {
    const tier = capabilityTierFromPricingRule({
      id: seed.id,
      provider: seed.provider,
      model: seed.model,
      mediaKind: seed.mediaKind,
      billingUnit: seed.billingUnit,
      unitPriceFen: seed.unitPriceFen,
      metadata: metadataFor(seed),
      effectiveFrom: at,
      active: seed.active,
    });
    const isDevSmoke = seed.activationScope === "dev_smoke_only";
    const resolved = resolveTierFromPricingRule({
      id: seed.id,
      provider: seed.provider,
      model: seed.model,
      mediaKind: seed.mediaKind,
      billingUnit: seed.billingUnit,
      unitPriceFen: seed.unitPriceFen,
      metadata: metadataFor(seed),
    }, {
      allowDevSmoke: isDevSmoke,
      companyProviderAllowlist: ["ark", "suchuang", "happyhorse"],
    });
    if (LITE_B2_PENDING_ACTIVATION_TIER_IDS.has(seed.tier.tierId)) {
      // 守卫目录已收录、激活证据未落:公共目录投影冻结、报价解析拒绝,tier-unfreeze 补证据前保持此态。
      assert.ok(tier, seed.tier.tierId);
      assert.equal(tier.status, "experimental", seed.tier.tierId);
      assert.equal(resolved, null, seed.tier.tierId);
      continue;
    }
    assert.ok(tier, seed.tier.tierId);
    assert.ok(resolved, seed.tier.tierId);
    if (isDevSmoke) {
      assert.equal(tier.status, "experimental");
      assert.equal(resolveTierFromPricingRule({
        id: seed.id,
        provider: seed.provider,
        model: seed.model,
        mediaKind: seed.mediaKind,
        billingUnit: seed.billingUnit,
        unitPriceFen: seed.unitPriceFen,
        metadata: metadataFor(seed),
      }), null);
      continue;
    }
    if (seed.provider === "suchuang") {
      // 本测试声明的白名单已含 suchuang,估价必须跟着同一份名单走:
      // 能选中就要能报出价,否则就是「开了也用不了」。
      const suchuangEstimate = estimateGenerationCost({
        ...resolved.rule,
        metadata: metadataFor(seed),
      }, {
        tierId: resolved.tierId,
        mediaKind: seed.mediaKind,
        model: seed.model,
        quantity: resolved.quantity,
        parameters: resolved.parameters,
        referenceAssetSnapshots: [],
      }, { companyProviderAllowlist: ["ark", "suchuang"] });
      assert.equal(suchuangEstimate.tierId, seed.tier.tierId);
      assert.equal(suchuangEstimate.estimatedCostFen, seed.unitPriceFen);
      continue;
    }
    const estimate = estimateGenerationCost({
      ...resolved.rule,
      metadata: metadataFor(seed),
    }, {
      tierId: resolved.tierId,
      mediaKind: seed.mediaKind,
      model: seed.model,
      quantity: resolved.quantity,
      parameters: resolved.parameters,
      referenceAssetSnapshots: [],
    }, { companyProviderAllowlist: ["ark", "suchuang", "happyhorse"] });
    assert.equal(estimate.tierId, seed.tier.tierId);
    assert.equal(
      estimate.estimatedCostFen,
      seed.unitPriceFen * (seed.mediaKind === "video"
        ? Number(resolved.parameters.durationSeconds)
        : seed.mediaKind === "audio" ? Number(resolved.parameters.originalDurationSeconds) : 1),
    );
  }

  const mini = promotions.find((seed) => seed.tier.tierId === "vid-seedance20mini-916-720p")!;
  const miniResolved = resolveTierFromPricingRule({
    id: mini.id,
    provider: mini.provider,
    model: mini.model,
    mediaKind: mini.mediaKind,
    billingUnit: mini.billingUnit,
    unitPriceFen: mini.unitPriceFen,
    metadata: metadataFor(mini),
  }, { allowDevSmoke: true });
  assert.ok(miniResolved);
  assert.equal(mini.unitPriceFen, 50);
  assert.equal(miniResolved.parameters.durationSeconds, 4);
});

test("4k 开发档使用小写 provider 值，但普通报价仍 fail-closed", () => {
  const baseline = seedByTierId("vid-seedance20-169-4k");
  const active4k: PricingTierSeed = {
    ...baseline,
    active: true,
    priceSourceKind: "待核",
    activationScope: "dev_smoke_only",
    source: "test:sgoal04:4k",
    tier: {
      ...baseline.tier,
      status: "active",
      params: { ...baseline.tier.params, duration_seconds: 4 },
    },
  };
  const resolved = resolveTierFromPricingRule({
    id: active4k.id,
    provider: active4k.provider,
    model: active4k.model,
    mediaKind: active4k.mediaKind,
    billingUnit: active4k.billingUnit,
    unitPriceFen: active4k.unitPriceFen,
    metadata: metadataFor(active4k),
  }, { allowDevSmoke: true });
  assert.ok(resolved);
  assert.equal(resolved.parameters.resolution, "4k");
  assert.throws(() => estimateGenerationCost({
      ...resolved.rule,
      metadata: metadataFor(active4k),
    }, {
      tierId: resolved.tierId,
      mediaKind: "video",
      model: active4k.model,
      quantity: 1,
      parameters: resolved.parameters,
      referenceAssetSnapshots: [],
    }),
    /开发冒烟档不能进入普通用户报价链/,
  );
});

test("既有价格冻结表:56 档 tier_id → unitPriceFen 全量断言(防手滑改价)", () => {
  const expected: Record<string, number> = {
    "img-seedream5pro-169-2k-1": 60,
    "vid-seedance20fast-916-720p-4s": 80,
    // 快乐马预览:低价快速预览,5 秒条 = 40 积分(设计文档 §3.2)
    "happyhorse-preview-480p-5s": 8,
    // Lite 批次二:仅保留 2.5 接入点档，按账号折后价折算，DC 确认前按此登记
    "vid-seedance25-ep-916-720p-4s": 155,
    "img-seedream5pro-169-1k-1": 30,
    "img-seedream5pro-916-1k-1": 30,
    "img-seedream5pro-11-1k-1": 30,
    "img-seedream5pro-916-2k-1": 60,
    "img-seedream5pro-11-2k-1": 60,
    "vid-seedance20-169-480p": 50,
    "vid-seedance20-916-480p": 50,
    "vid-seedance20-11-480p": 45,
    "vid-seedance20-169-720p": 100,
    "vid-seedance20-916-720p": 100,
    "vid-seedance20-11-720p": 100,
    "vid-seedance20-169-1080p": 250,
    "vid-seedance20-916-1080p": 250,
    "vid-seedance20-11-1080p": 250,
    "vid-seedance20-169-4k": 510,
    "vid-seedance20-916-4k": 510,
    "vid-seedance20-11-4k": 510,
    "vid-seedance20fast-169-480p": 40,
    "vid-seedance20fast-916-480p": 40,
    "vid-seedance20fast-11-480p": 40,
    "vid-seedance20fast-169-720p": 80,
    "vid-seedance20fast-11-720p": 80,
    "vid-seedance20mini-169-480p": 25,
    "vid-seedance20mini-916-480p": 25,
    "vid-seedance20mini-11-480p": 25,
    "vid-seedance20mini-169-720p": 50,
    "vid-seedance20mini-916-720p": 50,
    "vid-seedance20mini-11-720p": 50,
    "aud-seedaudio10-3s": 3,
    "aud-seedaudio10-multilingual-3s": 3,
    "aud-seedaudio10-32k-mp3-3s": 3,
    "aud-seedaudio10-32k-mp3-10s": 3,
    "aud-seedaudio10-32k-wav-3s": 3,
    "aud-seedaudio10-32k-wav-10s": 3,
    "aud-seedaudio10-48k-mp3-10s": 3,
    "aud-seedaudio10-48k-wav-3s": 3,
    "aud-seedaudio10-48k-wav-10s": 3,
    "aud-seedaudio10-multilingual-32k-mp3-3s": 3,
    "aud-seedaudio10-multilingual-32k-mp3-10s": 3,
    "aud-seedaudio10-multilingual-32k-wav-3s": 3,
    "aud-seedaudio10-multilingual-32k-wav-10s": 3,
    "aud-seedaudio10-multilingual-48k-mp3-10s": 3,
    "aud-seedaudio10-multilingual-48k-wav-3s": 3,
    "aud-seedaudio10-multilingual-48k-wav-10s": 3,
    "img-minimax-image01-169-1k-1": 3,
    "img-minimax-image01live-169-1k-1": 3,
    "vid-minimax-h3-169-768p-4s": 50,
    "vid-minimax-h3-169-2k-4s": 80,
    "aud-minimax-speech28turbo-mp3": 200,
    "aud-minimax-speech28hd-mp3": 350,
    "img-newapi-gptimage2-11-1k-low": 0,
    "img-newapi-gemini31proimage-11-1k": 0,
  };
  assert.equal(Object.keys(expected).length, 56);
  const actual = Object.fromEntries(
    PRICING_TIER_SEEDS
      .filter((seed) => seed.provider !== "suchuang")
      .map((seed) => [seed.tier.tierId, seed.unitPriceFen]),
  );
  assert.deepEqual(actual, expected);

  const belowLegacyFloor = s58ResearchSeeds.filter(
    (seed) => seed.mediaKind === "video" && seed.unitPriceFen < videoSeed.unitPriceFen,
  );
  assert.equal(belowLegacyFloor.length, 12);
  assert.ok(belowLegacyFloor.every((seed) => !seed.active && seed.tier.status === "experimental"));
  assert.equal(videoSeed.unitPriceFen, 80);
});

test("旧两档通过真实报价链档位解析(estimate/quote/confirm 共用)", () => {
  const imageResolved = resolveTierFromPricingRule({
    id: imageSeed.id,
    provider: imageSeed.provider,
    model: imageSeed.model,
    mediaKind: "image",
    billingUnit: imageSeed.billingUnit,
    unitPriceFen: imageSeed.unitPriceFen,
    metadata: metadataFor(imageSeed),
  });
  assert.ok(imageResolved);
  assert.equal(imageResolved.quantity, 1);
  assert.deepEqual(imageResolved.parameters, {
    // 当前 provider 参数解冻把用户层 2K 标准化成 Ark 的实际像素尺寸；
    // tier 仍是 16:9 / 2K，账务身份不变。
    size: "2048x1152",
    ratio: "16:9",
    watermark: false,
    sequentialImageGeneration: "disabled",
  });

  const videoResolved = resolveTierFromPricingRule({
    id: videoSeed.id,
    provider: videoSeed.provider,
    model: videoSeed.model,
    mediaKind: "video",
    billingUnit: videoSeed.billingUnit,
    unitPriceFen: videoSeed.unitPriceFen,
    metadata: metadataFor(videoSeed),
  });
  assert.ok(videoResolved);
  assert.equal(videoResolved.quantity, 1);
  assert.deepEqual(videoResolved.parameters, {
    resolution: "720p",
    ratio: "9:16",
    durationSeconds: 4,
    watermark: false,
    generateAudio: true,
  });
});

test("旧两档直接喂给估价链:图片 60 积分/张,视频 4 秒 320 积分", () => {
  const imageEstimate = estimateGenerationCost(
    {
      id: imageSeed.id,
      provider: imageSeed.provider,
      model: imageSeed.model,
      mediaKind: "image",
      billingUnit: imageSeed.billingUnit,
      unitPriceFen: imageSeed.unitPriceFen,
      metadata: metadataFor(imageSeed),
    },
    {
      mediaKind: "image",
      model: imageSeed.model,
      quantity: 1,
      parameters: { size: "2K", ratio: "16:9" },
      referenceAssetSnapshots: [],
    },
  );
  assert.equal(imageEstimate.estimatedCostFen, 60);
  assert.equal(imageEstimate.billableUnits, 1);

  const videoEstimate = estimateGenerationCost(
    {
      id: videoSeed.id,
      provider: videoSeed.provider,
      model: videoSeed.model,
      mediaKind: "video",
      billingUnit: videoSeed.billingUnit,
      unitPriceFen: videoSeed.unitPriceFen,
      metadata: metadataFor(videoSeed),
    },
    {
      mediaKind: "video",
      model: videoSeed.model,
      quantity: 1,
      parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
      referenceAssetSnapshots: [],
    },
  );
  assert.equal(videoEstimate.billableUnits, 4);
  assert.equal(videoEstimate.estimatedCostFen, 320);

  assert.throws(() => estimateGenerationCost(
    {
      id: videoSeed.id,
      provider: videoSeed.provider,
      model: videoSeed.model,
      mediaKind: "video",
      billingUnit: videoSeed.billingUnit,
      unitPriceFen: videoSeed.unitPriceFen,
      metadata: metadataFor(videoSeed),
      // 模拟 S58-era 运行行仍残留能力位；旧 80 分固定档也必须拒绝视频参考。
      supportsInputVideo: true,
    },
    {
      mediaKind: "video",
      model: videoSeed.model,
      quantity: 1,
      parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
      referenceAssetSnapshots: [{
        kind: "video",
        url: "https://example.test/reference.mp4",
        role: "reference_video",
      }],
    },
  ), /单价未覆盖视频参考/);
});
