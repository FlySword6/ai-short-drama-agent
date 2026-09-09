import type {
  GenerationMediaKind,
  GenerationParameters,
  GenerationReferenceManifestItem,
  GenerationReferenceMode,
  GenerationReferenceSnapshot,
} from "./types.js";

export const V01_IMAGE_SIZE = "2K";
export const V01_VIDEO_MODEL = "doubao-seedance-2-0-fast-260128";
export const V01_VIDEO_RESOLUTION = "720p";
export const V01_VIDEO_RATIO = "9:16";
export const V01_VIDEO_DURATION_SECONDS = 4;
export const V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND = 80;
/** 旧固定档只覆盖无输入视频，不得由历史 metadata 能力位升级成视频参考价。 */
export const V01_LEGACY_NO_INPUT_VIDEO_TIER_ID = "vid-seedance20fast-916-720p-4s";
/** Frozen product contract and the Seed Audio v3 interface both allow up to 3000 characters. */
export const AUDIO_MAX_TEXT_PROMPT_LENGTH = 3000;
export const AUDIO_MAX_REFERENCE_COUNT = 3;
export const AUDIO_MAX_REFERENCE_DURATION_SECONDS = 30;
export const AUDIO_MAX_ORIGINAL_DURATION_SECONDS = 120;

/**
 * The 80-fen floor belongs to the original fixed Seedance tier, not every
 * current Ark video model. New capability tiers carry their own audited price.
 * Missing tier metadata stays on the conservative legacy rule.
 */
export function requiresV01LegacyVideoPriceFloor(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const capabilityTier = metadata?.capability_tier;
  if (!capabilityTier || typeof capabilityTier !== "object") return true;
  const tierId = (capabilityTier as Record<string, unknown>).tier_id;
  return typeof tierId !== "string" || tierId === V01_LEGACY_NO_INPUT_VIDEO_TIER_ID;
}

/**
 * Provider identifiers are facts, not product labels.  Keep this small
 * allow-list close to the request normalizer: pricing still decides which
 * combinations can be quoted, while this registry only prevents an adapter
 * from sending fields a configured Ark model cannot understand.
 */
export const ARK_SEEDREAM_5_PRO_MODEL = "doubao-seedream-5-0-pro-260628";
export const ARK_SEEDREAM_5_MODEL = "doubao-seedream-5-0-260128";
export const ARK_SEEDREAM_5_LITE_MODEL = "doubao-seedream-5-0-lite-260128";
export const ARK_SEEDREAM_3_MODEL = "doubao-seedream-3-0-t2i-250415";
export const ARK_SEEDREAM_4_MODEL = "doubao-seedream-4-0-250828";
export const ARK_SEEDREAM_4_5_MODEL = "doubao-seedream-4-5-251128";
export const ARK_SEEDANCE_2_MODEL = "doubao-seedance-2-0-260128";
export const ARK_SEEDANCE_2_FAST_MODEL = V01_VIDEO_MODEL;
export const ARK_SEEDANCE_2_MINI_MODEL = "doubao-seedance-2-0-mini-260615";
export const ARK_SEEDANCE_1_LITE_I2V_MODEL = "doubao-seedance-1-0-lite-i2v-250428";
export const ARK_SEEDANCE_1_LITE_T2V_MODEL = "doubao-seedance-1-0-lite-t2v-250428";
export const ARK_SEEDANCE_1_PRO_MODEL = "doubao-seedance-1-0-pro-250528";
export const ARK_SEEDANCE_1_PRO_FAST_MODEL = "doubao-seedance-1-0-pro-fast-251015";
export const ARK_SEEDANCE_1_5_PRO_MODEL = "doubao-seedance-1-5-pro-251215";
export const ARK_SEEDANCE_2_5_MODEL = "doubao-seedance-2-5-260628";
/**
 * Seedance 2.5 专用接入点 ep id（折扣绑定在该接入点，DC 2026-08-07 拍板实测出片）。
 * 提交时 model 字段就是这个 ep id；部署经 ARK_VIDEO_MODEL_2_5 把同一 ep id 绑进注册表。
 */
export const ARK_SEEDANCE_2_5_ENDPOINT_MODEL = "ep-20260807153339-f6bp4";
export const ARK_WAN_FLF2V_MODEL = "wan2-1-14b-flf2v-250417";
export const ARK_WAN_I2V_MODEL = "wan2-1-14b-i2v-250225";
export const ARK_WAN_T2V_MODEL = "wan2-1-14b-t2v-250225";
export const MINIMAX_IMAGE_01_MODEL = "image-01";
export const MINIMAX_IMAGE_01_LIVE_MODEL = "image-01-live";
export const MINIMAX_H3_MODEL = "MiniMax-H3";
/** HappyHorse(快乐马)1.1 r2v:预览档专用低价视频模型(设计文档 §1.1,2026-08-19 参数化裁定)。 */
export const HAPPYHORSE_R2V_MODEL = "happyhorse-1.1-r2v";
/** 快乐马 API 画幅白名单(设计文档 §1.1:16:9、9:16、3:4、4:3、4:5、5:4、1:1、9:21、21:9)。
    不含 adaptive——快乐马 API 无自适应画幅;4:5/5:4/9:21 是视频档里快乐马独占。 */
