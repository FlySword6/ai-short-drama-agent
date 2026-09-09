import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { settings, type Settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetVariants,
  episodes,
  generationDefaultStrategies,
  projectAssetRefs,
  projects,
  promptDefaultTemplates,
  promptTemplates,
  scenes,
  shots,
} from "../../db/schema.js";
import type { AssetSearchItem } from "../../domain/assets/types.js";
import { ArkChatClient } from "../../integrations/arkClient.js";
import { DoubaoEmbeddingClient, type EmbeddingClient } from "../../integrations/embeddingClient.js";
import type { TextCompletionPort } from "../../services/searchService.js";
import { AppError, BadRequestError, ExternalServiceError, NotFoundError } from "../../shared/errors.js";
import { parseJsonValue } from "../../shared/json.js";
import { DEFAULT_IMAGE_PROMPT_TEMPLATE, DEFAULT_VIDEO_PROMPT_TEMPLATE, renderProjectPromptTemplate, type PromptReferenceEntry } from "../generation/promptCompiler.js";
import { HybridAssetSearchService } from "../assets/hybridSearchService.js";
import { platformRoleOrMember } from "../auth/types.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import {
  assetMatchRerankPrompt,
  assetMatchRerankSystem,
  promptDraftPrompt,
  promptDraftSystem,
  promptTranslatePrompt,
  promptTranslateSystem,
} from "./prompts.js";
import { DrizzleAiCallRepository } from "./repository.js";
import { RoutedAiCompletionProvider, type AiCompletionRoute } from "./routedCompletionProvider.js";
import {
  CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS,
  DrizzleModelCapabilityStore,
  ModelCapabilityLookup,
  stageOutputBudget,
} from "./modelCapabilities.js";
import {
  ColCompletionProvider,
  ColCompletionTimeoutError,
} from "./colCompletionProvider.js";
import { ProviderTransportError } from "../../shared/providerTransportFailure.js";
import {
  AiCompletionValidationError,
  AI_ASSET_MATCH_MAX_DESCRIPTION_CHARS,
  AI_ASSET_MATCH_QUERY_UNDERSTANDING_MAX_TOKENS,
  AI_ASSET_MATCH_RERANK_MAX_TOKENS,
  AI_PROMPT_DRAFT_MAX_CREATIVE_CONTEXT_CHARS,
  AI_PROMPT_DRAFT_MAX_DESCRIPTION_CHARS,
  AI_PROMPT_DRAFT_MAX_NAME_CHARS,
  AI_PROMPT_DRAFT_MAX_SELECTED_ASSETS,
  AI_PROMPT_DRAFT_MAX_SUPPLEMENT_CHARS,
  AI_PROMPT_DRAFT_MAX_TOKENS,
  AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS,
  AI_PROMPT_TRANSLATE_MAX_TOKENS,
} from "./types.js";
import type {
  AiCallRepository,
  AiCompletionProvider,
  AiCompletionRequest,
  AiPurpose,
  AiProductionAssistAccessPort,
  AiProviderCompletion,
  AiConversationMessage,
  AiPromptModelKey,
  AiPromptModelOption,
  AiProviderToolTurn,
  AiToolSpec,
  AiToolTurnRequest,
  AssetMatchCandidate,
  AssetMatchItem,
  AssetMatchResult,
  AssetMatchRetriever,
  FailAiCallInput,
  PromptDraftResult,
  PromptTemplateContext,
  AiRelatedObject,
  PromptDraftInput,
  PromptDraftAssetContext,
  PromptTranslationInput,
  PromptTranslationResult,
} from "./types.js";

const MAX_ASSET_MATCH_CANDIDATES = 20;
const MAX_ASSET_MATCH_RESULTS = 8;

/** 渲染 AI 优化/起草链路的图片模板占位符（与生成期 renderProjectPromptTemplate 同源）：
 * {{segment_content}}→生产意图，{{characters}}/{{props}}/{{references}}→已选资产按角色栏分组，
 * {{style_description}}→项目默认风格；{{scene}} 等无值占位符所在行删除。
 * 模板含未知占位符时（生成期会校验拒绝）回退原始模板，不因模板配置问题中断 AI 优化。 */
function renderPromptDraftTemplate(
  template: string,
  context: { description: string; visualStyle?: string; assets: PromptDraftAssetContext[] },
): string {
  const references: PromptReferenceEntry[] = context.assets
    .filter((asset) => asset.name?.trim())
    .map((asset) => ({
      lane: asset.usageMode === "identity" ? "character"
        : asset.usageMode === "prop" ? "prop"
        : "reference",
      name: asset.name,
      description: asset.description?.trim() || undefined,
    }));
  try {
    return renderProjectPromptTemplate(template, {
      shotIntent: context.description,
      styleDescription: context.visualStyle,
    }, references).prompt;
  } catch {
    return template;
  }
}

/**
 * 用途级请求超时覆盖(#282 评估项,**2026-08-18 用户批准**)。
 *
 * P6 阶段②把拆镜从「每轮填一格」(每轮输出天然小,120 秒余量充足)改成
 * 「一次拆全部分镜」(输出随剧本长度线性增长:实测 208 字剧本一次拆镜
 * 65 秒、2627 字剧本超过 120 秒被客户端掐死)。「一次拆完」的活塞进了
 * 给「一次填一格」设计的 120 秒表里,长剧本必撞。
 *
 * 只放宽这一个用途:调超时是花钱的决定,归 #282,这里逐用途写死并留
 * 批注,不做配置面。其余用途一律继续走适配器默认 120 秒。600 秒是
 * 两个适配器结构上限(Col 构造器闸 / Ark MAX_ARK_REQUEST_TIMEOUT_MS)
 * 内的最大值——再大要先动结构上限,又是一次花钱的决定。
 */
export const AI_PURPOSE_TIMEOUT_OVERRIDES: Partial<Record<AiPurpose, number>> = {
  script_breakdown_storyboard: 600_000,
};

const assetMatchRerankSchema = z.object({
  items: z.array(z.object({
    candidate_id: z.string().trim().min(1).max(256),
    reason: z.string().trim().min(1).max(512),
  }).strict()).max(MAX_ASSET_MATCH_RESULTS),
}).strict();

const promptTranslationSchema = z.object({
  auto: z.string().trim().min(1).max(AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS),
  supplement: z.string().max(AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS),
}).strict();

export interface AiGatewayConfiguration {
  enabled: boolean;
  apiKeyConfigured: boolean;
  embeddingApiKeyConfigured?: boolean;
  dailyCallLimit: number;
  defaultModel: string | null;
  embeddingModel: string | null;
  promptModels?: Partial<Record<AiPromptModelKey, string | null>>;
  purposeModels?: Partial<Record<AiPurpose, string | null>>;
  promptModelBindings?: readonly AiPromptModelBinding[];
  defaultPromptModelKey?: AiPromptModelKey;
}

export interface AiPromptModelBinding extends AiPromptModelOption {
  providerId: "ark" | "minimax" | "col";
  model: string;
}

/** 一个文字模型归哪个通道。通道是模型的属性,不是整个网关的开关。 */
export interface AiTextModelRoute {
  model: string;
  providerId: "ark" | "col";
}

interface AiTextChannelSource {
  arkApiKeyConfigured: boolean;
  arkLlmModels?: string;
  arkLlmModel?: string;
  doubaoLlmModel?: string;
  colBaseUrl?: string;
  colApiKeyConfigured?: boolean;
  colTextModels?: string;
  colScriptBreakdownModel?: string;
  colPromptDraftModel?: string;
  colPromptTranslateModel?: string;
}

/**
 * 文字模型的通道归属:火山方舟优先,公司通道兜底。
 *
 * 同一个模型 ID 两边都登记时走火山——火山是我们自己的正版部署,版本可控;
 * 公司通道只承载火山没有的模型(kimi、qwen、deepseek-pro 这类)。
 * 两个通道各自可缺席:只配火山、只配公司通道、两个都配,都是合法部署。
 */
export function textModelRoutes(source: AiTextChannelSource): AiTextModelRoute[] {
  const arkModels = source.arkApiKeyConfigured
    ? uniqueModels(source.arkLlmModels, source.arkLlmModel, source.doubaoLlmModel)
    : [];
  const colModels = isColCompletionConfigured(source) ? uniqueModels(source.colTextModels) : [];
  const servedByArk = new Set(arkModels);
  return [
    ...arkModels.map((model) => ({ model, providerId: "ark" as const })),
    ...colModels
      .filter((model) => !servedByArk.has(model))
      .map((model) => ({ model, providerId: "col" as const })),
  ];
}

