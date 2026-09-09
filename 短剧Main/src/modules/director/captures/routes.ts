import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/client.js";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest } from "../../../http/response.js";
import { BadRequestError, PayloadTooLargeError } from "../../../shared/errors.js";
import { DIRECTOR_CAPTURE_MAX_FILE_BYTES, DirectorCaptureService, type DirectorCaptureUploadInput } from "./service.js";

/**
 * 导演台截图入库 API（multipart）。读取文件前先校验项目归属（与 assets 媒体
 * 上传同一先例），避免未授权请求拖着大文件上传。返回 camelCase 契约。
 */

const projectParams = z.object({ project_id: z.string().uuid() });

const captureFieldsSchema = z.object({
  episode_id: z.string().uuid().optional(),
  scene_id: z.string().uuid().optional(),
  shot_id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(128).optional(),
});

export interface CaptureRouteDependencies {
  createCaptureService?: (
    db: Database,
  ) => Pick<DirectorCaptureService, "assertProjectCreateAccess" | "upload">;
}

export async function registerDirectorCaptureRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: CaptureRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createCaptureService?.(getDatabase())
    ?? new DirectorCaptureService(getDatabase());

  app.post("/api/v1/projects/:project_id/director/captures", async (request, reply) => {
    const params = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const captureService = service();
    // 项目创作权限先于 multipart 读取；service 内再检查，避免未授权请求
    // 拖着大文件进入 TOS 上传链。
    await captureService.assertProjectCreateAccess(actor, params.project_id);
    const upload = await readCaptureMultipart(request);
    const item = await captureService.upload({
      actor,
      projectId: params.project_id,
      ...upload,
    });
    return reply.code(201).send({ ok: true, data: item });
  });
}

async function readCaptureMultipart(
  request: FastifyRequest,
): Promise<Omit<DirectorCaptureUploadInput, "actor" | "projectId">> {
  let file: { fileName: string; declaredContentType: string; content: Buffer } | undefined;
  const fields: Record<string, string> = {};
  try {
    for await (const part of request.parts({
      limits: {
        fileSize: DIRECTOR_CAPTURE_MAX_FILE_BYTES,
        files: 1,
        fields: 4,
        parts: 5,
      },
    })) {
      if (part.type === "file") {
        if (file) throw new BadRequestError("一次只能上传一张截图");
        file = {
          fileName: part.filename,
          declaredContentType: part.mimetype,
          content: await part.toBuffer(),
        };
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    if (isMultipartFileTooLarge(error)) {
      throw new PayloadTooLargeError("上传截图没成：文件不能超过 10 兆。");
    }
    throw error;
  }
  if (!file) throw new BadRequestError("缺少上传截图");
  const input = parseRequest(captureFieldsSchema, fields);
  const placement = {
    ...(input.episode_id ? { episodeId: input.episode_id } : {}),
    ...(input.scene_id ? { sceneId: input.scene_id } : {}),
    ...(input.shot_id ? { shotId: input.shot_id } : {}),
  };
  return {
    ...file,
    placement,
    ...(input.title ? { title: input.title } : {}),
  };
}

function isMultipartFileTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE";
}
