/**
 * ClarificationGenerator —— LLM 反问生成器
 *
 * 来源：grill-engine-design.md §2.2 + §8 阶段 1 步骤 1.4。
 * 逻辑：
 * - 只问 priority 最高且未收集的字段（由调用方传入 targetField）
 * - 用 LLM 生成 1 个聚焦的自然语言问题
 * - 带兜底话术："我先按 X 来，你看着改？"
 *
 * 成本控制：1 次 LLM 调用，通过 callLLMWithGuard 记账 + 熔断。
 * 超限降级：用 stage0CheckBridge 的纯代码反问。
 */

import type { AiCallRepository, AiCompletionProvider } from "../../ai/types.js";
import { callLLMWithGuard, readJsonField } from "./callLLMWithGuard.js";
import type { Candidate, ConversationContext, FieldSpec } from "./types.js";

export interface ClarificationResult {
  question: string;
  targetField: string;
}

const CLARIFICATION_SYSTEM = `你是一个创意助手的对话引擎。用户正在描述一个创作需求，你需要用自然、口语化的方式追问一个关键信息。

核心原则：
1. 像真人对话——简洁、有温度，不要机械重复同一句式
2. 结合上下文已知信息，让追问显得自然连贯
3. 如果有候选选项，顺带提一下让用户选
4. 如果字段有默认值，用"我先按 X 来，你看着改？"的方式降低用户负担
5. 每次措辞要有变化，不要像模板

只输出严格 JSON：{"question": "你的反问"}`;

/** 已收集字段的简要摘要，用于让 LLM 了解对话进展。 */
function collectedSummary(ctx: ConversationContext): string {
  const parts: string[] = [];
  if (ctx.ephemeralFields) {
    for (const [k, v] of Object.entries(ctx.ephemeralFields)) {
      if (v !== undefined && v !== null && v !== "") {
        parts.push(`${k}=${String(v)}`);
      }
    }
  }
  return parts.length > 0 ? parts.join("，") : "（暂无）";
}

/**
 * 用 LLM 生成一个聚焦的反问。
 * 超限或失败时降级为纯代码反问。
 */
export async function generateClarification(
  repo: AiCallRepository,
  provider: AiCompletionProvider,
  intent: string,
  targetField: FieldSpec,
  ctx: ConversationContext,
  userId: string,
  candidates?: Candidate[],
  round: number = 1,
): Promise<ClarificationResult> {
  const lines = [
    `用户最初需求: ${intent}`,
    `已收集信息: ${collectedSummary(ctx)}`,
    `当前是第 ${round} 轮追问`,
    `现在需要追问的字段: ${targetField.name} (${targetField.description})`,
  ];

  const prefHints = ctx.metadata?.preferenceHints;
  if (prefHints) {
    lines.push(`用户在注册引导中已填偏好: ${prefHints}`);
    lines.push(
      `可参考偏好作为方向建议，但反问必须优先围绕用户意图中的主题和语境。` +
      `当用户意图与注册偏好明显不匹配时（如用户说"老奶奶过马路"但偏好是"江湖武侠"），` +
      `反问应围绕用户实际主题展开（日常/温情/生活等），可以提一句偏好让用户选择，` +
      `但不要用"你平时喜欢X，这次要不要也来点X的"这种强行套用偏好的句式。`,
    );
  }

  if (candidates && candidates.length > 0) {
    const candDesc = candidates.map(c => `${c.label}${c.description ? `(${c.description})` : ""}`).join(" / ");
    lines.push(`该字段有候选选项: ${candDesc}`);
    lines.push(`可以在反问中顺带提一下这些选项，让用户直接选。`);
  }

  if (targetField.defaultValue !== undefined) {
    lines.push(`默认值: ${String(targetField.defaultValue)}（可以用"我先按 ${String(targetField.defaultValue)} 来，你看着改？"的方式）`);
  } else {
    lines.push(`此字段无默认值，需用户明确回答。`);
  }

  lines.push(`请用自然的口语生成一个追问，不要像表单。措辞要和之前的轮次有变化。`);

  const prompt = lines.join("\n\n");

  const result = await callLLMWithGuard(repo, provider, {
    userId,
    purpose: "grill_clarify",
    system: CLARIFICATION_SYSTEM,
    prompt,
    maxTokens: 300,
    projectId: ctx.projectId,
  });

  if (!result || !result.json) {
    // 降级：用纯代码反问
    return fallbackClarification(targetField, round, ctx.metadata?.preferenceHints);
  }

  const question = readJsonField<string>(result.json, "question");
  if (typeof question === "string" && question.trim()) {
    return { question: question.trim(), targetField: targetField.name };
  }

  // 如果 LLM 返回了纯文本（非 JSON），直接用
  if (result.content && result.content.trim()) {
    const text = result.content.trim();
    // 去掉可能的 markdown 代码块标记
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    if (cleaned) {
      return { question: cleaned, targetField: targetField.name };
    }
  }

  return fallbackClarification(targetField, round, ctx.metadata?.preferenceHints);
}

/** 纯代码兜底反问，零 LLM。根据轮次变换措辞。 */
function fallbackClarification(field: FieldSpec, round: number = 1, prefHints?: string): ClarificationResult {
  // 有偏好提示时，提供参考但不强制套用
  if (prefHints) {
    const prefVariations = [
      `关于${field.description}，你之前偏好${prefHints}，想沿用这个方向还是换一种？`,
      `你之前的偏好是${prefHints}。这次需要什么${field.description}？可以延续偏好的方向，也可以换口味。`,
      `按你之前的偏好（${prefHints}）来，还是想换个不一样的？`,
    ];
    return {
      question: prefVariations[round % prefVariations.length]!,
      targetField: field.name,
    };
  }

  const variations = [
    `我需要知道你的${field.description}，方便我给出更贴合的结果。`,
    `对了，你的${field.description}是什么？这样我能更精准。`,
    `还差一个信息——${field.description}，你有什么偏好吗？`,
    `最后确认下${field.description}，你说一下我就能开始了。`,
  ];
  const baseQuestion = variations[round % variations.length]!;

  if (field.defaultValue !== undefined) {
    const defaultVariations = [
      `我需要知道你的${field.description}。我先按「${String(field.defaultValue)}」来，你看着改？`,
      `关于${field.description}，我先默认「${String(field.defaultValue)}」，你觉得不合适随时改。`,
      `${field.description}这块，我先按「${String(field.defaultValue)}」走？你可以直接告诉我想要的。`,
    ];
    return {
      question: defaultVariations[round % defaultVariations.length]!,
      targetField: field.name,
    };
  }
  return {
    question: baseQuestion,
    targetField: field.name,
  };
}
