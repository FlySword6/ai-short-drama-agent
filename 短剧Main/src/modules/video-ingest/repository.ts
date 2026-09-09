import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  mediaProvenanceSubjects,
  videoIngestTasks,
  type AssetEntityRow,
  type VideoIngestTaskRow,
} from "../../db/schema.js";
import type { JsonObject } from "../../domain/assets/types.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { buildVideoAppearanceText, buildVideoOutfitDescriptionText } from "./normalizer.js";
import type { NormalizedVideoUnderstanding, VideoIngestTaskView } from "./types.js";

export interface CreateVideoIngestSubmissionInput {
  actorId: string;
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  name: string;
  description: string | null;
  video: {
    storageBucket: string;
    storagePath: string;
    storageUrl: string | null;
    originalFileName: string;
    contentType: string;
    contentLength: number | null;
  };
  cover?: {
    storageBucket: string | null;
    storagePath: string;
    contentType: string;
  } | null;
  task: {
    operatorId: string;
    operatorVersion: string;
    taskTemplate: string;
    queryHash: string;
  };
}

export interface CreatedVideoIngestSubmission {
  assetId: string;
  mediaId: string;
  taskId: string;
}

export interface CompleteVideoIngestInput {
  taskId: string;
  rawResult: JsonObject;
  normalizedResult: NormalizedVideoUnderstanding;
  vectorText: string;
}

export class VideoIngestRepository {
  constructor(private readonly db: Database) {}

