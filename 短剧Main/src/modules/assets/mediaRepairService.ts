import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Database } from "../../db/client.js";
import { TosStorage } from "../../integrations/tosStorage.js";
import {
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../shared/errors.js";
import {
  ASSET_MEDIA_DISPLAY_SPECS,
  type AssetMediaDisplaySpec,
} from "./mediaDisplay.js";
import { isAssetImageMediaKind } from "./assetImageKinds.js";
import { diagnoseAssetMedia } from "./mediaHealth.js";
import {
  isLegalBundleMediaForAsset,
  PostgresAssetMediaRepairRepository,
} from "./mediaRepairRepository.js";
import type {
  AssetMediaHealthView,
  AssetMediaRepairActor,
  AssetMediaRepairRenditionUpsert,
  AssetMediaRepairRepositoryPort,
  AssetMediaRepairTaskView,
  AssetMediaStoragePort,
  AssetRepairBundle,
  AssetRepairMediaSnapshot,
  ClaimedAssetMediaRepairTask,
  CreateAssetMediaRepairInput,
} from "./mediaRepairTypes.js";

const SOURCE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const RENDITION_MAX_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_EXPIRES_SECONDS = 300;
const safeImageFormats = new Set(["jpeg", "jpg", "png", "webp", "avif", "gif"]);

export class AssetMediaRepairService {
  constructor(
    private readonly repository: AssetMediaRepairRepositoryPort,
    private readonly storage: AssetMediaStoragePort,
  ) {}

  static fromDatabase(
    db: Database,
    storage: AssetMediaStoragePort = new TosStorage(),
  ): AssetMediaRepairService {
    return new AssetMediaRepairService(
      new PostgresAssetMediaRepairRepository(db),
      storage,
    );
  }

  async health(actor: AssetMediaRepairActor, assetId: string): Promise<AssetMediaHealthView> {
    const bundle = await this.repository.loadVisibleBundle(actor, assetId);
    const canInspectRepairFacts = actor.role === "admin"
      || (bundle.asset.visibility === "personal" && bundle.asset.ownerUserId === actor.id);
    return diagnoseAssetMedia(
      canInspectRepairFacts ? bundle : publicDisplayHealthBundle(bundle),
    );
  }

  async submit(input: CreateAssetMediaRepairInput): Promise<AssetMediaRepairTaskView> {
    await this.repository.requireRepairPermission(input.actor, input.assetId);
    const bundle = await this.repository.loadVisibleBundle(input.actor, input.assetId);
    const mediaIds = normalizeMediaIds(input.mediaIds);
    if (mediaIds) {
      const available = new Set(bundle.media.filter((item) => !item.deletedAt).map((item) => item.id));
      if (mediaIds.some((mediaId) => !available.has(mediaId))) {
        throw new UnprocessableEntityError("修复清单里有不属于这件资产的素材");
      }
    }
    const health = diagnoseAssetMedia(bundle);
    const requestHash = repairRequestHash(input.assetId, mediaIds, input.mode);
    const { task, created } = await this.repository.createOrReuseTask({
      assetId: input.assetId,
      requestedByUserId: input.actor.id,
      clientIdempotencyKey: input.clientIdempotencyKey,
      requestHash,
      mode: input.mode,
      trigger: input.trigger ?? "manual",
      mediaIds,
      diagnosis: healthSnapshot(health),
    });
    return { ...task, idempotentReplay: !created };
  }

  async get(
    actor: AssetMediaRepairActor,
    assetId: string,
    taskId: string,
  ): Promise<AssetMediaRepairTaskView> {
    const task = await this.repository.getTaskForActor(actor, assetId, taskId);
    if (!task) throw new NotFoundError("资产媒体修复任务不存在");
    return { ...task, idempotentReplay: false };
  }

  async createDownloadUrl(
    actor: AssetMediaRepairActor,
    assetId: string,
    mediaId: string,
    options: { disposition?: "download" | "inline" } = {},
  ): Promise<{ mediaId: string; url: string; expiresAt: Date }> {
    const media = await this.repository.requireVisibleMedia(actor, assetId, mediaId);
    if (!media.storageBucket || !media.storagePath) {
      throw new ConflictError(
        "这份原文件缺少存储位置，暂时不能下载",
        "asset_media_source_locator_missing",
      );
    }
    const responseContentType = contentTypeForFormat(media.format);
    const result = await this.storage.createDownloadUrl(media.storagePath, {
      bucket: media.storageBucket,
      expiresSeconds: DOWNLOAD_EXPIRES_SECONDS,
      responseContentType,
      ...(options.disposition === "download" && media.title ? { fileName: safeDownloadName(media.title, media.format) } : {}),
    });

    return { mediaId, ...result };
  }
  async processNextQueued(): Promise<boolean> {
    const task = await this.repository.claimNextQueued();
    if (!task) return false;
    const claimToken = requireClaimToken(task);
    try {
      await this.processTask(task);
    } catch (error) {
      if (isClaimLost(error)) return true;
      await this.repository.failTask(task.id, claimToken, {
        errorCode: "asset_media_repair_failed",
        errorMessage: publicRepairFailure(error),
        finishedAt: new Date(),
      }).catch((terminalError: unknown) => {
        if (!isClaimLost(terminalError)) throw terminalError;
      });
    }
    return true;
  }

  requeueInterrupted(): Promise<number> {
    return this.repository.requeueInterrupted();
  }

  enqueueSelfHealCandidates(limit = 20): Promise<number> {
    return this.repository.enqueueSelfHealCandidates(limit);
  }

  private async processTask(task: ClaimedAssetMediaRepairTask): Promise<void> {
    const claimToken = requireClaimToken(task);
    await this.heartbeatOrThrow(task.id, claimToken);
    const before = await this.repository.loadRepairBundle(task.assetId);
    const selected = task.mediaIds ? new Set(task.mediaIds) : null;
    let succeededActions = 0;
    let blockedActions = 0;
    let failedActions = 0;

    for (const media of before.media.filter((item) => !item.deletedAt && (!selected || selected.has(item.id)))) {
      await this.heartbeatOrThrow(task.id, claimToken);
      const mediaIssues = diagnoseAssetMedia({ ...before, activeRepairTaskId: null }).issues
        .filter((item) => item.mediaId === media.id);
      const relationBlockers = mediaIssues.filter((item) =>
        item.blocker
        && item.code !== "model_preview_missing"
        && item.code !== "director_chinese_description_missing"
        && item.code !== "source_object_missing"
        && item.code !== "source_object_unreadable"
      );
      if (relationBlockers.length) {
        for (const blocker of relationBlockers) {
          await this.repository.appendAction({
            taskId: task.id,
            claimToken,
            assetMediaId: media.id,
            action: "mark_blocked",
            status: "blocked",
            before: {},
            after: {},
            errorCode: blocker.code,
            errorMessage: blocker.displayReason,
          });
          blockedActions += 1;
        }
        continue;
      }
      if (isAssetImageMediaKind(media.mediaKind)) {
        const result = await this.repairImage(task, media);
        succeededActions += result.succeeded;
        blockedActions += result.blocked;
        failedActions += result.failed;
        continue;
      }
      if (media.mediaKind === "model_3d" && mediaIssues.some((item) => item.code === "model_preview_missing")) {
        await this.repository.appendAction({
          taskId: task.id,
          claimToken,
          assetMediaId: media.id,
          action: "mark_blocked",
          status: "blocked",
          before: {},
          after: {},
          errorCode: "model_preview_missing",
          errorMessage: "3D 素材需要先由离屏渲染清单生成预览图",
        });
        blockedActions += 1;
      }
    }

    const afterBundle = await this.repository.loadRepairBundle(task.assetId);
    const afterHealth = diagnoseAssetMedia({ ...afterBundle, activeRepairTaskId: null });
    const relevantIssues = afterHealth.issues.filter((item) =>
      !selected || item.mediaId === null || selected.has(item.mediaId)
    );
    const finishedAt = new Date();
    const status = relevantIssues.length === 0
      ? "succeeded"
      : succeededActions > 0
        ? "partial"
        : "failed";
    await this.heartbeatOrThrow(task.id, claimToken);
    await this.repository.completeTask(task.id, claimToken, {
      status,
      diagnosis: healthSnapshot(afterHealth),
      result: {
        succeeded_actions: succeededActions,
        blocked_actions: blockedActions,
        failed_actions: failedActions,
        remaining_issue_codes: relevantIssues.map((item) => item.code),
      },
      errorCode: relevantIssues.length ? "asset_media_repair_incomplete" : null,
      errorMessage: relevantIssues.length
        ? "仍有问题需要补齐来源、渲染结果或人工确认后才能继续"
        : null,
      finishedAt,
    });
  }

  private async repairImage(
    task: ClaimedAssetMediaRepairTask,
    media: AssetRepairMediaSnapshot,
  ): Promise<{ succeeded: number; blocked: number; failed: number }> {
    const taskId = task.id;
    const claimToken = requireClaimToken(task);
    if (!media.storageBucket || !media.storagePath) {
      return { succeeded: 0, blocked: 1, failed: 0 };
    }
    await this.heartbeatOrThrow(taskId, claimToken);
    const locator = { bucket: media.storageBucket, storagePath: media.storagePath };
    let source: Buffer;
    let head: Awaited<ReturnType<AssetMediaStoragePort["headObject"]>>;
    try {
      head = await this.storage.headObject(locator.storagePath, locator.bucket);
      if (head.contentLength > SOURCE_IMAGE_MAX_BYTES) {
        throw new UnprocessableEntityError("原图片超过安全修复大小上限");
      }
      source = await this.storage.readObjectBytes(locator.storagePath, {
        bucket: locator.bucket,
        maxBytes: SOURCE_IMAGE_MAX_BYTES,
      });
      await this.heartbeatOrThrow(taskId, claimToken);
    } catch (error) {
      if (isClaimLost(error)) throw error;
      const failure = storageFailure(error);
      await this.recordSourceFailure(task, media, failure.code, failure.message);
      return { succeeded: 0, blocked: 1, failed: 0 };
    }

    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(source, { limitInputPixels: 25_000_000 }).metadata();
      if (
        !metadata.width
        || !metadata.height
        || !metadata.format
        || !safeImageFormats.has(metadata.format)
      ) {
        throw new Error("unsupported_image");
      }
    } catch {
      await this.recordSourceFailure(
        task,
        media,
        "source_object_unreadable",
        "原文件不是可安全处理的图片，修复任务已停止",
      );
      return { succeeded: 0, blocked: 1, failed: 0 };
    }

    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const beforeFacts = imageFacts(media);
    const afterFacts = {
      widthPx: metadata.width,
      heightPx: metadata.height,
      format: metadata.format,
      sha256: sourceSha256,
    };
    let succeeded = 0;
    if (!sameFacts(beforeFacts, afterFacts)) {
      await this.repository.updateMediaFactsAndAppendAction(taskId, claimToken, media.id, {
        ...afterFacts,
        metadata: {
          ...media.metadata,
          media_repair: {
            checked_at: new Date().toISOString(),
            content_length: head.contentLength,
            content_type: head.contentType,
            etag: head.etag,
          },
        },
      }, {
        assetMediaId: media.id,
        action: "refresh_metadata",
        status: "succeeded",
        before: beforeFacts,
        after: afterFacts,
      });
      succeeded += 1;
    }

    let failed = 0;
    for (const variant of [
      ASSET_MEDIA_DISPLAY_SPECS.thumbnail,
      ASSET_MEDIA_DISPLAY_SPECS.detail,
    ]) {
      const outcome = await this.verifyAndStoreRendition(task, media, sourceSha256, variant);
      if (outcome) succeeded += 1;
      else failed += 1;
    }
    return { succeeded, blocked: 0, failed };
  }

  private async verifyAndStoreRendition(
    task: ClaimedAssetMediaRepairTask,
    media: AssetRepairMediaSnapshot,
    sourceSha256: string,
    variant: AssetMediaDisplaySpec,
  ): Promise<boolean> {
    const taskId = task.id;
    const claimToken = requireClaimToken(task);
    try {
      await this.heartbeatOrThrow(taskId, claimToken);
      const content = await this.storage.readObjectBytes(media.storagePath!, {
        bucket: media.storageBucket!,
        maxBytes: RENDITION_MAX_BYTES,
        process: variant.processSpec,
      });
      const metadata = await sharp(content, { limitInputPixels: 25_000_000 }).metadata();
      if (
        !metadata.width
        || !metadata.height
        || metadata.format !== variant.format
        || !validRenditionDimensions(variant, metadata.width, metadata.height)
      ) {
        throw new Error("invalid_rendition");
      }
      const checkedAt = new Date();
      const expectedFacts = renditionFacts(content, metadata, variant);
      const expectedStoragePath = buildAssetMediaRenditionStoragePath(
        media.id,
        sourceSha256,
        variant.kind,
        expectedFacts.sha256,
      );
      const stored = await this.storage.uploadBytes(
        content,
        expectedStoragePath,
        "image/webp",
      );
      if (
        !stored.bucket.trim()
        || stored.storagePath !== expectedStoragePath
      ) {
        throw new Error("invalid_rendition_storage");
      }
      const finalContent = await this.storage.readObjectBytes(stored.storagePath, {
        bucket: stored.bucket,
        maxBytes: RENDITION_MAX_BYTES,
      });
      const finalMetadata = await sharp(finalContent, { limitInputPixels: 25_000_000 }).metadata();
      const facts = renditionFacts(finalContent, finalMetadata, variant);
      if (!sameRenditionFacts(expectedFacts, facts)) {
        throw new Error("rendition_readback_mismatch");
      }
      await this.heartbeatOrThrow(taskId, claimToken);
      await this.repository.upsertRenditionsAndAppendAction(taskId, claimToken, [{
        assetMediaId: media.id,
        renditionKind: variant.kind,
        strategy: "stored_object",
        status: "healthy",
        processSpec: null,
        storageBucket: stored.bucket,
        storagePath: stored.storagePath,
        storageUrl: null,
        sourceSha256,
        ...facts,
        errorCode: null,
        errorMessage: null,
        checkedAt,
      }], {
        assetMediaId: media.id,
        action: "create_rendition",
        status: "succeeded",
        before: {},
        // Audit the verified facts, not the private source locator or the
        // independently stored object key.
        after: { ...facts, rendition_kind: variant.kind },
      });
      return true;
    } catch (error) {
      const checkedAt = new Date();
      if (isClaimLost(error)) throw error;
      await this.repository.upsertRenditionsAndAppendAction(taskId, claimToken, [{
        assetMediaId: media.id,
        renditionKind: variant.kind,
        strategy: "tos_process",
        status: "failed",
        processSpec: variant.processSpec,
        storageBucket: null,
        storagePath: null,
        storageUrl: null,
        sourceSha256,
        widthPx: null,
        heightPx: null,
        format: null,
        sha256: null,
        errorCode: "rendition_failed",
        errorMessage: "展示图处理结果未通过图片校验",
        checkedAt,
      }], {
        assetMediaId: media.id,
        action: "create_rendition",
        status: "failed",
        before: {},
        after: {},
        errorCode: "rendition_failed",
        errorMessage: "展示图处理结果未通过图片校验",
      });
      return false;
    }
  }

  private async recordSourceFailure(
    task: ClaimedAssetMediaRepairTask,
    media: AssetRepairMediaSnapshot,
    code: "source_object_missing" | "source_object_unreadable" | "rendition_failed",
    message: string,
  ): Promise<void> {
    const taskId = task.id;
    const claimToken = requireClaimToken(task);
    const renditions: AssetMediaRepairRenditionUpsert[] = (["thumbnail", "detail"] as const).map((kind) => ({
        assetMediaId: media.id,
        renditionKind: kind,
        strategy: "tos_process",
        status: "failed",
        processSpec: ASSET_MEDIA_DISPLAY_SPECS[kind].processSpec,
        storageBucket: null,
        storagePath: null,
        storageUrl: null,
        sourceSha256: media.sha256,
        widthPx: null,
        heightPx: null,
        format: null,
        sha256: null,
        errorCode: code,
        errorMessage: message,
        checkedAt: new Date(),
      }));
    await this.repository.upsertRenditionsAndAppendAction(taskId, claimToken, renditions, {
      assetMediaId: media.id,
      action: "mark_blocked",
      status: code === "rendition_failed" ? "failed" : "blocked",
      before: {},
      after: {},
      errorCode: code,
      errorMessage: message,
    });
  }

  private async heartbeatOrThrow(taskId: string, claimToken: string): Promise<void> {
    if (!await this.repository.heartbeatClaim(taskId, claimToken)) {
      throw new ConflictError(
        "这次修复任务已由另一工作进程接手，当前处理已安全停止",
        "asset_media_repair_claim_lost",
      );
    }
  }
}

