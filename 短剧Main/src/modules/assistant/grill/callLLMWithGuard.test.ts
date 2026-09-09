/**
 * callLLMWithGuard 错误分类测试
 *
 * 合同依据：
 * - docs/contracts/environment-governance.md §5「开发与测试环境不做错误降级」：
 *   配置/额度/审计错误必须暴露为真实错误，不得静默吞错或伪装成可用。
 * - grill-engine-design.md §4.4：Grill 只对 provider 网络/模型失败降级到
 *   纯规则 + profile 预置候选。
 *
 * 分类清单（源自 src/modules/ai/service.ts 与 repository.ts 的真实 AppError code）：
 * - 原样抛出：ai_gateway_disabled、ai_gateway_not_configured、
 *   ai_daily_limit_exceeded（额度耗尽）、ai_audit_unavailable，以及未知错误。
 * - 降级为 null：external_service_error、ai_service_unavailable、
 *   ai_request_timeout、ai_invalid_response、AiCompletionValidationError。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { AppError, ExternalServiceError } from "../../../shared/errors.js";
import { AiDailyCallLimitError } from "../../ai/repository.js";
import {
  AiCompletionValidationError,
  type AiCallRepository,
  type AiCompletionProvider,
} from "../../ai/types.js";
import type { AiGatewayService } from "../../ai/service.js";
import {
  aiGatewayAsProvider,
  callLLMWithGuard,
  type GrillLlmCallInput,
} from "./callLLMWithGuard.js";

const input: GrillLlmCallInput = {
  userId: "user-1",
  purpose: "grill_candidate",
  system: "system",
  prompt: "prompt",
  maxTokens: 100,
};

function makeRepo(options: { reserveError?: unknown } = {}) {
  const calls = { reserve: 0, complete: 0, fail: 0 };
  const repo: AiCallRepository = {
    async reserve() {
      calls.reserve += 1;
      if (options.reserveError) throw options.reserveError;
      return { id: "reservation-1" };
    },
    async complete() {
      calls.complete += 1;
    },
    async fail() {
      calls.fail += 1;
    },
  };
  return { repo, calls };
}

function throwingProvider(error: unknown): AiCompletionProvider {
  return {
    async complete() {
      throw error;
    },
  };
}

function throwingGatewayProvider(error: unknown): AiCompletionProvider {
  const gateway: Pick<AiGatewayService, "completeValidated"> = {
    async completeValidated() {
      throw error;
    },
  } as Pick<AiGatewayService, "completeValidated">;
  return aiGatewayAsProvider(gateway);
}

test("额度耗尽（预留阶段）原样抛出，不静默成 null", async () => {
  const { repo } = makeRepo({ reserveError: new AiDailyCallLimitError() });
  await assert.rejects(
    () => callLLMWithGuard(repo, throwingProvider(new Error("不该被调用")), input),
    (error: unknown) => error instanceof AppError && error.code === "ai_daily_limit_exceeded",
  );
});

test("网关关闭、配置缺失、额度耗尽、审计不可用一律原样抛出", async () => {
  const configurationErrors: unknown[] = [
    new AppError(503, "ai_gateway_disabled", "使用 AI 辅助没成：功能暂未开启。", false),
    new AppError(503, "ai_gateway_not_configured", "使用 AI 辅助没成：服务暂未准备好。", false),
    new AppError(503, "ai_audit_unavailable", "AI 辅助没成：本次记录未能保存。", false),
    new AiDailyCallLimitError(),
  ];
  for (const error of configurationErrors) {
    const { repo, calls } = makeRepo();
    await assert.rejects(
      () => callLLMWithGuard(repo, throwingGatewayProvider(error), input),
      (thrown: unknown) => thrown === error,
      `code=${error instanceof AppError ? error.code : "unknown"} 必须原样抛出`,
    );
    assert.equal(calls.reserve, 0, "网关适配器不得二次预留审计");
  }
});

test("未知错误原样抛出，不降级", async () => {
  const { repo } = makeRepo();
  await assert.rejects(
    () => callLLMWithGuard(repo, throwingGatewayProvider(new TypeError("boom")), input),
    TypeError,
  );
});

test("provider 网络失败降级为 null 并记录 fail 审计", async () => {
  const { repo, calls } = makeRepo();
  const result = await callLLMWithGuard(
    repo,
    throwingProvider(new ExternalServiceError("Ark", "connection refused")),
    input,
  );
  assert.equal(result, null);
  assert.equal(calls.fail, 1);
  assert.equal(calls.complete, 0);
});

test("网关归一化后的 provider 失败与超时降级为 null", async () => {
  const providerErrors: unknown[] = [
    new AppError(502, "ai_service_unavailable", "AI 暂时没有完成这次处理。", true),
    new AppError(504, "ai_request_timeout", "AI 处理超时了。", true),
    new AppError(502, "ai_invalid_response", "结果暂时不可用。", true),
    new ExternalServiceError("公司 AI 通道", "chat completion failed with status 500"),
    new AiCompletionValidationError("schema_validation_failed", "模型返回结构不符合约定", {
      content: "{}",
      model: "mock-model",
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    }),
  ];
  for (const error of providerErrors) {
    const { repo } = makeRepo();
    const result = await callLLMWithGuard(repo, throwingGatewayProvider(error), input);
    assert.equal(result, null, "provider 侧失败必须降级为 null");
  }
});