export const HAPPYHORSE_RATIOS: readonly ImageRatio[] = [
  "16:9", "9:16", "3:4", "4:3", "4:5", "5:4", "1:1", "9:21", "21:9",
];
export const NEWAPI_GPT_IMAGE_2_MODEL = "gpt-image-2";
export const NEWAPI_GEMINI_31_PRO_IMAGE_MODEL = "gemini-3.1-pro-image";
export const SUCHUANG_GPT_IMAGE_2_MODEL = "gpt-image-2-suchuang";
export const NANOBANANA_2_MODEL = "nanobanana-2";
export const NANOBANANA_LITE_MODEL = "nanobanana-lite";

type NamedImageSize = "1K" | "2K" | "3K" | "4K";
type ImageRatio =
  | "auto"
  | "adaptive"
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "3:2"
  | "2:3"
  | "5:4"
  | "4:5"
  | "21:9"
  | "9:21"
  | "1:3"
  | "3:1"
  | "2:1"
  | "1:2"
  | "1:4"
  | "1:8"
  | "4:1"
  | "8:1";
const IMAGE_RATIOS: ReadonlySet<ImageRatio> = new Set([
  "16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive",
]);
const GPT_IMAGE_2_RATIOS: readonly ImageRatio[] = [
  "auto", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4",
  "21:9", "9:21", "1:3", "3:1", "2:1", "1:2",
];
const NANOBANANA_LITE_RATIOS: readonly ImageRatio[] = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "21:9",
];
const NANOBANANA_2_RATIOS: readonly ImageRatio[] = [
  ...NANOBANANA_LITE_RATIOS,
  "1:4", "1:8", "4:1", "8:1",
];
const IMAGE_RESOLUTION_PIXELS: Readonly<Record<NamedImageSize, number>> = {
  "1K": 1_048_576,
  "2K": 2_359_296,
  "3K": 8_847_360,
  "4K": 14_745_600,
};

interface ImageCapability {
  model: string;
  provider: "ark" | "minimax" | "newapi" | "suchuang";
  sizes: readonly NamedImageSize[];
  ratios?: readonly ImageRatio[];
  referenceImageLimit?: number;
  customPixels?: { min: number; max: number };
  supportsSequentialImages: boolean;
}

interface VideoReferenceLimits {
  readonly image: number;
  readonly video: number;
  readonly audio: number;
}

interface VideoCapabilityBase {
  model: string;
  provider: "ark" | "minimax" | "happyhorse";
  resolutions: readonly string[];
  /** 可选画幅白名单(缺省 = IMAGE_RATIOS);快乐马独占 4:5/5:4/9:21 且无 adaptive。 */
  ratios?: readonly ImageRatio[];
  /** 可选时长整数秒范围(缺省 4–15);快乐马 API 支持 3–15。 */
  durationSeconds?: { min: number; max: number };
}

type VideoCapability = VideoCapabilityBase & (
  | { referenceLimits: VideoReferenceLimits; referenceLimitSource: "verified" }
  | { referenceLimits?: never; referenceLimitSource: "legacy_unverified" }
);

export interface GenerationNativeCapability {
  mediaKind: GenerationMediaKind;
  model: string;
  visual?: {
    resolutions?: readonly string[];
    ratios?: readonly ImageRatio[];
    customPixels?: { min: number; max: number };
    referenceImageLimit?: number;
    supportsSequentialImages?: boolean;
  };
  motion?: {
    durationSeconds?: { min: number; max: number; step: number };
    referenceImageLimit?: number;
    referenceVideoLimit?: number;
    referenceAudioLimit?: number;
    generateAudio?: boolean;
  };
  audio?: {
    originalDurationSeconds: { min: number; max: number; step: number };
    formats: readonly string[];
    sampleRates: readonly number[];
    speechRate: { min: number; max: number; step: number };
    loudnessRate: { min: number; max: number; step: number };
    pitchRate: { min: number; max: number; step: number };
    referenceAudioLimit: number;
    referenceImageLimit: number;
  };
}

