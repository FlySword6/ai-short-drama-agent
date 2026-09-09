import assert from "node:assert/strict"; import test from "node:test";
import { TopicRadarService } from "./service.js"; import { resourceScope, TOPIC_RADAR_SOURCE, type FetchClaim, type TopicRadarSnapshot, type TopicRadarStore, type TopicRadarUpstreamCall } from "./types.js";
import { AppError } from "../../shared/errors.js";
const now = new Date("2026-07-24T10:00:00Z");
class Store implements TopicRadarStore { calls: any[] = []; snapshots = new Map<string, TopicRadarSnapshot>(); async claimFetch(input: any): Promise<FetchClaim> { const scope = resourceScope(input.resource); const old = this.calls.find((x) => x.resourceScope === scope && x.requestKind === input.requestKind); if (old) return { kind: "existing", call: old }; const call = { id: String(this.calls.length), source: TOPIC_RADAR_SOURCE, resourceScope: scope, cacheDate: input.cacheDate, requestKind: input.requestKind, status: "fetching" as const, snapshotId: null, startedAt: now }; this.calls.push(call); return { kind: "claimed", call }; } async completeCallSuccess(input: any) { input.call.status = "succeeded"; input.call.snapshotId = `s${input.call.id}`; const s = { id: input.call.snapshotId, source: TOPIC_RADAR_SOURCE, resourceScope: input.call.resourceScope, cacheDate: input.call.cacheDate, rankDate: input.rankDate, fetchedAt: input.fetchedAt, rawPayload: input.rawPayload, items: input.items.map(({ rawItem, ...item }: any) => item) }; this.snapshots.set(s.id, s); return s; } async completeCallFailure(input: any) { input.call.status = "failed"; } async getSnapshot(id: string) { return this.snapshots.get(id) ?? null; } async getLatestSnapshot(_source: any, resource: any) { const scope = resourceScope(resource); return [...this.snapshots.values()].find((x) => x.resourceScope === scope) ?? null; } }
test("目录与每个页 scope 独立，空页是成功终点", async () => { const store = new Store(); let pageCalls = 0; const service = new TopicRadarService(store, { async fetchRankings() { return { rankDate: null, rankings: [{ id: "a", name: "榜", subRankings: [] }], rawPayload: {} }; }, async fetchRankingPage(input) { pageCalls++; return { rankDate: null, rawPayload: {}, items: input.page === 2 ? [] : [{ rank: 1, title: "剧", heat: null, link: null, rawItem: {} }] }; } }, () => now); const catalog = await service.listRankings({ id: "u" }); const first = await service.getRankingPage({ id: "u" }, { rankingId: "a", page: 1 }); const empty = await service.getRankingPage({ id: "u" }, { rankingId: "a", page: 2 }); assert.equal(catalog.rankings.length, 1); assert.equal(catalog.dataDate, null); assert.equal(catalog.freshness, "fresh"); assert.equal(first.dataDate, null); assert.equal(first.nextPage, 2); assert.equal(empty.endReached, true); assert.equal(pageCalls, 2); assert.equal(store.calls.length, 3); });
test("页码上限给出业务错误", async () => { const service = new TopicRadarService(new Store(), { async fetchRankings() { return { rankDate: null, rankings: [], rawPayload: {} }; }, async fetchRankingPage() { throw new Error("no"); } }); await assert.rejects(service.getRankingPage({ id: "u" }, { rankingId: "a", page: 51 }), /页码超出范围/); });

test("第 50 页非空时不会给出越界 next_page", async () => {
  const service = new TopicRadarService(new Store(), {
    async fetchRankings() { return { rankDate: null, rankings: [], rawPayload: {} }; },
    async fetchRankingPage() { return { rankDate: null, rawPayload: {}, items: [{ rank: 1, title: "剧", heat: null, link: null, rawItem: {} }] }; },
  }, () => now);
  const page = await service.getRankingPage({ id: "u" }, { rankingId: "a", page: 50 });
  assert.equal(page.nextPage, null);
  assert.equal(page.endReached, false);
});

test("scope 编码不会因冒号分隔歧义而碰撞", () => {
  assert.notEqual(
    resourceScope({ kind: "ranking_page", rankingId: "a:b", subRankingId: "c", page: 1 }),
    resourceScope({ kind: "ranking_page", rankingId: "a", subRankingId: "b:c", page: 1 }),
  );
  assert.match(resourceScope({ kind: "ranking_page", rankingId: "x".repeat(256), page: 1 }), /^ranking_page:[a-f0-9]{64}$/);
});

