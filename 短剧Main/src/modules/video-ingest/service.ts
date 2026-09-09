import { createHash } from "node:crypto";
import path from "node:path";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AssetEntityRepository } from "../../repositories/assetEntityRepository.js";
import { AssetSourceProjectRepository } from "../../repositories/assetSourceProjectRepository.js";
import { TosStorage } from "../../integrations/tosStorage.js";
import {
  type LasVideoUnderstandingPort,
  VolcLasVideoUnderstandingClient,
} from "../../integrations/volcLasVideoUnderstanding.js";
import { VectorSyncService } from "../../services/vectorSyncService.js";
import { safePathPart } from "../../shared/files.js";
import { AppError, BadRequestError, ExternalServiceError } from "../../shared/errors.js";
import {
  buildVideoEntityVectorText,
  buildVideoVectorText,
  normalizeVideoUnderstanding,
  videoUnderstandingQuery,
} from "./normalizer.js";
import {
  queryHash,
  toVideoIngestTaskView,
  VideoIngestRepository,
} from "./repository.js";
import type {
  SubmittedVideoIngest,
  SubmittedUploadedVideoIngest,
  SubmitVideoIngestInput,
  SubmitUploadedVideoIngestInput,
  VideoIngestTaskView,
} from "./types.js";

export const VIDEO_UNDERSTANDING_OPERATOR_ID = "las_video_understanding";
export const VIDEO_UNDERSTANDING_OPERATOR_VERSION = "v1";
export const VIDEO_UNDERSTANDING_TASK_TEMPLATE = "dense_video_captioning";
export const VIDEO_UNDERSTANDING_FPS = 1;
export const VIDEO_UNDERSTANDING_MEDIA_RESOLUTION = "medium";
export const VIDEO_UNDERSTANDING_REASONING_EFFORT = "minimal";

const MAX_ATTEMPTS = 3;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLLS = 120;