const IMAGE_CAPABILITIES: readonly ImageCapability[] = [
  {
    model: ARK_SEEDREAM_3_MODEL,
    provider: "ark",
    sizes: ["1K", "2K"],
    referenceImageLimit: 0,
    customPixels: { min: 512 * 512, max: 2_048 * 2_048 },
    supportsSequentialImages: false,
  },
  {
    model: ARK_SEEDREAM_4_MODEL,
    provider: "ark",
    sizes: ["1K", "2K", "4K"],
    referenceImageLimit: 10,
    customPixels: { min: 921_600, max: 16_777_216 },
    supportsSequentialImages: true,
  },
  {
    model: ARK_SEEDREAM_4_5_MODEL,
    provider: "ark",
    sizes: ["2K", "4K"],
    referenceImageLimit: 14,
    customPixels: { min: 3_686_400, max: 16_777_216 },
    supportsSequentialImages: true,
  },
  {
    model: ARK_SEEDREAM_5_PRO_MODEL,
    provider: "ark",
    sizes: ["1K", "2K"],
    referenceImageLimit: 10,
    customPixels: { min: 921_600, max: 4_624_220 },
    supportsSequentialImages: false,
  },
  {
    model: ARK_SEEDREAM_5_MODEL,
    provider: "ark",
    sizes: ["2K", "3K", "4K"],
    referenceImageLimit: 14,
    customPixels: { min: 3_686_400, max: 16_777_216 },
    supportsSequentialImages: true,
  },
  {
    model: ARK_SEEDREAM_5_LITE_MODEL,
    provider: "ark",
    sizes: ["2K", "3K", "4K"],
    referenceImageLimit: 14,
    customPixels: { min: 3_686_400, max: 16_777_216 },
    supportsSequentialImages: true,
  },
  {
    model: MINIMAX_IMAGE_01_MODEL,
    provider: "minimax",
    sizes: ["1K"],
    referenceImageLimit: 1,
    customPixels: { min: 512 * 512, max: 2_048 * 2_048 },
    supportsSequentialImages: false,
  },
  {
    model: MINIMAX_IMAGE_01_LIVE_MODEL,
    provider: "minimax",
    sizes: ["1K"],
    referenceImageLimit: 1,
    customPixels: { min: 512 * 512, max: 2_048 * 2_048 },
    supportsSequentialImages: false,
  },
  {
    model: NEWAPI_GPT_IMAGE_2_MODEL,
    provider: "newapi",
    sizes: ["1K"],
    referenceImageLimit: 0,
    customPixels: { min: 512 * 512, max: 2_048 * 2_048 },
    supportsSequentialImages: false,
  },
  {
    model: NEWAPI_GEMINI_31_PRO_IMAGE_MODEL,
    provider: "newapi",
    sizes: ["1K"],
    referenceImageLimit: 0,
    customPixels: { min: 512 * 512, max: 2_048 * 2_048 },
    supportsSequentialImages: false,
  },
  {
    model: SUCHUANG_GPT_IMAGE_2_MODEL,
    provider: "suchuang",
    sizes: [],
    ratios: GPT_IMAGE_2_RATIOS,
    supportsSequentialImages: false,
  },
  {
    model: NANOBANANA_LITE_MODEL,
    provider: "suchuang",
    sizes: ["1K"],
    ratios: NANOBANANA_LITE_RATIOS,
    supportsSequentialImages: false,
  },
  {
    model: NANOBANANA_2_MODEL,
    provider: "suchuang",
    sizes: ["1K", "2K", "4K"],
    ratios: NANOBANANA_2_RATIOS,
    referenceImageLimit: 14,
    supportsSequentialImages: false,
  },
];

/** Ark API reference verified 2026-08-10: 2.0 series supports 9 images, 3 videos, and 3 audios.
 * https://docs.volcengine.com/docs/82379/1520757?lang=zh
 */
const SEEDANCE_2_VIDEO_REFERENCE_LIMITS: VideoReferenceLimits = {
  image: 9,
  video: 3,
  audio: 3,
};
/**
 * Ark sources verified 2026-08-10: 2.5 supports 30 images, 10 videos, and 10 audios.
 * https://docs.volcengine.com/docs/82379/2607688?lang=zh
 * https://docs.volcengine.com/docs/82379/1520757?lang=zh
 * https://docs.volcengine.com/docs/82379/2298881?lang=zh
 */
const SEEDANCE_2_5_VIDEO_REFERENCE_LIMITS: VideoReferenceLimits = {
  image: 30,
  video: 10,
  audio: 10,
};

/**
 * Historical compatibility only. These limits preserve existing behavior for
 * models whose official limits remain unverified; they are not provider
 * capability claims.
 */
const LEGACY_UNVERIFIED_VIDEO_REFERENCE_LIMITS: VideoReferenceLimits = {
  image: 9,
  video: 3,
  audio: 3,
};

const VIDEO_CAPABILITIES: readonly VideoCapability[] = [
  { model: ARK_SEEDANCE_1_LITE_I2V_MODEL, provider: "ark", resolutions: ["480p", "720p"], referenceLimitSource: "legacy_unverified" },
  { model: ARK_SEEDANCE_1_LITE_T2V_MODEL, provider: "ark", resolutions: ["480p", "720p"], referenceLimitSource: "legacy_unverified" },
  { model: ARK_SEEDANCE_1_PRO_MODEL, provider: "ark", resolutions: ["720p", "1080p"], referenceLimitSource: "legacy_unverified" },
  { model: ARK_SEEDANCE_1_PRO_FAST_MODEL, provider: "ark", resolutions: ["720p", "1080p"], referenceLimitSource: "legacy_unverified" },
  { model: ARK_SEEDANCE_1_5_PRO_MODEL, provider: "ark", resolutions: ["720p", "1080p"], referenceLimitSource: "legacy_unverified" },
  {
    model: ARK_SEEDANCE_2_MODEL,
    provider: "ark",
    resolutions: ["480p", "720p", "1080p", "4k"],
    referenceLimits: SEEDANCE_2_VIDEO_REFERENCE_LIMITS,
    referenceLimitSource: "verified",
  },
  {
    model: ARK_SEEDANCE_2_FAST_MODEL,
    provider: "ark",
    resolutions: ["480p", "720p"],
    referenceLimits: SEEDANCE_2_VIDEO_REFERENCE_LIMITS,
    referenceLimitSource: "verified",
  },
  {
    model: ARK_SEEDANCE_2_MINI_MODEL,
    provider: "ark",
    resolutions: ["480p", "720p"],
    referenceLimits: SEEDANCE_2_VIDEO_REFERENCE_LIMITS,
    referenceLimitSource: "verified",
  },
  {
    model: ARK_SEEDANCE_2_5_MODEL,
    provider: "ark",
    resolutions: ["720p", "1080p"],
    referenceLimits: SEEDANCE_2_5_VIDEO_REFERENCE_LIMITS,
    referenceLimitSource: "verified",
  },
  // 2.5 专用接入点（折扣走这个 ep，DC 2026-08-07 实测出片；裸模型 id doubao-seedance-2-5-260628
  // 已在表中，此条是部署级接入点绑定）。
  {
    model: ARK_SEEDANCE_2_5_ENDPOINT_MODEL,
    provider: "ark",
    resolutions: ["720p", "1080p"],
    referenceLimits: SEEDANCE_2_5_VIDEO_REFERENCE_LIMITS,
    referenceLimitSource: "verified",
  },
  { model: ARK_WAN_FLF2V_MODEL, provider: "ark", resolutions: ["480p", "720p"], referenceLimitSource: "legacy_unverified" },
  { model: ARK_WAN_I2V_MODEL, provider: "ark", resolutions: ["480p", "720p"], referenceLimitSource: "legacy_unverified" },
  { model: ARK_WAN_T2V_MODEL, provider: "ark", resolutions: ["480p", "720p"], referenceLimitSource: "legacy_unverified" },
  { model: MINIMAX_H3_MODEL, provider: "minimax", resolutions: ["768P", "2K"], referenceLimitSource: "legacy_unverified" },
  // HappyHorse 预览档(设计文档 §1.1,2026-08-19 参数化裁定):分辨率 480P/720P/1080P,
  // 画幅 9 种,时长 3–15 整数秒。
  { model: HAPPYHORSE_R2V_MODEL, provider: "happyhorse", resolutions: ["480p", "720p", "1080p"], ratios: HAPPYHORSE_RATIOS, durationSeconds: { min: 3, max: 15 }, referenceLimitSource: "legacy_unverified" },
];

