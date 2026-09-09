import type { AudioPromptDimensions } from "../audio/types.js";

export type GenerationMediaKind = "image" | "video" | "audio";
export type GenerationProductionMode = "full" | "sample";

/** Verified provenance for the implicit AIGC metadata carried by an output. */
export type AigcMetadataEvidence = "platform_applied" | "provider_response";

/**
 * The gate only accepts this narrow proof shape. Provider-specific metadata
 * may add fields, but it cannot invent a third evidence value.
 */
export interface AigcComplianceMetadata extends Record<string, unknown> {
  aigcMetadataEnabled: true;
  aigcMetadataEvidence: AigcMetadataEvidence;
  /** Reversible platform content identifier, present after the platform writer runs. */
  contentId?: string;
  contentProducer?: string;
  schemaVersion?: string;
}

export type GenerationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type GenerationPhase =
  | "created"
  | "submitting"
  | "provider_queued"
  | "provider_running"
  | "provider_succeeded"
  | "persisting"
  | "complete";

export type GenerationReferenceKind = "image" | "video" | "audio";

export type GenerationQuoteSource = "web" | "assistant" | "cli" | "agent";
export type GenerationQuoteAction = "submit" | "retry";
export type GenerationQuoteStatus = "pending_confirmation" | "confirmed" | "consumed" | "voided";

export interface GenerationReferenceSnapshot {
  kind: GenerationReferenceKind;
  url: string;
  role?: string;
  /**
   * Tracing handle back to the asset library row. Snapshots persisted before
   * the generation-mapping contract do not carry it; do not rely on it for
   * control semantics, only for display manifests.
   */
  mediaId?: string;
  /**
   * 本镜定稿图尚未登记为资产时，仍可用其受控原件直链作为 Seedance 全能参考。
   * 这不是对外请求字段；它只让付费链能在每个关键事务重新核验原件、项目归属和
   * 自产信任，避免把任意 URL 当成可重放的参考。
   */
  sourceMediaResultId?: string;
}

/**
 * 合同第一节三互斥场景的展示标签,由冻结参考快照纯函数派生
 * (v01Contract.deriveReferenceMode),不落库。
 */
export type GenerationReferenceMode = "multimodal_reference" | "anchor_frames" | "text_only";

/** 两段式提示词编译产物(合同第二节):版本化的自动段 + 人工补充段。 */
export interface GenerationPromptCompilation {
  version: string;
  autoPrompt: string;
  supplementPrompt: string;
  projectStyleApplied?: boolean;
  projectStyleReferenceMediaIds?: string[];
  promptTemplateSource?: "platform_default" | "project";
  /**
   * Audio keeps creative direction out of the spoken text. These values are
   * carried to the provider adapter for its verified structured controls and
   * retained in the quote snapshot for audit; they are never concatenated
   * into `autoPrompt`.
   */
  audioDimensions?: Required<AudioPromptDimensions>;
}

export interface GenerationReferenceManifestItem {
  mediaId: string | null;
  kind: GenerationReferenceKind;
  role: string | null;
}

export interface GenerationParameters {
  size?: string;
  ratio?: string;
  durationSeconds?: number;
  resolution?: string;
  seed?: number;
  watermark?: boolean;
  /** 预览档身份键:预览档 params 合法字段,供应商适配层剥离、不发给供应商。 */
  preview?: boolean;
  sequentialImageGeneration?: "auto" | "disabled";
  /** Seed Audio requests use original_duration for billing and the provider payload. */
  originalDurationSeconds?: number;
  format?: "mp3" | "wav" | "pcm";
  sampleRate?: number;
  speechRate?: number;
  loudnessRate?: number;
  pitchRate?: number;
  speakerId?: string;
  enableSubtitle?: boolean;
  /** Hidden compliance defaults. Ordinary callers cannot disable these. */
  aigcMetadataEnabled?: boolean;
  aigcWatermarkEnabled?: boolean;
  [key: string]: unknown;
}

export interface SubmitGenerationInput {
  projectId: string;
  episodeId?: string;
  sceneId?: string;
  shotId?: string;
  targetAssetEntityId?: string;
  /** v1.9 十.10：发起生成的变体；产物归属该变体（缺省回落第一变体）。 */
  targetAssetVariantId?: string;
  mediaKind: GenerationMediaKind;
  /** Public callers select a complete capability tier. Legacy adapters may omit it temporarily. */
  tierId?: string;
  model: string;
  prompt: string;
  /**
   * 两段式提示词编译快照(合同第二节):prompt 为自动段+人工补充段拼接结果时,
   * 路由层把编译产物随报价持久化,供透明化回带与审计。CLI/assistant 直传
   * prompt 的传统模式无此字段。
   */
  promptCompilation?: GenerationPromptCompilation;
  parameters?: GenerationParameters;
  referenceMediaIds?: string[];
  referenceAssetSnapshots?: GenerationReferenceSnapshot[];
  quantity?: number;
  productionMode?: GenerationProductionMode;
  clientIdempotencyKey: string;
}

