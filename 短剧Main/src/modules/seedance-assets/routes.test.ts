import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { AppError } from "../../shared/errors.js";
import { registerSeedanceAssetRegistrationRoutes } from "./routes.js";
import type { SeedanceAssetRegistrationPort, SeedanceAssetRegistrationView } from "./types.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";
const mediaResultId = "44444444-4444-4444-8444-444444444444";

function view(overrides: Partial<SeedanceAssetRegistrationView> = {}): SeedanceAssetRegistrationView {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    assetMediaId: mediaId,
    sourceMediaResultId: mediaResultId,
    assetGroupId: "asset-group-test",
    remoteAssetId: "Asset-example",
    status: "active",
    createdAt: new Date("2026-07-23T00:00:00.000Z"),
    updatedAt: new Date("2026-07-23T00:00:01.000Z"),
    activatedAt: new Date("2026-07-23T00:00:01.000Z"),
    authorizationExpiresAt: null,
    lastVerifiedAt: new Date("2026-07-23T00:00:01.000Z"),
    latestRequestId: "req-list-example",
    latestErrorCode: null,
    latestErrorMessage: null,
    retryCount: 0,
    lastRetryAt: null,
    ...overrides,
  };
}

function testService(calls: Array<{ method: string; args: unknown[] }>): SeedanceAssetRegistrationPort {
  const record = (method: string, result = view()) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return result;
  };
  return {
    registerMediaResult: record("registerMediaResult"),
    registerAssetMedia: record("registerAssetMedia"),
    refreshMediaResult: record("refreshMediaResult", view({ status: "processing", remoteAssetId: "Asset-example" })),
    refreshAssetMedia: record("refreshAssetMedia"),
    getMediaResult: record("getMediaResult"),
    getAssetMedia: record("getAssetMedia"),
    getRegistration: record("getRegistration"),
    refreshRegistration: record("refreshRegistration"),
  };
}

async function testApp(options: { authenticated?: boolean } = {}) {
  const app = Fastify({ logger: false });
  const calls: Array<{ method: string; args: unknown[] }> = [];
  if (options.authenticated !== false) {
    app.addHook("preHandler", async (request) => {
      request.authUser = { id: actorId, username: "artist", displayName: "制作人", role: "member" };
    });
  }
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ ok: false, error: { code: error.code } });
    return reply.code(500).send({ ok: false, error: { code: "internal_error" } });
  });
  await registerSeedanceAssetRegistrationRoutes(app, () => ({} as Database), {
    createService: () => testService(calls),
  });
  return { app, calls };
}

test("产物注册与刷新均要求登录，并保持显式动作边界", async () => {
  const { app, calls } = await testApp();
  try {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/media-results/${mediaResultId}/seedance-registration`,
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.deepEqual(created.json().data.registration, {
      id: "55555555-5555-4555-8555-555555555555",
      asset_media_id: mediaId,
      source_media_result_id: mediaResultId,
      remote_asset_id: "Asset-example",
      status: "active",
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:01.000Z",
      activated_at: "2026-07-23T00:00:01.000Z",
      authorization_expires_at: null,
      last_verified_at: "2026-07-23T00:00:01.000Z",
      latest_error: null,
    });
    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/media-results/${mediaResultId}/seedance-registration/refresh`,
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.json().data.registration.status, "processing");
    assert.deepEqual(calls, [
      { method: "registerMediaResult", args: [{ id: actorId, username: "artist", displayName: "制作人", role: "member" }, mediaResultId] },
      { method: "refreshMediaResult", args: [{ id: actorId, username: "artist", displayName: "制作人", role: "member" }, mediaResultId] },
    ]);
  } finally {
    await app.close();
  }

  const anonymous = await testApp({ authenticated: false });
  try {
    const response = await anonymous.app.inject({
      method: "POST",
      url: `/api/v1/media-results/${mediaResultId}/seedance-registration`,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(anonymous.calls.length, 0);
  } finally {
    await anonymous.app.close();
  }
});

test("资产媒体注册保留资产归属，非法路径不会调用服务", async () => {
  const { app, calls } = await testApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/media/${mediaId}/seedance-registration`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, [{
      method: "registerAssetMedia",
      args: [{ id: actorId, username: "artist", displayName: "制作人", role: "member" }, assetId, mediaId],
    }]);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/assets/not-a-uuid/media/nope/seedance-registration",
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
  }
});

test("旧登记路由不会回放历史供应商错误消息", async () => {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: actorId,
      username: "artist",
      displayName: "制作人",
      role: "member",
    };
  });
  await registerSeedanceAssetRegistrationRoutes(app, () => ({} as Database), {
    createService: () => ({
      ...testService([]),
      getMediaResult: async () => view({
        status: "failed",
        latestErrorCode: "AccessDenied" as never,
        latestErrorMessage: "AccessDenied: request_url=https://provider.invalid/?token=secret",
      }),
    }),
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/media-results/${mediaResultId}/seedance-registration`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data.registration.latest_error, {
      code: "ASSET_REGISTRY_ACCESS_DENIED",
      message: "火山素材库拒绝访问，请核对账号权限",
    });
    assert.doesNotMatch(response.body, /AccessDenied|provider\.invalid|token=secret/);
  } finally {
    await app.close();
  }
});
