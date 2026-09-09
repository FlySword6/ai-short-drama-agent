import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import type { Database } from "../../db/client.js";
import { toHttpErrorResponse } from "../../http/errorResponse.js";
import {
  registerGenerationOrchestrationRoutes,
} from "./routes.js";
import type { GenerationOrchestrationService } from "./service.js";
import { RealGenerationOperationExecutor } from "./executors.js";
import { AppError } from "../../shared/errors.js";

const sessionId = "40000000-0000-4000-8000-000000000001";
const operationId = "40000000-0000-4000-8000-000000000002";
const projectId = "40000000-0000-4000-8000-000000000003";
const shotId = "40000000-0000-4000-8000-000000000004";

test("轮次路由返回 201 操作卡并保持 snake_case 前端合同", async () => {
  const calls: unknown[] = [];
  const app = await testApp({
    async createTurn(input: unknown) {
      calls.push(input);
      return {
        turnId: operationId,
        status: "confirmation_required",
        assistantMessage: "已准备生成图片操作，请确认后执行。",
        operationCard: {
          operationId,
          operationType: "generate",
          inputMode: "text_to_image",
          mediaKind: "image",
          prompt: "雨夜巷口",
          context: { projectId, shotId },
          target: { placement: "attach_to_shot", shotId },
          references: { mediaIds: [] },
          tier: {
            tierId: "img-default",
            displayName: "图片 2K",
            providerLabel: "火山方舟",
            modelLabel: "已核价图片模型",
          },
          defaults: { size: "2048x1152", ratio: "16:9" },
          parameterGroups: [
            { key: "visual", label: "画面", controls: [] },
            { key: "motion", label: "运动", controls: [] },
            { key: "audio", label: "声音", controls: [] },
            { key: "cost", label: "成本", controls: [] },
          ],
          quote: {
            mode: "mock",
            generationQuoteId: null,
            estimatedCostFen: 60,
            currency: "CNY",
            billingUnit: "image",
            billableUnits: 1,
            expiresAt: null,
            notice: "模拟报价，不会扣费或创建真实任务",
          },
          requote: {
            method: "POST",
            endpoint: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/operations/${operationId}/requote`,
            label: "重新报价",
          },
          confirmation: {
            required: true,
            method: "POST",
            endpoint: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/operations/${operationId}/confirm`,
            label: "确认并生成",
          },
        },
      };
    },
    async confirm() {
      throw new Error("confirm should not run");
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/turns`,
      payload: {
        message: "雨夜巷口",
        context: {
          project_id: projectId,
          shot_id: shotId,
          reference_media_ids: [],
        },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const data = response.json().data;
    assert.equal(data.status, "confirmation_required");
    assert.equal(data.operation_card.input_mode, "text_to_image");
    assert.equal(data.operation_card.quote.generation_quote_id, null);
    assert.equal(data.operation_card.parameter_groups.length, 4);
    assert.equal(data.operation_card.confirmation.method, "POST");
    assert.match(data.operation_card.requote.endpoint, /requote$/u);
    assert.deepEqual(data.operation_card.references, { media_ids: [] });
    assert.equal(data.operation_card.schema_version, undefined);
    assert.equal(data.operation_card.execution_mode, undefined);
    assert.equal(data.operation_card.created_at, undefined);
    assert.equal(data.operation_card.context.selected_asset, undefined);
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
  }
});

test("重新报价路由只接收公开档位和白名单参数，并转换成服务端字段", async () => {
  const calls: unknown[] = [];
  const app = await testApp({
    async createTurn() {
      throw new Error("create should not run");
    },
    async requote(input: unknown) {
      calls.push(input);
      return {
        turnId: operationId,
        status: "clarification_required",
        assistantMessage: "没有对应核价档位",
        clarification: {
          code: "tier_not_priced",
          question: "没有对应核价档位",
        },
      };
    },
    async confirm() {
      throw new Error("confirm should not run");
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/operations/${operationId}/requote`,
      payload: {
        tier_id: "img-public-2k",
        parameters: {
          size: "1024x1024",
          ratio: "1:1",
          speech_rate: 20,
        },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls[0], {
      actorId: "40000000-0000-4000-8000-000000000010",
      sessionId,
      operationId,
      tierId: "img-public-2k",
      requestedParameters: {
        size: "1024x1024",
        ratio: "1:1",
        speechRate: 20,
      },
    });
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/operations/${operationId}/requote`,
      payload: {
        parameters: {},
        model: "internal-provider-model",
      },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
  }
});
test("真实编排执行器只把服务端会话项目作用域传给报价提交", async () => {
  const calls: unknown[][] = [];
  const executor = new RealGenerationOperationExecutor(async (...args) => {
    calls.push(args);
    return {
      requestId: "40000000-0000-4000-8000-000000000005",
      attemptId: "40000000-0000-4000-8000-000000000006",
      projectId,
      status: "pending",
      phase: "created",
      attemptNo: 1,
      mediaKind: "image",
      tierId: "img-default",
      model: "seedream-test",
      prompt: "雨夜巷口",
      parameters: {},
      providerTaskId: null,
      media: [],
    } as never;
  });

  await executor.execute({
    actorId: "40000000-0000-4000-8000-000000000010",
    session: { id: sessionId, userId: "40000000-0000-4000-8000-000000000010", projectId, shotId },
    operationId,
    operation: {
      executionMode: "real",
      quote: { mode: "real", generationQuoteId: "40000000-0000-4000-8000-000000000007" },
    } as never,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[3], projectId);
});

test("真实编排执行器在会话未绑定项目时拒绝提交，不用空串伪装作用域", async () => {
  const calls: unknown[][] = [];
  const executor = new RealGenerationOperationExecutor(async (...args) => {
    calls.push(args);
    return {} as never;
  });

  await assert.rejects(
    () => executor.execute({
      actorId: "40000000-0000-4000-8000-000000000010",
      session: { id: sessionId, userId: "40000000-0000-4000-8000-000000000010", projectId: null, shotId },
      operationId,
      operation: {
        executionMode: "real",
        quote: { mode: "real", generationQuoteId: "40000000-0000-4000-8000-000000000007" },
      } as never,
    }),
    (error: unknown) => error instanceof AppError && error.code === "session_project_missing",
  );
  assert.equal(calls.length, 0, "projectless session must never reach quote submission");
});

test("OpenAPI 明确三条路由的真实状态码、白名单参数和中文错误合同", async () => {
  const app = Fastify({ logger: false });
  await app.register(swagger, {
    openapi: {
      info: { title: "generation orchestration contract", version: "0.4.0" },
    },
  });
  await registerGenerationOrchestrationRoutes(
    app,
    () => ({}) as Database,
    {
      createService: () => ({
        async createTurn() {
          throw new Error("documentation-only test");
        },
        async requote() {
          throw new Error("documentation-only test");
        },
        async confirm() {
          throw new Error("documentation-only test");
        },
      }) as unknown as GenerationOrchestrationService,
    },
  );
  await app.ready();
  try {
    const document = app.swagger() as OpenApiDocument;
    const turn = document.paths[
      "/api/v1/agent/sessions/{session_id}/generation-orchestration/turns"
    ]?.post;
    assert.ok(turn?.responses?.["200"]);
    assert.ok(turn?.responses?.["201"]);
    assert.ok(turn?.responses?.["409"]);
    const operationCard = responseSchema(turn!, "201")
      .properties?.data
      ?.properties?.operation_card;
    assert.ok(operationCard?.properties?.context);
    assert.ok(operationCard?.properties?.target);
    assert.ok(operationCard?.properties?.references);
    assert.ok(operationCard?.properties?.tier);
    assert.ok(operationCard?.properties?.defaults);
    assert.ok(
      operationCard?.properties?.parameter_groups
        ?.items?.properties?.controls?.items?.properties?.availability,
    );

    const requote = document.paths[
      "/api/v1/agent/sessions/{session_id}/generation-orchestration/operations/{operation_id}/requote"
    ]?.post;
    assert.ok(requote?.responses?.["200"]);
    assert.ok(requote?.responses?.["201"]);
    const body = requote?.requestBody?.content?.["application/json"]?.schema as {
      properties?: {
        parameters?: { properties?: Record<string, unknown> };
      };
    };
    assert.ok(body.properties?.parameters?.properties?.size);
    assert.equal(body.properties?.parameters?.properties?.custom_pixels, undefined);

    const confirm = document.paths[
      "/api/v1/agent/sessions/{session_id}/generation-orchestration/operations/{operation_id}/confirm"
    ]?.post;
    assert.ok(confirm?.responses?.["200"]);
    assert.ok(confirm?.responses?.["202"]);
    assert.ok(confirm?.responses?.["402"]);
    const receipt = responseSchema(confirm!, "202").properties?.data;
    assert.ok(receipt?.properties?.target);
    assert.ok(receipt?.properties?.artifact?.properties?.storage_state);
    assert.ok(receipt?.properties?.ledger?.properties?.charged_cost_fen);
    assert.ok(receipt?.properties?.timeline?.items?.properties?.offset_ms);
    const errorCode = responseSchema(confirm!, "409")
      .properties?.error?.properties?.code;
    assert.match(String(errorCode?.description), /assistant_context_mismatch/u);
  } finally {
    await app.close();
  }
});

test("确认路由的 mock 回执为 200、零扣费且不回传模拟 URL", async () => {
  let confirmCalls = 0;
  const app = await testApp({
    async createTurn() {
      throw new Error("create should not run");
    },
    async confirm() {
      confirmCalls += 1;
      return {
        operationId,
        status: "succeeded",
        executionMode: "mock",
        generationRequestId: null,
        attemptId: "mock-attempt-1",
        target: { placement: "attach_to_shot", shotId },
        artifact: {
          mediaKind: "image",
          storageState: "simulated",
          storageUrl: null,
        },
        ledger: {
          estimatedCostFen: 60,
          chargedCostFen: 0,
          pointsSpent: 0,
          currency: "CNY",
        },
        timeline: [
          { state: "accepted", offsetMs: 0 },
          { state: "running", offsetMs: 40 },
          { state: "succeeded", offsetMs: 80 },
        ],
        message: "模拟生成已完成：未调用真实供应商，未扣费。",
      };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/operations/${operationId}/confirm`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data.ledger, {
      estimated_cost_fen: 60,
      charged_cost_fen: 0,
      points_spent: 0,
      currency: "CNY",
    });
    assert.equal(response.json().data.artifact.storage_url, null);
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/operations/${operationId}/confirm`,
      payload: {
        model: "internal-provider-model",
        price: 1,
      },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(confirmCalls, 1);
  } finally {
    await app.close();
  }
});

test("轮次请求拒绝客户端供应商字段和未登录调用", async () => {
  const service = {
    async createTurn() {
      throw new Error("invalid request must stop before service");
    },
    async confirm() {
      throw new Error("confirm should not run");
    },
  };
  const authenticated = await testApp(service);
  const anonymous = Fastify({ logger: false });
  registerErrorHandler(anonymous);
  await registerGenerationOrchestrationRoutes(
    anonymous,
    () => ({}) as Database,
    { createService: () => service as unknown as GenerationOrchestrationService },
  );
  try {
    const invalid = await authenticated.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/turns`,
      payload: {
        message: "生成一张图",
        context: { project_id: projectId, reference_media_ids: [] },
        provider: "ark",
      },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    const unauthenticated = await anonymous.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/turns`,
      payload: {
        message: "生成一张图",
        context: { project_id: projectId, reference_media_ids: [] },
      },
    });
    assert.equal(unauthenticated.statusCode, 401);
  } finally {
    await authenticated.close();
    await anonymous.close();
  }
});

async function testApp(service: {
  createTurn(input: unknown): Promise<unknown>;
  requote?(input: unknown): Promise<unknown>;
  confirm(input: unknown): Promise<unknown>;
}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: "40000000-0000-4000-8000-000000000010",
      username: "artist",
      displayName: "制作人",
      role: "member",
    };
  });
  await registerGenerationOrchestrationRoutes(
    app,
    () => ({}) as Database,
    { createService: () => service as unknown as GenerationOrchestrationService },
  );
  return app;
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toHttpErrorResponse(error);
    void reply.code(statusCode).send({ ok: false, error: body });
  });
}

interface OpenApiSchema {
  description?: string;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
}

interface OpenApiOperation {
  requestBody?: {
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  responses?: Record<string, {
    content?: Record<string, { schema?: OpenApiSchema }>;
  }>;
}

interface OpenApiDocument {
  paths: Record<string, { post?: OpenApiOperation }>;
}

function responseSchema(
  operation: OpenApiOperation,
  statusCode: string,
): OpenApiSchema {
  const schema = operation.responses?.[statusCode]
    ?.content?.["application/json"]
    ?.schema;
  assert.ok(schema, `OpenAPI 缺少 ${statusCode} application/json 响应 schema`);
  return schema;
}
