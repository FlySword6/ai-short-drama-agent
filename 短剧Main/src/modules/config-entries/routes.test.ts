import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerConfigEntriesRoutes } from "./routes.js";
import type { ConfigEntriesRepository, ConfigEntry } from "./types.js";

const sectionPayload = {
  title: "v0.2",
  status: "scheduled",
  note: "接口冻结在前，执行链验证在后。",
  cards: [{
    id: "pi-collab",
    title: "Pi 协作",
    tagline: "拆剧本、备参考太费手？——对话说清楚，Pi 帮你备好；付费生成永远由你亲手点。",
    status: "scheduled",
    category: "feature",
    release: "v0.2",
    teaser: "对话拆剧本、提前备好参考、@素材直达提示词",
  }],
};

const sectionEntry: ConfigEntry = {
  id: "entry-1",
  kind: "release_section",
  entryKey: "v0.2",
  status: "published",
  sort: 3,
  payload: sectionPayload,
  source: "seed-023",
  createdBy: null,
  createdAt: new Date("2026-07-26T00:00:00.000Z"),
  updatedBy: null,
  updatedAt: new Date("2026-07-26T00:00:00.000Z"),
};

function createRepository(overrides: Partial<ConfigEntriesRepository> = {}): ConfigEntriesRepository {
  return {
    async listPublishedByKind() { return [sectionEntry]; },
    async listByKind() { return [sectionEntry, { ...sectionEntry, id: "entry-2", entryKey: "v0.3", status: "draft" }]; },
    async create(input) {
      return {
        ...sectionEntry,
        id: "entry-new",
        kind: input.kind,
        entryKey: input.entryKey,
        status: input.status ?? "published",
        sort: input.sort ?? 0,
        payload: input.payload,
      };
    },
    async update(id, kind, input) {
      if (id !== "entry-1") return null;
      return {
        ...sectionEntry,
        kind,
        entryKey: input.entryKey ?? sectionEntry.entryKey,
        status: input.status ?? sectionEntry.status,
        sort: input.sort ?? sectionEntry.sort,
        payload: input.payload ?? sectionEntry.payload,
      };
    },
    async remove(id) { return id === "entry-1"; },
    ...overrides,
  };
}

async function testApp(options: { role?: string; repository?: ConfigEntriesRepository } = {}) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: "user-id",
      username: "producer",
      displayName: "制作人",
      ...(options.role ? { role: options.role as "admin" } : {}),
    };
  });
  await registerConfigEntriesRoutes(
    app,
    () => ({}) as never,
    { createRepository: () => options.repository ?? createRepository() },
  );
  return app;
}

test("登录用户可读已发布配置项,响应保持 snake_case 契约", async () => {
  const app = await testApp({ role: "member" });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/config-entries?kind=release_section" });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.entries.length, 1);
    const entry = body.data.entries[0];
    assert.equal(entry.entry_key, "v0.2");
    assert.equal(entry.status, "published");
    assert.equal(entry.sort, 3);
    assert.equal(entry.source, "seed-023");
    assert.deepEqual(entry.payload, sectionPayload);
    assert.ok(!("entryKey" in entry), "wire 上不得出现 camelCase 键");
  } finally {
    await app.close();
  }
});

test("未登录读配置项返回 401;kind 缺失或非法返回 400", async () => {
  const anonymous = Fastify({ logger: false });
  await registerConfigEntriesRoutes(anonymous, () => ({}) as never, { createRepository: () => createRepository() });
  const member = await testApp({ role: "member" });
  try {
    assert.equal(
      (await anonymous.inject({ method: "GET", url: "/api/v1/config-entries?kind=release_section" })).statusCode,
      401,
    );
    assert.equal((await member.inject({ method: "GET", url: "/api/v1/config-entries" })).statusCode, 400);
    assert.equal((await member.inject({ method: "GET", url: "/api/v1/config-entries?kind=unknown_kind" })).statusCode, 400);
    assert.equal(
      (await member.inject({ method: "GET", url: "/api/v1/config-entries?kind=provider_cost_basis" })).statusCode,
      400,
      "供应商成本单价不得从普通登录可读配置端点暴露",
    );
  } finally {
    await anonymous.close();
    await member.close();
  }
});

