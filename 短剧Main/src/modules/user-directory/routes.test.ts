import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { registerUserDirectoryRoutes } from "./routes.js";
import type { DirectoryUser } from "./types.js";

const results: DirectoryUser[] = [{
  id: "11111111-1111-4111-8111-111111111111",
  username: "artist.liu",
  displayName: "刘美术",
  active: true,
}];

test("登录用户可按用户名或显示名搜索最小用户目录，响应不泄露角色或管理字段", async () => {
  const calls: Array<{ query: string; limit: number }> = [];
  const app = await authenticatedApp(async (query, limit) => {
    calls.push({ query, limit });
    return results;
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/users/directory?q=%E5%88%98%E7%BE%8E" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        items: [{
          id: results[0]?.id,
          username: "artist.liu",
          display_name: "刘美术",
          active: true,
        }],
        count: 1,
      },
    });
    assert.deepEqual(calls, [{ query: "刘美", limit: 20 }]);
  } finally {
    await app.close();
  }
});

test("用户目录要求已登录；空/短查询放行（聚焦展示前 N 条），仅过长查询不触达存储层", async () => {
  const calls: Array<{ query: string; limit: number }> = [];
  const anonymous = Fastify({ logger: false });
  await registerUserDirectoryRoutes(anonymous, () => ({} as Database), {
    createStore: () => ({ searchActiveUsers: async (query, limit) => { calls.push({ query, limit }); return results; } }),
  });
  const authenticated = await authenticatedApp(async (query, limit) => {
    calls.push({ query, limit });
    return results;
  });
  try {
    const missing = await anonymous.inject({ method: "GET", url: "/api/v1/users/directory?q=%E5%88%98%E7%BE%8E" });
    assert.equal(missing.statusCode, 401, missing.body);

    // 空 q / 无 q / 单字都放行——聚焦即展示全部、单字也能搜
    for (const url of [
      "/api/v1/users/directory",
      "/api/v1/users/directory?q=",
      "/api/v1/users/directory?q=%E5%88%98",
    ]) {
      const response = await authenticated.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    }
    assert.equal(calls.length, 3, "空/短查询应触达存储层");
    assert.deepEqual(calls.map((c) => c.query), ["", "", "刘"], "空查询透传空串、单字原样透传");

    // 过长查询被校验拦截，不触达存储层
    const tooLong = await authenticated.inject({ method: "GET", url: `/api/v1/users/directory?q=${"a".repeat(65)}` });
    assert.equal(tooLong.statusCode, 400, tooLong.body);
    assert.equal(calls.length, 3, "过长查询不应触达存储层");
  } finally {
    await anonymous.close();
    await authenticated.close();
  }
});

async function authenticatedApp(searchActiveUsers: (query: string, limit: number) => Promise<DirectoryUser[]>) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: "22222222-2222-4222-8222-222222222222",
      username: "producer.one",
      displayName: "制片人一",
      role: "member",
    };
  });
  await registerUserDirectoryRoutes(app, () => ({} as Database), {
    createStore: () => ({ searchActiveUsers }),
  });
  return app;
}
