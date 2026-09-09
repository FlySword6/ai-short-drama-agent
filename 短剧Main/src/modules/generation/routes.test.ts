import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { AppError, errorBody } from "../../shared/errors.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessRecord, ProjectMembershipRole } from "../project-access/types.js";
import { PostgresGenerationRepository } from "./repository.js";
import {
  NEGATIVE_PROMPT_V1,
  SEGMENT_NO_BGM_CONSTRAINT,
  SEGMENT_PROMPT_DEFAULTS_VERSION,
} from "./promptCompiler.js";
import {
  batchEstimateData,
  batchSubmissionData,
  failedGenerationData,
  generationData,
  generationAttemptNotificationData,
  generationCapabilityData,
  generationSource,
  inFlightGenerationData,
  quoteData,
  registerGenerationRoutes,
  requiresManualReview,
  type BatchEstimateItem,
} from "./routes.js";
import type {
  GenerationBatchSubmissionView,
  GenerationFailedView,
  GenerationInFlightView,
  GenerationQuoteView,
  GenerationAttemptNotificationView,
  GenerationReferenceSnapshot,
  GenerationView,
} from "./types.js";
import { ARK_SEEDREAM_5_PRO_MODEL, V01_VIDEO_MODEL } from "./v01Contract.js";

const dummyDb = {} as Database;
const projectId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const quoteId = "33333333-3333-4333-8333-333333333333";

test("已登录用户能读取完整的模型能力目录，未配置项说明原因而不猜测供应商 ID", async () => {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: "user-a", username: "tester", displayName: "测试用户" };
  });
  await registerGenerationRoutes(app, () => dummyDb);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/generation-models" });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as {
      ok: boolean;
      data: { count: number; items: Array<Record<string, unknown>> };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.data.count, 12);
    assert.deepEqual(payload.data.items.map((item) => item.id), [
      "gpt-image-2",
      "nanobanana-2",
      "nanobanana-lite",
      "gemini-image",
      "seedream-5-pro",
      "seedance-2-0",
      "seedance-2-5",
      "minimax-image",
      "minimax-video-h3",
      "minimax-voice",
      "voice-synthesis",
      "happyhorse-1-1",
    ]);
    for (const item of payload.data.items) {
      assert.equal(typeof item.availability, "string");
      assert.equal(typeof item.media_kind, "string");
      if (item.availability === "unconfigured") {
        assert.equal(typeof item.unavailable_reason, "string");
        assert.equal("provider_id" in item, false);
        assert.equal("actual_model_id" in item, false);
      }
    }
  } finally {
    await app.close();
  }
});

test("已配置模型目录仍只返回产品能力，不暴露 provider 或实际模型 ID", () => {
  const projected = generationCapabilityData({
    id: "minimax-video-h3",
    displayName: "MiniMax H3 视频",
    mediaKind: "video",
    availability: "available",
    providerId: "minimax",
    actualModelId: "MiniMax-H3",
  });
  assert.deepEqual(projected, {
    id: "minimax-video-h3",
    displayName: "MiniMax H3 视频",
    mediaKind: "video",
    availability: "available",
  });
  assert.equal("providerId" in projected, false);
  assert.equal("actualModelId" in projected, false);
});

test("所有公共生成投影统一移除 provider 句柄、实际模型和原始错误", () => {
  const forbidden = ["provider_task_id", "model", "pricing_rule_id", "failure_reason"];
  const projected = [
    generationData({
      ...view([]),
      tierId: "vid-tier",
      providerTaskId: "vendor-task-123",
      errorMessage: "ProviderError: private upstream body",
    }),
    inFlightGenerationData({ ...inFlightView(), tierId: "img-tier" }),
    failedGenerationData({ ...failedView(), tierId: "vid-tier" }),
    generationAttemptNotificationData({
      ...notificationView(),
      status: "failed",
      errorMessage: "ProviderError: private upstream body",
    }),
  ];
  for (const item of projected) {
    for (const key of forbidden) assert.equal(key in item, false, `${key} must stay server-only`);
    assert.equal(typeof item.tier_id === "string" || !("tier_id" in item), true);
  }
});

test("报价只在单次金额严格超过阈值时标记人工复核", () => {
  assert.equal(requiresManualReview(500, 500), false);
  assert.equal(requiresManualReview(501, 500), true);
  assert.equal(quoteData(quote(501), 500).requires_manual_review, true);
  assert.equal(quoteData(quote(500), 500).requires_manual_review, false);
  assert.deepEqual(quoteData(quote(500), 500).price_snapshot, {
    tier_id: "img-seedream5-169-2k-1",
    media_kind: "image",
    billing_unit: "image",
    unit_price_fen: 500,
    billable_units: 1,
    estimated_cost_fen: 500,
    full_estimated_cost_fen: 500,
    production_mode: "full",
    price_multiplier_bps: 10_000,
    discount_numerator: 1,
    discount_denominator: 1,
    currency: "CNY",
  });
});

test("报价来源只取已认证凭据，header 与 body 自报不能伪造", () => {
  const request = {
    headers: { "x-shortdrama-client": "web" },
    body: { source: "assistant" },
    authContext: {
      user: { id: "user-a", username: "test", displayName: "测试用户", role: "member" },
      credential: {
        sessionId: "55555555-5555-4555-8555-555555555555",
        source: "agent",
        actorKind: "agent",
        agentType: "shortdrama-agent",
        userAgent: "spoof-test",
        expiresAt: new Date("2027-08-03T00:00:00.000Z"),
      },
    },
  } as unknown as Parameters<typeof generationSource>[0];
  assert.equal(generationSource(request), "agent");
});

