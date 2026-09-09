/* ============================================================
   generation-contract.test.ts — R3「Lite 请求体契约快照测试」（AGENTS.md §4.1 R3）

   红线原文：「Lite 拼出的 /generations/estimate、/generations 请求体必须能通过
   后端 zod 校验。后端改 schema，Lite 侧测试立即失败。」本文件就是那个进 CI 的
   契约层：把 Lite 前端真实拼出的 wire 体原样打进 Fastify 路由（app.inject），
   断言 ① zod 不 400；② 路由归一化后交给仓储的输入与内联快照逐键一致
   （deepStrictEqual，键集合也锁）；③ 两条互斥语义（prompt/supplement_prompt、
   references/reference_media_ids）对 Lite 体保持 422。

   wire 体真源（前端改动必须同步改这里，防两端漂移）：
   - lite-shots-page.tsx:671-694 —— LiteSubmissionInput 构造 + quoteGeneration→
     createGeneration 两段调用（只发 supplement_prompt 不发 prompt；视频发
     references:[{ media_id, usage_mode:"first_frame" }]；quantity/参数整档透传）。
   - api.ts:1341-1346 —— quoteGeneration 在 wire 上追加 action:"submit"/source:"web"。
   - api.ts:1381-1388 —— createGeneration 在 wire 上追加 generation_quote_id
     （不发 action/source、不发 cost_confirmed）。
   - capability-tiers.ts:100-122 —— tierSubmitInput 整档透传：图片恒带 ratio
     （缺省 "16:9"）+ size；视频恒带 ratio/resolution/duration_seconds；档声明的
     额外键（如 watermark）随 ...rest 透传。任务书口径 image parameters 记为
     { size }，现行 wire 真实形构是 { ratio, size }（FALLBACK_IMAGE_TIER 档），
     本快照按 wire 实形锁定。

   fake 边界（任务书第 4 条）：
   - 档清单内容是 fake 的（listActiveTiers 返回单档数组）；但档全等校验 fake 不掉——
     主线 FABLE-007 把 requireTierMatchesInput 内联进路由（requireEffectiveProjectTier
     的 matchedTier：model/quantity/归一化参数必须与某 active 档完全一致），且图片模型
     也要能力登记（requireImageCapability）。所以假档的 model 必须是合同已登记模型、
     parameters 必须等于 normalizeV01Parameters 的归一化产物（探针实测值，非手推）。
   - V0.1 归一化（v01Contract.normalizeV01Parameters）在 service 层是真代码，
     fake 躲不开也不躲：视频假档的 model/parameters 必须等于合同常量
     （V01_VIDEO_MODEL/720p/9:16/4s），图片 size 必须 2K（归一为像素 2048x1152）——
     这是合同常量，改动它们本来就该触发 Lite 复核。
   - 真付费链路绝不进测试（§4 付费红线）：requireSubmissionReady 用路由既有
     注入缝替成 no-op；repository 全 fake，createSubmission 只捕获入参返回
     内存 view，不落库、不触达供应商。
   - 提示词编译上下文（resolvePromptCompilationContext）返回 {}：自动段为空时
     prompt 恒等于 supplement_prompt，快照只反映 Lite 体，不耦合负面词表内容
     （非空编译路径已由 ../generation/routes.test.ts 两段式用例覆盖）。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { errorBody } from "../../shared/errors.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessRecord } from "../project-access/types.js";
import type { PostgresGenerationRepository } from "../generation/repository.js";
import { registerGenerationRoutes } from "../generation/routes.js";
import type { GenerationQuoteView, GenerationView } from "../generation/types.js";

const dummyDb = {} as Database;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SHOT_ID = "44444444-4444-4444-8444-444444444444";
const QUOTE_ID = "33333333-3333-4333-8333-333333333333";
const FIRST_FRAME_MEDIA_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";

/** 现行 V0.1 合同档（scripts/seed-pricing-tiers.mts + 前端 FALLBACK_TIERS）。 */
const LITE_IMAGE_TIER_ID = "img-seedream5pro-169-2k-1";
const LITE_VIDEO_TIER_ID = "vid-seedance20fast-916-720p-4s";
/** v01Contract.ts V01_VIDEO_MODEL 合同常量；改动它 = 生成合同变更，本测试预期变红。 */
const LITE_VIDEO_MODEL = "doubao-seedance-2-0-fast-260128";
/** FABLE-007 起图片模型也要能力登记（v01Contract.requireImageCapability），
    fake 档必须用合同已登记模型；改用 seedream 5 pro 合同常量。 */
