import { createHash } from "node:crypto";
import {
  GenerationAttemptLeaseLostError,
  GenerationError,
  ProviderRequestError,
  safeErrorMessage,
} from "./errors.js";
import { downloadMediaBytes, inlineDownloadedMedia } from "./mediaDownload.js";
import { toProviderRequest } from "./ports.js";
import type {
  CreateGenerationResult,
  GenerationAigcLabeler,
  GenerationMediaDownloader,
  GenerationProvider,
  GenerationRepository,
  GenerationStorage,
} from "./ports.js";
import type {
  AigcComplianceMetadata,
  BatchGenerationSubmitInput,
  GenerationActor,
  ScopedGenerationActor,
  GenerationBatchSubmissionView,
  GenerationFailedPage,
  GenerationMediaKind,
  GenerationInFlightPage,
  GenerationQuoteSource,
  GenerationQuoteView,
  GenerationView,
  NormalizedGenerationInput,
  ProviderMediaResult,
  ProviderResultSnapshot,
  RecoverableGenerationContext,
  StoredGenerationMedia,
  SubmitGenerationInput,
} from "./types.js";
import {
  normalizeV01Parameters,
  normalizeV01References,
  assertAudioSource,
  V01GenerationContractError,
} from "./v01Contract.js";
import { AUDIO_MAX_TEXT_PROMPT_LENGTH } from "./v01Contract.js";

export interface GenerationServiceOptions {
  repository: GenerationRepository;
  provider: GenerationProvider;
  storage: GenerationStorage;
  aigcLabeler: GenerationAigcLabeler;
  budgetLimitFen: number;
  mediaDownloader?: GenerationMediaDownloader;
  costAlertLogger?: {
    warn(value: unknown, message?: string): void;
  };
}

export class GenerationService {
  private readonly repository: GenerationRepository;
  private readonly provider: GenerationProvider;
  private readonly storage: GenerationStorage;
  private readonly aigcLabeler: GenerationAigcLabeler;
  private readonly budgetLimitFen: number;
  private readonly mediaDownloader: GenerationMediaDownloader;
  private readonly costAlertLogger: GenerationServiceOptions["costAlertLogger"];

  constructor(options: GenerationServiceOptions) {
    if (!Number.isSafeInteger(options.budgetLimitFen) || options.budgetLimitFen < 0) {
      throw new Error("budgetLimitFen must be a non-negative integer");
    }
    this.repository = options.repository;
    this.provider = options.provider;
    this.storage = options.storage;
    this.aigcLabeler = options.aigcLabeler;
    this.budgetLimitFen = options.budgetLimitFen;
    this.mediaDownloader = options.mediaDownloader ?? ((url, downloadOptions) => (
      downloadMediaBytes(url, downloadOptions)
    ));
    this.costAlertLogger = options.costAlertLogger ?? console;
  }

  async quoteSubmission(
    actor: GenerationActor,
    input: SubmitGenerationInput,
    source: GenerationQuoteSource,
    assistantSessionId?: string,
  ): Promise<GenerationQuoteView> {
    const actorId = requireText(actor.userId, "userId");
    const request = normalizeGenerationInput(input);
    return this.repository.createSubmissionQuote({
      actorId,
      ...(actor.authorizedProjectId ? { authorizedProjectId: actor.authorizedProjectId } : {}),
      source,
      ...(assistantSessionId ? { assistantSessionId: requireText(assistantSessionId, "assistantSessionId") } : {}),
      requestHash: hashGenerationRequest(request),
      request,
      ttlSeconds: 10 * 60,
    });
  }

  async quoteRetry(
    actor: GenerationActor,
    requestId: string,
    source: GenerationQuoteSource,
    assistantSessionId?: string,
  ): Promise<GenerationQuoteView> {
    return this.repository.createRetryQuote({
      actorId: requireText(actor.userId, "userId"),
      ...(actor.authorizedProjectId ? { authorizedProjectId: actor.authorizedProjectId } : {}),
      source,
      ...(assistantSessionId ? { assistantSessionId: requireText(assistantSessionId, "assistantSessionId") } : {}),
      requestId: requireText(requestId, "requestId"),
      ttlSeconds: 10 * 60,
    });
  }

  async confirmQuote(actor: ScopedGenerationActor, quoteId: string): Promise<GenerationQuoteView> {
    return this.repository.confirmQuote(
      requireText(actor.userId, "userId"),
      requireText(quoteId, "quoteId"),
      actor.authorizedProjectId,
    );
  }

  async listInFlight(actorId: string, page: number, pageSize: number): Promise<GenerationInFlightPage> {
    return this.repository.listInFlightViewsForActor(
      requireText(actorId, "actorId"),
      page,
      pageSize,
    );
  }

  async listFailed(actorId: string, page: number, pageSize: number): Promise<GenerationFailedPage> {
    return this.repository.listFailedViewsForActor(
      requireText(actorId, "actorId"),
      page,
      pageSize,
    );
  }