test("A5 模式透明化:报价与任务响应回带参考模式与参考清单快照", () => {
  const quoted = quoteData({
    ...quote(100),
    normalizedRequest: {
      referenceAssetSnapshots: [
        { kind: "image", url: "https://assets.test/prop.png", role: "reference_image", mediaId: "m-1" },
        { kind: "video", url: "https://assets.test/action.mp4", role: "reference_video" },
      ],
    },
  });
  assert.equal(quoted.reference_mode, "multimodal_reference");
  assert.deepEqual(quoted.reference_manifest, [
    { media_id: "m-1", kind: "image", role: "reference_image" },
    { media_id: null, kind: "video", role: "reference_video" },
  ]);

  const anchored = generationData(view([
    { kind: "image", url: "https://assets.test/first.png", role: "first_frame", mediaId: "m-2" },
  ]));
  assert.equal(anchored.reference_mode, "anchor_frames");
  assert.deepEqual(anchored.reference_manifest, [
    { media_id: "m-2", kind: "image", role: "first_frame" },
  ]);
  assert.equal(anchored.project_id, projectId);
  assert.equal(anchored.episode_id, "66666666-6666-4666-8666-666666666666");
  assert.equal(anchored.shot_id, "77777777-7777-4777-8777-777777777777");
  assert.equal(generationData(view([])).reference_mode, "text_only");
  assert.equal(quoteData(quote(100)).reference_mode, "text_only");
});

test("G3:任务详情回显冻结提示词，项目特征词可核验", () => {
  const featureWords = "港风黑帮、霓虹夜景、胶片颗粒";
  const projected = generationData({
    ...view([]),
    prompt: `片段内容：角色在雨夜回头\n图片风格：${featureWords}`,
    parameters: {
      size: "768x1366",
      ratio: "9:16",
      watermark: false,
      sequentialImageGeneration: "disabled",
    },
  });

  assert.match(String(projected.prompt), new RegExp(featureWords));
  assert.deepEqual(projected.parameters, {
    size: "768x1366",
    ratio: "9:16",
    watermark: false,
    sequentialImageGeneration: "disabled",
  });
});

test("批量估价保持清单顺序，聚合总额且永远不表示已创建任务", () => {
  const response = batchEstimateData([
    availableItem("shot-02", 200),
    {
      itemId: "shot-03",
      availability: "invalid",
      error: {
        code: "invalid_request",
        message: "该清单项内容不正确",
        retryable: false,
        status_code: 400,
        details: null,
      },
    },
    availableItem("shot-01", 301),
  ], "sample", 500);
  assert.deepEqual(response.items.map((item) => item.itemId), ["shot-02", "shot-03", "shot-01"]);
  assert.equal(response.production_mode, "sample");
  assert.equal(response.price_multiplier_bps, 6_000);
  assert.equal(response.available_count, 2);
  assert.equal(response.unavailable_count, 1);
  assert.equal(response.total_estimated_cost_fen, 501);
  assert.equal(response.requires_manual_review, true);
  assert.equal(response.creates_generation_tasks, false);
});

test("批量估价会在单项触发复核时保留该信号，即使总额尚未超过阈值", () => {
  const response = batchEstimateData([availableItem("shot-01", 501)], "full", 500);
  assert.equal(response.production_mode, "full");
  assert.equal(response.price_multiplier_bps, 10_000);
  assert.equal(response.requires_manual_review, true);
});

