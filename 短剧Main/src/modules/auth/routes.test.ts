import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../../db/client.js";
import type { UiMode } from "../../db/schema.js";
import { AppError, errorBody } from "../../shared/errors.js";
import type { AuthRepository } from "./repository.js";
import { registerAuthRoutes, type AuthServicePort } from "./routes.js";
import { AuthService, hashPassword, type RegistrationResult } from "./service.js";

const memberId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";

test("me 响应携带 ui_mode，本人 PATCH 切换后再次读取即为新值", async () => {
  let currentMode: UiMode = "full";
  const calls: string[] = [];
  const app = await createTestApp(calls, {
    findUiModeByUserId: async () => currentMode,
    updateUiMode: async (_userId, uiMode) => {
      currentMode = uiMode;
      return uiMode;
    },
  });
  try {
    const before = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: "Bearer member" } });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().data.id, memberId);
    assert.equal(before.json().data.username, "member");
    assert.equal(before.json().data.role, "member");
    assert.equal(before.json().data.ui_mode, "full");

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/me/ui-mode",
      headers: { authorization: "Bearer member" },
      payload: { ui_mode: "lite" },
    });
    assert.equal(patched.statusCode, 200);
    assert.deepEqual(patched.json().data, { ui_mode: "lite" });
    assert.ok(calls.includes(`update:${memberId}:lite`));

    const after = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: "Bearer member" } });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().data.ui_mode, "lite");
  } finally { await app.close(); }
});

test("ui_mode 只接受 lite/full，非法值与多余字段都 400 且不触库", async () => {
  const calls: string[] = [];
  const app = await createTestApp(calls, {});
  try {
    const badValue = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/me/ui-mode",
      headers: { authorization: "Bearer member" },
      payload: { ui_mode: "dark" },
    });
    assert.equal(badValue.statusCode, 400);
    assert.equal(badValue.json().error.code, "invalid_request");

    const extraField = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/me/ui-mode",
      headers: { authorization: "Bearer member" },
      payload: { ui_mode: "lite", role: "admin" },
    });
    assert.equal(extraField.statusCode, 400);
    assert.equal(extraField.json().error.code, "invalid_request");

    assert.deepEqual(calls, []);
  } finally { await app.close(); }
});

test("未登录访问 me 与 ui-mode 端点都返回 401", async () => {
  const calls: string[] = [];
  const app = await createTestApp(calls, {});
  try {
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    assert.equal(me.statusCode, 401);
    assert.equal(me.json().error.code, "unauthorized");

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/me/ui-mode",
      payload: { ui_mode: "lite" },
    });
    assert.equal(patch.statusCode, 401);
    assert.equal(patch.json().error.code, "unauthorized");

    assert.deepEqual(calls, []);
  } finally { await app.close(); }
});

test("login 响应的 user 携带 ui_mode（Lite 用户登录后前端据此跳转 /lite）", async () => {
  const passwordHash = await hashPassword("correct-horse-battery");
  const app = await createTestApp([], {
    findUserByUsername: async () => ({
      id: memberId,
      username: "member",
      displayName: "成员",
      role: "member",
      uiMode: "lite",
      active: true,
      passwordHash,
    }),
    createHumanSession: async () => sessionId,
  });
  try {
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "member", password: "correct-horse-battery" },
    });
    assert.equal(loggedIn.statusCode, 200);
    assert.equal(loggedIn.json().data.user.ui_mode, "lite");
  } finally { await app.close(); }
});

interface FakeRepository {
  findUiModeByUserId?: (userId: string) => Promise<UiMode | undefined>;
  updateUiMode?: (userId: string, uiMode: UiMode) => Promise<UiMode | undefined>;
  findUserByUsername?: (username: string) => Promise<unknown>;
  createHumanSession?: (input: unknown) => Promise<string | null>;
}

