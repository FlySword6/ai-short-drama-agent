import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../../db/client.js";
import { AppError, errorBody } from "../../shared/errors.js";
import { registerAccountCreditRoutes, type AccountCreditServicePort } from "./routes.js";
import type { AccountCreditActor, InvitationTier } from "./types.js";

const adminId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const tierId = "33333333-3333-4333-8333-333333333333";
const codeId = "44444444-4444-4444-8444-444444444444";
const targetId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";

const tier: InvitationTier = { id: tierId, code: "developer", name: "开发者", grantPoints: 100_000, dailyLimitPoints: 100_000, active: true, createdAt: new Date("2026-07-27T00:00:00Z"), updatedAt: new Date("2026-07-27T00:00:00Z") };

test("账户余额本人可读，邀请码和调账只能由数据库 admin 角色调用", async () => {
  const calls: string[] = [];
  const app = await createTestApp(calls);
  try {
    const mine = await app.inject({ method: "GET", url: "/api/v1/account-credits/me", headers: { authorization: "Bearer member" } });
    assert.equal(mine.statusCode, 200);
    assert.equal(mine.json().data.balance_points, 50_000);
    assert.equal(mine.json().data.point_to_fen, 1);

    const forbidden = await app.inject({ method: "POST", url: "/api/v1/admin/invite-tiers", headers: { authorization: "Bearer member" }, payload: { code: "developer", name: "开发者", grant_points: 100000, daily_limit_points: 100000 } });
    assert.equal(forbidden.statusCode, 403);

    const created = await app.inject({ method: "POST", url: "/api/v1/admin/invite-tiers", headers: { authorization: "Bearer admin" }, payload: { code: "developer", name: "开发者", grant_points: 100000, daily_limit_points: 100000 } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.item.grant_points, 100000);
    assert.deepEqual(calls, ["summary:member", "tier:create:admin:developer"]);
  } finally { await app.close(); }
});

test("邀请码明文仅在创建响应出现，后续列表只有掩码", async () => {
  const calls: string[] = [];
  const app = await createTestApp(calls);
  try {
    const created = await app.inject({ method: "POST", url: "/api/v1/admin/invite-codes", headers: { authorization: "Bearer admin" }, payload: { tier_id: tierId, max_redemptions: 2 } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.plaintext_code, "SD-ONCE");
    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/invite-codes", headers: { authorization: "Bearer admin" } });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.items[0].plaintext_code, undefined);
    assert.equal(listed.json().data.items[0].prefix, "SD-ON••••");
  } finally { await app.close(); }
});

test("管理员策略更新允许显式关闭额度，人工调账保持整数积分合同", async () => {
  const calls: string[] = [];
  const app = await createTestApp(calls);
  try {
    const closed = await app.inject({ method: "PATCH", url: "/api/v1/admin/account-credit-policies/self-registration", headers: { authorization: "Bearer admin" }, payload: { daily_limit_points: 0 } });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().data.policy.daily_limit_points, 0);
    const adjusted = await app.inject({ method: "POST", url: `/api/v1/admin/users/${targetId}/account-credits/adjust`, headers: { authorization: "Bearer admin" }, payload: { amount_points: -1, reason: "退款补正" } });
    assert.equal(adjusted.statusCode, 200);
    assert.equal(adjusted.json().data.adjustment.amount_points, -1);
    assert.ok(calls.includes("adjust:admin:-1"));
  } finally { await app.close(); }
});

test("余额为零时完整生成估价在路由前给出人话拒绝，非完整价格查询不受影响", async () => {
  const calls: string[] = [];
  const app = await createTestApp(calls, { balancePoints: 0 });
  app.post("/api/v1/generations/estimate", async () => ({ reached: true }));
  try {
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      headers: { authorization: "Bearer member" },
      payload: { project_id: "77777777-7777-4777-8777-777777777777" },
    });
    assert.equal(rejected.statusCode, 422);
    assert.equal(rejected.json().error.code, "account_credit_insufficient");
    assert.equal(rejected.json().error.message, "生成没排上：积分不够，请联系管理员调整后再试。");

    const browse = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      headers: { authorization: "Bearer member" },
      payload: { model: "price-preview-only" },
    });
    assert.equal(browse.statusCode, 200);
    assert.equal(browse.json().reached, true);
  } finally { await app.close(); }
});

