import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { toHttpErrorResponse } from "../../http/errorResponse.js";
import { registerOperationsRoutes, parseProjectOperationsPatch } from "./routes.js";
import {
  PROJECT_PRODUCTION_ROLES,
  type OperationsStore,
  type ProjectMembership,
} from "./types.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "producer.one",
  displayName: "制片人一",
  role: "member",
};
const projectId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const teamId = "44444444-4444-4444-8444-444444444444";

test("capabilities 返回访问角色与多选生产职责，响应保持 snake_case", async () => {
  const app = await testApp({
    getCapabilities: async (_actorId, allowMemberCreateProject) => ({
      platformRole: "member",
      allowMemberCreateProject,
      projectRoles: [{ projectId, role: "editor", productionRoles: ["director", "art"] }],
      permissions: ["project:create"],
    }),
  }, { allowMemberCreateProject: true });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/me/capabilities" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        platform_role: "member",
        allow_member_create_project: true,
        projects: [{
          project_id: projectId,
          role: "editor",
          production_roles: ["director", "art"],
        }],
        permissions: ["project:create"],
      },
    });
  } finally {
    await app.close();
  }
});

test("项目成员与 capabilities 的 OpenAPI 冻结五职责、请求体和真实状态码", async () => {
  const app = Fastify({ logger: false });
  await app.register(swagger, {
    openapi: {
      info: { title: "operations contract test", version: "0.1.0" },
    },
  });
  await registerOperationsRoutes(app, () => ({} as Database), {
    createStore: () => defaultStore() as OperationsStore,
  });
  await app.ready();
  try {
    const document = app.swagger() as OpenApiDocument;
    const create = operation(document, "/api/v1/projects/{project_id}/members", "post");
    const createBody = requestSchema(create);
    assert.deepEqual(
      createBody.properties?.production_roles?.items?.enum,
      [...PROJECT_PRODUCTION_ROLES],
    );
    assert.equal(createBody.properties?.production_roles?.uniqueItems, true);
    assert.ok(create.responses?.["201"], "新增成员必须公开 201 响应");
    assert.equal(create.responses?.["200"], undefined, "新增成员不能被 OpenAPI 误标成 200");
    assert.deepEqual(
      responseSchema(create, "201")
        .properties?.data
        ?.properties?.item
        ?.properties?.production_roles
        ?.items?.enum,
      [...PROJECT_PRODUCTION_ROLES],
    );

    const update = operation(
      document,
      "/api/v1/projects/{project_id}/members/{user_id}",
      "patch",
    );
    assert.equal(requestSchema(update).minProperties, 1);
    assert.deepEqual(
      requestSchema(update).properties?.production_roles?.items?.enum,
      [...PROJECT_PRODUCTION_ROLES],
    );

    const list = operation(document, "/api/v1/projects/{project_id}/members", "get");
    assert.deepEqual(
      responseSchema(list, "200")
        .properties?.data
        ?.properties?.items
        ?.items
        ?.properties?.production_roles
        ?.items?.enum,
      [...PROJECT_PRODUCTION_ROLES],
    );
    operation(document, "/api/v1/projects/{project_id}/members/{user_id}", "delete");

    const capabilities = operation(document, "/api/v1/me/capabilities", "get");
    assert.deepEqual(
      responseSchema(capabilities, "200")
        .properties?.data
        ?.properties?.projects
        ?.items
        ?.properties?.production_roles
        ?.items?.enum,
      [...PROJECT_PRODUCTION_ROLES],
    );
  } finally {
    await app.close();
  }
});

