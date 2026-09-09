import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { ScenePrepService } from "./service.js";
import type { ScenePrepStore } from "./types.js";

const uuid = z.string().uuid();
const sceneParams = z.object({ scene_id: uuid });
const itemParams = z.object({ scene_id: uuid, item_id: uuid });
const idempotencyKey = z.string().trim().min(8).max(255);
const pullBody = z.object({
  lane: z.string().trim().min(1).max(24),
  asset_entity_id: uuid,
  asset_variant_id: uuid.nullable().optional(),
  asset_media_id: uuid.nullable().optional(),
  client_idempotency_key: idempotencyKey,
}).strict();
const commitBody = z.object({
  client_idempotency_key: idempotencyKey,
  item_ids: z.array(uuid).min(1).max(50).optional(),
  shot_ids: z.array(uuid).min(1).max(200).optional(),
  all_shots: z.boolean().default(false),
  i_mean_it: z.boolean().default(false),
}).strict().superRefine((input, context) => {
  if (input.all_shots && input.shot_ids) {
    context.addIssue({ code: "custom", path: ["shot_ids"], message: "指定镜头与铺全场不能同时使用" });
  }
  if (input.all_shots && !input.i_mean_it) {
    context.addIssue({ code: "custom", path: ["i_mean_it"], message: "铺全场前需要再次明确确认" });
  }
  if (!input.all_shots && input.i_mean_it) {
    context.addIssue({ code: "custom", path: ["i_mean_it"], message: "只有铺全场时才需要这个确认" });
  }
});

export interface ScenePrepRouteDependencies {
  createService?: (database: Database) => ScenePrepStore;
}

export async function registerScenePrepRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ScenePrepRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase())
    ?? new ScenePrepService(getDatabase());

  app.get("/api/v1/scenes/:scene_id/prep-list", async (request) => {
    const params = parseRequest(sceneParams, request.params);
    const items = await service().list(requireCurrentUser(request), params.scene_id);
    return success({
      sceneId: params.scene_id,
      items,
      count: items.length,
      pendingCount: items.filter((item) => item.status === "pending").length,
      committedCount: items.filter((item) => item.status === "committed").length,
    });
  });

  app.post("/api/v1/scenes/:scene_id/prep-list/items", async (request, reply) => {
    const params = parseRequest(sceneParams, request.params);
    const input = parseRequest(pullBody, request.body);
    const item = await service().pull(requireCurrentUser(request), params.scene_id, {
      lane: input.lane,
      assetEntityId: input.asset_entity_id,
      assetVariantId: input.asset_variant_id,
      assetMediaId: input.asset_media_id,
      clientIdempotencyKey: input.client_idempotency_key,
    });
    return created(reply, item);
  });

  app.delete("/api/v1/scenes/:scene_id/prep-list/items/:item_id", async (request) => {
    const params = parseRequest(itemParams, request.params);
    await service().remove(requireCurrentUser(request), params.scene_id, params.item_id);
    return success({ deleted: true, itemId: params.item_id });
  });

  app.post("/api/v1/scenes/:scene_id/prep-list/commit", async (request) => {
    const params = parseRequest(sceneParams, request.params);
    const input = parseRequest(commitBody, request.body);
    return success(await service().commit(requireCurrentUser(request), params.scene_id, {
      clientIdempotencyKey: input.client_idempotency_key,
      itemIds: input.item_ids,
      shotIds: input.shot_ids,
      allShots: input.all_shots,
    }));
  });
}

function created(reply: FastifyReply, data: unknown) {
  return reply.code(201).send(success(data));
}
