import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Database } from "../../db/client.js";
import type { AssetUploadTaskRow } from "../../db/schema.js";
import { AssetEntityRepository } from "../../repositories/assetEntityRepository.js";
import { ImageAssetIngestService } from "../../services/assetIngestService.js";
import { VectorSyncService } from "../../services/vectorSyncService.js";
import {
  AppError,
  BadRequestError,
  NotFoundError,
  publicMessage,
} from "../../shared/errors.js";
import { cleanupUpload, extensionOf, IMAGE_EXTENSIONS, saveUpload } from "../../shared/files.js";
import {
  publicVolcAssetFailureCode,
  publicVolcAssetFailureMessage,
} from "../assets/volcAssetRegistry.js";
import { SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS } from "../seedance-assets/policy.js";
import type {
  SeedanceAssetRegistrationPort,
  SeedanceAssetRegistrationView,
} from "../seedance-assets/types.js";
import { inspectUploadedImage, type UploadedImageInfo } from "../assets/mediaUpload.js";
import {
  PostgresAssetUploadTaskRepository,
  type AssetUploadTaskRepository,
} from "./repository.js";
import {
  AssetRegistrationSchemaService,
  parseRegistrationFormSnapshot,
  registrationFormSnapshot,
  type AssetRegistrationForm,
} from "./registrationSchema.js";
import { RegisteredImageAssetService } from "./registeredImage.js";
import type {
  AssetUploadNotificationView,
  AssetUploadRegistrationResultView,
  AssetUploadTaskView,
} from "./types.js";

export interface SubmitAssetUploadInput {
  fileName: string;
  declaredContentType: string;
  content: Buffer;
  assetKindHint?: string | null;
  sourceProjectName?: string | null;
  clientIdempotencyKey?: string | null;
  registration?: unknown;
}

export interface AssetUploadTaskServiceDependencies {
  registrationSchema?: Pick<AssetRegistrationSchemaService, "validate">;
  registeredImages?: Pick<RegisteredImageAssetService, "ingest">;
  seedance?: Pick<SeedanceAssetRegistrationPort, "getAssetMedia" | "registerAssetMedia">;
  legacyIngest?: Pick<ImageAssetIngestService, "ingest">;
  queueVectorSync?: (entityId: string) => void;
  inspectImage?: (content: Buffer) => Promise<UploadedImageInfo>;
}

export class AssetUploadTaskService {
  private readonly tasks: AssetUploadTaskRepository;
  private readonly registrationSchema: Pick<AssetRegistrationSchemaService, "validate">;
  private readonly registeredImages: Pick<RegisteredImageAssetService, "ingest">;
  private readonly seedance: Pick<
    SeedanceAssetRegistrationPort,
    "getAssetMedia" | "registerAssetMedia"
  >;
  private readonly legacyIngest: Pick<ImageAssetIngestService, "ingest">;
  private readonly queueVectorSyncOverride?: (entityId: string) => void;
  private readonly inspectImage: (content: Buffer) => Promise<UploadedImageInfo>;

  constructor(
    private readonly db: Database,
    tasks?: AssetUploadTaskRepository,
    dependencies: AssetUploadTaskServiceDependencies = {},
  ) {
    this.tasks = tasks ?? new PostgresAssetUploadTaskRepository(db);
    this.registrationSchema = dependencies.registrationSchema ?? new AssetRegistrationSchemaService(db);
    this.registeredImages = dependencies.registeredImages ?? new RegisteredImageAssetService(db);
    this.seedance = dependencies.seedance ?? unavailableSeedanceRegistration();
    this.legacyIngest = dependencies.legacyIngest ?? new ImageAssetIngestService(db);
    this.queueVectorSyncOverride = dependencies.queueVectorSync;
    this.inspectImage = dependencies.inspectImage ?? inspectUploadedImage;
  }

