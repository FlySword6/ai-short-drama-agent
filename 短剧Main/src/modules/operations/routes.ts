import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { requireCurrentSessionId, requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { OperationsRepository } from "./repository.js";
import { OperationsService } from "./service.js";
import {
  capabilitiesOpenApiSchema,
  projectMemberCreateOpenApiSchema,
  projectMemberDeleteOpenApiSchema,
  projectMemberListOpenApiSchema,
  projectMemberUpdateOpenApiSchema,
} from "./openapi.js";
import {
  PROJECT_PRODUCTION_ROLES,
  PROJECT_ROLES,
  REVIEW_STRATEGIES,
  type AdminCostGroupBy,
  type CostAggregatePage,
  type CostFilter,
  type OperationsActor,
  type OperationsStore,
  type ProjectCostGroupBy,
  type ProjectOperationsPatch,
} from "./types.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id });
const projectMemberParams = z.object({ project_id: id, user_id: id });
const teamParams = z.object({ team_id: id });
const teamMemberParams = z.object({ team_id: id, user_id: id });
const groupParams = z.object({ group_id: id });
const groupMemberParams = z.object({ group_id: id, user_id: id });

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(128).optional(),
}).strict();

const teamCreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  parent_team_id: id.nullable().optional(),
}).strict();
const teamUpdateSchema = teamCreateSchema.partial().refine(hasAnyProperty, "至少提供一个要修改的字段");
const userGroupCreateSchema = z.object({ name: z.string().trim().min(1).max(128) }).strict();
const userGroupUpdateSchema = userGroupCreateSchema.refine(hasAnyProperty, "至少提供一个要修改的字段");

const projectMemberCreateSchema = z.object({
  user_id: id,
  role: z.enum(PROJECT_ROLES),
  production_roles: z.array(z.enum(PROJECT_PRODUCTION_ROLES))
    .max(PROJECT_PRODUCTION_ROLES.length)
    .refine(uniqueItems, "项目生产角色不能重复")
    .optional(),
}).strict();
const projectMemberUpdateSchema = z.object({
  role: z.enum(PROJECT_ROLES).optional(),
  production_roles: z.array(z.enum(PROJECT_PRODUCTION_ROLES))
    .max(PROJECT_PRODUCTION_ROLES.length)
    .refine(uniqueItems, "项目生产角色不能重复")
    .optional(),
}).strict().refine(hasAnyProperty, "至少提供一个要修改的成员字段");
const userMembershipCreateSchema = z.object({ user_id: id }).strict();

const costDateFilterSchema = paginationSchema.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const projectCostQuerySchema = costDateFilterSchema.extend({
  group_by: z.enum(["member", "model", "day"]),
}).strict().refine(validDateOrder, { message: "开始日期不能晚于结束日期", path: ["from"] });
const adminCostQuerySchema = costDateFilterSchema.extend({
  group_by: z.enum(["project", "team", "user", "model"]),
  format: z.enum(["json", "csv"]).default("json"),
}).strict().refine(validDateOrder, { message: "开始日期不能晚于结束日期", path: ["from"] });

const reviewPolicyPatchSchema = z.object({
  default_strategy: z.enum(REVIEW_STRATEGIES).optional(),
  reviewer_user_id: id.nullable().optional(),
}).strict().refine(hasAnyProperty, "审核策略至少修改一个字段");

/**
 * The production module already owns PATCH /api/v1/projects/:project_id.
 * Export this schema and mapper so the integration owner can extend that
 * existing handler without registering a duplicate Fastify route.
 */
export const projectOperationsPatchSchema = z.object({
  genre: z.string().trim().min(1).max(32).nullable().optional(),
  review_policies: z.object({
    image: reviewPolicyPatchSchema.optional(),
    video: reviewPolicyPatchSchema.optional(),
  }).strict().optional(),
}).strict().refine((value) => value.genre !== undefined || value.review_policies !== undefined, {
  message: "至少提供一个要修改的项目运营字段",
});

export interface OperationsRouteDependencies {
  createStore?: () => OperationsStore;
  allowMemberCreateProject?: boolean;
}

/**
 * Integration owner wires one line in src/http/routes.ts:
 * `await registerOperationsRoutes(app, options.getDatabase);`
 *
 * It deliberately does not register the project PATCH path; see
 * projectOperationsPatchSchema and `parseProjectOperationsPatch` below.
 */
