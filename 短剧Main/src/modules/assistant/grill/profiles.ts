/**
 * TaskProfile 注册表 —— 场景配置注册
 *
 * 来源：grill-engine-design.md §8 阶段 1 步骤 1.7。
 * 阶段 1 注册两个场景：registration（注册引导）+ content_creation（创作补全）。
 * script_breakdown 场景在阶段 2 接入。
 */

import type { TaskProfile, TaskType } from "./types.js";

// ── 注册引导场景 ──────────────────────────────────────────

const registrationProfile: TaskProfile = {
  taskType: "registration",
  requiredFields: [
    {
      name: "preferred_genre",
      description: "你最喜欢看的短剧题材",
      priority: "critical",
      usage: "persist",
      extractor: "enum",
      knownEnums: ["sweet", "rebirth", "ancient"],
    },
    {
      name: "user_role",
      description: "你的角色（编剧/导演/制片）",
      priority: "preferred",
      defaultValue: "screenwriter",
      usage: "persist",
      extractor: "enum",
      knownEnums: ["screenwriter", "director", "producer"],
    },
    {
      name: "preferred_tone",
      description: "你偏好的整体调性",
      priority: "preferred",
      defaultValue: "热血",
      usage: "persist",
      extractor: "llm",
    },
  ],
  maxClarifications: 2,
  maxTotalRounds: 6,
  maxSubjectDepth: 2,
  candidateCount: 3,
  fallbackCandidates: {
    preferred_genre: [
      { label: "甜宠", description: "现代都市甜宠，轻松恋爱向", value: "sweet" },
      { label: "重生复仇", description: "重生逆袭，打脸爽文向", value: "rebirth" },
      { label: "古风权谋", description: "古代背景，权谋斗争向", value: "ancient" },
    ],
    user_role: [
      { label: "编剧", description: "以分镜和叙事节奏视角参与", value: "screenwriter" },
      { label: "导演", description: "以镜头调度和画面感视角参与", value: "director" },
      { label: "制片", description: "以进度和资源可执行性视角参与", value: "producer" },
    ],
    preferred_tone: [
      { label: "热血", description: "节奏快、冲突强、爽感足", value: "hot_blooded" },
      { label: "治愈", description: "节奏缓、情感细腻、暖心向", value: "healing" },
      { label: "悬疑", description: "节奏紧、反转多、烧脑向", value: "suspense" },
    ],
  },
};

// ── 创作补全场景 ──────────────────────────────────────────

const contentCreationProfile: TaskProfile = {
  taskType: "content_creation",
  maxClarifications: 2,
  maxTotalRounds: 6,
  maxSubjectDepth: 2,
  candidateCount: 3,
  requiredFields: [
    {
      name: "content_type",
      description: "内容类型（图片/视频/文案等）",
      priority: "critical",
      usage: "ephemeral",
      extractor: "enum",
      knownEnums: ["video", "image", "text"],
    },
    {
      name: "subject_or_theme",
      description: "主题或题材方向",
      priority: "critical",
      usage: "ephemeral",
      extractor: "llm",
    },
    {
      name: "style_or_tone",
      description: "风格或调性",
      priority: "critical",
      usage: "ephemeral",
      extractor: "llm",
    },
    {
      name: "constraints",
      description: "约束条件（尺寸、时长、规格等）",
      priority: "preferred",
      defaultValue: "标准规格",
      usage: "ephemeral",
      extractor: "llm",
    },
  ],
  fallbackCandidates: {
    content_type: [
      { label: "视频", description: "生成短视频片段", value: "video" },
      { label: "图片", description: "生成单张图片", value: "image" },
      { label: "文案", description: "生成文字内容", value: "text" },
    ],
    subject_or_theme: [
      { label: "都市情感", description: "现代都市背景的恋爱/职场故事", value: "urban_romance" },
      { label: "古风穿越", description: "古代或穿越题材，宫斗/权谋", value: "ancient_time_travel" },
      { label: "悬疑推理", description: "烧脑反转，案件侦破向", value: "mystery" },
      { label: "热血励志", description: "逆袭成长，打脸爽文向", value: "hot_blooded" },
    ],
    style_or_tone: [
      { label: "写实电影感", description: "冷色调，强光影", value: "realistic_cinematic" },
      { label: "二次元插画", description: "高饱和，柔和线稿", value: "anime_illustration" },
      { label: "水墨国风", description: "留白，淡彩", value: "ink_wash" },
    ],
  },
};

// ── 注册表 ────────────────────────────────────────────────

const registry = new Map<TaskType, TaskProfile>([
  ["registration", registrationProfile],
  ["content_creation", contentCreationProfile],
]);

/** 按 TaskType 获取 TaskProfile。 */
export function getTaskProfile(taskType: TaskType): TaskProfile | undefined {
  return registry.get(taskType);
}

/**
 * 将 enum 字段的存储值映射回中文标签。
 * 例如 preferred_genre 的 "rebirth" → "重生复仇"。
 * 如果找不到映射，原样返回 value。
 */
export function enumValueToLabel(
  taskType: TaskType,
  fieldName: string,
  value: string,
): string {
  const profile = registry.get(taskType);
  if (!profile?.fallbackCandidates) return value;
  const candidates = profile.fallbackCandidates[fieldName];
  if (!candidates) return value;
  const match = candidates.find((c) => c.value === value);
  return match?.label ?? value;
}

/** 获取所有已注册的 TaskType。 */
export function getRegisteredTaskTypes(): TaskType[] {
  return [...registry.keys()];
}