test("批量提交回执保留一次授权总价、逐项结果和现有队列信息", () => {
  const data = batchSubmissionData(batchSubmissionView());
  assert.equal(data.authorization_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(data.production_mode, "sample");
  assert.equal(data.price_multiplier_bps, 6_000);
  assert.equal(data.authorized_total_estimated_cost_fen, 300);
  assert.equal(data.submitted_total_estimated_cost_fen, 100);
  assert.equal(data.status, "partial");
  assert.equal(data.created_count, 1);
  assert.equal(data.failed_count, 1);
  const items = data.items as Array<Record<string, unknown>>;
  assert.deepEqual(items[0], {
    item_id: "shot-01",
    generation_quote_id: quoteId,
    estimated_cost_fen: 100,
    status: "created",
    generation_request_id: requestId,
    generation_attempt_id: "44444444-4444-4444-8444-444444444444",
    queue_position: 2,
    estimated_duration_seconds: 45,
  });
  assert.deepEqual(items[1]?.error, {
    code: "GENERATION_QUOTE_EXPIRED",
    message: "报价已超过有效期，请重新估价",
    retryable: true,
    status_code: 409,
    details: null,
  });
  assert.match(String(data.notice), /重新估价/);
});

test("批量确认只冻结一份清单，重复 item 或 quote 在到达仓储前被拒绝", async () => {
  const calls: unknown[] = [];
  const repository = {
    createBatchAuthorization: async (input: unknown) => {
      calls.push(input);
      return { ...batchSubmissionView(), status: "confirmed", createdCount: 0, failedCount: 0 };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp(
    { id: "user-editor", role: "member" },
    "editor",
    repository,
    () => undefined,
    "cli",
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-confirm",
      headers: { "x-shortdrama-client": "web" },
      payload: {
        project_id: projectId,
        client_idempotency_key: "batch-key-123",
        expected_total_estimated_cost_fen: 300,
        items: [
          { item_id: "shot-01", generation_quote_id: quoteId },
          { item_id: "shot-02", generation_quote_id: "44444444-4444-4444-8444-444444444444" },
        ],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(calls.length, 1);
    const submitted = calls[0] as {
      actorId: string;
      authorizedProjectId?: string;
      source: string;
      listHash: string;
      batch: Record<string, unknown>;
    };
    assert.equal(submitted.actorId, "user-editor");
    assert.equal(submitted.authorizedProjectId, projectId);
    assert.equal(submitted.source, "cli");
    assert.match(submitted.listHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(submitted.batch, {
      projectId,
      clientIdempotencyKey: "batch-key-123",
      expectedTotalEstimatedCostFen: 300,
      productionMode: "full",
      items: [
        { itemId: "shot-01", quoteId },
        { itemId: "shot-02", quoteId: "44444444-4444-4444-8444-444444444444" },
      ],
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-confirm",
      payload: {
        project_id: projectId,
        client_idempotency_key: "batch-key-456",
        expected_total_estimated_cost_fen: 100,
        items: [
          { item_id: "shot-01", generation_quote_id: quoteId },
          { item_id: "shot-01", generation_quote_id: quoteId },
        ],
      },
    });
    assert.equal(duplicate.statusCode, 400, duplicate.body);
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
  }
});

test("批量确认不触发付费门禁，authorization submit 才复用付费就绪门禁", async () => {
  let confirmationCalls = 0;
  let submissionCalls = 0;
  const repository = {
    createBatchAuthorization: async () => {
      confirmationCalls += 1;
      return { ...batchSubmissionView(), status: "confirmed", createdCount: 0, failedCount: 0 };
    },
    findBatchAuthorizationProjectId: async () => projectId,
    submitBatchAuthorization: async () => {
      submissionCalls += 1;
      return batchSubmissionView();
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp(
    { id: "user-editor", role: "member" },
    "editor",
    repository,
    () => {
      throw new AppError(403, "paid_generation_disabled", "真实生成尚未开启，不会产生付费调用");
    },
  );
  try {
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-confirm",
      payload: {
        project_id: projectId,
        client_idempotency_key: "batch-key-disabled",
        expected_total_estimated_cost_fen: 100,
        items: [{ item_id: "shot-01", generation_quote_id: quoteId }],
      },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmationCalls, 1);

    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/generation-batches/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/submit",
    });
    assert.equal(submitted.statusCode, 403, submitted.body);
    assert.equal(submitted.json().error.code, "paid_generation_disabled");
    assert.equal(submissionCalls, 0);
  } finally {
    await app.close();
  }
});

test("旧 batch-submit 合同明确退役，避免客户端把确认与付费提交重新合并", async () => {
  const app = await createAuthorizationApp(
    { id: "user-editor", role: "member" },
    "editor",
    {} as PostgresGenerationRepository,
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-submit",
      payload: {},
    });
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().error.code, "batch_submit_contract_retired");
    assert.match(response.json().error.message, /确认和提交两步/);
  } finally {
    await app.close();
  }
});

test("批量估价在读取清单前要求登录，不会触碰数据库或模型", async () => {
  const app = Fastify({ logger: false });
  await registerGenerationRoutes(app, () => {
    throw new Error("未登录请求不应初始化数据库");
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-estimate",
      payload: { items: [] },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("样片批量估价逐项拒绝非视频，并返回冻结的模式与倍率", async () => {
  const app = await createAuthorizationApp(
    { id: "user-editor", role: "member" },
    "editor",
    {} as PostgresGenerationRepository,
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-estimate",
      payload: {
        production_mode: "sample",
        items: [{ item_id: "image-row", ...generationPayload() }],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.production_mode, "sample");
    assert.equal(response.json().data.price_multiplier_bps, 6_000);
    assert.equal(response.json().data.available_count, 0);
    assert.equal(response.json().data.items[0].error.code, "sample_mode_video_only");
    assert.match(response.json().data.items[0].error.message, /样片模式仅支持视频/);
  } finally {
    await app.close();
  }
});

test("样片模式只在批量面开放，普通估价和提交显式拒绝 production_mode", async () => {
  const app = await createAuthorizationApp(
    { id: "user-editor", role: "member" },
    "editor",
    {} as PostgresGenerationRepository,
  );
  try {
    for (const url of ["/api/v1/generations/estimate", "/api/v1/generations"]) {
      const response = await app.inject({
        method: "POST",
        url,
        payload: {
          ...generationPayload(),
          production_mode: "sample",
        },
      });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.json().error.code, "sample_mode_batch_only");
      assert.match(response.json().error.message, /只能在批量估价和批量提交中选择/);
    }
  } finally {
    await app.close();
  }
});

test("站内终态提醒只按当前用户读取，并要求显式确认后才从未读列表移除", async () => {
  const calls: string[] = [];
  const notification = notificationView();
  const repository = {
    listUnacknowledgedAttemptNotifications: async (actorId: string, limit: number) => {
      calls.push(`list:${actorId}:${limit}`);
      return [notification];
    },
    acknowledgeAttemptNotification: async (actorId: string, notificationId: string) => {
      calls.push(`ack:${actorId}:${notificationId}`);
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-a", role: "member" }, null, repository);
  try {
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/generation-attempt-notifications?limit=1",
    });
    assert.equal(listed.statusCode, 200);
    const expectedNotification = generationAttemptNotificationData(notification);
    assert.deepEqual(listed.json(), {
      ok: true,
      data: {
        count: 1,
        items: [{
          ...expectedNotification,
          created_at: notification.createdAt.toISOString(),
        }],
      },
    });

    const acknowledged = await app.inject({
      method: "POST",
      url: `/api/v1/generation-attempt-notifications/${notification.id}/acknowledge`,
    });
    assert.equal(acknowledged.statusCode, 200);
    assert.deepEqual(acknowledged.json(), {
      ok: true,
      data: { notification_id: notification.id, acknowledged: true },
    });
    assert.deepEqual(calls, [
      "list:user-a:1",
      `ack:user-a:${notification.id}`,
    ]);
  } finally {
    await app.close();
  }
});

test("在途任务端点按当前用户跨项目分页，并保持冻结的 ok/data 信封", async () => {
  const calls: Array<{ actorId: string; page: number; pageSize: number }> = [];
  const item = inFlightView();
  const repository = {
    listInFlightViewsForActor: async (actorId: string, page: number, pageSize: number) => {
      calls.push({ actorId, page, pageSize });
      return { items: [item], page, pageSize, total: 2 };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-admin", role: "admin" }, null, repository);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/generations/in-flight?page=2&page_size=1",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        items: [{
          ...inFlightGenerationData(item),
          created_at: item.createdAt.toISOString(),
          updated_at: item.updatedAt.toISOString(),
        }],
        page: 2,
        page_size: 1,
        total: 2,
        has_more: false,
      },
    });
    assert.equal("phase" in response.json().data.items[0], false, "P4 uses status as the only public state axis");
    assert.deepEqual(calls, [{ actorId: "user-admin", page: 2, pageSize: 1 }]);
  } finally {
    await app.close();
  }
});

test("在途任务端点默认每页 24 条，并在非法 page_size 时不触碰仓储", async () => {
  const calls: Array<{ actorId: string; page: number; pageSize: number }> = [];
  const repository = {
    listInFlightViewsForActor: async (actorId: string, page: number, pageSize: number) => {
      calls.push({ actorId, page, pageSize });
      return { items: [], page, pageSize, total: 0 };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-a", role: "member" }, null, repository);
  try {
    const defaultPage = await app.inject({ method: "GET", url: "/api/v1/generations/in-flight" });
    assert.equal(defaultPage.statusCode, 200, defaultPage.body);
    assert.deepEqual(defaultPage.json(), {
      ok: true,
      data: { items: [], page: 1, page_size: 24, total: 0, has_more: false },
    });
    assert.deepEqual(calls, [{ actorId: "user-a", page: 1, pageSize: 24 }]);

    const invalidPageSize = await app.inject({
      method: "GET",
      url: "/api/v1/generations/in-flight?page_size=51",
    });
    assert.equal(invalidPageSize.statusCode, 400, invalidPageSize.body);
    assert.equal(
      invalidPageSize.json().error.message,
      "请求没能处理：请检查标出的填写内容后重试。",
    );
    assert.equal(calls.length, 1, "invalid pagination must fail before repository access");
  } finally {
    await app.close();
  }
});

test("失败任务端点按当前管理员本人分页，返回队列需要处理区的冻结字段", async () => {
  const calls: Array<{ actorId: string; page: number; pageSize: number }> = [];
  const item = failedView();
  const repository = {
    listFailedViewsForActor: async (actorId: string, page: number, pageSize: number) => {
      calls.push({ actorId, page, pageSize });
      return { items: [item], page, pageSize, total: 2 };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp(
    { id: "user-admin", role: "admin" },
    null,
    repository,
    undefined,
    "agent",
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/generations/failed?page=2&page_size=1",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        items: [{
          generation_request_id: item.requestId,
          current_attempt_id: item.attemptId,
          project_id: item.projectId,
          episode_id: item.episodeId,
          scene_id: item.sceneId,
          shot_id: item.shotId,
          target_asset_entity_id: item.targetAssetEntityId,
          media_kind: "video",
          status: "failed",
          phase: "complete",
          attempt_no: 3,
          tier_id: null,
          retryable: true,
          error_code: "provider_rejected",
          display_reason: "视频生成没成：生成服务暂时没响应，请稍后重试。",
          created_at: item.createdAt.toISOString(),
          finished_at: item.finishedAt?.toISOString(),
          updated_at: item.updatedAt.toISOString(),
        }],
        page: 2,
        page_size: 1,
        total: 2,
        has_more: false,
      },
    });
    assert.deepEqual(calls, [{ actorId: "user-admin", page: 2, pageSize: 1 }]);
    assert.equal(response.json().data.items[0].notification_id, undefined);
    assert.equal(response.json().data.items[0].acknowledged_at, undefined);
  } finally {
    await app.close();
  }
});

test("失败任务端点默认每页 24 条，并在非法 page_size 时不触碰仓储", async () => {
  const calls: Array<{ actorId: string; page: number; pageSize: number }> = [];
  const repository = {
    listFailedViewsForActor: async (actorId: string, page: number, pageSize: number) => {
      calls.push({ actorId, page, pageSize });
      return { items: [], page, pageSize, total: 0 };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-a", role: "member" }, null, repository);
  try {
    const defaultPage = await app.inject({ method: "GET", url: "/api/v1/generations/failed" });
    assert.equal(defaultPage.statusCode, 200, defaultPage.body);
    assert.deepEqual(defaultPage.json(), {
      ok: true,
      data: { items: [], page: 1, page_size: 24, total: 0, has_more: false },
    });
    assert.deepEqual(calls, [{ actorId: "user-a", page: 1, pageSize: 24 }]);

    const invalidPageSize = await app.inject({
      method: "GET",
      url: "/api/v1/generations/failed?page_size=51",
    });
    assert.equal(invalidPageSize.statusCode, 400, invalidPageSize.body);
    assert.equal(
      invalidPageSize.json().error.message,
      "请求没能处理：请检查标出的填写内容后重试。",
    );
    assert.equal(calls.length, 1, "invalid pagination must fail before repository access");
  } finally {
    await app.close();
  }
});

test("非成员、viewer 与 operator 不能借生成估价或提交绕过项目成员权限", async () => {
  const cases: Array<[
    string,
    { id: string; role: "admin" | "operator" | "member" },
    ProjectMembershipRole | null,
    number,
  ]> = [
    ["非成员", { id: "user-nonmember", role: "member" as const }, null, 404],
    ["viewer", { id: "user-viewer", role: "member" as const }, "viewer" as const, 403],
    ["operator", { id: "user-operator", role: "operator" as const }, null, 403],
  ];
  for (const [label, actor, membership, expectedStatus] of cases) {
    const app = await createAuthorizationApp(actor, membership);
    try {
      const estimate = await app.inject({
        method: "POST",
        url: "/api/v1/generations/estimate",
        payload: generationPayload(),
      });
      assert.equal(estimate.statusCode, expectedStatus, `${label} estimate`);

      const submit = await app.inject({
        method: "POST",
        url: "/api/v1/generations",
        payload: { ...generationPayload(), generation_quote_id: quoteId },
      });
      assert.equal(submit.statusCode, expectedStatus, `${label} submit`);

      const batchConfirm = await app.inject({
        method: "POST",
        url: "/api/v1/generations/batch-confirm",
        payload: {
          project_id: projectId,
          client_idempotency_key: "batch-key-permission",
          expected_total_estimated_cost_fen: 100,
          items: [{ item_id: "shot-01", generation_quote_id: quoteId }],
        },
      });
      assert.equal(batchConfirm.statusCode, expectedStatus, `${label} batch confirm`);
    } finally {
      await app.close();
    }
  }
});

test("项目成员校验覆盖重试报价、报价确认与取消，且在付费就绪检查前执行", async () => {
  const calls: string[] = [];
  const repository = {
    findProjectIdForRequest: async (id: string) => {
      calls.push(`request:${id}`);
      return projectId;
    },
    findProjectIdForQuote: async (id: string) => {
      calls.push(`quote:${id}`);
      return projectId;
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp(
    { id: "user-viewer", role: "member" },
    "viewer",
    repository,
  );
  try {
    const retryQuote = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { action: "retry", original_request_id: requestId },
    });
    assert.equal(retryQuote.statusCode, 403);

    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/generation-quotes/${quoteId}/confirm`,
    });
    assert.equal(confirm.statusCode, 403);

    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/generations/${requestId}/retry`,
      payload: { generation_quote_id: quoteId, client_idempotency_key: "retry-key-123" },
    });
    assert.equal(retry.statusCode, 403);

    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/generations/${requestId}/cancel`,
    });
    assert.equal(cancel.statusCode, 403);
    assert.deepEqual(calls, [
      `request:${requestId}`,
      `quote:${quoteId}`,
      `request:${requestId}`,
      `request:${requestId}`,
    ]);
  } finally {
    await app.close();
  }
});

test("admin 与 operator 可读取项目生成状态，但只有 admin 获得创作权限", async () => {
  const reads: Array<{ actorId: string; projectId: string; authorizedProjectId?: string }> = [];
  const repository = {
    listViewsForProject: async (actorId: string, requestedProjectId: string, authorizedProjectId?: string) => {
      reads.push({ actorId, projectId: requestedProjectId, authorizedProjectId });
      return [];
    },
  } as unknown as PostgresGenerationRepository;
  for (const actor of [
    { id: "user-admin", role: "admin" as const },
    { id: "user-operator", role: "operator" as const },
  ]) {
    const app = await createAuthorizationApp(actor, null, repository);
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/generations` });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.count, 0);
    } finally {
      await app.close();
    }
  }
  assert.deepEqual(reads, [
    { actorId: "user-admin", projectId, authorizedProjectId: projectId },
    { actorId: "user-operator", projectId, authorizedProjectId: projectId },
  ]);
});

