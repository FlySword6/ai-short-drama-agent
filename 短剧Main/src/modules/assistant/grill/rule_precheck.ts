/**
 * RulePreChecker —— 纯代码规则预检器（零 LLM）
 *
 * 来源：grill-engine-design.md §2.2 + §8 阶段 0 步骤 0.2。
 * 逻辑：
 * - critical 字段全部存在 → 继续 preferred 检查
 * - preferred 字段全部存在 → sufficient
 * - preferred 字段缺失但 critical 全有 → needs_llm（交 LLM 判断能否推断）
 * - critical 字段缺失 → insufficient（直接判不充分，不需要 LLM）
 *
 * 阶段 0 约束：不接 LLM。needs_llm 结论返回后，由调用方决定如何处理
 * （阶段 0 测试中按 insufficient 处理，进入反问/降级流程）。
 */

import type {
  ConversationContext,
  FieldSpec,
  GrillCheckResult,
  RulePreCheckResult,
  TaskProfile,
} from "./types.js";

/** 检查单个字段是否在上下文中存在（非 undefined、非 null、非空字符串）。 */
function fieldExists(
  field: FieldSpec,
  ctx: ConversationContext,
): boolean {
  const value = ctx.ephemeralFields?.[field.name];
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/**
 * 规则预检：按 FieldSpec 的 priority + exists 检查充分性。
 * 零 LLM 调用，零延迟。
 */
export function rulePreCheck(
  profile: TaskProfile,
  ctx: ConversationContext,
): RulePreCheckResult {
  const missingCritical: string[] = [];
  const missingPreferred: string[] = [];

  for (const field of profile.requiredFields) {
    if (fieldExists(field, ctx)) continue;
    if (field.priority === "critical") {
      missingCritical.push(field.name);
    } else {
      missingPreferred.push(field.name);
    }
  }

  // critical 缺失 → 直接判不充分，不需要 LLM
  if (missingCritical.length > 0) {
    return { conclusion: "insufficient", missingCritical, missingPreferred };
  }

  // preferred 缺失 → 规则无法定论，交 LLM 判断能否推断
  if (missingPreferred.length > 0) {
    return { conclusion: "needs_llm", missingPreferred };
  }

  // 全部存在 → 充分
  return { conclusion: "sufficient" };
}

/**
 * 阶段 0 桥接函数：把 RulePreCheckResult 转为 GrillCheckResult。
 *
 * 阶段 0 不接 LLM，needs_llm 按规则降级路径处理：
 * - 若有 fallbackCandidates 且 missingPreferred 中的字段有预置候选 → offer_candidates
 * - 否则 → clarify（问 priority 最高且未收集的字段）
 *
 * 此函数是纯代码，不调用 LLM。真正接入 LLM 的 check() 在阶段 1 实现。
 */
export function stage0CheckBridge(
  profile: TaskProfile,
  preCheckResult: RulePreCheckResult,
  ctx: ConversationContext,
): GrillCheckResult {
  if (preCheckResult.conclusion === "sufficient") {
    return { action: "execute" };
  }

  if (preCheckResult.conclusion === "insufficient") {
    // critical 缺失：先反问，不直接给候选
    const targetField = preCheckResult.missingCritical[0]!;
    const question = buildClarifyQuestion(profile, targetField);
    return { action: "clarify", question, targetField };
  }

  // needs_llm：阶段 0 无 LLM，先反问
  const missingField = preCheckResult.missingPreferred[0]!;
  const question = buildClarifyQuestion(profile, missingField);
  return { action: "clarify", question, targetField: missingField };
}

/** 根据 FieldSpec.description 构造自然语言反问。阶段 0 简单拼接，阶段 1 用 LLM 生成。 */
function buildClarifyQuestion(profile: TaskProfile, fieldName: string): string {
  const spec = profile.requiredFields.find((f) => f.name === fieldName);
  if (!spec) return `请补充：${fieldName}`;
  // 兜底话术：带"我先按 X 来，你看着改"
  const defaultValue = spec.defaultValue;
  if (defaultValue !== undefined) {
    return `我需要知道你的${spec.description}。我先按「${String(defaultValue)}」来，你看着改？`;
  }
  return `我需要知道你的${spec.description}，方便我给出更贴合的结果。`;
}