  async submit(
    actor: ScopedGenerationActor,
    input: SubmitGenerationInput,
    quoteId: string,
    source: GenerationQuoteSource,
    autoConfirm?: boolean,
  ): Promise<GenerationView> {
    const actorId = requireText(actor.userId, "userId");
    const request = normalizeGenerationInput(input);
    const result = await this.repository.createSubmission({
      actorId,
      authorizedProjectId: actor.authorizedProjectId,
      source,
      quoteId: requireText(quoteId ?? "", "quoteId"),
      requestHash: hashGenerationRequest(request),
      request,
      budgetLimitFen: this.budgetLimitFen,
      ...(autoConfirm ? { autoConfirm } : {}),
    });
    return unwrapCreateResult(result);
  }

  async confirmBatch(
    actor: ScopedGenerationActor,
    input: BatchGenerationSubmitInput,
    source: GenerationQuoteSource = "web",
  ): Promise<GenerationBatchSubmissionView> {
    const actorId = requireText(actor.userId, "userId");
    const projectId = requireText(input.projectId, "projectId");
    const clientIdempotencyKey = requireText(input.clientIdempotencyKey, "clientIdempotencyKey");
    if (!Number.isSafeInteger(input.expectedTotalEstimatedCostFen) || input.expectedTotalEstimatedCostFen < 0) {
      throw invalidRequest("expectedTotalEstimatedCostFen must be a non-negative integer");
    }
    if (input.items.length < 1 || input.items.length > 50) {
      throw invalidRequest("batch items must contain 1 to 50 entries");
    }
    const itemIds = new Set<string>();
    const quoteIds = new Set<string>();
    const items = input.items.map((item) => {
      const itemId = requireText(item.itemId, "itemId");
      const quoteId = requireText(item.quoteId, "quoteId");
      if (itemIds.has(itemId) || quoteIds.has(quoteId)) {
        throw invalidRequest("batch items must not repeat itemId or quoteId");
      }
      itemIds.add(itemId);
      quoteIds.add(quoteId);
      return { itemId, quoteId };
    });
    const batch: BatchGenerationSubmitInput = {
      projectId,
      clientIdempotencyKey,
      expectedTotalEstimatedCostFen: input.expectedTotalEstimatedCostFen,
      productionMode: input.productionMode ?? "full",
      items,
    };
    return this.repository.createBatchAuthorization({
      actorId,
      authorizedProjectId: actor.authorizedProjectId,
      source,
      batch,
      listHash: hashGenerationBatch(batch),
    });
  }

  async submitBatchAuthorization(
    actor: ScopedGenerationActor,
    authorizationId: string,
    source: GenerationQuoteSource = "web",
  ): Promise<GenerationBatchSubmissionView> {
    return this.repository.submitBatchAuthorization({
      actorId: requireText(actor.userId, "userId"),
      authorizedProjectId: actor.authorizedProjectId,
      source,
      authorizationId: requireText(authorizationId, "authorizationId"),
      budgetLimitFen: this.budgetLimitFen,
    });
  }

  findBatchAuthorizationProjectId(actorId: string, authorizationId: string): Promise<string | null> {
    return this.repository.findBatchAuthorizationProjectId(
      requireText(actorId, "actorId"),
      requireText(authorizationId, "authorizationId"),
    );
  }

  async retry(
    actor: ScopedGenerationActor,
    requestId: string,
    clientIdempotencyKey: string,
    quoteId: string,
    source: GenerationQuoteSource,
    autoConfirm?: boolean,
  ): Promise<GenerationView> {
    const result = await this.repository.createRetry({
      actorId: requireText(actor.userId, "userId"),
      authorizedProjectId: actor.authorizedProjectId,
      source,
      requestId: requireText(requestId, "requestId"),
      quoteId: requireText(quoteId ?? "", "quoteId"),
      clientIdempotencyKey: requireText(clientIdempotencyKey, "clientIdempotencyKey"),
      budgetLimitFen: this.budgetLimitFen,
      ...(autoConfirm ? { autoConfirm } : {}),
    });
    return unwrapCreateResult(result);
  }

  async get(actor: GenerationActor, requestId: string): Promise<GenerationView> {
    const view = await this.repository.findViewForActor(
      requireText(actor.userId, "userId"),
      requireText(requestId, "requestId"),
      actor.authorizedProjectId,
    );
    if (!view) throw notFoundError();
    return view;
  }

  /**
   * The caller must hold the attempt's worker lease. A second worker must not
   * run the same attempt concurrently, especially while phase is `submitting`.
   */
  async runRecoverableAttempt(
    attemptId: string,
    signal?: AbortSignal,
    leaseOwner?: string,
  ): Promise<GenerationView> {
    const id = requireText(attemptId, "attemptId");
    try {
      const context = await this.repository.getRecoverableAttempt(id);
      if (!context) throw notFoundError();
      if (isTerminal(context)) return this.requireView(id);
      switch (context.attempt.phase) {
        case "created":
          return this.submitAttempt(context, signal, leaseOwner);
        case "submitting":
          // A prior process may have died after the paid POST left this service.
          // Automatically sending it again could double-charge the project.
          await this.repository.markSubmissionOutcomeUnknown(
            id,
            "Provider submission may have been accepted; explicit retry is required",
            leaseOwner,
          );
          return this.requireView(id);
        case "provider_queued":
        case "provider_running":
          return this.pollAttempt(context, signal, leaseOwner);
        case "provider_succeeded":
        case "persisting":
          return this.persistProviderResult(context, signal, leaseOwner);
        default:
          return this.requireView(id);
      }
    } catch (error) {
      // A late worker may have completed its external step after its lease was
      // reclaimed. Read the current owner-visible state, but never write it.
      if (error instanceof GenerationAttemptLeaseLostError) return this.requireView(id);
      throw error;
    }
  }