test("编辑者估价时把已授权项目范围传给控制资产快照解析，不放开全局个人资产", async () => {
  const calls: unknown[] = [];
  const repository = {
    resolveActiveTier: async () => ({
      tierId: "image-tier",
      rule: {
        id: "tier-rule",
        provider: "ark",
        model: ARK_SEEDREAM_5_PRO_MODEL,
        mediaKind: "image",
        billingUnit: "image",
        unitPriceFen: 1,
        metadata: {},
      },
      parameters: {},
      quantity: 1,
    }),
    resolveControlReferenceSnapshots: async (
      _actorId: string,
      _mediaKind: string,
      _input: unknown,
      options: unknown,
    ) => {
      calls.push(options);
      return [];
    },
    createSubmissionQuote: async () => quote(1),
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp(
    { id: "user-editor", role: "member" },
    "editor",
    repository,
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: {
        ...generationPayload(),
        reference_media_ids: ["44444444-4444-4444-8444-444444444444"],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, [{
      useRegisteredSeedanceAssetUris: false,
      enforceReferenceImageDimensions: false,
      authorizedProjectId: projectId,
    }]);
  } finally {
    await app.close();
  }
});

test("两段式提示词:supplement_prompt 触发服务端编译,报价回带自动段与模板版本", async () => {
  const contexts: unknown[] = [];
  const submissions: Array<Record<string, unknown>> = [];
  const repository = {
    resolveActiveTier: async () => estimateTier(),
    resolveControlReferenceSnapshots: async () => [],
    resolvePromptCompilationContext: async (input: unknown) => {
      contexts.push(input);
      return {
        sceneDescription: "深夜的御书房",
        shotIntent: "中景推近,皇帝独坐沉思",
        scriptText: "朕绝不退让。",
      };
    },
    createSubmissionQuote: async (input: { request: Record<string, unknown> }) => {
      submissions.push(input.request);
      return { ...quote(1), normalizedRequest: input.request };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const payload: Record<string, unknown> = { ...generationPayload() };
    delete payload.prompt;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { ...payload, supplement_prompt: "画面加一缕月光" },
    });
    assert.equal(response.statusCode, 200, response.body);
    const expectedAuto = `场景:深夜的御书房。镜头意图:中景推近,皇帝独坐沉思。台词:“朕绝不退让。”。${NEGATIVE_PROMPT_V1}`;
    const data = response.json().data;
    assert.equal(data.compiled_prompt, expectedAuto);
    assert.equal(data.prompt_template_version, "v3");
    assert.deepEqual(contexts, [{
      projectId,
      shotId: "44444444-4444-4444-8444-444444444444",
      referenceMediaIds: [],
      mediaKind: "image",
    }]);
    assert.equal(submissions[0]?.prompt, `${expectedAuto}\n画面加一缕月光`);
    assert.deepEqual(submissions[0]?.promptCompilation, {
      version: "v3",
      autoPrompt: expectedAuto,
      supplementPrompt: "画面加一缕月光",
      projectStyleApplied: false,
      projectStyleReferenceMediaIds: [],
      promptTemplateSource: "platform_default",
    });
  } finally {
    await app.close();
  }
});

