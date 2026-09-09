import assert from "node:assert/strict";
import test from "node:test";
import { AiGatewayService, type AiGatewayConfiguration } from "../ai/service.js";
import {
  CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS,
  ModelCapabilityLookup,
  type ModelCapabilityRecord,
} from "../ai/modelCapabilities.js";
import type { AiCallRepository, AiCompletionProvider } from "../ai/types.js";
import { ScriptBreakdownService } from "./service.js";
import {
  AllowAllAccess,
  happyPathToolTurns,
  InMemoryScriptBreakdownRepository,
  storyboardCompletionJson,
  TEST_ACTOR,
  TEST_EPISODE_ID,
  TEST_SCRIPT_TEXT,
} from "./test-doubles.js";

/**
 * 端到端钉住 downstream 关心的那一条:真实剧本的分镜解析不再被固定 2048 截断。
 *
 * 判据与阶段机无关,所以切到 agent 路之后它一条不少,只是载体从
 * complete 换成 completeToolTurn:证明拆解服务接上真网关后,实际发给
 * 供应商的 maxTokens 就是模型能力算出来的那个数,而且同一次运行里不漂移。
 */

const fixedNow = () => new Date("2026-08-07T08:00:00.000Z");

const bigModelCapability: ModelCapabilityRecord = {
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
};

function auditRepository(): AiCallRepository {
  let seq = 0;
  return {
    reserve: async () => {
      seq += 1;
      return { id: `cccccccc-cccc-4ccc-8ccc-${String(seq).padStart(12, "0")}` };
    },
    complete: async () => {},
    fail: async () => {},
  };
}

function recordingProvider() {
  const maxTokensSeen: number[] = [];
  const script = happyPathToolTurns();
  let index = 0;
  const value: AiCompletionProvider = {
    // P6 阶段②:单次文本往返,同样记录实际发出的 maxTokens
    complete: async (input) => {
      maxTokensSeen.push(input.maxTokens);
      return {
        content: storyboardCompletionJson(),
        model: input.model ?? "unknown",
        inputTokens: 120,
        outputTokens: 60,
        durationMs: 7,
      };
    },
    completeToolTurn: async (input) => {
      maxTokensSeen.push(input.maxTokens);
      const step = script[index] ?? { text: "没有更多要补的了。" };
      index += 1;
      return {
        content: step.text ?? "",
        toolCalls: (step.toolCalls ?? []).map((call, position) => ({
          id: `call-${index}-${position}`,
          name: call.name,
          arguments: call.arguments,
        })),
        unreadableToolCalls: [],
        model: input.model ?? "unknown",
        inputTokens: 120,
        outputTokens: 60,
        durationMs: 7,
      };
    },
  };
  return { value, maxTokensSeen };
}

function setup(capabilities: readonly ModelCapabilityRecord[]) {
  const configuration: AiGatewayConfiguration = {
    enabled: true,
    apiKeyConfigured: true,
    dailyCallLimit: 100,
    defaultModel: "deepseek-v4-flash-ga-260731",
    embeddingModel: null,
    purposeModels: { script_breakdown_enrich: "deepseek-v4-flash-ga-260731", script_breakdown_storyboard: "deepseek-v4-flash-ga-260731" },
  };
  const provider = recordingProvider();
  const gateway = new AiGatewayService(
    auditRepository(),
    provider.value,
    configuration,
    fixedNow,
    { embedImage: async () => [0.1, 0.2], embedText: async () => [] },
    new ModelCapabilityLookup({ listCapabilities: async () => capabilities }),
  );
  const service = new ScriptBreakdownService(
    new InMemoryScriptBreakdownRepository(),
    gateway,
    new AllowAllAccess(),
    { now: fixedNow },
  );
  return { service, provider };
}

async function runBreakdown(service: ScriptBreakdownService): Promise<void> {
  const version = await service.createScriptVersion(TEST_ACTOR, TEST_EPISODE_ID, {
    title: "第一集",
    scriptText: TEST_SCRIPT_TEXT,
    clientIdempotencyKey: "dyn-budget-version",
  });
  const run = await service.createRun(TEST_ACTOR, TEST_EPISODE_ID, {
    scriptVersionId: version.version.id,
    targetDurationSec: null,
    clientIdempotencyKey: "dyn-budget-run",
  });
  await service.executeRun(run.run.id, TEST_ACTOR.id);
}

test("已登记大容量模型:拆解每一轮实际发出的输出预算都超过 2048", async () => {
  const { service, provider } = setup([bigModelCapability]);

  await runBreakdown(service);

  assert.ok(provider.maxTokensSeen.length >= 5, "一次拆解:阶段①四轮 + 阶段②一轮");
  for (const seen of provider.maxTokensSeen) {
    assert.ok(seen > 2_048, `实际发出的 maxTokens ${seen} 仍被固定 2048 卡住`);
  }
  // 同一次运行里预算不该漂移,否则草稿会出现一半内容被截断的混合状态。
  assert.equal(new Set(provider.maxTokensSeen).size, 1);
});

test("模型未登记:拆解退回保守兜底,仍能跑通而不是整条链路不可用", async () => {
  const { service, provider } = setup([]);

  await runBreakdown(service);

  assert.ok(provider.maxTokensSeen.length >= 5);
  for (const seen of provider.maxTokensSeen) {
    assert.ok(seen > 0);
    assert.ok(seen <= CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS);
  }
});

test("每轮预算永远不超过网关按同一模型算出的硬顶,拆解不会自己把请求撑到被拒", async () => {
  const smallCapability: ModelCapabilityRecord = {
    ...bigModelCapability,
    maxOutputTokens: 4_096,
    maxReasoningTokens: null,
  };
  const { service, provider } = setup([smallCapability]);

  await runBreakdown(service);

  for (const seen of provider.maxTokensSeen) {
    assert.ok(seen <= 4_096, `${seen} 超过模型能力会在网关被 400 拒掉`);
  }
});
