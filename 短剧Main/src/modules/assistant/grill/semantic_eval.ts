/**
 * SemanticSufficiencyEvaluator —— LLM 语义充分性判断器
 *
 * 来源：grill-engine-design.md §2.2 + §8 阶段 1 步骤 1.3。
 * 逻辑：
 * - 仅在 RulePreChecker 返回 needs_llm 时调用（preferred 字段缺失但可推断）
 * - 用 Ark JSON mode 判断 preferred 字段能否从用户消息语义推断
 * - 返回 sufficient（可推断）或 insufficient（需要反问）
 *
 * 成本控制：1 次 LLM 调用，通过 callLLMWithGuard 记账 + 熔断。
 * 超限降级：返回 insufficient（走反问/候选降级路径）。
 */

import type { AiCallRepository, AiCompletionProvider } from "../../ai/types.js";
import { callLLMWithGuard, readJsonField } from "./callLLMWithGuard.js";
import type { FieldSpec, ConversationContext } from "./types.js";

export type SemanticEvalResult =
  | { conclusion: "sufficient"; inferred: Record<string, unknown> }
  | { conclusion: "insufficient"; missingFields: string[] };

const SEMANTIC_EVAL_SYSTEM = `你是一个信息充分性判断器。用户想执行一个任务，但有些非关键字段缺失。
你需要判断能否从用户的意图和已有上下文中推断出这些字段的值。
只输出严格 JSON，格式：{"sufficient": true/false, "inferred": {"field_name": "推断值"}, "missing": ["无法推断的字段名"]}`;

/**
 * 用 LLM 判断 preferred 字段能否从上下文语义推断。
 * 超限或失败时降级为 insufficient。
 */
export async function evaluateSemanticSufficiency(
  repo: AiCallRepository,
  provider: AiCompletionProvider,
  intent: string,
  missingFields: FieldSpec[],
  ctx: ConversationContext,
): Promise<SemanticEvalResult> {
  // Bug 8-6 守卫：仅对 preferred 字段做语义推断，critical 字段必须走反问/候选路径。
  // 如果调用方误传了 critical 字段，直接返回 insufficient。
  const preferredFields = missingFields.filter((f) => f.priority !== "critical");
  const criticalFields = missingFields.filter((f) => f.priority === "critical");

  if (criticalFields.length > 0) {
    return {
      conclusion: "insufficient",
      missingFields: criticalFields.map((f) => f.name),
    };
  }

  if (preferredFields.length === 0) {
    return { conclusion: "sufficient", inferred: {} };
  }

  const fieldDescriptions = preferredFields
    .map((f) => `- ${f.name}: ${f.description}${f.defaultValue !== undefined ? `（默认值: ${String(f.defaultValue)}）` : ""}`)
    .join("\n");

  const prompt = [
    `用户意图: ${intent}`,
    `已有上下文字段: ${JSON.stringify(ctx.ephemeralFields ?? {})}`,
    `需要判断是否充分的字段:`,
    fieldDescriptions,
    `请判断能否从用户意图和已有上下文推断这些字段的值。`,
  ].join("\n\n");

  const result = await callLLMWithGuard(repo, provider, {
    userId: ctx.userId,
    purpose: "grill_eval",
    system: SEMANTIC_EVAL_SYSTEM,
    prompt,
    maxTokens: 500,
    projectId: ctx.projectId,
  });

  if (!result || !result.json) {
    // LLM 超限或返回非 JSON → 降级为 insufficient
    return {
      conclusion: "insufficient",
      missingFields: missingFields.map((f) => f.name),
    };
  }

  const sufficient = readJsonField<boolean>(result.json, "sufficient");
  if (sufficient === true) {
    const inferred = readJsonField<Record<string, unknown>>(result.json, "inferred") ?? {};
    return { conclusion: "sufficient", inferred };
  }

  const missing = readJsonField<string[]>(result.json, "missing") ?? missingFields.map((f) => f.name);
  return { conclusion: "insufficient", missingFields: missing };
}
