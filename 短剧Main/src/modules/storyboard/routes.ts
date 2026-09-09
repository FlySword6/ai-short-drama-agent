import { createHash } from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";
import { StoryboardExcelParser } from "../../services/storyboard/parser.js";
import { DrizzleStoryboardImportRepository } from "./repository.js";
import { StoryboardImportService } from "./service.js";
import type { StoryboardImportRecord } from "./types.js";

const projectParams = z.object({ project_id: z.string().uuid() });
const importParams = z.object({ import_id: z.string().uuid() });

export async function registerStoryboardRoutes(app: FastifyInstance, getDatabase: () => Database): Promise<void> {
  app.post("/api/v1/projects/:project_id/storyboard-imports/preview", async (request, reply) => {
    const params = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const file = await request.file();
    if (!file) throw new BadRequestError("缺少分镜 Excel 文件");
    const extension = path.extname(file.filename).toLowerCase();
    if (extension !== ".xlsx" && extension !== ".xlsm") throw new BadRequestError("分镜文件格式不支持，请上传 Excel 文件");
    const content = await file.toBuffer();
    if (!content.length) throw new BadRequestError("分镜 Excel 文件为空");
    if (content.length > 20 * 1024 * 1024) throw new BadRequestError("分镜 Excel 文件不能超过 20 兆");

    const repository = new DrizzleStoryboardImportRepository(
      getDatabase(),
      createHash("sha256").update(content).digest("hex"),
    );
    await repository.requireProjectAccess(params.project_id, actor, "create");
    const record = await new StoryboardImportService(new StoryboardExcelParser(), repository).preview({
      projectId: params.project_id,
      actor,
      fileName: file.filename,
      content,
    });
    return reply.code(201).send(success(toResponse(record)));
  });

  app.get("/api/v1/storyboard-imports/:import_id", async (request) => {
    const params = parseRequest(importParams, request.params);
    const actor = requireCurrentUser(request);
    const repository = new DrizzleStoryboardImportRepository(getDatabase());
    const record = await repository.getById(params.import_id);
    if (!record) throw new NotFoundError("分镜导入记录不存在");
    await repository.requireProjectAccess(record.projectId, actor, "read");
    return success(toResponse(record));
  });

  app.post("/api/v1/storyboard-imports/:import_id/confirm", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const params = parseRequest(importParams, request.params);
    const actor = requireCurrentUser(request);
    const repository = new DrizzleStoryboardImportRepository(getDatabase());
    const current = await repository.getById(params.import_id);
    if (!current) throw new NotFoundError("分镜导入记录不存在");
    await repository.requireProjectAccess(current.projectId, actor, "create");
    const record = await new StoryboardImportService(new StoryboardExcelParser(), repository).confirm({
      importId: current.id,
      projectId: current.projectId,
      actor,
    });
    return success(toResponse(record));
  });
}

function toResponse(record: StoryboardImportRecord) {
  return {
    id: record.id,
    project_id: record.projectId,
    uploaded_by: record.uploadedBy,
    file_name: record.fileName,
    status: record.status,
    preview: {
      rows: record.preview.rows.map((row) => ({
        source_sheet: row.sourceSheet,
        source_row: row.sourceRow,
        episode_no: row.episodeNo,
        scene_name: row.sceneName,
        shot_no: row.shotCode,
        sort_order: row.sortOrder,
        screen_description: row.screenDescription,
        camera_movement: row.cameraMovement,
        shot_size_angle: row.shotSizeAngle,
        dialogue: row.dialogue,
        sound_effect: row.soundEffect,
        reference_image_note: row.referenceImageNote,
        storyboard_image_note: row.storyboardImageNote,
      })),
      issues: record.preview.issues.map((issue) => ({
        level: issue.level,
        code: issue.code,
        message: issue.message,
        source_row: issue.sourceRow,
      })),
      episode_count: record.preview.episodeCount,
      scene_count: record.preview.sceneCount,
      shot_count: record.preview.shotCount,
      can_confirm: record.preview.canConfirm,
    },
    confirmation_result: record.confirmationResult,
    confirmed_at: record.confirmedAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
  };
}
