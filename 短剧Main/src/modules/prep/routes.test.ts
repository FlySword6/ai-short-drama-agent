import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { AppError, errorBody } from "../../shared/errors.js";
import { registerScenePrepRoutes } from "./routes.js";
import type { ScenePrepCommitResult, ScenePrepItem } from "./types.js";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "director",
  displayName: "导演",
  role: "member" as const,
};
const sceneId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const mediaId = "55555555-5555-4555-8555-555555555555";
const shotA = "66666666-6666-4666-8666-666666666666";
const shotB = "77777777-7777-4777-8777-777777777777";

test("备戏 API 冻结拉件、列单、撤件与 snake_case 形状", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const item = prepItem();
  const app = await buildApp({
    list: async () => [item],
    pull: async (_actor, actualSceneId, input) => {
      calls.push({ action: "pull", sceneId: actualSceneId, ...input });
      return item;
    },
    remove: async (_actor, actualSceneId, actualItemId) => {
      calls.push({ action: "remove", sceneId: actualSceneId, itemId: actualItemId });
    },
    commit: async () => { throw new Error("must not run"); },
  });
  try {
    const pulled = await app.inject({
      method: "POST",
      url: `/api/v1/scenes/${sceneId}/prep-list/items`,
      payload: {
        lane: "character",
        asset_entity_id: assetId,
        asset_media_id: mediaId,
        client_idempotency_key: "prep-pull-0001",
      },
    });
    assert.equal(pulled.statusCode, 201, pulled.body);
    assert.equal(pulled.json().data.asset_entity_id, assetId);
    assert.equal(pulled.json().data.asset_media_id, mediaId);

    const list = await app.inject({ method: "GET", url: `/api/v1/scenes/${sceneId}/prep-list` });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().data, {
      scene_id: sceneId,
      items: [snakeItem()],
      count: 1,
      pending_count: 1,
      committed_count: 0,
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/scenes/${sceneId}/prep-list/items/${itemId}`,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual(removed.json().data, { deleted: true, item_id: itemId });
    assert.equal(calls.length, 2);
  } finally {
    await app.close();
  }
});

test("prep send 三态：默认场级、指定镜头、铺全场强防误", async () => {
  const commits: Array<Record<string, unknown>> = [];
  const app = await buildApp({
    list: async () => [],
    pull: async () => prepItem(),
    remove: async () => {},
    commit: async (_actor, actualSceneId, input) => {
      commits.push({ sceneId: actualSceneId, ...input });
      const mode = input.allShots ? "all_shots" : input.shotIds ? "shots" : "scene";
      return receipt(mode, input.shotIds ?? (input.allShots ? [shotA, shotB] : []));
    },
  });
  try {
    const scene = await app.inject({
      method: "POST",
      url: `/api/v1/scenes/${sceneId}/prep-list/commit`,
      payload: { client_idempotency_key: "prep-commit-scene" },
    });
    assert.equal(scene.statusCode, 200, scene.body);
    assert.equal(scene.json().data.mode, "scene");
    assert.deepEqual(scene.json().data.shot_ids, []);
    assert.deepEqual(scene.json().data.control_package_ref_ids, []);

    const shots = await app.inject({
      method: "POST",
      url: `/api/v1/scenes/${sceneId}/prep-list/commit`,
      payload: { shot_ids: [shotA], client_idempotency_key: "prep-commit-shot" },
    });
    assert.equal(shots.statusCode, 200, shots.body);
    assert.equal(shots.json().data.mode, "shots");

    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/scenes/${sceneId}/prep-list/commit`,
      payload: { all_shots: true, client_idempotency_key: "prep-commit-all-a" },
    });
    assert.equal(blocked.statusCode, 400, blocked.body);
    assert.match(blocked.json().error.message, /检查标出的填写内容/);
    assert.equal(commits.length, 2, "缺防误确认不能触达服务");

    const all = await app.inject({
      method: "POST",
      url: `/api/v1/scenes/${sceneId}/prep-list/commit`,
      payload: {
        all_shots: true,
        i_mean_it: true,
        client_idempotency_key: "prep-commit-all-b",
      },
    });
    assert.equal(all.statusCode, 200, all.body);
    assert.equal(all.json().data.mode, "all_shots");
    assert.deepEqual(all.json().data.shot_ids, [shotA, shotB]);
    assert.deepEqual(commits.map((call) => ({
      shotIds: call.shotIds,
      allShots: call.allShots,
    })), [
      { shotIds: undefined, allShots: false },
      { shotIds: [shotA], allShots: false },
      { shotIds: undefined, allShots: true },
    ]);
  } finally {
    await app.close();
  }
});

function prepItem(): ScenePrepItem {
  return {
    id: itemId,
    sceneId,
    lane: "character",
    assetEntityId: assetId,
    assetVariantId: null,
    assetMediaId: mediaId,
    assetName: "角色甲",
    thumbnailUrl: "https://example.test/role.webp",
    status: "pending",
    projectAssetRefId: null,
    committedByUserId: null,
    committedAt: null,
    createdByUserId: actor.id,
    createdAt: new Date("2026-08-02T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  };
}

function snakeItem() {
  return {
    id: itemId,
    scene_id: sceneId,
    lane: "character",
    asset_entity_id: assetId,
    asset_variant_id: null,
    asset_media_id: mediaId,
    asset_name: "角色甲",
    thumbnail_url: "https://example.test/role.webp",
    status: "pending",
    project_asset_ref_id: null,
    committed_by_user_id: null,
    committed_at: null,
    created_by_user_id: actor.id,
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
  };
}

function receipt(
  mode: ScenePrepCommitResult["mode"],
  shotIds: string[],
): ScenePrepCommitResult {
  return {
    commitId: "88888888-8888-4888-8888-888888888888",
    sceneId,
    projectId: "99999999-9999-4999-8999-999999999999",
    mode,
    itemIds: [itemId],
    projectAssetRefIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    shotIds,
    controlPackageRefIds: mode === "scene" ? [] : ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    controlPackageRefCount: mode === "scene" ? 0 : 1,
    committedAt: new Date("2026-08-02T00:01:00.000Z"),
    idempotentReplay: false,
  };
}

async function buildApp(service: {
  list: (...args: any[]) => Promise<ScenePrepItem[]>;
  pull: (...args: any[]) => Promise<ScenePrepItem>;
  remove: (...args: any[]) => Promise<void>;
  commit: (...args: any[]) => Promise<ScenePrepCommitResult>;
}) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerScenePrepRoutes(app, () => ({} as Database), {
    createService: () => service,
  });
  return app;
}
