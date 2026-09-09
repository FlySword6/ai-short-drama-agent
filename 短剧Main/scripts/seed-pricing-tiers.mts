#!/usr/bin/env tsx
/**
 * seed-pricing-tiers —— 播种生成档位(pricing_rules 行 + metadata.capability_tier)。S58 包。
 *
 * 背景:S47 交付了 2 个幂等 active 档(图片 60 积分/张、视频 fast 720p 80 积分/秒);
 * S58b 把其余 28 个推算组合降为 inactive/experimental 研究候选。2026-08-02
 * 再加入 Seed Audio 两个 active 内部售价档。2026-08-08 Lite 批次二再登记
 * Seedance 2.5 专用接入点档
 * (账号折后价折算,DC 确认前按此登记)。32 条登记覆盖
 * seedream-5.0-pro 图片 1K/2K × 16:9/9:16/1:1,seedance-2.0 本体/fast/mini 视频
 * 480p/720p/1080p/4k × 比例矩阵(fast/mini 官方不支持 1080p/4k,无档)。
 * 档位真源 = pricing_rules.metadata.capability_tier(src/modules/capability-tiers/repository.ts);
 * 表结构从 001 起已够用(metadata jsonb),本包不含迁移。
 *
 * 数值来源(逐条,禁止编造):
 *   - 官方牌价(docs.volcengine.com/docs/82379/1544106，2026-08-01 更新):
 *     Seedream 5.0 Pro 1.5K 及以下(≤261 万像素)0.30 元/张、
 *     高于 1.5K(>261 万像素)0.60 元/张(本表仅 1K/2K 两档,无 4K;
 *     规格见 docs.volcengine.com/docs/82379/2582774、
 *     /2298881 教程);视频按 token 刊例(元/百万 token,输入不含视频):本体
 *     doubao-seedance-2-0-260128 480p/720p=46、1080p=51、4k=26;fast 一律 37;mini 一律 23。
 *   - token 公式:token=宽×高×24fps×秒/1024;像素表 864×496/496×864=428,544、
 *     640×640=409,600、720p 全比例=921,600、1080p 全比例=2,073,600、4k 全比例=8,294,400
 *     (docs.volcengine.com/docs/82379/2298881)。
 *   - 模型 ID 与限流:docs.volcengine.com/docs/82379/1330310(4k 官方限流:并发 1 /
 *     RPM 15,写入 metadata.rate_limit_hint)。
 *   - 研究值规则:成本 × 加成率 1.0(现行两档反推:图 60/60=1.000、视频 80/79.92≈1.001,
 *     统一取 1.0),向上取整到 5 积分(该规则精确复算出现行两档价:79.92→80、60→60)。
 *     1 积分 = 1 分钱(合同附表脚注),故 unit_price_fen 数值=积分。28 个推算值不构成
 *     正式售价,必须逐档付费实测、核账并经独立管理动作解锁后才可 active。
 *   - 两个旧档:2026-07-21 付费冒烟实测 + 合同 v0.3.0 附表登记;2026-07-27 集成栈现行行
 *     只读核验后 params 形状对齐真源(价格/tier_id/模型不动)。
 *   - 本脚本的 24 个视频 seed 均不写 metadata.supports_input_video。旧 80 分固定档只保护
 *     无输入视频合同;28 个候选的官方公式同样不能作为视频参考定价授权。
 *   - 实验档机制:active=false + tier.status="experimental"。priceSourceKind 独立记录价格
 *     证据来源:官方公式可写“官方牌价×加成率(推算)”,未知来源才写“待核”。两者都不可报价。
 *
 * 幂等语义(pricing_rules 无自然键唯一约束,ON CONFLICT 不可用,用应用层 upsert):
 *   - 匹配键 =(provider, model, media_kind, billing_unit)+ metadata.capability_tier.tier_id
 *     (S58 起加 tier_id,同模型多档共存)。优先级:(a) 当前 active 行中同键同 tier_id;
 *     (b) id = seed 固定 id 的行(任意 active,抓回 inactive 待核行,保证重跑幂等)。
 *     都没有 → 插入。
 *   - 完全一致(身份四元组/source/unit_price_fen/currency/active/capability_tier/
 *     price_source_kind/value_sources/supports_input_video/rate_limit_hint)→ 跳过;
 *     任一漂移 → 不覆盖、报告差异并非零
 *     退出(改价是管理动作,走 POST /api/v1/admin/pricing-rules,seed 绝不静默改付费价格)。
 *
 * 用法:
 *   npx tsx scripts/seed-pricing-tiers.mts                      # dry-run(默认),只打印计划
 *   npx tsx scripts/seed-pricing-tiers.mts --apply --schema app # 真写库;schema 必须与 POSTGRES_SCHEMA 一致
 *   npx tsx scripts/seed-pricing-tiers.mts --target dev \
 *     --promote-sgoal04-p2 --confirm-sgoal04-p2                 # 预览 S-goal-04 的 7 个开发档
 *   npx tsx scripts/seed-pricing-tiers.mts --apply --schema app --target dev \
 *     --promote-sgoal04-p2 --confirm-sgoal04-p2                 # 仅开发环境受控启用
 *   POSTGRES_SCHEMA=app npx tsx scripts/seed-pricing-tiers.mts \
 *     --database-url postgresql://… [--apply --schema app]
 *
 * --database-url 只覆盖连接目标,不会改变 Drizzle 使用的显式 schema;
 * schema 仍由 POSTGRES_SCHEMA 决定。apply 强制重复声明 --schema,防止写错数据域。
 * dev_smoke_only promotion 额外拒绝 --database-url 覆盖，并要求部署侧配置
 * PRICING_SEED_DEV_DATABASE_IDENTITY_SHA256 与实际连接目标一致。
 */
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { pricingRules } from "../src/db/schema.js";
import { INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND } from "../src/shared/pricingRuleProvenance.js";

export type PriceSourceKind =
  | "实测"
  | "内部定价"
  | typeof INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND
  | "待核";

export interface PricingTierSeed {
  /** 固定 UUID:重复执行安全可识别,与 dev-seed 的保留 ID 段同一思路。 */
  id: string;
  provider: "ark" | "minimax" | "newapi" | "openspeech" | "suchuang" | "happyhorse";
  model: string;
  mediaKind: "image" | "video" | "audio";
  billingUnit: "image" | "second" | "ten_thousand_characters";
  unitPriceFen: number;
  currency: "CNY";
  /** pricing_rules.active:已解锁档 true;未经逐档实测的推算/待核档 false。 */
  active: boolean;
  /** 价格出处分类,随行进 metadata.price_source_kind。 */
  priceSourceKind: PriceSourceKind;
  /** 官方限流提示;有则写 metadata.rate_limit_hint。 */
  rateLimitHint?: string;
  /** 未完成真实冒烟的新档只允许在开发环境报价，不构成生产启用授权。 */
  activationScope?: "dev_smoke_only";
  /** 独立核准的视频参考单价能力位;S58b 的 30 个 seed 均不设置。 */
  supportsInputVideo?: boolean;
  source: string;
  tier: {
    tierId: string;
    params: Record<string, string | number | boolean>;
    /** 普通档 "active";待核档 "experimental"(档位投影只放行 active)。 */
    status: "active" | "experimental";
    displayName?: string;
    providerLabel?: string;
    modelLabel?: string;
    isDefault?: boolean;
    capabilities?: string[];
    officialPriceSource?: string;
  };
  /** 每个数值的出处,随行进 metadata.value_sources,回执与审计直接可查。 */
  valueSources: Record<string, string>;
}

export interface ExistingPricingRuleRow {
  id: string;
  provider: string;
  model: string;
  mediaKind: string;
  billingUnit: string;
  unitPriceFen: number;
  currency: string;
  active: boolean;
  source: string;
  metadata: Record<string, unknown>;
}

export type PricingTierSeedAction =
  | { kind: "insert"; seed: PricingTierSeed }
  | { kind: "update"; seed: PricingTierSeed; existingId: string }
  | { kind: "skip"; seed: PricingTierSeed; existingId: string }
  | { kind: "conflict"; seed: PricingTierSeed; existingId: string; differences: string[] };

const SEED_SOURCE = "seed:s58:scripts/seed-pricing-tiers.mts";
const SEED_AUDIO_PRICING_SOURCE = "seed:r154:seed-audio-pricing";
const SGOAL04_P2_DEV_SOURCE = "seed:sgoal04:p2:dev-smoke";
const FABLE007_DEV_SOURCE = "seed:fable007:multimodel:dev-smoke";
const FABLE016_NEWAPI_SOURCE = "seed:fable016:newapi:experimental";
const ISSUE157_SUCHUANG_SOURCE = "seed:issue-157:suchuang-image-gateway";
const LITE_B2_SOURCE = "seed:lite-b2:scripts/seed-pricing-tiers.mts";

const DOCS_PRICE_URL = "docs.volcengine.com/docs/82379/1544106";
const DOCS_PIXELS_URL = "docs.volcengine.com/docs/82379/2298881";
const DOCS_MODELS_URL = "docs.volcengine.com/docs/82379/1330310";

const MODEL_SEEDREAM_5_PRO = "doubao-seedream-5-0-pro-260628";
const MODEL_SEEDANCE_20 = "doubao-seedance-2-0-260128";
const MODEL_SEEDANCE_20_FAST = "doubao-seedance-2-0-fast-260128";
const MODEL_SEEDANCE_20_MINI = "doubao-seedance-2-0-mini-260615";
const MODEL_SEED_AUDIO_10 = "seed-audio-1.0";
const MODEL_SEED_AUDIO_10_MULTILINGUAL = "seed-audio-1.0-multilingual";
/** DC 自建 Seedance 2.5 专用接入点(折扣绑定,2026-08-07 拍板实测出片);与 v01Contract.ts ARK_SEEDANCE_2_5_ENDPOINT_MODEL 同值。 */
const MODEL_SEEDANCE_25_ENDPOINT = "ep-20260807153339-f6bp4";

const RATE_LIMIT_HINT_4K = "4K 官方限流:并发 1 / RPM 15(docs.volcengine.com/docs/82379/1330310)";
const SEED_AUDIO_PRICE_DOC_URL = "https://www.volcengine.com/docs/6561/1359370";
const MINIMAX_PRICE_DOC_URL = "https://platform.minimaxi.com/docs/guides/pricing-paygo";
const OPENAI_IMAGE_DOC_URL = "https://developers.openai.com/api/docs/guides/image-generation";
const GOOGLE_IMAGE_PRICE_DOC_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const SUCHUANG_GPT_IMAGE_2_DOC_URL = "https://api.wuyinkeji.com/doc/53";
const SUCHUANG_NANOBANANA_LITE_DOC_URL = "https://api.wuyinkeji.com/doc/74";
const SUCHUANG_NANOBANANA_2_DOC_URL = "https://api.wuyinkeji.com/doc/65";

