import { z } from "zod";
import { AppError } from "../../shared/errors.js";
import type { AiGatewayService } from "../ai/service.js";
import type { GenerationParameters } from "../generation/types.js";
import {
  generationParametersFromWire,
  generationRequestedParametersWireSchema,
} from "./requestParameters.js";
import type {
  GenerationIntentClarification,
  GenerationIntentDecision,
  GenerationIntentInterpreter,
  GenerationIntentInterpreterInput,
} from "./types.js";

const clarificationCodes = [
  "media_kind_required",
  "edit_target_required",
  "edit_target_mismatch",
  "audio_edit_not_supported",
  "trusted_script_required",
  "registered_male_speaker_required",
  "registered_female_speaker_required",
  "tier_not_priced",
  "request_ambiguous",
] as const;

const llmDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("operation"),
    operation_type: z.enum(["generate", "edit"]),
    media_kind: z.enum(["image", "video", "audio"]),
    prompt: z.string().trim().min(1).max(100_000),
    requested_tier_id: z.string().trim().min(1).max(128).optional(),
    requested_voice_gender: z.enum(["male", "female"]).optional(),
    requested_parameters: generationRequestedParametersWireSchema.default({}),
  }).strict(),
  z.object({
    decision: z.literal("clarification"),
    code: z.enum(clarificationCodes),
    question: z.string().trim().min(1).max(500),
    choices: z.array(z.object({
      value: z.string().trim().min(1).max(64),
      label: z.string().trim().min(1).max(80),
    }).strict()).max(8).optional(),
  }).strict(),
]);

export class DeterministicGenerationIntentInterpreter implements GenerationIntentInterpreter {
  async interpret(input: GenerationIntentInterpreterInput): Promise<GenerationIntentDecision> {
    const message = normalizedText(input.message);
    const selected = input.context.selectedAsset;
    const mediaKind = inferMediaKind(message, selected?.mediaKind);
    if (!mediaKind) return mediaKindClarification();

    const wantsEdit = editIntent(message);
    if (mediaKind === "audio" && wantsEdit && !/再生成|重新生成|生成一遍/u.test(message)) {
      return {
        decision: "clarification",
        code: "audio_edit_not_supported",
        question: "当前支持文本重新生成音频，不会直接覆盖已有音频。要按这段文字重新生成一条音频吗？",
        choices: [{ value: "regenerate_audio", label: "重新生成音频" }],
      };
    }

    if (wantsEdit && !selected) {
      return {
        decision: "clarification",
        code: "edit_target_required",
        question: `请先选中要修改的${mediaLabel(mediaKind)}，我才能保留原素材并准备修改报价。`,
      };
    }
    if (wantsEdit && selected?.mediaKind !== mediaKind) {
      return {
        decision: "clarification",
        code: "edit_target_mismatch",
        question: `当前选中的是${mediaLabel(selected!.mediaKind)}，请改选要修改的${mediaLabel(mediaKind)}。`,
      };
    }
    const operationType = wantsEdit ? "edit" : "generate";

    return {
      decision: "operation",
      operationType,
      mediaKind,
      prompt: input.message.trim(),
      ...(mediaKind === "audio" && voiceGender(message)
        ? { requestedVoiceGender: voiceGender(message) }
        : {}),
      requestedParameters: inferParameters(message, mediaKind),
    };
  }
}

export class AiGenerationIntentInterpreter implements GenerationIntentInterpreter {
  constructor(private readonly gateway: Pick<AiGatewayService, "completeValidated">) {}

  async interpret(input: GenerationIntentInterpreterInput): Promise<GenerationIntentDecision> {
    return this.gateway.completeValidated({
      actorId: input.actorId,
      purpose: "generation_orchestration",
      projectId: input.context.projectId,
      relatedObject: { type: "generation_orchestration", id: input.context.projectId },
      system: [
        "你是短剧生成操作解释器，只输出一个 JSON 对象，不输出 Markdown。",
        "你只能准备操作或提出澄清，绝不能执行、重试、改价格或发明供应商/model id。",
        "修改图片或视频必须依赖同模态选中媒体；选中图片要求动起来是 image-to-video。",
        "选中音频后要求再生成时使用 operation_type=edit；男声或女声写入 requested_voice_gender，台词由服务端可信来源解析，不要抄写指令本身。",
        "requested_tier_id 只能从输入档位列表选择；没有匹配核价档时返回 tier_not_priced。",
        "自然语言没说的参数不要猜，留空交给服务端默认值。",
        "字段合同：operation={decision,operation_type,media_kind,prompt,requested_tier_id?,requested_voice_gender?,requested_parameters};",
        "clarification={decision,code,question,choices?}。所有 question 使用中文。",
      ].join("\n"),
      prompt: JSON.stringify({
        message: input.message,
        context: input.context,
        available_tiers: input.tiers.map((tier) => ({
          tier_id: tier.tierId,
          media_kind: tier.mediaKind,
          display_name: tier.displayName,
          parameters: tier.parameters,
        })),
      }),
      thinking: "disabled",
      // 业务判断,不是能力上限:输出只有 operation/clarification 两种固定形状
      // (llmDecisionSchema)。2026-08-07 输出上限动态化时复核后刻意保留——
      // 抬到模型最大值不会让意图解析更准。能力上限由网关查表兜。
      maxTokens: 1_200,
    }, (completion) => {
      const parsed = llmDecisionSchema.safeParse(parseJsonObject(completion.content));
      if (!parsed.success) {
        throw new AppError(
          502,
          "generation_intent_invalid",
          "这句话暂时没能整理成安全的生成操作，请换一种说法。",
          true,
        );
      }
      return fromLlmDecision(parsed.data);
    });
  }
}