export function aiGatewayConfiguration(
  source: Pick<
    Settings,
    | "aiGatewayEnabled"
    | "aiDailyCallLimit"
    | "arkApiKeyConfigured"
    | "arkLlmModels"
    | "arkLlmModel"
    | "doubaoLlmModel"
    | "doubaoEmbeddingModel"
    | "aiPromptLlmQualityModel"
    | "aiPromptLlmFastModel"
    | "minimaxApiKey"
    | "minimaxLlmModels"
  > & Partial<Pick<
    Settings,
    | "colBaseUrl"
    | "colApiKeyConfigured"
    | "colTextModels"
    | "colScriptBreakdownModel"
    | "colPromptDraftModel"
    | "colPromptTranslateModel"
  >> = settings,
): AiGatewayConfiguration {
  const colConfigured = isColCompletionConfigured(source);
  const routes = textModelRoutes(source);
  const promptModelBindings = promptModelBindingsFor(routes);
  const cheapest = cheapestPromptModel(promptModelBindings);
  const arkModels = new Set(
    routes.filter((route) => route.providerId === "ark").map((route) => route.model),
  );
  const arkConfigured = arkModels.size > 0;
  const onArk = (model: string | undefined | null) => (model && arkModels.has(model) ? model : null);
  const legacyQualityModel = source.aiPromptLlmQualityModel
    ?? source.arkLlmModel
    ?? source.doubaoLlmModel
    ?? null;
  const arkQualityModel = onArk(legacyQualityModel) ?? cheapest?.model ?? null;
  const arkFastModel = onArk(source.aiPromptLlmFastModel);
  // 拆解用火山这边点名配置的那个模型,而不是目录里最便宜的那个:拆解吃的是质量。
  const arkBreakdownModel = onArk(source.arkLlmModel ?? source.doubaoLlmModel) ?? arkQualityModel;
  /** 火山在场就用火山这一档,公司通道只在火山缺席时接管默认值。 */
  const arkFirst = (arkModel: string | null, colModel: string | undefined) => (
    arkConfigured ? arkModel : colConfigured ? colModel ?? null : null
  );
  const defaultModel = arkFirst(
    cheapest?.model ?? onArk(legacyQualityModel),
    source.colPromptDraftModel,
  );
  return {
    enabled: source.aiGatewayEnabled,
    // A credential without an explicit model binding is not a configured
    // completion route and must fail before reserving an audited provider call.
    apiKeyConfigured: promptModelBindings.length > 0,
    embeddingApiKeyConfigured: source.arkApiKeyConfigured,
    dailyCallLimit: source.aiDailyCallLimit,
    defaultModel,
    embeddingModel: source.doubaoEmbeddingModel ?? null,
    promptModels: {
      quality: arkFirst(arkQualityModel, source.colPromptDraftModel),
      fast: arkFirst(arkFastModel, source.colPromptTranslateModel),
    },
    // 每项能力默认用哪个模型,同样是火山优先。至于这个模型走哪条通道,
    // 由 textModelRoutes 按模型判定,与用途无关。
    ...(arkConfigured || colConfigured ? {
      purposeModels: {
        prompt_draft: arkFirst(arkQualityModel, source.colPromptDraftModel),
        prompt_translate: arkFirst(arkFastModel ?? arkQualityModel, source.colPromptTranslateModel),
        script_breakdown: arkFirst(arkBreakdownModel, source.colScriptBreakdownModel),
        script_breakdown_enrich: arkFirst(arkBreakdownModel, source.colScriptBreakdownModel),
        // P6 阶段②(skill 单次结构化拆镜):与阶段①同一条解析链,火山优先。
        script_breakdown_storyboard: arkFirst(arkBreakdownModel, source.colScriptBreakdownModel),
      },
    } : {}),
    promptModelBindings,
    // 默认模型按合同取「起草用 AI_PROMPT_LLM_QUALITY_MODEL」那一档：
    // 火山在场时默认走豆包 quality 模型，而不是捡 catalog 里最便宜的一档。
    ...(arkConfigured && arkQualityModel
      ? { defaultPromptModelKey: "quality" as const }
      : arkConfigured && cheapest ? { defaultPromptModelKey: cheapest.key } : {}),
  };
}

const ARK_PRICE_SOURCE = "https://www.volcengine.com/product/doubao";

/**
 * 目录里每个模型都带着自己的通道。序号按通道各自计数,所以某个通道多配一个
 * 模型不会让另一个通道的「部署模型 N」跟着改名。
 *
 * FABLE-016: MiniMax is a private account. Its adapter and historical metadata
 * remain in source, but the production model catalog never exposes a direct
 * route, even if legacy key/allowlist fields are still populated.
 */
function promptModelBindingsFor(routes: readonly AiTextModelRoute[]): AiPromptModelBinding[] {
  const indexByProvider: Record<"ark" | "col", number> = { ark: 0, col: 0 };
  return routes.map(({ model, providerId }) => {
    const modelLabel = publicPromptModelLabel(providerId, model, indexByProvider[providerId]++);
    if (providerId === "col") {
      return {
        key: stablePromptModelKey("col", model),
        displayName: `公司文字通道 · ${modelLabel}`,
        description: "公司账户已登记；调用受统一审计与每日限额保护",
        available: true,
        isDefault: false,
        providerId,
        providerLabel: "公司文字通道",
        modelLabel,
        model,
      };
    }
    const price = arkLlmPrice(model);
    return {
      key: stablePromptModelKey("ark", model),
      displayName: `火山方舟 · ${modelLabel}`,
      description: price
        ? `官方按量价：输入 ${price.input}、输出 ${price.output} 元/百万 tokens`
        : "部署已登记；调用仍受统一审计与每日限额保护",
      available: true,
      isDefault: false,
      providerId,
      providerLabel: "火山方舟",
      modelLabel,
      officialPriceSource: ARK_PRICE_SOURCE,
      ...(price ? {
        inputPriceYuanPerMillionTokens: price.input,
        outputPriceYuanPerMillionTokens: price.output,
      } : {}),
      model,
    };
  });
}

function cheapestPromptModel(
  bindings: readonly AiPromptModelBinding[],
): AiPromptModelBinding | undefined {
  return bindings.filter((binding) => Number.isFinite(modelPriceScore(binding))).sort((left, right) => {
    const leftPrice = modelPriceScore(left);
    const rightPrice = modelPriceScore(right);
    if (leftPrice !== rightPrice) return leftPrice - rightPrice;
    return right.model.localeCompare(left.model);
  })[0];
}