const LITE_IMAGE_MODEL = "doubao-seedream-5-0-pro-260628";

/* ---------- Lite wire 体（与 lite-shots-page.tsx 提交点逐键对齐） ---------- */

/**
 * Lite 图片 estimate 体 = LiteSubmissionInput + api.quoteGeneration 追加的
 * action/source。任务书键集：media_kind/tier_id/project_id/shot_id/
 * supplement_prompt/parameters{size}/quantity 1/client_idempotency_key；
 * parameters 按 wire 实形带 ratio（tierSubmitInput 恒输出）。
 */
function liteImageEstimateBody() {
  return {
    media_kind: "image",
    tier_id: LITE_IMAGE_TIER_ID,
    project_id: PROJECT_ID,
    shot_id: SHOT_ID,
    supplement_prompt: "画面加一缕月光",
    parameters: { ratio: "16:9", size: "2K" },
    quantity: 1,
    client_idempotency_key: "lite-gen-image-0001",
    action: "submit",
    source: "web",
  };
}

/**
 * Lite 视频 submit 体 = LiteSubmissionInput（视频形态：references 首帧锚定）
 * + api.createGeneration 追加的 generation_quote_id。不发 action/source、
 * 不发 cost_confirmed（schema 里 optional literal true，Lite 用不到）。
 */
function liteVideoSubmitBody() {
  return {
    media_kind: "video",
    tier_id: LITE_VIDEO_TIER_ID,
    project_id: PROJECT_ID,
    shot_id: SHOT_ID,
    supplement_prompt: "镜头缓慢推近",
    parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 4 },
    quantity: 1,
    client_idempotency_key: "lite-gen-video-0001",
    references: [{ media_id: FIRST_FRAME_MEDIA_ID, usage_mode: "first_frame" }],
    generation_quote_id: QUOTE_ID,
  };
}

/* ---------- fake 档与视图（只服务形构契约，不代表档可行性结论） ---------- */

/** 假图片档：主线把档全等校验内联进路由（requireEffectiveProjectTier 的 matchedTier
    要求 model/quantity/归一化参数与某 active 档完全一致），所以 parameters 必须就是
    normalizeV01Parameters 的归一化产物（size 2K 会被归一成像素 2048x1152），不再是任意假值。 */
function fakeImageTier() {
  return {
    tierId: LITE_IMAGE_TIER_ID,
    rule: {
      id: "rule-lite-image",
      provider: "ark",
      model: LITE_IMAGE_MODEL,
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 60,
      metadata: {},
    },
    parameters: { size: "2048x1152", ratio: "16:9", watermark: false, sequentialImageGeneration: "disabled" },
    quantity: 1,
  };
}

/** 假视频档：model 必须等于 v01Contract 合同常量；parameters 同上=归一化产物。 */
function fakeVideoTier() {
  return {
    tierId: LITE_VIDEO_TIER_ID,
    rule: {
      id: "rule-lite-video",
      provider: "ark",
      model: LITE_VIDEO_MODEL,
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 80,
      metadata: {},
    },
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4, watermark: false, generateAudio: true },
    quantity: 1,
  };
}

