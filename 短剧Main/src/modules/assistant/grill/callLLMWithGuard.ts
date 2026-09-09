/**
 * callLLMWithGuard —— Grill Engine LLM 调用成本控制包装器
 *
 * 来源：grill-engine-design.md §4.4 阶段 A（记账 + 次数熔断）。
 * 逻辑：
 * - 复用 AiCallRepository.reserve/complete/fail 写 ai_calls 表记账
 * - 每日调用次数上限 = settings.grillLlmDailyLimit
 * - 额度耗尽（ai_daily_limit_exceeded）→ 原样抛出，由上层向用户暴露
 * - provider 网络/模型失败 → 返回 null（调用方降级到纯规则 + profile 预置候选）
 *
 * 遵守 AGENTS.md §4 付费红线：Grill Engine 的 LLM 调用不是付费生成动作，
 * 但仍需记账和限额，防止成本失控。
 * 遵守 docs/contracts/environment-governance.md §5：配置/额度/审计错误不做
 * 降级、不吞错；只有明确的 provider 侧失败才允许降级为纯规则路径。
 */

import { settings } from "../../../config/env.js";
import { AppError, ExternalServiceError } from "../../../shared/errors.js";
import { isRecord, jsonObject, parseJsonValue } from "../../../shared/json.js";
import type { JsonObject } from "../../../domain/assets/types.js";
import {
  AiCompletionValidationError,
  type AiCallRepository,
  type AiPurpose,
  type AiProviderCompletion,
  type AiCompletionProvider,
} from "../../ai/types.js";
import type { AiGatewayService } from "../../ai/service.js";

export interface GrillLlmCallInput {
  userId: string;
  purpose: AiPurpose;
  system: string;
  prompt: string;
  maxTokens: number;
  projectId?: string;
}

export interface GrillLlmResult {
  content: string;
  json: JsonObject | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

/**
 * 包装 LLM 调用，在 ai_calls 表记账并执行每日次数熔断。
 * provider 网络/模型失败时返回 null，调用方降级到纯规则路径；
 * 网关关闭、配置缺失、额度耗尽、审计不可用等错误原样抛出。
 */
export async function callLLMWithGuard(
  repo: AiCallRepository,
  provider: AiCompletionProvider,
  input: GrillLlmCallInput,
): Promise<GrillLlmResult | null> {
  const now = new Date();

  // Gateway-backed providers own the complete reserve → provider → settle
  // transaction. Keeping the legacy guard for isolated Grill tests avoids a
  // second audit reservation in production.
  let reservation: { id: string } | undefined;
  if (!provider.handlesAudit) {
    // 预留失败（额度耗尽、审计库故障等）必须暴露：把这类错误静默成 null
    // 会让配置/额度问题伪装成可用，违反 environment-governance.md §5。
    reservation = await repo.reserve({
      actorId: input.userId,
      purpose: input.purpose,
      provider: provider.providerForModel?.("default") ?? "unknown",
      requestedModel: "default",
      projectId: input.projectId ?? null,
      relatedObject: null,
      dailyLimit: settings.grillLlmDailyLimit,
      now,
    });
  }

  let completion: AiProviderCompletion;
  try {
    completion = await provider.complete({
      system: input.system,
      prompt: input.prompt,
      maxTokens: input.maxTokens,
      actorId: input.userId,
      purpose: input.purpose,
      projectId: input.projectId,
    });
  } catch (error) {
    // 只有明确的 provider 网络/模型失败才允许降级为纯规则路径；
    // 网关关闭/配置缺失/额度耗尽/审计不可用与未知错误必须原样抛出
    // （environment-governance.md §5：不做错误降级、不吞错）。
    if (!isProviderDegradableError(error)) throw error;
    console.error("[GrillLLM] provider.complete failed:", error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : "");
    if (reservation) {
      await repo.fail({
        id: reservation.id,
        errorCode: error instanceof ExternalServiceError ? error.internalMessage : "llm_call_failed",
        durationMs: 0,
        now: new Date(),
      }).catch(() => undefined);
    }
    return null;
  }

  if (reservation) {
    await repo.complete({
      id: reservation.id,
      model: completion.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      durationMs: completion.durationMs,
      now: new Date(),
    }).catch(() => undefined);
  }

  // 尝试解析 JSON（grill_eval / grill_clarify 等通常需要 JSON 输出）
  let json: JsonObject | null = null;
  try {
    json = jsonObject(parseJsonValue(completion.content));
  } catch {
    // 非 JSON 输出也允许（clarification 可能返回纯文本）
  }

  return {
    content: completion.content,
    json,
    model: completion.model,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    durationMs: completion.durationMs,
  };
}

/**
 * Grill 允许降级的 provider 侧失败（网络/模型失败）错误码：
 * - ai_service_unavailable / ai_request_timeout：completeValidated 归一化后的
 *   provider 失败与超时（retryable）；
 * - ai_invalid_response：provider 返回不完整结果（retryable）；
 * - external_service_error：provider 适配器原始失败（含公司通道超时
 *   ColCompletionTimeoutError）。
 * 清单之外——网关关闭/配置缺失（ai_gateway_disabled、ai_gateway_not_configured）、
 * 额度耗尽（ai_daily_limit_exceeded）、审计不可用（ai_audit_unavailable）、
 * 模型目录/通道能力配置（ai_model_unavailable、ai_tool_calling_unavailable、
 * provider_company_account_not_enabled）以及任何未知错误——都必须原样抛出。
 */
const PROVIDER_DEGRADABLE_ERROR_CODES: Record<string, true> = {
  ai_service_unavailable: true,
  ai_request_timeout: true,
  ai_invalid_response: true,
  external_service_error: true,
};

function isProviderDegradableError(error: unknown): boolean {
  if (error instanceof AiCompletionValidationError) return true;
  return error instanceof AppError && PROVIDER_DEGRADABLE_ERROR_CODES[error.code] === true;
}

/**
 * Adapts the audited AI gateway to the Grill provider seam. Every real Grill
 * call carries its actor, existing Grill purpose, optional project, and token
 * budget into completeValidated; the gateway owns model routing and the sole
 * production audit reservation.
 */
export function aiGatewayAsProvider(
  gateway: Pick<AiGatewayService, "completeValidated">,
): AiCompletionProvider {
  return {
    handlesAudit: true,
    async complete(input) {
      if (!input.actorId || !input.purpose) {
        throw new Error("Grill gateway completion requires actorId and purpose");
      }
      return gateway.completeValidated({
        actorId: input.actorId,
        purpose: input.purpose,
        system: input.system,
        prompt: input.prompt,
        maxTokens: input.maxTokens,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }, (completion) => completion);
    },
  };
}

/** 安全读取 JSON 对象字段。 */
export function readJsonField<T = unknown>(
  json: JsonObject | null,
  key: string,
): T | undefined {
  if (!json || !isRecord(json)) return undefined;
  const value = json[key];
  return value as T | undefined;
}