/**
 * A common-asset viewer may inspect display health, but that must not become a
 * side channel for pending or malformed media hidden by every catalog surface.
 * Owners/admins keep the full diagnostic bundle so they can repair blockers.
 */
function publicDisplayHealthBundle(bundle: AssetRepairBundle): AssetRepairBundle {
  const media = bundle.media.filter((item) => isLegalBundleMediaForAsset(bundle, item));
  const mediaIds = new Set(media.map((item) => item.id));
  return {
    ...bundle,
    media,
    renditions: bundle.renditions.filter((item) => mediaIds.has(item.assetMediaId)),
    // Repair task ids and operational state are administrative facts, not
    // public catalog health.
    activeRepairTaskId: null,
  };
}

export function buildAssetMediaRenditionStoragePath(
  mediaId: string,
  sourceSha256: string,
  kind: "thumbnail" | "detail",
  renditionSha256: string,
): string {
  const identity = createHash("sha256")
    .update(`asset-media-rendition:v2\0${mediaId}\0${sourceSha256}\0${kind}\0${renditionSha256}`)
    .digest("hex");
  return `asset-renditions/v1/${identity.slice(0, 2)}/${identity}.webp`;
}

function repairRequestHash(assetId: string, mediaIds: string[] | null, mode: "safe"): string {
  return createHash("sha256")
    .update(JSON.stringify({ asset_id: assetId, media_ids: mediaIds, mode }))
    .digest("hex");
}

