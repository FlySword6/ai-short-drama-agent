import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { publicStoredMessage } from "../../shared/errors.js";
import { AssetMediaRepairService } from "./mediaRepairService.js";
import type {
  AssetMediaHealthView,
  AssetMediaRepairActor,
  AssetMediaRepairTaskView,
} from "./mediaRepairTypes.js";
import type { AssetMediaRepairKickPort } from "./mediaRepairWorker.js";

const id = z.string().uuid();
const assetParams = z.object({ asset_id: id });
const taskParams = z.object({ asset_id: id, repair_id: id });
const mediaParams = z.object({ asset_id: id, media_id: id });
const createRepairSchema = z.object({
  client_idempotency_key: id,
  media_ids: z.array(id).max(500).optional(),
  mode: z.literal("safe").default("safe"),
}).strict();

export interface AssetMediaRepairRouteService {
  health(actor: AssetMediaRepairActor, assetId: string): Promise<AssetMediaHealthView>;
  submit(input: {
    actor: AssetMediaRepairActor;
    assetId: string;
    clientIdempotencyKey: string;
    mediaIds?: string[];
    mode: "safe";
  }): Promise<AssetMediaRepairTaskView>;
  get(
    actor: AssetMediaRepairActor,
    assetId: string,
    taskId: string,
  ): Promise<AssetMediaRepairTaskView>;
  createDownloadUrl(
    actor: AssetMediaRepairActor,
    assetId: string,
    mediaId: string,
    options?: { disposition?: "download" | "inline" },
  ): Promise<{ mediaId: string; url: string; expiresAt: Date }>;
}
export interface AssetMediaRepairRouteDependencies {
  createService?: (db: Database) => AssetMediaRepairRouteService;
  worker?: AssetMediaRepairKickPort;
}

export async function registerAssetMediaRepairRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AssetMediaRepairRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase())
    ?? AssetMediaRepairService.fromDatabase(getDatabase());

  app.get("/api/v1/assets/:asset_id/media-health", async (request) => {
    const params = parseRequest(assetParams, request.params);
    const actor = requireCurrentUser(request);
    return success(mediaHealthData(await service().health(actor, params.asset_id)));
  });

  app.post("/api/v1/assets/:asset_id/media-repairs", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const params = parseRequest(assetParams, request.params);
    const input = parseRequest(createRepairSchema, request.body);
    const task = await service().submit({
      actor: requireCurrentUser(request),
      assetId: params.asset_id,
      clientIdempotencyKey: input.client_idempotency_key,
      ...(input.media_ids ? { mediaIds: input.media_ids } : {}),
      mode: input.mode,
    });
    dependencies.worker?.kick();
    return reply.code(202).send(success(mediaRepairTaskData(task)));
  });

  app.get("/api/v1/assets/:asset_id/media-repairs/:repair_id", async (request) => {
    const params = parseRequest(taskParams, request.params);
    const task = await service().get(
      requireCurrentUser(request),
      params.asset_id,
      params.repair_id,
    );
    return success(mediaRepairTaskData(task));
  });

  app.post("/api/v1/assets/:asset_id/media/:media_id/download-url", async (request) => {
    const params = parseRequest(mediaParams, request.params);
    const result = await service().createDownloadUrl(
      requireCurrentUser(request),
      params.asset_id,
      params.media_id,
    );
    return success({
      media_id: result.mediaId,
      url: result.url,
      expires_at: result.expiresAt,
    });
  });

  app.post("/api/v1/assets/:asset_id/media/:media_id/preview-url", async (request) => {
    const params = parseRequest(mediaParams, request.params);
    const result = await service().createDownloadUrl(
      requireCurrentUser(request),
      params.asset_id,
      params.media_id,
      { disposition: "inline" },
    );
    return success({
      media_id: result.mediaId,
      url: result.url,
      expires_at: result.expiresAt,
    });
  });

  app.get("/api/v1/assets/:asset_id/media/:media_id/download", async (request, reply) => {
    const params = parseRequest(mediaParams, request.params);
    const result = await service().createDownloadUrl(
      requireCurrentUser(request),
      params.asset_id,
      params.media_id,
    );
    return reply.redirect(result.url, 302);
  });
}

export function mediaHealthData(view: AssetMediaHealthView): Record<string, unknown> {
  return {
    asset_id: view.assetId,
    status: view.status,
    active_repair_task_id: view.activeRepairTaskId,
    media_count: view.mediaCount,
    healthy_media_count: view.healthyMediaCount,
    checked_at: view.checkedAt,
    issues: view.issues.map((issue) => ({
      code: issue.code,
      media_id: issue.mediaId,
      rendition_kind: issue.renditionKind,
      display_reason: issue.displayReason,
      auto_repairable: issue.autoRepairable,
      blocker: issue.blocker,
    })),
  };
}

export function mediaRepairTaskData(view: AssetMediaRepairTaskView): Record<string, unknown> {
  const displayReason = view.errorMessage
    ? publicStoredMessage(
        view.errorMessage,
        "资产媒体修复还没完成，请稍后重试；若仍失败请交给管理员检查。",
      )
    : null;
  return {
    id: view.id,
    asset_id: view.assetId,
    requested_by_user_id: view.requestedByUserId,
    client_idempotency_key: view.clientIdempotencyKey,
    mode: view.mode,
    trigger: view.trigger,
    media_ids: view.mediaIds,
    status: view.status,
    diagnosis: view.diagnosis,
    result: view.result,
    error_code: view.errorCode,
    display_reason: displayReason,
    created_at: view.createdAt,
    started_at: view.startedAt,
    finished_at: view.finishedAt,
    updated_at: view.updatedAt,
    idempotent_replay: view.idempotentReplay,
  };
}