function pendingQuoteView(): GenerationQuoteView {
  const now = new Date("2026-08-07T00:00:00.000Z");
  return {
    id: QUOTE_ID,
    userId: "user-lite",
    source: "web",
    action: "submit",
    requestHash: "lite-contract-request-hash",
    normalizedRequest: {},
    pricingRuleId: "rule-lite-image",
    priceSnapshot: {
      tierId: LITE_IMAGE_TIER_ID,
      pricingRuleId: "rule-lite-image",
        provider: "ark",
        model: LITE_IMAGE_MODEL,
        mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 60,
      billableUnits: 1,
      estimatedCostFen: 60,
      currency: "CNY",
    },
    estimatedCostFen: 60,
    status: "pending_confirmation",
    expiresAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function submittedVideoView(): GenerationView {
  const now = new Date("2026-08-07T00:00:00.000Z");
  return {
    requestId: REQUEST_ID,
    attemptId: ATTEMPT_ID,
    projectId: PROJECT_ID,
    status: "pending",
    phase: "created",
    mediaKind: "video",
    model: LITE_VIDEO_MODEL,
    prompt: "lite 契约测试冻结提示词",
    parameters: {},
    estimatedCostFen: 320,
    media: [],
    referenceAssetSnapshots: [{
      kind: "image",
      url: "https://assets.test/lite-first-frame.png",
      role: "first_frame",
      mediaId: FIRST_FRAME_MEDIA_ID,
    }],
    createdAt: now,
    updatedAt: now,
  };
}

/* ---------- harness（照 ../generation/routes.test.ts 的注入缝） ---------- */

async function createLiteContractApp(repository: PostgresGenerationRepository) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: "user-lite", username: "user-lite", displayName: "Lite 用户", role: "member" };
    /* FABLE-007 起写操作走 agentAccess 门禁，需完整 authContext（human 凭据），
       否则 human_only 路由 401——照主线 createAuthorizationApp 的注入形。 */
    request.authSessionId = "55555555-5555-4555-8555-555555555555";
    request.authContext = {
      user: request.authUser,
      credential: {
        sessionId: request.authSessionId,
        source: "web",
        actorKind: "human",
        agentType: null,
        userAgent: null,
        expiresAt: new Date("2027-08-03T00:00:00.000Z"),
      },
    };
  });
  const access = new ProjectAccessService({
    findAccessRecord: async (_actorId, requestedProjectId): Promise<ProjectAccessRecord | null> => (
      requestedProjectId === PROJECT_ID
        ? { projectId: PROJECT_ID, ownerUserId: "user-owner", membershipRole: "editor" }
        : null
    ),
  });
  await registerGenerationRoutes(app, () => dummyDb, {
    createRepository: () => repository,
    createProjectAccessService: () => access,
    // 付费就绪门禁的真身会查环境配置；契约测试用既有注入缝 no-op 掉，
    // 真付费链路（落库/供应商调用）由全 fake 的 repository 兜底，绝不触达。
    requireSubmissionReady: () => undefined,
  });
  return app;
}

/* ---------- 契约用例 ---------- */