  private async submitAttempt(
    context: RecoverableGenerationContext,
    signal?: AbortSignal,
    leaseOwner?: string,
  ): Promise<GenerationView> {
    const attemptId = context.attempt.id;
    try {
      // This transition performs the final server-side provenance/remote
      // status check in the same transaction. A deterministic failure must
      // become terminal before the provider sees any paid request.
      await this.repository.markSubmitting(attemptId, leaseOwner);
    } catch (error) {
      if (!(error instanceof GenerationError) || error.code !== "control_asset_invalid_usage") {
        throw error;
      }
      await this.repository.markProviderFailed({
        attemptId,
        errorCode: error.code,
        errorMessage: error.message,
        leaseOwner,
      });
      return this.requireView(attemptId);
    }

    let submission;
    try {
      submission = await this.provider.submit(toProviderRequest(context.request.input), signal);
    } catch (error) {
      if (error instanceof ProviderRequestError && error.outcome === "rejected") {
        await this.repository.markProviderFailed({
          attemptId,
          errorCode: error.providerCode ?? "PROVIDER_REJECTED",
          errorMessage: safeErrorMessage(error),
          leaseOwner,
        });
      } else {
        await this.repository.markSubmissionOutcomeUnknown(attemptId, safeErrorMessage(error), leaseOwner);
      }
      return this.requireView(attemptId);
    }

    if (submission.outcome === "accepted") {
      await this.repository.markProviderAccepted(
        attemptId,
        submission.providerTaskId,
        submission.rawStatus,
        leaseOwner,
      );
      return this.requireView(attemptId);
    }

    await this.recordProviderCostFailOpen(context, submission.result);
    const result = await this.markProviderSucceededAfterAudioIntegrity(
      attemptId,
      context.request.input,
      submission.result,
      leaseOwner,
    );
    if (!result) return this.requireView(attemptId);
    return this.persistProviderResult(
      {
        ...context,
        attempt: {
          ...context.attempt,
          status: "running",
          phase: "provider_succeeded",
          providerTaskId: submission.providerTaskId,
          providerResult: result,
        },
      },
      signal,
      leaseOwner,
    );
  }

  private async pollAttempt(
    context: RecoverableGenerationContext,
    signal?: AbortSignal,
    leaseOwner?: string,
  ): Promise<GenerationView> {
    const attemptId = context.attempt.id;
    const providerTaskId = context.attempt.providerTaskId;
    if (!providerTaskId) {
      await this.repository.markProviderFailed({
        attemptId,
        errorCode: "PROVIDER_TASK_ID_MISSING",
        errorMessage: "Provider task id is missing",
        leaseOwner,
      });
      return this.requireView(attemptId);
    }

    let result: ProviderResultSnapshot;
    try {
      result = await this.provider.query(providerTaskId, context.request.input, signal);
    } catch (error) {
      // A query outage says nothing about the paid provider task's final state.
      await this.repository.recordPollFailure(attemptId, safeErrorMessage(error), leaseOwner);
      return this.requireView(attemptId);
    }

    if (result.status === "pending" || result.status === "running") {
      await this.repository.markProviderProgress(attemptId, result, leaseOwner);
      return this.requireView(attemptId);
    }
    await this.recordProviderCostFailOpen(context, result);
    if (result.status === "failed") {
      await this.repository.markProviderFailed({
        attemptId,
        errorCode: result.errorCode ?? "PROVIDER_TASK_FAILED",
        errorMessage: result.errorMessage ?? "Provider generation failed",
        leaseOwner,
      });
      return this.requireView(attemptId);
    }
    if (result.media.length === 0) {
      await this.repository.markProviderFailed({
        attemptId,
        errorCode: "PROVIDER_RESULT_MISSING",
        errorMessage: "Provider task succeeded without downloadable media",
        leaseOwner,
      });
      return this.requireView(attemptId);
    }

    const persistedResult = await this.markProviderSucceededAfterAudioIntegrity(
      attemptId,
      context.request.input,
      result,
      leaseOwner,
    );
    if (!persistedResult) return this.requireView(attemptId);
    return this.persistProviderResult(
      {
        ...context,
        attempt: {
          ...context.attempt,
          status: "running",
          phase: "provider_succeeded",
          providerResult: persistedResult,
        },
      },
      signal,
      leaseOwner,
    );
  }

