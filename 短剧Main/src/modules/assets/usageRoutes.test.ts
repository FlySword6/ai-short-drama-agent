import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { registerAssetRoutes } from "./routes.js";
import type { AssetUsageReport, AssetUsageService } from "./usage.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "director.one",
  displayName: "导演一",
};
const assetId = "22222222-2222-4222-8222-222222222222";
const projectId = "44444444-4444-4444-8444-444444444444";
const episodeId = "55555555-5555-4555-8555-555555555555";
const shotId = "66666666-6666-4666-8666-666666666666";
const mediaId = "77777777-7777-4777-8777-777777777777";

type UsageServiceStub = Pick<AssetUsageService, "report">;

function reportFixture(): AssetUsageReport {
  return {
    counts: { controlPackages: 1, shots: 1, generationRequests: 2 },
    bindings: [{ projectId, projectName: "测试项目", episodeNos: [1], shotCount: 1 }],
    shots: [{
      projectId,
      projectName: "测试项目",
      episodeId,
      episodeNo: 1,
      sceneId: null,
      sceneNo: null,
      shotId,
      shotCode: "EP01-001",
      via: ["control_package", "generation_request"],
      lanes: ["character"],
      mediaIds: [mediaId],
    }],
  };
}

test("使用明细:project_id 映射到 service,响应 snake_case 且 200", async () => {
  const calls: Array<{ actor: AuthenticatedUser; assetId: string; projectId?: string }> = [];
  const app = await buildApp(actor, {
    report: async (actualActor, actualAssetId, actualProjectId) => {
      assert.equal(typeof actualActor, "object");
      calls.push({
        actor: actualActor as AuthenticatedUser,
        assetId: actualAssetId,
        projectId: actualProjectId,
      });
      return reportFixture();
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}/usage?project_id=${projectId}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        counts: { control_packages: 1, shots: 1, generation_requests: 2 },
        bindings: [{ project_id: projectId, project_name: "测试项目", episode_nos: [1], shot_count: 1 }],
        shots: [{
          project_id: projectId,
          project_name: "测试项目",
          episode_id: episodeId,
          episode_no: 1,
          scene_id: null,
          scene_no: null,
          shot_id: shotId,
          shot_code: "EP01-001",
          via: ["control_package", "generation_request"],
          lanes: ["character"],
          media_ids: [mediaId],
        }],
      },
    });
    assert.deepEqual(calls, [{ actor, assetId, projectId }]);
  } finally {
    await app.close();
  }
});

test("使用明细:不带 project_id 时传 undefined", async () => {
  const calls: Array<{ projectId?: string }> = [];
  const app = await buildApp(actor, {
    report: async (_actorId, _assetId, actualProjectId) => {
      calls.push({ projectId: actualProjectId });
      return { counts: { controlPackages: 0, shots: 0, generationRequests: 0 }, bindings: [], shots: [] };
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/assets/${assetId}/usage` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, [{ projectId: undefined }]);
  } finally {
    await app.close();
  }
});

test("使用明细:非法 query 一律 400 且不触达 service", async () => {
  let called = false;
  const app = await buildApp(actor, {
    report: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  try {
    for (const url of [
      `/api/v1/assets/${assetId}/usage?project_id=not-a-uuid`,
      `/api/v1/assets/${assetId}/usage?hacker=1`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 400, url);
    }
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("使用明细:未登录一律 401", async () => {
  let called = false;
  const app = await buildApp(undefined, {
    report: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/assets/${assetId}/usage` });
    assert.equal(response.statusCode, 401);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

async function buildApp(user: AuthenticatedUser | undefined, service: UsageServiceStub) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (user) request.authUser = user;
  });
  await registerAssetRoutes(app, () => ({} as Database), {
    createUsageService: () => service,
  });
  return app;
}
