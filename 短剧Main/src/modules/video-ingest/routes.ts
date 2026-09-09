import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { BadRequestError, PayloadTooLargeError } from "../../shared/errors.js";
import { VideoIngestService } from "./service.js";
import type { VideoIngestKickPort } from "./worker.js";

const VIDEO_UPLOAD_MAX_FILE_BYTES = 100 * 1024 * 1024;

const taskParamsSchema = z.object({
  task_id: z.string().uuid(),
}).strict();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const tosVideoSchema = z.object({
  storage_bucket: z.string().trim().min(1).max(128).optional(),
  storage_path: z.string().trim().min(1).max(512),
  storage_url: z.string().url().max(1024).nullable().optional(),
  original_file_name: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(128),
}).strict();

const coverSchema = z.object({
  storage_bucket: z.string().trim().min(1).max(128).optional(),
  storage_path: z.string().trim().min(1).max(512),
  content_type: z.string().trim().min(1).max(128),
}).strict();

const submitSchema = z.object({
  source_project_name: z.string().trim().min(1).max(128).nullable().optional(),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2_000).nullable().optional(),
  video: tosVideoSchema,
  cover: coverSchema.nullable().optional(),
}).strict();

const uploadFieldsSchema = z.object({
  source_project_name: z.string().trim().min(1).max(128).nullable().optional(),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2_000).nullable().optional(),
}).strict();

export interface VideoIngestRouteDependencies {
  createService?: (db: Database) => Pick<VideoIngestService, "submit" | "submitUploadedFile" | "get" | "listRecent" | "retry">;
  worker?: VideoIngestKickPort;
}

export async function registerVideoIngestRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: VideoIngestRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase()) ?? new VideoIngestService(getDatabase());

  app.post("/api/v1/asset-ingest/videos", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const input = parseRequest(submitSchema, request.body);
    const result = await service().submit({
      actorId: actor.id,
      sourceProjectName: input.source_project_name,
      name: input.name,
      description: input.description,
      video: {
        storageBucket: input.video.storage_bucket,
        storagePath: input.video.storage_path,
        storageUrl: input.video.storage_url,
        originalFileName: input.video.original_file_name,
        contentType: input.video.content_type,
      },
      cover: input.cover
        ? {
            storageBucket: input.cover.storage_bucket,
            storagePath: input.cover.storage_path,
            contentType: input.cover.content_type,
          }
        : null,
    });
    dependencies.worker?.kick();
    return reply.code(202).send(success({
      asset_id: result.assetId,
      media_id: result.mediaId,
      task_id: result.taskId,
      status: result.status,
    }));
  });

  app.post("/api/v1/asset-ingest/videos/upload", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const upload = await readVideoUploadMultipart(request);
    const result = await service().submitUploadedFile({
      actorId: actor.id,
      sourceProjectName: upload.fields.source_project_name,
      name: upload.fields.name,
      description: upload.fields.description,
      file: upload.file,
    });
    dependencies.worker?.kick();
    return reply.code(202).send(success({
      asset_id: result.assetId,
      media_id: result.mediaId,
      task_id: result.taskId,
      status: result.status,
      storage_bucket: result.storageBucket,
      storage_path: result.storagePath,
      storage_url: result.storageUrl,
    }));
  });

  app.get("/api/v1/video-ingest-tasks", async (request) => {
    const actor = requireCurrentUser(request);
    const query = parseRequest(listQuerySchema, request.query ?? {});
    const items = await service().listRecent(actor.id, query.limit);
    return success({ items: items.map(taskView), count: items.length });
  });

  app.get("/api/v1/video-ingest-tasks/:task_id", async (request) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(taskParamsSchema, request.params);
    return success({ task: taskView(await service().get(actor.id, params.task_id)) });
  });

  app.post("/api/v1/video-ingest-tasks/:task_id/retry", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(taskParamsSchema, request.params);
    const task = await service().retry(actor.id, params.task_id);
    dependencies.worker?.kick();
    return reply.code(202).send(success({ task: taskView(task) }));
  });
}

interface VideoUploadMultipartBody {
  fields: z.infer<typeof uploadFieldsSchema>;
  file: {
    fileName: string;
    contentType: string;
    content: Buffer;
  };
}

async function readVideoUploadMultipart(request: FastifyRequest): Promise<VideoUploadMultipartBody> {
  const fields: Record<string, string> = {};
  let file: VideoUploadMultipartBody["file"] | undefined;
  try {
    for await (const part of request.parts({
      limits: {
        fileSize: VIDEO_UPLOAD_MAX_FILE_BYTES,
        files: 1,
        fields: 3,
        parts: 4,
      },
    })) {
      if (part.type === "field") {
        if (typeof part.value === "string" && part.value.trim()) fields[part.fieldname] = part.value.trim();
        continue;
      }
      if (file) throw new BadRequestError("一次只能上传一个视频文件");
      if (!part.filename) {
        await part.toBuffer().catch(() => undefined);
        continue;
      }
      file = {
        fileName: part.filename,
        contentType: part.mimetype,
        content: await part.toBuffer(),
      };
    }
  } catch (error) {
    if (isMultipartFileTooLarge(error)) throw new PayloadTooLargeError("上传视频不能超过 100MB");
    if (isMultipartCountLimitExceeded(error)) throw new PayloadTooLargeError("一次只能上传一个视频文件");
    throw error;
  }
  if (!file) throw new BadRequestError("缺少上传视频文件");
  return {
    fields: parseRequest(uploadFieldsSchema, fields),
    file,
  };
}

function isMultipartFileTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE";
}

function isMultipartCountLimitExceeded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT";
}

function taskView(task: Awaited<ReturnType<VideoIngestService["get"]>>) {
  return {
    id: task.id,
    status: task.status,
    asset_entity_id: task.assetEntityId,
    asset_media_id: task.assetMediaId,
    operator_task_id: task.operatorTaskId,
    error_code: task.errorCode,
    error_message: task.errorMessage,
    created_at: task.createdAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
  };
}
