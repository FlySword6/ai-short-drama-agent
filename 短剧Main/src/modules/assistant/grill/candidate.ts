/**
 * CandidateGenerator —— 候选生成器（LLM 动态优先 + 预置兜底）
 *
 * 来源：grill-engine-design.md §2.2 + §8 阶段 1 步骤 1.5。
 * 逻辑：
 * - 始终优先用 LLM 生成针对性候选（结合上下文和偏好）
 * - LLM 失败时用 profile.fallbackCandidates 预置候选兜底
 * - 无预置候选时返回 null，调用方再降级到反问
 */

import type { AiCallRepository, AiCompletionProvider } from "../../ai/types.js";
import { callLLMWithGuard, readJsonField } from "./callLLMWithGuard.js";
import type { Candidate, ConversationContext, FieldSpec, TaskProfile } from "./types.js";

const CANDIDATE_SYSTEM = `你是一个候选生成器。用户的任务有一个字段信息不充分，需要给用户具体可挑的候选。
只输出严格 JSON，格式：{"candidates": [{"label": "简短标签", "description": "一句话描述", "value": "机器值"}]}
候选要求：具体可挑，不是"请补充描述"。候选要结合用户已提供的信息和偏好，有针对性。
每次生成的候选要有变化，不要总是返回相同的选项。`;

/**
 * 生成候选：始终优先 LLM 动态生成，LLM 失败时用预置候选兜底。
 * 返回 null 表示无法生成候选（调用方应降级到反问）。
 */
export async function generateCandidates(
  repo: AiCallRepository,
  provider: AiCompletionProvider,
  profile: TaskProfile,
  field: FieldSpec,
  intent: string,
  userId: string,
  ctx?: ConversationContext,
): Promise<Candidate[] | null> {
  // 已收集的字段
  const collectedFields = ctx?.ephemeralFields
    ? Object.entries(ctx.ephemeralFields).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
      )
    : [];

  const contextSummary = collectedFields.length > 0
    ? collectedFields.map(([k, v]) => `${k}=${String(v)}`).join(", ")
    : "（暂无）";

  // 构建 LLM prompt
  const prompt = [
    `用户意图: ${intent}`,
    `已收集的信息: ${contextSummary}`,
    `需要候选的字段: ${field.name} (${field.description})`,
  ];

  const prefHints = ctx?.metadata?.preferenceHints;
  if (prefHints) {
    prompt.push(`用户注册时填写的偏好: ${prefHints}`);
    prompt.push(
      `可参考用户偏好作为方向建议，但候选必须优先匹配用户意图中的主题和语境。` +
      `当用户意图与注册偏好明显不匹配时（如用户说"老奶奶过马路"但偏好是"江湖武侠"），` +
      `应以用户意图的实际语境为准，生成日常/生活/温情等匹配主题的候选，不要强制套用偏好。`,
    );
  }

  prompt.push(
    `请基于以上信息，生成 ${profile.candidateCount} 个有针对性、多样化的候选。`,
    `注意：候选应该根据当前对话上下文动态变化，不要总是返回相同的选项。`,
  );

  // 始终优先 LLM 生成
  const result = await callLLMWithGuard(repo, provider, {
    userId,
    purpose: "grill_candidate",
    system: CANDIDATE_SYSTEM,
    prompt: prompt.join("\n\n"),
    maxTokens: 500,
    projectId: ctx?.projectId,
  });

  if (!result) {
    console.error("[GrillCandidate] callLLMWithGuard returned null (reserve failed or LLM call failed)");
  } else if (!result.json) {
    console.error("[GrillCandidate] LLM returned non-JSON content, content length:", result.content.length);
  }

  if (result?.json) {
    const rawCandidates = readJsonField<unknown[]>(result.json, "candidates");
    if (!Array.isArray(rawCandidates)) {
      console.error("[GrillCandidate] LLM JSON missing 'candidates' array. Keys:", Object.keys(result.json));
    }
    if (Array.isArray(rawCandidates)) {
      const candidates: Candidate[] = [];
      let rejectCount = 0;
      for (const raw of rawCandidates) {
        if (
          raw && typeof raw === "object" && !Array.isArray(raw)
          && typeof (raw as Record<string, unknown>).label === "string"
          && typeof (raw as Record<string, unknown>).description === "string"
          && "value" in raw
        ) {
          candidates.push({
            label: String((raw as Record<string, unknown>).label),
            description: String((raw as Record<string, unknown>).description),
            value: (raw as Record<string, unknown>).value,
          });
        } else {
          rejectCount++;
          console.error(`[GrillCandidate] Rejected candidate: label=${typeof (raw as Record<string, unknown> | undefined)?.label}, desc=${typeof (raw as Record<string, unknown> | undefined)?.description}, hasValue=${raw != null && typeof raw === "object" && "value" in (raw as Record<string, unknown>)}`);
        }
      }
      if (rejectCount > 0) {
        console.error(`[GrillCandidate] ${rejectCount} of ${rawCandidates.length} candidates rejected by validation`);
      }
      if (candidates.length >= 2) {
        return candidates.slice(0, profile.candidateCount);
      }
      console.error(`[GrillCandidate] Only ${candidates.length} valid candidates parsed from LLM (need >=2)`);
    }
  }

  console.error("[GrillCandidate] Falling back to preset candidates for field:", field.name);
  // LLM 失败 → 用预置候选兜底
  const preset = profile.fallbackCandidates?.[field.name];
  if (preset && preset.length > 0) {
    // 有偏好时，提供偏好方向供参考（不强制作为首选）
    if (prefHints) {
      const prefCandidate: Candidate = {
        label: `按偏好走（${prefHints}）`,
        description: `延续你的偏好方向，若与当前主题不符可选其他`,
        value: "__use_preference__",
      };
      return [prefCandidate, ...preset.slice(0, profile.candidateCount - 1)];
    }
    return preset.slice(0, profile.candidateCount);
  }

  return null;
}