function normalizeMediaIds(mediaIds: string[] | undefined): string[] | null {
  if (!mediaIds?.length) return null;
  return [...new Set(mediaIds)].sort();
}

function healthSnapshot(health: AssetMediaHealthView): Record<string, unknown> {
  return {
    status: health.status,
    issue_codes: health.issues.map((item) => item.code),
    issue_count: health.issues.length,
    media_count: health.mediaCount,
    healthy_media_count: health.healthyMediaCount,
    checked_at: health.checkedAt.toISOString(),
  };
}

function imageFacts(media: AssetRepairMediaSnapshot): Record<string, unknown> {
  return {
    widthPx: media.widthPx,
    heightPx: media.heightPx,
    format: media.format,
    sha256: media.sha256,
  };
}

function sameFacts(
  before: Record<string, unknown>,
  after: { widthPx: number; heightPx: number; format: string; sha256: string },
): boolean {
  return before.widthPx === after.widthPx
    && before.heightPx === after.heightPx
    && before.format === after.format
    && before.sha256 === after.sha256;
}

function storageFailure(error: unknown): {
  code: "source_object_missing" | "source_object_unreadable";
  message: string;
} {
  const category = error && typeof error === "object"
    ? (error as { category?: unknown }).category
    : undefined;
  if (category === "object_not_found") {
    return { code: "source_object_missing", message: "原文件在存储中不存在，不能生成展示图" };
  }
  const status = statusCode(error);
  if (status === 404 || /\b(?:NoSuchKey|NotFound|404)\b/iu.test(errorText(error))) {
    return { code: "source_object_missing", message: "原文件在存储中不存在，不能生成展示图" };
  }
  return { code: "source_object_unreadable", message: "原文件暂时无法读取，修复任务已停止" };
}