  /**
   * Accept an image upload: stage the bytes on local disk, persist the queued
   * fact and return — the paid/slow work (vision + TOS + rows) happens on the
   * worker side. Excel stays on the synchronous ingest route on purpose.
   */
  async submitImage(actorId: string, input: SubmitAssetUploadInput): Promise<AssetUploadTaskView> {
    const extension = extensionOf(input.fileName);
    const isImage = IMAGE_EXTENSIONS.has(extension) || input.declaredContentType.startsWith("image/");
    if (!isImage) throw new BadRequestError("只支持常见图片文件;Excel 批量导入请使用原有的同步导入入口");
    if (!input.content.length) throw new BadRequestError("上传文件为空");
    const registrationMode = input.registration !== undefined || input.clientIdempotencyKey !== undefined;
    if (registrationMode && (!input.registration || !input.clientIdempotencyKey)) {
      throw new AppError(400, "registration_schema_mismatch", "登记字段已更新，请刷新页面后重新提交");
    }
    const registration = registrationMode
      ? await this.registrationSchema.validate(input.registration)
      : null;
    if (registration) await this.inspectImage(input.content);
    const snapshot = registration ? registrationFormSnapshot(registration) : null;
    const contentSha256 = registration
      ? createHash("sha256").update(input.content).digest("hex")
      : null;
    const requestSha256 = registration && contentSha256
      ? requestHash(contentSha256, snapshot!)
      : null;
    const stagedPath = await saveUpload(input.fileName, input.content);
    let task: AssetUploadTaskRow;
    try {
      const result = await this.tasks.createOrReuse({
        userId: actorId,
        originalFileName: input.fileName,
        contentType: input.declaredContentType || null,
        assetKindHint: registration?.assetKind ?? input.assetKindHint ?? null,
        clientIdempotencyKey: input.clientIdempotencyKey ?? null,
        contentSha256,
        requestSha256,
        registrationForm: snapshot,
        stagedPath,
        stagedBytes: input.content.length,
      });
      task = result.task;
      if (!result.created) await cleanupUpload(stagedPath).catch(() => false);
    } catch (error) {
      await cleanupUpload(stagedPath).catch(() => false);
      throw error;
    }
    return this.toTaskView(task);
  }

  async listActive(actorId: string): Promise<AssetUploadTaskView[]> {
    const rows = await this.tasks.listActiveByUser(actorId);
    return Promise.all(rows.map((row) => this.toTaskView(row)));
  }

  async get(actorId: string, taskId: string): Promise<AssetUploadTaskView> {
    const row = await this.tasks.getByUser(actorId, taskId);
    if (!row) throw new NotFoundError("上传任务不存在");
    return this.toTaskView(row);
  }

  async listNotifications(actorId: string, limit: number): Promise<AssetUploadNotificationView[]> {
    const rows = await this.tasks.listUnacknowledgedTerminal(actorId, limit);
    return Promise.all(rows.map(async (row) => ({
      id: row.id,
      status: row.status as "succeeded" | "failed",
      originalFileName: row.originalFileName,
      resultAssetEntityId: row.resultAssetEntityId,
      resultAssetMediaId: row.resultAssetMediaId,
      resultAssetName: row.resultAssetName,
      seedanceRegistration: await this.registrationResult(row),
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    })));
  }

  async acknowledge(actorId: string, taskId: string): Promise<void> {
    await this.tasks.acknowledge(actorId, taskId);
  }

  /** Worker side: claim one queued task and run it to a terminal state. Returns false when the queue is empty. */
  async processNextQueued(): Promise<boolean> {
    const task = await this.tasks.claimNextQueued();
    if (!task) return false;
    await this.processClaimed(task);
    return true;
  }

  /** Restart recovery: interrupted rows go back to queued before the first drain. */
  async requeueInterrupted(): Promise<number> {
    return this.tasks.requeueInterrupted();
  }

