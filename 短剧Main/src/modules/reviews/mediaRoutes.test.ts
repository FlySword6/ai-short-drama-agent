import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { AppError, ForbiddenError, NotFoundError, UnprocessableEntityError } from "../../shared/errors.js";
import type { MediaReviewQueuePage } from "./mediaTypes.js";
import { registerReviewRoutes } from "./routes.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "66666666-6666-4666-8666-666666666666";
const actorId = "33333333-3333-4333-8333-333333333333";
const mediaResultId = "11111111-1111-4111-8111-111111111111";

const queuePage: MediaReviewQueuePage = {
  items: [{
    mediaResultId,
    shotId: "77777777-7777-4777-8777-777777777777",
    shotCode: "G01",
    episodeId,
    episodeNo: 3,
    mediaKind: "video",
    originKind: "generation",
    reviewStatus: "needs_review",
    persistenceStatus: "persisted",
    storageUrl: "https://storage.example/v.mp4",
    mimeType: "video/mp4",
    durationSeconds: 4,
    isPrimary: true,
    selectionSource: "manual",
    createdAt: new Date("2026-07-24T01:00:00.000Z"),
  }],
  total: 1,
  page: 1,
  pageSize: 20,
};

async function createTestApp(options: {
  throwOn?: "queue" | "decide";
  error?: AppError;
} = {}) {
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
  await registerReviewRoutes(app, () => ({} as Database), {
    createMediaReviewService: () => ({
      listQueue: async (...args: unknown[]) => {
        calls.push({ type: "queue", args });
        if (options.throwOn === "queue") throw options.error;
        return queuePage;
      },
      decide: async (...args: unknown[]) => {
        calls.push({ type: "decide", args });
        if (options.throwOn === "decide") throw options.error;
        return [{ mediaResultId, status: "accepted", changed: true, reason: "accepted" }];
      },
      listActions: async () => [],
    }),
  });
  return { app, calls };
}

test("待审队列解析分页与集过滤并输出 snake_case", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/media-reviews?status=needs_review&episode_id=${episodeId}&page=2&page_size=10`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.items[0].media_result_id, mediaResultId);
    assert.equal(body.data.items[0].shot_code, "G01");
    assert.equal(body.data.items[0].episode_no, 3);
    assert.equal(body.data.items[0].is_primary, true);
    assert.equal(body.data.items[0].selection_source, "manual");
    assert.deepEqual(calls[0], {
      type: "queue",
      args: [
        { id: actorId, username: "tester", displayName: "测试用户", role: "member" },
        projectId,
        { status: "needs_review", episodeId, page: 2, pageSize: 10 },
      ],
    });
  } finally {
    await app.close();
  }
});

test("批量裁决透传决定列表并返回逐项结果", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/media-reviews/decisions`,
      payload: {
        decisions: [
          { media_result_id: mediaResultId, action: "approve" },
          { media_result_id: "88888888-8888-4888-8888-888888888888", action: "reject", rejection_reason: "穿帮" },
        ],
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.count, 1);
    assert.deepEqual(calls[0], {
      type: "decide",
      args: [
        { id: actorId, username: "tester", displayName: "测试用户", role: "member" },
        projectId,
        [
          { mediaResultId, action: "approve", rejectionReason: undefined },
          { mediaResultId: "88888888-8888-4888-8888-888888888888", action: "reject", rejectionReason: "穿帮" },
        ],
      ],
    });
  } finally {
    await app.close();
  }
});

test("鉴权与校验路径:非成员 404、非审核人 403、拒绝无理由 422、形状错误 400", async () => {
  const notMember = await createTestApp({ throwOn: "queue", error: new NotFoundError("项目不存在或你没有访问权限") });
  try {
    const response = await notMember.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/media-reviews` });
    assert.equal(response.statusCode, 404);
  } finally {
    await notMember.app.close();
  }

  const notReviewer = await createTestApp({ throwOn: "decide", error: new ForbiddenError("你没有在该项目中执行审核决定的权限") });
  try {
    const response = await notReviewer.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/media-reviews/decisions`,
      payload: { decisions: [{ media_result_id: mediaResultId, action: "approve" }] },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await notReviewer.app.close();
  }

  const missingReason = await createTestApp({ throwOn: "decide", error: new UnprocessableEntityError("拒绝产物时必须填写拒绝理由") });
  try {
    const response = await missingReason.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/media-reviews/decisions`,
      payload: { decisions: [{ media_result_id: mediaResultId, action: "reject" }] },
    });
    assert.equal(response.statusCode, 422);
  } finally {
    await missingReason.app.close();
  }

  const { app } = await createTestApp();
  try {
    const badShape = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/media-reviews/decisions`,
      payload: { decisions: [{ media_result_id: "not-a-uuid", action: "approve" }] },
    });
    assert.equal(badShape.statusCode, 400);
    const badStatus = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/media-reviews?status=unknown`,
    });
    assert.equal(badStatus.statusCode, 400);
  } finally {
    await app.close();
  }
});