/**
 * Public model-native descriptor used by the orchestration operation card.
 * Pricing tiers still decide which exact combinations can be quoted; this
 * descriptor prevents the UI from confusing "not currently priced" with
 * "the model cannot do it".
 */
export function generationNativeCapability(
  mediaKind: GenerationMediaKind,
  model: string,
): GenerationNativeCapability | null {
  if (mediaKind === "image") {
    const capability = findImageCapability(model);
    if (!capability) return null;
    return {
      mediaKind,
      model,
      visual: {
        resolutions: [...capability.sizes],
        ratios: [...(capability.ratios ?? IMAGE_RATIOS)],
        ...(capability.customPixels
          ? { customPixels: { ...capability.customPixels } }
          : {}),
        referenceImageLimit: capability.referenceImageLimit,
        supportsSequentialImages: capability.supportsSequentialImages,
      },
    };
  }
  if (mediaKind === "video") {
    const capability = findVideoCapability(model);
    if (!capability) return null;
    const referenceLimits = effectiveVideoReferenceLimits(capability);
    return {
      mediaKind,
      model,
      visual: {
        resolutions: [...capability.resolutions],
        ratios: [...(capability.ratios ?? IMAGE_RATIOS)],
      },
      motion: {
        durationSeconds: { ...(capability.durationSeconds ?? { min: 4, max: 15 }), step: 1 },
        referenceImageLimit: referenceLimits.image,
        referenceVideoLimit: referenceLimits.video,
        referenceAudioLimit: referenceLimits.audio,
        generateAudio: true,
      },
    };
  }
  return {
    mediaKind,
    model,
    audio: {
      originalDurationSeconds: {
        min: 1,
        max: AUDIO_MAX_ORIGINAL_DURATION_SECONDS,
        step: 1,
      },
      formats: ["mp3", "wav", "pcm"],
      sampleRates: [8_000, 16_000, 24_000, 32_000, 44_100, 48_000],
      speechRate: { min: -50, max: 100, step: 1 },
      loudnessRate: { min: -50, max: 100, step: 1 },
      pitchRate: { min: -12, max: 12, step: 1 },
      referenceAudioLimit: AUDIO_MAX_REFERENCE_COUNT,
      referenceImageLimit: 1,
    },
  };
}

export class V01GenerationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V01GenerationContractError";
  }
}

export function normalizeV01Parameters(input: {
  mediaKind: GenerationMediaKind;
  model: string;
  parameters: GenerationParameters;
  quantity: number;
}): GenerationParameters {
  if (input.quantity !== 1) {
    throw contractError("当前一次只能生成一个结果，请把数量改为 1");
  }
  if (input.mediaKind === "image") return normalizeImageParameters(input.model, input.parameters);
  if (input.mediaKind === "video") return normalizeVideoParameters(input.model, input.parameters);
  return normalizeAudioParameters(input.parameters);
}

