import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { AppError } from "../../shared/errors.js";
import type {
  SeedanceAssetRegistrationPort,
  SeedanceAssetRegistrationView,
} from "../seedance-assets/types.js";
import { volcRegistrationCreateOpenApi } from "./volcRegistrationOpenApi.js";
import { registerVolcAssetRegistrationRoutes } from "./volcRegistrationRoutes.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";
const registrationId = "44444444-4444-4444-8444-444444444444";

function view(overrides: Partial<SeedanceAssetRegistrationView> = {}): SeedanceAssetRegistrationView {
  return {
    id: registrationId,
    assetMediaId: mediaId,
    sourceMediaResultId: null,
    assetGroupId: "group-volc-test",
    remoteAssetId: "asset-volc-test",
    status: "processing",
    createdAt: new Date("2026-08-05T00:00:00.000Z"),
    updatedAt: new Date("2026-08-05T00:00:01.000Z"),
    activatedAt: null,
    authorizationExpiresAt: null,
    lastVerifiedAt: new Date("2026-08-05T00:00:01.000Z"),
    latestRequestId: "req-volc-test",
    latestErrorCode: null,
    latestErrorMessage: null,
    retryCount: 1,
    lastRetryAt: new Date("2026-08-05T00:00:00.500Z"),
    ...overrides,
  };
}

function fakeService(
  calls: Array<{ method: string; args: unknown[] }>,
  defaultView = view(),
): SeedanceAssetRegistrationPort {
  const record = (method: string, result = defaultView) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return result;
  };
  return {
    registerMediaResult: record("registerMediaResult"),
    registerAssetMedia: record("registerAssetMedia"),
    refreshMediaResult: record("refreshMediaResult"),
    refreshAssetMedia: record("refreshAssetMedia"),
    getMediaResult: record("getMediaResult"),
    getAssetMedia: record("getAssetMedia"),
    getRegistration: record("getRegistration"),
    refreshRegistration: record("refreshRegistration", view({ status: "active" })),
  };
}

async function app(authenticated = true, defaultView = view()) {
  const server = Fastify({ logger: false });
  const calls: Array<{ method: string; args: unknown[] }> = [];
  if (authenticated) {
    server.addHook("preHandler", async (request) => {
      request.authUser = {
        id: actorId,
        username: "artist",
        displayName: "制作人",
        role: "member",
      };
    });
  }
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        ok: false,
        error: { code: error.code, message: error.message },
      });
    }
    if (
      typeof error === "object"
      && error !== null
      && "statusCode" in error
      && typeof error.statusCode === "number"
    ) {
      return reply.code(error.statusCode).send({
        ok: false,
        error: {
          code: "invalid_request",
          message: error instanceof Error ? error.message : "invalid request",
        },
      });
    }
    return reply.code(500).send({ ok: false, error: { code: "internal_error" } });
  });
  await registerVolcAssetRegistrationRoutes(server, () => ({} as Database), {
    createService: () => fakeService(calls, defaultView),
  });
  return { server, calls };
}

test("通用资产登记 API 冻结创建、查询和 ListAssets 刷新合同", async () => {
  const { server, calls } = await app();
  try {
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/assets/registrations",
      payload: { asset_id: assetId, asset_media_id: mediaId },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.deepEqual(created.json().data.registration, {
      id: registrationId,
      asset_media_id: mediaId,
      volc_asset_group_id: "group-volc-test",
      volc_asset_id: "asset-volc-test",
      status: "processing",
      request_id: "req-volc-test",
      retry_count: 1,
      last_retry_at: "2026-08-05T00:00:00.500Z",
      last_verified_at: "2026-08-05T00:00:01.000Z",
      failure: null,
    });

    const read = await server.inject({
      method: "GET",
      url: `/api/v1/assets/registrations/${registrationId}`,
    });
    assert.equal(read.statusCode, 200, read.body);

    const refreshed = await server.inject({
      method: "POST",
      url: `/api/v1/assets/registrations/${registrationId}/refresh`,
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.json().data.registration.status, "active");
    assert.deepEqual(calls.map((call) => call.method), [
      "registerAssetMedia",
      "getRegistration",
      "refreshRegistration",
    ]);
    assert.deepEqual(calls[0]?.args, [
      {
        id: actorId,
        username: "artist",
        displayName: "制作人",
        role: "member",
      },
      assetId,
      mediaId,
    ]);
  } finally {
    await server.close();
  }
});

test("通用登记 API 要求登录、严格 UUID 和无额外字段", async () => {
  const authenticated = await app();
  try {
    const invalid = await authenticated.server.inject({
      method: "POST",
      url: "/api/v1/assets/registrations",
      payload: { asset_id: assetId, asset_media_id: "not-a-uuid", extra: true },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(authenticated.calls.length, 0);
  } finally {
    await authenticated.server.close();
  }

  const anonymous = await app(false);
  try {
    const response = await anonymous.server.inject({
      method: "GET",
      url: `/api/v1/assets/registrations/${registrationId}`,
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(anonymous.calls.length, 0);
  } finally {
    await anonymous.server.close();
  }
});

test("通用登记 API 把历史供应商错误码投影为稳定公开分类", async () => {
  const { server } = await app(true, view({
    status: "failed",
    latestErrorCode: "AccessDenied" as never,
    latestErrorMessage: "AccessDenied: request_url=https://provider.invalid/?token=secret",
  }));
  try {
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/assets/registrations/${registrationId}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data.registration.failure, {
      code: "ASSET_REGISTRY_ACCESS_DENIED",
      message: "火山素材库拒绝访问，请核对账号权限",
    });
    assert.doesNotMatch(response.body, /AccessDenied|provider\.invalid|token=secret/);
  } finally {
    await server.close();
  }
});

test("OpenAPI 创建合同公开本地资产双 UUID，不接收 URL 或云端 ID", () => {
  const body = volcRegistrationCreateOpenApi.body;
  assert.deepEqual(body.required, ["asset_id", "asset_media_id"]);
  assert.deepEqual(Object.keys(body.properties), ["asset_id", "asset_media_id"]);
  assert.equal(body.additionalProperties, false);
});
