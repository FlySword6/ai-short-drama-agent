import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Fastify, { type FastifyRequest } from "fastify";
import { AppError, errorBody } from "../shared/errors.js";
import { enforceAgentAccess, type AgentAccess } from "./agentAccess.js";

test("Agent 的写请求默认拒绝，header 与 body 自报都不能提升权限", () => {
  for (const access of [undefined, "human_only"] as const) {
    const request = fakeRequest("POST", access);
    request.headers["x-shortdrama-client"] = "web";
    request.body = { source: "web", agent_access: "quote" };
    assert.throws(
      () => enforceAgentAccess(request),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 403);
        assert.equal(
          error.code,
          access === "human_only" ? "human_confirmation_required" : "agent_action_not_allowed",
        );
        return true;
      },
    );
  }
});

test("Agent 只可读取或调用服务器显式批准的候选、备料和报价写路由", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.doesNotThrow(() => enforceAgentAccess(fakeRequest(method)));
  }
  for (const access of ["candidate", "prep", "quote"] as const) {
    assert.doesNotThrow(() => enforceAgentAccess(fakeRequest("POST", access)));
  }
  assert.doesNotThrow(() => enforceAgentAccess(fakeRequest("POST", undefined, "web")));
  assert.doesNotThrow(() => enforceAgentAccess(fakeRequest("POST", undefined, "cli")));
});

test("冻结的人类专属路由均保留 human_only 服务器标注", async () => {
  const routes: ReadonlyArray<{ file: string; route: string; method?: "post" | "delete" }> = [
    { file: "src/modules/script-breakdown/routes.ts", route: "/api/v1/script-breakdowns/:run_id/confirm" },
    { file: "src/modules/storyboard/routes.ts", route: "/api/v1/storyboard-imports/:import_id/confirm" },
    { file: "src/modules/generation/routes.ts", route: "/api/v1/generation-quotes/:quote_id/confirm" },
    { file: "src/modules/generation/routes.ts", route: "/api/v1/generations" },
    { file: "src/modules/generation/routes.ts", route: "/api/v1/generations/batch-confirm" },
    { file: "src/modules/generation/routes.ts", route: "/api/v1/generation-batches/:authorization_id/submit" },
    { file: "src/modules/generation/routes.ts", route: "/api/v1/generations/:request_id/retry" },
    { file: "src/modules/assistant/routes.ts", route: "/api/v1/agent/sessions/:session_id/generation-quotes/:quote_id/submit" },
    { file: "src/modules/assistant/routes.ts", route: "/api/v1/agent/sessions" },
    { file: "src/modules/assistant/routes.ts", route: "/api/v1/agent/sessions/:session_id/messages" },
    { file: "src/modules/reviews/routes.ts", route: "/api/v1/projects/:project_id/reviews/assets/:asset_id/decision" },
    { file: "src/modules/reviews/routes.ts", route: "/api/v1/projects/:project_id/media-reviews/decisions" },
    { file: "src/modules/assets/routes.ts", route: "/api/v1/assets/:asset_id/media/:media_id/set-primary" },
    { file: "src/modules/shot-media/routes.ts", route: "/api/v1/shots/:shot_id/media/:media_id/set-primary" },
    { file: "src/modules/shot-media/routes.ts", route: "/api/v1/shots/:shot_id/media/from-asset" },
    { file: "src/modules/delivery/routes.ts", route: "/api/v1/episodes/:episode_id/deliveries" },
    { file: "src/modules/audio/routes.ts", route: "/api/v1/audio/versions/:media_result_id/lock" },
    { file: "src/modules/auth/routes.ts", route: "/api/v1/auth/agent-credentials" },
    {
      file: "src/modules/auth/routes.ts",
      route: "/api/v1/auth/agent-credentials/:credential_id",
      method: "delete",
    },
  ];
  const cache = new Map<string, string>();
  for (const item of routes) {
    const source = cache.get(item.file)
      ?? await readFile(path.resolve(item.file), "utf8");
    cache.set(item.file, source);
    assert.match(
      source,
      new RegExp(
        `app\\.${item.method ?? "post"}\\([\\s\\S]{0,80}${escapeRegExp(JSON.stringify(item.route))}`
        + `[\\s\\S]{0,180}agentAccess:\\s*"human_only"`,
      ),
      `人类专属路由缺少 human_only 标注: ${item.route}`,
    );
  }
});