export function normalizeV01References(
  mediaKind: GenerationMediaKind,
  references: GenerationReferenceSnapshot[],
  model?: string,
): GenerationReferenceSnapshot[] {
  for (const reference of references) {
    if (isDirectorOnlyModelUrl(reference.url)) {
      throw contractError("3D 素模仅供导演台使用，不能作为生成参考");
    }
  }
  if (mediaKind === "audio") {
    const audioCount = references.filter((reference) => reference.kind === "audio").length;
    const imageCount = references.filter((reference) => reference.kind === "image").length;
    if (references.some((reference) => reference.kind === "video")) {
      throw contractError("当前音频生成不支持视频参考，请移除视频后重试");
    }
    if (audioCount > 0 && imageCount > 0) {
      throw contractError("图片参考和音频参考不能同时使用，请只保留一种");
    }
    if (audioCount > AUDIO_MAX_REFERENCE_COUNT) {
      throw contractError(`当前最多支持 ${AUDIO_MAX_REFERENCE_COUNT} 段音频参考`);
    }
    if (imageCount > 1) {
      throw contractError("当前最多支持 1 张图片参考");
    }
    return references.map((reference) => {
      if (reference.url.startsWith("asset://")) {
        throw contractError("已登记素材暂不支持用于当前音频参考");
      }
      const expectedRole = reference.kind === "image" ? "reference_image" : "reference_audio";
      const role = reference.role ?? expectedRole;
      if (role !== expectedRole) throw contractError("这份参考素材的用途不适用于音频生成，请重新选择");
      return { ...reference, role };
    });
  }
  if (mediaKind === "image") {
    if (references.some((reference) => reference.url.startsWith("asset://"))) {
      throw contractError("已登记素材只能用于视频生成的普通参考位");
    }
    if (references.some((reference) => reference.kind !== "image")) {
      throw contractError("图片生成只能使用图片作为参考，请移除其他素材");
    }
    const capability = requireImageCapability(model);
    if (capability.referenceImageLimit !== undefined
      && references.length > capability.referenceImageLimit) {
      throw contractError(`当前图片模型最多支持 ${capability.referenceImageLimit} 张参考图`);
    }
    return references.map((reference) => {
      if (reference.role && reference.role !== "reference_image") {
        throw contractError("首帧和尾帧只用于视频生成");
      }
      return { ...reference };
    });
  }

  const referenceLimits = effectiveVideoReferenceLimits(
    model === undefined ? undefined : requireVideoCapability(model),
  );
  const imageCount = references.filter((reference) => reference.kind === "image").length;
  const videoCount = references.filter((reference) => reference.kind === "video").length;
  const audioCount = references.filter((reference) => reference.kind === "audio").length;
  if (imageCount > referenceLimits.image) {
    throw contractError(`当前最多支持 ${referenceLimits.image} 张参考图`);
  }
  if (videoCount > referenceLimits.video) {
    throw contractError(`当前最多支持 ${referenceLimits.video} 段参考视频`);
  }
  if (audioCount > referenceLimits.audio) {
    throw contractError(`当前最多支持 ${referenceLimits.audio} 段参考音频`);
  }
  if (audioCount > 0 && imageCount + videoCount === 0) {
    throw contractError("参考集不能只包含音频，请至少搭配一张参考图或一段参考视频；纯文本生成请清空参考集");
  }

  // Every reference leaves this boundary with an explicit role. Omitting the
  // role lets the provider read positional semantics into the request (the
  // first image silently becomes the first frame), which is exactly how a
  // prop reference was once promoted to an anchor frame without consent.
  const normalized = references.map((reference) => {
    if (reference.kind === "image") {
      const role = reference.role ?? "reference_image";
      if (role !== "reference_image" && role !== "first_frame" && role !== "last_frame") {
        throw contractError("这张图片的用途不适用于当前视频生成方式，请重新选择");
      }
      assertArkAssetReferenceUsage(reference.url, role, model);
      return { ...reference, role };
    }
    if (reference.kind === "video") {
      const role = reference.role ?? "reference_video";
      if (role !== "reference_video") {
        throw contractError("这段视频的用途不适用于当前视频生成方式，请重新选择");
      }
      assertArkAssetReferenceUsage(reference.url, role, model);
      return { ...reference, role };
    }
    const role = reference.role ?? "reference_audio";
    if (role !== "reference_audio") {
      throw contractError("这段音频的用途不适用于当前视频生成方式，请重新选择");
    }
    if (reference.url.startsWith("asset://")) {
      throw contractError("已登记素材暂不支持用于音频参考");
    }
    return { ...reference, role };
  });

  if (normalized.filter((reference) => reference.role === "first_frame").length > 1) {
    throw contractError("首帧最多只能选择 1 张图片");
  }
  if (normalized.filter((reference) => reference.role === "last_frame").length > 1) {
    throw contractError("尾帧最多只能选择 1 张图片");
  }
  // Anchor frames and the multimodal reference set are mutually exclusive
  // scenes. "Reference plus a chosen first frame" is expressed as a multimodal
  // reference plus prompt wording, never by mixing the two groups.
  const hasAnchorFrame = normalized.some(
    (reference) => reference.role === "first_frame" || reference.role === "last_frame",
  );
  const hasReferenceRole = normalized.some(
    (reference) => reference.role === "reference_image"
      || reference.role === "reference_video"
      || reference.role === "reference_audio",
  );
  if (hasAnchorFrame && hasReferenceRole) {
    throw contractError("首帧/尾帧与参考素材不能混用：需要参考并指定首帧时，请使用多模态参考并在提示词中说明");
  }
  if (
    normalized.some((reference) => reference.role === "last_frame")
    && !normalized.some((reference) => reference.role === "first_frame")
  ) {
    throw contractError("尾帧需要与首帧一起使用");
  }
  // Video references are part of the all-reference control package (for
  // action and camera intent). Pricing remains a server-side rule concern;
  // do not silently remove a valid control input at the provider boundary.
  return normalized;
}

