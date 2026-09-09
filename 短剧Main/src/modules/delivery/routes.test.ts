import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { registerDeliveryRoutes } from "./routes.js";
import type { GatedManifest } from "./service.js";

const episodeId = "66666666-6666-4666-8666-666666666666";
const actorId = "33333333-3333-4333-8333-333333333333";

const manifest: GatedManifest = {
  version: "v0.1",
  generatedAt: "2026-07-24T01:00:00.000Z",
  project: { id: "project-1", name: "测试短剧" },
  episode: { id: episodeId, no: 1 },
  estimatedCostFen: 100,
  estimatedCostNotice: "预估消耗，非云平台实际账单",
  items: [],
  partial: true,
  gaps: [{ shotId: "shot-2", shotCode: "G02", reason: "video_not_accepted" }],
};

const record = {
  id: "99999999-9999-4999-8999-999999999999",
  projectId: "project-1",
  episodeId,
  manifestHash: "a".repeat(64),
  mediaResultIds: ["video-1"],
  partial: true,
  missingShotCodes: ["G02"],
  purpose: "送审样片",
  deliveredByUserId: actorId,
  createdAt: new Date("2026-07-24T02:00:00.000Z"),
};

async function createTestApp(options: { error?: AppError } = {}) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户", role: "member" };
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message } });
    }
    return reply.code(500).send({ ok: false, error: { code: "internal_error" } });
  });
  const calls: unknown[] = [];
  await registerDeliveryRoutes(app, () => ({} as Database), {
    createService: () => ({
      getPlayback: async (...args: unknown[]) => {
        calls.push({ type: "playback", args });
        if (options.error) throw options.error;
        return { ...manifest, playback: [] };
      },
      getManifest: async (...args: unknown[]) => {
        calls.push({ type: "manifest", args });
        if (options.error) throw options.error;
        return manifest;
      },
      createDeliveryRecord: async (...args: unknown[]) => {
        calls.push({ type: "record", args });
        if (options.error) throw options.error;
        return record;
      },
      listDeliveryRecords: async (...args: unknown[]) => {
        calls.push({ type: "history", args });
        if (options.error) throw options.error;
        return { items: [record], total: 1, page: 1, pageSize: 20 };
      },
      getDownload: async () => {
        throw new NotFoundError("媒体不存在或尚未持久化");
      },
    }),
  });
  return { app, calls };
}

test("playback 与 deliverables 解析 partial=true 并带缺口", async () => {
  const { app, calls } = await createTestApp();
  try {
    const playback = await app.inject({ method: "GET", url: `/api/v1/episodes/${episodeId}/playback?partial=true` });
    assert.equal(playback.statusCode, 200);
    assert.equal(playback.json().data.partial, true);
    assert.equal(playback.json().data.gaps[0].shot_code, "G02");
    assert.deepEqual(calls[0], {
      type: "playback",
      args: [{ id: actorId, username: "tester", displayName: "测试用户", role: "member" }, episodeId, { partial: true }],
    });

    const deliverables = await app.inject({ method: "GET", url: `/api/v1/episodes/${episodeId}/deliverables?partial=true` });
    assert.equal(deliverables.statusCode, 200);
    assert.equal(deliverables.json().data.gaps[0].reason, "video_not_accepted");

    const defaulted = await app.inject({ method: "GET", url: `/api/v1/episodes/${episodeId}/deliverables` });
    assert.equal(defaulted.statusCode, 200);
    assert.deepEqual(calls.at(-1), {
      type: "manifest",
      args: [{ id: actorId, username: "tester", displayName: "测试用户", role: "member" }, episodeId, { partial: false }],
    });
  } finally {
    await app.close();
  }
});

test("POST deliveries 落交付记录返回 201 与 snake_case,GET 列交付历史", async () => {
  const { app, calls } = await createTestApp();
  try {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/episodes/${episodeId}/deliveries`,
      payload: { purpose: "送审样片", partial: true },
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.equal(body.data.manifest_hash.length, 64);
    assert.equal(body.data.media_result_ids[0], "video-1");
    assert.equal(body.data.missing_shot_codes[0], "G02");
    assert.equal(body.data.delivered_by_user_id, actorId);
    assert.deepEqual(calls[0], {
      type: "record",
      args: [{ id: actorId, username: "tester", displayName: "测试用户", role: "member" }, episodeId, { purpose: "送审样片", partial: true }],
    });

    const history = await app.inject({ method: "GET", url: `/api/v1/episodes/${episodeId}/deliveries?page=1&page_size=20` });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().data.total, 1);
    assert.equal(history.json().data.items[0].manifest_hash.length, 64);
  } finally {
    await app.close();
  }
});

test("门禁拦截与非成员分集按合同映射为 409/404", async () => {
  const blocked = await createTestApp({
    error: new ConflictError("有分镜缺少已持久化且通过审核的视频主版本", "deliverable_not_ready", { gaps: [] }),
  });
  try {
    const response = await blocked.app.inject({ method: "GET", url: `/api/v1/episodes/${episodeId}/deliverables` });
    assert.equal(response.statusCode, 409);
    const posted = await blocked.app.inject({
      method: "POST",
      url: `/api/v1/episodes/${episodeId}/deliveries`,
      payload: {},
    });
    assert.equal(posted.statusCode, 409);
  } finally {
    await blocked.app.close();
  }

  const hidden = await createTestApp({ error: new NotFoundError("分集不存在") });
  try {
    const response = await hidden.app.inject({ method: "GET", url: `/api/v1/episodes/${episodeId}/deliveries` });
    assert.equal(response.statusCode, 404);
  } finally {
    await hidden.app.close();
  }
});