test("管理员列表可见草稿;普通成员读管理端点 403", async () => {
  const admin = await testApp({ role: "admin" });
  const member = await testApp({ role: "member" });
  try {
    const response = await admin.inject({ method: "GET", url: "/api/v1/admin/config-entries?kind=release_section" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().data.entries.map((entry: { status: string }) => entry.status),
      ["published", "draft"],
    );
    assert.equal(
      (await member.inject({ method: "GET", url: "/api/v1/admin/config-entries?kind=release_section" })).statusCode,
      403,
    );
    assert.equal(
      (await admin.inject({ method: "GET", url: "/api/v1/admin/config-entries?kind=provider_cost_basis" })).statusCode,
      200,
    );
  } finally {
    await admin.close();
    await member.close();
  }
});

test("管理员可新增配置项并拿到 201;payload 走该类列目校验", async () => {
  const admin = await testApp({ role: "admin" });
  const member = await testApp({ role: "member" });
  try {
    const created = await admin.inject({
      method: "POST",
      url: "/api/v1/admin/config-entries",
      payload: { kind: "release_section", entry_key: "v0.4", sort: 6, payload: { ...sectionPayload, title: "v0.4", cards: [] } },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.entry.entry_key, "v0.4");

    assert.equal((await member.inject({
      method: "POST",
      url: "/api/v1/admin/config-entries",
      payload: { kind: "release_section", entry_key: "v0.4", payload: sectionPayload },
    })).statusCode, 403);

    // 卡片缺 tagline / category 非法 → 400,不入库
    assert.equal((await admin.inject({
      method: "POST",
      url: "/api/v1/admin/config-entries",
      payload: { kind: "release_section", entry_key: "v0.4", payload: { title: "v0.4", status: "concept", cards: [{ id: "x", title: "缺字段" }] } },
    })).statusCode, 400);
    // 段状态取五态之外 → 400
    assert.equal((await admin.inject({
      method: "POST",
      url: "/api/v1/admin/config-entries",
      payload: { kind: "release_section", entry_key: "v0.4", payload: { title: "v0.4", status: "doing", cards: [] } },
    })).statusCode, 400);

    const costBasis = await admin.inject({
      method: "POST",
      url: "/api/v1/admin/config-entries",
      payload: {
        kind: "provider_cost_basis",
        entry_key: "ark-video-test",
        payload: {
          provider: "ark",
          model: "video-test",
          media_kind: "video",
          parameter_match: { resolution: ["720p"] },
          billing_unit: "million_output_tokens",
          usage_keys: ["completion_tokens"],
          unit_price_cny_micros: 37_000_000,
          unit_size: 1_000_000,
          currency: "CNY",
          fallback: {
            kind: "video_token_formula",
            frames_per_second: 24,
            token_divisor: 1024,
            pixel_count_by_resolution_ratio: {
              "720p": { "9:16": 921_600 },
            },
          },
          source_url: "https://www.volcengine.com/docs/82379/1544106",
        },
      },
    });
    assert.equal(costBasis.statusCode, 201, costBasis.body);
    assert.equal(costBasis.json().data.entry.kind, "provider_cost_basis");
  } finally {
    await admin.close();
    await member.close();
  }
});

test("同名(kind, entry_key)撞唯一键时返回 409 人话", async () => {
  const repository = createRepository({
    async create() {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    },
  });
  const app = await testApp({ role: "admin", repository });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/config-entries",
      payload: { kind: "release_section", entry_key: "v0.2", payload: sectionPayload },
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.body, /同一类型下已有同名列/);
  } finally {
    await app.close();
  }
});

test("管理员可改排序/状态/内容;改不存在的 id 返回 404;payload 校验不过 400", async () => {
  const app = await testApp({ role: "admin" });
  try {
    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/config-entries/entry-1",
      payload: { kind: "release_section", sort: 9, status: "archived" },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.entry.sort, 9);
    assert.equal(updated.json().data.entry.status, "archived");

    assert.equal((await app.inject({
      method: "PUT",
      url: "/api/v1/admin/config-entries/not-there",
      payload: { kind: "release_section", sort: 9 },
    })).statusCode, 404);

    assert.equal((await app.inject({
      method: "PUT",
      url: "/api/v1/admin/config-entries/entry-1",
      payload: { kind: "release_section", payload: { title: "坏", status: "doing", cards: [] } },
    })).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("管理员可删除配置项 204;删不存在的 id 返回 404;普通成员 403", async () => {
  const admin = await testApp({ role: "admin" });
  const member = await testApp({ role: "member" });
  try {
    assert.equal((await admin.inject({ method: "DELETE", url: "/api/v1/admin/config-entries/entry-1" })).statusCode, 204);
    assert.equal((await admin.inject({ method: "DELETE", url: "/api/v1/admin/config-entries/not-there" })).statusCode, 404);
    assert.equal((await member.inject({ method: "DELETE", url: "/api/v1/admin/config-entries/entry-1" })).statusCode, 403);
  } finally {
    await admin.close();
    await member.close();
  }
});