/** 2026-07-27 集成栈现行两行只读核验结论,追加在两个旧档的 value_sources 里。 */
const LEGACY_ROW_VERIFICATION_NOTE = "2026-07-27 集成栈现行行只读核验"
  + "(行 8ec1ae5a-7c9f-4586-a204-2d0895cef360 / 0f0fb9a9-e9de-48ab-9011-22e718dd558b),"
  + "metadata 形状以真源为准";

type AspectRatio = "16:9" | "9:16" | "1:1";
type ImageResolution = "1K" | "2K";
type VideoResolution = "480p" | "720p" | "1080p" | "4k";

/** S47 交付的两个旧档;S58 只对齐 params/metadata 形状,价格、tier_id、模型不动。 */
const LEGACY_SEEDS: readonly PricingTierSeed[] = [
  {
    id: "00000000-5470-4000-8000-000000000001",
    provider: "ark",
    model: MODEL_SEEDREAM_5_PRO,
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 60,
    currency: "CNY",
    active: true,
    priceSourceKind: "实测",
    source: SEED_SOURCE,
    tier: {
      tierId: "img-seedream5pro-169-2k-1",
      params: {
        aspect_ratio: "16:9",
        resolution: "2K",
        watermark: false,
        sequential_image_generation: "disabled",
        quantity: 1,
      },
      status: "active",
    },
    valueSources: {
      model: "服务端配置 ARK_IMAGE_MODEL;合同 v0.3.0 附表登记行",
      unit_price_fen:
        "60 积分/张(1 积分=1 分钱):2026-07-21 付费冒烟实测(估价 60 分→确认→出图→记账);"
        + "docs/validation/v0.1.1-admin-models-pricing-handoff.md 现行行;合同 v0.3.0 附表",
      params:
        "v01Contract.ts 冻结:size=2K/ratio=16:9/watermark=false/sequential=disabled;"
        + `quantity=1 为后端档位解析硬性要求;${LEGACY_ROW_VERIFICATION_NOTE}`,
      tier_id: "合同 v0.3.0 附表登记 img-seedream5pro-169-2k-1(active)",
    },
  },
  {
    id: "00000000-5470-4000-8000-000000000002",
    provider: "ark",
    model: MODEL_SEEDANCE_20_FAST,
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
    currency: "CNY",
    active: true,
    priceSourceKind: "实测",
    source: SEED_SOURCE,
    tier: {
      tierId: "vid-seedance20fast-916-720p-4s",
      params: {
        aspect_ratio: "9:16",
        resolution: "720p",
        duration_seconds: 4,
        watermark: false,
        quantity: 1,
      },
      status: "active",
    },
    valueSources: {
      model: "服务端配置 ARK_VIDEO_MODEL;v01Contract.ts V01_VIDEO_MODEL;合同 v0.3.0 附表登记行",
      unit_price_fen:
        "80 积分/秒(本档 4 秒=320 积分):S47 任务包实测口径;合同 v0.3.0 附表;"
        + "docs/validation/v0.1/checkpoint-05-ark-paid-contract.md 成本核算(86,400 token×37 元/百万≈3.2 元/条,向上冻结);"
        + "v01Contract.ts V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND=80",
      params:
        "v01Contract.ts 冻结:720p/9:16/4 秒/watermark=false;quantity=1 为后端档位解析硬性要求;"
        + "旧 80 分固定档仅覆盖无输入视频,不写 supports_input_video;"
        + LEGACY_ROW_VERIFICATION_NOTE,
      tier_id: "合同 v0.3.0 附表登记 vid-seedance20fast-916-720p-4s(active)",
    },
  },
];

/** 音频参数档矩阵:两 seed 模型 × 2 音质(32k/48k)× 2 格式(mp3/wav)× 2 时长(3s/10s),
    扣除已有两档(48k/mp3/3s)后新增 14 档。音质/格式/时长全部落在真实原子档(先有档再有界面)。 */
interface NewAudioTierSpec {
  model: typeof MODEL_SEED_AUDIO_10 | typeof MODEL_SEED_AUDIO_10_MULTILINGUAL;
  sampleRate: 32000 | 48000;
  format: "mp3" | "wav";
  durationSeconds: 3 | 10;
}

const AUDIO_MODEL_LABELS: Record<string, string> = {
  [MODEL_SEED_AUDIO_10]: "Seed Audio 1.0",
  [MODEL_SEED_AUDIO_10_MULTILINGUAL]: "Seed Audio 1.0 多语言",
};
const AUDIO_PROVIDER_LABEL = "火山引擎";
const AUDIO_TIER_CAPABILITIES: string[] = ["text_to_speech"];

/** 新档 id 段 31–44(十进制,接续已有 29/30),避开 happyhorse 预留段。 */
function newAudioTierId(spec: NewAudioTierSpec): string {
  const modelSuffix = spec.model === MODEL_SEED_AUDIO_10_MULTILINGUAL ? "-multilingual" : "";
  return `aud-seedaudio10${modelSuffix}-${spec.sampleRate / 1000}k-${spec.format}-${spec.durationSeconds}s`;
}

function newAudioSeed(spec: NewAudioTierSpec, index: number): PricingTierSeed {
  const modelLabel = AUDIO_MODEL_LABELS[spec.model]!;
  const tierId = newAudioTierId(spec);
  const parameterDescription =
    `${spec.durationSeconds} 秒 / ${spec.format.toUpperCase()} / ${spec.sampleRate / 1000}kHz / 字幕开启;`
    + "AIGC 元数据开启、显式水印关闭;quantity=1";
  return {
    id: `00000000-5580-4000-8000-${String(31 + index).padStart(12, "0")}`,
    provider: "openspeech",
    model: spec.model,
    mediaKind: "audio",
    billingUnit: "second",
    unitPriceFen: 3,
    currency: "CNY",
    active: true,
    priceSourceKind: "内部定价",
    source: SEED_AUDIO_PRICING_SOURCE,
    tier: {
      tierId,
      params: {
        original_duration_seconds: spec.durationSeconds,
        format: spec.format,
        sample_rate: spec.sampleRate,
        enable_subtitle: true,
        aigc_metadata_enabled: true,
        aigc_watermark_enabled: false,
        quantity: 1,
      },
      status: "active",
      displayName: modelLabel,
      providerLabel: AUDIO_PROVIDER_LABEL,
      modelLabel,
      capabilities: AUDIO_TIER_CAPABILITIES,
    },
    valueSources: {
      model: `${spec.model};${modelLabel}`,
      unit_price_fen:
        `3 积分/秒(1 积分=1 分钱);R154 统筹冻结的内部售价;`
        + `官方成本 1 元/分钟(${SEED_AUDIO_PRICE_DOC_URL})`,
      params: parameterDescription,
      tier_id: `R154 命名 ${tierId}(active)`,
    },
  };
}

const NEW_AUDIO_SEEDS: readonly PricingTierSeed[] = (
  ([MODEL_SEED_AUDIO_10, MODEL_SEED_AUDIO_10_MULTILINGUAL] as const)
    .flatMap((model) => ([32000, 48000] as const)
      .flatMap((sampleRate) => (["mp3", "wav"] as const)
        .flatMap((format) => ([3, 10] as const)
          .map((durationSeconds) => ({ model, sampleRate, format, durationSeconds })))))
    .filter((spec) => !(spec.sampleRate === 48000 && spec.format === "mp3" && spec.durationSeconds === 3))
    .map((spec, index) => newAudioSeed(spec, index))
);

/** R154 内部售价档：官方成本 1 元/分钟，统筹冻结用户售价 3 积分/秒。 */
const AUDIO_SEEDS: readonly PricingTierSeed[] = [
  {
    id: "00000000-5580-4000-8000-000000000029",
    provider: "openspeech",
    model: MODEL_SEED_AUDIO_10,
    mediaKind: "audio",
    billingUnit: "second",
    unitPriceFen: 3,
    currency: "CNY",
    active: true,
    priceSourceKind: "内部定价",
    source: SEED_AUDIO_PRICING_SOURCE,
    tier: {
      tierId: "aud-seedaudio10-3s",
      params: {
        original_duration_seconds: 3,
        format: "mp3",
        sample_rate: 48000,
        enable_subtitle: true,
        aigc_metadata_enabled: true,
        aigc_watermark_enabled: false,
        quantity: 1,
      },
      status: "active",
      displayName: "Seed Audio 1.0",
      providerLabel: "火山引擎",
      modelLabel: "Seed Audio 1.0",
      capabilities: ["text_to_speech"],
    },
    valueSources: {
      model: `${MODEL_SEED_AUDIO_10};Seed Audio 1.0 标准模型`,
      unit_price_fen:
        `3 积分/秒(1 积分=1 分钱);R154 统筹冻结的内部售价;`
        + `官方成本 1 元/分钟(${SEED_AUDIO_PRICE_DOC_URL})`,
      params: "3 秒标准报价档;MP3/48kHz/字幕开启;AIGC 元数据开启、显式水印关闭;quantity=1",
      tier_id: "R154 命名 aud-seedaudio10-3s(active)",
    },
  },
  {
    id: "00000000-5580-4000-8000-000000000030",
    provider: "openspeech",
    model: MODEL_SEED_AUDIO_10_MULTILINGUAL,
    mediaKind: "audio",
    billingUnit: "second",
    unitPriceFen: 3,
    currency: "CNY",
    active: true,
    priceSourceKind: "内部定价",
    source: SEED_AUDIO_PRICING_SOURCE,
    tier: {
      tierId: "aud-seedaudio10-multilingual-3s",
      params: {
        original_duration_seconds: 3,
        format: "mp3",
        sample_rate: 48000,
        enable_subtitle: true,
        aigc_metadata_enabled: true,
        aigc_watermark_enabled: false,
        quantity: 1,
      },
      status: "active",
      displayName: "Seed Audio 1.0 多语言",
      providerLabel: "火山引擎",
      modelLabel: "Seed Audio 1.0 多语言",
      capabilities: ["text_to_speech"],
    },
    valueSources: {
      model: `${MODEL_SEED_AUDIO_10_MULTILINGUAL};Seed Audio 1.0 多语言模型`,
      unit_price_fen:
        `3 积分/秒(1 积分=1 分钱);R154 统筹冻结的内部售价;`
        + `官方成本 1 元/分钟(${SEED_AUDIO_PRICE_DOC_URL})`,
      params: "3 秒多语言报价档;MP3/48kHz/字幕开启;AIGC 元数据开启、显式水印关闭;quantity=1",
      tier_id: "R154 命名 aud-seedaudio10-multilingual-3s(active)",
    },
  },
  ...NEW_AUDIO_SEEDS,
];