test("P1 Agent 只开放指定的候选与备料写路由", async () => {
  const allowed: ReadonlyArray<{ file: string; route: string; access: "candidate" | "prep"; method?: "post" | "put" }> = [
    { file: "src/modules/script-breakdown/routes.ts", route: "/api/v1/episodes/:episode_id/script-versions", access: "candidate" },
    { file: "src/modules/script-breakdown/routes.ts", route: "/api/v1/episodes/:episode_id/script-breakdowns", access: "candidate" },
    { file: "src/modules/script-breakdown/routes.ts", route: "/api/v1/script-breakdowns/:run_id/resume", access: "candidate" },
    { file: "src/modules/asset-uploads/routes.ts", route: "/api/v1/asset-upload-tasks", access: "candidate" },
    { file: "src/modules/project-assets/routes.ts", route: "/api/v1/projects/:project_id/assets", access: "prep" },
    { file: "src/modules/vnext/routes.ts", route: "/api/vnext/projects/:project_id/graph", access: "candidate", method: "put" },
  ];
  const notAllowed: ReadonlyArray<{ file: string; route: string; method: "post" | "delete" }> = [
    { file: "src/modules/script-breakdown/routes.ts", route: "/api/v1/script-breakdowns/:run_id/discard", method: "post" },
    { file: "src/modules/project-assets/routes.ts", route: "/api/v1/projects/:project_id/assets/:ref_id", method: "delete" },
  ];
  const cache = new Map<string, string>();
  const sourceFor = async (file: string) => {
    const source = cache.get(file) ?? await readFile(path.resolve(file), "utf8");
    cache.set(file, source);
    return source;
  };
  for (const item of allowed) {
    assert.match(
      await sourceFor(item.file),
      routeAgentAccessPattern(item.method ?? "post", item.route, item.access),
      `Agent 允许路由缺少 ${item.access} 标注: ${item.route}`,
    );
  }
  const expectedAccessByFile = new Map<string, AgentAccess[]>();
  for (const item of allowed) {
    const expected = expectedAccessByFile.get(item.file) ?? [];
    expected.push(item.access);
    expectedAccessByFile.set(item.file, expected);
  }
  for (const [file, expected] of expectedAccessByFile) {
    const actual = [...(await sourceFor(file)).matchAll(/agentAccess:\s*"(candidate|prep|quote)"/g)]
      .map((match) => match[1]);
    assert.deepEqual(
      actual,
      expected,
      `非 human_only 的 Agent 标注必须精确匹配 P1 allowlist: ${file}`,
    );
  }
  for (const item of notAllowed) {
    assert.doesNotMatch(
      await sourceFor(item.file),
      routeAnyAgentAccessPattern(item.method, item.route),
      `默认拒绝路由不得添加 Agent 开放标注: ${item.route}`,
    );
  }
});

test("人类专属路由在 handler 前统一返回 403，业务方法零调用", async () => {
  const app = Fastify({ logger: false });
  let handlerCalls = 0;
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  app.addHook("preHandler", async (request) => {
    request.authContext = fakeRequest("POST").authContext;
    enforceAgentAccess(request);
  });
  const contractRoutes = [
    "/contract/script-confirm",
    "/contract/storyboard-confirm",
    "/contract/quote-confirm",
    "/contract/generation-submit",
    "/contract/batch-confirm",
    "/contract/batch-submit",
    "/contract/retry",
    "/contract/assistant-submit",
    "/contract/asset-review",
    "/contract/media-review",
    "/contract/asset-primary",
    "/contract/shot-primary",
    "/contract/from-asset",
    "/contract/delivery",
  ];
  for (const [index, route] of contractRoutes.entries()) {
    app.post(route, { config: { agentAccess: "human_only" } }, async () => {
      handlerCalls += index + 1;
      return { ok: true };
    });
  }
  try {
    for (const route of contractRoutes) {
      const response = await app.inject({ method: "POST", url: route });
      assert.equal(response.statusCode, 403, `${route}: ${response.body}`);
      assert.equal(response.json().error.code, "human_confirmation_required");
    }
    assert.equal(handlerCalls, 0);
  } finally {
    await app.close();
  }
});

function fakeRequest(
  method: string,
  agentAccess?: AgentAccess,
  source: "web" | "cli" | "agent" = "agent",
): FastifyRequest {
  return {
    method,
    headers: {},
    body: undefined,
    routeOptions: { config: agentAccess ? { agentAccess } : {} },
    authContext: {
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        username: "test",
        displayName: "测试用户",
        role: "member",
      },
      credential: {
        sessionId: "22222222-2222-4222-8222-222222222222",
        source,
        actorKind: source === "agent" ? "agent" : "human",
        agentType: source === "agent" ? "shortdrama-agent" : null,
        userAgent: null,
        expiresAt: new Date("2027-08-03T00:00:00.000Z"),
      },
    },
  } as unknown as FastifyRequest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routeAgentAccessPattern(
  method: "post" | "put" | "delete",
  route: string,
  access: AgentAccess,
): RegExp {
  return new RegExp(
    `app\\.${method}\\([\\s\\S]{0,80}${escapeRegExp(JSON.stringify(route))}`
    + `[\\s\\S]{0,180}agentAccess:\\s*${escapeRegExp(JSON.stringify(access))}`,
  );
}

function routeAnyAgentAccessPattern(method: "post" | "delete", route: string): RegExp {
  return new RegExp(
    `app\\.${method}\\([\\s\\S]{0,80}${escapeRegExp(JSON.stringify(route))}`
    + `[\\s\\S]{0,180}agentAccess:\\s*`,
  );
}
