import assert from "node:assert/strict";
import test from "node:test";
import type { EmbeddingClient } from "../../integrations/embeddingClient.js";
import { BadRequestError } from "../../shared/errors.js";
import {
  CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS,
  ModelCapabilityLookup,
  type ModelCapabilityRecord,
  type ModelCapabilityStore,
} from "./modelCapabilities.js";
import { AiGatewayService, type AiGatewayConfiguration } from "./service.js";
import type {
  AiCallRepository,
  AiCompletionProvider,
  AiProviderCompletion,
} from "./types.js";

/**
 * 网关全局输出硬顶必须按当前模型的能力判断,不再是固定 2048。
 *
 * 起因(2026-08-07):assertOutputBudget 里写死 `maxTokens > 2_048` 直接 400。
 * 这是六处写死里最先卡死的一道闸——剧本拆解一场戏要出 20+ 个结构化镜头,
 * 输出必然超过 2048,而它连供应商都到不了就被自家网关拒了。
 */

const actorId = "11111111-1111-4111-8111-111111111111";
const fixedNow = new Date("2026-08-07T10:00:00.000Z");

const configuredGateway: AiGatewayConfiguration = {
  enabled: true,
  apiKeyConfigured: true,
  dailyCallLimit: 10,
  defaultModel: "deepseek-v4-flash-ga-260731",
  embeddingModel: "doubao-embedding-test",
};

function capability(overrides: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord {
  return {
    modelName: "deepseek-v4-flash-ga",
    modelVersion: "260731",
    callableModelId: "deepseek-v4-flash-ga-260731",
    provider: "ark",
    contextWindowTokens: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 393_216,
    maxReasoningTokens: 393_216,
    rateLimitRpm: 500,
    rateLimitTpm: 1_000_000,
    dataSource: "provider_api",
    ...overrides,
  };
}

function lookupOf(rows: readonly ModelCapabilityRecord[]): ModelCapabilityLookup {
  const store: ModelCapabilityStore = { listCapabilities: async () => rows };
  return new ModelCapabilityLookup(store);
}

function repository() {
  const calls: { reserve: unknown[]; complete: unknown[]; fail: unknown[] } = {
    reserve: [], complete: [], fail: [],
  };
  const value: AiCallRepository = {
    reserve: async (input) => {
      calls.reserve.push(input);
      return { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    },
    complete: async (input) => { calls.complete.push(input); },
    fail: async (input) => { calls.fail.push(input); },
  };
  return { value, calls };
}

function provider() {
  const calls: Array<{ model?: string; maxTokens: number }> = [];
  const value: AiCompletionProvider = {
    complete: async (input) => {
      calls.push({ model: input.model, maxTokens: input.maxTokens });
      return {
        content: "{}",
        model: input.model ?? "unknown",
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 30,
      } satisfies AiProviderCompletion;
    },
  };
  return { value, calls };
}

function gatewayWith(
  lookup: ModelCapabilityLookup | undefined,
  configuration: AiGatewayConfiguration = configuredGateway,
) {
  const audit = repository();
  const ark = provider();
  const embedding: EmbeddingClient = { embedImage: async () => [0.1, 0.2], embedText: async () => [] };
  const service = new AiGatewayService(
    audit.value,
    ark.value,
    configuration,
    () => fixedNow,
    embedding,
    lookup,
  );
  return { service, audit, ark };
}

test("大容量模型:输出预算可以远超原来写死的 2048", async () => {
  const { service, ark } = gatewayWith(lookupOf([capability()]));

  await service.complete({
    actorId,
    purpose: "script_breakdown_enrich",
    system: "system",
    prompt: "prompt",
    maxTokens: 32_768,
  });

  assert.equal(ark.calls[0]?.maxTokens, 32_768, "384k 输出能力的模型不该被 2048 卡住");
});

test("同一个请求预算,在两个不同容量的模型上给出不同结论", async () => {
  const lookup = lookupOf([
    capability(),
    capability({
      modelName: "small-model",
      modelVersion: "260101",
      callableModelId: "small-model-260101",
      contextWindowTokens: 8_192,
      maxInputTokens: 8_192,
      maxOutputTokens: 4_096,
      maxReasoningTokens: null,
    }),
  ]);

  // 大模型放行。
  const big = gatewayWith(lookup);
  await big.service.complete({
    actorId,
    purpose: "script_breakdown_enrich",
    system: "system",
    prompt: "prompt",
    model: "deepseek-v4-flash-ga-260731",
    maxTokens: 100_000,
  });
  assert.equal(big.ark.calls[0]?.maxTokens, 100_000);

  // 同样的 100000 在 4096 输出能力的模型上必须被拒,且拒在预留额度之前。
  const small = gatewayWith(lookup);
  await assert.rejects(
    small.service.complete({
      actorId,
      purpose: "script_breakdown_enrich",
      system: "system",
      prompt: "prompt",
      model: "small-model-260101",
      maxTokens: 100_000,
    }),
    (error: unknown) => error instanceof BadRequestError,
  );
  assert.equal(small.audit.calls.reserve.length, 0, "超出模型能力不该预留额度");
  assert.equal(small.ark.calls.length, 0);
});

test("小容量模型在自己能力内的预算照样放行", async () => {
  const { service, ark } = gatewayWith(lookupOf([capability({
    modelName: "small-model",
    modelVersion: "260101",
    callableModelId: "small-model-260101",
    maxOutputTokens: 4_096,
  })]), { ...configuredGateway, defaultModel: "small-model-260101" });

  await service.complete({
    actorId,
    purpose: "prompt_draft",
    system: "system",
    prompt: "prompt",
    maxTokens: 4_096,
  });

  assert.equal(ark.calls[0]?.maxTokens, 4_096);
});

test("表里查不到模型:退回保守兜底上限而不是拒绝所有调用", async () => {
  const lookup = lookupOf([]);

  const allowed = gatewayWith(lookup);
  await allowed.service.complete({
    actorId,
    purpose: "prompt_draft",
    system: "system",
    prompt: "prompt",
    maxTokens: CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS,
  });
  assert.equal(
    allowed.ark.calls[0]?.maxTokens,
    CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS,
    "未登记模型仍要能按改造前的能力跑通",
  );

  const rejected = gatewayWith(lookup);
  await assert.rejects(
    rejected.service.complete({
      actorId,
      purpose: "prompt_draft",
      system: "system",
      prompt: "prompt",
      maxTokens: CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS + 1,
    }),
    (error: unknown) => error instanceof BadRequestError,
  );
});

test("非法预算仍然被拒:0、负数、小数、超大都不是「模型能力」问题", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const { service, audit } = gatewayWith(lookupOf([capability()]));
    await assert.rejects(
      service.complete({
        actorId,
        purpose: "prompt_draft",
        system: "system",
        prompt: "prompt",
        maxTokens: bad,
      }),
      (error: unknown) => error instanceof BadRequestError,
      `${bad} 应当被拒`,
    );
    assert.equal(audit.calls.reserve.length, 0);
  }
});

