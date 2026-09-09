/**
 * 提示词完整度预检评分器 — 纯规则引擎,零 LLM 调用。
 * 规划文档: docs/planning/generation-precheck-cost-control.md §5.1
 *
 * 6 维评分,加权总分 0–100。同一输入永远同一输出(确定性)。
 * 不硬阻止提交:低分仍然能点生成,只给红色醒目提示。
 */

import { randomUUID } from "node:crypto";
import type { GenerationMediaKind } from "./types.js";
import type { PrecheckResult, PromptDimensionScore } from "./types.js";

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export interface PrecheckInput {
  /** 服务端编译的自动段 (compileAutoPrompt 产物) */
  autoPrompt: string;
  /** 用户手写补充段 (可空) */
  manualPrompt?: string;
  /** 角色描述列表,每角色一条(名字+特征) */
  characterDescriptions: string[];
  /** 场景描述文本 */
  sceneDescription?: string;
  /** 镜头意图文本 (shots.directorPrompt / breakdownElements 组合) */
  shotIntent: string;
  /** 参考控制包栏位总数 */
  referenceLaneCount: number;
  /** 已填栏位数 */
  filledLaneCount: number;
  /** 自定义负面提示词 (可空,无则仅有默认词表) */
  negativePrompt?: string;
  /** 媒体类型 (image / video / audio) */
  mediaKind: GenerationMediaKind;
}

// ---------------------------------------------------------------------------
// 维度权重 (附录 B)
// ---------------------------------------------------------------------------

interface DimensionWeight {
  key: string;
  label: string;
  weight: number;
}

/** video 对 shot_intent 权重略高, character_description 略降 */
const DIMENSIONS_IMAGE: DimensionWeight[] = [
  { key: "character_description", label: "角色描述", weight: 0.25 },
  { key: "scene_description", label: "场景描述", weight: 0.20 },
  { key: "shot_intent", label: "镜头意图", weight: 0.25 },
  { key: "reference_materials", label: "参考素材", weight: 0.15 },
  { key: "negative_constraints", label: "约束与排除", weight: 0.10 },
  { key: "prompt_length", label: "提示词充分度", weight: 0.05 },
];

const DIMENSIONS_VIDEO: DimensionWeight[] = [
  { key: "character_description", label: "角色描述", weight: 0.20 },
  { key: "scene_description", label: "场景描述", weight: 0.20 },
  { key: "shot_intent", label: "镜头意图", weight: 0.30 },
  { key: "reference_materials", label: "参考素材", weight: 0.15 },
  { key: "negative_constraints", label: "约束与排除", weight: 0.10 },
  { key: "prompt_length", label: "提示词充分度", weight: 0.05 },
];

const DIMENSIONS_AUDIO: DimensionWeight[] = [
  { key: "character_description", label: "角色描述", weight: 0.15 },
  { key: "scene_description", label: "场景描述", weight: 0.10 },
  { key: "shot_intent", label: "镜头意图", weight: 0.20 },
  { key: "reference_materials", label: "参考素材", weight: 0.10 },
  { key: "negative_constraints", label: "约束与排除", weight: 0.15 },
  { key: "prompt_length", label: "提示词充分度", weight: 0.30 },
];