function validRenditionDimensions(
  variant: AssetMediaDisplaySpec,
  width: number,
  height: number,
): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return false;
  }
  if (variant.kind === "thumbnail") {
    return width === variant.targetWidth && height === variant.targetHeight;
  }
  return width <= variant.targetWidth && height <= variant.targetHeight;
}

function renditionFacts(
  content: Buffer,
  metadata: sharp.Metadata,
  variant: AssetMediaDisplaySpec,
): { widthPx: number; heightPx: number; format: "webp"; sha256: string } {
  if (
    !isWebp(content)
    || !metadata.width
    || !metadata.height
    || metadata.format !== "webp"
    || !validRenditionDimensions(variant, metadata.width, metadata.height)
  ) {
    throw new Error("invalid_rendition");
  }
  return {
    widthPx: metadata.width,
    heightPx: metadata.height,
    format: "webp",
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function isWebp(content: Buffer): boolean {
  return content.length >= 12
    && content.subarray(0, 4).equals(Buffer.from("RIFF"))
    && content.subarray(8, 12).equals(Buffer.from("WEBP"));
}

function sameRenditionFacts(
  left: { widthPx: number; heightPx: number; format: string; sha256: string },
  right: { widthPx: number; heightPx: number; format: string; sha256: string },
): boolean {
  return left.widthPx === right.widthPx
    && left.heightPx === right.heightPx
    && left.format === right.format
    && left.sha256 === right.sha256;
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { statusCode?: unknown }).statusCode;
  if (typeof direct === "number") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return undefined;
  const nested = (cause as { statusCode?: unknown }).statusCode;
  return typeof nested === "number" ? nested : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof ExternalServiceError) return error.internalMessage.slice(0, 256);
  return error instanceof Error ? error.message.slice(0, 256) : "";
}

