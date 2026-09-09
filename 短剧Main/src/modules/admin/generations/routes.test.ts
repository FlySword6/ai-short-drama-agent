import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../../db/client.js";
import type { AuthenticatedUser } from "../../../http/authenticate.js";
import { registerAdminGenerationRoutes, type AdminGenerationsRouteDependencies } from "./routes.js";
import type { AdminGenerationsRepository } from "./repository.js";
import type { AdminGenerationListFilter, AdminGenerationListResult, AdminGenerationStats } from "./types.js";

const dummyDb = {} as Database;
const allowedAdmins = ["ops.admin"];
const adminUser: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "ops.admin",
  displayName: "运营管理员",
  role: "admin",
};
const memberUser: AuthenticatedUser = {
  id: "22222222-2222-4222-8222-222222222222",
  username: "regular.user",
  displayName: "普通用户",
  role: "member",
};

const listItemFixture: AdminGenerationListResult["items"][number] = {
  requestId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  projectName: "夜色倾城",
  userId: "55555555-5555-4555-8555-555555555555",
  username: "director.li",
  mediaKind: "video",
  status: "failed",
  phase: "complete",
  attemptNo: 2,
  model: "seedance-2-0",
  estimatedCostFen: 1280,
  failureReason: "ProviderError: Ark request failed with HTTP status 503",
  providerTaskId: "provider-task-9",
  createdAt: new Date("2026-07-18T02:00:00.000Z"),
  updatedAt: new Date("2026-07-18T02:05:00.000Z"),
};

const statsFixture: AdminGenerationStats = {
  byStatus: [
    { status: "pending", count: 1 },
    { status: "running", count: 2 },
    { status: "succeeded", count: 30 },
    { status: "failed", count: 4 },
    { status: "cancelled", count: 0 },
  ],
  topFailureReasons: [
    { failureReason: "ProviderError: Ark request failed with HTTP status 503", count: 3 },
    { failureReason: "预算不足", count: 1 },
  ],
  dailyCostFen: [
    { date: "2026-07-19", estimatedCostFen: 500 },
    { date: "2026-07-20", estimatedCostFen: 1280 },
  ],
  windowDays: 30,
};

interface TestAppOptions {
  authUser?: AuthenticatedUser;
  listResult?: AdminGenerationListResult;
  stats?: AdminGenerationStats;
  listCalls?: AdminGenerationListFilter[];
  statsCallCount?: { count: number };
}

async function buildApp(options: TestAppOptions = {}) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (options.authUser) request.authUser = options.authUser;
  });
  const repository: AdminGenerationsRepository = {
    list: async (filter) => {
      options.listCalls?.push(filter);
      return options.listResult ?? { items: [], total: 0, limit: filter.limit, offset: filter.offset };
    },
    stats: async () => {
      if (options.statsCallCount) options.statsCallCount.count += 1;
      return options.stats ?? statsFixture;
    },
  };
  const dependencies: AdminGenerationsRouteDependencies = {
    adminUsernames: allowedAdmins,
    createRepository: () => repository,
  };
  await registerAdminGenerationRoutes(app, () => dummyDb, dependencies);
  return app;
}

test("未登录返回 401、已登录非管理员返回 403，两者都不会触碰生成任务仓库", async () => {
  const listCalls: AdminGenerationListFilter[] = [];
  const statsCallCount = { count: 0 };

  const anonymousApp = await buildApp({ listCalls, statsCallCount });
  const memberApp = await buildApp({ authUser: memberUser, listCalls, statsCallCount });
  try {
    const anonymousList = await anonymousApp.inject({ method: "GET", url: "/api/v1/admin/generations" });
    assert.equal(anonymousList.statusCode, 401);
    const anonymousStats = await anonymousApp.inject({ method: "GET", url: "/api/v1/admin/generations/stats" });
    assert.equal(anonymousStats.statusCode, 401);

    const memberList = await memberApp.inject({ method: "GET", url: "/api/v1/admin/generations" });
    assert.equal(memberList.statusCode, 403);
    const memberStats = await memberApp.inject({ method: "GET", url: "/api/v1/admin/generations/stats" });
    assert.equal(memberStats.statusCode, 403);

    assert.equal(listCalls.length, 0, "非管理员请求不应该查询生成任务仓库");
    assert.equal(statsCallCount.count, 0, "非管理员请求不应该查询统计仓库");
  } finally {
    await anonymousApp.close();
    await memberApp.close();
  }
});

