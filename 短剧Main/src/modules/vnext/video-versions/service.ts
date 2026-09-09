/**
 * vNext video segment version service.
 *
 * Owns the lifecycle from a saved video segment → modify/extend draft →
 * (after the existing human-confirmed paid generation flow succeeds) a new
 * immutable version row.
 *
 * Paid-safety guarantees:
 * - Draft creation only writes reviewable rows (control package version,
 *   pending intent, change-draft linkage). Zero provider calls.
 * - Confirmation reuses the existing generation-tasks endpoint: exactly one
 *   paid task per (project, actor, client_idempotency_key).
 * - A version row is appended only from a succeeded task whose latest attempt
 *   succeeded with TOS media. Failed tasks never produce version rows and
 *   never touch the origin version.
 * - This module has no provider, upload, reservation, or billing dependency.
 * 例外：只读本地参数端口（单方法、无网络、无计费），不构成上述依赖。
 */

import { AppError, NotFoundError, UnprocessableEntityError } from "../../../shared/errors.js";
import type { ControlPackage, ControlPackageDraft } from "../control-packages/types.js";
import type { ControlPackageService } from "../control-packages/service.js";
import type { GenerationIntentService } from "../generation-intents/service.js";
import type { PendingIntentStore } from "../generation-intents/repository.js";
import type { PendingGenerationIntent } from "../generation-intents/types.js";
import type { VnextGenerationStore } from "../generation/repository.js";
import type {
  VnextVideoChangeDraft,
  VnextVideoChangeDraftInput,
  VnextVideoVersion,
} from "./types.js";
import type { VnextVideoChangeDraftStore, VnextVideoVersionStore } from "./repository.js";

export interface VnextVideoVersionProjectAccess {
  assertRead(actorId: string, projectId: string): Promise<void>;
  assertWrite(actorId: string, projectId: string): Promise<void>;
}

export interface LockedTaskParameterSource {
  lockedTaskParameters(): Record<string, unknown>;
}

export interface VnextVideoVersionServiceOptions {
  versions: VnextVideoVersionStore;
  drafts: VnextVideoChangeDraftStore;
  access: VnextVideoVersionProjectAccess;
  controlPackages: Pick<ControlPackageService, "save">;
  intents: Pick<GenerationIntentService, "createPending">;
  pendingIntents: Pick<PendingIntentStore, "findById">;
  generationTasks: Pick<VnextGenerationStore, "getTaskView">;
  lockedTaskParameters: LockedTaskParameterSource;
}

export interface VnextVideoChangeDraftResult {
  draft: VnextVideoChangeDraft;
  intent: PendingGenerationIntent;
  /** The control package snapshot written for this draft; null on replay/crash recovery. */
  controlPackage: ControlPackage | null;
  created: boolean;
}

export class VnextVideoVersionService {
  constructor(private readonly options: VnextVideoVersionServiceOptions) {}

  /** Refresh recovery: full version chains with task/cost/TOS media facts. */
  async listVersions(actorId: string, projectId: string): Promise<{ items: VnextVideoVersion[] }> {
    await this.options.access.assertRead(actorId, projectId);
    return { items: await this.options.versions.listByProject(projectId) };
  }

