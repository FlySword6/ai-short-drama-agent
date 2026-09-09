import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { registerReferenceTestRoutes } from "./routes.js";
import type { ReferenceTest, ReferenceTestResult } from "./types.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const testId = "44444444-4444-4444-8444-444444444444";
const resultId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
const mediaResultId = "77777777-7777-4777-8777-777777777777";

const item: ReferenceTest = {
  id: testId,
  projectId,
  name: "宫门夜外光线测试",
  mediaKind: "video",
  mode: "direct_reference",
  modelKey: "seedance-2-5",
  prompt: "女主从宫门阴影处走出",
  parameters: { duration_seconds: 5 },
  referenceMediaIds: [],
  createdByUserId: actorId,
  version: 1,
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
};
const result: ReferenceTestResult = {
  id: resultId,
  referenceTestId: testId,
  generationRequestId: requestId,
  mediaResultId,
  mediaKind: "video",
  mode: "direct_reference",
  modelKey: "seedance-2-5",
  parameters: { duration_seconds: 5 },
  createdByUserId: actorId,
  createdAt: "2026-07-21T00:00:01.000Z",
};

async function createTestApp() {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  const calls: Array<{ method: string; value: unknown }> = [];
  await registerReferenceTestRoutes(app, () => ({} as Database), {
    createService: () => ({
      create: async (...args: unknown[]) => { calls.push({ method: "create", value: args }); return item; },
      get: async () => item,
      list: async () => ({ items: [item], page: 1, pageSize: 20, hasNext: false }),
      update: async (...args: unknown[]) => { calls.push({ method: "update", value: args }); return item; },
      remove: async (...args: unknown[]) => { calls.push({ method: "remove", value: args }); },
      attachResult: async (...args: unknown[]) => { calls.push({ method: "attach", value: args }); return result; },
      listResults: async () => ({ items: [{ ...result, referenceTestName: item.name, mediaResult: { storageUrl: "https://example.invalid/result.mp4", persistenceStatus: "persisted", mimeType: "video/mp4", widthPx: 1080, heightPx: 1920, durationSeconds: 5 } }], page: 1, pageSize: 20, hasNext: false }),
      listProjectResults: async () => ({ items: [{ ...result, referenceTestName: item.name, mediaResult: { storageUrl: "https://example.invalid/result.mp4", persistenceStatus: "persisted", mimeType: "video/mp4", widthPx: 1080, heightPx: 1920, durationSeconds: 5 } }], page: 1, pageSize: 20, hasNext: false }),
      setResultAsDefault: async (...args: unknown[]) => { calls.push({ method: "setDefault", value: args }); return { id: "default" }; },
    }) as never,
  });
  return { app, calls };
}

test("参考测试接口提供 CRUD、稳定分页、结果列表与显式设默认", async () => {
  const { app, calls } = await createTestApp();
  try {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reference-tests`,
      payload: {
        name: item.name,
        media_kind: "video",
        mode: "direct_reference",
        model_key: "seedance-2-5",
        prompt: item.prompt,
        parameters: { duration_seconds: 5 },
        reference_media_ids: [],
      },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().data.media_kind, "video");

    const listed = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/reference-tests?page=1&page_size=20&media_kind=video` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.items[0].model_key, "seedance-2-5");
    assert.equal(listed.json().data.has_next, false);

    const allResults = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/reference-test-results?page=1&page_size=20&media_kind=video` });
    assert.equal(allResults.statusCode, 200);
    assert.equal(allResults.json().data.items[0].reference_test_name, item.name);
    assert.equal(allResults.json().data.items[0].media_result.persistence_status, "persisted");
    assert.equal("review_status" in allResults.json().data.items[0].media_result, false);

    const attached = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reference-tests/${testId}/results`,
      payload: { generation_request_id: requestId, media_result_id: mediaResultId },
    });
    assert.equal(attached.statusCode, 200);
    assert.equal(attached.json().data.generation_request_id, requestId);

    const setDefault = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reference-tests/${testId}/results/${resultId}/set-default`,
      payload: { expected_version: 0 },
    });
    assert.equal(setDefault.statusCode, 200);
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/reference-tests/${testId}`,
      payload: {
        name: item.name,
        media_kind: "video",
        mode: "direct_reference",
        model_key: "seedance-2-5",
        expected_version: 1,
      },
    });
    assert.equal(updated.statusCode, 200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/reference-tests/${testId}`,
      payload: { expected_version: 1 },
    });
    assert.equal(deleted.statusCode, 204);

    assert.deepEqual(calls.map((call) => call.method), ["create", "attach", "setDefault", "update", "remove"]);
    assert.deepEqual(calls[2]?.value, [actorId, projectId, testId, resultId, 0]);
    assert.deepEqual((calls[3]?.value as unknown[])?.at(-1), 1);
    assert.deepEqual(calls[4]?.value, [actorId, projectId, testId, 1]);
  } finally {
    await app.close();
  }
});

test("参考测试接口拒绝非 UUID、未知模式及缺少显式默认版本", async () => {
  const { app } = await createTestApp();
  try {
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reference-tests`,
      payload: { name: "x", media_kind: "video", mode: "automatic", model_key: "x" },
    });
    assert.equal(invalid.statusCode, 400);

    const noVersion = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reference-tests/${testId}/results/${resultId}/set-default`,
      payload: {},
    });
    assert.equal(noVersion.statusCode, 400);

    const updateNoVersion = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/reference-tests/${testId}`,
      payload: { name: "x", media_kind: "image", mode: "direct_reference", model_key: "gpt-image-2" },
    });
    assert.equal(updateNoVersion.statusCode, 400);

    const malformedId = await app.inject({ method: "GET", url: "/api/v1/projects/not-a-uuid/reference-tests" });
    assert.equal(malformedId.statusCode, 400);
  } finally {
    await app.close();
  }
});
