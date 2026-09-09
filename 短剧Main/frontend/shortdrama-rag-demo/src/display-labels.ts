/* ============================================================
   display-labels.ts — 业务语言化（#18）：技术标识 → 用户可见中文标签

   判据：用户可见处不出现厂商型号原串、snake_case 内部名。
   三类标识：AI 服务商（provider）、模型型号（model）、助手工具名（tool）。

   原则：
   - 已知值 → 中文标签（按能力说话：图片生成模型/视频生成模型/对话模型…）；
   - 未知值 → 中性兜底，原始值由 *RawTitle 放进 title 悬浮说明，
     既不裸显也不吞掉（与 assetKindLabel/assetKindRawTitle 同套口径）。
   ============================================================ */

/** 服务商内部标识 → 中文服务名。 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  ark: "火山方舟",
  openspeech: "语音合成服务",
};

/** 型号特征串 → 能力中文名（includes 命中即返，产品族在前、对话族在后）。 */
const MODEL_FEATURE_LABELS: readonly [feature: string, label: string][] = [
  ["seedream", "图片生成模型"],
  ["seedance", "视频生成模型"],
  ["doubao", "对话模型"],
  ["openspeech", "语音合成模型"],
  ["tts", "语音合成模型"],
];

/** 助手工具名 → 中文动作（与 app.tsx 助手面板同口径，未知→「工具调用」）。 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  search_assets: "检索资产",
  add_project_asset: "加入项目资产",
  generate_media: "准备生成",
  get_generation_task: "查询任务",
  draft_episode_outline: "起草分集大纲",
};

function normalize(value?: string | null): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** 服务商中文标签：空值→「—」由调用方决定；未知→「平台服务」（原值进 title）。 */
export function providerLabel(provider?: string | null): string {
  const key = normalize(provider);
  if (!key) return "—";
  return PROVIDER_LABELS[key] ?? "平台服务";
}

/** 服务商原值悬浮说明：已识别/空 → undefined；未识别 → 原值。 */
export function providerRawTitle(provider?: string | null): string | undefined {
  const key = normalize(provider);
  if (!key || PROVIDER_LABELS[key]) return undefined;
  return provider?.trim() || undefined;
}

/** 型号中文标签：空值→「—」；特征命中→能力名；未知→「平台模型」（原值进 title）。 */
export function modelDisplayLabel(model?: string | null): string {
  const key = normalize(model);
  if (!key) return "—";
  for (const [feature, label] of MODEL_FEATURE_LABELS) {
    if (key.includes(feature)) return label;
  }
  return "平台模型";
}

/** 型号原值悬浮说明：特征命中/空 → undefined；未识别 → 原值。 */
export function modelRawTitle(model?: string | null): string | undefined {
  const key = normalize(model);
  if (!key) return undefined;
  for (const [feature] of MODEL_FEATURE_LABELS) {
    if (key.includes(feature)) return undefined;
  }
  return model?.trim() || undefined;
}

/** 工具名中文标签：空值→「工具调用」；未知→「工具调用」（原值进 title）。 */
export function toolNameLabel(name?: string | null): string {
  const key = normalize(name);
  if (!key) return "工具调用";
  return TOOL_LABELS[key] ?? "工具调用";
}

/** 工具名原值悬浮说明：已识别/空 → undefined；未识别 → 原值。 */
export function toolNameRawTitle(name?: string | null): string | undefined {
  const key = normalize(name);
  if (!key || TOOL_LABELS[key]) return undefined;
  return name?.trim() || undefined;
}