export interface VideoIngestServiceDependencies {
  repository?: VideoIngestRepository;
  sourceProjects?: Pick<AssetSourceProjectRepository, "getOrCreate">;
  storage?: Pick<TosStorage, "headObject" | "createDownloadUrl" | "uploadBytes">;
  las?: LasVideoUnderstandingPort;
  vectorSync?: Pick<VectorSyncService, "syncEntityWithText">;
  entityRepository?: Pick<AssetEntityRepository, "toData" | "getById">;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export class VideoIngestService {
  private readonly repository: VideoIngestRepository;
  private readonly sourceProjects: Pick<AssetSourceProjectRepository, "getOrCreate">;
  private readonly storage: Pick<TosStorage, "headObject" | "createDownloadUrl" | "uploadBytes">;
  private readonly las: LasVideoUnderstandingPort;
  private readonly vectorSync: Pick<VectorSyncService, "syncEntityWithText">;
  private readonly entities: Pick<AssetEntityRepository, "toData" | "getById">;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(db: Database, dependencies: VideoIngestServiceDependencies = {}) {
    this.repository = dependencies.repository ?? new VideoIngestRepository(db);
    this.sourceProjects = dependencies.sourceProjects ?? new AssetSourceProjectRepository(db);
    this.storage = dependencies.storage ?? new TosStorage();
    this.las = dependencies.las ?? new VolcLasVideoUnderstandingClient();
    this.vectorSync = dependencies.vectorSync ?? new VectorSyncService();
    this.entities = dependencies.entityRepository ?? new AssetEntityRepository(db);
    this.pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPolls = dependencies.maxPolls ?? DEFAULT_MAX_POLLS;
  }

  async submit(input: SubmitVideoIngestInput): Promise<SubmittedVideoIngest> {
    const video = normalizeVideoInput(input);
    const head = await this.storage.headObject(video.storagePath, video.storageBucket);
    const contentType = video.contentType || head.contentType || "video/mp4";
    assertVideoContent(video.originalFileName, contentType);
    const sourceProjectName = input.sourceProjectName?.trim() || null;
    const sourceProject = sourceProjectName
      ? await this.sourceProjects.getOrCreate({
          name: sourceProjectName,
          code: `video_api_${queryHash(sourceProjectName).slice(0, 12)}`,
          description: "reference video ingest",
          projectType: "video_upload",
          metadata: { ingest_api: "asset-ingest/videos" },
        })
      : null;
    const query = videoUnderstandingQuery();
    const created = await this.repository.createSubmission({
      actorId: input.actorId,
      sourceProjectId: sourceProject?.id ?? null,
      sourceProjectName: sourceProject?.name ?? null,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      video: {
        storageBucket: video.storageBucket,
        storagePath: video.storagePath,
        storageUrl: video.storageUrl ?? null,
        originalFileName: video.originalFileName,
        contentType,
        contentLength: head.contentLength,
      },
      cover: input.cover
        ? {
            storageBucket: input.cover.storageBucket ?? null,
            storagePath: input.cover.storagePath,
            contentType: input.cover.contentType,
          }
        : null,
      task: {
        operatorId: VIDEO_UNDERSTANDING_OPERATOR_ID,
        operatorVersion: VIDEO_UNDERSTANDING_OPERATOR_VERSION,
        taskTemplate: VIDEO_UNDERSTANDING_TASK_TEMPLATE,
        queryHash: queryHash(query),
      },
    });
    return {
      assetId: created.assetId,
      mediaId: created.mediaId,
      taskId: created.taskId,
      status: "queued",
    };
  }

  async submitUploadedFile(input: SubmitUploadedVideoIngestInput): Promise<SubmittedUploadedVideoIngest> {
    const fileName = input.file.fileName.trim();
    const contentType = input.file.contentType.trim() || "application/octet-stream";
    if (!fileName) throw new BadRequestError("视频原始文件名不能为空");
    if (!input.file.content.length) throw new BadRequestError("视频文件不能为空");
    assertVideoContent(fileName, contentType);

    const sourceProjectName = input.sourceProjectName?.trim() || null;
    const sha256 = createHash("sha256").update(input.file.content).digest("hex");
    const stored = await this.storage.uploadBytes(
      input.file.content,
      videoStoragePath({ fileName, contentType, sha256 }),
      contentType,
    );
    const submitted = await this.submit({
      actorId: input.actorId,
      sourceProjectName,
      name: input.name,
      description: input.description,
      video: {
        storageBucket: stored.bucket,
        storagePath: stored.storagePath,
        storageUrl: stored.storageUrl,
        originalFileName: fileName,
        contentType,
      },
    });
    return {
      ...submitted,
      storageBucket: stored.bucket,
      storagePath: stored.storagePath,
      storageUrl: stored.storageUrl,
    };
  }

  async get(actorId: string, taskId: string): Promise<VideoIngestTaskView> {
    const task = await this.repository.getByUser(actorId, taskId);
    if (!task) throw new AppError(404, "video_ingest_task_not_found", "视频入库任务不存在");
    return toVideoIngestTaskView(task);
  }

  async listRecent(actorId: string, limit: number): Promise<VideoIngestTaskView[]> {
    const rows = await this.repository.listRecentByUser(actorId, limit);
    return rows.map(toVideoIngestTaskView);
  }

  async retry(actorId: string, taskId: string): Promise<VideoIngestTaskView> {
    return toVideoIngestTaskView(await this.repository.retryFailed(actorId, taskId));
  }

  async requeueInterrupted(): Promise<number> {
    return this.repository.requeueInterrupted();
  }

  async processNextQueued(): Promise<boolean> {
    const task = await this.repository.claimNextQueued();
    if (!task) return false;
    if (task.attemptCount > MAX_ATTEMPTS) {
      await this.repository.markFailed(task.id, "max_attempts_exceeded", "视频解析重试次数已用完");
      return true;
    }
    try {
      const query = videoUnderstandingQuery();
      const download = await this.storage.createDownloadUrl(task.sourceVideoPath, {
        bucket: task.sourceVideoBucket,
        expiresSeconds: 900,
      });
      const submitted = await this.las.submit({
        videoUrl: download.url,
        query,
        taskTemplate: task.taskTemplate,
        fps: VIDEO_UNDERSTANDING_FPS,
        mediaResolution: VIDEO_UNDERSTANDING_MEDIA_RESOLUTION,
        reasoningEffort: VIDEO_UNDERSTANDING_REASONING_EFFORT,
        ...(settings.lasVideoUnderstandingModel ? { modelName: settings.lasVideoUnderstandingModel } : {}),
      });
      await this.repository.recordOperatorTask(task.id, submitted.taskId, submitted.raw);
      const raw = await this.waitForCompletion(submitted.taskId);
      const normalized = normalizeVideoUnderstanding(raw, task.sourceVideoPath);
      const vectorText = buildVideoVectorText(normalized);
      const updated = await this.repository.markSucceeded({
        taskId: task.id,
        rawResult: raw,
        normalizedResult: normalized,
        vectorText,
      });
      const entity = this.entities.toData(updated);
      await this.vectorSync.syncEntityWithText(entity, buildVideoEntityVectorText(entity.name, vectorText)).catch((error: unknown) => {
        console.error("[video-ingest] vector sync failed", error);
      });
    } catch (error) {
      const failure = videoIngestFailure(error);
      await this.repository.markFailed(task.id, failure.code, failure.message);
    }
    return true;
  }

  private async waitForCompletion(operatorTaskId: string) {
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      const result = await this.las.poll(operatorTaskId);
      if (result.status === "completed") return result.raw;
      if (result.status === "failed") {
        throw new ExternalServiceError("Volc LAS", "video understanding task failed");
      }
      if (this.pollIntervalMs > 0) await sleep(this.pollIntervalMs);
    }
    throw new ExternalServiceError("Volc LAS", "video understanding task timed out");
  }
}

