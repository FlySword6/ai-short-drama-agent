import type {
  AigcComplianceMetadata,
  BatchGenerationSubmitInput,
  GenerationBatchSubmissionView,
  GenerationView,
  GenerationQuoteSource,
  GenerationQuoteView,
  GenerationParameters,
  GenerationMediaKind,
  GenerationFailedPage,
  GenerationInFlightPage,
  NormalizedGenerationInput,
  ProviderGenerationRequest,
  ProviderResultSnapshot,
  ProviderSubmission,
  RecoverableGenerationContext,
  StoredGenerationMedia,
  GenerationTosObjectReceipt,
} from "./types.js";
import type { ResolvedGenerationTier } from "./capabilityTiers.js";
import type { ProviderCostRecordOutcome } from "./providerCost.js";

export type CreateGenerationResult =
  | { outcome: "created" | "existing"; view: GenerationView }
  | { outcome: "idempotency_conflict" }
  | { outcome: "budget_exceeded" };

/**
 * The worker owns a recoverable attempt only while this database lease says
 * so. Keeping this narrow contract separate avoids making request-facing
 * repositories pretend to be worker schedulers.
 */
export interface GenerationWorkerLeaseRepository {
  claimNextRecoverableAttempt(
    workerId: string,
    leaseSeconds: number,
    allowNewSubmission: boolean,
  ): Promise<string | null>;
  /** Returns false when the owner fencing check failed or the lease expired. */
  renewLease(attemptId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  releaseLease(attemptId: string, workerId: string, delayMs?: number): Promise<void>;
}

export interface GenerationRepository {
  /** Tiers are read from active pricing_rules.metadata.capability_tier only. */
  resolveActiveTier(input: {
    tierId: string;
    mediaKind: "image" | "video" | "audio";
    parameters: GenerationParameters;
    quantity: number;
  }): Promise<ResolvedGenerationTier>;
  /**
   * The concrete repository must apply the budget check, budget reservation,
   * idempotency check, request creation and first-attempt creation atomically.
   */
  createSubmission(input: {
    actorId: string;
    authorizedProjectId: string;
    source: GenerationQuoteSource;
    quoteId: string;
    requestHash: string;
    request: NormalizedGenerationInput;
    budgetLimitFen: number;
    /** v1.9 十.7：Lite 自动确认——提交事务内对同 actor 的 pending 报价做同口径确认。 */
    autoConfirm?: boolean;
  }): Promise<CreateGenerationResult>;

  /**
   * Persist one human confirmation over a frozen ordered quote list without
   * creating a request, attempt, or provider call. Each child quote becomes
   * confirmed by the same actor in the same transaction.
   */
  createBatchAuthorization(input: {
    actorId: string;
    authorizedProjectId: string;
    source: GenerationQuoteSource;
    batch: BatchGenerationSubmitInput;
    listHash: string;
  }): Promise<GenerationBatchSubmissionView>;

  /**
   * Consume one previously confirmed authorization. The implementation keeps
   * every child quote's price/budget/one-time checks and records partial
   * outcomes without silently re-pricing.
   */
  submitBatchAuthorization(input: {
    actorId: string;
    authorizedProjectId: string;
    source: GenerationQuoteSource;
    authorizationId: string;
    budgetLimitFen: number;
  }): Promise<GenerationBatchSubmissionView>;

  findBatchAuthorizationProjectId(actorId: string, authorizationId: string): Promise<string | null>;

  /** A retry is a new paid attempt and therefore reserves budget atomically too. */
  createRetry(input: {
    actorId: string;
    authorizedProjectId: string;
    source: GenerationQuoteSource;
    requestId: string;
    quoteId: string;
    clientIdempotencyKey: string;
    budgetLimitFen: number;
    /** v1.9 十.7：Lite 自动确认（同 createSubmission）。 */
    autoConfirm?: boolean;
  }): Promise<CreateGenerationResult>;

  createSubmissionQuote(input: {
    actorId: string;
    authorizedProjectId?: string;
    source: GenerationQuoteSource;
    assistantSessionId?: string;
    requestHash: string;
    request: NormalizedGenerationInput;
    ttlSeconds: number;
  }): Promise<GenerationQuoteView>;

  createRetryQuote(input: {
    actorId: string;
    authorizedProjectId?: string;
    source: GenerationQuoteSource;
    assistantSessionId?: string;
    requestId: string;
    ttlSeconds: number;
  }): Promise<GenerationQuoteView>;

  /** A quote cannot be confirmed after its pricing-rule tier has been withdrawn. */
  confirmQuote(actorId: string, quoteId: string, authorizedProjectId: string): Promise<GenerationQuoteView>;