test("未配置时服务不领取额度", async () => {
  const store = new Store();
  const service = new TopicRadarService(store, {
    assertReady() {
      throw new AppError(503, "topic_radar_not_configured", "选题雷达尚未配置，未发送任何上游请求");
    },
    async fetchRankings() { throw new Error("must not fetch"); },
    async fetchRankingPage() { throw new Error("must not fetch"); },
  }, () => now);
  const rankings = await service.listRankings({ id: "u" });
  const page = await service.getRankingPage({ id: "u" }, { rankingId: "a", page: 1 });
  assert.deepEqual(rankings, {
    rankings: [],
    dataDate: null,
    fetchedAt: null,
    freshness: "unconfigured",
  });
  assert.deepEqual(page, {
    rankingId: "a",
    page: 1,
    items: [],
    nextPage: null,
    endReached: true,
    dataDate: null,
    fetchedAt: null,
    freshness: "unconfigured",
  });
  assert.equal(store.calls.length, 0);
});

test("管理员同日重复手动刷新复用已有快照，不重复请求供应商", async () => {
  const store = new Store();
  let providerCalls = 0;
  const service = new TopicRadarService(store, {
    async fetchRankings() {
      providerCalls += 1;
      return { rankDate: "2026-07-20", rankings: [{ id: "a", name: "榜", subRankings: [] }], rawPayload: {} };
    },
    async fetchRankingPage() { throw new Error("must not fetch"); },
  }, () => now);

  await service.listRankings({ id: "u" });
  const firstManual = await service.forceRefresh({ id: "admin", role: "admin" }, { kind: "rankings" });
  const replay = await service.forceRefresh({ id: "admin", role: "admin" }, { kind: "rankings" });

  assert.equal(providerCalls, 2, "daily 一次、manual 一次；重复 manual 不再请求");
  assert.deepEqual(store.calls.map((call) => call.requestKind), ["daily", "manual"]);
  assert.deepEqual(replay, firstManual);
});

test("manual 进行中或失败时不以 daily 快照冒充结果", async () => {
  const store = new Store();
  let providerCalls = 0;
  const service = new TopicRadarService(store, {
    async fetchRankings() {
      providerCalls += 1;
      return { rankDate: "2026-07-20", rankings: [{ id: "a", name: "定时榜", subRankings: [] }], rawPayload: {} };
    },
    async fetchRankingPage() { throw new Error("must not fetch"); },
  }, () => now, { allowStaleFallback: true });

  await service.listRankings({ id: "u" });
  const manualCall: TopicRadarUpstreamCall = {
    id: "manual-in-flight",
    source: TOPIC_RADAR_SOURCE,
    resourceScope: resourceScope({ kind: "rankings" }),
    cacheDate: "2026-07-24",
    requestKind: "manual",
    status: "fetching",
    snapshotId: null,
    startedAt: now,
  };
  store.calls.push(manualCall);

  await assert.rejects(
    service.forceRefresh({ id: "admin", role: "admin" }, { kind: "rankings" }),
    /正在更新/,
  );
  manualCall.status = "failed";
  await assert.rejects(
    service.forceRefresh({ id: "admin", role: "admin" }, { kind: "rankings" }),
    /暂时没有可用数据/,
  );
  assert.equal(providerCalls, 1);
});

test("manual 首次抓取失败时也不回退 daily 快照", async () => {
  const store = new Store();
  let failManual = false;
  const service = new TopicRadarService(store, {
    async fetchRankings() {
      if (failManual) throw new Error("manual upstream down");
      return { rankDate: "2026-07-20", rankings: [{ id: "a", name: "定时榜", subRankings: [] }], rawPayload: {} };
    },
    async fetchRankingPage() { throw new Error("must not fetch"); },
  }, () => now, { allowStaleFallback: true });

  await service.listRankings({ id: "u" });
  failManual = true;
  await assert.rejects(
    service.forceRefresh({ id: "admin", role: "admin" }, { kind: "rankings" }),
    /选题榜单暂时不可用/,
  );
  assert.equal(store.calls.find((call) => call.requestKind === "manual")?.status, "failed");
});