/**
 * Retries intentionally preserve the original immutable reference snapshot,
 * so they cannot reclassify a later-edited asset. The frozen URL is still
 * checked on every normalization path to keep 3D director assets out.
 */
function isDirectorOnlyModelUrl(url: string): boolean {
  return /\.(?:glb|gltf)(?:[?#]|$)/i.test(url);
}

/** `asset://` is an Ark library handle, never an arbitrary external URL. */
export function isArkAssetReferenceUrl(url: string): boolean {
  return /^asset:\/\/[^\s/?#]+$/.test(url);
}

function assertArkAssetReferenceUsage(url: string, role: string, model?: string): void {
  if (!url.startsWith("asset://")) return;
  if (!isArkAssetReferenceUrl(url)) {
    throw contractError("素材登记信息不正确，请重新选择");
  }
  if (!isArkSeedance2Model(model)) {
    throw contractError("已登记素材只能用于支持素材登记的视频档位");
  }
  if (role !== "reference_image" && role !== "reference_video") {
    throw contractError("已登记素材不能作为严格首帧或尾帧");
  }
}

function normalizeImageParameters(model: string, parameters: GenerationParameters): GenerationParameters {
  if (model === SUCHUANG_GPT_IMAGE_2_MODEL) {
    assertAllowedKeys(parameters, ["ratio", "size"]);
    return {
      size: readRequiredImageEnum(
        parameters.ratio ?? parameters.size ?? "auto",
        GPT_IMAGE_2_RATIOS,
        "图片比例",
      ),
    };
  }
  if (model === NANOBANANA_LITE_MODEL || model === NANOBANANA_2_MODEL) {
    assertAllowedKeys(parameters, ["size", "ratio", "aspectRatio"]);
    const capability = requireImageCapability(model);
    const ratios = capability.ratios ?? [];
    return {
      size: readRequiredImageEnum(parameters.size ?? "1K", capability.sizes, "图片清晰度"),
      aspectRatio: readRequiredImageEnum(
        parameters.ratio ?? parameters.aspectRatio ?? "auto",
        ratios,
        "图片比例",
      ),
    };
  }
  const capability = requireImageCapability(model);
  assertAllowedKeys(
    parameters,
    ["size", "resolution", "ratio", "watermark", "sequentialImageGeneration"],
  );
  const explicitSize = parameters.size === undefined ? undefined : readImageSize(parameters.size);
  const explicitResolution = parameters.resolution === undefined ? undefined : readImageSize(parameters.resolution);
  if ((parameters.size !== undefined && !explicitSize)
    || (parameters.resolution !== undefined && !explicitResolution)) {
    throw contractError("图片清晰度仅支持模型列出的 K 档位或合法的宽x高尺寸");
  }
  if (explicitSize !== undefined && explicitResolution !== undefined && explicitSize !== explicitResolution) {
    throw contractError("图片清晰度与分辨率不能同时填写不同的值，请只保留一个");
  }
  const requestedSize = explicitSize ?? explicitResolution ?? V01_IMAGE_SIZE;
  const ratio = normalizeImageRatio(parameters.ratio);
  const size = normalizeImageSize(capability, requestedSize, ratio);
  if (parameters.watermark !== undefined && parameters.watermark !== false) {
    throw contractError("图片生成的内容标识由平台统一处理，不能自行修改");
  }
  if (parameters.sequentialImageGeneration !== undefined && parameters.sequentialImageGeneration !== "disabled") {
    throw contractError(capability.supportsSequentialImages
      ? "当前产品一次只能生成一张图片，请关闭连续组图"
      : "当前图片模型不支持连续组图");
  }
  return {
    size,
    ratio,
    watermark: false,
    sequentialImageGeneration: "disabled",
  };
}

function normalizeVideoParameters(model: string, parameters: GenerationParameters): GenerationParameters {
  const capability = requireVideoCapability(model);
  assertAllowedKeys(
    parameters,
    // preview 是预览档身份键(§2.1),随档 params 合法化,归一化原样透传。
    ["resolution", "ratio", "durationSeconds", "watermark", "generateAudio", "preview"],
  );
  const resolution = parameters.resolution ?? V01_VIDEO_RESOLUTION;
  if (!capability.resolutions.includes(resolution)) {
    throw contractError(`当前视频模型不支持 ${resolution}，可选：${capability.resolutions.join("、")}`);
  }
  const ratio = parameters.ratio ?? V01_VIDEO_RATIO;
  const allowedRatios = capability.ratios ?? [...IMAGE_RATIOS];
  if (!allowedRatios.includes(ratio as ImageRatio)) {
    throw contractError(`当前视频模型画幅仅支持 ${allowedRatios.join("、")}`);
  }
  const durationRange = capability.durationSeconds ?? { min: 4, max: 15 };
  const durationSeconds = parameters.durationSeconds ?? V01_VIDEO_DURATION_SECONDS;
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < durationRange.min || durationSeconds > durationRange.max) {
    throw contractError(`视频时长仅支持 ${durationRange.min} 到 ${durationRange.max} 秒；智能时长的计费规则尚未开放`);
  }
  if (parameters.watermark !== undefined && parameters.watermark !== false) {
    throw contractError("内容标识由平台统一处理，不能自行修改");
  }
  return {
    resolution,
    ratio,
    durationSeconds,
    watermark: false,
    generateAudio: parameters.generateAudio ?? true,
    ...(parameters.preview === true ? { preview: true } : {}),
  };
}

function requireImageCapability(model: string | undefined): ImageCapability {
  // Reference normalization is also used by read-only legacy paths that did
  // not persist a model. Those paths retain the conservative Pro limits; any
  // actual generation request always supplies a concrete model ID.
  const capability = model === undefined
    ? findImageCapability(ARK_SEEDREAM_5_PRO_MODEL)
    : findImageCapability(model);
  if (!capability) {
    throw contractError("当前图片模型尚未完成能力登记，不能创建生成任务");
  }
  return capability;
}

function requireVideoCapability(model: string): VideoCapability {
  const capability = findVideoCapability(model);
  if (!capability) {
    throw contractError("当前视频模型尚未完成能力登记，不能创建生成任务");
  }
  return capability;
}

function effectiveVideoReferenceLimits(
  capability: VideoCapability | undefined,
): VideoReferenceLimits {
  return capability?.referenceLimitSource === "verified"
    ? capability.referenceLimits
    : LEGACY_UNVERIFIED_VIDEO_REFERENCE_LIMITS;
}

function findImageCapability(model: string | undefined): ImageCapability | undefined {
  const normalized = model?.trim();
  return IMAGE_CAPABILITIES.find((item) => item.model === normalized);
}

function findVideoCapability(model: string | undefined): VideoCapability | undefined {
  const normalized = model?.trim();
  return VIDEO_CAPABILITIES.find((item) => item.model === normalized);
}

/** Shared admission predicate for Ark-only Seedance asset-library semantics. */
export function isArkSeedance2Model(model: string | undefined): boolean {
  const normalized = model?.trim() ?? "";
  return findVideoCapability(normalized)?.provider === "ark"
    && normalized.startsWith("doubao-seedance-2-");
}

function readImageSize(value: unknown): NamedImageSize | `${number}x${number}` | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized === "1K" || normalized === "2K" || normalized === "3K" || normalized === "4K") return normalized;
  return /^\d{2,5}x\d{2,5}$/.test(normalized) ? normalized as `${number}x${number}` : undefined;
}

function readRequiredImageEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
): string {
  if (typeof value !== "string" || !allowed.includes(value.trim())) {
    throw contractError(`${label}不受当前图片模型支持，可选：${allowed.join("、")}`);
  }
  return value.trim();
}

function normalizeImageRatio(value: unknown): ImageRatio {
  if (value === undefined) return "16:9";
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!isImageRatio(normalized)) {
    throw contractError("图片画幅仅支持 16:9、4:3、1:1、3:4、9:16、21:9 或自适应");
  }
  return normalized;
}

/**
 * Ark accepts a concrete WxH size. Product UIs expose resolution and ratio as
 * independent controls, so named resolution selections are materialized here
 * rather than silently dropping the ratio before the provider call.
 */
function normalizeImageSize(
  capability: ImageCapability,
  requestedSize: NamedImageSize | `${number}x${number}`,
  ratio: ImageRatio,
): string {
  const customPixels = capability.customPixels;
  if (!customPixels) {
    throw contractError("当前图片模型只支持文档列出的离散档位");
  }
  if (!isNamedImageSize(requestedSize)) {
    const dimensions = requestedSize.split("x").map(Number);
    const width = dimensions[0]!;
    const height = dimensions[1]!;
    assertImageDimensions(width, height, customPixels);
    return requestedSize;
  }
  if (!capability.sizes.includes(requestedSize)) {
    throw contractError(`当前图片模型不支持 ${requestedSize}，可选：${capability.sizes.join("、")}`);
  }
  if (ratio === "adaptive") return requestedSize;
  const [ratioWidth, ratioHeight] = ratio.split(":").map(Number) as [number, number];
  const targetPixels = Math.max(IMAGE_RESOLUTION_PIXELS[requestedSize], customPixels.min);
  const width = roundToEven(Math.sqrt(targetPixels * ratioWidth / ratioHeight));
  const height = roundToEven(width * ratioHeight / ratioWidth);
  assertImageDimensions(width, height, customPixels);
  return `${width}x${height}`;
}

function isNamedImageSize(value: string): value is NamedImageSize {
  return value === "1K" || value === "2K" || value === "3K" || value === "4K";
}

function isImageRatio(value: string): value is ImageRatio {
  return IMAGE_RATIOS.has(value as ImageRatio);
}

function assertImageDimensions(
  width: number,
  height: number,
  pixels: { min: number; max: number },
): void {
  const ratio = width / height;
  const totalPixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 15 || height < 15 || ratio < 1 / 16 || ratio > 16
    || totalPixels < pixels.min || totalPixels > pixels.max) {
    throw contractError(`图片尺寸超出当前模型范围（总像素 ${pixels.min}–${pixels.max}，画幅 1:16–16:1）`);
  }
}

function roundToEven(value: number): number {
  return Math.max(16, Math.round(value / 2) * 2);
}