function getDimensionWeights(mediaKind: GenerationMediaKind): DimensionWeight[] {
  if (mediaKind === "video") return DIMENSIONS_VIDEO;
  if (mediaKind === "audio") return DIMENSIONS_AUDIO;
  return DIMENSIONS_IMAGE;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 按 Unicode 标量值计数,与 promptCompiler 的 charLength 一致 */
function charLength(text: string): number {
  return [...text].length;
}

function statusFromScore(score: number): PromptDimensionScore["status"] {
  if (score >= 80) return "good";
  if (score >= 40) return "ok";
  if (score > 0) return "weak";
  return "missing";
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 线性插值 [minLen, maxLen] → [minScore, maxScore] */
function linearScore(
  length: number,
  minLen: number,
  maxLen: number,
  minScore: number,
  maxScore: number,
): number {
  if (length >= maxLen) return maxScore;
  if (length <= minLen) return minScore;
  const ratio = (length - minLen) / (maxLen - minLen);
  return Math.round(minScore + ratio * (maxScore - minScore));
}

// ---------------------------------------------------------------------------
// 各维度评分
// ---------------------------------------------------------------------------

/**
 * 角色描述: ≥2 条有特征 → 100; 仅有名字 → 50; 无 → 0
 * "有特征" = 描述文本长度 > 名字本身 + 至少 5 个字符
 */
function scoreCharacterDescriptions(
  descriptions: string[],
): { score: number; detail: string; suggestion?: string } {
  if (descriptions.length === 0) {
    return {
      score: 0,
      detail: "无角色描述",
      suggestion: "在参考控制包角色栏登记角色名字与外貌、服装特征",
    };
  }
  const withTraits = descriptions.filter((desc) => {
    const trimmed = desc.trim();
    if (!trimmed) return false;
    // 名字通常 ≤ 10 字,特征描述会在名字之外追加
    return charLength(trimmed) > 10;
  });

  if (withTraits.length >= 2) {
    return { score: 100, detail: `已有 ${withTraits.length} 位角色含特征描述` };
  }
  if (withTraits.length === 1) {
    return {
      score: 60,
      detail: `仅 1 位角色有特征描述,共 ${descriptions.length} 条`,
      suggestion: "为每个角色补充外貌、服装、表情等特征,建议每角色 10–30 字",
    };
  }
  // 有角色名但无特征
  return {
    score: 50,
    detail: `有 ${descriptions.length} 位角色名字,但无特征描述`,
    suggestion: "为每角色补充外貌、服装、表情等特征",
  };
}

/**
 * 场景描述: ≥50 字 → 100; 10–50 → 线性; <10 → 20; 空 → 0
 */
function scoreSceneDescription(
  description: string | undefined,
): { score: number; detail: string; suggestion?: string } {
  const text = description?.trim() ?? "";
  if (!text) {
    return {
      score: 0,
      detail: "无场景描述",
      suggestion: "补充场景的环境、光线、氛围描述,建议 50 字以上",
    };
  }
  const len = charLength(text);
  if (len >= 50) return { score: 100, detail: `场景描述 ${len} 字` };
  if (len >= 10) {
    return {
      score: linearScore(len, 10, 50, 30, 100),
      detail: `场景描述 ${len} 字,建议补充到 50 字以上`,
      suggestion: "补充光线、氛围、时间等细节",
    };
  }
  return {
    score: 20,
    detail: `场景描述仅 ${len} 字`,
    suggestion: "场景描述过短,建议补充环境、光线、氛围等",
  };
}

// 镜头意图关键词
const ACTION_KEYWORDS = [
  "推", "拉", "摇", "移", "跟", "俯", "仰", "正反打", "特写", "全景", "中景",
  "远景", "近景", "运镜", "镜头", "slow motion", "慢动作", "变焦", "转场",
];

function scoreShotIntent(
  intent: string,
): { score: number; detail: string; suggestion?: string } {
  const text = intent.trim();
  if (!text) {
    return {
      score: 0,
      detail: "无镜头意图",
      suggestion: "补充运镜方向、构图、动作描述,建议 15–30 字",
    };
  }
  const len = charLength(text);
  const hasAction = ACTION_KEYWORDS.some((kw) => text.includes(kw));
  // 只有时间码 (纯数字+冒号)
  const isOnlyTimecode = /^\d{1,2}:\d{2}([.,]\d+)?$/.test(text);

  if (hasAction && len >= 15) {
    return { score: 100, detail: `镜头意图含动作/运镜描述,${len} 字` };
  }
  if (hasAction) {
    return {
      score: 70,
      detail: `镜头意图含运镜关键词但偏短,${len} 字`,
      suggestion: "补充构图或动作细节,建议 15–30 字",
    };
  }
  if (isOnlyTimecode) {
    return {
      score: 20,
      detail: "镜头意图仅含时间码",
      suggestion: "补充运镜方向、构图、动作描述",
    };
  }
  return {
    score: 40,
    detail: `镜头意图仅有基本描述,${len} 字`,
    suggestion: "补充运镜方向(推/拉/摇/移等)或构图关键词",
  };
}

/**
 * 参考素材: filled / total 比例 × 100
 */
function scoreReferenceMaterials(
  filled: number,
  total: number,
): { score: number; detail: string; suggestion?: string } {
  if (total === 0) {
    return {
      score: 0,
      detail: "未配置参考栏位",
      suggestion: "在参考控制包中添加角色、场景、道具等参考素材",
    };
  }
  const ratio = filled / total;
  const score = Math.round(ratio * 100);
  if (score >= 100) {
    return { score: 100, detail: `已填 ${filled}/${total} 栏位` };
  }
  const missing = total - filled;
  return {
    score,
    detail: `已填 ${filled}/${total} 栏位,缺 ${missing} 类`,
    suggestion: `再上传 ${missing} 类参考素材可提升出片质量`,
  };
}

/**
 * 约束与排除: 自定义负面词 >10 字 → 100; 仅默认词表 → 60; 无 → 0
 */
function scoreNegativeConstraints(
  negativePrompt: string | undefined,
): { score: number; detail: string; suggestion?: string } {
  const text = negativePrompt?.trim() ?? "";
  if (!text) {
    return {
      score: 60,
      detail: "仅使用默认负面词表",
      suggestion: "可补充自定义排除项(如特定风格、元素)以提升精确度",
    };
  }
  const len = charLength(text);
  if (len > 10) {
    return { score: 100, detail: `自定义负面约束 ${len} 字` };
  }
  return {
    score: 80,
    detail: `自定义负面约束仅 ${len} 字`,
    suggestion: "负面约束过短,建议补充更多排除项",
  };
}

/**
 * 提示词充分度: ≥300 字 → 100; 100–300 → 线性; <100 → 20; 空 → 0
 */
function scorePromptLength(
  autoPrompt: string,
  manualPrompt: string | undefined,
): { score: number; detail: string; suggestion?: string } {
  const total = charLength(autoPrompt.trim()) + charLength(manualPrompt?.trim() ?? "");
  if (total === 0) {
    return {
      score: 0,
      detail: "提示词为空",
      suggestion: "编写提示词或等待自动段编译完成",
    };
  }
  if (total >= 300) return { score: 100, detail: `提示词总长 ${total} 字` };
  if (total >= 100) {
    return {
      score: linearScore(total, 100, 300, 50, 100),
      detail: `提示词总长 ${total} 字,建议达到 300 字以上`,
      suggestion: "补充更多描述细节以提升生成质量",
    };
  }
  return {
    score: 20,
    detail: `提示词总长仅 ${total} 字`,
    suggestion: "提示词过短,建议补充到至少 100 字",
  };
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

export function evaluatePromptCompleteness(input: PrecheckInput): PrecheckResult {
  const weights = getDimensionWeights(input.mediaKind);

  const charResult = scoreCharacterDescriptions(input.characterDescriptions);
  const sceneResult = scoreSceneDescription(input.sceneDescription);
  const shotResult = scoreShotIntent(input.shotIntent);
  const refResult = scoreReferenceMaterials(input.filledLaneCount, input.referenceLaneCount);
  const negResult = scoreNegativeConstraints(input.negativePrompt);
  const lenResult = scorePromptLength(input.autoPrompt, input.manualPrompt);

  const scoreMap: Record<string, { score: number; detail: string; suggestion?: string }> = {
    character_description: charResult,
    scene_description: sceneResult,
    shot_intent: shotResult,
    reference_materials: refResult,
    negative_constraints: negResult,
    prompt_length: lenResult,
  };

  const dimensions: PromptDimensionScore[] = weights.map((dim) => {
    const result = scoreMap[dim.key]!;
    return {
      key: dim.key,
      label: dim.label,
      score: clampScore(result.score),
      weight: dim.weight,
      status: statusFromScore(result.score),
      detail: result.detail,
      ...(result.suggestion ? { suggestion: result.suggestion } : {}),
    };
  });

  // 加权总分
  const overallScore = clampScore(
    dimensions.reduce((sum, d) => sum + d.score * d.weight, 0),
  );

  // 缺失的参考栏位
  const missingReferences: string[] = [];
  if (input.referenceLaneCount === 0) {
    missingReferences.push("角色", "场景", "道具");
  } else if (input.filledLaneCount < input.referenceLaneCount) {
    missingReferences.push(`还缺 ${input.referenceLaneCount - input.filledLaneCount} 类参考`);
  }

  // 优先级排序的改进建议
  const recommendations = dimensions
    .filter((d) => d.suggestion)
    .sort((a, b) => {
      // 优先级 = 低分维度先 + 高权重先
      const priorityA = (100 - a.score) * a.weight;
      const priorityB = (100 - b.score) * b.weight;
      return priorityB - priorityA;
    })
    .map((d) => d.suggestion!)
    .slice(0, 3);

  // 采样效果预估
  const estimatedSamplingEffect = {
    warning: overallScore < 30,
    ...(overallScore < 30
      ? { message: "提示词过短或结构不完整,样片可能也难以体现效果,建议先补全" }
      : {}),
  };

  return {
    overallScore,
    dimensions,
    autoPromptPreview: input.autoPrompt,
    missingReferences,
    recommendations,
    estimatedSamplingEffect,
    precheckId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}