function modelPriceScore(binding: AiPromptModelBinding): number {
  if (binding.inputPriceYuanPerMillionTokens === undefined
    || binding.outputPriceYuanPerMillionTokens === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return binding.inputPriceYuanPerMillionTokens + binding.outputPriceYuanPerMillionTokens;
}

function arkLlmPrice(model: string): { input: number; output: number } | undefined {
  if (/^doubao-seed-2-0-mini-/u.test(model)) return { input: 0.2, output: 2 };
  if (/^doubao-seed-2-0-lite-/u.test(model)) return { input: 0.6, output: 3.6 };
  if (/^doubao-seed-2-0-pro-/u.test(model)) return { input: 3.2, output: 16 };
  if (/^doubao-seed-2-1-turbo-/u.test(model)) return { input: 3, output: 15 };
  if (/^doubao-seed-2-1-pro-/u.test(model)) return { input: 6, output: 30 };
  return undefined;
}

function uniqueModels(...values: Array<string | undefined>): string[] {
  return [...new Set(values.flatMap((value) => (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)))];
}

function stablePromptModelKey(provider: "ark" | "minimax" | "col", model: string): string {
  const digest = createHash("sha256")
    .update(provider)
    .update("\0")
    .update(model)
    .digest("hex")
    .slice(0, 24);
  return `model-${digest}`;
}

function publicPromptModelLabel(
  provider: "ark" | "minimax" | "col",
  model: string,
  index: number,
): string {
  if (model === "deepseek-v4-flash-ga-260731") return "DeepSeek V4 Flash";
  const arkFamilies: Array<[RegExp, string]> = [
    [/^doubao-seed-2-0-mini-\d{6}$/u, "豆包 Seed 2.0 Mini"],
    [/^doubao-seed-2-0-lite-\d{6}$/u, "豆包 Seed 2.0 Lite"],
    [/^doubao-seed-2-0-pro-\d{6}$/u, "豆包 Seed 2.0 Pro"],
    [/^doubao-seed-2-1-turbo-\d{6}$/u, "豆包 Seed 2.1 Turbo"],
    [/^doubao-seed-2-1-pro-\d{6}$/u, "豆包 Seed 2.1 Pro"],
  ];
  if (provider === "ark") {
    return arkFamilies.find(([pattern]) => pattern.test(model))?.[1]
      ?? `部署模型 ${index + 1}`;
  }
  if (provider === "col") return `部署模型 ${index + 1}`;
  const minimaxLabels: Readonly<Record<string, string>> = {
    "MiniMax-M3": "M3",
    "MiniMax-M2.7": "M2.7",
    "MiniMax-M2.7-highspeed": "M2.7 高速",
    "MiniMax-M2.5": "M2.5",
    "MiniMax-M2.5-highspeed": "M2.5 高速",
    "MiniMax-M2.1": "M2.1",
    "MiniMax-M2.1-highspeed": "M2.1 高速",
    "MiniMax-M2": "M2",
  };
  return minimaxLabels[model] ?? `部署模型 ${index + 1}`;
}

export function isColCompletionConfigured(source: {
  colBaseUrl?: string;
  colApiKeyConfigured?: boolean;
  colTextModels?: string;
  colScriptBreakdownModel?: string;
  colPromptDraftModel?: string;
  colPromptTranslateModel?: string;
}): boolean {
  return Boolean(
    source.colBaseUrl
    && source.colApiKeyConfigured
    && uniqueModels(source.colTextModels).length > 0
    && source.colScriptBreakdownModel
    && source.colPromptDraftModel
    && source.colPromptTranslateModel,
  );
}

/** Ark is only an adapter here; quota, logging and prompt ownership stay above it. */
export class ArkAiCompletionProvider implements AiCompletionProvider {
  constructor(private readonly client = new ArkChatClient()) {}

  complete(input: {
    system: string;
    prompt: string;
    model?: string;
    thinking?: "enabled" | "disabled" | "auto";
    maxTokens: number;
    timeoutMs?: number;
  }): Promise<AiProviderCompletion> {
    return this.client.completeTextWithMetadata(input.prompt, input.system, {
      model: input.model,
      thinking: input.thinking,
      maxTokens: input.maxTokens,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
  }

  completeToolTurn(input: AiToolTurnRequest): Promise<AiProviderToolTurn> {
    return this.client.completeToolTurn(input);
  }
}

export class AiGatewayService {
  constructor(
    private readonly repository: AiCallRepository,
    private readonly provider: AiCompletionProvider,
    private readonly configuration: AiGatewayConfiguration = aiGatewayConfiguration(),
    private readonly now: () => Date = () => new Date(),
    private readonly embedding: EmbeddingClient = new DoubaoEmbeddingClient(),
    /**
     * 模型容量真源。缺省时(单测与旧调用方)按保守兜底上限判断,
     * 行为等价于改造前的适配器硬顶,不会比现状更宽松。
     */
    private readonly capabilities?: ModelCapabilityLookup,
  ) {}

  /**
   * 当前模型允许的最大输出 token。这是「max output token 动态化」的读取点:
   * 表里查到就用模型自己的能力,查不到用保守兜底(理由见
   * CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS 注释)。
   */
  async maxOutputTokensFor(model: string): Promise<number> {
    if (!this.capabilities) return CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS;
    return this.capabilities.maxOutputTokens(model);
  }

  /**
   * 多阶段结构化任务(剧本拆解)单次该要多少输出预算。
   * 留余量的三条理由写在 stageOutputBudget 里——拿到 384k 不等于该传 384k。
   *
   * 只收用途:用途对应哪个模型由网关按配置解析(和 completeValidated 同一
   * 条规则),调用方自己猜模型会算出跟实际调用不一致的预算然后被拒。
   * 解析不出模型就报错——这里返回一个兜底数字等于把「没配好」伪装成
   * 「预算就这么大」,而实际调用马上会在同一处配置上失败。
   */
  async stageOutputBudgetFor(purpose: AiPurpose): Promise<number> {
    // 用与真实调用同一套可用性规则回答:关掉的网关不该先给出一个预算数字,
    // 再在几毫秒后的调用上报「服务未准备好」。
    this.assertAvailable();
    return stageOutputBudget(await this.maxOutputTokensFor(this.modelForPurpose(purpose)));
  }

  /** 用途 → 实际会被调用的模型。与 completeValidated 的解析规则保持同一条。 */
  private modelForPurpose(purpose: AiPurpose): string {
    const model = this.configuration.purposeModels?.[purpose] ?? this.configuration.defaultModel;
    if (!model) {
      throw new AppError(
        503,
        "ai_gateway_not_configured",
        "使用 AI 辅助没成：服务暂未准备好，请联系管理员处理。",
        false,
      );
    }
    return model;
  }

  assertAvailable(): void {
    this.assertEnabledAndApiKey();
    if (!this.configuration.defaultModel) {
      throw new AppError(503, "ai_gateway_not_configured", "使用 AI 辅助没成：服务暂未准备好，请联系管理员处理。", false);
    }
  }

  promptModelCatalog(): { items: AiPromptModelOption[]; defaultKey: AiPromptModelKey } {
    const models = this.resolvedPromptModels();
    const configuredDefault = this.configuration.defaultPromptModelKey;
    const defaultKey: AiPromptModelKey = configuredDefault && models[configuredDefault]
      ? configuredDefault
      : models.quality ? "quality" : models.fast ? "fast" : "quality";
    const dynamicItems = (this.configuration.promptModelBindings ?? []).map((binding) => {
      const {
        providerId: _providerId,
        model: _model,
        ...option
      } = binding;
      return { ...option, isDefault: binding.key === defaultKey };
    });
    return {
      items: [
        {
          key: "quality",
          displayName: "精细档",
          description: "适合复杂画面、风格控制和最终提示词整理",
          available: Boolean(models.quality),
          isDefault: defaultKey === "quality",
        },
        {
          key: "fast",
          displayName: "快速档",
          description: "适合快速试写、翻译和轻量调整",
          available: Boolean(models.fast),
          isDefault: defaultKey === "fast",
        },
        ...dynamicItems,
      ],
      defaultKey,
    };
  }

  resolvePromptModel(
    requestedKey: AiPromptModelKey | undefined,
    preferredKey: AiPromptModelKey,
  ): { key: AiPromptModelKey; model: string } {
    const models = this.resolvedPromptModels();
    const configuredDefault = this.configuration.defaultPromptModelKey;
    const key = requestedKey
      ?? (configuredDefault && models[configuredDefault]
        ? configuredDefault
        : models[preferredKey] ? preferredKey : preferredKey === "quality" ? "fast" : "quality");
    const model = models[key];
    if (!model) {
      throw new AppError(
        422,
        "ai_model_unavailable",
        key === "fast"
          ? "生成提示词没成：快速档暂未准备好，请改用其他可用模型。"
          : key === "quality"
            ? "生成提示词没成：精细档暂未准备好，请改用其他可用模型。"
            : "生成提示词没成：所选模型暂不可用，请从模型列表重新选择。",
        false,
      );
    }
    return { key, model };
  }

  private resolvedPromptModels(): Record<AiPromptModelKey, string | null> {
    const models: Record<AiPromptModelKey, string | null> = {
      quality: this.configuration.promptModels?.quality ?? this.configuration.defaultModel,
      fast: this.configuration.promptModels?.fast ?? null,
    };
    for (const binding of this.configuration.promptModelBindings ?? []) {
      models[binding.key] = binding.available ? binding.model : null;
    }
    return models;
  }

  /**
   * The asset matcher gives this narrow wrapper to HybridAssetSearchService
   * instead of its raw embedding adapter. This makes each actual vector
   * request a separately reserved and auditable provider attempt.
   */
  embeddingClient(actorId: string): EmbeddingClient {
    return {
      embedText: (text) => this.embedText(actorId, text),
      embedImage: (content, contentType) => this.embedImage(actorId, content, contentType),
    };
  }

  async embedText(actorId: string, text: string): Promise<number[]> {
    this.assertEmbeddingAvailable();
    const model = this.configuration.embeddingModel;
    // assertEmbeddingAvailable establishes this invariant. Keep it local so a
    // future adapter cannot reserve a call without a configured model label.
    if (!model) throw new AppError(503, "ai_gateway_not_configured", "匹配素材没成：检索服务暂未准备好，请联系管理员处理。", false);
    const startedAt = this.now();
    const startedTick = performance.now();
    const reservation = await this.repository.reserve({
      actorId,
      purpose: "asset_match_embedding",
      provider: "ark",
      requestedModel: model,
      projectId: null,
      relatedObject: null,
      dailyLimit: this.configuration.dailyCallLimit,
      now: startedAt,
    });
    let vector: number[];
    try {
      vector = await this.embedding.embedText(text);
    } catch (error) {
      // Embedding adapters do not expose provider token accounting. Keep the
      // configured model and null token fields so the failed attempt stays
      // distinguishable from an unreserved request.
      await this.failReservation({
        id: reservation.id,
        errorCode: errorCode(error),
        model,
        inputTokens: null,
        outputTokens: null,
        durationMs: elapsedMilliseconds(startedTick),
        now: this.now(),
      });
      // Keep the typed vector-projection error intact so the retrieval layer
      // can switch to PostgreSQL rather than turning a recoverable index outage
      // into a user-facing failure.
      throw error;
    }
    try {
      await this.repository.complete({
        id: reservation.id,
        model,
        inputTokens: null,
        outputTokens: null,
        durationMs: elapsedMilliseconds(startedTick),
        now: this.now(),
      });
      return vector;
    } catch {
      await this.failReservation({
        id: reservation.id,
        errorCode: "audit_completion_failed",
        model,
        inputTokens: null,
        outputTokens: null,
        durationMs: elapsedMilliseconds(startedTick),
        now: this.now(),
      });
      throw auditUnavailableError();
    }
  }

  async embedImage(actorId: string, content: Buffer, contentType: string | null): Promise<number[]> {
    this.assertEmbeddingAvailable();
    const model = this.configuration.embeddingModel;
    if (!model) throw new AppError(503, "ai_gateway_not_configured", "image embedding not available", false);
    const startedAt = this.now();
    const startedTick = performance.now();
    const reservation = await this.repository.reserve({
      actorId,
      purpose: "asset_match_embedding",
      provider: "ark",
      requestedModel: model,
      projectId: null,
      relatedObject: null,
      dailyLimit: this.configuration.dailyCallLimit,
      now: startedAt,
    });
    let vector: number[];
    try {
      vector = await this.embedding.embedImage(content, contentType);
    } catch (error) {
      await this.failReservation({
        id: reservation.id,
        errorCode: errorCode(error),
        model,
        inputTokens: null,
        outputTokens: null,
        durationMs: elapsedMilliseconds(startedTick),
        now: this.now(),
      });
      throw error;
    }
    try {
      await this.repository.complete({
        id: reservation.id,
        model,
        inputTokens: null,
        outputTokens: null,
        durationMs: elapsedMilliseconds(startedTick),
        now: this.now(),
      });
      return vector;
    } catch {
      await this.failReservation({
        id: reservation.id,
        errorCode: "audit_completion_failed",
        model,
        inputTokens: null,
        outputTokens: null,
        durationMs: elapsedMilliseconds(startedTick),
        now: this.now(),
      });
      throw auditUnavailableError();
    }
  }

  private async failReservation(input: FailAiCallInput): Promise<void> {
    try {
      await this.repository.fail(input);
    } catch {
      // Do not falsely report the provider result when the durable audit row
      // cannot be closed. The still-running reservation continues to count
      // against the daily cap, which is safer than silently enabling retries.
      throw auditUnavailableError();
    }
  }

  private assertEnabledAndApiKey(): void {
    if (!this.configuration.enabled) {
      throw new AppError(503, "ai_gateway_disabled", "使用 AI 辅助没成：功能暂未开启，请联系管理员处理。", false);
    }
    if (!this.configuration.apiKeyConfigured) {
      throw new AppError(503, "ai_gateway_not_configured", "使用 AI 辅助没成：服务暂未准备好，请联系管理员处理。", false);
    }
  }

  private assertEmbeddingAvailable(): void {
    this.assertEnabledAndApiKey();
    if (this.configuration.embeddingApiKeyConfigured === false) {
      throw new AppError(503, "ai_gateway_not_configured", "匹配素材没成：检索服务暂未准备好，请联系管理员处理。", false);
    }
    if (!this.configuration.embeddingModel) {
      throw new AppError(503, "ai_gateway_not_configured", "匹配素材没成：检索服务暂未准备好，请联系管理员处理。", false);
    }
  }

  async complete(input: AiCompletionRequest): Promise<AiProviderCompletion> {
    return this.completeValidated(input, (completion) => completion);
  }

  /**
   * Keep the audit row running until the caller validates a structured model
   * result. A syntactically successful provider response is not a successful
   * production-assist result if it violates the product contract.
   */
  async completeValidated<T>(
    input: AiCompletionRequest,
    validate: (completion: AiProviderCompletion) => T | Promise<T>,
  ): Promise<T> {
    this.assertAvailable();
    // 用途模型是「没人挑的时候用哪个」,不是「只准用这个」:用户从目录里挑了
    // 火山没有的模型(kimi 这类),就该按它自己的通道走,而不是被打回。
    const model = input.model
      ?? this.configuration.purposeModels?.[input.purpose]
      ?? this.configuration.defaultModel;
    // `assertAvailable` establishes this invariant. Keep the check local so
    // TypeScript and future adapters cannot accidentally reserve an unlabelled
    // paid/accounted model call.
    if (!model) throw new AppError(503, "ai_gateway_not_configured", "使用 AI 辅助没成：服务暂未准备好，请联系管理员处理。", false);
    // 按解析出的这个模型查上限,而不是全局一个数;并且查在预留额度之前——
    // 超出能力的请求不该先消耗掉调用方当天的额度。
    assertOutputBudget(input.maxTokens, await this.maxOutputTokensFor(model));
    const startedAt = this.now();
    const reservation = await this.repository.reserve({
      actorId: input.actorId,
      purpose: input.purpose,
      provider: this.provider.providerForModel?.(model) ?? "ark",
      requestedModel: model,
      projectId: input.projectId ?? null,
      relatedObject: input.relatedObject ?? null,
      ...(input.executionFence ? { executionFence: input.executionFence } : {}),
      dailyLimit: this.configuration.dailyCallLimit,
      now: startedAt,
    });
    let completion: AiProviderCompletion | undefined;
    let result: T;
    try {
      completion = await this.provider.complete({
        system: input.system,
        prompt: input.prompt,
        model,
        ...(input.thinking ? { thinking: input.thinking } : {}),
        maxTokens: input.maxTokens,
        // 调用方传进来的 timeoutMs 一律作废:超时归网关按用途决定。
        ...(AI_PURPOSE_TIMEOUT_OVERRIDES[input.purpose] !== undefined
          ? { timeoutMs: AI_PURPOSE_TIMEOUT_OVERRIDES[input.purpose] }
          : {}),
      });
      result = await validate(completion);
    } catch (error) {
      await this.failReservation({
        id: reservation.id,
        errorCode: errorCode(error),
        ...(completion ? {
          model: completion.model,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
        } : {}),
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        now: this.now(),
      });
      if (error instanceof AiCompletionValidationError) throw error;
      throw publicAiError(error);
    }
    if (!completion) throw auditUnavailableError();
    try {
      await this.repository.complete({
        id: reservation.id,
        model: completion.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        durationMs: completion.durationMs,
        now: this.now(),
      });
      return result;
    } catch {
      await this.failReservation({
        id: reservation.id,
        errorCode: "audit_completion_failed",
        model: completion.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        now: this.now(),
      });
      throw auditUnavailableError();
    }
  }

  /**
   * 带工具表的一轮对话,与 completeValidated 共用同一套预留—记账—失败关账。
   * 工具调用轮次同样是一次真实的付费调用,必须一样进审计与每日限额。
   */
  async runToolTurn(input: AiCompletionRequest & {
    messages: AiConversationMessage[];
    tools: AiToolSpec[];
  }): Promise<AiProviderToolTurn> {
    this.assertAvailable();
    const model = this.modelForPurpose(input.purpose);
    if (!this.provider.completeToolTurn) {
      throw new AppError(
        503,
        "ai_tool_calling_unavailable",
        "使用 AI 辅助没成：当前模型通道还不支持这项功能，请联系管理员处理。",
        false,
      );
    }
    assertOutputBudget(input.maxTokens, await this.maxOutputTokensFor(model));
    const startedAt = this.now();
    const reservation = await this.repository.reserve({
      actorId: input.actorId,
      purpose: input.purpose,
      provider: this.provider.providerForModel?.(model) ?? "ark",
      requestedModel: model,
      projectId: input.projectId ?? null,
      relatedObject: input.relatedObject ?? null,
      ...(input.executionFence ? { executionFence: input.executionFence } : {}),
      dailyLimit: this.configuration.dailyCallLimit,
      now: startedAt,
    });
    let turn: AiProviderToolTurn;
    try {
      turn = await this.provider.completeToolTurn({
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        model,
        ...(input.thinking ? { thinking: input.thinking } : {}),
        maxTokens: input.maxTokens,
        ...(AI_PURPOSE_TIMEOUT_OVERRIDES[input.purpose] !== undefined
          ? { timeoutMs: AI_PURPOSE_TIMEOUT_OVERRIDES[input.purpose] }
          : {}),
      });
    } catch (error) {
      await this.failReservation({
        id: reservation.id,
        errorCode: errorCode(error),
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        now: this.now(),
      });
      throw publicAiError(error);
    }
    if (turn.unreadableToolCalls.length > 0) {
      // 落在这里是因为它是每一次工具轮次的必经之处。不落这条,上层只会看到
      // 「模型这一轮没调工具」,排查的人就会去改提示词、换模型,而真因是一条
      // 读不出的报文。片段已在适配层截断脱敏。
      console.warn("[ai-gateway] 供应商返回了读不出的工具入参", {
        purpose: input.purpose,
        model: turn.model,
        unreadable: turn.unreadableToolCalls.length,
        calls: turn.unreadableToolCalls.map((call) => ({ name: call.name, excerpt: call.argumentsExcerpt })),
      });
    }
    try {
      await this.repository.complete({
        id: reservation.id,
        model: turn.model,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        durationMs: turn.durationMs,
        now: this.now(),
      });
      return turn;
    } catch {
      await this.failReservation({
        id: reservation.id,
        errorCode: "audit_completion_failed",
        model: turn.model,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        now: this.now(),
      });
      throw auditUnavailableError();
    }
  }

  textCompletionPort(actorId: string): TextCompletionPort {
    return {
      completeText: async (prompt, system) => (await this.complete({
        actorId,
        purpose: "asset_match_query_understanding",
        prompt,
        system: system ?? "你只输出严格 JSON，不输出 Markdown，不输出解释。",
        thinking: "disabled",
        maxTokens: AI_ASSET_MATCH_QUERY_UNDERSTANDING_MAX_TOKENS,
      })).content,
    };
  }
}

export class AiProductionAssistService {
  constructor(
    private readonly gateway: AiGatewayService,
    private readonly assetMatcher: AssetMatchRetriever,
    private readonly access: AiProductionAssistAccessPort,
  ) {}

  listPromptModels(): { items: AiPromptModelOption[]; defaultKey: AiPromptModelKey } {
    return this.gateway.promptModelCatalog();
  }

  async createPromptDraft(actor: AiPromptDraftActor, input: PromptDraftInput): Promise<PromptDraftResult> {
    const projectActor = toAiPromptDraftActor(actor);
    assertPromptDraftInputBounds(input);
    if (input.projectId) await this.access.assertProjectCreate(projectActor, input.projectId);
    if (input.relatedObject) {
      if (!input.projectId) throw new BadRequestError("准备 AI 辅助没成：关联内容需要选择所属项目，请补充后再试。");
      await this.access.assertRelatedObjectAccess(projectActor, input.projectId, input.relatedObject);
    }
    const selectedAssets = await this.access.resolvePromptDraftAssets(projectActor.id, input.selectedAssets);
    const selectedModel = this.gateway.resolvePromptModel(input.modelKey, "quality");
    // 按目标媒介注入项目默认风格与生成模板（image=图片风格+图片模板，video=视频风格+
    // 视频模板），使 AI 优化/起草结果结合项目配置的对应媒介默认（与生成期 compileAutoPrompt
    // 同源：视频走 video_style_description/video 策略模板，图片走 image_style_description/图片模板）。
    // audio（对白/旁白）无项目风格/模板概念，不读取、不注入。
    const isAudio = input.mediaKind === "audio";
    const isVideo = input.mediaKind === "video";
    const projectStyle = !isAudio && input.projectId
      ? (isVideo
        ? await this.access.getProjectVideoStyle(input.projectId)
        : await this.access.getProjectImageStyle(input.projectId))
      : null;
    // 项目默认生成模板（image=projects.image_prompt_template → 图片媒介策略引用；
    // video=projects.video_prompt_template → 视频媒介策略引用 → 系统默认 DEFAULT_IMAGE/VIDEO_PROMPT_TEMPLATE）注入输入。
    // 模板原文的 {{占位符}} 用本请求的真实值渲染（与生成期 renderProjectPromptTemplate
    // 同源）：{{segment_content}}→生产意图，{{characters}}/{{props}}/{{references}}→已选资产，
    // {{style_description}}→项目默认风格，{{scene}} 等无值占位符所在行删除。
    const projectTemplate = !isAudio && input.projectId
      ? (isVideo
        ? await this.access.getProjectVideoTemplate(input.projectId)
        : await this.access.getProjectImageTemplate(input.projectId))
      : null;
    const visualStyle = input.creativeContext?.visualStyle ?? ((projectStyle?.styleDescription?.trim()) || undefined);
    const renderedTemplate = projectTemplate?.content
      ? renderPromptDraftTemplate(projectTemplate.content, {
        description: input.description,
        visualStyle,
        assets: selectedAssets,
      })
      : null;
    const system = promptDraftSystem(input.mediaKind);
    const prompt = promptDraftPrompt(input.description, selectedAssets, {
      name: input.name?.trim() || undefined,
      supplement: input.supplement,
      mediaKind: input.mediaKind,
      projectTemplate: renderedTemplate ?? undefined,
      creativeContext: {
        ...input.creativeContext,
        visualStyle,
      },
    });
    const supplementText = input.supplement?.trim() ?? "";
    // 诊断日志：分项输出本次喂给 AI 的输入是否引入项目默认风格 / 生成模板 /
    // 用户补充，并输出各自引入的内容（模板原文），用于定位「生成结果没结合风格模板与生成模板」。
    console.error(
      `[prompt-draft-input] actor=${projectActor.id} project=${input.projectId ?? "none"} mediaKind=${input.mediaKind} model=${selectedModel.key}\n` +
        `[prompt-draft-input] style: injected=${visualStyle ? "true" : "false"} content=${JSON.stringify(visualStyle ?? null)}\n` +
        `[prompt-draft-input] template: injected=${renderedTemplate ? "true" : "false"} source=${projectTemplate?.source ?? "none"}${projectTemplate?.missingTemplateId ? ` missingTemplateId=${projectTemplate.missingTemplateId}` : ""} rendered=${projectTemplate?.content ? "true" : "false"} content=${JSON.stringify(renderedTemplate)}\n` +
        `[prompt-draft-input] supplement: provided=${supplementText ? "true" : "false"} content=${JSON.stringify(supplementText)}\n` +
        `---- 最终传给模型的完整输入：下方 system 与 prompt 经网关原样透传 provider.complete，无截断、无包装 ----\n` +
        `---- SYSTEM ----\n${system}\n---- PROMPT ----\n${prompt}`,
    );
    const autoPrompt = await this.gateway.completeValidated({
      actorId: projectActor.id,
      purpose: "prompt_draft",
      system,
      prompt,
      projectId: input.projectId,
      relatedObject: input.relatedObject,
      model: selectedModel.model,
      thinking: "disabled",
      maxTokens: AI_PROMPT_DRAFT_MAX_TOKENS,
    }, (completion) => {
      const content = completion.content.trim();
      if (!content) {
        throw new AppError(502, "ai_invalid_response", "提示词草稿没整理好：结果暂时不可用，请稍后重试。", true);
      }
      return content;
    });
    return {
      autoPrompt,
      supplement: supplementText,
      promptText: [autoPrompt, supplementText].filter(Boolean).join("\n"),
      modelKey: selectedModel.key,
    };
  }

  async translatePrompt(actor: AiPromptDraftActor, input: PromptTranslationInput): Promise<PromptTranslationResult> {
    const projectActor = toAiPromptDraftActor(actor);
    assertPromptTranslationInputBounds(input);
    if (input.projectId) await this.access.assertProjectCreate(projectActor, input.projectId);
    if (input.relatedObject) {
      if (!input.projectId) throw new BadRequestError("准备 AI 辅助没成：关联内容需要选择所属项目，请补充后再试。");
      await this.access.assertRelatedObjectAccess(projectActor, input.projectId, input.relatedObject);
    }
    const selectedModel = this.gateway.resolvePromptModel(input.modelKey, "fast");
    const parsed = await this.gateway.completeValidated({
      actorId: projectActor.id,
      purpose: "prompt_translate",
      system: promptTranslateSystem(input.targetLanguage),
      prompt: promptTranslatePrompt(input.prompt, input.targetLanguage),
      projectId: input.projectId,
      relatedObject: input.relatedObject,
      model: selectedModel.model,
      thinking: "disabled",
      maxTokens: AI_PROMPT_TRANSLATE_MAX_TOKENS,
    }, (completion) => parseStructured(promptTranslationSchema, completion.content, "提示词翻译"));
    const translation = {
      auto: parsed.auto,
      supplement: parsed.supplement,
    };
    return {
      translation,
      promptText: [translation.auto, translation.supplement].filter((value) => value.trim()).join("\n"),
      modelKey: selectedModel.key,
    };
  }

  async matchAssets(actorId: string, description: string): Promise<AssetMatchResult> {
    assertAssetMatchDescriptionBounds(description);
    // Check the gate before touching the asset index. A closed AI gateway must
    // not look like a successful recommendation request with hidden work.
    this.gateway.assertAvailable();
    const retrieval = await this.assetMatcher.retrieve(actorId, description);
    // Recheck before passing any candidate metadata to an external provider.
    const visibleCandidates = await this.access.filterVisibleCandidates(actorId, retrieval.candidates);
    if (!visibleCandidates.length) {
      return {
        items: [],
        count: 0,
        retrievalMode: retrieval.retrievalMode,
        empty: true,
        emptyMessage: "当前可见资产库中没有与这段素材匹配的资产；请先入库或换个描述后重试。",
      };
    }
    const items = await this.gateway.completeValidated({
      actorId,
      purpose: "asset_match_rerank",
      system: assetMatchRerankSystem(),
      prompt: assetMatchRerankPrompt(description, visibleCandidates),
      thinking: "disabled",
      maxTokens: AI_ASSET_MATCH_RERANK_MAX_TOKENS,
    }, async (completion) => {
      const ranked = parseStructured(assetMatchRerankSchema, completion.content, "资产匹配");
      return this.toVisibleAssetMatchItems(actorId, visibleCandidates, ranked.items);
    });
    return {
      items,
      count: items.length,
      retrievalMode: retrieval.retrievalMode,
      empty: items.length === 0,
      ...(items.length === 0 ? { emptyMessage: "AI 未从当前候选中找到合适资产；请补充描述或调整资产库。" } : {}),
    };
  }

  private async toVisibleAssetMatchItems(
    actorId: string,
    candidates: AssetMatchCandidate[],
    rankedItems: Array<{ candidate_id: string; reason: string }>,
  ): Promise<AssetMatchItem[]> {
    const allowed = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const seen = new Set<string>();
    const selected = rankedItems.map((item) => {
      if (seen.has(item.candidate_id)) {
        throw new AppError(502, "ai_invalid_response", "匹配素材没成：这次推荐结果不完整，请稍后重试。", true);
      }
      seen.add(item.candidate_id);
      const candidate = allowed.get(item.candidate_id);
      if (!candidate) {
        throw new AppError(502, "ai_invalid_response", "匹配素材没成：这次推荐结果不完整，请稍后重试。", true);
      }
      const { candidateId: _candidateId, ...output } = candidate;
      return { candidate, output: { ...output, reason: item.reason } satisfies AssetMatchItem };
    });
    const stillVisible = await this.access.filterVisibleCandidates(actorId, selected.map((item) => item.candidate));
    const visibleByCandidateId = new Set(stillVisible.map((item) => item.candidateId));
    return selected
      .filter((item) => visibleByCandidateId.has(item.candidate.candidateId))
      .map((item) => item.output);
  }
}

/**
 * Recalls a bounded, permission-filtered candidate set before the separately
 * audited rerank. PostgreSQL remains authoritative; Milvus is a rebuildable
 * projection and any embedding call is supplied by the audited gateway.
 */
export class DatabaseAssetMatchRetriever implements AssetMatchRetriever {
  constructor(
    private readonly db: Database,
    private readonly dependencies: {
      hybridSearch?: Pick<HybridAssetSearchService, "search">;
      /** Test seam for HybridAssetSearchService; production gets the
       * embedding client through `embeddingForActor` below. */
      createHybridSearch?: (actorId: string, embedding: EmbeddingClient) => Pick<HybridAssetSearchService, "search">;
      /** Must be backed by AiGatewayService.embeddingClient in production. */
      embeddingForActor?: (actorId: string) => EmbeddingClient;
    } = {},
  ) {}

  async retrieve(actorId: string, description: string): Promise<{ candidates: AssetMatchCandidate[]; retrievalMode: "hybrid" | "structured_fallback" }> {
    const search = this.resolveHybridSearch(actorId);
    const recall = await search.search({
      actorId,
      query: description,
      page: 1,
      pageSize: MAX_ASSET_MATCH_CANDIDATES,
    });
    const mode = recall.diagnostics.semanticAvailable ? "hybrid" : "structured_fallback";
    return {
      candidates: await this.toCandidates(actorId, recall.items),
      retrievalMode: mode,
    };
  }

  private resolveHybridSearch(actorId: string): Pick<HybridAssetSearchService, "search"> {
    if (this.dependencies.hybridSearch) return this.dependencies.hybridSearch;
    const embedding = this.dependencies.embeddingForActor?.(actorId);
    if (!embedding) {
      throw new Error("AI 资产匹配缺少受审计的向量调用适配器");
    }
    if (this.dependencies.createHybridSearch) {
      return this.dependencies.createHybridSearch(actorId, embedding);
    }
    return new HybridAssetSearchService(this.db, {
      embedding,
    });
  }

  private async toCandidates(actorId: string, items: AssetSearchItem[]): Promise<AssetMatchCandidate[]> {
    const entityIds = [...new Set(items.map((item) => item.sourceTable === "asset_entities"
      ? item.sourceId
      : item.parentEntityId).filter((value): value is string => Boolean(value)))];
    const variantIds = [...new Set(items.filter((item) => item.sourceTable === "asset_variants").map((item) => item.sourceId))];
    if (!entityIds.length) return [];
    const [entities, variants] = await Promise.all([
      this.db.select().from(assetEntities).where(and(inArray(assetEntities.id, entityIds), isNull(assetEntities.deletedAt))),
      variantIds.length
        ? this.db.select().from(assetVariants).where(and(inArray(assetVariants.id, variantIds), isNull(assetVariants.deletedAt)))
        : Promise.resolve([]),
    ]);
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const variantById = new Map(variants.map((variant) => [variant.id, variant]));
    const candidates: AssetMatchCandidate[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const assetId = item.sourceTable === "asset_entities" ? item.sourceId : item.parentEntityId;
      if (!assetId) continue;
      const entity = entityById.get(assetId);
      if (!entity || (entity.visibility !== "common" && entity.ownerUserId !== actorId)) continue;
      const variant = item.sourceTable === "asset_variants" ? variantById.get(item.sourceId) : undefined;
      if (item.sourceTable === "asset_variants" && (!variant || variant.assetEntityId !== entity.id)) continue;
      const candidateId = `${item.sourceTable}:${item.sourceId}`;
      if (seen.has(candidateId)) continue;
      seen.add(candidateId);
      candidates.push({
        candidateId,
        assetId: entity.id,
        assetVariantId: variant?.id ?? null,
        assetKind: entity.assetKind,
        role: entity.role,
        usageMode: entity.usageMode ?? "reference",
        name: variant?.name ?? entity.displayName ?? entity.name,
        description: compactDescription(variant?.description ?? item.description ?? entity.intro ?? entity.appearance),
      });
      if (candidates.length >= MAX_ASSET_MATCH_CANDIDATES) break;
    }
    return candidates;
  }
}

/**
 * Fresh authorization reads for the small set of facts used by production
 * assistance. They intentionally happen after retrieval (and, for reranking,
 * after the model response) so a deletion or visibility change cannot leak a
 * stale candidate through an in-flight request.
 */
type AiPromptDraftActor = string | ProjectAccessActor;

type AiProjectAccessPort = Pick<ProjectAccessService, "require">;

export class DatabaseAiProductionAssistAccess implements AiProductionAssistAccessPort {
  constructor(
    private readonly db: Database,
    private readonly projectAccess: AiProjectAccessPort = ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
  ) {}

  async assertProjectCreate(actor: ProjectAccessActor, projectId: string): Promise<void> {
    await this.projectAccess.require(actor, projectId, "create");
  }

  async getProjectImageStyle(projectId: string): Promise<{ styleDescription: string | null } | null> {
    const rows = await this.db.select({ imageStyleDescription: projects.imageStyleDescription })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!rows[0]) return null;
    return { styleDescription: rows[0].imageStyleDescription };
  }

  async getProjectImageTemplate(projectId: string): Promise<PromptTemplateContext | null> {
    // 真源 1：projects.image_prompt_template（完整版「项目设置→图片生成模板」文本列，
    // 生成期 resolveProjectGenerationConfig 同源读取）。项目不存在时直接返回 null。
    const projectRows = await this.db.select({ imagePromptTemplate: projects.imagePromptTemplate })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const project = projectRows[0];
    if (!project) return null;
    const direct = project.imagePromptTemplate?.trim();
    if (direct) return { source: "project", content: direct };
    // 真源 2：Lite 模型默认 → 图片媒介策略 parameters.prompt_template_id → 模板库内容。
    const strategies = await this.db.select({ parameters: generationDefaultStrategies.parameters })
      .from(generationDefaultStrategies)
      .where(and(
        eq(generationDefaultStrategies.projectId, projectId),
        eq(generationDefaultStrategies.mediaKind, "image"),
      ))
      .limit(1);
    const strategy = strategies[0];
    if (!strategy) return { source: "system_default", content: await this.resolvePlatformDefaultImageTemplate() };
    const templateId = typeof strategy.parameters?.prompt_template_id === "string"
      && strategy.parameters.prompt_template_id.length > 0
      ? strategy.parameters.prompt_template_id
      : null;
    if (!templateId) return { source: "system_default", content: await this.resolvePlatformDefaultImageTemplate() };
    const templates = await this.db.select({ content: promptTemplates.content })
      .from(promptTemplates)
      .where(and(
        eq(promptTemplates.id, templateId),
        eq(promptTemplates.projectId, projectId),
        eq(promptTemplates.mediaKind, "image"),
        isNull(promptTemplates.deletedAt),
      ))
      .limit(1);
    if (!templates[0]) return { source: "system_default", content: await this.resolvePlatformDefaultImageTemplate(), missingTemplateId: templateId };
    return { source: "template", content: templates[0].content };
  }

  /** 平台默认图片模板（迁移 064 播种的 prompt_default_templates，即「系统模板」）：缺行时回落代码常量。 */
  private async resolvePlatformDefaultImageTemplate(): Promise<string> {
    const rows = await this.db.select({ content: promptDefaultTemplates.content })
      .from(promptDefaultTemplates)
      .where(eq(promptDefaultTemplates.mediaKind, "image"))
      .limit(1);
    return rows[0]?.content ?? DEFAULT_IMAGE_PROMPT_TEMPLATE;
  }

  /** 项目默认视频风格（projects.video_style_description），供视频提示词草稿注入项目视频风格。 */
  async getProjectVideoStyle(projectId: string): Promise<{ styleDescription: string | null } | null> {
    const rows = await this.db.select({ videoStyleDescription: projects.videoStyleDescription })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!rows[0]) return null;
    return { styleDescription: rows[0].videoStyleDescription };
  }

  /** 项目默认视频生成模板：真源 1 projects.video_prompt_template；真源 2 video 媒介策略
      parameters.prompt_template_id → 模板库(video)；回落平台视频系统模板/代码常量。 */
  async getProjectVideoTemplate(projectId: string): Promise<PromptTemplateContext | null> {
    const projectRows = await this.db.select({ videoPromptTemplate: projects.videoPromptTemplate })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const project = projectRows[0];
    if (!project) return null;
    const direct = project.videoPromptTemplate?.trim();
    if (direct) return { source: "project", content: direct };
    const strategies = await this.db.select({ parameters: generationDefaultStrategies.parameters })
      .from(generationDefaultStrategies)
      .where(and(
        eq(generationDefaultStrategies.projectId, projectId),
        eq(generationDefaultStrategies.mediaKind, "video"),
      ))
      .limit(1);
    const strategy = strategies[0];
    if (!strategy) return { source: "system_default", content: await this.resolvePlatformDefaultVideoTemplate() };
    const templateId = typeof strategy.parameters?.prompt_template_id === "string"
      && strategy.parameters.prompt_template_id.length > 0
      ? strategy.parameters.prompt_template_id
      : null;
    if (!templateId) return { source: "system_default", content: await this.resolvePlatformDefaultVideoTemplate() };
    const templates = await this.db.select({ content: promptTemplates.content })
      .from(promptTemplates)
      .where(and(
        eq(promptTemplates.id, templateId),
        eq(promptTemplates.projectId, projectId),
        eq(promptTemplates.mediaKind, "video"),
        isNull(promptTemplates.deletedAt),
      ))
      .limit(1);
    if (!templates[0]) return { source: "system_default", content: await this.resolvePlatformDefaultVideoTemplate(), missingTemplateId: templateId };
    return { source: "template", content: templates[0].content };
  }

  /** 平台默认视频模板（prompt_default_templates 视频系统模板）：缺行时回落代码常量。 */
  private async resolvePlatformDefaultVideoTemplate(): Promise<string> {
    const rows = await this.db.select({ content: promptDefaultTemplates.content })
      .from(promptDefaultTemplates)
      .where(eq(promptDefaultTemplates.mediaKind, "video"))
      .limit(1);
    return rows[0]?.content ?? DEFAULT_VIDEO_PROMPT_TEMPLATE;
  }

  async filterVisibleCandidates(actorId: string, candidates: AssetMatchCandidate[]): Promise<AssetMatchCandidate[]> {
    const entityIds = [...new Set(candidates.map((candidate) => candidate.assetId))];
    if (!entityIds.length) return [];
    const variantIds = [...new Set(candidates
      .map((candidate) => candidate.assetVariantId)
      .filter((value): value is string => Boolean(value)))];
    const [entities, variants] = await Promise.all([
      this.db.select({
        id: assetEntities.id,
      }).from(assetEntities).where(and(
        inArray(assetEntities.id, entityIds),
        isNull(assetEntities.deletedAt),
        or(
          eq(assetEntities.visibility, "common"),
          eq(assetEntities.ownerUserId, actorId),
        ),
      )),
      variantIds.length
        ? this.db.select({ id: assetVariants.id, assetEntityId: assetVariants.assetEntityId }).from(assetVariants).where(and(
          inArray(assetVariants.id, variantIds),
          isNull(assetVariants.deletedAt),
        ))
        : Promise.resolve([]),
    ]);
    const visibleEntityIds = new Set(entities.map((entity) => entity.id));
    const visibleVariants = new Map(variants.map((variant) => [variant.id, variant.assetEntityId]));
    return candidates.filter((candidate) => visibleEntityIds.has(candidate.assetId)
      && (!candidate.assetVariantId || visibleVariants.get(candidate.assetVariantId) === candidate.assetId));
  }

  async assertRelatedObjectAccess(_actor: ProjectAccessActor, projectId: string, relatedObject: AiRelatedObject): Promise<void> {
    if (relatedObject.type === "project") {
      if (relatedObject.id !== projectId) throw new BadRequestError("准备 AI 辅助没成：关联内容不属于当前项目，请重新选择。");
      return;
    }
    const belongsToProject = await this.relatedObjectBelongsToProject(projectId, relatedObject);
    if (!belongsToProject) {
      throw new NotFoundError(relatedObjectNotFoundMessage(relatedObject.type));
    }
  }

  async resolvePromptDraftAssets(actorId: string, assets: import("./types.js").PromptDraftAssetContext[]): Promise<import("./types.js").PromptDraftAssetContext[]> {
    if (!assets.length) return [];
    const ids = [...new Set(assets.map((asset) => asset.assetId))];
    const rows = await this.db.select().from(assetEntities).where(and(
      inArray(assetEntities.id, ids),
      isNull(assetEntities.deletedAt),
      or(eq(assetEntities.visibility, "common"), eq(assetEntities.ownerUserId, actorId)),
    ));
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (byId.size !== ids.length) throw new NotFoundError("准备 AI 辅助没成：有素材不存在、已删除或无权使用，请重新选择。");
    return assets.map((asset) => {
      const row = byId.get(asset.assetId)!;
      return {
        assetId: row.id,
        name: row.displayName ?? row.name,
        type: row.assetKind,
        description: compactDescription(row.intro ?? row.appearance),
        usageMode: row.usageMode ?? "reference",
      };
    });
  }

  private async relatedObjectBelongsToProject(projectId: string, relatedObject: AiRelatedObject): Promise<boolean> {
    switch (relatedObject.type) {
      case "shot": {
        const rows = await this.db.select({ id: shots.id }).from(shots)
          .innerJoin(episodes, eq(shots.episodeId, episodes.id))
          .innerJoin(projects, eq(episodes.projectId, projects.id))
          .where(and(
            eq(shots.id, relatedObject.id),
            eq(projects.id, projectId),
            isNull(shots.deletedAt),
            isNull(episodes.deletedAt),
            isNull(projects.deletedAt),
          ))
          .limit(1);
        return Boolean(rows[0]);
      }
      case "scene": {
        const rows = await this.db.select({ id: scenes.id }).from(scenes)
          .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
          .innerJoin(projects, eq(episodes.projectId, projects.id))
          .where(and(
            eq(scenes.id, relatedObject.id),
            eq(projects.id, projectId),
            isNull(scenes.deletedAt),
            isNull(episodes.deletedAt),
            isNull(projects.deletedAt),
          ))
          .limit(1);
        return Boolean(rows[0]);
      }
      case "asset": {
        const rows = await this.db.select({ id: projectAssetRefs.id }).from(projectAssetRefs)
          .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
          .where(and(
            eq(projectAssetRefs.projectId, projectId),
            eq(projectAssetRefs.assetEntityId, relatedObject.id),
            isNull(projectAssetRefs.deletedAt),
            isNull(assetEntities.deletedAt),
          ))
          .limit(1);
        return Boolean(rows[0]);
      }
      default:
        throw new BadRequestError("准备 AI 辅助没成：关联内容类型不支持，请重新选择。");
    }
  }
}

export function createAiGatewayService(db: Database): AiGatewayService {
  const configuration = aiGatewayConfiguration();
  const completionProvider = new RoutedAiCompletionProvider(
    textCompletionRoutes(settings),
    { companyProviderAllowlist: settings.companyProviderAllowlist },
  );
  const gateway = new AiGatewayService(
    new DrizzleAiCallRepository(db),
    completionProvider,
    configuration,
    undefined,
    undefined,
    new ModelCapabilityLookup(new DrizzleModelCapabilityStore(db)),
  );
  return gateway;
}

/**
 * 路由表和模型目录用同一份 textModelRoutes 生成,所以目录里能选到的模型
 * 一定有通道可走,同一个模型也不会被两个通道同时认领。
 */
export function textCompletionRoutes(source: Settings): AiCompletionRoute[] {
  const routes = textModelRoutes(source);
  const arkModels = routes.filter((route) => route.providerId === "ark").map((route) => route.model);
  const colModels = routes.filter((route) => route.providerId === "col").map((route) => route.model);
  return [
    ...(arkModels.length
      ? [{ providerId: "ark" as const, models: arkModels, adapter: new ArkAiCompletionProvider() }]
      : []),
    ...(colModels.length
      ? [{
          providerId: "col" as const,
          models: colModels,
          adapter: new ColCompletionProvider(
            source.colApiKey,
            source.colPromptDraftModel,
            source.colBaseUrl,
          ),
        }]
      : []),
  ];
}

export function createAiProductionAssistService(db: Database): AiProductionAssistService {
  const gateway = createAiGatewayService(db);
  return new AiProductionAssistService(
    gateway,
    new DatabaseAssetMatchRetriever(db, {
      embeddingForActor: (actorId) => gateway.embeddingClient(actorId),
    }),
    new DatabaseAiProductionAssistAccess(db),
  );
}

/**
 * HTTP callers provide an authenticated user, while a few in-process callers
 * still provide just an id. Treat the latter as a normal member so old code
 * cannot accidentally acquire an admin/operator project grant.
 */
export function toAiPromptDraftActor(input: AiPromptDraftActor): ProjectAccessActor {
  if (typeof input === "string") return { id: input, role: "member" };
  return { id: input.id, role: platformRoleOrMember(input.role) };
}

function relatedObjectNotFoundMessage(type: string): string {
  switch (type) {
    case "shot":
      return "分镜不存在或不属于当前项目";
    case "scene":
      return "场不存在或不属于当前项目";
    case "asset":
      return "资产不存在或未加入当前项目";
    default:
      return "关联对象不存在或不属于当前项目";
  }
}

function parseStructured<T extends z.ZodType>(schema: T, content: string, name: string): z.infer<T> {
  try {
    const parsed = schema.safeParse(parseJsonValue(content));
    if (parsed.success) return parsed.data;
  } catch {
    // The public error below intentionally does not echo a model response.
  }
  throw new AppError(502, "ai_invalid_response", `${name}没整理好：结果暂时不可用，请稍后重试。`, true);
}

function compactDescription(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 1_000) : null;
}

