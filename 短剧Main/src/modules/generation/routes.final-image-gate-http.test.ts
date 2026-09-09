/**
 * 上一层是纯函数判据,这一层守 HTTP 边界:三个入口(单项估价 / 单项提交 / 批量估价)
 * 拿到「定稿图在但没入库」时各自该怎么回,以及知情标记能不能真的一路透传到放行。
 *
 * 起因同 routes.final-image-gate.test.ts:不注册就生视频 = 人物全对不上的废片
 * (实测证据 outputs/e2e-wolf-ep1-20260808/)。纯函数挡住了不等于接口挡住了,
 * 中间还隔着 zod 入参、三处调用点和批量的逐项容错,那几段都可能把闸门吃掉。
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { errorBody } from "../../shared/errors.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessRecord } from "../project-access/types.js";
import type { PostgresGenerationRepository } from "./repository.js";
import { registerGenerationRoutes } from "./routes.js";
import { V01_VIDEO_MODEL } from "./v01Contract.js";

const dummyDb = {} as Database;
const projectId = "11111111-1111-4111-8111-111111111111";
const shotId = "44444444-4444-4444-8444-444444444444";
const finalMediaId = "55555555-5555-4555-8555-555555555555";

function videoTier() {
  return {
    tierId: "video-tier",
    rule: {
      id: "video-tier-rule",
      provider: "ark",
      model: V01_VIDEO_MODEL,
      mediaKind: "video" as const,
      billingUnit: "second" as const,
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

function quoteRow() {
  return {
    generationQuoteId: "33333333-3333-4333-8333-333333333333",
    source: "web" as const,
    action: "submit" as const,
    status: "pending_confirmation" as const,
    estimatedCostFen: 1,
    currency: "CNY" as const,
    expiresAt: new Date("2027-08-08T00:00:00.000Z"),
    createdAt: new Date("2026-08-08T00:00:00.000Z"),
    priceSnapshot: {},
    normalizedRequest: {},
  };
}

/**
 * 假仓储只实现闸门这条路要用到的接口。`finalReference` 决定本镜定稿图的处境;
 * `submitted` 记下真的走到提交层的请求,用来证明放行不是「挡住后吞掉错误」。
 */
function repositoryWith(finalReference: unknown, submitted: unknown[]) {
  return {
    resolveActiveTier: async () => videoTier(),
    resolveProjectGenerationConfig: async () => ({
      styleReferenceMediaIds: [],
      promptTemplateSource: "platform_default" as const,
    }),
    resolveShotFinalReference: async () => finalReference,
    resolveShotAssetVariantReferences: async () => [],
    resolveControlReferenceSnapshots: async (
      _actorId: string,
      _mediaKind: string,
      input: { referenceMediaIds: string[] },
    ) => input.referenceMediaIds.map((mediaId) => ({
      kind: "image" as const,
      url: `https://assets.test/${mediaId}.png`,
      mediaId,
    })),
    createSubmissionQuote: async (input: { request: Record<string, unknown> }) => {
      submitted.push(input.request);
      return { ...quoteRow(), normalizedRequest: input.request };
    },
  } as unknown as PostgresGenerationRepository;
}

async function createApp(repository: PostgresGenerationRepository) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: "user-editor", username: "editor", displayName: "编辑" };
    request.authSessionId = "66666666-6666-4666-8666-666666666666";
    request.authContext = {
      user: request.authUser,
      credential: {
        sessionId: request.authSessionId,
        source: "web",
        actorKind: "human",
        agentType: null,
        userAgent: null,
        expiresAt: new Date("2027-08-08T00:00:00.000Z"),
      },
    };
  });
  const access = new ProjectAccessService({
    findAccessRecord: async (_actorId, requested): Promise<ProjectAccessRecord | null> => (
      requested === projectId
        ? { projectId, ownerUserId: "user-editor", membershipRole: "editor" }
        : null
    ),
  });
  await registerGenerationRoutes(app, () => dummyDb, {
    createRepository: () => repository,
    createProjectAccessService: () => access,
    requireSubmissionReady: () => undefined,
  });
  return app;
}

function videoPayload(overrides: Record<string, unknown> = {}) {
  return {
    media_kind: "video",
    tier_id: "video-tier",
    project_id: projectId,
    shot_id: shotId,
    prompt: "雨夜广场,三个主角对峙",
    parameters: {},
    client_idempotency_key: "gate-http-key-123",
    ...overrides,
  };
}

test("单项估价:未登记定稿图 fail-closed 拒绝,不丢图改纯文字", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const app = await createApp(repositoryWith({ status: "unregistered" }, submitted));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: videoPayload(),
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.body, /参考资产|纯文字/u);
    assert.equal(submitted.length, 0, "未登记定稿图不得走到供应商组包");
  } finally {
    await app.close();
  }
});

test("定稿图已入库时照旧补进参考清单", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const app = await createApp(repositoryWith(
    { status: "registered", mediaId: finalMediaId },
    submitted,
  ));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: videoPayload(),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(submitted[0]?.referenceMediaIds, [finalMediaId]);
  } finally {
    await app.close();
  }
});