test("项目成员 CRUD 传递会话审计身份，且错误输入不会触达服务", async () => {
  const calls: string[] = [];
  const member: ProjectMembership = {
    projectId,
    userId,
    username: "artist.one",
    displayName: "美术一",
    platformRole: "member" as const,
    projectRole: "editor" as const,
    productionRoles: ["director", "art"],
    addedByUserId: actor.id,
    createdAt: new Date("2026-07-24T00:00:00.000Z"),
  };
  const app = await testApp({
    listProjectMembers: async (actualActor, actualProjectId) => {
      calls.push(`list:${actualActor.userId}:${actualActor.sessionId ?? "none"}:${actualProjectId}`);
      return [member];
    },
    addProjectMember: async (actualActor, actualProjectId, input) => {
      calls.push(
        `add:${actualActor.userId}:${actualActor.sessionId}:${actualProjectId}:${input.userId}:${input.role}:${input.productionRoles?.join(",") ?? "preserve"}`,
      );
      return { ...member, productionRoles: input.productionRoles ?? member.productionRoles };
    },
    updateProjectMember: async (actualActor, actualProjectId, actualUserId, input) => {
      calls.push(
        `update:${actualActor.userId}:${actualActor.sessionId}:${actualProjectId}:${actualUserId}:${input.role ?? "preserve"}:${input.productionRoles?.join(",") ?? "preserve"}`,
      );
      return {
        ...member,
        projectRole: input.role ?? member.projectRole,
        productionRoles: input.productionRoles ?? member.productionRoles,
      };
    },
    removeProjectMember: async (actualActor, actualProjectId, actualUserId) => {
      calls.push(`remove:${actualActor.userId}:${actualActor.sessionId}:${actualProjectId}:${actualUserId}`);
    },
  });
  try {
    const list = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/members` });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().data.items[0].project_role, "editor");
    assert.deepEqual(list.json().data.items[0].production_roles, ["director", "art"]);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/members`,
      payload: {
        user_id: userId,
        role: "editor",
        production_roles: ["director", "art"],
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.item.user_id, userId);
    assert.deepEqual(created.json().data.item.production_roles, ["director", "art"]);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/members/${userId}`,
      payload: {
        role: "viewer",
        production_roles: ["screenwriter", "coordinator", "reviewer"],
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.item.project_role, "viewer");
    assert.deepEqual(updated.json().data.item.production_roles, [
      "screenwriter",
      "coordinator",
      "reviewer",
    ]);

    const deleted = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}/members/${userId}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().data.deleted, true);

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/members`,
      payload: { user_id: userId, role: "unknown" },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);

    const duplicatedRole = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/members/${userId}`,
      payload: { production_roles: ["director", "director"] },
    });
    assert.equal(duplicatedRole.statusCode, 400, duplicatedRole.body);

    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/members/${userId}`,
      payload: {},
    });
    assert.equal(emptyPatch.statusCode, 400, emptyPatch.body);

    assert.deepEqual(calls, [
      `list:${actor.id}:none:${projectId}`,
      `add:${actor.id}:session-id:${projectId}:${userId}:editor:director,art`,
      `update:${actor.id}:session-id:${projectId}:${userId}:viewer:screenwriter,coordinator,reviewer`,
      `remove:${actor.id}:session-id:${projectId}:${userId}`,
    ]);
  } finally {
    await app.close();
  }
});

test("成本路由只交给 cost_entries 服务面，并将 CSV 导出限制在验证过的分页范围", async () => {
  const calls: string[] = [];
  const app = await testApp({
    getProjectCosts: async (_actor, actualProjectId, groupBy, filter) => {
      calls.push(`project:${actualProjectId}:${groupBy}:${filter.page}:${filter.pageSize}`);
      return page(groupBy, "制片人一");
    },
    getAdminCosts: async (_actor, groupBy, filter) => {
      calls.push(`admin:${groupBy}:${filter.page}:${filter.pageSize}`);
      return page(groupBy, "项目 A, 需要转义");
    },
  });
  try {
    const project = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/costs?group_by=member&page=2&page_size=20`,
    });
    assert.equal(project.statusCode, 200, project.body);
    assert.equal(project.json().data.rows[0].charged_points, 80);

    const csv = await app.inject({
      method: "GET",
      url: "/api/v1/admin/costs?group_by=project&format=csv&page_size=20",
    });
    assert.equal(csv.statusCode, 200, csv.body);
    assert.match(csv.headers["content-type"] ?? "", /text\/csv/);
    assert.match(csv.body, /"项目 A, 需要转义"/);

    const invalidPage = await app.inject({
      method: "GET",
      url: "/api/v1/admin/costs?group_by=project&page_size=101",
    });
    assert.equal(invalidPage.statusCode, 400, invalidPage.body);
    assert.deepEqual(calls, [
      `project:${projectId}:member:2:20`,
      "admin:project:1:20",
    ]);
  } finally {
    await app.close();
  }
});

test("项目运营 PATCH 合同只解析 genre 与按媒体类型划分的审核策略，不注册重复路由", () => {
  assert.deepEqual(parseProjectOperationsPatch({
    genre: "甜宠",
    review_policies: {
      image: { default_strategy: "pending_review", reviewer_user_id: userId },
      video: { reviewer_user_id: null },
    },
  }), {
    genre: "甜宠",
    reviewPolicies: {
      image: { defaultStrategy: "pending_review", reviewerUserId: userId },
      video: { defaultStrategy: undefined, reviewerUserId: null },
    },
  });
  // S24 解冻：genre 为自由文本，自定义体裁（不在旧六值枚举内）也可通过。
  assert.deepEqual(parseProjectOperationsPatch({ genre: "悬疑" }), {
    genre: "悬疑",
    reviewPolicies: undefined,
  });
  assert.throws(
    () => parseProjectOperationsPatch({ review_policies: { image: {} } }),
    /请检查标出的填写内容/,
  );
  assert.throws(
    () => parseProjectOperationsPatch({ genre: "" }),
    /请检查标出的填写内容/,
  );
});

test("团队 PATCH 支持父团队字段，并将写会话身份交给既有一层父子校验", async () => {
  const calls: Array<{ actorId: string; sessionId: string | undefined; parentTeamId: string | null | undefined }> = [];
  const parentTeamId = "66666666-6666-4666-8666-666666666666";
  const app = await testApp({
    updateTeam: async (actualActor, actualTeamId, input) => {
      assert.equal(actualTeamId, teamId);
      calls.push({
        actorId: actualActor.userId,
        sessionId: actualActor.sessionId,
        parentTeamId: input.parentTeamId,
      });
      return {
        id: teamId,
        name: "后期组",
        parentTeamId: input.parentTeamId ?? null,
        memberCount: 0,
        createdAt: new Date("2026-07-24T00:00:00.000Z"),
        updatedAt: new Date("2026-07-24T00:00:00.000Z"),
      };
    },
  });
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/teams/${teamId}`,
      payload: { parent_team_id: parentTeamId },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.item.parent_team_id, parentTeamId);
    assert.deepEqual(calls, [{ actorId: actor.id, sessionId: "session-id", parentTeamId }]);
  } finally {
    await app.close();
  }
});