export async function registerOperationsRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: OperationsRouteDependencies = {},
): Promise<void> {
  const service = () => new OperationsService(
    dependencies.createStore?.() ?? new OperationsRepository(getDatabase()),
    { allowMemberCreateProject: dependencies.allowMemberCreateProject ?? settings.allowMemberCreateProject },
  );

  app.get("/api/v1/me/capabilities", {
    schema: capabilitiesOpenApiSchema,
  }, async (request) => {
    const capabilities = await service().getCapabilities(requireCurrentUser(request).id);
    return success({
      platformRole: capabilities.platformRole,
      allowMemberCreateProject: capabilities.allowMemberCreateProject,
      projects: capabilities.projectRoles,
      permissions: capabilities.permissions,
    });
  });

  app.get("/api/v1/projects/:project_id/members", {
    attachValidation: true,
    schema: projectMemberListOpenApiSchema,
  }, async (request) => {
    const params = parseRequest(projectParams, request.params);
    const items = await service().listProjectMembers(actor(request), params.project_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/projects/:project_id/members", {
    attachValidation: true,
    schema: projectMemberCreateOpenApiSchema,
  }, async (request, reply) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(projectMemberCreateSchema, request.body);
    const item = await service().addProjectMember(writeActor(request), params.project_id, {
      userId: input.user_id,
      role: input.role,
      ...(input.production_roles === undefined
        ? {}
        : { productionRoles: input.production_roles }),
    });
    return reply.code(201).send(success({ item }));
  });

  app.patch("/api/v1/projects/:project_id/members/:user_id", {
    attachValidation: true,
    schema: projectMemberUpdateOpenApiSchema,
  }, async (request) => {
    const params = parseRequest(projectMemberParams, request.params);
    const input = parseRequest(projectMemberUpdateSchema, request.body);
    const item = await service().updateProjectMember(
      writeActor(request),
      params.project_id,
      params.user_id,
      {
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.production_roles === undefined
          ? {}
          : { productionRoles: input.production_roles }),
      },
    );
    return success({ item });
  });

  app.delete("/api/v1/projects/:project_id/members/:user_id", {
    attachValidation: true,
    schema: projectMemberDeleteOpenApiSchema,
  }, async (request) => {
    const params = parseRequest(projectMemberParams, request.params);
    await service().removeProjectMember(writeActor(request), params.project_id, params.user_id);
    return success({ deleted: true, userId: params.user_id });
  });

  app.get("/api/v1/admin/teams", async (request) => {
    const input = parseRequest(listQuerySchema, request.query);
    return success(await service().listTeams(actor(request), toListFilter(input)));
  });

  app.post("/api/v1/admin/teams", async (request, reply) => {
    const input = parseRequest(teamCreateSchema, request.body);
    const item = await service().createTeam(writeActor(request), {
      name: input.name,
      parentTeamId: input.parent_team_id,
    });
    return reply.code(201).send(success({ item }));
  });

  app.patch("/api/v1/admin/teams/:team_id", async (request) => {
    const params = parseRequest(teamParams, request.params);
    const input = parseRequest(teamUpdateSchema, request.body);
    const item = await service().updateTeam(writeActor(request), params.team_id, {
      name: input.name,
      parentTeamId: input.parent_team_id,
    });
    return success({ item });
  });

  app.delete("/api/v1/admin/teams/:team_id", async (request) => {
    const params = parseRequest(teamParams, request.params);
    await service().deleteTeam(writeActor(request), params.team_id);
    return success({ deleted: true, id: params.team_id });
  });

  app.get("/api/v1/admin/teams/:team_id/members", async (request) => {
    const params = parseRequest(teamParams, request.params);
    const items = await service().listTeamMembers(actor(request), params.team_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/admin/teams/:team_id/members", async (request, reply) => {
    const params = parseRequest(teamParams, request.params);
    const input = parseRequest(userMembershipCreateSchema, request.body);
    await service().addTeamMember(writeActor(request), params.team_id, input.user_id);
    return reply.code(201).send(success({ added: true, userId: input.user_id }));
  });

  app.delete("/api/v1/admin/teams/:team_id/members/:user_id", async (request) => {
    const params = parseRequest(teamMemberParams, request.params);
    await service().removeTeamMember(writeActor(request), params.team_id, params.user_id);
    return success({ deleted: true, userId: params.user_id });
  });

  app.get("/api/v1/admin/user-groups", async (request) => {
    const input = parseRequest(listQuerySchema, request.query);
    return success(await service().listUserGroups(actor(request), toListFilter(input)));
  });

  app.post("/api/v1/admin/user-groups", async (request, reply) => {
    const input = parseRequest(userGroupCreateSchema, request.body);
    const item = await service().createUserGroup(writeActor(request), input);
    return reply.code(201).send(success({ item }));
  });

  app.patch("/api/v1/admin/user-groups/:group_id", async (request) => {
    const params = parseRequest(groupParams, request.params);
    const input = parseRequest(userGroupUpdateSchema, request.body);
    const item = await service().updateUserGroup(writeActor(request), params.group_id, input);
    return success({ item });
  });

  app.delete("/api/v1/admin/user-groups/:group_id", async (request) => {
    const params = parseRequest(groupParams, request.params);
    await service().deleteUserGroup(writeActor(request), params.group_id);
    return success({ deleted: true, id: params.group_id });
  });

  app.get("/api/v1/admin/user-groups/:group_id/members", async (request) => {
    const params = parseRequest(groupParams, request.params);
    const items = await service().listUserGroupMembers(actor(request), params.group_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/admin/user-groups/:group_id/members", async (request, reply) => {
    const params = parseRequest(groupParams, request.params);
    const input = parseRequest(userMembershipCreateSchema, request.body);
    await service().addUserGroupMember(writeActor(request), params.group_id, input.user_id);
    return reply.code(201).send(success({ added: true, userId: input.user_id }));
  });

  app.delete("/api/v1/admin/user-groups/:group_id/members/:user_id", async (request) => {
    const params = parseRequest(groupMemberParams, request.params);
    await service().removeUserGroupMember(writeActor(request), params.group_id, params.user_id);
    return success({ deleted: true, userId: params.user_id });
  });

  app.get("/api/v1/projects/:project_id/costs", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(projectCostQuerySchema, request.query);
    return success(await service().getProjectCosts(
      actor(request),
      params.project_id,
      input.group_by as ProjectCostGroupBy,
      toCostFilter(input),
    ));
  });

  app.get("/api/v1/admin/costs", async (request, reply) => {
    const input = parseRequest(adminCostQuerySchema, request.query);
    const data = await service().getAdminCosts(
      actor(request),
      input.group_by as AdminCostGroupBy,
      toCostFilter(input),
    );
    if (input.format === "csv") return sendCostCsv(reply, data);
    return success(data);
  });
}