  private async persistProviderResult(
    context: RecoverableGenerationContext,
    signal?: AbortSignal,
    leaseOwner?: string,
  ): Promise<GenerationView> {
    const attemptId = context.attempt.id;
    const result = context.attempt.providerResult;
    if (!result || result.status !== "succeeded" || result.media.length === 0) {
      await this.repository.recordPersistenceFailure(
        attemptId,
        "Provider result is unavailable for persistence",
        leaseOwner,
      );
      return this.requireView(attemptId);
    }

    const persistedKeys = new Set(context.media
      .filter((item) => item.complianceMetadata?.aigcMetadataEvidence === "platform_applied")
      .map((item) => item.providerResultKey));
    try {
      if (context.request.input.mediaKind === "audio") {
        for (const media of result.media) {
          assertAudioProviderMediaIntegrity(context.request.input, media);
        }
      }
      const prepared: PreparedAigcMedia[] = [];
      const enrichedMedia = [...result.media];
      for (const [index, media] of result.media.entries()) {
        const persisted = context.media.find(
          (item) => item.providerResultKey === media.providerResultKey
            && item.complianceMetadata?.aigcMetadataEvidence === "platform_applied",
        );
        if (persisted) {
          assertAigcMetadataEvidence(persisted.mediaKind, persisted.complianceMetadata);
          enrichedMedia[index] = { ...media, complianceMetadata: persisted.complianceMetadata };
          continue;
        }
        const downloaded = media.inlineContent
          ? inlineDownloadedMedia(media.inlineContent)
          : await this.mediaDownloader(requireTemporaryMediaUrl(media), { signal });
        const storedMediaKind = storedMediaKindForProviderResult(media);
        const contentId = buildAigcContentId(attemptId, index);
        let labeled;
        try {
          labeled = await this.aigcLabeler.apply({
            content: downloaded.content,
            contentType: downloaded.contentType,
            extension: downloaded.extension,
            mediaKind: storedMediaKind,
            contentId,
          });
        } catch (error) {
          throw new AigcMetadataApplicationError(
            storedMediaKind,
            `Could not apply and verify AIGC metadata for ${contentId}: ${safeErrorMessage(error)}`,
          );
        }
        assertAigcMetadataEvidence(storedMediaKind, labeled.complianceMetadata);
        enrichedMedia[index] = {
          ...media,
          complianceMetadata: preserveProviderEvidence(
            media.complianceMetadata,
            labeled.complianceMetadata,
          ),
        };
        prepared.push({
          index,
          media,
          storedMediaKind,
          content: labeled.content,
          contentType: downloaded.contentType,
          extension: downloaded.extension,
          complianceMetadata: enrichedMedia[index]!.complianceMetadata!,
        });
      }

      const labeledResult: ProviderResultSnapshot = { ...result, media: enrichedMedia };
      for (const media of labeledResult.media) {
        assertAigcMetadataEvidence(storedMediaKindForProviderResult(media), media.complianceMetadata);
      }
      // Keep the verified evidence recoverable before the first external TOS
      // write. A crash after this point will re-run the idempotent writer.
      await this.repository.markProviderSucceeded(attemptId, labeledResult, leaseOwner);
      await this.repository.markPersisting(attemptId, leaseOwner);

      // Every pending result has already been labeled and verified. A bad
      // tail frame therefore cannot leave the main video partially uploaded.
      for (const item of prepared) {
        const storagePath = buildStoragePath(
          context,
          item.storedMediaKind,
          item.index,
          item.extension,
          leaseOwner,
        );
        const stored = await this.storage.uploadBytes({
          content: item.content,
          storagePath,
          contentType: item.contentType,
        });
        const storedMedia = {
          providerResultKey: item.media.providerResultKey,
          mediaKind: item.storedMediaKind,
          storageBucket: stored.bucket,
          storagePath: stored.storagePath,
          storageUrl: stored.storageUrl,
          sha256: createHash("sha256").update(item.content).digest("hex"),
          mimeType: item.contentType,
          // Existing image/video media use integer seconds. TTS returns a
          // measured millisecond duration, which must not be rounded into the
          // legacy column or pretended to equal the quote estimate.
          ...(item.storedMediaKind !== "audio" && item.media.durationSeconds !== undefined
            ? { durationSeconds: item.media.durationSeconds }
            : {}),
          ...(item.media.subtitle !== undefined ? { subtitle: item.media.subtitle } : {}),
          /* 预览档身份键(§2.2):请求 parameters.preview=true 的媒体结果随落库转录进
             metadata.preview;供应商适配层从未发送该键,这里只做身份留档。 */
          ...(context.request.input.parameters.preview === true ? { preview: true } : {}),
          complianceMetadata: item.complianceMetadata,
        } satisfies StoredGenerationMedia;
        await this.repository.recordTosObjectUpload(attemptId, {
          providerResultKey: item.media.providerResultKey,
          storageBucket: stored.bucket,
          objectKey: stored.storagePath,
          producedAt: new Date(),
        }, leaseOwner);
        await this.repository.saveMediaResult(attemptId, storedMedia, leaseOwner);
        persistedKeys.add(item.media.providerResultKey);
      }
      // Public success is deliberately delayed until every provider result is in TOS.
      if (!result.media.every((media) => persistedKeys.has(media.providerResultKey))) {
        throw new Error("Not all provider media results were persisted");
      }
      await this.repository.markSucceeded(attemptId, leaseOwner);
    } catch (error) {
      if (error instanceof GenerationAttemptLeaseLostError) throw error;
      // A malformed but successfully returned provider result will not become
      // valid on a worker retry. Fail it terminally instead of occupying a
      // persisting slot forever; storage/DB/TOS failures still use the bounded
      // persistence-recovery path below.
      if (error instanceof AudioProviderMediaIntegrityError
        || error instanceof AigcMetadataEvidenceError
        || error instanceof AigcMetadataApplicationError) {
        await this.repository.markProviderFailed({
          attemptId,
          errorCode: error.code,
          errorMessage: error.message,
          providerResult: result,
          recordCompensationPending: error instanceof AigcMetadataEvidenceError
            || error instanceof AigcMetadataApplicationError,
          leaseOwner,
        });
      } else {
        await this.repository.recordPersistenceFailure(attemptId, safeErrorMessage(error), leaseOwner);
      }
    }
    return this.requireView(attemptId);
  }

