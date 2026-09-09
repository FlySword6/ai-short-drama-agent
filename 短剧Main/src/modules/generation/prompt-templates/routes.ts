import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/client.js";
import { requireCurrentUser, type AuthenticatedUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import { ProjectAccessRepository } from "../../project-access/repository.js";
import { ProjectAccessService } from "../../project-access/service.js";
import type { ProjectAccessAction } from "../../project-access/types.js";
import { PromptTemplateRepository } from "./repository.js";
import { createPromptTemplateService, type PromptTemplateService } from "./service.js";
import {
  promptTemplateMediaKinds,
  PROMPT_TEMPLATE_CONTENT_MAX,
  PROMPT_TEMPLATE_NAME_MAX,
  type PromptTemplate,
} from "./types.js";

const uuid = z.string().uuid();
const projectParamsSchema = z.object({ project_id: uuid });
const listQuerySchema = z.object({
  media_kind: z.enum(promptTemplateMediaKinds).optional(),
});
const resourceParamsSchema = z.object({
  project_id: uuid,
  template_id: uuid,
});
const writeSchema = z.object({
  media_kind: z.enum(promptTemplateMediaKinds),
  name: z.string().trim().min(1).max(PROMPT_TEMPLATE_NAME_MAX),
  content: z.string().trim().min(1).max(PROMPT_TEMPLATE_CONTENT_MAX),
}).strict();

export interface PromptTemplateRouteDependencies {
  createService?: () => PromptTemplateService;
  createProjectAccessService?: (database: Database) => Pick<ProjectAccessService, "require">;
}

export async function registerPromptTemplateRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: PromptTemplateRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.()
    ?? createPromptTemplateService(new PromptTemplateRepository(getDatabase()));
  const projectAccess = () => dependencies.createProjectAccessService?.(getDatabase())
    ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(getDatabase()));

  app.get("/api/v1/projects/:project_id/prompt-templates", async (request) => {
    const params = parseRequest(projectParamsSchema, request.params);
    const query = parseRequest(listQuerySchema, request.query);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizePromptTemplateProject(projectAccess(), actor, params.project_id, "read");
    const items = await service().list(actor.id, params.project_id, query.media_kind, authorizedProjectId);
    return success({
      items: items.map(promptTemplateData),
      count: items.length,
    });
  });

  app.post("/api/v1/projects/:project_id/prompt-templates", async (request) => {
    const params = parseRequest(projectParamsSchema, request.params);
    const input = parseRequest(writeSchema, request.body);
    const actor = requireCurrentUser(request);
    // 模板库是配置读写，不触发付费动作。
    const authorizedProjectId = await authorizePromptTemplateProject(projectAccess(), actor, params.project_id, "create");
    return success(promptTemplateData(await service().create(actor.id, params.project_id, {
      mediaKind: input.media_kind,
      name: input.name,
      content: input.content,
    }, authorizedProjectId)));
  });

  app.put("/api/v1/projects/:project_id/prompt-templates/:template_id", async (request) => {
    const params = parseRequest(resourceParamsSchema, request.params);
    const input = parseRequest(writeSchema, request.body);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizePromptTemplateProject(projectAccess(), actor, params.project_id, "create");
    return success(promptTemplateData(await service().update(actor.id, params.project_id, params.template_id, {
      mediaKind: input.media_kind,
      name: input.name,
      content: input.content,
    }, authorizedProjectId)));
  });

  app.delete("/api/v1/projects/:project_id/prompt-templates/:template_id", async (request) => {
    const params = parseRequest(resourceParamsSchema, request.params);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizePromptTemplateProject(projectAccess(), actor, params.project_id, "create");
    await service().softDelete(actor.id, params.project_id, params.template_id, authorizedProjectId);
    return success({ template_id: params.template_id, deleted: true });
  });
}

async function authorizePromptTemplateProject(
  projectAccess: Pick<ProjectAccessService, "require">,
  actor: AuthenticatedUser,
  projectId: string,
  action: ProjectAccessAction,
): Promise<string> {
  const access = await projectAccess.require(actor, projectId, action);
  return access.projectId;
}

function promptTemplateData(template: PromptTemplate): Record<string, unknown> {
  return {
    id: template.id,
    project_id: template.projectId,
    media_kind: template.mediaKind,
    name: template.name,
    content: template.content,
    created_by_user_id: template.createdByUserId,
    deleted_by_user_id: template.deletedByUserId,
    deleted_at: template.deletedAt ? template.deletedAt.toISOString() : null,
    created_at: template.createdAt.toISOString(),
    updated_at: template.updatedAt.toISOString(),
  };
}