test("项目风格描述与参考图自动进入报价快照，单次可明确取消", async () => {
  const styleMediaId = "99999999-9999-4999-8999-999999999999";
  const referenceInputs: unknown[] = [];
  const submissions: Array<Record<string, unknown>> = [];
  const repository = {
    resolveActiveTier: async () => estimateTier(),
    resolveProjectGenerationConfig: async () => ({
      styleDescription: "港风黑帮、霓虹夜景、胶片颗粒",
      styleReferenceMediaIds: [styleMediaId],
      promptTemplate: "片段内容：{{segment_content}}\n风格：{{style_description}}",
      promptTemplateSource: "project" as const,
    }),
    resolveControlReferenceSnapshots: async (
      _actorId: string,
      _mediaKind: string,
      input: { referenceMediaIds: string[] },
    ) => {
      referenceInputs.push(input);
      return input.referenceMediaIds.map((mediaId) => ({
        kind: "image" as const,
        url: `https://assets.test/${mediaId}.png`,
        mediaId,
      }));
    },
    resolvePromptCompilationContext: async (input: Record<string, unknown>) => ({
      shotIntent: "角色在雨夜回头",
      styleDescription: input.styleDescription,
      promptTemplate: input.promptTemplate,
      mediaKind: input.mediaKind,
    }),
    createSubmissionQuote: async (input: { request: Record<string, unknown> }) => {
      submissions.push(input.request);
      return { ...quote(1), normalizedRequest: input.request };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const payload: Record<string, unknown> = { ...generationPayload() };
    delete payload.prompt;
    const applied = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload,
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const data = applied.json().data;
    assert.match(data.compiled_prompt, /港风黑帮、霓虹夜景、胶片颗粒/);
    assert.equal(data.project_style_applied, true);
    assert.deepEqual(data.project_style_reference_media_ids, [styleMediaId]);
    assert.equal(data.prompt_template_source, "project");
    assert.deepEqual(referenceInputs[0], { referenceMediaIds: [styleMediaId] });
    assert.deepEqual(submissions[0]?.referenceMediaIds, [styleMediaId]);
    assert.match(String(submissions[0]?.prompt), /港风黑帮、霓虹夜景、胶片颗粒/);

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { ...payload, use_project_style: false },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.deepEqual(referenceInputs[1], { referenceMediaIds: [] });
    assert.doesNotMatch(String(submissions[1]?.prompt), /港风黑帮/);
  } finally {
    await app.close();
  }
});

test("T10.14 分镜参考快照的变体主图并入参考清单，无 shot_id 不触发解析", async () => {
  const variantPrimaryMediaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const variantResolveCalls: Array<{ shotId: string }> = [];
  const referenceInputs: unknown[] = [];
  const submissions: Array<Record<string, unknown>> = [];
  const repository = {
    resolveActiveTier: async () => estimateTier(),
    resolveProjectGenerationConfig: async () => ({
      styleReferenceMediaIds: [],
      promptTemplateSource: "platform_default" as const,
    }),
    resolveShotAssetVariantReferences: async (input: { shotId: string }) => {
      variantResolveCalls.push(input);
      return [variantPrimaryMediaId];
    },
    resolveControlReferenceSnapshots: async (
      _actorId: string,
      _mediaKind: string,
      input: { referenceMediaIds: string[] },
    ) => {
      referenceInputs.push(input);
      return input.referenceMediaIds.map((mediaId) => ({
        kind: "image" as const,
        url: `https://assets.test/${mediaId}.png`,
        mediaId,
      }));
    },
    createSubmissionQuote: async (input: { request: Record<string, unknown> }) => {
      submissions.push(input.request);
      return { ...quote(1), normalizedRequest: input.request };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { ...generationPayload() },
    });
    assert.equal(response.statusCode, 200, response.body);
    // 服务端按 shot_id 解析变体主图并并入参考清单,resolveControlReferenceSnapshots 拿到合并后清单。
    assert.deepEqual(variantResolveCalls, [{ shotId: generationPayload().shot_id }]);
    assert.deepEqual(referenceInputs[0], { referenceMediaIds: [variantPrimaryMediaId] });
    assert.deepEqual(submissions[0]?.referenceMediaIds, [variantPrimaryMediaId]);

    // 无 shot_id(改用 target_asset_entity_id 满足校验):不触发变体参考解析,参考清单保持为空。
    const noShot = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { ...generationPayload(), shot_id: undefined, target_asset_entity_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    });
    assert.equal(noShot.statusCode, 200, noShot.body);
    assert.equal(variantResolveCalls.length, 1, "无 shot_id 时不得调用变体参考解析");
    assert.deepEqual(referenceInputs[1], { referenceMediaIds: [] });
    assert.deepEqual(submissions[1]?.referenceMediaIds, []);
  } finally {
    await app.close();
  }
});

