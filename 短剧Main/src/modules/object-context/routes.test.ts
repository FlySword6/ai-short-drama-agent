import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { AppError, NotFoundError, errorBody } from "../../shared/errors.js";
import { registerObjectContextRoutes } from "./routes.js";
import type { ObjectContextQuery, ProductionGraphQuery } from "./types.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "director.one",
  displayName: "导演一",
  role: "operator",
};
const projectId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const contextId = "44444444-4444-4444-8444-444444444444";

test("对象上下文路由传递完整 actor、解析默认值并统一为 snake_case envelope", async () => {
  const calls: unknown[] = [];
  const app = await buildApp({
    context: async (...args: unknown[]) => {
      calls.push({ type: "context", args });
      return objectContextResult();
    },
    productionGraph: async (...args: unknown[]) => {
      calls.push({ type: "graph", args });
      return graphResult();
    },
  });
  try {
    const context = await app.inject({
      method: "GET",
      url: `/api/v1/objects/asset_entity/${objectId}/context?include=origin,usage&project_context_id=${contextId}`,
    });
    assert.equal(context.statusCode, 200, context.body);
    assert.deepEqual(context.json().data.subject, {
      kind: "asset_entity",
      id: objectId,
      display_name: "雨夜男主",
    });
    assert.equal(context.json().data.next_actions[0].requires_human_confirmation, false);
    assert.equal(context.json().data.usage.next_cursor, null);
    assert.deepEqual(calls[0], {
      type: "context",
      args: [actor, "asset_entity", objectId, {
        include: new Set(["origin", "usage"]),
        projectContextId: contextId,
        originDepth: 2,
        usageCursor: undefined,
        usagePageSize: 50,
      } satisfies ObjectContextQuery],
    });

    const graph = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/production-graph` });
    assert.equal(graph.statusCode, 200, graph.body);
    assert.equal(graph.json().data.graph_id, `${projectId}:project:${projectId}`);
    assert.equal(graph.json().data.view.interaction.move, "locked");
    assert.deepEqual(calls[1], {
      type: "graph",
      args: [actor, projectId, {
        scopeKind: "project",
        scopeId: undefined,
        preset: "pipeline",
      } satisfies ProductionGraphQuery],
    });
  } finally {
    await app.close();
  }
});

test("对象上下文和生产图严格校验查询合同，错误不触达服务", async () => {
  let calls = 0;
  const app = await buildApp({
    context: async () => { calls += 1; return objectContextResult(); },
    productionGraph: async () => { calls += 1; return graphResult(); },
  });
  try {
    const noInclude = await app.inject({
      method: "GET",
      url: `/api/v1/objects/asset_entity/${objectId}/context?include=origin,unknown`,
    });
    assert.equal(noInclude.statusCode, 400, noInclude.body);

    const badPage = await app.inject({
      method: "GET",
      url: `/api/v1/objects/asset_entity/${objectId}/context?usage_page_size=101`,
    });
    assert.equal(badPage.statusCode, 400, badPage.body);

    const noScope = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/production-graph?scope_kind=scene`,
    });
    assert.equal(noScope.statusCode, 400, noScope.body);

    const unknownGraphQuery = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/production-graph?unexpected=true`,
    });
    assert.equal(unknownGraphQuery.statusCode, 400, unknownGraphQuery.body);
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("项目图 scope_id 同项目时原样传服务，不同项目由服务统一隐藏为 404", async () => {
  const calls: unknown[] = [];
  const app = await buildApp({
    context: async () => objectContextResult(),
    productionGraph: async (...args: unknown[]) => {
      calls.push(args);
      const [, actualProjectId, query] = args as [unknown, string, ProductionGraphQuery];
      if (query.scopeId && query.scopeId !== actualProjectId) {
        throw new NotFoundError("对象不存在或你没有访问权限");
      }
      return graphResult();
    },
  });
  try {
    const sameProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/production-graph?scope_kind=project&scope_id=${projectId}`,
    });
    assert.equal(sameProject.statusCode, 200, sameProject.body);
    assert.deepEqual(calls[0], [actor, projectId, {
      scopeKind: "project",
      scopeId: projectId,
      preset: "pipeline",
    } satisfies ProductionGraphQuery]);

    const differentProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/production-graph?scope_kind=project&scope_id=${contextId}`,
    });
    assert.equal(differentProject.statusCode, 404, differentProject.body);
    assert.equal(differentProject.body.includes(projectId), false);
    assert.equal(differentProject.body.includes(contextId), false);
    assert.deepEqual(calls[1], [actor, projectId, {
      scopeKind: "project",
      scopeId: contextId,
      preset: "pipeline",
    } satisfies ProductionGraphQuery]);
  } finally {
    await app.close();
  }
});

test("跨项目的对象上下文与生产图统一 404，响应不泄露项目标识或计数", async () => {
  const hidden = new NotFoundError("对象不存在或你没有访问权限");
  const app = await buildApp({
    context: async () => { throw hidden; },
    productionGraph: async () => { throw hidden; },
  });
  try {
    const context = await app.inject({
      method: "GET",
      url: `/api/v1/objects/shot/${objectId}/context?project_context_id=${contextId}`,
    });
    assert.equal(context.statusCode, 404, context.body);
    assert.deepEqual(context.json(), {
      ok: false,
      error: {
        code: "not_found",
        message: "对象不存在或你没有访问权限",
        retryable: false,
        details: null,
      },
    });
    assert.equal(context.body.includes(projectId), false);
    assert.equal(context.body.includes("count"), false);

    const graph = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/production-graph` });
    assert.equal(graph.statusCode, 404, graph.body);
    assert.deepEqual(graph.json(), context.json());
  } finally {
    await app.close();
  }
});