  private async processClaimed(task: AssetUploadTaskRow): Promise<void> {
    const started = Date.now();
    const registration = parseRegistrationFormSnapshot(task.registrationForm);
    if (registration) {
      await this.processRegisteredTask(task, registration, started);
      return;
    }
    if (task.registrationForm) {
      await this.tasks.markFailed(task.id, {
        errorCode: "registration_schema_mismatch",
        errorMessage: "登记字段已更新，请刷新页面后重新提交",
        durationSeconds: secondsSince(started),
        finishedAt: new Date(),
      });
      await cleanupUpload(task.stagedPath).catch(() => false);
      return;
    }
    try {
      const content = await this.readStagedFile(task, started);
      if (!content) return;
      const item = await this.legacyIngest.ingest({
        ownerUserId: task.userId,
        visibility: "personal",
        fileName: task.originalFileName,
        content,
        contentType: task.contentType,
        sourceProjectName: null,
        batchSize: 5,
        assetKindHint: task.assetKindHint,
      }, false);
      await this.tasks.markSucceeded(task.id, {
        resultAssetEntityId: item.id,
        resultAssetName: item.displayName ?? item.name,
        durationSeconds: secondsSince(started),
        finishedAt: new Date(),
      });
      // Vector search is a rebuildable projection, never part of the task's
      // terminal fact — mirror the sync route's best-effort background sync.
      this.queueVectorSync(item.id);
    } catch (error) {
      const failure = honestFailure(error);
      await this.tasks.markFailed(task.id, {
        errorCode: failure.code,
        errorMessage: failure.message,
        durationSeconds: secondsSince(started),
        finishedAt: new Date(),
      });
    } finally {
      await cleanupUpload(task.stagedPath).catch(() => false);
    }
  }

  private async processRegisteredTask(
    task: AssetUploadTaskRow,
    registration: AssetRegistrationForm,
    started: number,
  ): Promise<void> {
    let local = task.resultAssetEntityId && task.resultAssetMediaId
      ? {
          assetId: task.resultAssetEntityId,
          mediaId: task.resultAssetMediaId,
          name: task.resultAssetName ?? registration.name,
        }
      : null;
    try {
      if (!local) {
        const content = await this.readStagedFile(task, started);
        if (!content) return;
        local = await this.registeredImages.ingest({
          taskId: task.id,
          actorId: task.userId,
          fileName: task.originalFileName,
          declaredContentType: task.contentType,
          content,
          form: registration,
        });
        // Crash boundary: the durable local result is recorded before any
        // remote request, so a restarted worker never uploads the image twice.
        await this.tasks.recordLocalResult(task.id, {
          resultAssetEntityId: local.assetId,
          resultAssetMediaId: local.mediaId,
          resultAssetName: local.name,
        });
      }

      const seedance = await this.registerSeedanceOnce(task.userId, local.assetId, local.mediaId);
      await this.tasks.markSucceeded(task.id, {
        resultAssetEntityId: local.assetId,
        resultAssetMediaId: local.mediaId,
        resultAssetName: local.name,
        resultRegistrationId: seedance.id,
        resultRegistrationStatus: seedance.status,
        registrationErrorCode: seedance.latestErrorCode,
        registrationErrorMessage: seedance.latestErrorMessage,
        durationSeconds: secondsSince(started),
        finishedAt: new Date(),
      });
      this.queueVectorSync(local.assetId);
    } catch (error) {
      if (local) {
        const failure = seedanceFallback(error);
        await this.tasks.markSucceeded(task.id, {
          resultAssetEntityId: local.assetId,
          resultAssetMediaId: local.mediaId,
          resultAssetName: local.name,
          resultRegistrationId: null,
          resultRegistrationStatus: "unavailable",
          registrationErrorCode: failure.code,
          registrationErrorMessage: failure.message,
          durationSeconds: secondsSince(started),
          finishedAt: new Date(),
        });
        this.queueVectorSync(local.assetId);
      } else {
        const failure = honestFailure(error);
        await this.tasks.markFailed(task.id, {
          errorCode: failure.code,
          errorMessage: failure.message,
          durationSeconds: secondsSince(started),
          finishedAt: new Date(),
        });
      }
    } finally {
      await cleanupUpload(task.stagedPath).catch(() => false);
    }
  }

