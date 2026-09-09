import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser, type AuthenticatedUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessAction } from "../project-access/types.js";
import { ProjectAssetService } from "./service.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id });
const projectReferenceParams = z.object({ project_id: id, ref_id: id });
const addReferenceSchema = z.object({
  asset_entity_id: id,
  asset_variant_id: id.nullable().optional(),
  asset_media_id: id.nullable().optional(),
});

type ProjectAssetAccess = Pick<ProjectAccessService, "require">;

export interface ProjectAssetRouteDependencies {
  createService?: (database: Database) => Pick<ProjectAssetService, "list" | "addReference" | "removeReference">;
  createProjectAccessService?: (database: Database) => ProjectAssetAccess;
}

export async function registerProjectAssetRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ProjectAssetRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase()) ?? new ProjectAssetService(getDatabase());
  const projectAccess = () => dependencies.createProjectAccessService?.(getDatabase())
    ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(getDatabase()));

  app.get("/api/v1/projects/:project_id/assets", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const access = await requireProjectAssetAccess(projectAccess(), actor, params.project_id, "read");
    const items = await service().list(actor.id, params.project_id, access.projectId);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/projects/:project_id/assets", {
    config: { agentAccess: "prep" },
  }, async (request, reply) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(addReferenceSchema, request.body);
    const actor = requireCurrentUser(request);
    const access = await requireProjectAssetAccess(projectAccess(), actor, params.project_id, "create");
    const item = await service().addReference(actor.id, params.project_id, {
      assetEntityId: input.asset_entity_id,
      assetVariantId: input.asset_variant_id,
      assetMediaId: input.asset_media_id,
    }, access.projectId);
    return created(reply, item);
  });

  app.delete("/api/v1/projects/:project_id/assets/:ref_id", async (request) => {
    const params = parseRequest(projectReferenceParams, request.params);
    const actor = requireCurrentUser(request);
    const access = await requireProjectAssetAccess(projectAccess(), actor, params.project_id, "create");
    await service().removeReference(actor.id, params.project_id, params.ref_id, access.projectId);
    return success({ deleted: true });
  });
}

async function requireProjectAssetAccess(
  access: ProjectAssetAccess,
  actor: AuthenticatedUser,
  projectId: string,
  action: ProjectAccessAction,
) {
  return access.require(actor, projectId, action);
}

function created(reply: FastifyReply, data: unknown) {
  return reply.code(201).send(success(data));
}