test("没注入容量查询时按兜底上限判断,老调用方不受影响", async () => {
  const { service, ark } = gatewayWith(undefined);

  await service.complete({
    actorId,
    purpose: "prompt_draft",
    system: "system",
    prompt: "prompt",
    maxTokens: 2_048,
  });
  assert.equal(ark.calls[0]?.maxTokens, 2_048);

  const strict = gatewayWith(undefined);
  await assert.rejects(
    strict.service.complete({
      actorId,
      purpose: "prompt_draft",
      system: "system",
      prompt: "prompt",
      maxTokens: CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS + 1,
    }),
    (error: unknown) => error instanceof BadRequestError,
  );
});

test("网关能把当前模型的阶段预算告诉调用方,剧本拆解据此定 maxTokens", async () => {
  const { service } = gatewayWith(lookupOf([capability()]));

  const budget = await service.stageOutputBudgetFor("script_breakdown_enrich");
  assert.ok(budget > 2_048, "384k 输出能力的模型,阶段预算必须超过原来的固定 2048");
  assert.ok(budget < 393_216, "整档打满会把超时与失败成本一起顶到最大");

  const unregistered = gatewayWith(lookupOf([]), {
    ...configuredGateway,
    defaultModel: "还没登记的模型",
  });
  const unknown = await unregistered.service.stageOutputBudgetFor("script_breakdown_enrich");
  assert.ok(unknown > 0);
  assert.ok(unknown <= CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS);
});