  private async registerSeedanceOnce(
    actorId: string,
    assetId: string,
    mediaId: string,
  ): Promise<SeedanceAssetRegistrationView> {
    try {
      return await this.seedance.getAssetMedia(actorId, assetId, mediaId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    return this.seedance.registerAssetMedia(actorId, assetId, mediaId);
  }

  /** Returns null after marking the task failed when the staged file is gone. */
  private async readStagedFile(task: AssetUploadTaskRow, started: number): Promise<Buffer | null> {
    try {
      return await readFile(task.stagedPath);
    } catch {
      await this.tasks.markFailed(task.id, {
        errorCode: "staged_file_missing",
        errorMessage: "服务重启后暂存文件已丢失,请重新上传该图片",
        durationSeconds: secondsSince(started),
        finishedAt: new Date(),
      });
      return null;
    }
  }

  private queueVectorSync(entityId: string): void {
    if (this.queueVectorSyncOverride) {
      this.queueVectorSyncOverride(entityId);
      return;
    }
    setImmediate(() => {
      void (async () => {
        const repository = new AssetEntityRepository(this.db);
        const row = await repository.getById(entityId);
        if (!row) return;
        await new VectorSyncService().syncEntity(repository.toData(row));
      })().catch((error: unknown) => console.error("[asset-upload] vector sync failed", error));
    });
  }

  private async toTaskView(task: AssetUploadTaskRow): Promise<AssetUploadTaskView> {
    const [queuePosition, eta] = await Promise.all([
      this.tasks.queuePositionFor(task),
      this.tasks.estimatedDuration(),
    ]);
    const registration = parseRegistrationFormSnapshot(task.registrationForm);
    return {
      id: task.id,
      status: task.status as AssetUploadTaskView["status"],
      originalFileName: task.originalFileName,
      assetKindHint: task.assetKindHint,
      assetKind: registration?.assetKind ?? task.assetKindHint,
      factorType: registration?.factorType ?? null,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      queuePosition,
      estimatedDurationSeconds: task.status === "queued" || task.status === "processing" ? eta.seconds : null,
      estimatedDurationSampleCount: eta.sampleCount,
      result: task.resultAssetEntityId
        ? {
            asset: {
              id: task.resultAssetEntityId,
              mediaId: task.resultAssetMediaId,
              scope: "personal",
              status: "approved",
            },
            seedanceRegistration: await this.registrationResult(task),
          }
        : null,
      error: task.errorMessage
        ? { code: task.errorCode, message: task.errorMessage }
        : null,
    };
  }

  private async registrationResult(
    task: AssetUploadTaskRow,
  ): Promise<AssetUploadRegistrationResultView | null> {
    if (!task.resultRegistrationStatus && !task.resultRegistrationId) return null;
    if (task.resultAssetEntityId && task.resultAssetMediaId && task.resultRegistrationId) {
      try {
        return toRegistrationResult(await this.seedance.getAssetMedia(
          task.userId,
          task.resultAssetEntityId,
          task.resultAssetMediaId,
        ));
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          return fallbackRegistrationResult(task);
        }
      }
    }
    return fallbackRegistrationResult(task);
  }
}

/**
 * User-facing failure copy: AppError messages are already written for users;
 * anything else stays generic instead of leaking provider or storage internals.
 */
function honestFailure(error: unknown): { code: string | null; message: string } {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: publicMessage(
        error,
        "图片入库没成：请稍后重试；多次失败可换一张图片。",
      ),
    };
  }
  return {
    code: "asset_registration_failed",
    message: "图片入库没成：请稍后重试；多次失败可换一张图片。",
  };
}

