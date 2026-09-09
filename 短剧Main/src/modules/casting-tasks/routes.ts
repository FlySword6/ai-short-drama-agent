import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { CastingTaskService } from "./service.js";
import type { CastingTaskStore } from "./types.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id });
const taskParams = z.object({ id });
const createBody = z.object({
  // 场级单只传 scene_id；镜级单 scene_id + shot_id 都传；
  // 两个都不传是纯补图单(只认 target_asset_entity_id)。
  scene_id: id.optional(),
  shot_id: id.optional(),
  // lane 取值来自 reference_lane_vocabulary 词表；未知/停用 lane 由 store 拒成 422。
  lane: z.string().trim().min(1).max(24),
  target_asset_entity_id: id.optional(),
  target_asset_variant_id: id.optional(),
  title: z.string().trim().min(1).max(255),
  brief: z.string().trim().min(1).max(4000).optional(),
  assignee_user_id: id.optional(),
});
const listQuery = z.object({
  status: z.string().trim().min(1).max(16).optional(),
  assignee_user_id: id.optional(),
  shot_id: id.optional(),
});
const updateBody = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  brief: z.string().trim().min(1).max(4000).nullable().optional(),
  assignee_user_id: id.nullable().optional(),
}).refine(
  (value) => value.title !== undefined || value.brief !== undefined || value.assignee_user_id !== undefined,
  { message: "没有需要修改的内容" },
);

export interface CastingTaskRouteDependencies {
  createCastingTaskService?: (db: Database) => Pick<
    CastingTaskStore,
    "create" | "list" | "get" | "update"
  >;
}

export async function registerCastingTaskRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: CastingTaskRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createCastingTaskService?.(getDatabase())
    ?? new CastingTaskService(getDatabase());

  app.post("/api/v1/projects/:project_id/casting-tasks", async (request, reply) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(createBody, request.body);
    const data = await service().create(requireCurrentUser(request), params.project_id, {
      sceneId: input.scene_id,
      shotId: input.shot_id,
      lane: input.lane,
      targetAssetEntityId: input.target_asset_entity_id,
      targetAssetVariantId: input.target_asset_variant_id,
      title: input.title,
      brief: input.brief,
      assigneeUserId: input.assignee_user_id,
    });
    return reply.code(201).send(success(data));
  });

  app.get("/api/v1/projects/:project_id/casting-tasks", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const query = parseRequest(listQuery, request.query);
    return success(await service().list(requireCurrentUser(request), params.project_id, {
      status: query.status,
      assigneeUserId: query.assignee_user_id,
      shotId: query.shot_id,
    }));
  });

  app.get("/api/v1/casting-tasks/:id", async (request) => {
    const params = parseRequest(taskParams, request.params);
    return success(await service().get(requireCurrentUser(request), params.id));
  });

  app.patch("/api/v1/casting-tasks/:id", async (request) => {
    const params = parseRequest(taskParams, request.params);
    const input = parseRequest(updateBody, request.body);
    return success(await service().update(requireCurrentUser(request), params.id, {
      title: input.title,
      brief: input.brief,
      assigneeUserId: input.assignee_user_id,
    }));
  });
}
