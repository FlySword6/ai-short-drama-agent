import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../shared/errors.js";
import { AiGatewayService } from "./service.js";
import { ModelCapabilityLookup, type ModelCapabilityRecord } from "./modelCapabilities.js";
import type { AiCallRepository, AiCompletionProvider } from "./types.js";

/**
 * 输出预算只能按「用途」解析。改造前拆解侧传空串当模型名靠网关反查,
 * 火山分支没有用途表时空串落回去、能力表查不到、预算静默缩到兜底值。
 */

const idleRepository: AiCallRepository = {
  reserve: async () => ({ id: "unused" }),
  complete: async () => {},
  fail: async () => {},
};

const idleProvider: AiCompletionProvider = {
  complete: async () => {
    throw new Error("本用例不外呼");
  },
};

function capabilityLookup(records: ModelCapabilityRecord[]): ModelCapabilityLookup {
  return new ModelCapabilityLookup({ listCapabilities: async () => records });
}

function capability(callableModelId: string, maxOutputTokens: number): ModelCapabilityRecord {
  return {
    modelName: callableModelId,
    modelVersion: "260731",
    callableModelId,
    provider: "ark",
    contextWindowTokens: 131_072,
    maxInputTokens: null,
    maxOutputTokens,
    maxReasoningTokens: null,
    rateLimitRpm: null,
    rateLimitTpm: null,
    dataSource: "provider_api",
  };
}

test("用途落在默认模型上时按该模型的真实能力算预算", async () => {
  const gateway = new AiGatewayService(
    idleRepository,
    idleProvider,
    {
      enabled: true,
      apiKeyConfigured: true,
      dailyCallLimit: 100,
      defaultModel: "deepseek-v4-flash-ga-260731",
      embeddingModel: null,
    },
    () => new Date(),
    undefined,
    capabilityLookup([capability("deepseek-v4-flash-ga-260731", 393_216)]),
  );

  assert.equal(await gateway.stageOutputBudgetFor("script_breakdown_enrich"), 32_768);
});

test("用途配了专用模型时按专用模型算,不落回默认模型", async () => {
  const gateway = new AiGatewayService(
    idleRepository,
    idleProvider,
    {
      enabled: true,
      apiKeyConfigured: true,
      dailyCallLimit: 100,
      defaultModel: "doubao-seed-2-1-pro-260628",
      embeddingModel: null,
      purposeModels: { script_breakdown_enrich: "deepseek-v4-flash-ga-260731" },
    },
    () => new Date(),
    undefined,
    capabilityLookup([
      capability("deepseek-v4-flash-ga-260731", 8_192),
      capability("doubao-seed-2-1-pro-260628", 393_216),
    ]),
  );

  assert.equal(await gateway.stageOutputBudgetFor("script_breakdown_enrich"), 8_192);
});

test("解析不出模型时报错,不静默给一个兜底数", async () => {
  const gateway = new AiGatewayService(
    idleRepository,
    idleProvider,
    {
      enabled: true,
      apiKeyConfigured: true,
      dailyCallLimit: 100,
      defaultModel: null,
      embeddingModel: null,
    },
    () => new Date(),
    undefined,
    capabilityLookup([]),
  );

  await assert.rejects(
    gateway.stageOutputBudgetFor("script_breakdown_enrich"),
    (error: unknown) => error instanceof AppError && error.code === "ai_gateway_not_configured",
  );
});