function fromLlmDecision(parsed: z.infer<typeof llmDecisionSchema>): GenerationIntentDecision {
  if (parsed.decision === "clarification") {
    return {
      decision: "clarification",
      code: parsed.code,
      question: parsed.question,
      ...(parsed.choices ? { choices: parsed.choices } : {}),
    };
  }
  return {
    decision: "operation",
    operationType: parsed.operation_type,
    mediaKind: parsed.media_kind,
    prompt: parsed.prompt,
    ...(parsed.requested_tier_id ? { requestedTierId: parsed.requested_tier_id } : {}),
    ...(parsed.requested_voice_gender
      ? { requestedVoiceGender: parsed.requested_voice_gender }
      : {}),
    requestedParameters: generationParametersFromWire(parsed.requested_parameters),
  };
}

function inferMediaKind(
  message: string,
  selectedKind: "image" | "video" | "audio" | undefined,
): "image" | "video" | "audio" | undefined {
  if (/音频|配音|旁白|男声|女声|音色|声音/u.test(message)) return "audio";
  if (/视频|成片|动起来|运镜|镜头运动|动画/u.test(message)) return "video";
  if (/图片|图像|生图|改图|这张图|一张[^，。！？]*图|的图|画面|海报/u.test(message)) return "image";
  if (editIntent(message)) return selectedKind;
  return undefined;
}

function editIntent(message: string): boolean {
  return /修改|改成|改亮|调亮|调暗|换成|替换|重绘|改图|改视频|再生成|重新生成/u.test(message);
}

function voiceGender(message: string): "male" | "female" | undefined {
  if (/男声|男性音色|男音/u.test(message)) return "male";
  if (/女声|女性音色|女音/u.test(message)) return "female";
  return undefined;
}

function inferParameters(
  message: string,
  mediaKind: "image" | "video" | "audio",
): GenerationParameters {
  const parameters: GenerationParameters = {};
  const ratio = message.match(/(?:画幅|比例)?\s*(16:9|4:3|1:1|3:4|9:16|21:9)/u)?.[1];
  if (ratio) parameters.ratio = ratio;

  const resolution = message.match(/\b(480p|720p|1080p|1k|2k|3k|4k)\b/iu)?.[1];
  if (resolution) {
    const normalized = resolution.toUpperCase() === "1080P"
      || resolution.toUpperCase() === "720P"
      || resolution.toUpperCase() === "480P"
      ? resolution.toLowerCase()
      : resolution.toUpperCase();
    if (mediaKind === "image") parameters.size = normalized;
    else if (mediaKind === "video") parameters.resolution = normalized;
  }

  const seconds = Number(message.match(/(\d{1,3})\s*秒/u)?.[1]);
  if (Number.isSafeInteger(seconds) && seconds > 0) {
    if (mediaKind === "video") parameters.durationSeconds = seconds;
    if (mediaKind === "audio") parameters.originalDurationSeconds = seconds;
  }
  if (mediaKind === "video") {
    if (/静音|不要声音|无声/u.test(message)) parameters.generateAudio = false;
    if (/带声音|生成声音|保留声音/u.test(message)) parameters.generateAudio = true;
  }
  if (mediaKind === "image" && /组图|一组图/u.test(message)) {
    parameters.sequentialImageGeneration = "auto";
  }
  if (mediaKind === "audio") {
    if (/\b(wav|pcm|mp3)\b/iu.test(message)) {
      parameters.format = message.match(/\b(wav|pcm|mp3)\b/iu)![1]!.toLowerCase() as "wav" | "pcm" | "mp3";
    }
    if (/快一点|加快/u.test(message)) parameters.speechRate = 20;
    if (/慢一点|放慢/u.test(message)) parameters.speechRate = -20;
  }
  return parameters;
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function mediaKindClarification(): GenerationIntentClarification {
  return {
    decision: "clarification",
    code: "media_kind_required",
    question: "你想生成图片、视频还是音频？",
    choices: [
      { value: "image", label: "图片" },
      { value: "video", label: "视频" },
      { value: "audio", label: "音频" },
    ],
  };
}

function mediaLabel(mediaKind: "image" | "video" | "audio"): string {
  return mediaKind === "image" ? "图片" : mediaKind === "video" ? "视频" : "音频";
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