test("未登录请求在路由层 fail closed", async () => {
  const app = await buildApp({
    context: async () => objectContextResult(),
    productionGraph: async () => graphResult(),
  }, null);
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/objects/project/${projectId}/context` });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.json().error.code, "unauthorized");
  } finally {
    await app.close();
  }
});

test("集与场生产状态路由复用 snake_case 信封、传递 actor，并隐藏无权限资源", async () => {
  const calls: unknown[] = [];
  const app = await buildApp({
    context: async () => objectContextResult(),
    productionGraph: async () => graphResult(),
    episodeProductionStatus: async (...args: unknown[]) => {
      calls.push(args);
      return episodeStatusResult();
    },
    sceneProductionStatus: async (...args: unknown[]) => {
      calls.push(args);
      if (args[1] === contextId) throw new NotFoundError("对象不存在或你没有访问权限");
      return sceneStatusResult();
    },
  });
  try {
    const episode = await app.inject({ method: "GET", url: `/api/v1/episodes/${projectId}/production-status` });
    assert.equal(episode.statusCode, 200, episode.body);
    assert.equal(episode.json().data.has_in_flight, true);
    assert.equal(episode.json().data.status_counts.generating, 1);

    const scene = await app.inject({ method: "GET", url: `/api/v1/scenes/${objectId}/production-status` });
    assert.equal(scene.statusCode, 200, scene.body);
    assert.equal(scene.json().data.scene.attempt_summary.queue_position, 2);
    assert.equal(scene.json().data.scene.control_package_summary.enabled_lane_count, 7);
    assert.deepEqual(calls, [[actor, projectId], [actor, objectId]]);

    const hidden = await app.inject({ method: "GET", url: `/api/v1/scenes/${contextId}/production-status` });
    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.equal(hidden.body.includes(contextId), false);
  } finally {
    await app.close();
  }
});

type ServiceStub = {
  context: (...args: unknown[]) => Promise<unknown>;
  productionGraph: (...args: unknown[]) => Promise<unknown>;
  episodeProductionStatus?: (...args: unknown[]) => Promise<unknown>;
  sceneProductionStatus?: (...args: unknown[]) => Promise<unknown>;
};

async function buildApp(service: ServiceStub, user: AuthenticatedUser | null = actor) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (user) request.authUser = user;
  });
  app.setErrorHandler((error, _request, reply) => {
    const body = errorBody(error);
    return reply.code(error instanceof AppError ? error.statusCode : 500).send({ ok: false, error: body });
  });
  await registerObjectContextRoutes(app, () => ({} as Database), {
    createService: () => ({
      ...service,
      episodeProductionStatus: service.episodeProductionStatus ?? (async () => episodeStatusResult()),
      sceneProductionStatus: service.sceneProductionStatus ?? (async () => sceneStatusResult()),
    }) as never,
  });
  return app;
}

function objectContextResult() {
  return {
    schemaVersion: 1 as const,
    subject: { kind: "asset_entity" as const, id: objectId, displayName: "雨夜男主" },
    revision: "revision-1",
    state: { blockers: [] },
    origin: { edges: [], truncated: false },
    usage: { edges: [], nextCursor: null },
    nextActions: [{
      key: "open_asset",
      label: "查看资产",
      enabled: true,
      disabledReason: null,
      reasonCodes: ["asset_visible"],
      effect: "navigation" as const,
      requiresHumanConfirmation: false,
      inputSchemaKey: null,
      invocation: { kind: "route" as const, href: `/assets/${objectId}` },
    }],
    coverage: { complete: false, omittedRelationKinds: ["reference_tests"] },
  };
}

function graphResult() {
  return {
    schemaVersion: 1 as const,
    graphId: `${projectId}:project:${projectId}`,
    revision: "revision-graph-1",
    scope: { kind: "project" as const, id: projectId, displayName: "测试项目" },
    nodes: [],
    edges: [],
    view: {
      preset: "pipeline" as const,
      interaction: { move: "locked" as const, connect: "locked" as const, create: "locked" as const, remove: "locked" as const },
    },
    actions: [],
  };
}

function sceneStatusResult() {
  return {
    schemaVersion: 1 as const,
    revision: "scene-status-revision",
    scene: {
      sceneId: objectId,
      episodeId: projectId,
      sceneNo: 1,
      name: "雨夜巷口",
      sortOrder: 1,
      productionStatus: "generating",
      statusLabel: "生成中",
      shotSummary: { total: 1, controlPackageStarted: 1, ready: 1, inFlight: 1, withPrimaryVideo: 0, delivered: 0 },
      controlPackageSummary: { filledLaneCount: 2, enabledLaneCount: 7 },
      attemptSummary: { pending: 1, running: 0, queuePosition: 2 },
      outputSummary: { samplePrimaryCount: 0, fullPrimaryCount: 0 },
      coverMedia: null,
      updatedAt: "2026-08-02T00:00:00.000Z",
    },
  };
}

function episodeStatusResult() {
  const scene = sceneStatusResult().scene;
  return {
    schemaVersion: 1 as const,
    revision: "episode-status-revision",
    episodeId: projectId,
    projectId: contextId,
    productionStatus: "generating",
    statusLabel: "生成中",
    sceneCount: 1,
    deliveredSceneCount: 0,
    hasInFlight: true,
    nextSceneId: objectId,
    statusCounts: {
      notBrokenDown: 0,
      brokenDown: 0,
      preparing: 0,
      ready: 0,
      generating: 1,
      hasMedia: 0,
      delivered: 0,
    },
    scenes: [scene],
  };
}
