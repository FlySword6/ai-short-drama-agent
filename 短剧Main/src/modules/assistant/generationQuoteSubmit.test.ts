import assert from "node:assert/strict";
import test from "node:test";
import { GenerationError } from "../generation/errors.js";
import {
  requireAssistantPaidGenerationEnabled,
  restoreAssistantGenerationInput,
  submitAssistantGenerationQuote,
} from "./generationQuoteSubmit.js";

const ids = {
  project: "89a47aaa-a315-4e18-95a8-4e7bf8fbab65",
  shot: "4896778d-b1b4-48b0-88e2-065369f10fcb",
  quote: "24c4daf4-d6d9-4894-8615-e24eb06e64ec",
  reference: "f4cccf91-ae42-407d-9931-d5147a28472f",
};

test("助手报价只从严格冻结快照恢复输入，并使用稳定幂等键", () => {
  const input = restoreAssistantGenerationInput(validSnapshot(), {
    projectId: ids.project,
    shotId: ids.shot,
  }, ids.quote);

  assert.equal(input.projectId, ids.project);
  assert.equal(input.shotId, ids.shot);
  assert.equal(input.clientIdempotencyKey, `confirmation:${ids.quote}`);
  assert.deepEqual(input.parameters, {
    size: "2K",
    watermark: false,
    sequentialImageGeneration: "disabled",
  });
});

test("助手报价拒绝缺少分镜、未知字段和引用数组不一致的快照", () => {
  const session = { projectId: ids.project, shotId: ids.shot };
  assertSnapshotRejected({ ...validSnapshot(), shotId: undefined }, session);
  assertSnapshotRejected({ ...validSnapshot(), hiddenPrompt: "不允许" }, session);
  assertSnapshotRejected({
    ...validSnapshot(),
    parameters: { ...(validSnapshot().parameters as Record<string, unknown>), seed: 42 },
  }, session);
  assertSnapshotRejected({
    ...validSnapshot(),
    referenceMediaIds: [ids.reference],
    referenceAssetSnapshots: [],
  }, session);
});

test("助手报价拒绝与会话项目或分镜不一致的快照", () => {
  assertSnapshotRejected(validSnapshot(), {
    projectId: "20e2b55a-cd21-445a-8678-f37a29c3f671",
    shotId: ids.shot,
  }, "GENERATION_QUOTE_CONTEXT_MISMATCH");
  assertSnapshotRejected(validSnapshot(), {
    projectId: ids.project,
    shotId: null,
  }, "GENERATION_QUOTE_CONTEXT_MISMATCH");
});

test("v0.4 编排报价可恢复三模态通用参数，并允许项目级会话承载镜头上下文", () => {
  const restored = restoreAssistantGenerationInput({
    projectId: ids.project,
    shotId: ids.shot,
    mediaKind: "audio",
    tierId: "aud-seedaudio10-3s",
    model: "seed-audio-1.0",
    prompt: "今晚必须找到他",
    parameters: {
      originalDurationSeconds: 3,
      format: "mp3",
      sampleRate: 48_000,
      enableSubtitle: true,
      aigcMetadataEnabled: true,
      aigcWatermarkEnabled: false,
    },
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    quantity: 1,
    productionMode: "full",
  }, {
    projectId: ids.project,
    shotId: null,
  }, ids.quote);

  assert.equal(restored.mediaKind, "audio");
  assert.equal(restored.tierId, "aud-seedaudio10-3s");
  assert.equal(restored.shotId, ids.shot);
  assert.equal(restored.productionMode, "full");
  assert.equal(restored.clientIdempotencyKey, `confirmation:${ids.quote}`);
});

test("付费开关关闭时在报价确认前返回 403", () => {
  assert.throws(
    () => requireAssistantPaidGenerationEnabled(false),
    (error: unknown) => isError(error, "paid_generation_disabled", 403),
  );
  assert.doesNotThrow(() => requireAssistantPaidGenerationEnabled(true));
});

test("付费开关关闭时提交服务不读取或确认报价", async () => {
  const inaccessibleDatabase = new Proxy({}, {
    get() {
      throw new Error("付费开关关闭时不应访问数据库");
    },
  });
  await assert.rejects(
    submitAssistantGenerationQuote(inaccessibleDatabase as never, {
      actorId: ids.project,
      authorizedProjectId: ids.project,
      session: {
        id: ids.shot,
        userId: ids.project,
        authSessionId: null,
        agentType: "platform_assistant",
        userAgent: null,
        projectId: ids.project,
        shotId: ids.shot,
        title: "测试会话",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
        clarificationState: null,
      },
      quoteId: ids.quote,
      paidGenerationEnabled: false,
    }),
    (error: unknown) => isError(error, "paid_generation_disabled", 403),
  );
});

test("Ark 或 TOS 配置不完整时提交服务不会读取或确认报价", async () => {
  const inaccessibleDatabase = new Proxy({}, {
    get() {
      throw new Error("配置不完整时不应访问数据库");
    },
  });
  await assert.rejects(
    submitAssistantGenerationQuote(inaccessibleDatabase as never, {
      actorId: ids.project,
      authorizedProjectId: ids.project,
      session: {
        id: ids.shot,
        userId: ids.project,
        authSessionId: null,
        agentType: "platform_assistant",
        userAgent: null,
        projectId: ids.project,
        shotId: ids.shot,
        title: "测试会话",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
        clarificationState: null,
      },
      quoteId: ids.quote,
      paidGenerationEnabled: true,
      generationReadiness: {
        arkApiKey: "test-only-ark-key",
        tosBucket: "test-only-bucket",
        tosEndpoint: "https://tos.example.test",
        tosAccessKey: "test-only-access-key",
        tosSecretKey: "test-only-secret-key",
        tosPublicBaseUrl: undefined,
      },
    }),
    (error: unknown) => isError(error, "generation_service_unavailable", 503),
  );
});

function validSnapshot(): Record<string, unknown> {
  return {
    projectId: ids.project,
    shotId: ids.shot,
    mediaKind: "image",
    model: "seedream-quote-test",
    prompt: "雨夜街道上的人物",
    parameters: {
      size: "2K",
      watermark: false,
      sequentialImageGeneration: "disabled",
    },
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    quantity: 1,
  };
}

function assertSnapshotRejected(
  snapshot: unknown,
  session: { projectId: string | null; shotId: string | null },
  code = "GENERATION_QUOTE_INVALID_SNAPSHOT",
): void {
  assert.throws(
    () => restoreAssistantGenerationInput(snapshot, session, ids.quote),
    (error: unknown) => error instanceof GenerationError && error.code === code,
  );
}

function isError(error: unknown, code: string, statusCode: number): boolean {
  return error instanceof Error
    && "code" in error
    && "statusCode" in error
    && error.code === code
    && error.statusCode === statusCode;
}