  /**
   * Preserve observed audio duration and its quote delta in the provider
   * snapshot before the attempt becomes recoverable. That makes the audit
   * durable across a storage/DB retry without adding a schema migration or
   * claiming that the supplier returned the estimated duration.
   */
  private async markProviderSucceededAfterAudioIntegrity(
    attemptId: string,
    request: NormalizedGenerationInput,
    result: ProviderResultSnapshot,
    leaseOwner?: string,
  ): Promise<ProviderResultSnapshot | undefined> {
    let auditedResult = result;
    try {
      auditedResult = annotateAudioDurationAudit(request, result);
      if (request.mediaKind === "audio") {
        for (const media of auditedResult.media) {
          assertAudioProviderMediaIntegrity(request, media);
        }
      }
    } catch (error) {
      if (error instanceof AudioProviderMediaIntegrityError) {
        await this.repository.markProviderFailed({
          attemptId,
          errorCode: error.code,
          errorMessage: error.message,
          providerResult: auditedResult,
          leaseOwner,
        });
        return undefined;
      }
      throw error;
    }
    await this.repository.markProviderSucceeded(attemptId, auditedResult, leaseOwner);
    return auditedResult;
  }

  private async requireView(attemptId: string): Promise<GenerationView> {
    const view = await this.repository.findViewByAttemptId(attemptId);
    if (!view) throw notFoundError();
    return view;
  }

  private async recordProviderCostFailOpen(
    context: RecoverableGenerationContext,
    result: ProviderResultSnapshot,
  ): Promise<void> {
    if (!this.repository.recordProviderCost) return;
    try {
      const outcome = await this.repository.recordProviderCost({
        attemptId: context.attempt.id,
        result,
      });
      if (!outcome.requiresAttention) return;
      this.costAlertLogger?.warn({
        alert_code: "provider_cost_requires_attention",
        requires_attention: true,
        attempt_id: context.attempt.id,
        request_id: context.request.id,
        model: context.request.input.model,
        media_kind: context.request.input.mediaKind,
        calculation_status: outcome.status,
        failure_code: outcome.failureCode,
      }, "provider cost requires attention");
    } catch (error) {
      // S84 red line: supplier-cost accounting is an audit sidecar. A broken
      // config/table/write must alert but can never change generation outcome.
      this.costAlertLogger?.warn({
        alert_code: "provider_cost_recording_failed",
        requires_attention: true,
        attempt_id: context.attempt.id,
        request_id: context.request.id,
        model: context.request.input.model,
        media_kind: context.request.input.mediaKind,
        error: safeErrorMessage(error),
      }, "provider cost recording failed open");
    }
  }
}

/**
 * Provisional operational tolerance for a provider-reported TTS duration.
 * This is deliberately not a billing rule: actual and delta values are kept
 * in the durable provider-result snapshot for pending DC reconciliation.
 * Fable/DC must replace this guard with an approved pricing policy before
 * production acceptance.
 */
export const AUDIO_DURATION_TOLERANCE_MS = 1_000;

export interface AudioProviderDurationAudit {
  actualDurationMs: number;
  durationDeltaMs: number;
}

interface PreparedAigcMedia {
  index: number;
  media: ProviderMediaResult;
  storedMediaKind: GenerationMediaKind;
  content: Buffer;
  contentType: string;
  extension: string;
  complianceMetadata: AigcComplianceMetadata;
}

/** A deterministic provider-result contract failure must not enter retry. */
export class AudioProviderMediaIntegrityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AudioProviderMediaIntegrityError";
  }
}

/** A deterministic writer failure is terminal: raw bytes must never reach TOS. */
export class AigcMetadataApplicationError extends Error {
  readonly code: string;

  constructor(readonly mediaKind: GenerationMediaKind, message: string) {
    super(message);
    this.name = "AigcMetadataApplicationError";
    this.code = `${mediaKind.toUpperCase()}_RESULT_AIGC_LABELING_FAILED`;
  }
}

/** The same evidence predicate protects image, video and audio persistence. */
export class AigcMetadataEvidenceError extends Error {
  readonly code: string;

  constructor(readonly mediaKind: GenerationMediaKind) {
    super(`${mediaKind} result is missing verified AIGC metadata evidence`);
    this.name = "AigcMetadataEvidenceError";
    this.code = `${mediaKind.toUpperCase()}_RESULT_AIGC_EVIDENCE_MISSING`;
  }
}

export function assertAigcMetadataEvidence(
  mediaKind: GenerationMediaKind,
  metadata: Record<string, unknown> | undefined,
): asserts metadata is AigcComplianceMetadata {
  if (metadata?.aigcMetadataEnabled !== true
    || (metadata.aigcMetadataEvidence !== "platform_applied"
      && metadata.aigcMetadataEvidence !== "provider_response")) {
    throw new AigcMetadataEvidenceError(mediaKind);
  }
}

