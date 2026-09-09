import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/client.js";
import { requireCurrentUser, type AuthenticatedUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import { ProjectAccessRepository } from "../../project-access/repository.js";
import { ProjectAccessService } from "../../project-access/service.js";
import type { ProjectAccessAction } from "../../project-access/types.js";
import { GenerationDefaultStrategyRepository } from "./repository.js";
import { createGenerationDefaultStrategyService, type GenerationDefaultStrategyService } from "./service.js";
import { generationDefaultMediaKinds, generationDefaultModes } from "./types.js";

const uuid = z.string().uuid();
const paramsSchema = z.object({
  project_id: uuid,
  media_kind: z.enum(generationDefaultMediaKinds),
});
const projectParamsSchema = z.object({ project_id: uuid });
const putSchema = z.object({
  mode: z.enum(generationDefaultModes),
  model_key: z.string().trim().min(1).max(128),
  parameters: z.record(z.string(), z.unknown()).default({}),
  source_generation_request_id: uuid.nullable().optional(),
  expected_version: z.coerce.number().int().min(0),
}).strict().superRefine((value, ctx) => {
  // Lite 模板引用键（docs/design/prd-v2/lite-model-defaults.md §4.3）：只校验格式，
  // 不在这里做引用完整性校验——生成期/客户端对缺失、软删、跨项目的引用统一回落
  // 系统默认（八条·选满足当前需求的最简实现）。
  const raw = value.parameters?.prompt_template_id;
  if (raw === undefined || raw === null) return;
  if (raw === "") return;
  if (typeof raw !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parameters", "prompt_template_id"],
      message: "prompt_template_id 必须是通用唯一标识符或 null",
    });
  }
});

export interface GenerationDefaultsRouteDependencies {
  createService?: () => GenerationDefaultStrategyService;
  createProjectAccessService?: (database: Database) => Pick<ProjectAccessService, "require">;
}

export async function registerGenerationDefaultStrategyRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: GenerationDefaultsRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.()
    ?? createGenerationDefaultStrategyService(new GenerationDefaultStrategyRepository(getDatabase()));
  const projectAccess = () => dependencies.createProjectAccessService?.(getDatabase())
    ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(getDatabase()));

  app.get("/api/v1/projects/:project_id/generation-defaults", async (request) => {
    const params = parseRequest(projectParamsSchema, request.params);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizeGenerationDefaultsProject(projectAccess(), actor, params.project_id, "read");
    const items = await service().list(actor.id, params.project_id, authorizedProjectId);
    return success({ items, count: items.length });
  });

  app.get("/api/v1/projects/:project_id/generation-defaults/:media_kind", async (request) => {
    const params = parseRequest(paramsSchema, request.params);
    const actor = requireCurrentUser(request);
    const authorizedProjectId = await authorizeGenerationDefaultsProject(projectAccess(), actor, params.project_id, "read");
    return success(await service().get(actor.id, params.project_id, params.media_kind, authorizedProjectId));
  });

  app.put("/api/v1/projects/:project_id/generation-defaults/:media_kind", async (request) => {
    const params = parseRequest(paramsSchema, request.params);
    const input = parseRequest(putSchema, request.body);
    const actor = requireCurrentUser(request);
    // Generation defaults are creative parameters, so project editors may
    // update them. This does not submit a paid generation action.
    const authorizedProjectId = await authorizeGenerationDefaultsProject(
      projectAccess(),
      actor,
      params.project_id,
      "create",
    );
    return success(await service().put(actor.id, params.project_id, {
      mediaKind: params.media_kind,
      mode: input.mode,
      modelKey: input.model_key,
      parameters: input.parameters,
      sourceGenerationRequestId: input.source_generation_request_id,
      expectedVersion: input.expected_version,
    }, authorizedProjectId));
  });
}

async function authorizeGenerationDefaultsProject(
  projectAccess: Pick<ProjectAccessService, "require">,
  actor: AuthenticatedUser,
  projectId: string,
  action: ProjectAccessAction,
): Promise<string> {
  const access = await projectAccess.require(actor, projectId, action);
  return access.projectId;
}