test("试点积分闸门可由配置显式关闭", async () => {
  const calls: string[] = [];
  const app = await createTestApp(calls, { balancePoints: 0, generationPilotCreditGateEnabled: false });
  app.post("/api/v1/generations/estimate", async () => ({ reached: true }));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      headers: { authorization: "Bearer member" },
      payload: { project_id: "77777777-7777-4777-8777-777777777777" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reached, true);
    assert.deepEqual(calls, []);
  } finally { await app.close(); }
});

async function createTestApp(
  calls: string[],
  options: {
    balancePoints?: number;
    dailyLimitPoints?: number;
    usedTodayPoints?: number;
    generationPilotCreditGateEnabled?: boolean;
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? Number((error as { statusCode: number }).statusCode) : 500;
    const body = errorBody(error);
    return reply.code(statusCode).send({ ok: false, error: error instanceof AppError || body.code !== "internal_error" ? body : { code: "invalid_request", message: error instanceof Error ? error.message : "请求内容不正确", retryable: false, details: null } });
  });
  app.addHook("preHandler", async (request) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token === "admin") { request.authUser = { id: adminId, username: "admin", displayName: "管理员", role: "admin" }; request.authSessionId = sessionId; }
    if (token === "member") { request.authUser = { id: memberId, username: "member", displayName: "成员", role: "member" }; request.authSessionId = sessionId; }
  });
  const service: AccountCreditServicePort = {
    getSummary: async (userId) => {
      const balancePoints = options.balancePoints ?? 50_000;
      const dailyLimitPoints = options.dailyLimitPoints ?? 50_000;
      const usedTodayPoints = options.usedTodayPoints ?? 0;
      calls.push(`summary:${userId === memberId ? "member" : "admin"}`);
      return { userId, balancePoints, dailyLimitPoints, usedTodayPoints, remainingTodayPoints: Math.max(0, dailyLimitPoints - usedTodayPoints), dayDate: "2026-07-27", pointToFen: 1 };
    },
    listInvitationTiers: async () => [tier],
    createInvitationTier: async (actor: AccountCreditActor, input) => { calls.push(`tier:create:${actor.userId === adminId ? "admin" : "member"}:${input.code}`); return tier; },
    updateInvitationTier: async () => tier,
    deactivateInvitationTier: async () => undefined,
    listInviteCodes: async () => [{ id: codeId, prefix: "SD-ON••••", tierId, tierCode: "developer", grantPoints: 100_000, dailyLimitPoints: 100_000, maxRedemptions: 2, usedRedemptions: 0, expiresAt: null, active: true, createdAt: new Date(), updatedAt: new Date() }],
    createInviteCode: async () => ({ inviteCode: { id: codeId, prefix: "SD-ON••••", tierId, tierCode: "developer", grantPoints: 100_000, dailyLimitPoints: 100_000, maxRedemptions: 2, usedRedemptions: 0, expiresAt: null, active: true, createdAt: new Date(), updatedAt: new Date() }, plaintextCode: "SD-ONCE" }),
    updateInviteCode: async () => ({ id: codeId, prefix: "SD-ON••••", tierId, tierCode: "developer", grantPoints: 100_000, dailyLimitPoints: 100_000, maxRedemptions: 2, usedRedemptions: 0, expiresAt: null, active: true, createdAt: new Date(), updatedAt: new Date() }),
    deactivateInviteCode: async () => undefined,
    getSelfRegistrationPolicy: async () => ({ policyKey: "self_registration", dailyLimitPoints: 50_000, updatedAt: new Date() }),
    updateSelfRegistrationPolicy: async (_actor, input) => ({ policyKey: "self_registration", dailyLimitPoints: input.dailyLimitPoints, updatedAt: new Date() }),
    adjustBalance: async (actor, userId, input) => { calls.push(`adjust:${actor.userId === adminId ? "admin" : "member"}:${input.amountPoints}`); return { userId, balancePoints: 49_999, amountPoints: input.amountPoints, reason: input.reason, createdAt: new Date() }; },
  };
  await registerAccountCreditRoutes(app, () => ({} as Database), {
    createService: () => service,
    ...(options.generationPilotCreditGateEnabled === undefined
      ? {}
      : { generationPilotCreditGateEnabled: options.generationPilotCreditGateEnabled }),
  });
  return app;
}