const MINIMAX_SEEDS: readonly PricingTierSeed[] = [
  {
    id: "00000000-5590-4000-8000-000000000001",
    provider: "minimax",
    model: "image-01",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 3,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: FABLE007_DEV_SOURCE,
    tier: {
      tierId: "img-minimax-image01-169-1k-1",
      params: {
        aspect_ratio: "16:9",
        resolution: "1K",
        watermark: false,
        sequential_image_generation: "disabled",
        quantity: 1,
      },
      status: "experimental",
      displayName: "MiniMax Image 01 · 1K",
      providerLabel: "MiniMax",
      modelLabel: "Image 01",
      isDefault: true,
      capabilities: ["text_to_image", "image_reference", "aigc_watermark"],
      officialPriceSource: MINIMAX_PRICE_DOC_URL,
    },
    valueSources: {
      model: `MiniMax image-01;${MINIMAX_PRICE_DOC_URL}`,
      unit_price_fen: `官方 0.025 元/张,开发报价向上取整为 3 分/张;${MINIMAX_PRICE_DOC_URL}`,
      params: "1K/16:9/单张;供应商 AIGC 水印开启且平台继续写入隐式标识",
      tier_id: "FABLE-007 开发档 img-minimax-image01-169-1k-1",
    },
  },
  {
    id: "00000000-5590-4000-8000-000000000002",
    provider: "minimax",
    model: "image-01-live",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 3,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: FABLE007_DEV_SOURCE,
    tier: {
      tierId: "img-minimax-image01live-169-1k-1",
      params: {
        aspect_ratio: "16:9",
        resolution: "1K",
        watermark: false,
        sequential_image_generation: "disabled",
        quantity: 1,
      },
      status: "experimental",
      displayName: "MiniMax Image 01 Live · 1K",
      providerLabel: "MiniMax",
      modelLabel: "Image 01 Live",
      capabilities: ["text_to_image", "image_reference", "aigc_watermark"],
      officialPriceSource: MINIMAX_PRICE_DOC_URL,
    },
    valueSources: {
      model: `MiniMax image-01-live;${MINIMAX_PRICE_DOC_URL}`,
      unit_price_fen: `官方 0.025 元/张,开发报价向上取整为 3 分/张;${MINIMAX_PRICE_DOC_URL}`,
      params: "1K/16:9/单张;供应商 AIGC 水印开启且平台继续写入隐式标识",
      tier_id: "FABLE-007 开发档 img-minimax-image01live-169-1k-1",
    },
  },
  // 下面两条 MiniMax-H3 档（768P 50 分/秒、2K 80 分/秒）：2026-08-22 经官方公开按量价页
  // (platform.minimaxi.com/docs/guides/pricing-paygo.md) 核实，单价与 value_sources 记的
  // 官方牌价一致。**仍维持 priceSourceKind: "待核" 且 active: false**——核实的是官方对外价，
  // 我们的企业实价（折扣幅度）未知，据此报价会按牌价而非成本报。取证见 main#432。
  // 光看 value_sources 有官方 URL 就想摘「待核」的，先读 pricingRuleProvenance.ts 的注释。
  {
    id: "00000000-5590-4000-8000-000000000003",
    provider: "minimax",
    model: "MiniMax-H3",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 50,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: FABLE007_DEV_SOURCE,
    tier: {
      tierId: "vid-minimax-h3-169-768p-4s",
      params: {
        aspect_ratio: "16:9",
        resolution: "768P",
        duration_seconds: 4,
        watermark: false,
        quantity: 1,
      },
      status: "experimental",
      displayName: "MiniMax H3 · 768P · 4 秒",
      providerLabel: "MiniMax",
      modelLabel: "MiniMax H3",
      capabilities: ["text_to_video", "multimodal_reference", "aigc_watermark"],
      officialPriceSource: MINIMAX_PRICE_DOC_URL,
    },
    valueSources: {
      model: `MiniMax-H3;${MINIMAX_PRICE_DOC_URL}`,
      unit_price_fen: `官方 768P 0.50 元/秒;${MINIMAX_PRICE_DOC_URL}`,
      params: "768P/16:9/4 秒;供应商 AIGC 水印开启且平台继续写入隐式标识",
      tier_id: "FABLE-007 开发档 vid-minimax-h3-169-768p-4s",
    },
  },
  {
    id: "00000000-5590-4000-8000-000000000004",
    provider: "minimax",
    model: "MiniMax-H3",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: FABLE007_DEV_SOURCE,
    tier: {
      tierId: "vid-minimax-h3-169-2k-4s",
      params: {
        aspect_ratio: "16:9",
        resolution: "2K",
        duration_seconds: 4,
        watermark: false,
        quantity: 1,
      },
      status: "experimental",
      displayName: "MiniMax H3 · 2K · 4 秒",
      providerLabel: "MiniMax",
      modelLabel: "MiniMax H3",
      capabilities: ["text_to_video", "multimodal_reference", "aigc_watermark"],
      officialPriceSource: MINIMAX_PRICE_DOC_URL,
    },
    valueSources: {
      model: `MiniMax-H3;${MINIMAX_PRICE_DOC_URL}`,
      unit_price_fen: `官方 2K 0.80 元/秒;${MINIMAX_PRICE_DOC_URL}`,
      params: "2K/16:9/4 秒;供应商 AIGC 水印开启且平台继续写入隐式标识",
      tier_id: "FABLE-007 开发档 vid-minimax-h3-169-2k-4s",
    },
  },
  {
    id: "00000000-5590-4000-8000-000000000005",
    provider: "minimax",
    model: "speech-2.8-turbo",
    mediaKind: "audio",
    billingUnit: "ten_thousand_characters",
    unitPriceFen: 200,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: FABLE007_DEV_SOURCE,
    tier: {
      tierId: "aud-minimax-speech28turbo-mp3",
      params: {
        original_duration_seconds: 3,
        format: "mp3",
        sample_rate: 32000,
        enable_subtitle: true,
        aigc_metadata_enabled: true,
        aigc_watermark_enabled: false,
        quantity: 1,
      },
      status: "experimental",
      displayName: "MiniMax Speech 2.8 Turbo",
      providerLabel: "MiniMax",
      modelLabel: "Speech 2.8 Turbo",
      isDefault: true,
      capabilities: ["text_to_audio", "aigc_watermark", "mp3"],
      officialPriceSource: MINIMAX_PRICE_DOC_URL,
    },
    valueSources: {
      model: `MiniMax speech-2.8-turbo;${MINIMAX_PRICE_DOC_URL}`,
      unit_price_fen: `官方 2 元/万字符;中文字符按 2 个计费字符、其他字符按 1 个;${MINIMAX_PRICE_DOC_URL}`,
      params: "MP3/32kHz;按实际台词字符冻结报价;供应商与平台双层 AIGC 标识",
      tier_id: "FABLE-007 开发档 aud-minimax-speech28turbo-mp3",
    },
  },
  {
    id: "00000000-5590-4000-8000-000000000006",
    provider: "minimax",
    model: "speech-2.8-hd",
    mediaKind: "audio",
    billingUnit: "ten_thousand_characters",
    unitPriceFen: 350,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: FABLE007_DEV_SOURCE,
    tier: {
      tierId: "aud-minimax-speech28hd-mp3",
      params: {
        original_duration_seconds: 3,
        format: "mp3",
        sample_rate: 32000,
        enable_subtitle: true,
        aigc_metadata_enabled: true,
        aigc_watermark_enabled: false,
        quantity: 1,
      },
      status: "experimental",
      displayName: "MiniMax Speech 2.8 HD",
      providerLabel: "MiniMax",
      modelLabel: "Speech 2.8 HD",
      capabilities: ["text_to_audio", "aigc_watermark", "mp3"],
      officialPriceSource: MINIMAX_PRICE_DOC_URL,
    },
    valueSources: {
      model: `MiniMax speech-2.8-hd;${MINIMAX_PRICE_DOC_URL}`,
      unit_price_fen: `官方 3.5 元/万字符;中文字符按 2 个计费字符、其他字符按 1 个;${MINIMAX_PRICE_DOC_URL}`,
      params: "MP3/32kHz;按实际台词字符冻结报价;供应商与平台双层 AIGC 标识",
      tier_id: "FABLE-007 开发档 aud-minimax-speech28hd-mp3",
    },
  },
];

/**
 * FABLE-016 公司 newapi 预留档。unitPriceFen=0 是不可报价哨兵，不是免费价；
 * active=false + experimental 让公共投影和报价链都拒绝这两档。上游公开美元价
 * 只作为核价输入，公司网关 alias、折扣、汇率与内部积分价仍须公司账户确认。
 */
const NEWAPI_EXPERIMENTAL_SEEDS: readonly PricingTierSeed[] = [
  {
    id: "00000000-5590-4000-8000-000000000007",
    provider: "newapi",
    model: "gpt-image-2",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 0,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: FABLE016_NEWAPI_SOURCE,
    tier: {
      tierId: "img-newapi-gptimage2-11-1k-low",
      params: {
        aspect_ratio: "1:1",
        resolution: "1K",
        quality: "low",
        watermark: false,
        sequential_image_generation: "disabled",
        quantity: 1,
      },
      status: "experimental",
      displayName: "GPT Image 2 · 1K · Low",
      providerLabel: "公司聚合网关",
      modelLabel: "GPT Image 2",
      capabilities: ["text_to_image", "platform_aigc_metadata"],
      officialPriceSource: OPENAI_IMAGE_DOC_URL,
    },
    valueSources: {
      model: `OpenAI gpt-image-2;${OPENAI_IMAGE_DOC_URL}`,
      unit_price_fen:
        "0 仅作 inactive 未核价哨兵，不代表免费；官方公开 1024×1024 low 输出约"
        + ` $0.006/张；公司 newapi 折扣、汇率与内部积分价待核；${OPENAI_IMAGE_DOC_URL}`,
      params: "1K/1:1/low/单张；公司网关支持性待实测",
      tier_id: "FABLE-016 公司 newapi 预留档 img-newapi-gptimage2-11-1k-low",
    },
  },
  {
    id: "00000000-5590-4000-8000-000000000008",
    provider: "newapi",
    model: "gemini-3.1-pro-image",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 0,
    currency: "CNY",
    active: false,
    priceSourceKind: "待核",
    source: FABLE016_NEWAPI_SOURCE,
    tier: {
      tierId: "img-newapi-gemini31proimage-11-1k",
      params: {
        aspect_ratio: "1:1",
        resolution: "1K",
        watermark: false,
        sequential_image_generation: "disabled",
        quantity: 1,
      },
      status: "experimental",
      displayName: "Gemini 3.1 Pro Image · 1K",
      providerLabel: "公司聚合网关",
      modelLabel: "Gemini 3.1 Pro Image",
      capabilities: ["text_to_image", "platform_aigc_metadata"],
      officialPriceSource: GOOGLE_IMAGE_PRICE_DOC_URL,
    },
    valueSources: {
      model:
        "FABLE-016 指定公司 newapi alias=gemini-3.1-pro-image；Google 官方公开页当前"
        + `上游名为 gemini-3-pro-image，alias 映射待公司网关验证；${GOOGLE_IMAGE_PRICE_DOC_URL}`,
      unit_price_fen:
        "0 仅作 inactive 未核价哨兵，不代表免费；官方上游 1K/2K 输出 $0.134/张、"
        + `4K $0.24/张；公司 newapi 折扣、汇率与内部积分价待核；${GOOGLE_IMAGE_PRICE_DOC_URL}`,
      params: "1K/1:1/单张；公司网关 alias、尺寸参数与返回格式待实测",
      tier_id: "FABLE-016 公司 newapi 预留档 img-newapi-gemini31proimage-11-1k",
    },
  },
];

