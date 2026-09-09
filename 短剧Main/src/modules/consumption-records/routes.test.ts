import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { AppError, ForbiddenError, NotFoundError, errorBody } from "../../shared/errors.js";
import { registerConsumptionRecordRoutes } from "./routes.js";
import type { ConsumptionRecordsRepository } from "./repository.js";
import type { ConsumptionRecordPage } from "./types.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function page(): ConsumptionRecordPage {
  return {
    records: [{
      createdAt: new Date("2026-07-22T08:00:00.000Z"),
      taskType: "generation" as const,
      modelDisplayName: "Seedance 2.0",
      episodeNo: null,
      promptExcerpt: null,
      taskId: "33333333-3333-4333-8333-333333333333",
      points: 84,
      projectName: "雨夜巷口",
      sourceTable: "generation_requests",
      sourceId: "33333333-3333-4333-8333-333333333333",
      isUnpriced: false,
    }],
    total: 1,
    page: 2,
    pageSize: 20,
    compatibilityGaps: [
      "成本账本没有 media_kind，不能按图片或视频筛选。",
      "成本账本没有 episode_id 与提示词，明细不会伪造分集或提示词。",
    ],
  };
}

async function createApp(calls: unknown[], result: ConsumptionRecordPage = page()) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "maker", displayName: "制片" };
  });
  const repository: ConsumptionRecordsRepository = {
    list: async (...args) => {
      calls.push(args);
      return result;
    },
    getSceneConsumptionSummary: async () => ({ totalCostPoints: 0, requestCount: 0, breakdownByKind: [] }),
  };
  await registerConsumptionRecordRoutes(app, () => ({} as Database), { createRepository: () => repository });
  return app;
}

test("项目消耗明细传入筛选条件且不泄漏项目名", async () => {
  const calls: unknown[] = [];
  const app = await createApp(calls);
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/consumption/records?from=2026-07-01T00:00:00.000Z&to=2026-07-22T00:00:00.000Z&task_type=generation&model=Seedance%202.0&page=2&page_size=20`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [[actorId, {
      projectId,
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-22T00:00:00.000Z"),
      taskType: "generation",
      model: "Seedance 2.0",
      page: 2,
      pageSize: 20,
    }]]);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        cost_source: "cost_entries",
        compatibility_gaps: [
          "成本账本没有 media_kind，不能按图片或视频筛选。",
          "成本账本没有 episode_id 与提示词，明细不会伪造分集或提示词。",
        ],
        records: [{
          created_at: "2026-07-22T08:00:00.000Z",
          task_type: "generation",
          model_display_name: "Seedance 2.0",
          episode_no: null,
          prompt_excerpt: null,
          task_id: "33333333-3333-4333-8333-333333333333",
          points: 84,
          source_table: "generation_requests",
          source_id: "33333333-3333-4333-8333-333333333333",
          is_unpriced: false,
        }],
        total: 1,
        page: 2,
        page_size: 20,
      },
    });
  } finally {
    await app.close();
  }
});

test("全局消耗明细显示项目名，并拒绝超大分页与倒置时间", async () => {
  const calls: unknown[] = [];
  const app = await createApp(calls);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/consumption/records" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.records[0].project_name, "雨夜巷口");
    assert.deepEqual(calls, [[actorId, {
      projectId: undefined,
      from: undefined,
      to: undefined,
      taskType: undefined,
      model: undefined,
      page: 1,
      pageSize: 20,
    }]]);

    const tooLarge = await app.inject({ method: "GET", url: "/api/v1/consumption/records?page_size=101" });
    assert.equal(tooLarge.statusCode, 400);
    const inverted = await app.inject({
      method: "GET",
      url: "/api/v1/consumption/records?from=2026-07-23T00:00:00.000Z&to=2026-07-22T00:00:00.000Z",
    });
    assert.equal(inverted.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("消耗明细必须登录", async () => {
  const app = Fastify({ logger: false });
  await registerConsumptionRecordRoutes(app, () => ({} as Database), {
    createRepository: () => ({ list: async () => page(), getSceneConsumptionSummary: async () => ({ totalCostPoints: 0, requestCount: 0, breakdownByKind: [] }) }),
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/consumption/records" });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("超出末页仍如实返回总数", async () => {
  const app = await createApp([], {
    records: [],
    total: 41,
    page: 4,
    pageSize: 20,
    compatibilityGaps: [
      "成本账本没有 media_kind，不能按图片或视频筛选。",
      "成本账本没有 episode_id 与提示词，明细不会伪造分集或提示词。",
    ],
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/consumption/records?page=4&page_size=20" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, {
      cost_source: "cost_entries",
      compatibility_gaps: [
        "成本账本没有 media_kind，不能按图片或视频筛选。",
        "成本账本没有 episode_id 与提示词，明细不会伪造分集或提示词。",
      ],
      records: [],
      total: 41,
      page: 4,
      page_size: 20,
    });
  } finally {
    await app.close();
  }
});

test("旧图片或视频筛选值会交给服务端明确拒绝，不会伪造媒体类型", async () => {
  const calls: unknown[] = [];
  const app = await createApp(calls);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/consumption/records?task_type=image",
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().code, "ledger_media_kind_unavailable");
    assert.match(response.json().message, /不能按图片或视频筛选/);
    assert.doesNotMatch(response.json().message, /generation|ai_assist/);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

test("项目成本沿用 ProjectAccess 的 404/403 语义", async () => {
  const nonMember = await createAccessErrorApp(new NotFoundError("项目不存在或你没有访问权限"));
  const viewer = await createAccessErrorApp(new ForbiddenError("你没有在该项目中执行此操作的权限"));
  try {
    const hidden = await nonMember.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/consumption/records`,
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.equal(hidden.json().code, "not_found");

    const denied = await viewer.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/consumption/records`,
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().code, "forbidden");
  } finally {
    await nonMember.close();
    await viewer.close();
  }
});

async function createAccessErrorApp(error: AppError) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "maker", displayName: "制片" };
  });
  app.setErrorHandler((caught, _request, reply) => {
    const normalized = caught instanceof AppError
      ? caught
      : new AppError(500, "internal_error", "服务器内部错误");
    return reply.code(normalized.statusCode).send(errorBody(normalized));
  });
  await registerConsumptionRecordRoutes(app, () => ({} as Database), {
    createRepository: () => ({ list: async () => { throw error; }, getSceneConsumptionSummary: async () => { throw error; } }),
  });
  return app;
}
