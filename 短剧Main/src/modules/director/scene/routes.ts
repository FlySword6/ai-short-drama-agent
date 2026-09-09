import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/client.js";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest } from "../../../http/response.js";
import { sceneSnapshotSchema } from "../commands/snapshot.js";
import { DirectorSceneService } from "./service.js";
import type { DirectorSceneRecord, DirectorSceneVersionRecord } from "./repository.js";

/**
 * 导演台场景与版本 API。与模版接口同为 camelCase 数据契约：不走 success()
 * 的 snake_case 转换（快照本体就是导演台场景 JSON），错误仍走全局错误信封。
 */

const projectParams = z.object({ project_id: z.string().uuid() });

const saveSceneBodySchema = z.object({
  sceneVersion: z.number().int().min(0),
  snapshot: sceneSnapshotSchema,
  sourceAction: z.string().trim().min(1).max(64).optional(),
  status: z.enum(["draft", "saved"]).optional(),
});

export interface SceneRouteDependencies {
  createSceneService?: (
    db: Database,
  ) => Pick<DirectorSceneService, "get" | "save" | "listVersions">;
}

export async function registerDirectorSceneRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: SceneRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createSceneService?.(getDatabase())
    ?? new DirectorSceneService(getDatabase());

  app.get("/api/v1/projects/:project_id/director/scene", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const scene = await service().get(actor, params.project_id);
    return { ok: true, data: toSceneResponse(scene) };
  });

  app.put("/api/v1/projects/:project_id/director/scene", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const body = parseRequest(saveSceneBodySchema, request.body);
    const result = await service().save(actor, params.project_id, {
      sceneVersion: body.sceneVersion,
      snapshot: body.snapshot as Record<string, unknown>,
      ...(body.sourceAction ? { sourceAction: body.sourceAction } : {}),
      ...(body.status ? { status: body.status } : {}),
    });
    return {
      ok: true,
      data: {
        ...toSceneResponse(result.scene),
        savedVersion: toVersionResponse(result.version),
      },
    };
  });

  app.get("/api/v1/projects/:project_id/director/scene/versions", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const { scene, versions } = await service().listVersions(actor, params.project_id);
    return {
      ok: true,
      data: {
        sceneId: scene.id,
        currentVersion: scene.currentVersion,
        versions: versions.map(toVersionResponse),
      },
    };
  });
}

function toSceneResponse(scene: DirectorSceneRecord): Record<string, unknown> {
  return {
    id: scene.id,
    projectId: scene.projectId,
    status: scene.status,
    currentVersion: scene.currentVersion,
    snapshot: scene.snapshot,
    createdByUserId: scene.createdByUserId,
    createdAt: scene.createdAt,
    updatedAt: scene.updatedAt,
  };
}

function toVersionResponse(version: DirectorSceneVersionRecord): Record<string, unknown> {
  return {
    id: version.id,
    sceneId: version.sceneId,
    version: version.version,
    kind: version.kind,
    sourceAction: version.sourceAction,
    createdByUserId: version.createdByUserId,
    createdAt: version.createdAt,
  };
}