function publicRepairFailure(error: unknown): string {
  if (error instanceof ConflictError || error instanceof UnprocessableEntityError) return error.message;
  return "资产媒体修复没能完成，请稍后重试；若仍失败请交给管理员检查。";
}

function requireClaimToken(task: ClaimedAssetMediaRepairTask): string {
  if (!task.claimToken) {
    throw new ConflictError(
      "修复任务没有有效工作租约，处理已安全停止",
      "asset_media_repair_claim_lost",
    );
  }
  return task.claimToken;
}

function isClaimLost(error: unknown): boolean {
  return error instanceof ConflictError && error.code === "asset_media_repair_claim_lost";
}

function safeDownloadName(title: string, format: string | null): string {
  const base = title.trim().replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 80) || "asset";
  const extension = format?.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
  return extension && !base.toLowerCase().endsWith(`.${extension}`)
    ? `${base}.${extension}`
    : base;
}

function contentTypeForFormat(format: string | null): string | undefined {
  if (!format) return undefined;
  const normalized = format.trim().toLowerCase();
  if (normalized === "mp3" || normalized === "mpeg") return "audio/mpeg";
  if (normalized === "wav" || normalized === "wave") return "audio/wav";
  if (normalized === "ogg" || normalized === "opus") return "audio/ogg";
  if (normalized === "mp4") return "video/mp4";
  if (normalized === "webm") return "video/webm";
  if (normalized === "jpeg" || normalized === "jpg") return "image/jpeg";
  if (normalized === "png") return "image/png";
  if (normalized === "webp") return "image/webp";
  if (normalized === "gif") return "image/gif";
  if (normalized === "avif") return "image/avif";
  return undefined;
}