test("管理员列表接口把过滤条件原样传给仓库，并返回稳定分页与蛇形字段", async () => {
  const listCalls: AdminGenerationListFilter[] = [];
  const app = await buildApp({
    authUser: adminUser,
    listCalls,
    listResult: { items: [listItemFixture], total: 12, limit: 5, offset: 5 },
  });
  try {
    const query = new URLSearchParams({
      status: "failed",
      media_kind: "video",
      created_from: "2026-07-01T00:00:00.000Z",
      created_to: "2026-07-20T23:59:59.000Z",
      limit: "5",
      offset: "5",
    });
    const response = await app.inject({ method: "GET", url: `/api/v1/admin/generations?${query.toString()}` });
    assert.equal(response.statusCode, 200);

    assert.equal(listCalls.length, 1);
    assert.deepEqual(listCalls[0], {
      status: "failed",
      mediaKind: "video",
      createdFrom: new Date("2026-07-01T00:00:00.000Z"),
      createdTo: new Date("2026-07-20T23:59:59.000Z"),
      limit: 5,
      offset: 5,
    });

    const payload = response.json() as { ok: boolean; data: Record<string, unknown> };
    assert.equal(payload.ok, true);
    assert.equal(payload.data.count, 1);
    assert.equal(payload.data.total, 12);
    assert.equal(payload.data.limit, 5);
    assert.equal(payload.data.offset, 5);
    // offset(5) + returned items(1) = 6, still short of total(12): there is another page.
    assert.equal(payload.data.next_offset, 6);

    const item = (payload.data.items as Array<Record<string, unknown>>)[0];
    assert.deepEqual(item, {
      generation_request_id: listItemFixture.requestId,
      project_id: listItemFixture.projectId,
      project_name: listItemFixture.projectName,
      user_id: listItemFixture.userId,
      username: listItemFixture.username,
      media_kind: "video",
      status: "failed",
      phase: "complete",
      attempt_no: 2,
      model: "seedance-2-0",
      estimated_cost_fen: 1280,
      failure_reason: "ProviderError: Ark request failed with HTTP status 503",
      display_reason: "视频生成没成：生成服务暂时没响应，请稍后重试。",
      provider_task_id: "provider-task-9",
      created_at: "2026-07-18T02:00:00.000Z",
      updated_at: "2026-07-18T02:05:00.000Z",
    });
  } finally {
    await app.close();
  }
});

test("管理员列表接口在没有筛选时使用默认分页，且没有下一页时 next_offset 为空", async () => {
  const listCalls: AdminGenerationListFilter[] = [];
  const app = await buildApp({
    authUser: adminUser,
    listCalls,
    listResult: { items: [], total: 0, limit: 20, offset: 0 },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/generations" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(listCalls[0], {
      status: undefined,
      mediaKind: undefined,
      createdFrom: undefined,
      createdTo: undefined,
      limit: 20,
      offset: 0,
    });
    const payload = response.json() as { data: Record<string, unknown> };
    assert.equal(payload.data.count, 0);
    assert.equal(payload.data.next_offset, null);
  } finally {
    await app.close();
  }
});

test("管理员列表接口拒绝超出范围的分页参数和倒挂的时间区间", async () => {
  const app = await buildApp({ authUser: adminUser });
  try {
    const limitTooLarge = await app.inject({ method: "GET", url: "/api/v1/admin/generations?limit=101" });
    assert.equal(limitTooLarge.statusCode, 400);

    const negativeOffset = await app.inject({ method: "GET", url: "/api/v1/admin/generations?offset=-1" });
    assert.equal(negativeOffset.statusCode, 400);

    const invertedRange = await app.inject({
      method: "GET",
      url: "/api/v1/admin/generations?created_from=2026-07-20T00:00:00.000Z&created_to=2026-07-01T00:00:00.000Z",
    });
    assert.equal(invertedRange.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("统计接口返回稳定的状态计数、TOP5 失败原因与近 30 天按日费用形状", async () => {
  const statsCallCount = { count: 0 };
  const app = await buildApp({ authUser: adminUser, statsCallCount });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/generations/stats" });
    assert.equal(response.statusCode, 200);
    assert.equal(statsCallCount.count, 1);

    const payload = response.json() as { ok: boolean; data: Record<string, unknown> };
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.data.by_status, [
      { status: "pending", count: 1 },
      { status: "running", count: 2 },
      { status: "succeeded", count: 30 },
      { status: "failed", count: 4 },
      { status: "cancelled", count: 0 },
    ]);
    assert.deepEqual(payload.data.top_failure_reasons, [
      {
        failure_reason: "ProviderError: Ark request failed with HTTP status 503",
        display_reason: "内容生成没成：生成服务暂时没响应，请稍后重试。",
        count: 3,
      },
      {
        failure_reason: "预算不足",
        display_reason: "生成没成：可用积分不足，请充值或选择较低档位后重试。",
        count: 1,
      },
    ]);
    assert.ok((payload.data.top_failure_reasons as unknown[]).length <= 5);
    assert.deepEqual(payload.data.daily_cost_fen, [
      { date: "2026-07-19", estimated_cost_fen: 500 },
      { date: "2026-07-20", estimated_cost_fen: 1280 },
    ]);
    assert.equal(payload.data.window_days, 30);
    assert.equal(typeof payload.data.notice, "string");
  } finally {
    await app.close();
  }
});