async function createTestApp(calls: string[], repository: FakeRepository): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? Number((error as { statusCode: number }).statusCode) : 500;
    const body = errorBody(error);
    return reply.code(statusCode).send({ ok: false, error: error instanceof AppError || body.code !== "internal_error" ? body : { code: "invalid_request", message: error instanceof Error ? error.message : "请求内容不正确", retryable: false, details: null } });
  });
  app.addHook("preHandler", async (request) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token === "member") {
      request.authUser = { id: memberId, username: "member", displayName: "成员", role: "member" };
      request.authSessionId = sessionId;
    }
  });
  const fakeRepository: FakeRepository = {
    findUiModeByUserId: async (userId) => {
      calls.push(`read:${userId}`);
      return repository.findUiModeByUserId?.(userId);
    },
    updateUiMode: async (userId, uiMode) => {
      calls.push(`update:${userId}:${uiMode}`);
      return repository.updateUiMode?.(userId, uiMode);
    },
    findUserByUsername: async (username) => repository.findUserByUsername?.(username),
    createHumanSession: async (input) => repository.createHumanSession?.(input) ?? null,
  };
  await registerAuthRoutes(app, () => ({} as Database), {
    createService: () => new AuthService({} as Database, fakeRepository as unknown as AuthRepository),
  });
  return app;
}

const registration: RegistrationResult = {
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    username: "u-0123456789abcdef0123",
    display_name: "新用户",
    role: "member",
    ui_mode: "full",
  },
  accountCredit: {
    userId: "11111111-1111-4111-8111-111111111111",
    balancePoints: 50_000,
    dailyLimitPoints: 50_000,
    usedTodayPoints: 0,
    remainingTodayPoints: 50_000,
    dayDate: "2026-08-02",
    pointToFen: 1,
  },
  registrationGrant: {
    source: "invitation",
    grantedPoints: 50_000,
  },
};

test("注册响应加性返回用户、账户积分快照和本次赠送，字段统一 snake_case", async () => {
  const calls: unknown[] = [];
  const app = await createApp({
    ...serviceStub(),
    register: async (input) => {
      calls.push(input);
      return registration;
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "new-user@example.test",
        password: "test-password",
        verification_code: "123456",
        display_name: "新用户",
        invitation_code: "COLTECH",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        user: registration.user,
        account_credit: {
          user_id: registration.accountCredit.userId,
          balance_points: 50_000,
          daily_limit_points: 50_000,
          used_today_points: 0,
          remaining_today_points: 50_000,
          day_date: "2026-08-02",
          point_to_fen: 1,
        },
        registration_grant: {
          source: "invitation",
          granted_points: 50_000,
        },
      },
    });
    assert.deepEqual(calls, [{
      email: "new-user@example.test",
      password: "test-password",
      verificationCode: "123456",
      displayName: "新用户",
      invitationCode: "COLTECH",
    }]);
  } finally {
    await app.close();
  }
});

test("注册请求仍严格拒绝客户端写角色或额度", async () => {
  let registerCalls = 0;
  const app = await createApp({
    ...serviceStub(),
    register: async () => {
      registerCalls += 1;
      return registration;
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "new-user@example.test",
        password: "test-password",
        verification_code: "123456",
        role: "admin",
        daily_limit_points: 2_147_483_647,
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(registerCalls, 0);
  } finally {
    await app.close();
  }
});

test("Web 与 CLI 登录由不同路由签发，客户端自报来源不改变服务方法", async () => {
  const calls: Array<{ lane: string; input: unknown; userAgent?: string }> = [];
  const app = await createApp({
    ...serviceStub(),
    login: async (input, userAgent) => {
      calls.push({ lane: "web", input, userAgent });
      return loginResult();
    },
    loginCli: async (input, userAgent) => {
      calls.push({ lane: "cli", input, userAgent });
      return loginResult();
    },
  });
  try {
    const web = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: {
        "user-agent": "browser-test",
        "x-shortdrama-client": "cli",
      },
      payload: { username: "artist", password: "test-password" },
    });
    const cli = await app.inject({
      method: "POST",
      url: "/api/v1/auth/cli/login",
      headers: {
        "user-agent": "shortdrama-cli/0.3.0",
        "x-shortdrama-client": "web",
      },
      payload: { username: "artist", password: "test-password" },
    });
    assert.equal(web.statusCode, 200, web.body);
    assert.equal(cli.statusCode, 200, cli.body);
    const bodySpoof = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "artist",
        password: "test-password",
        source: "agent",
      },
    });
    assert.equal(bodySpoof.statusCode, 400, bodySpoof.body);
    assert.deepEqual(calls, [
      {
        lane: "web",
        input: { username: "artist", password: "test-password" },
        userAgent: "browser-test",
      },
      {
        lane: "cli",
        input: { username: "artist", password: "test-password" },
        userAgent: "shortdrama-cli/0.3.0",
      },
    ]);
  } finally {
    await app.close();
  }
});