test("项目画幅与图片清晰度进入生成，单次覆盖解析到另一计费档且不回写项目", async () => {
  const projectConfig = {
    defaultRatio: "9:16",
    defaultImageResolution: "1K",
    defaultVideoResolution: "720p",
    styleReferenceMediaIds: [],
    promptTemplateSource: "platform_default" as const,
  };
  const tiers = [
    imageTier("img-anchor-169-2k", "2048x1152", "16:9", 60),
    imageTier("img-project-default-916-1k", "768x1366", "9:16", 30),
    imageTier("img-single-override-169-1k", "1366x768", "16:9", 30),
  ];
  const submissions: Array<Record<string, unknown>> = [];
  const repository = {
    listActiveTiers: async () => tiers,
    resolveProjectGenerationConfig: async () => projectConfig,
    resolveControlReferenceSnapshots: async () => [],
    createSubmissionQuote: async (input: { request: Record<string, unknown> }) => {
      submissions.push(input.request);
      return {
        ...quote(30),
        normalizedRequest: input.request,
        priceSnapshot: {
          ...quote(30).priceSnapshot,
          tierId: String(input.request.tierId),
        },
      };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const defaultResponse = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: {
        ...generationPayload(),
        tier_id: "img-anchor-169-2k",
        parameters: {},
      },
    });
    assert.equal(defaultResponse.statusCode, 200, defaultResponse.body);
    assert.equal(submissions[0]?.tierId, "img-project-default-916-1k");
    assert.deepEqual(submissions[0]?.parameters, {
      size: "768x1366",
      ratio: "9:16",
      watermark: false,
      sequentialImageGeneration: "disabled",
    });

    const overrideResponse = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: {
        ...generationPayload(),
        tier_id: "img-anchor-169-2k",
        parameters: { resolution: "1K", ratio: "16:9" },
      },
    });
    assert.equal(overrideResponse.statusCode, 200, overrideResponse.body);
    assert.equal(submissions[1]?.tierId, "img-single-override-169-1k");
    assert.deepEqual(submissions[1]?.parameters, {
      size: "1366x768",
      ratio: "16:9",
      watermark: false,
      sequentialImageGeneration: "disabled",
    });
    assert.deepEqual(projectConfig, {
      defaultRatio: "9:16",
      defaultImageResolution: "1K",
      defaultVideoResolution: "720p",
      styleReferenceMediaIds: [],
      promptTemplateSource: "platform_default",
    });
  } finally {
    await app.close();
  }
});

