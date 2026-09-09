import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerCommandPaletteRoutes } from "./routes.js";
import type {
  CommandPaletteActor,
  CommandPaletteRepository,
  CommandPaletteSearchResults,
} from "./types.js";

function emptyResults(): CommandPaletteSearchResults {
  return { projects: [], episodes: [], scenes: [], shots: [], assets: [] };
}

function sampleResults(): CommandPaletteSearchResults {
  return {
    projects: [{ id: "project-1", name: "夜行者", description: "都市悬疑短剧" }],
    episodes: [{ id: "episode-1", projectId: "project-1", episodeNo: 3, name: "天台对峙" }],
    scenes: [{ id: "scene-1", projectId: "project-1", episodeId: "episode-1", sceneNo: 2, name: "夜巷追逐" }],
    shots: [{ id: "shot-1", projectId: "project-1", episodeId: "episode-1", shotCode: "S01-004", title: "回头一望" }],
    assets: [{ id: "asset-1", projectId: "project-1", name: "lin_zhao", displayName: "林昭", assetKind: "character" }],
  };
}

interface RecordedCall {
  actor: CommandPaletteActor;
  query: string;
  perGroupLimit: number;
}

function createRepository(results: CommandPaletteSearchResults, recorded: RecordedCall[]): CommandPaletteRepository {
  return {
    async searchVisible(actor, query, perGroupLimit) {
      recorded.push({ actor, query, perGroupLimit });
      return results;
    },
  };
}

async function testApp(options: { role?: string; repository: CommandPaletteRepository }) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: "user-id",
      username: "producer",
      displayName: "制作人",
      ...(options.role ? { role: options.role as "admin" | "member" } : {}),
    };
  });
  await registerCommandPaletteRoutes(app, () => ({}) as never, { createRepository: () => options.repository });
  return app;
}

test("登录用户可搜索,响应保持 snake_case 契约", async () => {
  const recorded: RecordedCall[] = [];
  const app = await testApp({ role: "member", repository: createRepository(sampleResults(), recorded) });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/command-palette/search?q=%E5%A4%9C" });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    const results = body.data.results;
    assert.deepEqual(Object.keys(results), ["projects", "episodes", "scenes", "shots", "assets"]);
    assert.equal(results.projects[0].name, "夜行者");
    assert.equal(results.episodes[0].project_id, "project-1");
    assert.equal(results.episodes[0].episode_no, 3);
    assert.equal(results.scenes[0].episode_id, "episode-1");
    assert.equal(results.scenes[0].scene_no, 2);
    assert.equal(results.shots[0].shot_code, "S01-004");
    assert.equal(results.assets[0].display_name, "林昭");
    assert.equal(results.assets[0].asset_kind, "character");
    assert.ok(!("projectId" in results.episodes[0]), "wire 上不得出现 camelCase 键");
    assert.ok(!("shotCode" in results.shots[0]), "wire 上不得出现 camelCase 键");
    // 角色与身份原样透传给仓储:可见性在 SQL 层按这个角色裁剪(服务端兜底)。
    assert.deepEqual(recorded[0]?.actor, { id: "user-id", role: "member" });
    assert.equal(recorded[0]?.query, "夜");
    assert.equal(recorded[0]?.perGroupLimit, 5);
  } finally {
    await app.close();
  }
});

test("未登录搜索返回 401", async () => {
  const app = Fastify({ logger: false });
  await registerCommandPaletteRoutes(app, () => ({}) as never, { createRepository: () => createRepository(emptyResults(), []) });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/command-palette/search?q=x" });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("q 缺失、空白或超长返回 400;多余参数返回 400", async () => {
  const app = await testApp({ role: "member", repository: createRepository(emptyResults(), []) });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/command-palette/search" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/command-palette/search?q=%20%20" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/command-palette/search?q=${"a".repeat(65)}` })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/command-palette/search?q=x&limit=99" })).statusCode, 400);
  } finally {
    await app.close();
  }
});
