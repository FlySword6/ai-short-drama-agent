import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { ShotMediaService } from "./service.js";

const id = z.string().uuid();
const shotParams = z.object({ shot_id: id });
const shotMediaParams = z.object({ shot_id: id, media_id: id });
const assetMediaBody = z.object({ asset_media_id: id });
const versionLabelBody = z.object({
  version_label: z.string().trim().max(255).nullable(),
  version_note: z.string().trim().max(2000).nullable(),
}).strict();

export interface ShotMediaRouteDependencies {
  createShotMediaService?: (
    db: Database,
  ) => Pick<ShotMediaService, "list" | "setPrimary" | "registerAssetMediaAsPrimary" | "setVersionLabel" | "deleteMedia">;
}

export async function registerShotMediaRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ShotMediaRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createShotMediaService?.(getDatabase())
    ?? new ShotMediaService(getDatabase());

  app.get("/api/v1/shots/:shot_id/media", async (request) => {
    const params = parseRequest(shotParams, request.params);
    const items = await service().list(requireCurrentUser(request), params.shot_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/shots/:shot_id/media/:media_id/set-primary", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const params = parseRequest(shotMediaParams, request.params);
    const data = await service().setPrimary(
      requireCurrentUser(request),
      params.shot_id,
      params.media_id,
    );
    return success(data);
  });

  app.post("/api/v1/shots/:shot_id/media/from-asset", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const params = parseRequest(shotParams, request.params);
    const input = parseRequest(assetMediaBody, request.body);
    const data = await service().registerAssetMediaAsPrimary(
      requireCurrentUser(request),
      params.shot_id,
      input.asset_media_id,
    );
    return reply.code(data.created ? 201 : 200).send(success(toAssetRegistrationResponse(data)));
  });

  // v1.4(迁移 065):视频版本标签与备注。
  app.patch("/api/v1/shots/:shot_id/media/:media_id/version-label", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const params = parseRequest(shotMediaParams, request.params);
    const input = parseRequest(versionLabelBody, request.body);
    const data = await service().setVersionLabel(
      requireCurrentUser(request),
      params.shot_id,
      params.media_id,
      input.version_label,
      input.version_note,
    );
    return success(data);
  });

  // Lite 界面重做 §4.3.2:删除视频版本(软删;当前版需先换)。
  app.delete("/api/v1/shots/:shot_id/media/:media_id", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const params = parseRequest(shotMediaParams, request.params);
    const data = await service().deleteMedia(
      requireCurrentUser(request),
      params.shot_id,
      params.media_id,
    );
    return success(data);
  });
}

function toAssetRegistrationResponse(data: Awaited<ReturnType<ShotMediaService["registerAssetMediaAsPrimary"]>>) {
  return { ...data, origin_label: "从素材库选用" };
}