test("生产错误策略下当日抓取失败返回同 scope stale 与真实数据日期", async () => {
  const store = new Store();
  store.snapshots.set("old-rankings", {
    id: "old-rankings",
    source: TOPIC_RADAR_SOURCE,
    resourceScope: resourceScope({ kind: "rankings" }),
    cacheDate: "2026-07-23",
    rankDate: "2026-07-22",
    fetchedAt: new Date("2026-07-23T01:00:00Z"),
    items: [],
    rawPayload: { rankings: [{ id: "a", name: "旧榜", subRankings: [] }] },
  });
  const service = new TopicRadarService(store, {
    async fetchRankings() { throw new Error("upstream down"); },
    async fetchRankingPage() { throw new Error("must not fetch"); },
  }, () => now, { allowStaleFallback: true });

  const view = await service.listRankings({ id: "u" });
  assert.equal(view.freshness, "stale");
  assert.equal(view.dataDate, "2026-07-22");
  assert.equal(view.rankings[0]?.name, "旧榜");
});

test("daily fallback 命中同日 manual 快照仍强制标为 stale", async () => {
  const store = new Store();
  store.snapshots.set("same-day-manual", {
    id: "same-day-manual",
    source: TOPIC_RADAR_SOURCE,
    resourceScope: resourceScope({ kind: "rankings" }),
    cacheDate: "2026-07-24",
    rankDate: "2026-07-20",
    fetchedAt: new Date("2026-07-24T09:00:00Z"),
    items: [],
    rawPayload: { rankings: [{ id: "a", name: "manual-result", subRankings: [] }] },
  });
  const service = new TopicRadarService(store, {
    async fetchRankings() { throw new Error("daily upstream down"); },
    async fetchRankingPage() { throw new Error("must not fetch"); },
  }, () => now, { allowStaleFallback: true });

  const failedFallback = await service.listRankings({ id: "u" });
  assert.equal(failedFallback.freshness, "stale");
  assert.equal(failedFallback.rankings[0]?.name, "manual-result");

  const inFlightStore = new Store();
  inFlightStore.snapshots.set("same-day-manual", store.snapshots.get("same-day-manual")!);
  inFlightStore.calls.push({
    id: "daily-in-flight",
    source: TOPIC_RADAR_SOURCE,
    resourceScope: resourceScope({ kind: "rankings" }),
    cacheDate: "2026-07-24",
    requestKind: "daily",
    status: "fetching",
    snapshotId: null,
    startedAt: now,
  });
  const inFlightService = new TopicRadarService(inFlightStore, {
    async fetchRankings() { throw new Error("must not fetch"); },
    async fetchRankingPage() { throw new Error("must not fetch"); },
  }, () => now, { allowStaleFallback: true });
  assert.equal((await inFlightService.listRankings({ id: "u" })).freshness, "stale");
});

test("开发与测试错误策略不吞上游错误或退回 stale", async () => {
  const store = new Store();
  store.snapshots.set("old-rankings", {
    id: "old-rankings",
    source: TOPIC_RADAR_SOURCE,
    resourceScope: resourceScope({ kind: "rankings" }),
    cacheDate: "2026-07-23",
    rankDate: "2026-07-22",
    fetchedAt: new Date("2026-07-23T01:00:00Z"),
    items: [],
    rawPayload: { rankings: [{ id: "a", name: "旧榜", subRankings: [] }] },
  });
  const upstreamError = new Error("REAL-UPSTREAM-DETAIL");
  const service = new TopicRadarService(store, {
    async fetchRankings() { throw upstreamError; },
    async fetchRankingPage() { throw new Error("must not fetch"); },
  }, () => now);

  await assert.rejects(service.listRankings({ id: "u" }), (error) => error === upstreamError);
});

test("失败不自动重试，fallback 只允许同一 scope", async () => {
  const store = new Store();
  store.snapshots.set("other", { id: "other", source: TOPIC_RADAR_SOURCE, resourceScope: resourceScope({ kind: "ranking_page", rankingId: "other", page: 1 }), cacheDate: "2026-07-23", rankDate: "2026-07-23", fetchedAt: now, items: [], rawPayload: {} });
  const service = new TopicRadarService(store, {
    async fetchRankings() { return { rankDate: null, rankings: [], rawPayload: {} }; },
    async fetchRankingPage() { throw new Error("upstream down"); },
  }, () => now);
  await assert.rejects(service.getRankingPage({ id: "u" }, { rankingId: "wanted", page: 1 }), /upstream down/);
  await assert.rejects(service.getRankingPage({ id: "u" }, { rankingId: "wanted", page: 1 }), /没有可用数据/);
  assert.equal(store.calls.length, 1);
});