function elapsedMilliseconds(startedTick: number): number {
  return Math.max(0, Math.round(performance.now() - startedTick));
}

function auditUnavailableError(): AppError {
  return new AppError(
    503,
    "ai_audit_unavailable",
    "AI 辅助没成：本次记录未能保存，请联系管理员核对后再试。",
    false,
  );
}

/**
 * 输出预算的合法性分两层。
 *
 * 第一层是形状:必须是正整数。0/负数/小数不是「能力不够」,是参数写错了。
 *
 * 第二层是能力:上限来自模型自己在 model_capabilities 表里登记的
 * max_output_tokens。改造前这里写死 `> 2_048` 一律 400——剧本拆解一场戏要出
 * 20+ 个结构化镜头,输出必然超过 2048,连供应商都到不了就被自家网关拒了。
 */
function assertOutputBudget(maxTokens: number, modelMaxOutputTokens: number): void {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > modelMaxOutputTokens) {
    throw new BadRequestError("生成提示词没成：输出长度设置不对，请修改后再试。");
  }
}

function assertPromptDraftInputBounds(input: PromptDraftInput): void {
  assertBoundedText(input.description, "提示词描述", AI_PROMPT_DRAFT_MAX_DESCRIPTION_CHARS);
  if (input.selectedAssets.length > AI_PROMPT_DRAFT_MAX_SELECTED_ASSETS) {
    throw new BadRequestError(`生成提示词没成：一次最多选择 ${AI_PROMPT_DRAFT_MAX_SELECTED_ASSETS} 个素材，请减少后再试。`);
  }
  for (const asset of input.selectedAssets) {
    if (!asset.assetId.trim()) throw new BadRequestError("生成提示词没成：所选素材信息不完整，请重新选择。");
  }
  if (input.supplement !== undefined) {
    assertMaximumText(input.supplement, "用户补充", AI_PROMPT_DRAFT_MAX_SUPPLEMENT_CHARS);
  }
  if (input.name !== undefined) {
    assertMaximumText(input.name, "资产名称", AI_PROMPT_DRAFT_MAX_NAME_CHARS);
  }
  const creativeParts = [
    input.creativeContext?.visualStyle ?? "",
    input.creativeContext?.cameraDirection ?? "",
    ...(input.creativeContext?.referenceNotes ?? []),
  ];
  if (creativeParts.reduce((sum, value) => sum + value.length, 0) > AI_PROMPT_DRAFT_MAX_CREATIVE_CONTEXT_CHARS) {
    throw new BadRequestError(`生成提示词没成：创作说明不能超过 ${AI_PROMPT_DRAFT_MAX_CREATIVE_CONTEXT_CHARS} 个字符，请缩短后再试。`);
  }
}