  findViewForActor(actorId: string, requestId: string, authorizedProjectId?: string): Promise<GenerationView | null>;
  findViewByAttemptId(attemptId: string): Promise<GenerationView | null>;
  /**
   * Current authenticated user's cross-project active queue. Project roles do
   * not widen this owner scope, including for administrators.
   */
  listInFlightViewsForActor(actorId: string, page: number, pageSize: number): Promise<GenerationInFlightPage>;
  /**
   * Current authenticated user's cross-project failures. Only the latest
   * attempt for each request can appear, independently of notification ack.
   */
  listFailedViewsForActor(actorId: string, page: number, pageSize: number): Promise<GenerationFailedPage>;
  getRecoverableAttempt(attemptId: string): Promise<RecoverableGenerationContext | null>;
  /**
   * Optional for in-memory adapters. Production records this independent audit
   * fact fail-open; it must never share the quote/credit transaction.
   */
  recordProviderCost?(input: {
    attemptId: string;
    result: ProviderResultSnapshot;
  }): Promise<ProviderCostRecordOutcome>;

  /** `leaseOwner` enables worker-side compare-and-set after a lease expires. */
  markSubmitting(attemptId: string, leaseOwner?: string): Promise<void>;
  markProviderAccepted(attemptId: string, providerTaskId: string, rawStatus?: string, leaseOwner?: string): Promise<void>;
  markProviderProgress(attemptId: string, result: ProviderResultSnapshot, leaseOwner?: string): Promise<void>;
  markProviderSucceeded(attemptId: string, result: ProviderResultSnapshot, leaseOwner?: string): Promise<void>;
  markProviderFailed(input: {
    attemptId: string;
    errorCode: string;
    errorMessage: string;
    /** Retain a supplier result that failed local acceptance for human review. */
    providerResult?: ProviderResultSnapshot;
    /**
     * The provider already produced media but the platform AIGC label gate
     * failed. Persist a quote-linked pending-compensation fact without changing
     * pricing or claiming that the user incurred zero cost.
     */
    recordCompensationPending?: boolean;
    leaseOwner?: string;
  }): Promise<void>;
  markSubmissionOutcomeUnknown(attemptId: string, errorMessage: string, leaseOwner?: string): Promise<void>;
  recordPollFailure(attemptId: string, errorMessage: string, leaseOwner?: string): Promise<void>;
  markPersisting(attemptId: string, leaseOwner?: string): Promise<void>;
  recordPersistenceFailure(attemptId: string, errorMessage: string, leaseOwner?: string): Promise<void>;
  /**
   * Record an uploaded TOS object before the media row references it. Because
   * the external write already happened, this audit-only receipt must remain
   * recordable after lease loss; it grants no workflow transition.
   */
  recordTosObjectUpload(attemptId: string, object: GenerationTosObjectReceipt, leaseOwner?: string): Promise<void>;
  /** Upsert the result and set media_results.persistence_status to `persisted`. */
  saveMediaResult(attemptId: string, result: StoredGenerationMedia, leaseOwner?: string): Promise<void>;
  /** Must refuse the transition while any expected media result is not persisted. */
  markSucceeded(attemptId: string, leaseOwner?: string): Promise<void>;
}

export interface GenerationProvider {
  submit(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission>;
  /** The originating request lets routers select the correct adapter after a restart. */
  query(
    providerTaskId: string,
    request?: Pick<ProviderGenerationRequest, "model" | "mediaKind">,
    signal?: AbortSignal,
  ): Promise<ProviderResultSnapshot>;
}

export interface GenerationStorage {
  uploadBytes(input: {
    content: Buffer;
    storagePath: string;
    contentType: string;
  }): Promise<{ bucket: string; storagePath: string; storageUrl: string }>;
}

/**
 * Trusted platform writer. Implementations may return platform_applied only
 * after writing the bytes and independently reading back the single label.
 */
export interface GenerationAigcLabeler {
  apply(input: {
    content: Buffer;
    contentType: string;
    extension: string;
    mediaKind: GenerationMediaKind;
    contentId: string;
  }): Promise<{
    content: Buffer;
    complianceMetadata: AigcComplianceMetadata;
  }>;
}

export interface DownloadedMedia {
  content: Buffer;
  contentType: string;
  byteLength: number;
  extension: string;
}

export type GenerationMediaDownloader = (
  url: string,
  options?: { signal?: AbortSignal },
) => Promise<DownloadedMedia>;

export function toProviderRequest(input: NormalizedGenerationInput): ProviderGenerationRequest {
  return {
    mediaKind: input.mediaKind,
    model: input.model,
    prompt: input.prompt,
    parameters: input.parameters,
    references: input.referenceAssetSnapshots,
    quantity: input.quantity,
    ...(input.mediaKind === "audio" && input.promptCompilation?.audioDimensions
      ? { audioPromptDimensions: input.promptCompilation.audioDimensions }
      : {}),
  };
}
