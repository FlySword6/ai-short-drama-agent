import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { registerShotMediaRoutes } from "./routes.js";
import type { ShotMediaService } from "./service.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "director.one",
  displayName: "导演一",
};
const shotId = "22222222-2222-4222-8222-222222222222";
const assetMediaId = "33333333-3333-4333-8333-333333333333";
const mediaResultId = "44444444-4444-4444-8444-444444444444";

test("已入库图片登记为分镜主图，重复请求返回同一 media_result", async () => {
  const calls: Array<{ actorId: string; shotId: string; assetMediaId: string }> = [];
  let created = true;
  const service = {
    registerAssetMediaAsPrimary: async (
      currentActor: AuthenticatedUser,
      actualShotId: string,
      actualAssetMediaId: string,
    ) => {
      calls.push({ actorId: currentActor.id, shotId: actualShotId, assetMediaId: actualAssetMediaId });
      const result = {
        shot_id: actualShotId,
        media_kind: "image",
        media_result_id: mediaResultId,
        selected_media_result_id: mediaResultId,
        source_asset_media_id: actualAssetMediaId,
        created,
      };
      created = false;
      return result;
    },
  } as unknown as ShotMediaService;
  const app = await buildApp(actor, service);
  try {
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/shots/${shotId}/media/from-asset`,
      payload: { asset_media_id: assetMediaId },
    });
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(first.json(), {
      ok: true,
      data: {
        shot_id: shotId,
        media_kind: "image",
        media_result_id: mediaResultId,
        selected_media_result_id: mediaResultId,
        source_asset_media_id: assetMediaId,
        origin_label: "从素材库选用",
        created: true,
      },
    });

    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/shots/${shotId}/media/from-asset`,
      payload: { asset_media_id: assetMediaId },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().data.media_result_id, mediaResultId);
    assert.equal(retry.json().data.created, false);
    assert.deepEqual(calls, [
      { actorId: actor.id, shotId, assetMediaId },
      { actorId: actor.id, shotId, assetMediaId },
    ]);
  } finally {
    await app.close();
  }
});

test("分镜资产登记拒绝未登录和不合法 asset_media_id", async () => {
  let called = false;
  const service = {
    registerAssetMediaAsPrimary: async () => {
      called = true;
      throw new Error("must not run");
    },
  } as unknown as ShotMediaService;

  const anonymous = await buildApp(undefined, service);
  try {
    const response = await anonymous.inject({
      method: "POST",
      url: `/api/v1/shots/${shotId}/media/from-asset`,
      payload: { asset_media_id: assetMediaId },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await anonymous.close();
  }

  const authenticated = await buildApp(actor, service);
  try {
    const response = await authenticated.inject({
      method: "POST",
      url: `/api/v1/shots/${shotId}/media/from-asset`,
      payload: { asset_media_id: "not-a-uuid" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(called, false);
  } finally {
    await authenticated.close();
  }
});

async function buildApp(user: AuthenticatedUser | undefined, service: ShotMediaService) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (user) request.authUser = user;
  });
  await registerShotMediaRoutes(app, () => ({} as Database), {
    createShotMediaService: () => service,
  });
  return app;
}