  /**
   * Start a modify/extend draft on a saved version.  Snapshots the reviewed
   * inputs into a new control package version, creates the pending intent and
   * the change-draft linkage.  No provider call, upload, reservation, or debit.
   */
  async createChangeDraft(
    actorId: string,
    projectId: string,
    originVersionId: string,
    input: VnextVideoChangeDraftInput,
  ): Promise<VnextVideoChangeDraftResult> {
    await this.options.access.assertWrite(actorId, projectId);
    const key = input.clientIdempotencyKey.trim();
    if (!key) throw new UnprocessableEntityError("确认前必须提供稳定的幂等键");
    const origin = await this.options.versions.findById(originVersionId, projectId);
    if (!origin) throw new NotFoundError("原视频段版本不存在或你没有访问权限");

    // Idempotent replay: the same key returns the same draft + intent without
    // writing another control package version.
    const existing = await this.options.drafts.findByKey(projectId, actorId, key);
    if (existing) {
      const intent = await this.options.pendingIntents.findById(existing.intentId, projectId);
      if (!intent) throw new NotFoundError("修改/续写草稿关联的待确认意图不存在，请刷新");
      return { draft: existing, intent, controlPackage: null, created: false };
    }

    // Crash recovery: an earlier request created the intent but never linked it.
    const unlinkedIntentId = await this.options.drafts.findUnlinkedIntentIdByKey(projectId, actorId, key);
    if (unlinkedIntentId) {
      const intent = await this.options.pendingIntents.findById(unlinkedIntentId, projectId);
      if (!intent) throw new NotFoundError("修改/续写草稿关联的待确认意图不存在，请刷新");
      const { draft } = await this.options.drafts.create({
        projectId, actorId, originVersionId: origin.id, changeType: input.changeType,
        intentId: intent.id, clientIdempotencyKey: key,
      });
      return { draft, intent, controlPackage: null, created: true };
    }

    const controlPackage = await this.options.controlPackages.save(
      actorId,
      projectId,
      draftFields(input, this.options.lockedTaskParameters),
    );
    // createPending snapshots the just-saved latest control package and runs
    // the existing budget + reference authorization gates. A key collision
    // with a different package raises a conflict instead of double-creating.
    const { intent } = await this.options.intents.createPending(actorId, projectId, key);
    const { draft } = await this.options.drafts.create({
      projectId, actorId, originVersionId: origin.id, changeType: input.changeType,
      intentId: intent.id, clientIdempotencyKey: key,
    });
    return { draft, intent, controlPackage, created: true };
  }

  /**
   * Append a version from a succeeded generation task.  Idempotent on
   * (project, source_attempt): re-attaching the same succeeded attempt replays
   * the existing version.  When the task came from a change draft, the new
   * version grows the origin's chain with that change type; otherwise it
   * registers version 1 of a new chain.
   */
  async attachSucceededTask(
    actorId: string,
    projectId: string,
    taskId: string,
  ): Promise<{ version: VnextVideoVersion; created: boolean }> {
    await this.options.access.assertWrite(actorId, projectId);
    const view = await this.options.generationTasks.getTaskView(taskId, projectId);
    if (!view) throw new NotFoundError("生成任务不存在或你没有访问权限");
    const { task, latestAttempt } = view;
    if (task.status !== "succeeded" || !latestAttempt || latestAttempt.status !== "succeeded" || latestAttempt.tosMedia.length === 0) {
      throw new AppError(
        422,
        "video_version_source_not_succeeded",
        "只有生成成功并已保存媒体的任务才能注册为视频段版本；失败任务不会产生新版本，也不会影响原版本",
      );
    }

    const linkage = await this.options.drafts.findByIntentId(task.intentId);
    if (linkage) {
      const origin = await this.options.versions.findById(linkage.originVersionId, projectId);
      if (!origin) throw new NotFoundError("修改/续写草稿关联的原视频段版本不存在");
    }

    return this.options.versions.create({
      projectId,
      actorId,
      changeType: linkage?.changeType ?? "register",
      originVersionId: linkage?.originVersionId ?? null,
      sourceTaskId: task.id,
      sourceAttemptId: latestAttempt.id,
      controlPackageId: task.controlPackageId,
      controlPackageVersion: task.controlPackageVersion,
      provider: task.provider,
      model: task.model,
      prompt: task.prompt,
      parameters: task.parameters,
      tosMedia: latestAttempt.tosMedia,
      estimatedCostFen: task.estimatedCostFen,
      actualCostFen: null,
    });
  }
}

function draftFields(
  input: VnextVideoChangeDraftInput,
  lockedTaskParameters: LockedTaskParameterSource,
): ControlPackageDraft {
  return {
    references: input.references,
    finalPrompt: input.finalPrompt,
    model: input.model,
    parameters: {
      ...input.parameters,
      ...lockedTaskParameters.lockedTaskParameters(),
    },
    noBgm: input.noBgm,
    modelAvailability: input.modelAvailability,
    estimatedCostFen: input.estimatedCostFen,
  };
}