export interface NormalizedGenerationInput
  extends Omit<
    SubmitGenerationInput,
    "parameters" | "referenceMediaIds" | "referenceAssetSnapshots" | "quantity" | "productionMode"
  > {
  parameters: GenerationParameters;
  tierId: string;
  referenceMediaIds: string[];
  referenceAssetSnapshots: GenerationReferenceSnapshot[];
  quantity: number;
  productionMode: GenerationProductionMode;
}

export interface GenerationActor {
  userId: string;
  /**
   * An internal, route-verified project scope. HTTP handlers obtain it only
   * after ProjectAccessService has applied the platform + project-role matrix.
   * It proves project capability only; it never transfers ownership of
   * another user's quote or paid generation request.
   *
   * Quote creation and read-only lookups may omit it; they fall back to the
   * conservative rule that a caller can act only on their own generation rows.
   */
  authorizedProjectId?: string;
}

/**
 * Every paid consumption transaction (confirm, submit, batch confirm/submit,
 * retry) must carry the route-verified project scope so the repository can
 * re-check access inside the write transaction. This is a compile-time
 * contract; there is no unscoped consumption path.
 */
export interface ScopedGenerationActor extends GenerationActor {
  authorizedProjectId: string;
}

export interface ProviderMediaResult {
  kind: "image" | "video" | "audio" | "last_frame";
  /**
   * Temporary provider-hosted URL to download from. Optional because some
   * providers (e.g. synchronous TTS) return media bytes inline instead.
   * Exactly one of temporaryUrl / inlineContent must be present.
   */
  temporaryUrl?: string;
  /** Inline base64 media bytes for providers without a downloadable URL. */
  inlineContent?: { contentBase64: string; contentType: string };
  providerResultKey: string;
  durationSeconds?: number;
  /** Actual provider-reported media length. Audio is millisecond-precise. */
  actualDurationMs?: number;
  /** Actual audio duration minus the frozen quote estimate, persisted in the provider snapshot. */
  durationDeltaMs?: number;
  /**
   * Provider-declared audio duration behavior. This is an adapter result
   * semantic, not a caller-controlled generation parameter: providers that
   * bill and determine duration after synthesis can opt out of the legacy
   * quote-tolerance/subtitle terminal gate while retaining their own cap.
   */
  audioDurationPolicy?: {
    source: "provider_reported";
    maxDurationMs: number;
  };
  /** Provider-neutral subtitle timing payload, retained only after TOS persistence. */
  subtitle?: Record<string, unknown> | unknown[];
  complianceMetadata?: AigcComplianceMetadata;
}

export interface ProviderResultSnapshot {
  status: "pending" | "running" | "succeeded" | "failed";
  providerTaskId?: string;
  rawStatus?: string;
  unknownStatus?: boolean;
  media: ProviderMediaResult[];
  errorCode?: string;
  errorMessage?: string;
  /** The configured, provider-verified model identifier used for this task. */
  actualModelId?: string;
  /** Provider-neutral task details; raw provider responses are never exposed. */
  parameterSnapshot?: GenerationParameters;
  usage?: Record<string, number | string | boolean>;
  cost?: { amount?: number; currency?: string };
  metadata?: Record<string, unknown>;
}

export interface ProviderSubmissionAccepted {
  outcome: "accepted";
  providerTaskId: string;
  rawStatus?: string;
}

export interface ProviderSubmissionSucceeded {
  outcome: "succeeded";
  providerTaskId?: string;
  result: ProviderResultSnapshot;
}

export type ProviderSubmission = ProviderSubmissionAccepted | ProviderSubmissionSucceeded;

export interface ProviderGenerationRequest {
  mediaKind: GenerationMediaKind;
  model: string;
  prompt: string;
  parameters: GenerationParameters;
  references: GenerationReferenceSnapshot[];
  quantity: number;
  /** Server-compiled audio direction, intentionally separate from spoken `prompt`. */
  audioPromptDimensions?: Required<AudioPromptDimensions>;
}

export interface StoredGenerationMedia {
  id?: string;
  providerResultKey: string;
  mediaKind: GenerationMediaKind;
  storageBucket: string;
  storagePath: string;
  storageUrl: string;
  sha256: string;
  mimeType: string;
  durationSeconds?: number;
  subtitle?: Record<string, unknown> | unknown[];
  complianceMetadata?: AigcComplianceMetadata;
  /** 预览档身份标记:请求 parameters.preview=true 的媒体结果,落库转写入 metadata.preview。 */
  preview?: boolean;
  createdAt?: Date;
}

