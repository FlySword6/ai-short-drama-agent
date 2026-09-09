import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../../../db/client.js";
import { AppError, NotFoundError, errorBody } from "../../../shared/errors.js";
import { registerAdminUserRoutes, type AdminUserServicePort } from "./routes.js";
import type { AdminActor, AdminUserListRecord, AdminUserRecord } from "./types.js";

const adminId = "11111111-1111-4111-8111-111111111111";
const normalId = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const missingId = "55555555-5555-4555-8555-555555555555";

const user: AdminUserRecord = {
  id: targetId,
  username: "artist",
  displayName: "美术同事",
  role: "member",
  uiMode: "full",
  active: true,
  createdAt: new Date("2026-07-21T01:00:00.000Z"),
  updatedAt: new Date("2026-07-21T01:00:00.000Z"),
};
const listedUser: AdminUserListRecord = {
  ...user,
  email: "artist@example.com",
  emailVerifiedAt: new Date("2026-07-21T00:59:00.000Z"),
  accountCredit: {
    userId: targetId,
    balancePoints: 12_000,
    dailyLimitPoints: 5_000,
    usedTodayPoints: 1_250,
    remainingTodayPoints: 3_750,
    dayDate: "2026-08-04",
    pointToFen: 1,
  },
};
const legacyUser: AdminUserListRecord = {
  ...user,
  id: normalId,
  username: "legacy",
  displayName: "旧账号",
  email: null,
  emailVerifiedAt: null,
  accountCredit: null,
};

async function createTestApp(): Promise<{
  app: FastifyInstance;
  calls: Array<{ type: string; actor: AdminActor; payload?: unknown }>;
}> {
  const app = Fastify({ logger: false });
  setTestErrorHandler(app);
  app.addHook("preHandler", async (request) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token === "admin-token") {
      request.authUser = { id: adminId, username: "admin", displayName: "管理员", role: "admin" };
      request.authSessionId = sessionId;
    }
    if (token === "normal-token") {
      request.authUser = { id: normalId, username: "normal", displayName: "普通用户", role: "member" };
      request.authSessionId = sessionId;
    }
  });

  const calls: Array<{ type: string; actor: AdminActor; payload?: unknown }> = [];
  const service: AdminUserServicePort = {
    listUsers: async (actor) => { calls.push({ type: "list", actor }); return [listedUser, legacyUser]; },
    createUser: async (actor, input) => {
      calls.push({ type: "create", actor, payload: input });
      // 回显 uiMode 模拟真实 service 的缺省 'full'，让响应可断言模式落值。
      return { user: { ...user, uiMode: input.uiMode ?? "full" }, initialPassword: "generated-initial-password" };
    },
    disableUser: async (actor, id) => {
      calls.push({ type: "disable", actor, payload: id });
      return { user: { ...user, active: false }, changed: true, revokedSessionCount: 2 };
    },
    resetPassword: async (actor, id) => {
      calls.push({ type: "reset", actor, payload: id });
      return { user, changed: true, revokedSessionCount: 1, temporaryPassword: "generated-reset-password" };
    },
    updateRole: async (actor, id, role) => {
      calls.push({ type: "role", actor, payload: { id, role } });
      return { ...user, role };
    },
    updateUiMode: async (actor, id, uiMode) => {
      calls.push({ type: "ui-mode", actor, payload: { id, uiMode } });
      if (id === missingId) throw new NotFoundError("用户不存在");
      return { ...user, uiMode };
    },
  };
  await registerAdminUserRoutes(app, () => ({} as Database), { createService: () => service });
  return { app, calls };
}

test("GET /admin/users 只允许数据库角色为 admin 的登录账号，并返回安全用户列表", async () => {
  const { app, calls } = await createTestApp();
  try {
    const missing = await app.inject({ method: "GET", url: "/api/v1/admin/users" });
    assert.equal(missing.statusCode, 401);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { authorization: "Bearer normal-token" },
    });
    assert.equal(forbidden.statusCode, 403);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { authorization: "Bearer admin-token" },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.count, 2);
    assert.equal(body.data.items[0].display_name, "美术同事");
    assert.equal(body.data.items[0].email, "artist@example.com");
    assert.equal(body.data.items[0].email_verified_at, "2026-07-21T00:59:00.000Z");
    assert.deepEqual(body.data.items[0].account_credit, {
      user_id: targetId,
      balance_points: 12_000,
      daily_limit_points: 5_000,
      used_today_points: 1_250,
      remaining_today_points: 3_750,
      day_date: "2026-08-04",
      point_to_fen: 1,
    });
    assert.equal(body.data.items[0].accountCredit, undefined);
    assert.equal(body.data.items[0].password_hash, undefined);
    assert.equal(body.data.items[1].email, null);
    assert.equal(body.data.items[1].email_verified_at, null);
    assert.equal(body.data.items[1].account_credit, null);
    assert.deepEqual(calls, [{ type: "list", actor: { userId: adminId, sessionId } }]);
  } finally {
    await app.close();
  }
});