const SUCHUANG_GPT_IMAGE_2_RATIOS = [
  "auto", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4",
  "21:9", "9:21", "1:3", "3:1", "2:1", "1:2",
] as const;
const SUCHUANG_NANOBANANA_LITE_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "21:9",
] as const;
const SUCHUANG_NANOBANANA_2_RATIOS = [
  ...SUCHUANG_NANOBANANA_LITE_RATIOS,
  "1:4", "1:8", "4:1", "8:1",
] as const;
const SUCHUANG_NANOBANANA_2_SIZES = ["1K", "2K", "4K"] as const;

interface SuchuangImageTier {
  model: "gpt-image-2-suchuang" | "nanobanana-lite" | "nanobanana-2";
  modelLabel: string;
  ratio: string;
  size?: string;
  unitPriceFen: 8 | 10;
  documentUrl: string;
}

function suchuangTierId(entry: SuchuangImageTier): string {
  const model = entry.model
    .replace("-suchuang", "")
    .replaceAll("-", "");
  const ratio = entry.ratio.replace(":", "x");
  const size = entry.size ? `-${entry.size.toLowerCase()}` : "";
  return `img-suchuang-${model}-${ratio}${size}-1`;
}

function suchuangImageSeed(entry: SuchuangImageTier, index: number): PricingTierSeed {
  const tierId = suchuangTierId(entry);
  const priceYuan = (entry.unitPriceFen / 100).toFixed(2);
  const parameterDescription = entry.size
    ? `${entry.size} / ${entry.ratio} / 单张`
    : `${entry.ratio} / 单张；供应商字段 size 表示画幅`;
  const userDescription = entry.size
    ? `${entry.size}、${entry.ratio}，按 1 张计价；这不是模型能力上限`
    : `${entry.ratio}，按 1 张计价；这不是模型能力上限`;
  return {
    id: `00000000-5591-4000-8000-${String(index + 1).padStart(12, "0")}`,
    provider: "suchuang",
    model: entry.model,
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: entry.unitPriceFen,
    currency: "CNY",
    active: true,
    priceSourceKind: "内部定价",
    source: ISSUE157_SUCHUANG_SOURCE,
    tier: {
      tierId,
      params: {
        aspect_ratio: entry.ratio,
        ...(entry.size ? { resolution: entry.size } : {}),
        quantity: 1,
      },
      status: "active",
      displayName: userDescription,
      providerLabel: "公司图片网关",
      modelLabel: entry.modelLabel,
      capabilities: ["text_to_image", "image_reference", "platform_aigc_metadata"],
      officialPriceSource: entry.documentUrl,
    },
    valueSources: {
      model: `${entry.modelLabel} 临时公司通道模型；${entry.documentUrl}`,
      unit_price_fen:
        `${entry.unitPriceFen} 积分/张（1 积分=1 分钱，${priceYuan} 元/张）；`
        + `2026-08-06 产品负责人确认核账口径；${entry.documentUrl}`,
      params: `${parameterDescription}；参数值域逐模型按供应商文档独立登记，不与其他模型合并`,
      tier_id: `#157 公司图片网关计费档 ${tierId}`,
    },
  };
}

const SUCHUANG_IMAGE_SEEDS: readonly PricingTierSeed[] = [
  ...SUCHUANG_GPT_IMAGE_2_RATIOS.map((ratio) => ({
    model: "gpt-image-2-suchuang" as const,
    modelLabel: "GPT Image 2",
    ratio,
    unitPriceFen: 10 as const,
    documentUrl: SUCHUANG_GPT_IMAGE_2_DOC_URL,
  })),
  ...SUCHUANG_NANOBANANA_LITE_RATIOS.map((ratio) => ({
    model: "nanobanana-lite" as const,
    modelLabel: "NanoBanana Lite",
    ratio,
    size: "1K",
    unitPriceFen: 8 as const,
    documentUrl: SUCHUANG_NANOBANANA_LITE_DOC_URL,
  })),
  ...SUCHUANG_NANOBANANA_2_SIZES.flatMap((size) => (
    SUCHUANG_NANOBANANA_2_RATIOS.map((ratio) => ({
      model: "nanobanana-2" as const,
      modelLabel: "NanoBanana 2",
      ratio,
      size,
      unitPriceFen: 10 as const,
      documentUrl: SUCHUANG_NANOBANANA_2_DOC_URL,
    }))
  )),
].map(suchuangImageSeed);

/**
 * Lite 批次二的 active 视频档：2.5 档 vid-seedance25-ep-916-720p-4s =
 * DC 自建 Seedance 2.5 专用接入点(折扣绑定)。
 *    售价折算:arkcli pricing models 2026-08-08 账号折后价 NV2VCompletion 0.07 元/千 token
 *    (=70 元/百万 token);720p/9:16 921,600 像素×24fps÷1024=21,600 token/秒 × 70 元/百万
 *    = 151.2 分/秒,按本文件既有规则(加成率 1.0、向上取整到 5 积分)= 155 积分/秒。
 *    DC 确认前按此登记;确认后如漂移,改价走 POST /api/v1/admin/pricing-rules 管理动作。
 * 注意:pricing_rules 视频档只支持 second 计费(分/秒);任务口径里的
 * unit_price_cny_micros / million_output_tokens / video_token_formula 属供应商成本基数
 * (provider_cost_basis,config_entries)词汇,不经本脚本播种——fast 的成本基数 migration 038
 * 已有,2.5 接入点的成本基数条目待协调者另行登记(本批不含迁移)。
 * 报价守卫目录(tierPricingGuard.ts PRICE_DEFINITIONS)未收录该 tier_id 之前,
 * 公共投影按 pricing_unverified 冻结、报价链 fail-closed;守卫登记与逐档实测激活证据
 * 由协调者另行收口,本脚本绝不伪造证据。
 */
const LITE_B2_VIDEO_SEEDS: readonly PricingTierSeed[] = [
  {
    id: "00000000-55b2-4000-8000-000000000002",
    provider: "ark",
    model: MODEL_SEEDANCE_25_ENDPOINT,
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 155,
    currency: "CNY",
    active: true,
    priceSourceKind: "内部定价",
    source: LITE_B2_SOURCE,
    tier: {
      tierId: "vid-seedance25-ep-916-720p-4s",
      params: {
        aspect_ratio: "9:16",
        resolution: "720p",
        duration_seconds: 4,
        watermark: false,
        quantity: 1,
      },
      status: "active",
      displayName: "Seedance 2.5 · 720P · 4 秒",
      providerLabel: "火山方舟",
      modelLabel: "Seedance 2.5(专用接入点)",
    },
    valueSources: {
      model:
        `DC 自建 Seedance 2.5 专用接入点 ${MODEL_SEEDANCE_25_ENDPOINT}(折扣绑定在该接入点,`
        + "DC 2026-08-07 拍板实测出片);提交时 model 字段即此 ep id;能力登记见"
        + "v01Contract.ts ARK_SEEDANCE_2_5_ENDPOINT_MODEL(720p/1080p)",
      unit_price_fen:
        "155 积分/秒(1 积分=1 分钱,4 秒条=620 积分):arkcli pricing models 2026-08-08 账号折后价"
        + "NV2VCompletion 0.07 元/千 token(=70 元/百万 token);720p/9:16 921,600 像素×24fps÷1024"
        + "=21,600 token/秒 × 70 元/百万 = 151.2 分/秒,向上取整到 5 积分 = 155;DC 确认前按此登记",
      params:
        "720p/9:16/4 秒/watermark=false/quantity=1 与现行视频档一致;不写 supports_input_video;"
        + "该接入点的供应商成本基数(provider_cost_basis)条目本批未登记(不含迁移),由协调者另行收口",
      tier_id: "Lite 批次二命名 vid-seedance25-ep-916-720p-4s(ep=专用接入点)",
    },
  },
];

/** 视频刊例价(元/百万 token,输入不含视频);fast/mini 官方不支持 1080p/4k,故无档。 */
const VIDEO_LIST_PRICE_YUAN_PER_MILLION_TOKENS: Readonly<Record<string, Partial<Record<VideoResolution, number>>>> = {
  [MODEL_SEEDANCE_20]: { "480p": 46, "720p": 46, "1080p": 51, "4k": 26 },
  [MODEL_SEEDANCE_20_FAST]: { "480p": 37, "720p": 37 },
  [MODEL_SEEDANCE_20_MINI]: { "480p": 23, "720p": 23 },
};

interface NewImageTierRow {
  nn: string;
  tierId: string;
  unitPriceFen: number;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
}

interface NewVideoTierRow {
  nn: string;
  tierId: string;
  model: string;
  unitPriceFen: number;
  aspectRatio: AspectRatio;
  resolution: VideoResolution;
  rateLimitHint?: string;
}