function normalizeAudioParameters(parameters: GenerationParameters): GenerationParameters {
  assertAllowedKeys(parameters, [
    "originalDurationSeconds", "format", "sampleRate", "speechRate", "loudnessRate", "pitchRate",
    "enableSubtitle", "aigcMetadataEnabled", "aigcWatermarkEnabled", "speakerId",
  ]);
  const originalDurationSeconds = parameters.originalDurationSeconds;
  if (!Number.isSafeInteger(originalDurationSeconds)
    || (originalDurationSeconds ?? 0) < 1
    || (originalDurationSeconds ?? 0) > AUDIO_MAX_ORIGINAL_DURATION_SECONDS) {
    throw contractError(`音频时长必须是 1 到 ${AUDIO_MAX_ORIGINAL_DURATION_SECONDS} 秒之间的整数`);
  }
  if (parameters.format !== undefined && !["mp3", "wav", "pcm"].includes(parameters.format)) {
    throw contractError("音频格式仅支持 MP3、WAV 或 PCM");
  }
  if (parameters.speakerId !== undefined && !parameters.speakerId.trim()) {
    throw contractError("请选择一个可用音色");
  }
  if (parameters.sampleRate !== undefined && ![8000, 16000, 24000, 32000, 44100, 48000].includes(parameters.sampleRate)) {
    throw contractError("当前不支持所选采样率，请重新选择");
  }
  assertRange(parameters.speechRate, -50, 100, "speechRate");
  assertRange(parameters.loudnessRate, -50, 100, "loudnessRate");
  assertRange(parameters.pitchRate, -12, 12, "pitchRate");
  if (parameters.enableSubtitle !== undefined && parameters.enableSubtitle !== true) {
    throw contractError("当前音频生成必须保留字幕");
  }
  if (parameters.aigcMetadataEnabled !== undefined && parameters.aigcMetadataEnabled !== true) {
    throw contractError("音频的内容标识不能关闭");
  }
  if (parameters.aigcWatermarkEnabled !== undefined && parameters.aigcWatermarkEnabled !== false) {
    throw contractError("当前音频档位不支持额外的显式水印");
  }
  return {
    originalDurationSeconds,
    format: parameters.format ?? "mp3",
    ...(parameters.sampleRate !== undefined ? { sampleRate: parameters.sampleRate } : {}),
    ...(parameters.speechRate !== undefined ? { speechRate: parameters.speechRate } : {}),
    ...(parameters.loudnessRate !== undefined ? { loudnessRate: parameters.loudnessRate } : {}),
    ...(parameters.pitchRate !== undefined ? { pitchRate: parameters.pitchRate } : {}),
    ...(parameters.speakerId ? { speakerId: parameters.speakerId.trim() } : {}),
    enableSubtitle: true,
    aigcMetadataEnabled: true,
    aigcWatermarkEnabled: false,
  };
}

/** Pure text, speaker, audio references and an image reference are mutually exclusive Seed Audio source modes. */
export function assertAudioSource(
  parameters: GenerationParameters,
  references: GenerationReferenceSnapshot[],
): void {
  const hasSpeaker = Boolean(parameters.speakerId?.trim());
  const hasAudioReferences = references.some((reference) => reference.kind === "audio");
  const hasImageReference = references.some((reference) => reference.kind === "image");
  const sourceModeCount = Number(hasSpeaker) + Number(hasAudioReferences) + Number(hasImageReference);
  if (sourceModeCount > 1) {
    throw contractError("音色、音频参考和图片参考不能混用，请只选择一种来源");
  }
}

function assertRange(value: number | undefined, min: number, max: number, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
    throw contractError(`当前参数超出可选范围（${min} 到 ${max}），请重新调整`);
  }
}

/**
 * Defensive reader for persisted snapshot JSON. Rows persisted before the
 * generation-mapping contract may lack role/mediaId; invalid items are dropped
 * instead of failing a read path.
 */
export function readReferenceSnapshots(value: unknown): GenerationReferenceSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    const url = record.url;
    if ((kind !== "image" && kind !== "video" && kind !== "audio") || typeof url !== "string") return [];
    return [{
      kind,
      url,
      ...(typeof record.role === "string" ? { role: record.role } : {}),
      ...(typeof record.mediaId === "string" ? { mediaId: record.mediaId } : {}),
      ...(typeof record.sourceMediaResultId === "string"
        ? { sourceMediaResultId: record.sourceMediaResultId }
        : {}),
    }];
  });
}

/**
 * 合同第一节的三场景互斥,所以「本次采用的模式」是冻结快照集的纯函数,
 * 永远不存冗余字段。混合集(历史脏数据)按锚帧优先归类,保持确定性。
 */
export function deriveReferenceMode(
  snapshots: GenerationReferenceSnapshot[],
): GenerationReferenceMode {
  if (snapshots.length === 0) return "text_only";
  return snapshots.some(
    (snapshot) => snapshot.role === "first_frame" || snapshot.role === "last_frame",
  )
    ? "anchor_frames"
    : "multimodal_reference";
}

/** Display manifest for the S17 transparency panel; null-fills unknown fields. */
export function referenceManifest(
  snapshots: GenerationReferenceSnapshot[],
): GenerationReferenceManifestItem[] {
  return snapshots.map((snapshot) => ({
    mediaId: snapshot.mediaId ?? null,
    kind: snapshot.kind,
    role: snapshot.role ?? null,
  }));
}

function assertAllowedKeys(
  parameters: GenerationParameters,
  allowedKeys: string[],
): void {
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(parameters).filter(
    (key) => parameters[key] !== undefined && !allowed.has(key),
  );
  if (unsupported.length > 0) {
    throw contractError(`当前生成档位不支持这些设置：${unsupported.join("、")}`);
  }
}

function contractError(message: string): V01GenerationContractError {
  return new V01GenerationContractError(message);
}
