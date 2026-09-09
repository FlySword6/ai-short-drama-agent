import type { ProjectAccessActor } from "../project-access/types.js";

export const aiPurposes = [
  "prompt_draft",
  "asset_match_query_understanding",
  "asset_search_tokenize",
  "asset_match_embedding",
  "asset_match_rerank",
  "prompt_translate",
  "script_breakdown",
  "script_breakdown_enrich",
  "script_breakdown_storyboard",
  "generation_orchestration",
  "grill_eval",
  "grill_clarify",
  "grill_candidate",
  "grill_absorb",
  "variant_match_suggest",
] as const;

export type AiPurpose = typeof aiPurposes[number];
export type AiCallStatus = "running" | "succeeded" | "failed";

/**
 * Bounded user input and output budgets for the two V0.2 production-assist
 * calls. These are deliberately character/token caps rather than a pricing
 * policy: the gateway still owns daily attempt limits and later billing.
 *
 * 2026-08-07 输出上限动态化时逐个复核过下面四个 *_MAX_TOKENS,结论是**不动**:
 * 它们是「这个用途只需要这么多」的业务判断,不是能力上限。判据是输出形状本身
 * 有界——prompt_draft 是 5 个固定字段、translate 是 2 个固定段、rerank 最多 8 条
 * (MAX_ASSET_MATCH_RESULTS)、query_understanding 是一个小结构。把它们抬到模型
 * 最大值不会让结果更好,只会让一次失控输出的成本与超时按整档算。
 *
 * 真正的能力上限归网关:assertOutputBudget 按 model_capabilities 表判断,
 * 这四个数只要落在当前模型能力内就照用。
 */
export const AI_PROMPT_DRAFT_MAX_DESCRIPTION_CHARS = 4_000;
export const AI_PROMPT_DRAFT_MAX_NAME_CHARS = 200;
export const AI_PROMPT_DRAFT_MAX_SELECTED_ASSETS = 12;
export const AI_PROMPT_DRAFT_MAX_ASSET_DESCRIPTION_CHARS = 1_000;
export const AI_PROMPT_DRAFT_MAX_ASSET_CONTEXT_CHARS = 6_000;
export const AI_PROMPT_DRAFT_MAX_SUPPLEMENT_CHARS = 4_000;
export const AI_PROMPT_DRAFT_MAX_CREATIVE_CONTEXT_CHARS = 4_000;
export const AI_ASSET_MATCH_MAX_DESCRIPTION_CHARS = 2_000;
export const AI_PROMPT_DRAFT_MAX_TOKENS = 1_800;
export const AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS = 12_000;
export const AI_PROMPT_TRANSLATE_MAX_TOKENS = 2_000;
export const AI_ASSET_MATCH_RERANK_MAX_TOKENS = 500;
export const AI_ASSET_MATCH_QUERY_UNDERSTANDING_MAX_TOKENS = 500;

export const aiPromptModelKeys = ["quality", "fast"] as const;
export const AI_PROMPT_MODEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,127}$/;
/** Server-issued catalogue key. Provider model IDs are never accepted from clients. */
export type AiPromptModelKey = string;

export interface AiPromptModelOption {
  key: AiPromptModelKey;
  displayName: string;
  description: string;
  available: boolean;
  isDefault: boolean;
  providerLabel?: string;
  modelLabel?: string;
  officialPriceSource?: string;
  inputPriceYuanPerMillionTokens?: number;
  outputPriceYuanPerMillionTokens?: number;
}

export interface AiRelatedObject {
  type: string;
  id: string;
}

export interface AiExecutionFence {
  type: "script_breakdown_run";
  runId: string;
  token: string;
}

export type AiThinkingMode = "enabled" | "disabled" | "auto";

export interface AiCompletionRequest {
  actorId: string;
  purpose: AiPurpose;
  system: string;
  prompt: string;
  projectId?: string;
  /**
   * Opaque audit label only. It is never used to authorize a request: callers
   * that associate a call with project content must also provide `projectId`,
   * whose ownership is checked by the production-assist service.
   */
  relatedObject?: AiRelatedObject;
  /** Atomically checked before a paid call is reserved. */
  executionFence?: AiExecutionFence;
  model?: string;
  /** Structured/latency-sensitive callers can explicitly disable deep thinking. */
  thinking?: AiThinkingMode;
  maxTokens: number;
  /**
   * 调用方不许自己给:请求超时由网关按用途决定
   * (AI_PURPOSE_TIMEOUT_OVERRIDES)。字段留在请求上是因为网关内部
   * 组装 provider 调用时要带它;业务侧传了也会被网关覆盖。
   */
  timeoutMs?: number;
}