/** 新图片档(nn 01-05;16:9 2K 即旧档 img-seedream5pro-169-2k-1,不重复)。 */
const NEW_IMAGE_TIERS: readonly NewImageTierRow[] = [
  { nn: "01", tierId: "img-seedream5pro-169-1k-1", unitPriceFen: 30, aspectRatio: "16:9", resolution: "1K" },
  { nn: "02", tierId: "img-seedream5pro-916-1k-1", unitPriceFen: 30, aspectRatio: "9:16", resolution: "1K" },
  { nn: "03", tierId: "img-seedream5pro-11-1k-1", unitPriceFen: 30, aspectRatio: "1:1", resolution: "1K" },
  { nn: "04", tierId: "img-seedream5pro-916-2k-1", unitPriceFen: 60, aspectRatio: "9:16", resolution: "2K" },
  { nn: "05", tierId: "img-seedream5pro-11-2k-1", unitPriceFen: 60, aspectRatio: "1:1", resolution: "2K" },
];

/** 新视频档(nn 06-28;时长 4-15 秒不拆档,estimate 按秒计,故 params 不含 duration_seconds)。 */
const NEW_VIDEO_TIERS: readonly NewVideoTierRow[] = [
  { nn: "06", tierId: "vid-seedance20-169-480p", model: MODEL_SEEDANCE_20, unitPriceFen: 50, aspectRatio: "16:9", resolution: "480p" },
  { nn: "07", tierId: "vid-seedance20-916-480p", model: MODEL_SEEDANCE_20, unitPriceFen: 50, aspectRatio: "9:16", resolution: "480p" },
  { nn: "08", tierId: "vid-seedance20-11-480p", model: MODEL_SEEDANCE_20, unitPriceFen: 45, aspectRatio: "1:1", resolution: "480p" },
  { nn: "09", tierId: "vid-seedance20-169-720p", model: MODEL_SEEDANCE_20, unitPriceFen: 100, aspectRatio: "16:9", resolution: "720p" },
  { nn: "10", tierId: "vid-seedance20-916-720p", model: MODEL_SEEDANCE_20, unitPriceFen: 100, aspectRatio: "9:16", resolution: "720p" },
  { nn: "11", tierId: "vid-seedance20-11-720p", model: MODEL_SEEDANCE_20, unitPriceFen: 100, aspectRatio: "1:1", resolution: "720p" },
  { nn: "12", tierId: "vid-seedance20-169-1080p", model: MODEL_SEEDANCE_20, unitPriceFen: 250, aspectRatio: "16:9", resolution: "1080p" },
  { nn: "13", tierId: "vid-seedance20-916-1080p", model: MODEL_SEEDANCE_20, unitPriceFen: 250, aspectRatio: "9:16", resolution: "1080p" },
  { nn: "14", tierId: "vid-seedance20-11-1080p", model: MODEL_SEEDANCE_20, unitPriceFen: 250, aspectRatio: "1:1", resolution: "1080p" },
  { nn: "15", tierId: "vid-seedance20-169-4k", model: MODEL_SEEDANCE_20, unitPriceFen: 510, aspectRatio: "16:9", resolution: "4k", rateLimitHint: RATE_LIMIT_HINT_4K },
  { nn: "16", tierId: "vid-seedance20-916-4k", model: MODEL_SEEDANCE_20, unitPriceFen: 510, aspectRatio: "9:16", resolution: "4k", rateLimitHint: RATE_LIMIT_HINT_4K },
  { nn: "17", tierId: "vid-seedance20-11-4k", model: MODEL_SEEDANCE_20, unitPriceFen: 510, aspectRatio: "1:1", resolution: "4k", rateLimitHint: RATE_LIMIT_HINT_4K },
  { nn: "18", tierId: "vid-seedance20fast-169-480p", model: MODEL_SEEDANCE_20_FAST, unitPriceFen: 40, aspectRatio: "16:9", resolution: "480p" },
  { nn: "19", tierId: "vid-seedance20fast-916-480p", model: MODEL_SEEDANCE_20_FAST, unitPriceFen: 40, aspectRatio: "9:16", resolution: "480p" },
  { nn: "20", tierId: "vid-seedance20fast-11-480p", model: MODEL_SEEDANCE_20_FAST, unitPriceFen: 40, aspectRatio: "1:1", resolution: "480p" },
  { nn: "21", tierId: "vid-seedance20fast-169-720p", model: MODEL_SEEDANCE_20_FAST, unitPriceFen: 80, aspectRatio: "16:9", resolution: "720p" },
  { nn: "22", tierId: "vid-seedance20fast-11-720p", model: MODEL_SEEDANCE_20_FAST, unitPriceFen: 80, aspectRatio: "1:1", resolution: "720p" },
  { nn: "23", tierId: "vid-seedance20mini-169-480p", model: MODEL_SEEDANCE_20_MINI, unitPriceFen: 25, aspectRatio: "16:9", resolution: "480p" },
  { nn: "24", tierId: "vid-seedance20mini-916-480p", model: MODEL_SEEDANCE_20_MINI, unitPriceFen: 25, aspectRatio: "9:16", resolution: "480p" },
  { nn: "25", tierId: "vid-seedance20mini-11-480p", model: MODEL_SEEDANCE_20_MINI, unitPriceFen: 25, aspectRatio: "1:1", resolution: "480p" },
  { nn: "26", tierId: "vid-seedance20mini-169-720p", model: MODEL_SEEDANCE_20_MINI, unitPriceFen: 50, aspectRatio: "16:9", resolution: "720p" },
  { nn: "27", tierId: "vid-seedance20mini-916-720p", model: MODEL_SEEDANCE_20_MINI, unitPriceFen: 50, aspectRatio: "9:16", resolution: "720p" },
  { nn: "28", tierId: "vid-seedance20mini-11-720p", model: MODEL_SEEDANCE_20_MINI, unitPriceFen: 50, aspectRatio: "1:1", resolution: "720p" },
];

function imageValueSources(entry: NewImageTierRow): Record<string, string> {
  const band = entry.resolution === "1K"
    ? "1.5K 及以下(≤261 万像素)0.30 元/张"
    : "高于 1.5K(>261 万像素)0.60 元/张";
  return {
    unit_price_fen:
      `官方牌价 ${band}(${DOCS_PRICE_URL});成本 × 加成率 1.0,向上取整到 5 积分 = ${entry.unitPriceFen} 积分/张`,
    model:
      `${MODEL_SEEDREAM_5_PRO},火山方舟模型列表(${DOCS_MODELS_URL});`
      + `仅 1K/2K 两档(无 4K),规格见 docs.volcengine.com/docs/82379/2582774、${DOCS_PIXELS_URL} 教程`,
    params:
      "S58 全量档位矩阵(比例 16:9/9:16/1:1 × 分辨率 1K/2K;16:9 2K 为现行档 img-seedream5pro-169-2k-1);"
      + "watermark=false、sequential_image_generation=disabled、quantity=1 与现行档一致",
    tier_id: `S58 命名延续 ${entry.tierId}`,
  };
}

function videoValueSources(entry: NewVideoTierRow): Record<string, string> {
  const listPrice = VIDEO_LIST_PRICE_YUAN_PER_MILLION_TOKENS[entry.model]?.[entry.resolution];
  if (listPrice === undefined) throw new Error(`缺少官方刊例价:${entry.model} ${entry.resolution}`);
  const { label: pixelLabel, pixels } = videoPixels(entry.resolution, entry.aspectRatio === "1:1");
  const tokensPerSecond = (pixels * 24) / 1024;
  const costFenPerSecond = ((tokensPerSecond * listPrice) / 10_000).toFixed(2);
  const family = entry.model === MODEL_SEEDANCE_20_FAST
    ? "fast"
    : entry.model === MODEL_SEEDANCE_20_MINI ? "mini" : "本体";
  return {
    unit_price_fen:
      `官方刊例 ${listPrice} 元/百万 token(输入不含视频,${DOCS_PRICE_URL});`
      + `token=宽×高×24fps×秒/1024,${entry.resolution} ${pixelLabel}=${pixels.toLocaleString("en-US")} 像素 `
      + `→ ${tokensPerSecond.toLocaleString("en-US")} token/秒(${DOCS_PIXELS_URL});`
      + `成本 ${costFenPerSecond} 分/秒 × 加成率 1.0,向上取整到 5 积分 = ${entry.unitPriceFen} 积分/秒`,
    model: `${entry.model},火山方舟模型列表(${DOCS_MODELS_URL})`,
    params:
      "S58 全量档位矩阵(比例 16:9/9:16/1:1 × 分辨率);时长 4-15 秒不拆档,estimate 按秒计;"
      + "watermark=false、quantity=1 与现行档一致;"
      + "官方公式不授权视频参考报价,本档不写 supports_input_video;"
      + (family === "本体" ? "本体覆盖 480p/720p/1080p/4k" : `${family} 无 1080p/4k 档(官方不支持)`),
    tier_id: `S58 命名延续 ${entry.tierId}(时长不拆档,不带旧档 -4s 时长段)`,
  };
}

/** 像素表(docs.volcengine.com/docs/82379/2298881);720p 起官方按「全比例」同一像素量计。 */
function videoPixels(resolution: VideoResolution, square: boolean): { label: string; pixels: number } {
  if (resolution === "480p") {
    return square
      ? { label: "640×640", pixels: 409_600 }
      : { label: "864×496 / 496×864", pixels: 428_544 };
  }
  if (resolution === "720p") return { label: "全比例", pixels: 921_600 };
  if (resolution === "1080p") return { label: "全比例", pixels: 2_073_600 };
  return { label: "全比例", pixels: 8_294_400 };
}

function newImageSeed(entry: NewImageTierRow): PricingTierSeed {
  return {
    id: `00000000-5580-4000-8000-0000000000${entry.nn}`,
    provider: "ark",
    model: MODEL_SEEDREAM_5_PRO,
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: entry.unitPriceFen,
    currency: "CNY",
    active: false,
    priceSourceKind: INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND,
    source: SEED_SOURCE,
    tier: {
      tierId: entry.tierId,
      params: {
        aspect_ratio: entry.aspectRatio,
        resolution: entry.resolution,
        watermark: false,
        sequential_image_generation: "disabled",
        quantity: 1,
      },
      status: "experimental",
    },
    valueSources: imageValueSources(entry),
  };
}

function newVideoSeed(entry: NewVideoTierRow): PricingTierSeed {
  return {
    id: `00000000-5580-4000-8000-0000000000${entry.nn}`,
    provider: "ark",
    model: entry.model,
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: entry.unitPriceFen,
    currency: "CNY",
    active: false,
    priceSourceKind: INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND,
    ...(entry.rateLimitHint ? { rateLimitHint: entry.rateLimitHint } : {}),
    source: SEED_SOURCE,
    tier: {
      tierId: entry.tierId,
      params: {
        aspect_ratio: entry.aspectRatio,
        resolution: entry.resolution,
        watermark: false,
        quantity: 1,
      },
      status: "experimental",
    },
    valueSources: videoValueSources(entry),
  };
}

