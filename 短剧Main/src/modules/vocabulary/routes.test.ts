import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerVocabularyRoutes } from "./routes.js";
import type { VocabularyRepository } from "./types.js";

const laneEntry = {
  id: "character",
  displayName: "角色",
  domain: "entity" as const,
  pickKind: "character",
  sort: 1,
  active: true,
  recommended: [{ key: "character_card", label: "角色卡", required: true }],
};

const roleEntry = {
  id: "character_identity",
  displayName: "角色身份",
  domain: "entity" as const,
  pickKind: null,
  sort: 1,
  active: true,
  recommended: [],
};

const genreEntry = { id: "甜宠", sort: 1, active: true };

function createRepository(overrides: Partial<VocabularyRepository> = {}): VocabularyRepository {
  return {
    async listReferenceLanes() { return [laneEntry]; },
    async listAssetRoles() { return [roleEntry]; },
    async listGenres() { return [genreEntry]; },
    async createReferenceLane(input) {
      return {
        id: input.id,
        displayName: input.displayName,
        domain: input.domain,
        pickKind: input.pickKind ?? null,
        sort: input.sort ?? 0,
        active: true,
        recommended: input.recommended ?? [],
      };
    },
    async createAssetRole(input) {
      return {
        id: input.id,
        displayName: input.displayName,
        domain: input.domain,
        pickKind: input.pickKind ?? null,
        sort: input.sort ?? 0,
        active: true,
        recommended: [],
      };
    },
    async createGenre(input) {
      return { id: input.id, sort: input.sort ?? 0, active: true };
    },
    ...overrides,
  };
}

async function testApp(options: { role?: string; repository?: VocabularyRepository } = {}) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: "user-id",
      username: "producer",
      displayName: "制作人",
      ...(options.role ? { role: options.role as "admin" } : {}),
    };
  });
  await registerVocabularyRoutes(
    app,
    () => ({}) as never,
    { createRepository: () => options.repository ?? createRepository() },
  );
  return app;
}

test("登录用户可读三张词表,响应保持 snake_case 契约", async () => {
  const app = await testApp({ role: "member" });
  try {
    const lanes = await app.inject({ method: "GET", url: "/api/v1/vocabulary/reference-lanes" });
    assert.equal(lanes.statusCode, 200, lanes.body);
    assert.deepEqual(lanes.json(), {
      ok: true,
      data: {
        lanes: [{
          id: "character",
          display_name: "角色",
          domain: "entity",
          pick_kind: "character",
          sort: 1,
          active: true,
          recommended: [{ key: "character_card", label: "角色卡", required: true }],
        }],
      },
    });

    const roles = await app.inject({ method: "GET", url: "/api/v1/vocabulary/asset-roles" });
    assert.equal(roles.statusCode, 200, roles.body);
    assert.deepEqual(roles.json().data.roles, [{
      id: "character_identity",
      display_name: "角色身份",
      domain: "entity",
      pick_kind: null,
      sort: 1,
      active: true,
      recommended: [],
    }]);

    const genres = await app.inject({ method: "GET", url: "/api/v1/vocabulary/genres" });
    assert.equal(genres.statusCode, 200, genres.body);
    assert.deepEqual(genres.json().data.genres, [{ id: "甜宠", sort: 1, active: true }]);
  } finally {
    await app.close();
  }
});

test("未登录读词表返回 401", async () => {
  const app = Fastify({ logger: false });
  await registerVocabularyRoutes(app, () => ({}) as never, { createRepository: () => createRepository() });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/vocabulary/reference-lanes" });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("管理员可新增词条并拿到 201;普通成员 403", async () => {
  const admin = await testApp({ role: "admin" });
  const member = await testApp({ role: "member" });
  try {
    const created = await admin.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/reference-lanes",
      payload: {
        id: "weather",
        display_name: "天气",
        domain: "style",
        sort: 3,
        recommended: [{ key: "weather_card", label: "天气卡", required: false }],
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().data.entry, {
      id: "weather",
      display_name: "天气",
      domain: "style",
      pick_kind: null,
      sort: 3,
      active: true,
      recommended: [{ key: "weather_card", label: "天气卡", required: false }],
    });

    const genre = await admin.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/genres",
      payload: { id: "悬疑", sort: 7 },
    });
    assert.equal(genre.statusCode, 201, genre.body);
    assert.deepEqual(genre.json().data.entry, { id: "悬疑", sort: 7, active: true });

    assert.equal((await member.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/reference-lanes",
      payload: { id: "weather", display_name: "天气", domain: "style" },
    })).statusCode, 403);
  } finally {
    await admin.close();
    await member.close();
  }
});

test("重复 id 落库撞唯一键时返回 409 人话", async () => {
  const repository = createRepository({
    async createReferenceLane() {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    },
  });
  const app = await testApp({ role: "admin", repository });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/reference-lanes",
      payload: { id: "character", display_name: "角色", domain: "entity" },
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.body, /词条已存在/);
  } finally {
    await app.close();
  }
});

test("词条 id 非法(大写/超长)或 body 多字段时 400", async () => {
  const app = await testApp({ role: "admin" });
  try {
    assert.equal((await app.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/asset-roles",
      payload: { id: "Character", display_name: "角色", domain: "entity" },
    })).statusCode, 400);
    assert.equal((await app.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/genres",
      payload: { id: "悬疑", extra: true },
    })).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("登录成员可写入自定义体裁,新体裁 201 且 sort 接在现有最大之后", async () => {
  const app = await testApp({ role: "member" });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/vocabulary/genres",
      payload: { id: "悬疑" },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().data.entry, { id: "悬疑", sort: 2, active: true });
  } finally {
    await app.close();
  }
});

test("重复体裁写入幂等返回 200 与既有词条", async () => {
  const app = await testApp({ role: "member" });
  try {
    const duplicated = await app.inject({
      method: "POST",
      url: "/api/v1/vocabulary/genres",
      payload: { id: "甜宠" },
    });
    assert.equal(duplicated.statusCode, 200, duplicated.body);
    assert.deepEqual(duplicated.json().data.entry, { id: "甜宠", sort: 1, active: true });
  } finally {
    await app.close();
  }
});

test("未登录写体裁返回 401;body 多字段 400", async () => {
  const anonymous = Fastify({ logger: false });
  await registerVocabularyRoutes(anonymous, () => ({}) as never, { createRepository: () => createRepository() });
  const app = await testApp({ role: "member" });
  try {
    assert.equal((await anonymous.inject({
      method: "POST",
      url: "/api/v1/vocabulary/genres",
      payload: { id: "悬疑" },
    })).statusCode, 401);
    assert.equal((await app.inject({
      method: "POST",
      url: "/api/v1/vocabulary/genres",
      payload: { id: "悬疑", sort: 9 },
    })).statusCode, 400);
  } finally {
    await anonymous.close();
    await app.close();
  }
});