/**
 * Durable receipt for a TOS object after upload and before PostgreSQL media
 * persistence. The object stays on the orphan ledger until the media row
 * references it or a later cleanup package records disposal.
 */
export interface GenerationTosObjectReceipt {
  providerResultKey: string;
  storageBucket: string;
  objectKey: string;
  producedAt: Date;
}

export interface GenerationView {
  requestId: string;
  attemptId: string;
  projectId: string;
  episodeId?: string;
  shotId?: string;
  attemptNo?: number;
  status: GenerationStatus;
  phase: GenerationPhase;
  mediaKind: GenerationMediaKind;
  /** Stable public selection key; actual provider model remains server-only. */
  tierId?: string;
  model: string;
  /** Final server-side prompt frozen on the generation request. */
  prompt: string;
  /** Final normalized parameters frozen with the request. */
  parameters: GenerationParameters;
  estimatedCostFen: number;
  providerTaskId?: string;
  media: StoredGenerationMedia[];
  /**
   * Frozen control snapshots of the originating request, read back for the
   * reference_mode/reference_manifest transparency fields (合同 A5).
   */
  referenceAssetSnapshots?: GenerationReferenceSnapshot[];
  errorCode?: string;
  errorMessage?: string;
  /** 本地 worker 当前可领取队列中的顺位；不是供应商远端排队位置。 */
  queuePosition?: number | null;
  /** 同类历史成功尝试的中位总耗时；样本不足时为 null，绝不填默认值。 */
  estimatedDurationSeconds?: number | null;
  estimatedDurationSampleCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Current-user projection for the cross-project production queue. */
export interface GenerationInFlightView {
  requestId: string;
  attemptId: string;
  projectId: string;
  episodeId?: string;
  shotId?: string;
  targetAssetEntityId?: string;
  mediaKind: GenerationMediaKind;
  status: Extract<GenerationStatus, "pending" | "running">;
  attemptNo: number;
  /** Stable public selection key; actual provider model remains server-only. */
  tierId?: string;
  model: string;
  /** 本地 worker 当前可领取队列中的顺位；不是供应商远端排队位置。 */
  queuePosition: number | null;
  /** 同类历史成功尝试的中位总耗时；样本不足时为 null，绝不填默认值。 */
  estimatedDurationSeconds: number | null;
  estimatedDurationSampleCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GenerationInFlightPage {
  items: GenerationInFlightView[];
  page: number;
  pageSize: number;
  total: number;
}

/** Current-user projection for failed rows that still need human handling. */
export interface GenerationFailedView {
  requestId: string;
  attemptId: string;
  projectId: string;
  episodeId?: string;
  sceneId?: string;
  shotId?: string;
  targetAssetEntityId?: string;
  mediaKind: GenerationMediaKind;
  status: "failed";
  phase: GenerationPhase;
  attemptNo: number;
  /** Stable public selection key; actual provider model remains server-only. */
  tierId?: string;
  model: string;
  retryable: boolean;
  errorCode?: string;
  errorMessage?: string;
  createdAt: Date;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface GenerationFailedPage {
  items: GenerationFailedView[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * One explicit, durable in-site reminder for a succeeded or definitely failed
 * attempt. The attempt itself remains the source of truth for the outcome;
 * this record only tracks whether its owner has acknowledged the reminder.
 */
export interface GenerationAttemptNotificationView {
  id: string;
  requestId: string;
  attemptId: string;
  projectId: string;
  episodeId?: string;
  shotId?: string;
  targetAssetEntityId?: string;
  mediaKind: GenerationMediaKind;
  status: Extract<GenerationStatus, "succeeded" | "failed">;
  errorMessage?: string;
  createdAt: Date;
}

export interface GenerationQuotePriceSnapshot {
  tierId: string;
  pricingRuleId: string;
  provider: string;
  model: string;
  mediaKind: GenerationMediaKind;
  billingUnit: "request" | "image" | "second" | "ten_thousand_characters";
  unitPriceFen: number;
  billableUnits: number;
  estimatedCostFen: number;
  /** Absent on legacy quotes; readers normalize that shape to full mode. */
  fullEstimatedCostFen?: number;
  productionMode?: GenerationProductionMode;
  priceMultiplierBps?: number;
  discountNumerator?: number;
  discountDenominator?: number;
  currency: "CNY";
  pricingBasis?: {
    contractVersion:
      | "v0.1-ark-fixed"
      | "v0.2-audio-original-duration"
      | "v0.3-audio-characters"
      | "v0.4-provider-tier";
    method:
      | "configured_per_image"
      | "conservative_per_second"
      | "configured_per_10k_characters";
    fixedParameters: Record<string, string | number | boolean>;
    noInputVideo?: true;
    inputVideoReferenceCount?: number;
    estimatedTokens?: number;
    providerYuanPerMillionTokens?: number;
  };
}

export interface GenerationQuoteView {
  id: string;
  userId: string;
  source: GenerationQuoteSource;
  action: GenerationQuoteAction;
  assistantSessionId?: string;
  originalRequestId?: string;
  baseAttemptId?: string;
  baseAttemptNo?: number;
  requestHash: string;
  normalizedRequest: Record<string, unknown>;
  pricingRuleId: string;
  priceSnapshot: GenerationQuotePriceSnapshot;
  estimatedCostFen: number;
  status: GenerationQuoteStatus;
  expiresAt: Date;
  confirmedAt?: Date;
  /** Server-recorded human who confirmed this exact paid action. */
  confirmedByUserId?: string;
  consumedAt?: Date;
  generationRequestId?: string;
  generationAttemptId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A single human authorization over one frozen, ordered list of ordinary
 * one-time quotes. It is deliberately separate from `generation_quotes`:
 * each quote still maps to at most one attempt, while the batch record proves
 * who authorized the complete list and the total they saw.
 */
export type GenerationBatchAuthorizationStatus = "confirmed" | "completed" | "partial" | "failed";

export type GenerationBatchItemStatus =
  | "confirmed"
  | "created"
  | "expired"
  | "price_changed"
  | "budget_blocked"
  | "quote_unavailable"
  | "failed";

export interface BatchGenerationSubmitItem {
  itemId: string;
  quoteId: string;
}

export interface BatchGenerationSubmitInput {
  projectId: string;
  clientIdempotencyKey: string;
  /** Exact sum the user saw in the estimate drawer before confirming. */
  expectedTotalEstimatedCostFen: number;
  productionMode?: GenerationProductionMode;
  items: BatchGenerationSubmitItem[];
}

export interface GenerationBatchItemView {
  itemId: string;
  quoteId: string;
  estimatedCostFen: number;
  status: GenerationBatchItemStatus;
  generationRequestId?: string;
  generationAttemptId?: string;
  queuePosition?: number | null;
  estimatedDurationSeconds?: number | null;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    statusCode: number;
    details: unknown | null;
  };
}

export interface GenerationBatchSubmissionView {
  authorizationId: string;
  userId: string;
  projectId: string;
  clientIdempotencyKey: string;
  listHash: string;
  productionMode: GenerationProductionMode;
  status: GenerationBatchAuthorizationStatus;
  authorizedTotalEstimatedCostFen: number;
  submittedTotalEstimatedCostFen: number;
  currency: "CNY";
  createdCount: number;
  failedCount: number;
  authorizedAt: Date;
  idempotentReplay: boolean;
  items: GenerationBatchItemView[];
}

export interface RecoverableGenerationContext {
  request: {
    id: string;
    actorId: string;
    input: NormalizedGenerationInput;
    requestHash: string;
    estimatedCostFen: number;
  };
  attempt: {
    id: string;
    status: GenerationStatus;
    phase: GenerationPhase;
    providerTaskId?: string;
    providerResult?: ProviderResultSnapshot;
  };
  media: StoredGenerationMedia[];
}

// ---------------------------------------------------------------------------
// 生成预检 (generation precheck) — 纯规则评分器类型
// 规划文档: docs/planning/generation-precheck-cost-control.md §4.1
// ---------------------------------------------------------------------------

/** 单维度评分状态 */
export type PrecheckDimensionStatus = "good" | "ok" | "weak" | "missing";

/** 单维度评分 */
export interface PromptDimensionScore {
  /** 维度标识, e.g. "character_description" */
  key: string;
  /** 中文标签 */
  label: string;
  /** 0–100 分 */
  score: number;
  /** 0–1 权重, 所有维度 weight 之和 = 1 */
  weight: number;
  status: PrecheckDimensionStatus;
  /** 一句话定位问题 */
  detail: string;
  /** 改进建议 */
  suggestion?: string;
}

/** 提示词预检结果 */
export interface PrecheckResult {
  /** 加权总分 0–100 */
  overallScore: number;
  dimensions: PromptDimensionScore[];
  /** 服务端编译的自动段 (只读预览) */
  autoPromptPreview: string;
  /** 缺失的参考栏位名称列表 */
  missingReferences: string[];
  /** 优先级排序的改进建议 */
  recommendations: string[];
  /** 预检分过低时 sample 模式可能浪费 */
  estimatedSamplingEffect: {
    warning: boolean;
    message?: string;
  };
  /** 幂等键 */
  precheckId: string;
  /** ISO 8601 */
  createdAt: string;
}