  async createSubmission(input: CreateVideoIngestSubmissionInput): Promise<CreatedVideoIngestSubmission> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const assetId = randomUUID();
      const mediaId = randomUUID();
      const taskId = randomUUID();
      const videoMetadata: JsonObject = {
        video_ingest: {
          status: "queued",
          task_id: taskId,
          task_template: input.task.taskTemplate,
        },
        video_understanding: {
          status: "pending",
        },
        source_file_name: input.video.originalFileName,
        content_type: input.video.contentType,
        source_video: {
          storage_bucket: input.video.storageBucket,
          storage_path: input.video.storagePath,
          storage_url: input.video.storageUrl,
          content_length: input.video.contentLength,
        },
        ...(input.cover ? { cover: input.cover } : {}),
      };
      await transaction.insert(assetEntities).values({
        id: assetId,
        sourceProjectId: input.sourceProjectId,
        sourceProjectName: input.sourceProjectName,
        ownerUserId: input.actorId,
        visibility: "personal",
        assetKind: "video",
        role: "motion",
        usageMode: "reference",
        name: input.name,
        displayName: input.name,
        intro: input.description,
        appearance: input.description,
        ageValue: null,
        gender: null,
        heightCm: null,
        hairDescription: null,
        outfitDescription: null,
        category: "视频",
        styleTags: [],
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        sourceFileUrl: input.video.storageUrl,
        metadata: videoMetadata,
        createdAt: now,
        updatedAt: now,
        useCount: 0,
        deletedAt: null,
        deletedByUserId: null,
      });
      await transaction.insert(assetMedia).values({
        id: mediaId,
        assetEntityId: assetId,
        assetVariantId: null,
        mediaKind: "video",
        viewAngle: "reference",
        title: input.name,
        description: input.description,
        storageBucket: input.video.storageBucket,
        storagePath: input.video.storagePath,
        storageUrl: input.video.storageUrl,
        widthPx: null,
        heightPx: null,
        format: formatFromFileName(input.video.originalFileName, input.video.contentType),
        sha256: null,
        isPrimary: true,
        approved: true,
        sortOrder: 100,
        metadata: {
          source: "video_ingest",
          original_file_name: input.video.originalFileName,
          content_type: input.video.contentType,
          content_length: input.video.contentLength,
          cover: input.cover ?? null,
        },
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      });
      await transaction.insert(mediaProvenanceSubjects).values({
        assetMediaId: mediaId,
        mediaResultId: null,
        sourceChannel: "external_upload",
        sourceGenerationAttemptId: null,
        providerAssetId: null,
        observedAt: now,
      });
      await transaction.insert(videoIngestTasks).values({
        id: taskId,
        actorUserId: input.actorId,
        assetEntityId: assetId,
        assetMediaId: mediaId,
        sourceVideoBucket: input.video.storageBucket,
        sourceVideoPath: input.video.storagePath,
        operatorId: input.task.operatorId,
        operatorVersion: input.task.operatorVersion,
        operatorTaskId: null,
        taskTemplate: input.task.taskTemplate,
        queryHash: input.task.queryHash,
        status: "queued",
        attemptCount: 0,
        rawResult: null,
        normalizedResult: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return { assetId, mediaId, taskId };
    });
  }

  async getByUser(actorId: string, taskId: string): Promise<VideoIngestTaskRow | null> {
    const [row] = await this.db.select().from(videoIngestTasks).where(and(
      eq(videoIngestTasks.id, taskId),
      eq(videoIngestTasks.actorUserId, actorId),
    )).limit(1);
    return row ?? null;
  }

  async claimNextQueued(): Promise<VideoIngestTaskRow | null> {
    return this.db.transaction(async (transaction) => {
      const [row] = await transaction.select().from(videoIngestTasks)
        .where(eq(videoIngestTasks.status, "queued"))
        .orderBy(videoIngestTasks.createdAt, videoIngestTasks.id)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [updated] = await transaction.update(videoIngestTasks).set({
        status: "processing",
        attemptCount: sql`${videoIngestTasks.attemptCount} + 1`,
        startedAt: new Date(),
        updatedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      }).where(eq(videoIngestTasks.id, row.id)).returning();
      return updated ?? null;
    });
  }

  async recordOperatorTask(taskId: string, operatorTaskId: string, rawResult: JsonObject): Promise<void> {
    await this.db.update(videoIngestTasks).set({
      operatorTaskId,
      rawResult,
      updatedAt: new Date(),
    }).where(eq(videoIngestTasks.id, taskId));
  }

  async markSucceeded(input: CompleteVideoIngestInput): Promise<AssetEntityRow> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const normalized = normalizedToJson(input.normalizedResult);
      const [task] = await transaction.select().from(videoIngestTasks)
        .where(eq(videoIngestTasks.id, input.taskId))
        .limit(1);
      if (!task) throw new NotFoundError("视频解析任务不存在");
      const [asset] = await transaction.select().from(assetEntities)
        .where(eq(assetEntities.id, task.assetEntityId))
        .limit(1);
      if (!asset) throw new NotFoundError("视频素材不存在");
      const [media] = await transaction.select().from(assetMedia)
        .where(eq(assetMedia.id, task.assetMediaId))
        .limit(1);
      if (!media) throw new NotFoundError("视频媒体不存在");
      const metadata: JsonObject = {
        ...(asset.metadata as JsonObject),
        video_ingest: {
          status: "parsed",
          task_id: task.id,
          operator_task_id: task.operatorTaskId,
          task_template: task.taskTemplate,
          updated_at: now.toISOString(),
        },
        video_understanding: {
          status: "parsed",
          normalized,
        },
      };
      const mediaMetadata: JsonObject = {
        ...(media.metadata as JsonObject),
        video_ingest: {
          status: "parsed",
          task_id: task.id,
          operator_task_id: task.operatorTaskId,
          task_template: task.taskTemplate,
          updated_at: now.toISOString(),
        },
        video_understanding: {
          status: "parsed",
          normalized,
          vector_text: input.vectorText,
        },
      };
      const resolution = resolutionFromRawResult(input.rawResult);
      const readableName = buildVideoAssetName(input.normalizedResult, asset.name);
      const shouldRename = shouldReplaceVideoAssetName(asset.name, media.title);
      const appearanceText = buildVideoAppearanceText(input.normalizedResult) || asset.appearance;
      const visualStyleTags = input.normalizedResult.visual_style;
      const mergedTags = [...new Set([...input.normalizedResult.tags, ...visualStyleTags])];
      const [updated] = await transaction.update(assetEntities).set({
        name: shouldRename ? readableName : asset.name,
        displayName: shouldRename ? readableName : asset.displayName,
        appearance: appearanceText,
        outfitDescription: null,
        category: "视频",
        styleTags: mergedTags,
        metadata,
        updatedAt: now,
      }).where(eq(assetEntities.id, asset.id)).returning();
      await transaction.update(assetMedia).set({
        title: shouldRename ? readableName : media.title,
        description: input.normalizedResult.summary || media.description || asset.intro,
        widthPx: resolution.widthPx ?? media.widthPx,
        heightPx: resolution.heightPx ?? media.heightPx,
        metadata: mediaMetadata,
      }).where(eq(assetMedia.id, media.id));
      await transaction.update(videoIngestTasks).set({
        status: "succeeded",
        rawResult: input.rawResult,
        normalizedResult: normalized,
        errorCode: null,
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      }).where(eq(videoIngestTasks.id, input.taskId));
      return updated ?? asset;
    });
  }

  async markFailed(taskId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const now = new Date();
      const [task] = await transaction.select().from(videoIngestTasks)
        .where(eq(videoIngestTasks.id, taskId))
        .limit(1);
      if (!task) return;
      await transaction.update(videoIngestTasks).set({
        status: "failed",
        errorCode,
        errorMessage,
        completedAt: now,
        updatedAt: now,
      }).where(eq(videoIngestTasks.id, taskId));
      const [asset] = await transaction.select().from(assetEntities)
        .where(eq(assetEntities.id, task.assetEntityId))
        .limit(1);
      if (!asset) return;
      await transaction.update(assetEntities).set({
        metadata: {
          ...(asset.metadata as JsonObject),
          video_ingest: {
            status: "failed",
            task_id: task.id,
            operator_task_id: task.operatorTaskId,
            error_code: errorCode,
            error_message: errorMessage,
            updated_at: now.toISOString(),
          },
        },
        updatedAt: now,
      }).where(eq(assetEntities.id, asset.id));
      const [media] = await transaction.select().from(assetMedia)
        .where(eq(assetMedia.id, task.assetMediaId))
        .limit(1);
      if (!media) return;
      await transaction.update(assetMedia).set({
        metadata: {
          ...(media.metadata as JsonObject),
          video_ingest: {
            status: "failed",
            task_id: task.id,
            operator_task_id: task.operatorTaskId,
            error_code: errorCode,
            error_message: errorMessage,
            updated_at: now.toISOString(),
          },
          video_understanding: {
            status: "failed",
          },
        },
      }).where(eq(assetMedia.id, media.id));
    });
  }

  async retryFailed(actorId: string, taskId: string): Promise<VideoIngestTaskRow> {
    return this.db.transaction(async (transaction) => {
      const [task] = await transaction.select().from(videoIngestTasks).where(and(
        eq(videoIngestTasks.id, taskId),
        eq(videoIngestTasks.actorUserId, actorId),
      )).limit(1).for("update");
      if (!task) throw new NotFoundError("视频解析任务不存在");
      if (task.status !== "failed") throw new ConflictError("只有失败的视频解析任务可以重试", "video_ingest_not_retryable");
      const [updated] = await transaction.update(videoIngestTasks).set({
        status: "queued",
        operatorTaskId: null,
        rawResult: null,
        normalizedResult: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(eq(videoIngestTasks.id, task.id)).returning();
      return updated ?? task;
    });
  }

  async requeueInterrupted(): Promise<number> {
    const rows = await this.db.update(videoIngestTasks).set({
      status: "queued",
      startedAt: null,
      updatedAt: new Date(),
    }).where(eq(videoIngestTasks.status, "processing"))
      .returning({ id: videoIngestTasks.id });
    return rows.length;
  }

  async listRecentByUser(actorId: string, limit: number): Promise<VideoIngestTaskRow[]> {
    return this.db.select().from(videoIngestTasks)
      .where(eq(videoIngestTasks.actorUserId, actorId))
      .orderBy(desc(videoIngestTasks.createdAt), desc(videoIngestTasks.id))
      .limit(limit);
  }
}

export function toVideoIngestTaskView(row: VideoIngestTaskRow): VideoIngestTaskView {
  return {
    id: row.id,
    status: row.status as VideoIngestTaskView["status"],
    assetEntityId: row.assetEntityId,
    assetMediaId: row.assetMediaId,
    operatorTaskId: row.operatorTaskId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export function queryHash(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

function formatFromFileName(fileName: string, contentType: string): string {
  const extension = path.extname(fileName).replace(/^\./, "").trim().toLowerCase();
  if (extension) return extension.slice(0, 32);
  const subtype = contentType.split("/")[1]?.trim().toLowerCase();
  return subtype ? subtype.slice(0, 32) : "mp4";
}

function normalizedToJson(value: NormalizedVideoUnderstanding): JsonObject {
  return value as unknown as JsonObject;
}

export function buildVideoAssetName(value: NormalizedVideoUnderstanding, fallbackName: string): string {
  const usefulTags = value.tags
    .map(cleanNamePart)
    .filter((tag) => tag && !isGenericVideoTag(tag));
  const tagName = unique(usefulTags).slice(0, 3).join(" · ");
  if (tagName) return limitName(tagName);

  const scene = cleanNamePart(value.scene);
  const action = cleanNamePart(value.actions[0] ?? "");
  const sceneActionName = [scene, action].filter(Boolean).slice(0, 2).join(" · ");
  if (sceneActionName) return limitName(sceneActionName);

  const summary = cleanNamePart(value.summary);
  return limitName(summary || fallbackName || "参考视频");
}

export function shouldReplaceVideoAssetName(assetName: string | null, mediaTitle: string | null): boolean {
  const candidates = [assetName, mediaTitle].map((value) => cleanNamePart(value ?? "")).filter(Boolean);
  if (candidates.length === 0) return true;
  return candidates.every((value) => isGeneratedVideoName(value) || isGenericVideoName(value));
}

function resolutionFromRawResult(raw: JsonObject): { widthPx: number | null; heightPx: number | null } {
  const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
    ? raw.data as Record<string, unknown>
    : {};
  const resolution = typeof data.resolution === "string"
    ? data.resolution
    : typeof raw.resolution === "string"
      ? raw.resolution
      : "";
  const match = /(\d{2,5})\s*[xX×]\s*(\d{2,5})/u.exec(resolution);
  if (match) {
    return {
      widthPx: Number(match[1]),
      heightPx: Number(match[2]),
    };
  }
  return {
    widthPx: numberField(data.width ?? data.width_px ?? data.video_width ?? raw.width ?? raw.width_px),
    heightPx: numberField(data.height ?? data.height_px ?? data.video_height ?? raw.height ?? raw.height_px),
  };
}

function numberField(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanNamePart(value: string): string {
  return value
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[。；;，,、]+$/u, "")
    .trim();
}

function limitName(value: string): string {
  const normalized = cleanNamePart(value);
  return normalized.length > 48 ? normalized.slice(0, 48) : normalized;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isGenericVideoName(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "video",
    "reference video",
    "video reference",
    "参考视频",
    "视频",
    "视频素材",
    "素材视频",
  ].includes(normalized);
}

function isGenericVideoTag(value: string): boolean {
  return [
    "视频",
    "参考视频",
    "短剧",
    "情感短剧",
    "3d动画",
    "3D动画",
  ].includes(value);
}

function isGeneratedVideoName(value: string): boolean {
  const normalized = value.toLowerCase();
  return /^[0-9a-f]{8}[\s_-][0-9a-f]{4}[\s_-][0-9a-f]{4}[\s_-][0-9a-f]{4}[\s_-][0-9a-f]{12}$/i.test(normalized)
    || /^[0-9a-f]{8,}[\s_-][0-9a-f][0-9a-f\s_-]{3,}/i.test(normalized)
    || /^[0-9a-f]{12,}$/i.test(normalized)
    || normalized.startsWith("asset-videos/");
}
