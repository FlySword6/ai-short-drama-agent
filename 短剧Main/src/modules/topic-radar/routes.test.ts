import assert from "node:assert/strict"; import test from "node:test"; import Fastify from "fastify";
import type { Database } from "../../db/client.js"; import { registerTopicRadarRoutes } from "./routes.js"; import type { TopicRadarServicePort } from "./types.js";
class Service implements TopicRadarServicePort { targets: any[] = []; async listRankings() { return { rankings: [{ id: "r", name: "榜", subRankings: [] }], dataDate: "2026-07-24", fetchedAt: new Date("2026-07-24T00:00:00Z"), freshness: "fresh" as const }; } async getRankingPage(_actor: any, input: any) { return { ...input, items: input.page === 2 ? [] : [{ rank: 1, title: "剧", heat: null, link: null }], nextPage: input.page === 2 ? null : input.page + 1, endReached: input.page === 2, dataDate: "2026-07-24", fetchedAt: new Date("2026-07-24T00:00:00Z"), freshness: "fresh" as const }; } async forceRefresh(_actor: any, target: any) { this.targets.push(target); return target.kind === "rankings" ? this.listRankings() : this.getRankingPage({}, target); } }
async function app(role = "member", service: TopicRadarServicePort = new Service()) { const server = Fastify(); server.addHook("preHandler", async (request) => { request.authUser = { id: "u", username: "u", displayName: "U", role: role as "admin" | "member" }; }); await registerTopicRadarRoutes(server, () => ({}) as Database, { createService: () => service }); return { server }; }
test("新目录和分页路由使用 snake_case 并保留商业状态", async () => { const { server } = await app(); try { const catalog = await server.inject("/api/v1/topic-radar/rankings"); const page = await server.inject("/api/v1/topic-radar/rankings/r/items?page=2"); assert.equal(catalog.statusCode, 200); assert.equal(catalog.json().data.data_date, "2026-07-24"); assert.equal(catalog.json().data.commercial_display_status, "pending_vendor_written_approval"); assert.deepEqual(page.json().data.next_page, null); assert.equal(page.json().data.end_reached, true); } finally { await server.close(); } });
test("未配置态返回可渲染的空结果与齐全状态字段", async () => {
  const service: TopicRadarServicePort = {
    listRankings: async () => ({
      rankings: [],
      dataDate: null,
      fetchedAt: null,
      freshness: "unconfigured",
    }),
    getRankingPage: async (_actor: any, input: any) => ({
      ...input,
      items: [],
      nextPage: null,
      endReached: true,
      dataDate: null,
      fetchedAt: null,
      freshness: "unconfigured",
    }),
    forceRefresh: async () => ({
      rankings: [],
      dataDate: null,
      fetchedAt: null,
      freshness: "unconfigured",
    }),
  };
  const { server } = await app("member", service);
  try {
    const catalog = (await server.inject("/api/v1/topic-radar/rankings")).json().data;
    const page = (await server.inject("/api/v1/topic-radar/rankings/r/items?page=1")).json().data;
    assert.deepEqual(
      {
        freshness: catalog.freshness,
        data_date: catalog.data_date,
        fetched_at: catalog.fetched_at,
        commercial_display_status: catalog.commercial_display_status,
      },
      {
        freshness: "unconfigured",
        data_date: null,
        fetched_at: null,
        commercial_display_status: "pending_vendor_written_approval",
      },
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.end_reached, true);
  } finally {
    await server.close();
  }
});
test("管理员 refresh 接受 target，成员不能调用", async () => { const member = await app(); const adminService = new Service(); const admin = await app("admin", adminService); try { assert.equal((await member.server.inject({ method: "POST", url: "/api/v1/admin/topic-radar/refresh", payload: { target: "rankings" } })).statusCode, 403); const response = await admin.server.inject({ method: "POST", url: "/api/v1/admin/topic-radar/refresh", payload: { target: "ranking_page", ranking_id: "r", page: 1 } }); assert.equal(response.statusCode, 200); assert.deepEqual(adminService.targets[0], { kind: "ranking_page", rankingId: "r", page: 1 }); } finally { await member.server.close(); await admin.server.close(); } });

test("路由把无效 target、空或超长 ID 变成 400 业务错误", async () => {
  const { server } = await app("admin");
  try {
    const invalidTarget = await server.inject({ method: "POST", url: "/api/v1/admin/topic-radar/refresh", payload: { target: "bad" } });
    assert.equal(invalidTarget.statusCode, 400);
    assert.match(invalidTarget.json().message, /刷新目标无效/);
    const emptyId = await server.inject("/api/v1/topic-radar/rankings/%20/items");
    assert.equal(emptyId.statusCode, 400);
    const tooLong = await server.inject({
      method: "POST",
      url: "/api/v1/admin/topic-radar/refresh",
      payload: { target: "ranking_page", ranking_id: "a".repeat(257) },
    });
    assert.equal(tooLong.statusCode, 400);
  } finally { await server.close(); }
});

test("匿名请求被拒绝，响应没有 total、total_pages 或 has_more", async () => {
  const anonymous = Fastify();
  const service = new Service();
  await registerTopicRadarRoutes(anonymous, () => ({}) as Database, { createService: () => service });
  const loggedIn = await app();
  try {
    assert.equal((await anonymous.inject("/api/v1/topic-radar/rankings")).statusCode, 401);
    const response = await loggedIn.server.inject("/api/v1/topic-radar/rankings/r/items?page=1");
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /total_pages|has_more|"total"/);
  } finally { await anonymous.close(); await loggedIn.server.close(); }
});