function assertPromptTranslationInputBounds(input: PromptTranslationInput): void {
  assertBoundedText(input.prompt.auto, "自动提示词", AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS);
  assertMaximumText(input.prompt.supplement, "用户补充", AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS);
}

function assertAssetMatchDescriptionBounds(description: string): void {
  assertBoundedText(description, "资产匹配描述", AI_ASSET_MATCH_MAX_DESCRIPTION_CHARS);
}

function assertBoundedText(value: string, label: string, maximum: number): void {
  if (!value.trim()) throw new BadRequestError(`提交没成：${label}没填，请补充后再试。`);
  if (value.length > maximum) throw new BadRequestError(`提交没成：${label}过长，请缩短到 ${maximum} 个字符以内后再试。`);
}

function assertMaximumText(value: string, label: string, maximum: number): void {
  if (value.length > maximum) throw new BadRequestError(`提交没成：${label}过长，请缩短到 ${maximum} 个字符以内后再试。`);
}

function errorCode(error: unknown): string {
  if (error instanceof AiCompletionValidationError) return error.code;
  if (error instanceof ColCompletionTimeoutError) return "provider_timeout";
  if (error instanceof ProviderTransportError && error.transportFailure === "timeout") return "provider_timeout";
  if (error instanceof AppError) return error.code;
  if (error instanceof ExternalServiceError) return error.code;
  return "provider_error";
}

function publicAiError(error: unknown): unknown {
  if (error instanceof AppError && !(error instanceof ExternalServiceError)) return error;
  if (error instanceof ColCompletionTimeoutError
    || (error instanceof ProviderTransportError && error.transportFailure === "timeout")) {
    return new AppError(
      504,
      "ai_request_timeout",
      "AI 处理超时了，这次没有完成，请稍后重试。",
      true,
    );
  }
  const publicError = new AppError(
    502,
    "ai_service_unavailable",
    "AI 暂时没有完成这次处理，请稍后重试。",
    true,
  );
  (publicError as Error & { cause?: unknown }).cause = error;
  return publicError;
}