test("R144:段落视频报价在服务端剥离时间码并固化只音效不 BGM 默认", async () => {
  const submissions: Array<Record<string, unknown>> = [];
  const repository = {
    resolveActiveTier: async () => videoEstimateTier(),
    resolveControlReferenceSnapshots: async () => [],
    createSubmissionQuote: async (input: { request: Record<string, unknown> }) => {
      submissions.push(input.request);
      return { ...quote(4), normalizedRequest: input.request };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: {
        ...generationPayload(),
        media_kind: "video",
        tier_id: "video-tier",
        scene_id: "55555555-5555-4555-8555-555555555555",
        prompt: "镜头1 [00:00.000-00:04.000] 人物转身\n晚上 20:30 集合",
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json().data;
    assert.equal(data.compiled_prompt, SEGMENT_NO_BGM_CONSTRAINT);
    assert.equal(data.prompt_template_version, SEGMENT_PROMPT_DEFAULTS_VERSION);
    assert.equal(
      submissions[0]?.prompt,
      `${SEGMENT_NO_BGM_CONSTRAINT}\n镜头1 人物转身\n晚上 20:30 集合`,
    );
    assert.deepEqual(submissions[0]?.promptCompilation, {
      version: SEGMENT_PROMPT_DEFAULTS_VERSION,
      autoPrompt: SEGMENT_NO_BGM_CONSTRAINT,
      supplementPrompt: "镜头1 人物转身\n晚上 20:30 集合",
    });
  } finally {
    await app.close();
  }
});

test("两段式提示词:prompt 与 supplement_prompt 同发报 422 歧义", async () => {
  const repository = {
    resolveActiveTier: async () => estimateTier(),
    resolveControlReferenceSnapshots: async () => [],
    resolvePromptCompilationContext: async () => {
      throw new Error("歧义请求不得触发编译");
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { ...generationPayload(), supplement_prompt: "画面加一缕月光" },
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.body, /只能二选一/);
  } finally {
    await app.close();
  }
});

test("两段式提示词:两段皆空且结构化真源为空时报 422", async () => {
  const repository = {
    resolveActiveTier: async () => estimateTier(),
    resolveControlReferenceSnapshots: async () => [],
    resolvePromptCompilationContext: async () => ({}),
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const payload: Record<string, unknown> = { ...generationPayload() };
    delete payload.prompt;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload,
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.body, /提示词为空/);
  } finally {
    await app.close();
  }
});

test("传统全人工 prompt 也携带项目风格描述,关闭开关或已含原文则不追加(#170)", async () => {
  const submissions: Array<Record<string, unknown>> = [];
  const repository = {
    resolveActiveTier: async () => estimateTier(),
    resolveProjectGenerationConfig: async () => ({
      styleDescription: "港风黑帮、霓虹夜景、胶片颗粒",
      styleReferenceMediaIds: [],
      promptTemplateSource: "platform_default" as const,
    }),
    resolveControlReferenceSnapshots: async () => [],
    resolvePromptCompilationContext: async () => {
      throw new Error("传统 prompt 模式不得触发编译");
    },
    createSubmissionQuote: async (input: { request: Record<string, unknown> }) => {
      submissions.push(input.request);
      return { ...quote(1), normalizedRequest: input.request };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const applied = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: generationPayload(),
    });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(submissions[0]?.prompt, "权限测试画面\n风格:港风黑帮、霓虹夜景、胶片颗粒");

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { ...generationPayload(), use_project_style: false },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(submissions[1]?.prompt, "权限测试画面");

    const alreadyStyled = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { ...generationPayload(), prompt: "雨夜街头,港风黑帮、霓虹夜景、胶片颗粒" },
    });
    assert.equal(alreadyStyled.statusCode, 200, alreadyStyled.body);
    assert.equal(submissions[2]?.prompt, "雨夜街头,港风黑帮、霓虹夜景、胶片颗粒");
  } finally {
    await app.close();
  }
});

test("两段式提示词:传统全人工 prompt 不触发编译,报价回带 null", async () => {
  const repository = {
    resolveActiveTier: async () => estimateTier(),
    resolveControlReferenceSnapshots: async () => [],
    resolvePromptCompilationContext: async () => {
      throw new Error("传统 prompt 模式不得触发编译");
    },
    createSubmissionQuote: async () => quote(1),
  } as unknown as PostgresGenerationRepository;
  const app = await createAuthorizationApp({ id: "user-editor", role: "member" }, "editor", repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: generationPayload(),
    });
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json().data;
    assert.equal(data.compiled_prompt, null);
    assert.equal(data.prompt_template_version, null);
  } finally {
    await app.close();
  }
});

function estimateTier() {
  return {
    tierId: "image-tier",
    rule: {
      id: "tier-rule",
      provider: "ark",
      model: ARK_SEEDREAM_5_PRO_MODEL,
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 1,
      metadata: {},
    },
    parameters: {},
    quantity: 1,
  };
}

function videoEstimateTier() {
  return {
    tierId: "video-tier",
    rule: {
      id: "video-tier-rule",
      provider: "ark",
      model: V01_VIDEO_MODEL,
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 1,
      metadata: {},
    },
    parameters: {
      resolution: "720p",
      ratio: "9:16",
      durationSeconds: 4,
      generateAudio: true,
    },
    quantity: 1,
  };
}

function imageTier(
  tierId: string,
  size: string,
  ratio: string,
  unitPriceFen: number,
) {
  return {
    tierId,
    rule: {
      id: `${tierId}-rule`,
      provider: "ark",
      model: ARK_SEEDREAM_5_PRO_MODEL,
      mediaKind: "image" as const,
      billingUnit: "image" as const,
      unitPriceFen,
      metadata: {},
    },
    parameters: {
      size,
      ratio,
      watermark: false,
      sequentialImageGeneration: "disabled" as const,
    },
    quantity: 1,
  };
}

async function createAuthorizationApp(
  actor: { id: string; role: "admin" | "operator" | "member" },
  membership: ProjectMembershipRole | null,
  repository: PostgresGenerationRepository = {} as PostgresGenerationRepository,
  requireSubmissionReady?: () => void,
  credentialSource: "web" | "cli" | "agent" = "web",
) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actor.id, username: actor.id, displayName: actor.id, role: actor.role };
    request.authSessionId = "55555555-5555-4555-8555-555555555555";
    request.authContext = {
      user: request.authUser,
      credential: {
        sessionId: request.authSessionId,
        source: credentialSource,
        actorKind: credentialSource === "agent" ? "agent" : "human",
        agentType: credentialSource === "agent" ? "shortdrama-agent" : null,
        userAgent: null,
        expiresAt: new Date("2027-08-03T00:00:00.000Z"),
      },
    };
  });
  const access = new ProjectAccessService({
    findAccessRecord: async (_actorId, requestedProjectId): Promise<ProjectAccessRecord | null> => (
      requestedProjectId === projectId
        ? { projectId, ownerUserId: "user-owner", membershipRole: membership }
        : null
    ),
  });
  if (typeof repository.resolveProjectGenerationConfig !== "function") {
    repository.resolveProjectGenerationConfig = async () => ({
      styleReferenceMediaIds: [],
      promptTemplateSource: "platform_default",
    });
  }
  if (typeof repository.resolveShotFinalReference !== "function") {
    /* #164 定稿进视频:契约测试假仓储默认「本镜没有定稿图」=不补参考也不触发 R223 闸门。 */
    repository.resolveShotFinalReference = async () => ({ status: "absent" });
  }
  if (typeof repository.resolveShotAssetVariantReferences !== "function") {
    /* v1.3 T10.14:契约测试假仓储默认「快照无变体参考主图」=不补变体参考。 */
    repository.resolveShotAssetVariantReferences = async () => [];
  }
  await registerGenerationRoutes(app, () => dummyDb, {
    createRepository: () => repository,
    createProjectAccessService: () => access,
    ...(requireSubmissionReady ? { requireSubmissionReady } : {}),
  });
  return app;
}