const HAPPYHORSE_PREVIEW_SOURCE = "seed:happyhorse-preview:scripts/seed-pricing-tiers.mts";
const HAPPYHORSE_PREVIEW_DESIGN_DOC_URL = "docs/design/happyhorse-preview-integration-2026-08-18.md";

/** 快乐马(HappyHorse)预览档(设计文档 §3.2):低价快速预览,与正式视频同一条
    版本流,靠 metadata.preview 徽记区分;不设默认、不进正式级联。 */
const HAPPYHORSE_PREVIEW_SEEDS: readonly PricingTierSeed[] = [
  {
    id: "00000000-5610-4000-8000-000000000001",
    provider: "happyhorse",
    model: "happyhorse-1.1-r2v",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 8,
    currency: "CNY",
    active: true,
    priceSourceKind: "内部定价",
    source: HAPPYHORSE_PREVIEW_SOURCE,
    tier: {
      tierId: "happyhorse-preview-480p-5s",
      params: {
        aspect_ratio: "9:16",
        resolution: "480p",
        duration_seconds: 5,
        watermark: false,
        preview: true,
        quantity: 1,
      },
      status: "active",
      displayName: "快乐马 · 预览",
      providerLabel: "快乐马",
      modelLabel: "happyhorse-1.1-r2v",
      capabilities: ["text_to_video", "multimodal_reference"],
    },
    valueSources: {
      model:
        `HappyHorse 1.1 r2v(供应商真实 model id 由部署 env HAPPYHORSE_MODEL 显式配置,`
        + `此处仅作展示标签,非凭据绑定;${HAPPYHORSE_PREVIEW_DESIGN_DOC_URL})`,
      unit_price_fen:
        "8 积分/秒(设计文档 §3.2 内部定价:快乐马低价预览,5 秒条=40 积分;"
        + "未做真实付费冒烟前仅 dev 环境报价,回执必注明;"
        + `${HAPPYHORSE_PREVIEW_DESIGN_DOC_URL})`,
      params:
        "480p/9:16/5 秒/watermark=false/preview=true/quantity=1;preview 键经"
        + "providerParameters 合法化为 GenerationParameters.preview(设计文档 §2.1)",
      tier_id: "设计文档 §3.2 定名 happyhorse-preview-480p-5s",
    },
  },
];

export const PRICING_TIER_SEEDS: readonly PricingTierSeed[] = [
  ...LEGACY_SEEDS,
  ...NEW_IMAGE_TIERS.map(newImageSeed),
  ...NEW_VIDEO_TIERS.map(newVideoSeed),
  ...AUDIO_SEEDS,
  ...MINIMAX_SEEDS,
  ...NEWAPI_EXPERIMENTAL_SEEDS,
  ...SUCHUANG_IMAGE_SEEDS,
  ...LITE_B2_VIDEO_SEEDS,
  ...HAPPYHORSE_PREVIEW_SEEDS,
];

const SGOAL04_P2_DEV_PROMOTION_PARAMETERS: Readonly<Record<string, Record<string, string | number | boolean>>> = {
  "img-seedream5pro-916-2k-1": {},
  "img-seedream5pro-11-2k-1": {},
  "img-seedream5pro-169-1k-1": {},
  "vid-seedance20-916-720p": { duration_seconds: 4 },
  "vid-seedance20-169-1080p": { duration_seconds: 4 },
  "vid-seedance20fast-169-720p": { duration_seconds: 8 },
  "vid-seedance20mini-916-720p": { duration_seconds: 4 },
};

/**
 * S-goal-04 首批可见档位。它们只把官方能力矩阵中的 7 个组合开放给开发环境冒烟；
 * 生产仍需真实调用、成本核对和管理动作，不能直接复用这次启用。
 */
export function createSgoal04P2DevPromotionSeeds(): PricingTierSeed[] {
  return Object.entries(SGOAL04_P2_DEV_PROMOTION_PARAMETERS).map(([tierId, extraParams]) => {
    const baseline = PRICING_TIER_SEEDS.find((seed) => seed.tier.tierId === tierId);
    if (!baseline || baseline.active) throw new Error(`S-goal-04 开发档不存在或已是正式档:${tierId}`);
    return {
      ...baseline,
      active: true,
      priceSourceKind: "待核",
      activationScope: "dev_smoke_only",
      source: SGOAL04_P2_DEV_SOURCE,
      tier: {
        ...baseline.tier,
        params: { ...baseline.tier.params, ...extraParams },
        status: "active",
      },
      valueSources: {
        ...baseline.valueSources,
        activation:
          "S-goal-04 P2 开发环境可见档；仅用于报价链与真实冒烟，生产启用仍需逐档核账与管理动作",
      },
    };
  });
}

interface Fable007PromotionOverrides {
  params?: Record<string, string | number | boolean>;
  isDefault?: boolean;
  displayName?: string;
  providerLabel?: string;
  modelLabel?: string;
  capabilities?: string[];
  officialPriceSource?: string;
}

const FABLE007_DEV_PROMOTIONS: Readonly<Record<string, Fable007PromotionOverrides>> = {
  "img-seedream5pro-169-1k-1": {
    isDefault: true,
    displayName: "Seedream 5.0 Pro · 1K",
    providerLabel: "火山方舟",
    modelLabel: "Seedream 5.0 Pro",
    capabilities: ["text_to_image", "image_reference", "platform_aigc_metadata"],
    officialPriceSource: `https://${DOCS_PRICE_URL}`,
  },
  "vid-seedance20mini-169-480p": {
    params: { duration_seconds: 4 },
    isDefault: true,
    displayName: "Seedance 2.0 Mini · 480P · 4 秒",
    providerLabel: "火山方舟",
    modelLabel: "Seedance 2.0 Mini",
    capabilities: ["text_to_video", "multimodal_reference", "platform_aigc_metadata"],
    officialPriceSource: "https://www.volcengine.com/product/doubao",
  },
};

const RETIRED_FABLE007_MINIMAX_TIER_IDS = MINIMAX_SEEDS.map((seed) => seed.tier.tierId);

function promoteFable007Seed(
  baseline: PricingTierSeed,
  overrides: Fable007PromotionOverrides,
): PricingTierSeed {
  if (baseline.active) {
    throw new Error(`FABLE-007 开发档已是正式档:${baseline.tier.tierId}`);
  }
  return {
    ...baseline,
    active: true,
    priceSourceKind: "待核",
    activationScope: "dev_smoke_only",
    source: FABLE007_DEV_SOURCE,
    tier: {
      ...baseline.tier,
      params: { ...baseline.tier.params, ...(overrides.params ?? {}) },
      status: "active",
      ...(overrides.displayName ? { displayName: overrides.displayName } : {}),
      ...(overrides.providerLabel ? { providerLabel: overrides.providerLabel } : {}),
      ...(overrides.modelLabel ? { modelLabel: overrides.modelLabel } : {}),
      ...(overrides.isDefault !== undefined ? { isDefault: overrides.isDefault } : {}),
      ...(overrides.capabilities ? { capabilities: [...overrides.capabilities] } : {}),
      ...(overrides.officialPriceSource
        ? { officialPriceSource: overrides.officialPriceSource }
        : {}),
    },
    valueSources: {
      ...baseline.valueSources,
      activation:
        "FABLE-007 多模型开发环境可见档；仅用于受控小额实调，生产启用仍需独立管理动作",
    },
  };
}

/** FABLE-016 后，FABLE-007 dev 可见矩阵只保留 Ark 字节系档位。 */
export function createFable007DevPromotionSeeds(): PricingTierSeed[] {
  return Object.entries(FABLE007_DEV_PROMOTIONS).map(([tierId, overrides]) => {
    const baseline = PRICING_TIER_SEEDS.find((seed) => seed.tier.tierId === tierId);
    if (!baseline) throw new Error(`FABLE-007 开发档不存在:${tierId}`);
    return promoteFable007Seed(baseline, overrides);
  });
}

/** 仅用于精确识别并撤销 FABLE-016 前曾写入 dev 的 MiniMax 可见快照。 */
export function createRetiredFable007MinimaxDevPromotionSeeds(): PricingTierSeed[] {
  return RETIRED_FABLE007_MINIMAX_TIER_IDS.map((tierId) => {
    const baseline = PRICING_TIER_SEEDS.find((seed) => seed.tier.tierId === tierId);
    if (!baseline) throw new Error(`已退役 MiniMax 开发档不存在:${tierId}`);
    return promoteFable007Seed(baseline, {});
  });
}

export function metadataFor(seed: PricingTierSeed): Record<string, unknown> {
  return {
    capability_tier: {
      tier_id: seed.tier.tierId,
      params: seed.tier.params,
      status: seed.tier.status,
      ...(seed.tier.displayName ? { display_name: seed.tier.displayName } : {}),
      ...(seed.tier.providerLabel ? { provider_label: seed.tier.providerLabel } : {}),
      ...(seed.tier.modelLabel ? { model_label: seed.tier.modelLabel } : {}),
      ...(seed.tier.isDefault !== undefined ? { is_default: seed.tier.isDefault } : {}),
      ...(seed.tier.capabilities ? { capabilities: seed.tier.capabilities } : {}),
      ...(seed.tier.officialPriceSource
        ? { official_price_source: seed.tier.officialPriceSource }
        : {}),
    },
    value_sources: seed.valueSources,
    price_source_kind: seed.priceSourceKind,
    ...(seed.supportsInputVideo === true ? { supports_input_video: true } : {}),
    ...(seed.rateLimitHint ? { rate_limit_hint: seed.rateLimitHint } : {}),
    ...(seed.activationScope ? { activation_scope: seed.activationScope } : {}),
  };
}

function sameTierMetadata(seed: PricingTierSeed, metadata: Record<string, unknown>): boolean {
  const tier = (metadata as { capability_tier?: unknown }).capability_tier;
  if (!tier || typeof tier !== "object") return false;
  const expected = metadataFor(seed).capability_tier;
  return JSON.stringify(sortJson(tier)) === JSON.stringify(sortJson(expected));
}

function readTierId(metadata: Record<string, unknown>): string | null {
  const tier = (metadata as { capability_tier?: unknown }).capability_tier;
  if (!tier || typeof tier !== "object") return null;
  const tierId = (tier as Record<string, unknown>).tier_id;
  return typeof tierId === "string" ? tierId : null;
}

