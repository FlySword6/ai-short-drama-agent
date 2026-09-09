import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { registerEventRoutes } from "./routes.js";
import type { EventRepository } from "./repository.js";
import type { EventAggregationFilter, RecordProductEventInput } from "./types.js";

const admin: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "ops.admin",
  displayName: "运营管理员",
  role: "admin",
};
const member: AuthenticatedUser = {
  id: "22222222-2222-4222-8222-222222222222",
  username: "director.one",
  displayName: "导演一",
  role: "member",
};

test("登录用户可写入轻量事件，服务端绑定当前 user_id", async () => {
  const calls: Array<{ userId: string; input: RecordProductEventInput }> = [];
  const repository = fakeRepository({ recordCalls: calls });
  const app = await buildApp(member, repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: {
        event: "asset.search.submitted",
        props: { scope: "common", result_count: 12 },
        ts: "2026-07-21T08:00:00.000Z",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.userId, member.id);
    assert.equal(calls[0]?.input.event, "asset.search.submitted");
    assert.deepEqual(calls[0]?.input.props, { scope: "common", result_count: 12 });
    assert.equal(calls[0]?.input.occurredAt.toISOString(), "2026-07-21T08:00:00.000Z");
    assert.deepEqual(response.json().data, {
      id: "33333333-3333-4333-8333-333333333333",
      event: "asset.search.submitted",
      props: { scope: "common", result_count: 12 },
      ts: "2026-07-21T08:00:00.000Z",
      received_at: "2026-07-21T08:00:01.000Z",
    });
  } finally {
    await app.close();
  }
});

test("事件入口拒绝未登录、非法名字和过大的记录内容", async () => {
  const repository = fakeRepository();
  const anonymous = await buildApp(undefined, repository);
  const loggedIn = await buildApp(member, repository);
  try {
    const unauthenticated = await anonymous.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: { event: "asset.opened", props: {}, ts: Date.now() },
    });
    assert.equal(unauthenticated.statusCode, 401);

    const invalidName = await loggedIn.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: { event: "资产打开", props: {}, ts: Date.now() },
    });
    assert.equal(invalidName.statusCode, 400);

    const oversized = await loggedIn.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: { event: "asset.opened", props: { detail: "x".repeat(17 * 1024) }, ts: Date.now() },
    });
    assert.equal(oversized.statusCode, 400);
    assert.match(oversized.json().message, /记录内容太多/);
    assert.doesNotMatch(oversized.json().message, /props|KB/);
  } finally {
    await anonymous.close();
    await loggedIn.close();
  }
});

test("只有管理员可按事件、用户、时间查询聚合", async () => {
  const calls: EventAggregationFilter[] = [];
  const repository = fakeRepository({ aggregateCalls: calls });
  const nonAdmin = await buildApp(member, repository);
  const adminApp = await buildApp(admin, repository);
  try {
    const forbidden = await nonAdmin.inject({ method: "GET", url: "/api/v1/admin/events/summary" });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(calls.length, 0);

    const query = new URLSearchParams({
      event: "asset.search.submitted",
      user_id: member.id,
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-21T23:59:59.000Z",
    });
    const response = await adminApp.inject({ method: "GET", url: `/api/v1/admin/events/summary?${query}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, [{
      event: "asset.search.submitted",
      userId: member.id,
      occurredFrom: new Date("2026-07-01T00:00:00.000Z"),
      occurredTo: new Date("2026-07-21T23:59:59.000Z"),
    }]);
    assert.deepEqual(response.json().data.by_event, [{ event: "asset.search.submitted", count: 2 }]);
    assert.deepEqual(response.json().data.by_user, [{ user_id: member.id, username: member.username, count: 2 }]);
    assert.deepEqual(response.json().data.by_date, [{ date: "2026-07-21", count: 2 }]);
    assert.equal(response.json().data.timezone, "UTC");
  } finally {
    await nonAdmin.close();
    await adminApp.close();
  }
});

function fakeRepository(options: {
  recordCalls?: Array<{ userId: string; input: RecordProductEventInput }>;
  aggregateCalls?: EventAggregationFilter[];
} = {}): EventRepository {
  return {
    record: async (userId, input) => {
      options.recordCalls?.push({ userId, input });
      return {
        id: "33333333-3333-4333-8333-333333333333",
        userId,
        ...input,
        receivedAt: new Date("2026-07-21T08:00:01.000Z"),
      };
    },
    aggregate: async (filter) => {
      options.aggregateCalls?.push(filter);
      return {
        total: 2,
        byEvent: [{ event: "asset.search.submitted", count: 2 }],
        byUser: [{ userId: member.id, username: member.username, count: 2 }],
        byDate: [{ date: "2026-07-21", count: 2 }],
      };
    },
  };
}

async function buildApp(user: AuthenticatedUser | undefined, repository: EventRepository) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (user) request.authUser = user;
  });
  await registerEventRoutes(app, () => ({} as Database), {
    createRepository: () => repository,
    adminUsernames: [admin.username],
  });
  return app;
}