/**
 * The provider can only report its measured duration after synthesis. Attach
 * the derived delta to that durable result rather than writing the quoted
 * integer into legacy `media_results.duration_seconds`.
 */
function annotateAudioDurationAudit(
  request: Pick<NormalizedGenerationInput, "mediaKind" | "model" | "parameters">,
  result: ProviderResultSnapshot,
): ProviderResultSnapshot {
  if (request.mediaKind !== "audio") return result;
  return {
    ...result,
    media: result.media.map((media) => {
      const audit = measureAudioProviderDuration(request, media);
      return { ...media, durationDeltaMs: audit.durationDeltaMs };
    }),
  };
}

/**
 * TTS duration is an observed output, unlike video duration which is an input
 * contract. Audio therefore requires a positive measured duration within the
 * operational guard plus provider-derived timed subtitles. AIGC evidence is a
 * separate three-modal gate applied after bytes have been labeled.
 */
export function assertAudioProviderMediaIntegrity(
  request: Pick<NormalizedGenerationInput, "mediaKind" | "model" | "parameters">,
  media: ProviderMediaResult,
): AudioProviderDurationAudit | undefined {
  if (request.mediaKind !== "audio") return undefined;
  const audit = measureAudioProviderDuration(request, media);
  // Providers that report their own billed duration after synthesis declare
  // that capability in the result. Deployment aliases stay opaque to the
  // service; legacy TTS retains its quote-tolerance/subtitle contract.
  if (!usesProviderReportedDuration(media)
    && Math.abs(audit.durationDeltaMs) > AUDIO_DURATION_TOLERANCE_MS) {
    throw new AudioProviderMediaIntegrityError(
      "AUDIO_RESULT_DURATION_OUT_OF_TOLERANCE",
      `Audio provider duration is ${audit.actualDurationMs}ms; frozen estimate is ${request.parameters.originalDurationSeconds! * 1_000}ms (delta ${audit.durationDeltaMs}ms) and requires manual review`,
    );
  }
  if (!usesProviderReportedDuration(media)
    && !hasTimedSubtitle(media.subtitle, audit.actualDurationMs / 1_000)) {
    throw new AudioProviderMediaIntegrityError(
      "AUDIO_RESULT_SUBTITLE_MISSING",
      "Audio provider result is missing timed subtitle JSON",
    );
  }
  return audit;
}

/** Measure first so an out-of-tolerance result still keeps its actual/delta audit. */
function measureAudioProviderDuration(
  request: Pick<NormalizedGenerationInput, "mediaKind" | "model" | "parameters">,
  media: ProviderMediaResult,
): AudioProviderDurationAudit {
  if (media.kind !== "audio") {
    throw new AudioProviderMediaIntegrityError(
      "AUDIO_RESULT_MEDIA_KIND_INVALID",
      "Audio generation returned a non-audio media result",
    );
  }
  const expectedDuration = request.parameters.originalDurationSeconds;
  if (typeof expectedDuration !== "number"
    || !Number.isSafeInteger(expectedDuration)
    || expectedDuration < 1
    || expectedDuration > 120) {
    throw new AudioProviderMediaIntegrityError(
      "AUDIO_RESULT_QUOTE_DURATION_INVALID",
      "Audio generation has no valid frozen original duration",
    );
  }
  const actualDurationMs = media.actualDurationMs;
  if (typeof actualDurationMs !== "number"
    || !Number.isSafeInteger(actualDurationMs)
    || actualDurationMs <= 0) {
    throw new AudioProviderMediaIntegrityError(
      "AUDIO_RESULT_DURATION_MISSING",
      "Audio provider result is missing a positive measured duration",
    );
  }
  if (usesProviderReportedDuration(media)
    && actualDurationMs > media.audioDurationPolicy.maxDurationMs) {
    throw new AudioProviderMediaIntegrityError(
      "AUDIO_RESULT_DURATION_OUT_OF_RANGE",
      `Audio provider result exceeds its ${media.audioDurationPolicy.maxDurationMs / 1_000}-second duration limit`,
    );
  }
  const durationDeltaMs = actualDurationMs - expectedDuration * 1_000;
  return { actualDurationMs, durationDeltaMs };
}

function usesProviderReportedDuration(media: ProviderMediaResult): media is ProviderMediaResult & {
  audioDurationPolicy: { source: "provider_reported"; maxDurationMs: number };
} {
  const policy = media.audioDurationPolicy;
  return policy?.source === "provider_reported"
    && Number.isSafeInteger(policy.maxDurationMs)
    && policy.maxDurationMs > 0;
}

/**
 * A nested metadata object with two arbitrary numbers must not masquerade as
 * a subtitle. Require an actual non-empty text cue whose time range is
 * ordered, non-negative, and within the measured provider output duration.
 */