function readSupportsInputVideo(metadata: Record<string, unknown>): boolean {
  return (metadata as { supports_input_video?: unknown }).supports_input_video === true;
}

function readRateLimitHint(metadata: Record<string, unknown>): string | undefined {
  const hint = (metadata as { rate_limit_hint?: unknown }).rate_limit_hint;
  return typeof hint === "string" ? hint : undefined;
}

function readPriceSourceKind(metadata: Record<string, unknown>): unknown {
  return metadata.price_source_kind;
}

function readValueSources(metadata: Record<string, unknown>): unknown {
  return metadata.value_sources;
}

function readActivationScope(metadata: Record<string, unknown>): unknown {
  return metadata.activation_scope;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]));
}

/**
 * 纯函数:给定候选行(当前 active 行 + seed 固定 id 行,后者可 inactive),决定每个 seed 的动作。
 * 漂移即 conflict——seed 的使命是把新环境带到登记状态,不是改已有环境的价格。
 */
export function planPricingTierSeed(
  seeds: readonly PricingTierSeed[],
  existingRows: readonly ExistingPricingRuleRow[],
): PricingTierSeedAction[] {
  return seeds.map((seed) => {
    const naturalMatches = existingRows.filter((row) => row.active
      && row.provider === seed.provider
      && row.model === seed.model
      && row.mediaKind === seed.mediaKind
      && row.billingUnit === seed.billingUnit
      && readTierId(row.metadata) === seed.tier.tierId);
    const fixedIdMatches = existingRows.filter((row) => row.id === seed.id);
    const candidates = [...new Map(
      [...naturalMatches, ...fixedIdMatches].map((row) => [row.id, row]),
    ).values()];
    if (candidates.length === 0) return { kind: "insert", seed };
    const current = candidates[0]!;
    const differences: string[] = [];
    if (candidates.length > 1) {
      differences.push(`重复匹配行: ${candidates.map((row) => row.id).join(", ")}`);
    }
    if (current.provider !== seed.provider) {
      differences.push(`provider: 现 ${current.provider} ≠ seed ${seed.provider}`);
    }
    if (current.model !== seed.model) {
      differences.push(`model: 现 ${current.model} ≠ seed ${seed.model}`);
    }
    if (current.mediaKind !== seed.mediaKind) {
      differences.push(`media_kind: 现 ${current.mediaKind} ≠ seed ${seed.mediaKind}`);
    }
    if (current.billingUnit !== seed.billingUnit) {
      differences.push(`billing_unit: 现 ${current.billingUnit} ≠ seed ${seed.billingUnit}`);
    }
    if (current.unitPriceFen !== seed.unitPriceFen) {
      differences.push(`unit_price_fen: 现 ${current.unitPriceFen} ≠ seed ${seed.unitPriceFen}`);
    }
    if (current.currency !== seed.currency) {
      differences.push(`currency: 现 ${current.currency} ≠ seed ${seed.currency}`);
    }
    if (current.active !== seed.active) {
      differences.push(`active: 现 ${current.active} ≠ seed ${seed.active}`);
    }
    if (current.source !== seed.source) {
      differences.push(`source: 现 ${current.source} ≠ seed ${seed.source}`);
    }
    if (!sameTierMetadata(seed, current.metadata)) {
      differences.push("metadata.capability_tier 与 seed 不一致");
    }
    if (readPriceSourceKind(current.metadata) !== seed.priceSourceKind) {
      differences.push("metadata.price_source_kind 与 seed 不一致");
    }
    if (JSON.stringify(sortJson(readValueSources(current.metadata)))
      !== JSON.stringify(sortJson(seed.valueSources))) {
      differences.push("metadata.value_sources 与 seed 不一致");
    }
    const expectedSupportsInputVideo = seed.supportsInputVideo === true;
    const currentSupportsInputVideo = readSupportsInputVideo(current.metadata);
    if (currentSupportsInputVideo !== expectedSupportsInputVideo) {
      differences.push(`metadata.supports_input_video: 现 ${currentSupportsInputVideo} ≠ seed ${expectedSupportsInputVideo}`);
    }
    const currentRateLimitHint = readRateLimitHint(current.metadata);
    if (currentRateLimitHint !== seed.rateLimitHint) {
      differences.push(`metadata.rate_limit_hint: 现 ${currentRateLimitHint ?? "无"} ≠ seed ${seed.rateLimitHint ?? "无"}`);
    }
    if (readActivationScope(current.metadata) !== seed.activationScope) {
      differences.push(
        `metadata.activation_scope: 现 ${String(readActivationScope(current.metadata) ?? "无")}`
        + ` ≠ seed ${seed.activationScope ?? "无"}`,
      );
    }
    if (JSON.stringify(sortJson(current.metadata))
      !== JSON.stringify(sortJson(metadataFor(seed)))) {
      differences.push("metadata 完整快照与 seed 不一致（含 seed 未声明字段）");
    }
    if (differences.length === 0) return { kind: "skip", seed, existingId: current.id };
    return { kind: "conflict", seed, existingId: current.id, differences };
  });
}

const FABLE007_MINIMAX_AUDIO_TIER_IDS = new Set([
  "aud-minimax-speech28turbo-mp3",
  "aud-minimax-speech28hd-mp3",
]);

/**
 * FABLE-007 首轮 dev promotion 曾把 MiniMax MP3 档登记为供应商不支持的 48kHz。
 * 只为这两个固定 tier 构造那一份已知旧快照，供下方精确比对；不接受近似匹配。
 */
function knownLegacyFable007MinimaxAudioPromotion(
  desired: PricingTierSeed,
): PricingTierSeed | undefined {
  if (!FABLE007_MINIMAX_AUDIO_TIER_IDS.has(desired.tier.tierId)) return undefined;
  if (
    desired.activationScope !== "dev_smoke_only"
    || desired.provider !== "minimax"
    || desired.mediaKind !== "audio"
    || desired.tier.params.sample_rate !== 32_000
  ) return undefined;
  const paramsSource = desired.valueSources.params;
  if (!paramsSource?.includes("MP3/32kHz")) return undefined;
  return {
    ...desired,
    tier: {
      ...desired.tier,
      params: {
        ...desired.tier.params,
        sample_rate: 48_000,
      },
    },
    valueSources: {
      ...desired.valueSources,
      params: paramsSource.replace("MP3/32kHz", "MP3/48kHz"),
    },
  };
}

/**
 * 唯一允许的原地变更：
 * 1. 把 S58 从未报价的 inactive 候选切成开发冒烟档；
 * 2. 把 FABLE-007 MiniMax 音频两档的已知 48kHz dev 快照修正为官方支持的 32kHz。
 * 任一现有行不是完整已知基线（包括价格或来源漂移），仍然 fail-closed。
 */
export function planPricingTierSeedWithSgoal04Promotion(
  desiredSeeds: readonly PricingTierSeed[],
  existingRows: readonly ExistingPricingRuleRow[],
  options: { retireFable007Minimax?: boolean } = {},
): PricingTierSeedAction[] {
  return planPricingTierSeed(desiredSeeds, existingRows).map((action) => {
    if (action.kind !== "conflict") return action;
    if (
      options.retireFable007Minimax === true
      && action.seed.provider === "minimax"
      && action.seed.active === false
      && action.seed.tier.status === "experimental"
    ) {
      const retiredPromotion = createRetiredFable007MinimaxDevPromotionSeeds()
        .find((seed) => seed.id === action.seed.id);
      const knownSnapshots = retiredPromotion
        ? [retiredPromotion, knownLegacyFable007MinimaxAudioPromotion(retiredPromotion)]
          .filter((seed): seed is PricingTierSeed => seed !== undefined)
        : [];
      for (const knownSnapshot of knownSnapshots) {
        const [knownAction] = planPricingTierSeed([knownSnapshot], existingRows);
        if (knownAction?.kind === "skip" && knownAction.existingId === action.existingId) {
          return { kind: "update", seed: action.seed, existingId: action.existingId };
        }
      }
    }
    if (action.seed.activationScope !== "dev_smoke_only") return action;
    const baseline = PRICING_TIER_SEEDS.find((seed) => seed.id === action.seed.id);
    if (baseline) {
      const [baselineAction] = planPricingTierSeed([baseline], existingRows);
      if (baselineAction?.kind === "skip" && baselineAction.existingId === action.existingId) {
        return { kind: "update", seed: action.seed, existingId: action.existingId };
      }
    }
    const knownLegacy = knownLegacyFable007MinimaxAudioPromotion(action.seed);
    if (knownLegacy) {
      const [legacyAction] = planPricingTierSeed([knownLegacy], existingRows);
      if (legacyAction?.kind === "skip" && legacyAction.existingId === action.existingId) {
        return { kind: "update", seed: action.seed, existingId: action.existingId };
      }
    }
    return action;
  });
}

export interface PricingTierSeedCliOptions {
  apply: boolean;
  databaseUrl?: string;
  schema?: string;
  target?: "dev" | "test" | "prod";
  promoteSgoal04P2: boolean;
  confirmSgoal04P2: boolean;
  promoteFable007: boolean;
  confirmFable007: boolean;
}

export function parsePricingTierSeedArgs(args: readonly string[]): PricingTierSeedCliOptions {
  let apply = false;
  let databaseUrl: string | undefined;
  let schema: string | undefined;
  let target: PricingTierSeedCliOptions["target"];
  let promoteSgoal04P2 = false;
  let confirmSgoal04P2 = false;
  let promoteFable007 = false;
  let confirmFable007 = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--promote-sgoal04-p2") promoteSgoal04P2 = true;
    else if (arg === "--confirm-sgoal04-p2") confirmSgoal04P2 = true;
    else if (arg === "--promote-fable007") promoteFable007 = true;
    else if (arg === "--confirm-fable007") confirmFable007 = true;
    else if (arg === "--database-url") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--database-url 需要一个值");
      databaseUrl = value;
      index += 1;
    } else if (arg === "--schema") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--schema 需要一个值");
      schema = value;
      index += 1;
    } else if (arg === "--target") {
      const value = args[index + 1];
      if (value !== "dev" && value !== "test" && value !== "prod") {
        throw new Error("--target 仅支持 dev / test / prod");
      }
      target = value;
      index += 1;
    } else {
      throw new Error(
        `未知参数:${arg}(支持 --dry-run / --apply / --database-url <url> / --schema <name>`
        + " / --target <dev|test|prod> / --promote-sgoal04-p2 / --confirm-sgoal04-p2"
        + " / --promote-fable007 / --confirm-fable007)",
      );
    }
  }
  return {
    apply,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(schema ? { schema } : {}),
    ...(target ? { target } : {}),
    promoteSgoal04P2,
    confirmSgoal04P2,
    promoteFable007,
    confirmFable007,
  };
}