function page(groupBy: string, label: string) {
  return {
    groupBy: groupBy as "member",
    rows: [{ key: "row-id", label, chargedPoints: 80, unpricedCount: 1, entryCount: 2 }],
    totals: { chargedPoints: 80, unpricedCount: 1, entryCount: 2 },
    total: 1,
    page: 1,
    pageSize: 20,
  };
}

async function testApp(overrides: Partial<OperationsStore>, options: { allowMemberCreateProject?: boolean } = {}) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const normalized = toHttpErrorResponse(error);
    return reply.code(normalized.statusCode).send({ ok: false, error: normalized.body });
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
    request.authSessionId = "session-id";
  });
  await registerOperationsRoutes(app, () => ({} as Database), {
    createStore: () => ({ ...defaultStore(), ...overrides }) as OperationsStore,
    allowMemberCreateProject: options.allowMemberCreateProject,
  });
  return app;
}

function defaultStore(): Partial<OperationsStore> {
  const emptyPage = { items: [], total: 0, page: 1, pageSize: 20 };
  return {
    getCapabilities: async () => ({
      platformRole: "member",
      allowMemberCreateProject: false,
      projectRoles: [],
      permissions: [],
    }),
    listProjectMembers: async () => [],
    addProjectMember: async () => { throw new Error("not implemented"); },
    updateProjectMember: async () => { throw new Error("not implemented"); },
    removeProjectMember: async () => undefined,
    listTeams: async () => emptyPage,
    createTeam: async () => { throw new Error("not implemented"); },
    updateTeam: async () => { throw new Error("not implemented"); },
    deleteTeam: async () => undefined,
    listTeamMembers: async () => [],
    addTeamMember: async () => undefined,
    removeTeamMember: async () => undefined,
    listUserGroups: async () => emptyPage,
    createUserGroup: async () => { throw new Error("not implemented"); },
    updateUserGroup: async () => { throw new Error("not implemented"); },
    deleteUserGroup: async () => undefined,
    listUserGroupMembers: async () => [],
    addUserGroupMember: async () => undefined,
    removeUserGroupMember: async () => undefined,
    getProjectCosts: async () => page("member", "") as never,
    getAdminCosts: async () => page("project", "") as never,
    patchProjectOperations: async () => { throw new Error("not implemented"); },
  };
}

interface OpenApiSchema {
  enum?: unknown[];
  items?: OpenApiSchema;
  minProperties?: number;
  properties?: Record<string, OpenApiSchema>;
  uniqueItems?: boolean;
}

interface OpenApiOperation {
  requestBody?: {
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  responses?: Record<string, {
    content?: Record<string, { schema?: OpenApiSchema }>;
  }>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

function operation(
  document: OpenApiDocument,
  path: string,
  method: string,
): OpenApiOperation {
  const result = document.paths[path]?.[method];
  assert.ok(result, `OpenAPI 缺少 ${method.toUpperCase()} ${path}`);
  return result;
}

function requestSchema(operationRecord: OpenApiOperation): OpenApiSchema {
  const schema = operationRecord.requestBody?.content?.["application/json"]?.schema;
  assert.ok(schema, "OpenAPI 缺少 application/json 请求体 schema");
  return schema;
}

function responseSchema(
  operationRecord: OpenApiOperation,
  statusCode: string,
): OpenApiSchema {
  const schema = operationRecord.responses?.[statusCode]
    ?.content?.["application/json"]
    ?.schema;
  assert.ok(schema, `OpenAPI 缺少 ${statusCode} application/json 响应 schema`);
  return schema;
}