function hasTimedSubtitle(value: unknown, maxDurationSeconds: number, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => hasTimedSubtitle(item, maxDurationSeconds, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (isValidTimedSubtitleCue(record, maxDurationSeconds)) return true;
  return Object.values(record).some((item) => hasTimedSubtitle(item, maxDurationSeconds, depth + 1));
}

function isValidTimedSubtitleCue(record: Record<string, unknown>, maxDurationSeconds: number): boolean {
  const start = findTimestamp(record, ["start", "start_time", "startTime", "begin", "begin_time"]);
  const end = findTimestamp(record, ["end", "end_time", "endTime", "finish", "finish_time"]);
  const text = ["text", "word", "content", "token"]
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return text !== undefined
    && start !== undefined
    && end !== undefined
    && start >= 0
    && end > start
    && end <= maxDurationSeconds;
}

function findTimestamp(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const timestamp = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

export function normalizeGenerationInput(
  input: SubmitGenerationInput,
): NormalizedGenerationInput {
  const mediaKind = input.mediaKind;
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") {
    throw invalidRequest("mediaKind must be image, video, or audio");
  }
  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw invalidRequest("quantity must be a positive integer");
  }
  const productionMode = input.productionMode ?? "full";
  if (productionMode !== "full" && productionMode !== "sample") {
    throw invalidRequest("生产模式只能选择样片或成片");
  }
  if (productionMode === "sample" && mediaKind !== "video") {
    throw invalidRequest("样片模式仅支持视频生成，请改为成片模式或选择视频项");
  }

  const model = requireText(input.model, "model");
  const prompt = requireText(input.prompt, "prompt");
  if (mediaKind === "audio" && prompt.length > AUDIO_MAX_TEXT_PROMPT_LENGTH) {
    throw invalidRequest(`audio prompt must be at most ${AUDIO_MAX_TEXT_PROMPT_LENGTH} characters`);
  }
  let parameters;
  try {
    parameters = normalizeV01Parameters({
      mediaKind,
      model,
      parameters: { ...(input.parameters ?? {}) },
      quantity,
    });
  } catch (error) {
    if (error instanceof V01GenerationContractError) throw invalidRequest(error.message);
    throw error;
  }
  const referenceMediaIds = [...new Set(
    (input.referenceMediaIds ?? []).map((mediaId) => requireText(mediaId, "referenceMediaIds")),
  )];
  const parsedReferenceAssetSnapshots = (input.referenceAssetSnapshots ?? []).map((reference) => {
    if (!(["image", "video", "audio"] as const).includes(reference.kind)) {
      throw invalidRequest("reference kind is invalid");
    }
    const url = requireText(reference.url, "reference.url");
    const mediaId = reference.mediaId?.trim() || undefined;
    const sourceMediaResultId = reference.sourceMediaResultId?.trim() || undefined;
    if (url.startsWith("asset://")) {
      return {
        kind: reference.kind,
        url,
        ...(reference.role?.trim() ? { role: reference.role.trim() } : {}),
        ...(mediaId ? { mediaId } : {}),
        ...(sourceMediaResultId ? { sourceMediaResultId } : {}),
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalidRequest("reference.url must be a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw invalidRequest("reference.url must use HTTP or HTTPS");
    }
    const role = reference.role?.trim();
    return {
      kind: reference.kind,
      url: parsed.toString(),
      ...(role ? { role } : {}),
      ...(mediaId ? { mediaId } : {}),
      ...(sourceMediaResultId ? { sourceMediaResultId } : {}),
    };
  });
  let referenceAssetSnapshots;
  try {
    referenceAssetSnapshots = normalizeV01References(mediaKind, parsedReferenceAssetSnapshots, model);
    if (mediaKind === "audio") assertAudioSource(parameters, referenceAssetSnapshots);
  } catch (error) {
    if (error instanceof V01GenerationContractError) {
      throw controlAssetInvalidUsage(error.message);
    }
    throw error;
  }
  const episodeId = optionalRequiredText(input.episodeId, "episodeId");
  const sceneId = optionalRequiredText(input.sceneId, "sceneId");
  const shotId = optionalRequiredText(input.shotId, "shotId");
  const targetAssetEntityId = optionalRequiredText(
    input.targetAssetEntityId,
    "targetAssetEntityId",
  );
  const targetAssetVariantId = optionalRequiredText(
    input.targetAssetVariantId,
    "targetAssetVariantId",
  );

  const normalizedWithoutTier = {
    projectId: requireText(input.projectId, "projectId"),
    ...(episodeId ? { episodeId } : {}),
    ...(sceneId ? { sceneId } : {}),
    ...(shotId ? { shotId } : {}),
    ...(targetAssetEntityId ? { targetAssetEntityId } : {}),
    ...(targetAssetVariantId ? { targetAssetVariantId } : {}),
    mediaKind,
    model,
    prompt,
    ...(input.promptCompilation ? { promptCompilation: input.promptCompilation } : {}),
    parameters,
    referenceMediaIds,
    referenceAssetSnapshots,
    quantity,
    productionMode,
    clientIdempotencyKey: requireText(input.clientIdempotencyKey, "clientIdempotencyKey"),
  };
  // Public web routes require tier_id at their schema boundary. Keep the
  // service compatible with existing CLI/assistant adapters and historical
  // unit fixtures; a real repository still rejects this sentinel unless a
  // current pricing-rule tier can be resolved.
  const tierId = input.tierId?.trim() || "legacy-unresolved";
  return {
    ...normalizedWithoutTier,
    tierId,
  };
}

export function hashGenerationRequest(input: NormalizedGenerationInput): string {
  const { clientIdempotencyKey: _key, ...request } = input;
  return createHash("sha256").update(JSON.stringify(sortJsonValue(request))).digest("hex");
}

/**
 * Quotes created before P-02b did not carry `productionMode` in their identity.
 * This hash exists only for the short compatibility window that lets an
 * already-issued full-mode quote complete; sample mode never enters this path.
 */
export function hashLegacyFullGenerationRequest(input: NormalizedGenerationInput): string {
  if (input.productionMode !== "full") {
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      "历史报价兼容只适用于成片模式",
      400,
    );
  }
  const {
    clientIdempotencyKey: _key,
    productionMode: _productionMode,
    ...request
  } = input;
  return createHash("sha256").update(JSON.stringify(sortJsonValue(request))).digest("hex");
}

/** Ordered item ids are part of the authorization proof, not an incidental UI detail. */
export function hashGenerationBatch(input: BatchGenerationSubmitInput): string {
  return createHash("sha256").update(JSON.stringify({
    projectId: input.projectId,
    expectedTotalEstimatedCostFen: input.expectedTotalEstimatedCostFen,
    productionMode: input.productionMode ?? "full",
    items: input.items.map((item) => ({ itemId: item.itemId, quoteId: item.quoteId })),
  })).digest("hex");
}

function unwrapCreateResult(result: CreateGenerationResult): GenerationView {
  if (result.outcome === "created" || result.outcome === "existing") return result.view;
  if (result.outcome === "idempotency_conflict") {
    throw new GenerationError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different request",
      409,
    );
  }
  throw new GenerationError(
    "GENERATION_BUDGET_EXCEEDED",
    "The approved generation budget would be exceeded",
    402,
  );
}