test("人类会话签发 Agent 凭据时只在本次响应返回 token，字段为 snake_case", async () => {
  const calls: unknown[] = [];
  const app = await createApp({
    ...serviceStub(),
    issueAgentCredential: async (actor, input, userAgent) => {
      calls.push({ actor, input, userAgent });
      return {
        credentialId: "22222222-2222-4222-8222-222222222222",
        token: "shown-once",
        source: "agent",
        agentType: input.agentType,
        label: input.label,
        expiresAt: new Date("2026-08-04T00:00:00.000Z"),
      };
    },
  }, "web");
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/agent-credentials",
      headers: { "user-agent": "credential-console" },
      payload: { agent_type: "shortdrama-agent", label: "Codex 自动化" },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        credential_id: "22222222-2222-4222-8222-222222222222",
        token: "shown-once",
        source: "agent",
        agent_type: "shortdrama-agent",
        label: "Codex 自动化",
        expires_at: "2026-08-04T00:00:00.000Z",
      },
    });
    assert.deepEqual(calls, [{
      actor: {
        userId: registration.user.id,
        sessionId: "33333333-3333-4333-8333-333333333333",
        source: "web",
      },
      input: { agentType: "shortdrama-agent", label: "Codex 自动化" },
      userAgent: "credential-console",
    }]);
  } finally {
    await app.close();
  }
});

test("Agent 凭据不能签发下一枚 Agent 凭据，服务方法零调用", async () => {
  let issueCalls = 0;
  const app = await createApp({
    ...serviceStub(),
    issueAgentCredential: async () => {
      issueCalls += 1;
      throw new Error("不应调用签发服务");
    },
  }, "agent");
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/agent-credentials",
      payload: { agent_type: "shortdrama-agent", label: "自我复制" },
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(issueCalls, 0);
  } finally {
    await app.close();
  }
});

async function createApp(service: AuthServicePort, source?: "web" | "cli" | "agent") {
  const app = Fastify({ logger: false });
  if (source) {
    app.addHook("preHandler", async (request) => {
      request.authUser = {
        id: registration.user.id,
        username: registration.user.username,
        displayName: registration.user.display_name,
        role: registration.user.role,
      };
      request.authSessionId = "33333333-3333-4333-8333-333333333333";
      request.authContext = {
        user: request.authUser,
        credential: {
          sessionId: request.authSessionId,
          source,
          actorKind: source === "agent" ? "agent" : "human",
          agentType: source === "agent" ? "shortdrama-agent" : null,
          userAgent: null,
          expiresAt: new Date("2026-08-04T00:00:00.000Z"),
        },
      };
    });
  }
  await registerAuthRoutes(app, () => ({} as Database), {
    createService: () => service,
  });
  return app;
}

function serviceStub(): AuthServicePort {
  return {
    requestEmailVerification: async ({ email }) => ({
      email,
      expiresAt: new Date("2026-08-02T00:10:00.000Z"),
      devLogCode: "123456",
    }),
    register: async () => registration,
    login: async () => ({
      ...loginResult(),
    }),
    loginCli: async () => loginResult(),
    issueAgentCredential: async () => ({
      credentialId: "22222222-2222-4222-8222-222222222222",
      token: "test-agent-token",
      source: "agent",
      agentType: "shortdrama-agent",
      label: "test",
      expiresAt: new Date("2026-08-04T00:00:00.000Z"),
    }),
    listAgentCredentials: async () => [],
    revokeAgentCredential: async () => true,
    logout: async () => undefined,
    getUiMode: async () => "full",
    updateUiMode: async (_userId, uiMode) => uiMode,
  };
}

function loginResult() {
  return {
    token: "test-token",
    expires_at: "2026-08-03T00:00:00.000Z",
    user: registration.user,
  };
}