function secondsSince(started: number): number {
  return Math.max(0, Math.round((Date.now() - started) / 1_000));
}

function seedanceFallback(error: unknown): { code: string; message: string } {
  if (error instanceof AppError && error.code === "seedance_asset_registration_unavailable") {
    return {
      code: "ASSET_REGISTRY_UNAVAILABLE",
      message: "图片已进入个人资产库：素材登记没成，可稍后重试。",
    };
  }
  if (error instanceof AppError) {
    return {
      code: "ASSET_REGISTRY_UNAVAILABLE",
      message: "图片已进入个人资产库：素材登记没成，可稍后重试。",
    };
  }
  return {
    code: "ASSET_REGISTRY_UNAVAILABLE",
    message: "图片已进入个人资产库：素材登记没成，可稍后重试。",
  };
}

function requestHash(contentSha256: string, snapshot: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${contentSha256}\n${stableStringify(snapshot)}`)
    .digest("hex");
}

function stableStringify(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(",")}]`;
  if (input && typeof input === "object") {
    return `{${Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableStringify(value)}`)
      .join(",")}}`;
  }
  return JSON.stringify(input);
}

function toRegistrationResult(
  view: SeedanceAssetRegistrationView,
): AssetUploadRegistrationResultView {
  const freshUntil = view.lastVerifiedAt
    ? new Date(view.lastVerifiedAt.getTime() + SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS)
    : null;
  const canUse = view.status === "active"
    && Boolean(view.remoteAssetId)
    && Boolean(freshUntil && freshUntil.getTime() >= Date.now());
  const errorCode = view.latestErrorCode
    ? publicVolcAssetFailureCode(view.latestErrorCode)
    : null;
  return {
    id: view.id,
    status: view.status,
    remoteAssetId: view.remoteAssetId,
    lastVerifiedAt: view.lastVerifiedAt,
    freshUntil,
    canUseAsSeedanceReference: canUse,
    nextAction: nextRegistrationAction(view.status, canUse),
    errorCode,
    errorMessage: errorCode ? publicVolcAssetFailureMessage(errorCode) : null,
  };
}

function fallbackRegistrationResult(task: AssetUploadTaskRow): AssetUploadRegistrationResultView | null {
  if (!task.resultRegistrationStatus) return null;
  const errorCode = task.registrationErrorCode
    ? publicVolcAssetFailureCode(task.registrationErrorCode)
    : null;
  return {
    id: task.resultRegistrationId,
    status: task.resultRegistrationStatus as AssetUploadRegistrationResultView["status"],
    remoteAssetId: null,
    lastVerifiedAt: null,
    freshUntil: null,
    canUseAsSeedanceReference: false,
    nextAction: nextRegistrationAction(
      task.resultRegistrationStatus as AssetUploadRegistrationResultView["status"],
      false,
    ),
    errorCode,
    errorMessage: errorCode ? publicVolcAssetFailureMessage(errorCode) : null,
  };
}

function unavailableSeedanceRegistration(): Pick<
  SeedanceAssetRegistrationPort,
  "getAssetMedia" | "registerAssetMedia"
> {
  const unavailable = async (): Promise<never> => {
    throw new AppError(
      503,
      "seedance_asset_registration_unavailable",
      "火山素材注册尚未完成运行时组装，未发送任何请求",
    );
  };
  return {
    getAssetMedia: unavailable,
    registerAssetMedia: unavailable,
  };
}

function nextRegistrationAction(
  status: AssetUploadRegistrationResultView["status"],
  canUse: boolean,
): AssetUploadRegistrationResultView["nextAction"] {
  if (canUse) return null;
  if (status === "processing" || status === "active") return "refresh";
  if (status === "unknown") return "verify";
  if (status === "failed" || status === "unavailable") return "register";
  return null;
}