function buildStoragePath(
  context: RecoverableGenerationContext,
  mediaKind: "image" | "video" | "audio",
  index: number,
  extension: string,
  leaseOwner?: string,
): string {
  const suffix = safePathSegment(extension.toLowerCase().replace(/^\./, "")) || "bin";
  const projectPrefix = ["projects", safePathSegment(context.request.input.projectId)];
  const baseTaskId = safePathSegment(context.attempt.providerTaskId ?? context.attempt.id);
  // A TOS PutObject cannot be fenced by the PostgreSQL lease after it has
  // left this process. Scope the object key to the worker lease identity so a
  // late upload from an expired worker cannot overwrite its successor's live
  // bytes. The hash avoids exposing the worker identifier in object paths;
  // retries by the same live worker remain idempotent.
  const writerEpoch = leaseOwner
    ? createHash("sha256").update(leaseOwner).digest("hex").slice(0, 16)
    : null;
  const taskId = writerEpoch ? `${baseTaskId}-${writerEpoch}` : baseTaskId;
  if (context.request.input.shotId) {
    return [
      ...projectPrefix,
      "shots",
      safePathSegment(context.request.input.shotId),
      mediaKind,
      taskId,
      `${index}.${suffix}`,
    ].join("/");
  }
  return [
    ...projectPrefix,
    "assets",
    safePathSegment(context.request.input.targetAssetEntityId ?? context.request.id),
    mediaKind,
    taskId,
    `${index}.${suffix}`,
  ].join("/");
}

function safePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function isTerminal(context: RecoverableGenerationContext): boolean {
  return ["succeeded", "failed", "cancelled"].includes(context.attempt.status);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw invalidRequest("generation request contains a non-finite number");
  }
  return value;
}

function requireText(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw invalidRequest(`${field} is required`);
  return normalized;
}

function optionalRequiredText(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requireText(value, field);
}

function invalidRequest(message: string): GenerationError {
  return new GenerationError("INVALID_GENERATION_REQUEST", message, 400);
}

function controlAssetInvalidUsage(message: string): GenerationError {
  return new GenerationError("control_asset_invalid_usage", message, 422);
}

function notFoundError(): GenerationError {
  return new GenerationError("GENERATION_NOT_FOUND", "Generation request was not found", 404);
}

function requireTemporaryMediaUrl(media: ProviderMediaResult): string {
  if (typeof media.temporaryUrl === "string" && media.temporaryUrl.trim()) return media.temporaryUrl;
  throw new Error("Provider media result carries neither a temporary URL nor inline content");
}

function storedMediaKindForProviderResult(media: ProviderMediaResult): GenerationMediaKind {
  if (media.kind === "video") return "video";
  if (media.kind === "audio") return "audio";
  return "image";
}

function buildAigcContentId(attemptId: string, resultIndex: number): string {
  return `generation-attempt:${attemptId}:media:${resultIndex}`;
}

/**
 * C2PA/provider receipts and the platform-applied GB marker are independent
 * systems. Preserve an observed provider receipt as an audit hint while the
 * primary evidence records the platform writer that was just verified.
 */
function preserveProviderEvidence(
  providerMetadata: AigcComplianceMetadata | undefined,
  platformMetadata: AigcComplianceMetadata,
): AigcComplianceMetadata {
  const providerAudit: Record<string, unknown> = { ...(providerMetadata ?? {}) };
  delete providerAudit.providerOriginEvidence;
  return {
    ...providerAudit,
    ...platformMetadata,
    ...(providerMetadata?.aigcMetadataEvidence === "provider_response"
      ? { upstreamAigcMetadataEvidence: "provider_response" }
      : {}),
  };
}