test("POST /admin/users 创建账号并只在本次响应返回初始密码", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: { authorization: "Bearer admin-token" },
      payload: { username: "Artist", display_name: "美术同事" },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().data.initial_password, "generated-initial-password");
    assert.equal(response.json().data.user.ui_mode, "full");
    assert.deepEqual(calls.at(-1), {
      type: "create",
      actor: { userId: adminId, sessionId },
      payload: { username: "Artist", displayName: "美术同事", role: "member", uiMode: undefined },
    });

    const rejectedPassword = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: { authorization: "Bearer admin-token" },
      payload: { username: "artist", password: "must-not-be-client-controlled" },
    });
    assert.equal(rejectedPassword.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("PATCH /admin/users/:id 按平台角色更新用户角色", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${targetId}`,
      headers: { authorization: "Bearer admin-token" },
      payload: { role: "operator" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.user.role, "operator");
    assert.deepEqual(calls.at(-1), {
      type: "role",
      actor: { userId: adminId, sessionId },
      payload: { id: targetId, role: "operator" },
    });
  } finally {
    await app.close();
  }
});

test("POST /admin/users 建号可指定 ui_mode，缺省落 full，非法值 400", async () => {
  const { app, calls } = await createTestApp();
  try {
    const lite = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: { authorization: "Bearer admin-token" },
      payload: { username: "liteuser", ui_mode: "lite" },
    });
    assert.equal(lite.statusCode, 201);
    assert.equal(lite.json().data.user.ui_mode, "lite");
    assert.deepEqual(calls.at(-1), {
      type: "create",
      actor: { userId: adminId, sessionId },
      payload: { username: "liteuser", displayName: undefined, role: "member", uiMode: "lite" },
    });

    const fallback = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: { authorization: "Bearer admin-token" },
      payload: { username: "fulluser" },
    });
    assert.equal(fallback.statusCode, 201);
    assert.equal(fallback.json().data.user.ui_mode, "full");
    assert.deepEqual(calls.at(-1), {
      type: "create",
      actor: { userId: adminId, sessionId },
      payload: { username: "fulluser", displayName: undefined, role: "member", uiMode: undefined },
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: { authorization: "Bearer admin-token" },
      payload: { username: "baduser", ui_mode: "mini" },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("PATCH /admin/users/:id/ui-mode 更新界面模式，用户不存在 404", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${targetId}/ui-mode`,
      headers: { authorization: "Bearer admin-token" },
      payload: { ui_mode: "lite" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.user.ui_mode, "lite");
    assert.deepEqual(calls.at(-1), {
      type: "ui-mode",
      actor: { userId: adminId, sessionId },
      payload: { id: targetId, uiMode: "lite" },
    });

    const missing = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${missingId}/ui-mode`,
      headers: { authorization: "Bearer admin-token" },
      payload: { ui_mode: "full" },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("PATCH /admin/users/:id/ui-mode 非管理员 403，非法模式与非法 id 400", async () => {
  const { app } = await createTestApp();
  try {
    const forbidden = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${targetId}/ui-mode`,
      headers: { authorization: "Bearer normal-token" },
      payload: { ui_mode: "lite" },
    });
    assert.equal(forbidden.statusCode, 403);

    const invalidMode = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${targetId}/ui-mode`,
      headers: { authorization: "Bearer admin-token" },
      payload: { ui_mode: "mini" },
    });
    assert.equal(invalidMode.statusCode, 400);

    const invalidId = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/users/not-a-uuid/ui-mode",
      headers: { authorization: "Bearer admin-token" },
      payload: { ui_mode: "lite" },
    });
    assert.equal(invalidId.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /admin/users/:id/disable 禁用账号并回显撤销的会话数", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${targetId}/disable`,
      headers: { authorization: "Bearer admin-token" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.user.active, false);
    assert.equal(response.json().data.revoked_session_count, 2);
    assert.deepEqual(calls.at(-1), {
      type: "disable",
      actor: { userId: adminId, sessionId },
      payload: targetId,
    });

    const invalidId = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users/not-a-uuid/disable",
      headers: { authorization: "Bearer admin-token" },
    });
    assert.equal(invalidId.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /admin/users/:id/reset-password 返回新临时密码并撤销旧会话", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${targetId}/reset-password`,
      headers: { authorization: "Bearer admin-token" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.temporary_password, "generated-reset-password");
    assert.equal(response.json().data.revoked_session_count, 1);
    assert.deepEqual(calls.at(-1), {
      type: "reset",
      actor: { userId: adminId, sessionId },
      payload: targetId,
    });
  } finally {
    await app.close();
  }
});

function setTestErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    const normalized = errorBody(error);
    const body = error instanceof AppError || normalized.code !== "internal_error"
      ? normalized
      : statusCode < 500
        ? {
          code: "invalid_request",
          message: error instanceof Error ? error.message : "请求内容不正确",
          retryable: false,
          details: null,
        }
        : normalized;
    return reply.code(statusCode).send({ ok: false, error: body });
  });
}
