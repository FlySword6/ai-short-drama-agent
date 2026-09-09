/**
 * vNext generation service.
 *
 * Owns the lifecycle from confirmed intent → task → attempt execution.
 *
 * Paid-safety guarantees:
 * - A task is created exactly once per (project, actor, client_idempotency_key).
 * - An attempt in `submitting` state becomes unknown_outcome on crash; no auto re-submit.
 * - 429 / provider-rejected → attempt.failed, no automatic retry.
 * - TOS copy success is required before markSucceeded.
 */

import { createHash } from "node:crypto";
import { ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { VnextVideoProvider } from "../providers/videoProvider.js";
import { VnextAttemptLeaseLostError, VnextGenerationError, VnextProviderRequestError } from "./errors.js";
import type { VnextGenerationStore } from "./repository.js";
import type { ControlPackageReference } from "../control-packages/types.js";
import type { VnextGenerationReferenceResolver } from "./references.js";
import { safeMessage } from "./serviceUtils.js";
import type {
  VnextGenerationTaskView,
  VnextProviderResultSnapshot,
  VnextRecoverableAttemptContext,
} from "./types.js";
import { applyNoBgmTemplate } from "../workflows/noBgmTemplate.js";

export interface VnextProjectAccess {
  assertRead(actorId: string, projectId: string): Promise<void>;
  assertWrite(actorId: string, projectId: string): Promise<void>;
}

export interface VnextPendingIntentStore {
  findById(intentId: string, projectId: string): Promise<{
    id: string;
    projectId: string;
    actorId: string;
    controlPackageId: string;
    controlPackageVersion: number;
    finalPrompt: string;
    model: string;
    parameters: Record<string, unknown>;
    noBgm: boolean;
    estimatedCostFen: number;
    references: ControlPackageReference[];
  } | null>;
}

export interface VnextGenerationStorage {
  downloadBytes(url: string, signal?: AbortSignal): Promise<{ content: Buffer; contentType: string; extension: string }>;
  uploadBytes(input: {
    content: Buffer;
    storagePath: string;
    contentType: string;
  }): Promise<{ bucket: string; storagePath: string; storageUrl: string }>;
}

export interface VnextGenerationServiceOptions {
  store: VnextGenerationStore;
  intents: VnextPendingIntentStore;
  access: VnextProjectAccess;
  provider: VnextVideoProvider;
  storage: VnextGenerationStorage;
  referenceResolver: VnextGenerationReferenceResolver;
}

export class VnextGenerationService {
  constructor(private readonly options: VnextGenerationServiceOptions) {}

  /**
   * Confirm a pending intent → create a generation task and first attempt.
   * Idempotent on (projectId, actorId, clientIdempotencyKey).
   */
  async confirmIntent(
    actorId: string,
    projectId: string,
    intentId: string,
    clientIdempotencyKey: string,
  ): Promise<VnextGenerationTaskView> {
    await this.options.access.assertWrite(actorId, projectId);
    const key = clientIdempotencyKey.trim();
    if (!key) {
      throw new VnextGenerationError("VNEXT_GENERATION_IDEMPOTENCY_CONFLICT", "确认前必须提供稳定的幂等键", 422);
    }

    // Fail-closed: capability must be configured before any DB write.
    const capCheck = this.options.provider.checkReadiness();
    if (!capCheck.ok) {
      throw new VnextGenerationError(
        "VNEXT_GENERATION_PROVIDER_NOT_CONFIGURED",
        capCheck.reason,
        422,
      );
    }

    const intent = await this.options.intents.findById(intentId, projectId);
    if (!intent) throw new NotFoundError("待确认意图不存在或已过期");
    if (intent.actorId !== actorId) throw new ForbiddenError("没有权限确认该生成意图");

    const appliedTemplate = applyNoBgmTemplate({
      prompt: intent.finalPrompt,
      noBgm: intent.noBgm,
      parameters: intent.parameters,
    });
    const resolvedParams = this.options.provider.resolveParameters(intent.parameters);

    const { task } = await this.options.store.createTask({
      projectId,
      actorId,
      intentId,
      clientIdempotencyKey: key,
      controlPackageId: intent.controlPackageId,
      controlPackageVersion: intent.controlPackageVersion,
      references: intent.references,
      provider: this.options.provider.id,
      model: capCheck.modelId,
      prompt: appliedTemplate.prompt,
      noBgm: intent.noBgm,
      parameters: {
        ...resolvedParams,
        generateAudio: appliedTemplate.generateAudio,
      },
      estimatedCostFen: intent.estimatedCostFen,
    });

    const view = await this.options.store.getTaskView(task.id, projectId);
    if (!view) throw new NotFoundError("生成任务创建后无法读取，请刷新");
    return view;
  }

  async getTaskStatus(actorId: string, projectId: string, taskId: string): Promise<VnextGenerationTaskView> {
    await this.options.access.assertRead(actorId, projectId);
    const view = await this.options.store.getTaskView(taskId, projectId);
    if (!view) throw new NotFoundError("生成任务不存在");
    return view;
  }

  /**
   * Worker entry point.  Caller must hold the attempt's lease.
   */
  async runRecoverableAttempt(
    attemptId: string,
    signal?: AbortSignal,
    leaseOwner?: string,
  ): Promise<void> {
    try {
      const ctx = await this.options.store.getRecoverableContext(attemptId);
      if (!ctx) throw new NotFoundError(`Attempt ${attemptId} not found`);

      const { status } = ctx.attempt;
      if (isTerminal(status)) return;

      switch (status) {
        case "created":
          await this.submitAttempt(ctx, signal, leaseOwner);
          break;
        case "submitting":
          // Crashed after the paid POST; do not auto-resend.
          await this.options.store.markUnknownOutcome(
            attemptId,
            "Provider submission may have been accepted; explicit human re-confirmation required",
            leaseOwner,
          );
          break;
        case "provider_queued":
        case "provider_running":
          await this.pollAttempt(ctx, signal, leaseOwner);
          break;
        case "provider_succeeded":
        case "copying_to_tos":
          await this.persistToTos(ctx, signal, leaseOwner);
          break;
        default:
          break;
      }
    } catch (error) {
      if (error instanceof VnextAttemptLeaseLostError) return;
      throw error;
    }
  }

  // ─── Phase handlers ───────────────────────────────────────────────────────

  private async submitAttempt(
    ctx: VnextRecoverableAttemptContext,
    signal?: AbortSignal,
    leaseOwner?: string,
  ): Promise<void> {
    const { task, attempt } = ctx;
    const references = await this.options.referenceResolver.resolve(task.projectId, task.references);
    const params = task.parameters as {
      ratio?: string;
      resolution?: string;
      durationSeconds?: number;
      generateAudio?: boolean;
    };
    await this.options.store.markSubmitting(attempt.id, leaseOwner);
    let submitResult;
    try {
      submitResult = await this.options.provider.submit(
        {
          prompt: task.prompt,
          ratio: params.ratio ?? "9:16",
          resolution: params.resolution ?? "720p",
          durationSeconds: params.durationSeconds ?? 4,
          nativeAudio: params.generateAudio ?? true,
          references: references.map((reference) => ({
            kind: reference.kind,
            url: reference.url,
            ...(reference.durationSeconds === undefined ? {} : { durationSeconds: reference.durationSeconds }),
          })),
        },
        signal,
      );
    } catch (error) {
      if (error instanceof VnextProviderRequestError) {
        if (error.outcome === "rejected") {
          await this.options.store.markFailed({
            attemptId: attempt.id,
            errorCode: error.providerCode ?? "PROVIDER_REJECTED",
            errorMessage: error.message,
            leaseOwner,
          });
        } else {
          // outcome === "unknown": submission may or may not have landed.
          await this.options.store.markUnknownOutcome(attempt.id, error.message, leaseOwner);
        }
      } else {
        const violation = this.options.provider.isLocalContractViolation(error);
        if (violation.violated) {
          await this.options.store.markFailed({
            attemptId: attempt.id,
            errorCode: violation.code,
            errorMessage: safeMessage(error),
            leaseOwner,
          });
        } else {
          await this.options.store.markUnknownOutcome(attempt.id, safeMessage(error), leaseOwner);
        }
      }
      return;
    }

    await this.options.store.markProviderQueued(attempt.id, submitResult.providerTaskId, submitResult.rawStatus, leaseOwner);
  }

  private async pollAttempt(
    ctx: VnextRecoverableAttemptContext,
    signal?: AbortSignal,
    leaseOwner?: string,
  ): Promise<void> {
    const { attempt } = ctx;
    if (!attempt.providerTaskId) {
      await this.options.store.markFailed({
        attemptId: attempt.id,
        errorCode: "PROVIDER_TASK_ID_MISSING",
        errorMessage: "Provider task id missing; cannot poll",
        leaseOwner,
      });
      return;
    }

    let result;
    try {
      result = await this.options.provider.query(attempt.providerTaskId, signal);
    } catch (error) {
      await this.options.store.recordPollFailure(attempt.id, safeMessage(error), leaseOwner);
      return;
    }

    if (result.status === "pending" || result.status === "running") {
      await this.options.store.markProviderProgress(attempt.id, result.rawStatus, leaseOwner);
      return;
    }

    if (result.status === "failed") {
      await this.options.store.markFailed({
        attemptId: attempt.id,
        errorCode: result.errorCode ?? "PROVIDER_TASK_FAILED",
        errorMessage: result.errorMessage ?? "Provider generation failed",
        leaseOwner,
      });
      return;
    }

    // status === "succeeded"
    if (result.mediaUrls.length === 0) {
      await this.options.store.markFailed({
        attemptId: attempt.id,
        errorCode: "PROVIDER_RESULT_MISSING",
        errorMessage: "Provider task succeeded without downloadable media",
        leaseOwner,
      });
      return;
    }

    const snapshot: VnextProviderResultSnapshot = {
      status: "succeeded",
      rawStatus: result.rawStatus,
      providerTaskId: result.providerTaskId,
      mediaUrls: result.mediaUrls,
      actualModelId: result.actualModelId,
      durationSeconds: result.durationSeconds,
    };
    await this.options.store.markProviderSucceeded(attempt.id, snapshot, leaseOwner);

    const refreshed = await this.options.store.getRecoverableContext(attempt.id);
    if (refreshed) await this.persistToTos(refreshed, signal, leaseOwner);
  }

  private async persistToTos(
    ctx: VnextRecoverableAttemptContext,
    signal?: AbortSignal,
    leaseOwner?: string,
  ): Promise<void> {
    const { task, attempt } = ctx;
    const providerResult = attempt.providerResult;
    if (!providerResult || providerResult.status !== "succeeded" || providerResult.mediaUrls.length === 0) {
      await this.options.store.markFailed({
        attemptId: attempt.id,
        errorCode: "TOS_COPY_PRECONDITION_FAILED",
        errorMessage: "Provider result unavailable for TOS copy",
        leaseOwner,
      });
      return;
    }

    await this.options.store.markCopyingToTos(attempt.id, leaseOwner);

    const alreadyCopied = new Set(attempt.tosMedia.map((m) => m.providerResultKey));

    try {
      for (const [index, url] of providerResult.mediaUrls.entries()) {
        const providerResultKey = buildProviderResultKey(url, index);
        if (alreadyCopied.has(providerResultKey)) continue;

        const downloaded = await this.options.storage.downloadBytes(url, signal);
        const sha256 = createHash("sha256").update(downloaded.content).digest("hex");
        const storagePath = buildStoragePath(task.id, attempt.id, index, downloaded.extension);

        const stored = await this.options.storage.uploadBytes({
          content: downloaded.content,
          storagePath,
          contentType: downloaded.contentType,
        });

        await this.options.store.recordTosMedia(
          attempt.id,
          {
            providerResultKey,
            storageBucket: stored.bucket,
            objectKey: stored.storagePath,
            storageUrl: stored.storageUrl,
            mimeType: downloaded.contentType,
            sha256,
            durationSeconds: providerResult.durationSeconds,
            copiedAt: new Date().toISOString(),
          },
          leaseOwner,
        );
        alreadyCopied.add(providerResultKey);
      }

      if (alreadyCopied.size < providerResult.mediaUrls.length) {
        throw new Error("Not all provider media URLs were copied to TOS");
      }
      await this.options.store.markSucceeded(attempt.id, leaseOwner);
    } catch (error) {
      if (error instanceof VnextAttemptLeaseLostError) throw error;
      // Leave in copying_to_tos for next worker run unless deterministically failed.
      if (isDeterministicStorageError(error)) {
        await this.options.store.markFailed({
          attemptId: attempt.id,
          errorCode: "TOS_COPY_FAILED",
          errorMessage: safeMessage(error),
          leaseOwner,
        });
      }
      // Transient: do not change status; next worker run will retry TOS copy.
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "unknown_outcome";
}

function buildProviderResultKey(url: string, index: number): string {
  return `${index}:${url}`;
}

function buildStoragePath(taskId: string, attemptId: string, index: number, extension: string): string {
  return `vnext/generation/${taskId}/${attemptId}/${index}.${extension}`;
}

function isDeterministicStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("unsupported media type")
    || msg.includes("permission denied")
    || msg.includes("access denied");
}

