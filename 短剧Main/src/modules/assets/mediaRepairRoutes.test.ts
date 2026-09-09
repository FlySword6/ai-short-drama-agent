import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import {
  registerAssetMediaRepairRoutes,
  type AssetMediaRepairRouteService,
} from "./mediaRepairRoutes.js";
import type { AssetMediaRepairTaskView } from "./mediaRepairTypes.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const repairId = "33333333-3333-4333-8333-333333333333";
const actorId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";

function task(): AssetMediaRepairTaskView {
  const now = new Date("2026-08-04T00:00:00.000Z");
  return {
    id: repairId,
    assetId,
    requestedByUserId: actorId,
    clientIdempotencyKey: idempotencyKey,
    requestHash: "a".repeat(64),
    mode: "safe",
    trigger: "manual",
    mediaIds: [mediaId],
    status: "queued",
    diagnosis: { issue_count: 2 },
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    idempotentReplay: false,
  };
}

test("媒体健康、修理任务和原图短链使用同一资产合同", async () => {
  let kicked = 0;
  const downloadOptions: Array<unknown> = [];
  const service: AssetMediaRepairRouteService = {
    async health(actor, requestedAssetId) {
      assert.equal(actor.id, actorId);
      assert.equal(requestedAssetId, assetId);
      return {
        assetId,
        status: "degraded",
        activeRepairTaskId: null,
        issues: [{
          code: "image_thumbnail_missing",
          mediaId,
          renditionKind: "thumbnail",
          displayReason: "列表缩略图尚未核验，后端可自动生成展示变体。",
          autoRepairable: true,
          blocker: false,
        }],
        mediaCount: 1,
        healthyMediaCount: 0,
        checkedAt: new Date("2026-08-04T00:00:00.000Z"),
      };
    },
    async submit(input) {
      assert.equal(input.actor.id, actorId);
      assert.deepEqual(input.mediaIds, [mediaId]);
      return task();
    },
    async get() { return task(); },
    async createDownloadUrl(_actor, _assetId, _mediaId, options) {
      downloadOptions.push(options);
      return {
        mediaId,
        url: "https://signed.example.test/object",
        expiresAt: new Date("2026-08-04T00:05:00.000Z"),
      };
    },
  };
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户", role: "member" };
  });
  await registerAssetMediaRepairRoutes(app, () => ({} as Database), {
    createService: () => service,
    worker: { kick() { kicked += 1; } },
  });

  const health = await app.inject({ method: "GET", url: `/api/v1/assets/${assetId}/media-health` });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().data.issues[0].display_reason, "列表缩略图尚未核验，后端可自动生成展示变体。");

  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/assets/${assetId}/media-repairs`,
    payload: {
      client_idempotency_key: idempotencyKey,
      media_ids: [mediaId],
      mode: "safe",
    },
  });
  assert.equal(submitted.statusCode, 202);
  assert.equal(submitted.json().data.id, repairId);
  assert.equal(kicked, 1);

  const fetched = await app.inject({
    method: "GET",
    url: `/api/v1/assets/${assetId}/media-repairs/${repairId}`,
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().data.status, "queued");

  const download = await app.inject({
    method: "POST",
    url: `/api/v1/assets/${assetId}/media/${mediaId}/download-url`,
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.json().data.url, "https://signed.example.test/object");

  const preview = await app.inject({
    method: "POST",
    url: `/api/v1/assets/${assetId}/media/${mediaId}/preview-url`,
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().data.url, "https://signed.example.test/object");
  assert.deepEqual(downloadOptions.at(-1), { disposition: "inline" });

  const redirected = await app.inject({
    method: "GET",
    url: `/api/v1/assets/${assetId}/media/${mediaId}/download`,
  });
  assert.equal(redirected.statusCode, 302);
  assert.equal(redirected.headers.location, "https://signed.example.test/object");
  await app.close();
});

test("修理路由缺登录态时 fail closed", async () => {
  const app = Fastify({ logger: false });
  await registerAssetMediaRepairRoutes(app, () => ({} as Database), {
    createService: () => ({
      async health() { throw new Error("must not run"); },
      async submit() { throw new Error("must not run"); },
      async get() { throw new Error("must not run"); },
      async createDownloadUrl() { throw new Error("must not run"); },
    }),
  });
  const response = await app.inject({ method: "GET", url: `/api/v1/assets/${assetId}/media-health` });
  assert.equal(response.statusCode, 401);
  await app.close();
});