export function assertPricingTierSeedSchema(
  options: Pick<PricingTierSeedCliOptions, "apply" | "schema">,
  configuredSchema: string,
): void {
  const declaredSchema = options.schema?.trim();
  if (options.apply && !declaredSchema) {
    throw new Error("拒绝执行:--apply 需要显式声明 --schema <POSTGRES_SCHEMA>");
  }
  if (declaredSchema && declaredSchema !== configuredSchema) {
    throw new Error(`拒绝执行:--schema 声明为 ${declaredSchema},但 POSTGRES_SCHEMA 实为 ${configuredSchema}`);
  }
}

export function assertSgoal04P2PromotionAllowed(
  options: Pick<
    PricingTierSeedCliOptions,
    "promoteSgoal04P2" | "confirmSgoal04P2" | "target"
  >,
  configuredSchema: string,
): void {
  if (!options.promoteSgoal04P2 && !options.confirmSgoal04P2) return;
  if (!options.promoteSgoal04P2 || !options.confirmSgoal04P2) {
    throw new Error("拒绝执行:S-goal-04 开发档必须同时声明启用与确认参数");
  }
  if (options.target !== "dev") {
    throw new Error("拒绝执行:S-goal-04 未实测档只允许在 dev 环境启用");
  }
  if (/(^|[_-])(prod|production)($|[_-])/i.test(configuredSchema)) {
    throw new Error("拒绝执行:生产 schema 不能启用 S-goal-04 未实测档");
  }
}

export function assertFable007PromotionAllowed(
  options: Pick<
    PricingTierSeedCliOptions,
    "promoteFable007" | "confirmFable007" | "target"
  >,
  configuredSchema: string,
): void {
  if (!options.promoteFable007 && !options.confirmFable007) return;
  if (!options.promoteFable007 || !options.confirmFable007) {
    throw new Error("拒绝执行:FABLE-007 开发档必须同时声明启用与确认参数");
  }
  if (options.target !== "dev") {
    throw new Error("拒绝执行:FABLE-007 多模型档只允许在 dev 环境启用");
  }
  if (/(^|[_-])(prod|production)($|[_-])/i.test(configuredSchema)) {
    throw new Error("拒绝执行:生产 schema 不能启用 FABLE-007 开发档");
  }
}

export interface PromotionDatabaseIdentityOptions {
  databaseUrl?: string;
  promoteSgoal04P2: boolean;
  promoteFable007: boolean;
}

/**
 * A same-command `--target dev` flag is not an environment identity. Promotion
 * uses only the deployment's configured URL and an independently provisioned
 * non-secret fingerprint; arbitrary URL overrides are forbidden.
 */
export function assertPromotionDatabaseIdentity(
  options: PromotionDatabaseIdentityOptions,
  configured: {
    databaseUrl?: string;
    expectedSha256?: string;
    appEnvironment: string;
  },
): void {
  if (!options.promoteSgoal04P2 && !options.promoteFable007) return;
  if (options.databaseUrl) {
    throw new Error("拒绝执行:开发档 promotion 不接受 --database-url 覆盖");
  }
  if (configured.appEnvironment !== "development") {
    throw new Error("拒绝执行:开发档 promotion 只允许 development 运行时");
  }
  const expected = configured.expectedSha256?.trim();
  if (!expected) {
    throw new Error("拒绝执行:缺少部署侧 dev 数据库身份指纹");
  }
  const actual = pricingSeedDatabaseIdentitySha256(configured.databaseUrl);
  if (actual !== expected) {
    throw new Error("拒绝执行:当前数据库不是已批准的 dev 定价目标");
  }
}

export function pricingSeedDatabaseIdentitySha256(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error("拒绝执行:数据库连接未配置");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("拒绝执行:数据库连接地址无效");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("拒绝执行:数据库连接必须使用 PostgreSQL");
  }
  const database = url.pathname.replace(/^\/+/u, "");
  if (!url.username || !url.hostname || !database) {
    throw new Error("拒绝执行:数据库身份字段不完整");
  }
  const identity = [
    url.protocol,
    url.username,
    url.hostname.toLowerCase(),
    url.port || "5432",
    database,
  ].join("|");
  return createHash("sha256").update(identity).digest("hex");
}

async function main(): Promise<void> {
  const options = parsePricingTierSeedArgs(process.argv.slice(2));
  assertPricingTierSeedSchema(options, settings.postgresSchema);
  assertSgoal04P2PromotionAllowed(options, settings.postgresSchema);
  assertFable007PromotionAllowed(options, settings.postgresSchema);
  assertPromotionDatabaseIdentity(options, {
    databaseUrl: settings.databaseUrl,
    expectedSha256: settings.pricingSeedDevDatabaseIdentitySha256,
    appEnvironment: settings.appEnvironment,
  });
  const promotionSeeds = [
    ...(options.promoteSgoal04P2 ? createSgoal04P2DevPromotionSeeds() : []),
    ...(options.promoteFable007 ? createFable007DevPromotionSeeds() : []),
  ];
  const promotionsById = new Map(promotionSeeds.map((seed) => [seed.id, seed]));
  const desiredSeeds = PRICING_TIER_SEEDS.map((seed) => promotionsById.get(seed.id) ?? seed);
  const handle = createDatabase(options.databaseUrl ?? settings.databaseUrl);
  try {
    const now = new Date();
    // 当前 active 行 + 全部 seed 固定 id 行(后者抓回 inactive 待核行,保证重跑幂等)。
    const rows = await handle.db.select({
      id: pricingRules.id,
      provider: pricingRules.provider,
      model: pricingRules.model,
      mediaKind: pricingRules.mediaKind,
      billingUnit: pricingRules.billingUnit,
      unitPriceFen: pricingRules.unitPriceFen,
      currency: pricingRules.currency,
      active: pricingRules.active,
      source: pricingRules.source,
      metadata: pricingRules.metadata,
    }).from(pricingRules).where(or(
      and(
        eq(pricingRules.active, true),
        lte(pricingRules.effectiveFrom, now),
        or(isNull(pricingRules.effectiveTo), gt(pricingRules.effectiveTo, now)),
      ),
      inArray(pricingRules.id, desiredSeeds.map((seed) => seed.id)),
    ));

    const actions = options.promoteSgoal04P2 || options.promoteFable007
      ? planPricingTierSeedWithSgoal04Promotion(desiredSeeds, rows, {
        retireFable007Minimax: options.promoteFable007,
      })
      : planPricingTierSeed(desiredSeeds, rows);
    const mode = options.apply ? "APPLY" : "DRY-RUN";
    console.log(`[${mode}] schema=${settings.postgresSchema} 目标行 ${desiredSeeds.length} 个档位`);

    let conflicts = 0;
    let inserts = 0;
    let updates = 0;
    for (const action of actions) {
      const seed = action.seed;
      const unitLabel = seed.billingUnit === "second"
        ? "秒"
        : seed.billingUnit === "ten_thousand_characters" ? "万字符" : "张";
      const label = `${seed.tier.tierId} (${seed.mediaKind}/${seed.model} ${seed.unitPriceFen} 积分/${unitLabel})`;
      if (action.kind === "skip") {
        console.log(`  跳过 ${label} —— 与现有行 ${action.existingId} 完全一致`);
      } else if (action.kind === "insert") {
        inserts += 1;
        // 即使是 --apply 也不能写「已插入」——下面的冲突门会在真正写库前 throw。
        // 旧文案在 --apply 下直接印「插入」,但只要同批有任何一个冲突,
        // 整批一行都没写——看到「插入」却查不到数据,会把人往“写入丢了”误导。
        // （2026-08-09 实测:2.5 档显示「插入」但库里 0 行）
        // 统一用「将插入」（未来时）,真正写成功由末尾的「已插入 N 个」一行宣布。
        console.log(`  将插入 ${label}`);
      } else if (action.kind === "update") {
        updates += 1;
        console.log(`  将更新 ${label} —— 现有候选行 ${action.existingId}`);
      } else {
        conflicts += 1;
        console.error(`  冲突 ${label} —— 现有行 ${action.existingId} 数值漂移:`);
        for (const difference of action.differences) console.error(`    - ${difference}`);
        console.error("    seed 不覆盖已有价格;改价请走 POST /api/v1/admin/pricing-rules");
      }
    }

    if (conflicts > 0) {
      throw new Error(
        `${conflicts} 个档位与现有价格行漂移,整批未做任何写入`
        + (inserts + updates > 0
          ? `——上面列的 ${inserts} 个将插入、${updates} 个将更新也一并未写。`
            + "先把漂移行处置掉(改价走 POST /api/v1/admin/pricing-rules),再重跑本脚本。"
          : ""),
      );
    }
    if (options.apply && inserts + updates > 0) {
      // 全部档位是同一份登记快照：任一插入失败时整批回滚，不留下半播种状态。
      // 固定主键只让同一脚本的并发后到者 fail-closed；表上没有档位 natural-key
      // 唯一约束，不能据此声称拦住其他写者使用不同 ID 创建同类行。
      await handle.db.transaction(async (transaction) => {
        for (const action of actions) {
          if (action.kind !== "insert") continue;
          const seed = action.seed;
          await transaction.insert(pricingRules).values({
            id: seed.id,
            provider: seed.provider,
            model: seed.model,
            mediaKind: seed.mediaKind,
            billingUnit: seed.billingUnit,
            unitPriceFen: seed.unitPriceFen,
            currency: seed.currency,
            source: seed.source,
            active: seed.active,
            effectiveFrom: now,
            effectiveTo: null,
            metadata: metadataFor(seed),
            createdAt: now,
            updatedAt: now,
          });
        }
        for (const action of actions) {
          if (action.kind !== "update") continue;
          const seed = action.seed;
          await transaction.update(pricingRules).set({
            source: seed.source,
            active: seed.active,
            effectiveFrom: now,
            effectiveTo: null,
            metadata: metadataFor(seed),
            updatedAt: now,
          }).where(eq(pricingRules.id, action.existingId));
        }
      });
      console.log(`已插入 ${inserts} 个档位、更新 ${updates} 个开发档(effective_from=${now.toISOString()})`);
    } else if (!options.apply) {
      console.log("dry-run 未写库;确认计划无误后加 --apply");
    } else {
      console.log("无需写入:所有档位均已存在且一致");
    }
  } finally {
    await handle.pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("seed-pricing-tiers.mts")
  || process.argv[1]?.endsWith("seed-pricing-tiers");
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