interface NormalizedVideoInput {
  storageBucket: string;
  storagePath: string;
  storageUrl: string | null;
  originalFileName: string;
  contentType: string;
}

function normalizeVideoInput(input: SubmitVideoIngestInput): NormalizedVideoInput {
  const storagePath = input.video.storagePath.trim();
  if (!storagePath) throw new BadRequestError("视频 TOS 路径不能为空");
  const storageBucket = input.video.storageBucket?.trim() || settings.tosBucket;
  if (!storageBucket) throw new BadRequestError("视频 TOS bucket 不能为空");
  const originalFileName = input.video.originalFileName.trim();
  if (!originalFileName) throw new BadRequestError("视频原始文件名不能为空");
  if (!input.name.trim()) throw new BadRequestError("视频素材名称不能为空");
  return {
    storageBucket,
    storagePath,
    storageUrl: input.video.storageUrl ?? null,
    originalFileName,
    contentType: input.video.contentType.trim(),
  };
}

function assertVideoContent(fileName: string, contentType: string): void {
  const extension = path.extname(fileName).toLowerCase();
  const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"]);
  if (contentType.startsWith("video/") || videoExtensions.has(extension)) return;
  throw new BadRequestError("视频入库只支持常见视频文件");
}

function videoStoragePath(input: {
  fileName: string;
  contentType: string;
  sha256: string;
}): string {
  const extension = path.extname(input.fileName).toLowerCase() || extensionForContentType(input.contentType);
  const stem = safePathPart(path.basename(input.fileName, path.extname(input.fileName)));
  return [
    "asset-videos",
    `${input.sha256.slice(0, 12)}_${stem}${extension}`,
  ].join("/");
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.trim().toLowerCase();
  if (normalized === "video/quicktime") return ".mov";
  if (normalized === "video/webm") return ".webm";
  if (normalized === "video/x-m4v") return ".m4v";
  return ".mp4";
}

function videoIngestFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ExternalServiceError) {
    return { code: "external_service_error", message: error.internalMessage.slice(0, 512) };
  }
  if (error instanceof AppError) {
    return { code: error.code, message: error.message.slice(0, 512) };
  }
  return { code: "video_ingest_failed", message: error instanceof Error ? error.message.slice(0, 512) : "视频解析失败" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