export interface AiProviderCompletion {
  content: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

/**
 * Internal structured-output validation failure. Provider content stays in a
 * private field so logs/JSON serialization cannot accidentally persist it.
 */
export class AiCompletionValidationError extends Error {
  readonly code: string;
  #providerCompletion: AiProviderCompletion;

  constructor(
    code: string,
    message: string,
    providerCompletion: AiProviderCompletion,
  ) {
    super(message);
    this.name = "AiCompletionValidationError";
    this.code = code;
    this.#providerCompletion = providerCompletion;
  }

  completion(): AiProviderCompletion {
    return this.#providerCompletion;
  }
}

export interface AiCompletionProvider {
  complete(input: {
    system: string;
    prompt: string;
    model?: string;
    thinking?: AiThinkingMode;
    maxTokens: number;
    /** 网关按用途解析后的单次请求超时;适配器验完结构上限后生效。 */
    timeoutMs?: number;
    /** Gateway adapters require these to reserve and audit the call. */
    actorId?: string;
    purpose?: AiPurpose;
    projectId?: string;
  }): Promise<AiProviderCompletion>;
  /** Gateway-backed adapters already reserve and settle their own audit row. */
  handlesAudit?: boolean;
  /** 带工具表的一轮对话。只有支持工具调用的适配器实现它。 */
  completeToolTurn?(input: AiToolTurnRequest): Promise<AiProviderToolTurn>;
  /** Optional audit router; legacy single-provider adapters default to Ark. */
  providerForModel?(model: string): string;
}

export interface AiCallReservation {
  id: string;
}

export interface ReserveAiCallInput {
  actorId: string;
  purpose: AiPurpose;
  provider: string;
  requestedModel: string;
  projectId: string | null;
  relatedObject: AiRelatedObject | null;
  executionFence?: AiExecutionFence;
  dailyLimit: number;
  now: Date;
}

export interface CompleteAiCallInput {
  id: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  now: Date;
}

export interface FailAiCallInput {
  id: string;
  errorCode: string;
  /** Provider usage is still useful when its response fails our JSON contract. */
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs: number;
  now: Date;
}

/**
 * This is the durable boundary between request orchestration and the formal
 * audit ledger. `reserve` counts every real provider attempt, including calls
 * that later fail, so a retry cannot silently bypass the daily guardrail.
 */
export interface AiCallRepository {
  reserve(input: ReserveAiCallInput): Promise<AiCallReservation>;
  complete(input: CompleteAiCallInput): Promise<void>;
  fail(input: FailAiCallInput): Promise<void>;
}

export interface PromptDraftAssetContext {
  assetId: string;
  name: string;
  type?: string | null;
  description?: string | null;
  usageMode?: string | null;
}

export interface PromptDraftInput {
  /** 要生成的资产/分镜名称（前端弹窗「名称」输入框，独立传给模型以醒目标注）。 */
  name?: string;
  /** 目标媒介：决定注入项目默认风格/生成模板的取值分支（image=图片风格+图片模板，video=视频风格+视频模板，audio=无风格/模板概念）与成文文案（生图/生视频/对白旁白写手）。 */
  mediaKind: "image" | "video" | "audio";
  description: string;
  selectedAssets: PromptDraftAssetContext[];
  supplement?: string;
  creativeContext?: {
    visualStyle?: string;
    cameraDirection?: string;
    referenceNotes?: string[];
  };
  modelKey?: AiPromptModelKey;
  projectId?: string;
  relatedObject?: AiRelatedObject;
}

export interface PromptDraftResult {
  autoPrompt: string;
  supplement: string;
  promptText: string;
  modelKey: AiPromptModelKey;
}

export interface PromptTranslationInput {
  prompt: {
    auto: string;
    supplement: string;
  };
  targetLanguage: "zh" | "en";
  modelKey?: AiPromptModelKey;
  projectId?: string;
  relatedObject?: AiRelatedObject;
}

export interface PromptTranslationResult {
  translation: {
    auto: string;
    supplement: string;
  };
  promptText: string;
  modelKey: AiPromptModelKey;
}

export interface AssetMatchCandidate {
  candidateId: string;
  assetId: string;
  assetVariantId: string | null;
  assetKind: string | null;
  role: string | null;
  usageMode: string | null;
  name: string;
  description: string | null;
}

export interface AssetMatchRetrieval {
  candidates: AssetMatchCandidate[];
  retrievalMode: "hybrid" | "structured_fallback";
}

export interface AssetMatchRetriever {
  retrieve(actorId: string, description: string): Promise<AssetMatchRetrieval>;
}

/**
 * Reads only the authorization facts that AI production assistance needs.
 * Keeping this port below HTTP makes the service independently testable and
 * prevents stale retrieval candidates from bypassing the current DB state.
 */
export interface AiProductionAssistAccessPort {
  /**
   * A prompt draft that carries project context can influence project
   * production decisions, so it uses the same creative permission as other
   * project-scoped drafting work. The complete actor is required here: a bare
   * user id would silently discard a platform-admin grant.
   */
  assertProjectCreate(actor: ProjectAccessActor, projectId: string): Promise<void>;
  assertRelatedObjectAccess(actor: ProjectAccessActor, projectId: string, relatedObject: AiRelatedObject): Promise<void>;
  resolvePromptDraftAssets(actorId: string, assets: PromptDraftAssetContext[]): Promise<PromptDraftAssetContext[]>;
  filterVisibleCandidates(actorId: string, candidates: AssetMatchCandidate[]): Promise<AssetMatchCandidate[]>;
  /**
   * 项目默认图片风格（projects.image_style_description，镜像自 project_styles 默认行）。
   * 供提示词草稿/优化把项目风格注入 AI 输入；返回 null = 项目不存在，styleDescription 可为 null = 未配置风格。
   */
  getProjectImageStyle(projectId: string): Promise<{ styleDescription: string | null } | null>;
  /**
   * 项目默认图片生成模板（generation_default_strategies 图片媒介策略
   * parameters.prompt_template_id → prompt_templates.content，与前端
   * effectivePromptTemplate 同源解析）。返回 null = 项目不存在。
   */
  getProjectImageTemplate(projectId: string): Promise<PromptTemplateContext | null>;
  /**
   * 项目默认视频风格（projects.video_style_description）。供视频提示词草稿把项目视频风格
   * 注入 AI 输入；返回 null = 项目不存在，styleDescription 可为 null = 未配置风格。
   */
  getProjectVideoStyle(projectId: string): Promise<{ styleDescription: string | null } | null>;
  /**
   * 项目默认视频生成模板（generation_default_strategies 视频媒介策略
   * parameters.prompt_template_id → prompt_templates.content，与前端
   * effectivePromptTemplate 同源解析）。返回 null = 项目不存在。
   */
  getProjectVideoTemplate(projectId: string): Promise<PromptTemplateContext | null>;
}

export interface PromptTemplateContext {
  /** project = projects.image/video_prompt_template 文本列；template = 策略引用命中模板库；system_default = 无引用或引用失效回落（content 为空字符串）。 */
  source: "project" | "template" | "system_default";
  /** 模板原文；source 为 system_default 时为 ""。 */
  content: string;
  /** 策略引用 id 在库里找不到（软删/跨项目）时置位。 */
  missingTemplateId?: string;
}

export interface AssetMatchItem extends Omit<AssetMatchCandidate, "candidateId"> {
  reason: string;
}

export interface AssetMatchResult {
  items: AssetMatchItem[];
  count: number;
  retrievalMode: "hybrid" | "structured_fallback";
  empty: boolean;
  emptyMessage?: string;
}

/**
 * 工具调用轮次。结构化任务不再靠「让模型吐 JSON 再解析」,而是由工具的
 * input schema 强约束——这一层只负责把工具表和历史消息如实送到供应商,
 * 并把返回的工具调用如实带回来。审计、限额、模型解析仍归网关。
 */
export interface AiToolSpec {
  name: string;
  description: string;
  /** JSON Schema。由调用方的工具定义直接给出,网关不改写。 */
  parameters: unknown;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 供应商发起了一次工具调用,但入参读不出来(实测形状:裸词没加引号)。
 * 它是一条明确的失败,不是「模型没干活」:同一批里其他调用照常返回,
 * 只有这一条要退回给模型重发。片段只用于服务端定位,已截断脱敏。
 */
export interface AiUnreadableToolCall {
  id: string;
  name: string;
  argumentsExcerpt: string;
}

export interface AiConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: AiToolCall[];
}

export interface AiToolTurnRequest {
  system: string;
  messages: AiConversationMessage[];
  tools: AiToolSpec[];
  model?: string;
  thinking?: AiThinkingMode;
  maxTokens: number;
  /** 同 complete:由网关按用途解析,工具轮目前无覆盖用途。 */
  timeoutMs?: number;
}

export interface AiProviderToolTurn extends AiProviderCompletion {
  toolCalls: AiToolCall[];
  unreadableToolCalls: AiUnreadableToolCall[];
}
