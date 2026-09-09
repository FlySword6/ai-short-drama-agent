import { generationNativeCapability } from "../generation/v01Contract.js";
import type {
  GenerationParameters,
  GenerationReferenceSnapshot,
} from "../generation/types.js";
import type {
  GenerationOrchestrationTier,
  GenerationParameterControl,
  GenerationParameterGroup,
  GenerationOperationQuote,
} from "./types.js";

const ratios = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];

export function generationParameterGroups(
  tier: GenerationOrchestrationTier,
  parameters: GenerationParameters,
  quote: GenerationOperationQuote,
  references: readonly GenerationReferenceSnapshot[] = [],
  speakerIds: readonly string[] = [],
): GenerationParameterGroup[] {
  const native = generationNativeCapability(tier.mediaKind, tier.model);
  const referenceCounts = {
    image: references.filter((reference) => reference.kind === "image").length,
    video: references.filter((reference) => reference.kind === "video").length,
    audio: references.filter((reference) => reference.kind === "audio").length,
  };
  const visual: GenerationParameterControl[] = [];
  const motion: GenerationParameterControl[] = [];
  const audio: GenerationParameterControl[] = [];

  if (tier.mediaKind === "image") {
    visual.push(
      control("resolution", "清晰度", scalar(parameters.size ?? parameters.resolution), {
        options: native?.visual?.resolutions ? [...native.visual.resolutions] : [],
        fixed: true,
        note: "模型原生档位完整展示；切换到其他已核价档位后重新报价。",
      }),
      control("ratio", "画幅", scalar(parameters.ratio ?? "16:9"), {
        options: native?.visual?.ratios ? [...native.visual.ratios] : ratios,
        fixed: true,
      }),
      control("reference_images", "参考图数量", referenceCounts.image, {
        range: {
          min: 0,
          max: native?.visual?.referenceImageLimit ?? 0,
          step: 1,
        },
        fixed: false,
        availability: "frozen_context",
        requiresRequote: false,
        note: "参考素材已冻结在操作卡中；如需更改，请重新选择素材并发起新轮次。",
      }),
      control(
        "sequential_image_generation",
        "组图生成",
        scalar(parameters.sequentialImageGeneration ?? "disabled"),
        {
          options: native?.visual?.supportsSequentialImages ? ["disabled", "auto"] : ["disabled"],
          fixed: true,
          note: native?.visual?.supportsSequentialImages
            ? "模型原生支持，但当前单结果档未核价；选择 auto 会返回未核价澄清。"
            : "当前模型原生不支持。",
          availability: native?.visual?.supportsSequentialImages
            ? "not_priced"
            : "not_supported",
          requiresRequote: native?.visual?.supportsSequentialImages ?? false,
        },
      ),
    );
    const customPixels = native?.visual?.customPixels;
    visual.push(control("size", "自定义宽×高", null, {
      fixed: false,
      availability: customPixels ? "not_priced" : "not_supported",
      requiresRequote: Boolean(customPixels),
      note: customPixels
        ? `提交 size=宽x高；总像素须为 ${customPixels.min}–${customPixels.max}，未核价组合会返回澄清。`
        : "当前模型没有登记自定义宽高能力。",
    }));
  }

  if (tier.mediaKind === "video") {
    visual.push(
      control("resolution", "清晰度", scalar(parameters.resolution), {
        options: native?.visual?.resolutions ? [...native.visual.resolutions] : [],
        fixed: true,
      }),
      control("ratio", "画幅", scalar(parameters.ratio), {
        options: native?.visual?.ratios ? [...native.visual.ratios] : ratios,
        fixed: true,
      }),
    );
    motion.push(
      control("duration_seconds", "时长（秒）", scalar(parameters.durationSeconds), {
        range: native?.motion?.durationSeconds,
        fixed: true,
      }),
      control("generate_audio", "同时生成声音", scalar(parameters.generateAudio ?? true), {
        options: [true, false],
        fixed: true,
      }),
      control("reference_images", "参考图数量", referenceCounts.image, {
        range: { min: 0, max: native?.motion?.referenceImageLimit ?? 0, step: 1 },
        fixed: false,
        availability: "frozen_context",
        requiresRequote: false,
        note: "参考素材已冻结在操作卡中；如需更改，请重新选择素材并发起新轮次。",
      }),
      control("reference_videos", "参考视频数量", referenceCounts.video, {
        range: { min: 0, max: native?.motion?.referenceVideoLimit ?? 0, step: 1 },
        fixed: false,
        availability: "frozen_context",
        requiresRequote: false,
        note: "参考素材已冻结在操作卡中；如需更改，请重新选择素材并发起新轮次。",
      }),
      control("reference_audio", "参考音频数量", referenceCounts.audio, {
        range: { min: 0, max: native?.motion?.referenceAudioLimit ?? 0, step: 1 },
        fixed: false,
        availability: "frozen_context",
        requiresRequote: false,
        note: "参考素材已冻结在操作卡中；如需更改，请重新选择素材并发起新轮次。",
      }),
    );
  }

  if (tier.mediaKind === "audio") {
    const capability = native?.audio;
    audio.push(
      control("original_duration_seconds", "计费原始时长（秒）", scalar(parameters.originalDurationSeconds), {
        range: capability?.originalDurationSeconds,
        fixed: true,
      }),
      control("format", "格式", scalar(parameters.format ?? "mp3"), {
        options: capability?.formats ? [...capability.formats] : ["mp3", "wav", "pcm"],
        fixed: true,
      }),
      control("sample_rate", "采样率", scalar(parameters.sampleRate ?? 48_000), {
        options: capability?.sampleRates ? [...capability.sampleRates] : [],
        fixed: true,
      }),
      control("speaker_id", "音色", scalar(parameters.speakerId), {
        fixed: false,
        options: [...speakerIds],
        availability: speakerIds.length > 0 ? "adjustable" : "not_supported",
        requiresRequote: speakerIds.length > 0,
        note: speakerIds.length > 0
          ? "只可选择已登记且启用的公司音色；显示名由音色目录提供。"
          : "当前没有已登记且启用的公司音色。",
      }),
      control("speech_rate", "语速", scalar(parameters.speechRate ?? 0), {
        range: capability?.speechRate,
        fixed: false,
      }),
      control("loudness_rate", "音量", scalar(parameters.loudnessRate ?? 0), {
        range: capability?.loudnessRate,
        fixed: false,
      }),
      control("pitch_rate", "音高", scalar(parameters.pitchRate ?? 0), {
        range: capability?.pitchRate,
        fixed: false,
      }),
      control("reference_audio", "参考音频数量", referenceCounts.audio, {
        range: { min: 0, max: capability?.referenceAudioLimit ?? 0, step: 1 },
        fixed: false,
        availability: "frozen_context",
        requiresRequote: false,
        note: "参考素材已冻结在操作卡中；如需更改，请重新选择素材并发起新轮次。",
      }),
      control("reference_images", "参考图数量", referenceCounts.image, {
        range: { min: 0, max: capability?.referenceImageLimit ?? 0, step: 1 },
        fixed: false,
        availability: "frozen_context",
        requiresRequote: false,
        note: "参考素材已冻结在操作卡中；如需更改，请重新选择素材并发起新轮次。",
      }),
    );
  }

  const cost = [
    control("tier_id", "能力档位", tier.tierId, {
      fixed: true,
      note: "只可选择当前有效且已核价的公司账户档位。",
    }),
    control("estimated_cost_fen", "预计费用（人民币分）", quote.estimatedCostFen, {
      fixed: true,
      note: quote.notice,
    }),
    control("billing_unit", "计费单位", quote.billingUnit, {
      fixed: true,
    }),
    control("billable_units", "计费数量", quote.billableUnits, {
      fixed: true,
    }),
  ];

  return [
    { key: "visual", label: "画面", controls: visual },
    { key: "motion", label: "运动", controls: motion },
    { key: "audio", label: "声音", controls: audio },
    { key: "cost", label: "成本", controls: cost },
  ];
}

function control(
  key: string,
  label: string,
  value: string | number | boolean | null,
  options: {
    fixed: boolean;
    availability?: GenerationParameterControl["availability"];
    requiresRequote?: boolean;
    options?: Array<string | number | boolean>;
    range?: { min: number; max: number; step?: number };
    note?: string;
  },
): GenerationParameterControl {
  const availability = options.availability
    ?? (options.fixed ? "fixed_by_tier" : "adjustable");
  return {
    key,
    label,
    value,
    defaultValue: value,
    availability,
    requiresRequote: options.requiresRequote
      ?? (availability !== "not_supported" && availability !== "frozen_context"),
    ...(options.options && options.options.length > 0 ? { options: options.options } : {}),
    ...(options.range ? { range: options.range } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
}

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}
