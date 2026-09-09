import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/client.js";
import { requireCurrentUser, type AuthenticatedUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import { ProjectAccessRepository } from "../../project-access/repository.js";
import { ProjectAccessService } from "../../project-access/service.js";
import type { ProjectAccessAction } from "../../project-access/types.js";
import { ProjectStyleRepository } from "./repository.js";
import { createProjectStyleService, type ProjectStyleService } from "./service.js";
import {
  projectStyleMediaKinds,
  PROJECT_STYLE_CONTENT_MAX,
  PROJECT_STYLE_NAME_MAX,
  type ProjectStyle,
} from "./types.js";

const uuid = z.string().uuid();
const projectParamsSchema = z.object({ project_id: uuid });
const listQuerySchema = z.object({
  media_kind: z.enum(projectStyleMediaKinds).optional(),
});
const resourceParamsSchema = z.object({
  project_id: uuid,
  style_id: uuid,
});
const writeSchema = z.object({
  media_kind: z.enum(projectStyleMediaKinds),
  name: z.string().trim().min(1).max(PROJECT_STYLE_NAME_MAX),
  content: z.string().trim().min(1).max(PROJECT_STYLE_CONTENT_MAX),
}).strict();

export interface ProjectStyleRouteDependencies {
  createService?: () => ProjectStyleService;
  createProjectAccessService?: (database: Database) => Pick<ProjectAccessService, "require">;
}

export async function registerProjectStyleRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ProjectStyleRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.()
    ?? createProjectStyleService(new ProjectStyleRepository(getDatabase()));
  const projectAccess = () => dependencies.createProjectAccessService?.(getDatabase())
    ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(getDatabase()));

  app.get("/api/v1/projects/:project_id/project-styles", async (request) => {
    const params = parseRequest(projectParamsSchema, request.params);
    const query = parseRequest(listQuerySchema, request.query);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizeProjectStyleProject(projectAccess(), actor, params.project_id, "read");
    const items = await service().list(actor.id, params.project_id, query.media_kind, authorizedProjectId);
    return success({
      items: items.map(projectStyleData),
      count: items.length,
    });
  });

  app.post("/api/v1/projects/:project_id/project-styles", async (request) => {
    const params = parseRequest(projectParamsSchema, request.params);
    const input = parseRequest(writeSchema, request.body);
    const actor = requireCurrentUser(request);
    // 风格库是配置读写，不触发付费动作。
    const authorizedProjectId = await authorizeProjectStyleProject(projectAccess(), actor, params.project_id, "create");
    return success(projectStyleData(await service().create(actor.id, params.project_id, {
      mediaKind: input.media_kind,
      name: input.name,
      content: input.content,
    }, authorizedProjectId)));
  });

  app.put("/api/v1/projects/:project_id/project-styles/:style_id", async (request) => {
    const params = parseRequest(resourceParamsSchema, request.params);
    const input = parseRequest(writeSchema, request.body);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizeProjectStyleProject(projectAccess(), actor, params.project_id, "create");
    return success(projectStyleData(await service().update(actor.id, params.project_id, params.style_id, {
      mediaKind: input.media_kind,
      name: input.name,
      content: input.content,
    }, authorizedProjectId)));
  });

  app.delete("/api/v1/projects/:project_id/project-styles/:style_id", async (request) => {
    const params = parseRequest(resourceParamsSchema, request.params);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizeProjectStyleProject(projectAccess(), actor, params.project_id, "create");
    await service().softDelete(actor.id, params.project_id, params.style_id, authorizedProjectId);
    return success({ style_id: params.style_id, deleted: true });
  });

  // 设/换默认（D1 2026-08-17 修订：可逆）：事务内旧默认让位 + 置位 + 镜像写 projects.style*；
  // 并发换设由唯一索引兜底 → 409 可重试（并发保护，非锁定）。
  app.put("/api/v1/projects/:project_id/project-styles/:style_id/default", async (request) => {
    const params = parseRequest(resourceParamsSchema, request.params);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizeProjectStyleProject(projectAccess(), actor, params.project_id, "create");
    return success(projectStyleData(await service().setDefault(actor.id, params.project_id, params.style_id, authorizedProjectId)));
  });

  // 取消默认（D1：默认可为空）：is_default 置 false + 镜像清空，回「无默认」空态（幂等）。
  app.delete("/api/v1/projects/:project_id/project-styles/:style_id/default", async (request) => {
    const params = parseRequest(resourceParamsSchema, request.params);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizeProjectStyleProject(projectAccess(), actor, params.project_id, "create");
    return success(projectStyleData(await service().unsetDefault(actor.id, params.project_id, params.style_id, authorizedProjectId)));
  });
}

async function authorizeProjectStyleProject(
  projectAccess: Pick<ProjectAccessService, "require">,
  actor: AuthenticatedUser,
  projectId: string,
  action: ProjectAccessAction,
): Promise<string> {
  const access = await projectAccess.require(actor, projectId, action);
  return access.projectId;
}

function projectStyleData(style: ProjectStyle): Record<string, unknown> {
  return {
    id: style.id,
    project_id: style.projectId,
    media_kind: style.mediaKind,
    name: style.name,
    content: style.content,
    is_default: style.isDefault,
    created_by_user_id: style.createdByUserId,
    deleted_by_user_id: style.deletedByUserId,
    deleted_at: style.deletedAt ? style.deletedAt.toISOString() : null,
    created_at: style.createdAt.toISOString(),
    updated_at: style.updatedAt.toISOString(),
  };
}
