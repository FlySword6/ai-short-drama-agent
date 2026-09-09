import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { AppError, errorBody } from "../../shared/errors.js";
import { registerControlPackageRoutes } from "./routes.js";
import type { ControlPackageStore } from "./types.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "director.one",
  displayName: "导演一",
  role: "operator",
};
const shotId = "22222222-2222-4222-8222-222222222222";
const refId = "33333333-3333-4333-8333-333333333333";
const assetMediaId = "44444444-4444-4444-8444-444444444444";

test("控制包空读、人工就绪与参考物挂摘遵守冻结路径和 snake_case 响应", async () => {
  const calls: string[] = [];
  const store: ControlPackageStore = {
    get: async (actualActor, actualShotId) => {
      calls.push(`get:${actorLabel(actualActor)}:${actualShotId}`);
      return emptyPackage(actualShotId);
    },
    setReady: async (actualActor, actualShotId, ready) => {
      calls.push(`ready:${actorLabel(actualActor)}:${actualShotId}:${ready}`);
      return { ...emptyPackage(actualShotId), id: "55555555-5555-4555-8555-555555555555", ready: {
        markedBy: actorId(actualActor),
        markedByName: "导演一",
        markedAt: "2026-07-22T00:00:00.000Z",
      } };
    },
    addRef: async (actualActor, actualShotId, input) => {
      calls.push(`ref:${actorLabel(actualActor)}:${actualShotId}:${input.lane}:${input.assetMediaId}`);
      return {
        id: refId,
        lane: input.lane,
        kind: "asset",
        mediaId: input.assetMediaId!,
        thumbnailUrl: "https://example.test/thumb.webp",
        storageUrl: "https://example.test/media.webp",
        note: input.note ?? null,
        sortOrder: 0,
      };
    },
    deleteRef: async (actualActor, actualRefId) => {
      calls.push(`delete:${actorLabel(actualActor)}:${actualRefId}`);
    },
  };
  const app = await buildApp(actor, store);
  try {
    const get = await app.inject({ method: "GET", url: `/api/v1/shots/${shotId}/control-package` });
    assert.equal(get.statusCode, 200, get.body);
    assert.deepEqual(get.json().data, {
      id: null,
      shot_id: shotId,
      ready: null,
      lanes: {
        character: [], scene: [], prop: [], camera_motion: [], reference_video: [], audio: [],
      },
    });

    const ready = await app.inject({
      method: "PUT",
      url: `/api/v1/shots/${shotId}/control-package/ready`,
      payload: { ready: true },
    });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().data.ready.marked_by, actor.id);

    const ref = await app.inject({
      method: "POST",
      url: `/api/v1/shots/${shotId}/control-package/refs`,
      payload: { lane: "camera_motion", asset_media_id: assetMediaId, note: "推镜参考" },
    });
    assert.equal(ref.statusCode, 201, ref.body);
    assert.deepEqual(ref.json().data, {
      id: refId,
      lane: "camera_motion",
      kind: "asset",
      media_id: assetMediaId,
      thumbnail_url: "https://example.test/thumb.webp",
      storage_url: "https://example.test/media.webp",
      note: "推镜参考",
      sort_order: 0,
    });

    const deleted = await app.inject({ method: "DELETE", url: `/api/v1/control-package-refs/${refId}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.deepEqual(deleted.json(), { ok: true, data: { deleted: true, id: refId } });
    assert.deepEqual(calls, [
      `get:${actor.id}:operator:${shotId}`,
      `ready:${actor.id}:operator:${shotId}:true`,
      `ref:${actor.id}:operator:${shotId}:camera_motion:${assetMediaId}`,
      `delete:${actor.id}:operator:${refId}`,
    ]);
  } finally {
    await app.close();
  }
});

test("控制包参考物要求二选一引用，未认证或错误输入不触达服务", async () => {
  let called = false;
  const store: ControlPackageStore = {
    get: async () => { called = true; return emptyPackage(shotId); },
    setReady: async () => { called = true; return emptyPackage(shotId); },
    addRef: async () => { called = true; throw new Error("must not run"); },
    deleteRef: async () => { called = true; },
  };
  const anonymous = await buildApp(undefined, store);
  try {
    const response = await anonymous.inject({
      method: "POST",
      url: `/api/v1/shots/${shotId}/control-package/refs`,
      payload: { lane: "character", asset_media_id: assetMediaId },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await anonymous.close();
  }

  const authenticated = await buildApp(actor, store);
  try {
    const both = await authenticated.inject({
      method: "POST",
      url: `/api/v1/shots/${shotId}/control-package/refs`,
      payload: {
        lane: "character",
        asset_media_id: assetMediaId,
        media_result_id: "55555555-5555-4555-8555-555555555555",
      },
    });
    assert.equal(both.statusCode, 400);
    const neither = await authenticated.inject({
      method: "POST",
      url: `/api/v1/shots/${shotId}/control-package/refs`,
      payload: { lane: "character" },
    });
    assert.equal(neither.statusCode, 400);
    assert.match(neither.json().error.message, /检查标出的填写内容/);
    assert.doesNotMatch(neither.json().error.message, /asset_media_id|media_result_id/);
    assert.equal(called, false);
  } finally {
    await authenticated.close();
  }
});

test("控制包把隐藏对象与不存在对象统一为相同的 404 响应体", async () => {
  const hiddenShotId = "66666666-6666-4666-8666-666666666666";
  const missingShotId = "77777777-7777-4777-8777-777777777777";
  const hiddenRefId = "88888888-8888-4888-8888-888888888888";
  const missingRefId = "99999999-9999-4999-8999-999999999999";
  const hiddenShot = new AppError(404, "not_found", "粗剪素材不存在或你没有访问权限");
  const hiddenRef = new AppError(404, "not_found", "控制包参考物不存在或你没有访问权限");
  const store: ControlPackageStore = {
    get: async (_actualActor, actualShotId) => {
      if (actualShotId === hiddenShotId || actualShotId === missingShotId) throw hiddenShot;
      return emptyPackage(actualShotId);
    },
    setReady: async (_actualActor, actualShotId) => emptyPackage(actualShotId),
    addRef: async () => { throw new Error("must not run"); },
    deleteRef: async (_actualActor, actualRefId) => {
      if (actualRefId === hiddenRefId || actualRefId === missingRefId) throw hiddenRef;
    },
  };
  const app = await buildApp(actor, store);
  try {
    const hiddenShotResponse = await app.inject({ method: "GET", url: `/api/v1/shots/${hiddenShotId}/control-package` });
    const missingShotResponse = await app.inject({ method: "GET", url: `/api/v1/shots/${missingShotId}/control-package` });
    assert.equal(hiddenShotResponse.statusCode, 404, hiddenShotResponse.body);
    assert.equal(missingShotResponse.statusCode, 404, missingShotResponse.body);
    assert.deepEqual(hiddenShotResponse.json(), missingShotResponse.json(), "shot 的隐藏与不存在不能从响应体区分");

    const hiddenRefResponse = await app.inject({ method: "DELETE", url: `/api/v1/control-package-refs/${hiddenRefId}` });
    const missingRefResponse = await app.inject({ method: "DELETE", url: `/api/v1/control-package-refs/${missingRefId}` });
    assert.equal(hiddenRefResponse.statusCode, 404, hiddenRefResponse.body);
    assert.equal(missingRefResponse.statusCode, 404, missingRefResponse.body);
    assert.deepEqual(hiddenRefResponse.json(), missingRefResponse.json(), "ref 的隐藏与不存在不能从响应体区分");
  } finally {
    await app.close();
  }
});

function emptyPackage(actualShotId: string) {
  return {
    id: null,
    shotId: actualShotId,
    ready: null,
    lanes: { character: [], scene: [], prop: [], camera_motion: [], reference_video: [], audio: [] },
  };
}

function actorId(actualActor: string | { id: string }): string {
  return typeof actualActor === "string" ? actualActor : actualActor.id;
}

function actorLabel(actualActor: string | { id: string; role?: string }): string {
  return `${actorId(actualActor)}:${typeof actualActor === "string" ? "member" : actualActor.role ?? "member"}`;
}

async function buildApp(user: AuthenticatedUser | undefined, store: ControlPackageStore) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  app.addHook("preHandler", async (request) => {
    if (user) request.authUser = user;
  });
  await registerControlPackageRoutes(app, () => ({} as Database), {
    createControlPackageService: () => store,
  });
  return app;
}