test("R3 契约:Lite 图片 estimate 体通过 zod 校验,归一化输入与 Lite 体逐键一致", async () => {
  const tierCalls: unknown[] = [];
  const configCalls: unknown[] = [];
  const promptContextCalls: unknown[] = [];
  const quoteCalls: Array<Record<string, unknown>> = [];
  const repository = {
    resolveProjectGenerationConfig: async (projectId: unknown, mediaKind: unknown) => {
      configCalls.push({ projectId, mediaKind });
      return { styleReferenceMediaIds: [], promptTemplateSource: "platform_default" };
    },
    listActiveTiers: async (mediaKind: unknown) => {
      tierCalls.push(mediaKind);
      return [fakeImageTier()];
    },
    resolveControlReferenceSnapshots: async () => [],
    resolveShotAssetVariantReferences: async () => [],
    resolvePromptCompilationContext: async (input: unknown) => {
      promptContextCalls.push(input);
      return {};
    },
    createSubmissionQuote: async (input: Record<string, unknown>) => {
      quoteCalls.push(input);
      return pendingQuoteView();
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createLiteContractApp(repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: liteImageEstimateBody(),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ok, true);
    assert.equal(response.json().data.generation_quote_id, QUOTE_ID);

    // 主线 FABLE-007 后档解析读 listActiveTiers(mediaKind) 再按 tier_id 匹配;
    // wire 透传键的最终落点在下方 request 快照里逐键锁定。
    assert.deepStrictEqual(configCalls, [{ projectId: PROJECT_ID, mediaKind: "image" }]);
    assert.deepStrictEqual(tierCalls, ["image"]);
    // 只发 supplement_prompt → 走服务端编译；项目/分镜上下文取自 Lite 体。
    assert.deepStrictEqual(promptContextCalls, [{
      projectId: PROJECT_ID,
      shotId: SHOT_ID,
      referenceMediaIds: [],
      mediaKind: "image",
    }]);

    assert.equal(quoteCalls.length, 1);
    const quoteCall = quoteCalls[0]!;
    assert.deepStrictEqual(Object.keys(quoteCall).sort(), [
      "actorId",
      "authorizedProjectId",
      "request",
      "requestHash",
      "source",
      "ttlSeconds",
    ]);
    assert.equal(quoteCall.actorId, "user-lite");
    assert.equal(quoteCall.authorizedProjectId, PROJECT_ID);
    assert.equal(quoteCall.source, "web");
    assert.equal(quoteCall.ttlSeconds, 600);
    assert.match(String(quoteCall.requestHash), /^[a-f0-9]{64}$/);
    // 内联快照：归一化输入逐键锁定。parameters 是 v01Contract 归一化结果
    // （服务端真源；size 2K 归一为像素 2048x1152）,prompt = 空自动段 + supplement_prompt
    // （见文件头 fake 边界）;promptCompilation 随主线带项目风格三字段。
    assert.deepStrictEqual(quoteCall.request, {
      projectId: PROJECT_ID,
      shotId: SHOT_ID,
      mediaKind: "image",
      model: LITE_IMAGE_MODEL,
      prompt: "画面加一缕月光",
      promptCompilation: {
        version: "v3",
        autoPrompt: "",
        supplementPrompt: "画面加一缕月光",
        projectStyleApplied: false,
        projectStyleReferenceMediaIds: [],
        promptTemplateSource: "platform_default",
      },
      parameters: { size: "2048x1152", ratio: "16:9", watermark: false, sequentialImageGeneration: "disabled" },
      referenceMediaIds: [],
      referenceAssetSnapshots: [],
      quantity: 1,
      productionMode: "full",
      clientIdempotencyKey: "lite-gen-image-0001",
      tierId: LITE_IMAGE_TIER_ID,
    });
  } finally {
    await app.close();
  }
});

test("R3 契约:Lite 视频 submit 体（首帧 references）通过 zod 校验,归一化输入与快照一致", async () => {
  const tierCalls: unknown[] = [];
  const configCalls: unknown[] = [];
  const controlCalls: unknown[] = [];
  const submissionCalls: Array<Record<string, unknown>> = [];
  const repository = {
    resolveProjectGenerationConfig: async (projectId: unknown, mediaKind: unknown) => {
      configCalls.push({ projectId, mediaKind });
      return { styleReferenceMediaIds: [], promptTemplateSource: "platform_default" };
    },
    listActiveTiers: async (mediaKind: unknown) => {
      tierCalls.push(mediaKind);
      return [fakeVideoTier()];
    },
    resolveControlReferenceSnapshots: async (
      _actorId: string,
      _mediaKind: string,
      input: { firstFrameMediaId?: string },
    ) => {
      controlCalls.push(input);
      return [{
        kind: "image",
        url: "https://assets.test/lite-first-frame.png",
        role: "first_frame",
        mediaId: input.firstFrameMediaId,
      }];
    },
    resolveShotAssetVariantReferences: async () => [],
    resolvePromptCompilationContext: async () => ({}),
    createSubmission: async (input: Record<string, unknown>) => {
      submissionCalls.push(input);
      return { outcome: "created", view: submittedVideoView() };
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createLiteContractApp(repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations",
      payload: liteVideoSubmitBody(),
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().ok, true);
    assert.equal(response.json().data.generation_request_id, REQUEST_ID);
    assert.equal(response.json().data.status, "pending");

    // duration_seconds → durationSeconds 的键名驼峰化发生在 generationParameters;
    // 档解析改读 listActiveTiers(mediaKind),透传键的落点在下方 request 快照逐键锁定。
    assert.deepStrictEqual(configCalls, [{ projectId: PROJECT_ID, mediaKind: "video" }]);
    assert.deepStrictEqual(tierCalls, ["video"]);
    // references canonical 形状归一化进首帧槽（routes.ts normalizeControlReferences）。
    assert.deepStrictEqual(controlCalls, [{
      referenceMediaIds: [],
      firstFrameMediaId: FIRST_FRAME_MEDIA_ID,
    }]);

    assert.equal(submissionCalls.length, 1);
    const submissionCall = submissionCalls[0]!;
    assert.deepStrictEqual(Object.keys(submissionCall).sort(), [
      "actorId",
      "authorizedProjectId",
      "budgetLimitFen",
      "quoteId",
      "request",
      "requestHash",
      "source",
    ]);
    assert.equal(submissionCall.actorId, "user-lite");
    assert.equal(submissionCall.authorizedProjectId, PROJECT_ID);
    assert.equal(submissionCall.source, "web");
    // generation_quote_id 全链透传到消费点。
    assert.equal(submissionCall.quoteId, QUOTE_ID);
    assert.equal(typeof submissionCall.budgetLimitFen, "number");
    assert.match(String(submissionCall.requestHash), /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(submissionCall.request, {
      projectId: PROJECT_ID,
      shotId: SHOT_ID,
      mediaKind: "video",
      model: LITE_VIDEO_MODEL,
      prompt: "镜头缓慢推近",
      promptCompilation: {
        version: "v3",
        autoPrompt: "",
        supplementPrompt: "镜头缓慢推近",
        projectStyleApplied: false,
        projectStyleReferenceMediaIds: [],
        promptTemplateSource: "platform_default",
      },
      parameters: {
        resolution: "720p",
        ratio: "9:16",
        durationSeconds: 4,
        watermark: false,
        generateAudio: true,
      },
      referenceMediaIds: [FIRST_FRAME_MEDIA_ID],
      referenceAssetSnapshots: [{
        kind: "image",
        url: "https://assets.test/lite-first-frame.png",
        role: "first_frame",
        mediaId: FIRST_FRAME_MEDIA_ID,
      }],
      quantity: 1,
      productionMode: "full",
      clientIdempotencyKey: "lite-gen-video-0001",
      tierId: LITE_VIDEO_TIER_ID,
    });
  } finally {
    await app.close();
  }
});

test("R3 契约:Lite 体 prompt 与 supplement_prompt 同发锁 422 互斥,不创建报价", async () => {
  const repository = {
    resolveProjectGenerationConfig: async () => ({ styleReferenceMediaIds: [], promptTemplateSource: "platform_default" }),
    listActiveTiers: async () => [fakeImageTier()],
    resolveControlReferenceSnapshots: async () => [],
    resolveShotAssetVariantReferences: async () => [],
    resolvePromptCompilationContext: async () => {
      throw new Error("歧义请求不得触发编译");
    },
    createSubmissionQuote: async () => {
      throw new Error("歧义请求不得创建报价");
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createLiteContractApp(repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: { ...liteImageEstimateBody(), prompt: "完整版人工全段提示词" },
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, "INVALID_GENERATION_REQUEST");
    assert.match(response.body, /只能二选一/);
  } finally {
    await app.close();
  }
});

test("R3 契约:Lite 体 references 与旧版 reference_media_ids 同发锁 422 互斥,不创建任务", async () => {
  let submissionCalls = 0;
  const repository = {
    resolveProjectGenerationConfig: async () => ({ styleReferenceMediaIds: [], promptTemplateSource: "platform_default" }),
    listActiveTiers: async () => [fakeVideoTier()],
    resolveControlReferenceSnapshots: async () => {
      throw new Error("互斥歧义必须在归一化层拦截,不得触达仓储");
    },
    resolveShotAssetVariantReferences: async () => [],
    resolvePromptCompilationContext: async () => ({}),
    createSubmission: async () => {
      submissionCalls += 1;
      throw new Error("互斥歧义不得创建任务");
    },
  } as unknown as PostgresGenerationRepository;
  const app = await createLiteContractApp(repository);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations",
      payload: {
        ...liteVideoSubmitBody(),
        reference_media_ids: ["77777777-7777-4777-8777-777777777777"],
      },
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, "control_asset_invalid_usage");
    assert.equal(submissionCalls, 0);
  } finally {
    await app.close();
  }
});