function generationPayload() {
  return {
    media_kind: "image",
    tier_id: "image-tier",
    project_id: projectId,
    shot_id: "44444444-4444-4444-8444-444444444444",
    prompt: "权限测试画面",
    parameters: {},
    client_idempotency_key: "generation-key-123",
  };
}

function availableItem(itemId: string, estimatedCostFen: number): BatchEstimateItem {
  return {
    itemId,
    availability: "available",
    tierId: "image-tier",
    parameterSummary: { size: "2K" },
    quote: quoteData(quote(estimatedCostFen)),
  };
}

function view(referenceAssetSnapshots: GenerationReferenceSnapshot[]): GenerationView {
  const now = new Date("2026-07-20T00:00:00.000Z");
  return {
    requestId,
    attemptId: "44444444-4444-4444-8444-444444444444",
    projectId,
    episodeId: "66666666-6666-4666-8666-666666666666",
    shotId: "77777777-7777-4777-8777-777777777777",
    status: "succeeded",
    phase: "complete",
    mediaKind: "video",
    model: "doubao-seedance-2-0-fast-260128",
    prompt: "测试提示词",
    parameters: {
      resolution: "720p",
      ratio: "9:16",
      durationSeconds: 4,
      watermark: false,
      generateAudio: true,
    },
    estimatedCostFen: 100,
    media: [],
    referenceAssetSnapshots,
    createdAt: now,
    updatedAt: now,
  };
}

function notificationView(): GenerationAttemptNotificationView {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    requestId,
    attemptId: "44444444-4444-4444-8444-444444444444",
    projectId,
    episodeId: "66666666-6666-4666-8666-666666666666",
    shotId: "77777777-7777-4777-8777-777777777777",
    targetAssetEntityId: "88888888-8888-4888-8888-888888888888",
    mediaKind: "video",
    status: "succeeded",
    createdAt: new Date("2026-07-26T00:00:00.000Z"),
  };
}

function inFlightView(): GenerationInFlightView {
  return {
    requestId,
    attemptId: "99999999-9999-4999-8999-999999999999",
    projectId,
    episodeId: "66666666-6666-4666-8666-666666666666",
    shotId: "77777777-7777-4777-8777-777777777777",
    targetAssetEntityId: "88888888-8888-4888-8888-888888888888",
    mediaKind: "image",
    status: "pending",
    attemptNo: 2,
    model: "seedream-test",
    queuePosition: 3,
    estimatedDurationSeconds: null,
    estimatedDurationSampleCount: 4,
    createdAt: new Date("2026-08-01T11:00:00.000Z"),
    updatedAt: new Date("2026-08-01T11:00:03.000Z"),
  };
}

function failedView(): GenerationFailedView {
  return {
    requestId,
    attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectId,
    episodeId: "66666666-6666-4666-8666-666666666666",
    sceneId: "77777777-7777-4777-8777-777777777777",
    shotId: "88888888-8888-4888-8888-888888888888",
    targetAssetEntityId: "99999999-9999-4999-8999-999999999999",
    mediaKind: "video",
    status: "failed",
    phase: "complete",
    attemptNo: 3,
    model: "seedance-test",
    retryable: true,
    errorCode: "provider_rejected",
    errorMessage: "ProviderError: Ark request failed with HTTP 503",
    createdAt: new Date("2026-08-01T11:00:00.000Z"),
    finishedAt: new Date("2026-08-01T11:01:00.000Z"),
    updatedAt: new Date("2026-08-01T11:01:00.000Z"),
  };
}

function batchSubmissionView(): GenerationBatchSubmissionView {
  const now = new Date("2026-07-26T12:00:00.000Z");
  return {
    authorizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "user-editor",
    projectId,
    clientIdempotencyKey: "batch-key-123",
    listHash: "a".repeat(64),
    productionMode: "sample",
    status: "partial",
    authorizedTotalEstimatedCostFen: 300,
    submittedTotalEstimatedCostFen: 100,
    currency: "CNY",
    createdCount: 1,
    failedCount: 1,
    authorizedAt: now,
    idempotentReplay: false,
    items: [
      {
        itemId: "shot-01",
        quoteId,
        estimatedCostFen: 100,
        status: "created",
        generationRequestId: requestId,
        generationAttemptId: "44444444-4444-4444-8444-444444444444",
        queuePosition: 2,
        estimatedDurationSeconds: 45,
      },
      {
        itemId: "shot-02",
        quoteId: "44444444-4444-4444-8444-444444444444",
        estimatedCostFen: 200,
        status: "expired",
        error: {
          code: "GENERATION_QUOTE_EXPIRED",
          message: "报价已超过有效期，请重新估价",
          retryable: true,
          statusCode: 409,
          details: null,
        },
      },
    ],
  };
}

function quote(estimatedCostFen: number): GenerationQuoteView {
  const now = new Date("2026-07-20T00:00:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "user-a",
    source: "web",
    action: "submit",
    requestHash: "request-hash",
    normalizedRequest: {},
    pricingRuleId: "22222222-2222-4222-8222-222222222222",
    priceSnapshot: {
      tierId: "img-seedream5-169-2k-1",
      pricingRuleId: "22222222-2222-4222-8222-222222222222",
      provider: "configured-provider",
      model: "configured-model",
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: estimatedCostFen,
      billableUnits: 1,
      estimatedCostFen,
      fullEstimatedCostFen: estimatedCostFen,
      productionMode: "full",
      priceMultiplierBps: 10_000,
      discountNumerator: 1,
      discountDenominator: 1,
      currency: "CNY",
    },
    estimatedCostFen,
    status: "pending_confirmation",
    expiresAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