/** Shared integration seam for the existing production project PATCH route. */
export function parseProjectOperationsPatch(input: unknown): ProjectOperationsPatch {
  const parsed = parseRequest(projectOperationsPatchSchema, input);
  return {
    genre: parsed.genre,
    reviewPolicies: parsed.review_policies && {
      ...(parsed.review_policies.image ? {
        image: {
          defaultStrategy: parsed.review_policies.image.default_strategy,
          reviewerUserId: parsed.review_policies.image.reviewer_user_id,
        },
      } : {}),
      ...(parsed.review_policies.video ? {
        video: {
          defaultStrategy: parsed.review_policies.video.default_strategy,
          reviewerUserId: parsed.review_policies.video.reviewer_user_id,
        },
      } : {}),
    },
  };
}

export function operationsActorFromRequest(request: FastifyRequest, includeSession = false): OperationsActor {
  const user = requireCurrentUser(request);
  return includeSession
    ? { userId: user.id, sessionId: requireCurrentSessionId(request) }
    : { userId: user.id };
}

function actor(request: FastifyRequest): OperationsActor {
  return operationsActorFromRequest(request);
}

function writeActor(request: FastifyRequest): OperationsActor {
  return operationsActorFromRequest(request, true);
}

function toListFilter(input: z.infer<typeof listQuerySchema>) {
  return { page: input.page, pageSize: input.page_size, query: input.q };
}

function toCostFilter(input: z.infer<typeof costDateFilterSchema>): CostFilter {
  return { page: input.page, pageSize: input.page_size, from: input.from, to: input.to };
}

function sendCostCsv(reply: FastifyReply, page: CostAggregatePage) {
  const lines = [
    ["key", "label", "charged_points", "unpriced_count", "entry_count"],
    ...page.rows.map((row) => [row.key, row.label, row.chargedPoints, row.unpricedCount, row.entryCount]),
  ].map((line) => line.map(csvCell).join(","));
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="costs-${page.groupBy}.csv"`)
    .send(`\uFEFF${lines.join("\n")}\n`);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function hasAnyProperty(value: object): boolean {
  return Object.keys(value).length > 0;
}

function uniqueItems(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validDateOrder(value: { from?: Date; to?: Date }): boolean {
  return !value.from || !value.to || value.from.getTime() <= value.to.getTime();
}
