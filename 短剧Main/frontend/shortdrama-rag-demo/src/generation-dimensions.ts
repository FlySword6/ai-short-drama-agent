/* ============================================================
   generation-dimensions.ts — 生成参数维度引擎(S66,合同 v0.3.0 + R59 裁决)

   R59(DC 原话「档位难道不该是分开的吗,搞成个列表干什么?」):
   废除档位叉乘平铺列表 → 比例/清晰度/时长/数量/生成音频各是独立控件。
   铁律不变(合同 §1/§4):先有档,再有界面;没有档的参数组合,界面不给选。
   - 维度与可选值全部从 capability-tiers 接口的 active 档推导,不硬编码;
   - 用户改一个维度 → 按「共享维度一致」反查真实档,查无组合 = 该选项置灰;
   - 提交仍整档(tierSubmitInput),前后端参数逐键全等(后端 422 不蒙混);
   - 维度在全部 active 档上只有一个取值时 = 固定标签(合同 §4 单值形态),
     不做成看似可调的假控件。

   纯逻辑、零 DOM,node:test 直接 import(见 generation-dimensions.test.ts)。
   ============================================================ */

import { activeTiers, MORE_TIERS_NOTE, SINGLE_TIER_NOTE, tierModelLabel, type CapabilityMediaType, type CapabilityTier } from "./capability-tiers";

/* ---------- 维度定义 ---------- */

/** 用户可见的维度键。model_label 是档展示字段(安全投影,多模型接缝),其余是档 params 键(白名单,水印/组图等非用户维度不进)。 */
export type GenerationDimensionKey =
  | "model_label"
  | "aspect_ratio"
  | "resolution"
  | "duration_seconds"
  | "sample_rate"
  | "format"
  | "quantity"
  | "generate_audio";

export type GenerationDimensionValue = string | number | boolean;

export interface GenerationDimensionDef {
  key: GenerationDimensionKey;
  /** 维度行标签(libTV 口径:比例/清晰度/时长/数量/生成音频/模型)。 */
  label: string;
}

/** 各媒介的维度行顺序(libTV 参数 popover 口径:模型在最上,其余按使用频率)。 */
export const GENERATION_DIMENSION_DEFS: Record<CapabilityMediaType, readonly GenerationDimensionDef[]> = {
  image: [
    { key: "model_label", label: "模型" },
    { key: "aspect_ratio", label: "比例" },
    { key: "resolution", label: "清晰度" },
    { key: "quantity", label: "数量" },
  ],
  video: [
    { key: "model_label", label: "模型" },
    { key: "aspect_ratio", label: "比例" },
    { key: "resolution", label: "清晰度" },
    { key: "duration_seconds", label: "时长" },
    { key: "generate_audio", label: "生成音频" },
    { key: "quantity", label: "数量" },
  ],
  audio: [
    { key: "model_label", label: "模型" },
    { key: "sample_rate", label: "音质" },
    { key: "format", label: "格式" },
    { key: "duration_seconds", label: "时长" },
  ],
};

/* ---------- 档的维度取值 ---------- */

/** 档在某维度上的取值;档未声明该维度(params 无此键)时返回 undefined。
    模型维度取展示标签(model_label→display_name→tier_id 回落,见 tierModelLabel)。 */
export function tierDimensionValue(tier: CapabilityTier, key: GenerationDimensionKey): GenerationDimensionValue | undefined {
  if (key === "model_label") return tierModelLabel(tier);
  if (key === "duration_seconds") {
    // 视频档声明 duration_seconds,音频档声明 original_duration_seconds;统一读时长维度,一行两用。
    const value = tier.params.duration_seconds ?? tier.params.original_duration_seconds;
    if (typeof value === "number") return value;
    return undefined;
  }
  const value = tier.params[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

/** 档声明了的维度键集合(model_label 恒在,params 白名单键按实际声明)。 */
export function tierDeclaredKeys(tier: CapabilityTier, mediaType: CapabilityMediaType): GenerationDimensionKey[] {
  return GENERATION_DIMENSION_DEFS[mediaType]
    .map((def) => def.key)
    .filter((key) => tierDimensionValue(tier, key) !== undefined);
}

/* ---------- 维度选项推导(值域 = active 档实际数据) ---------- */

export interface GenerationDimensionOption {
  value: GenerationDimensionValue;
  label: string;
  /** 当前档的其他维度保持不变时,是否存在可取该值的 active 档;false = 组合查无档,界面置灰。 */
  feasible: boolean;
  /** 是否当前档的命中值(档未声明本维度时全 false)。 */
  selected: boolean;
}

export interface GenerationDimension {
  key: GenerationDimensionKey;
  label: string;
  options: GenerationDimensionOption[];
  /** 全部 active 档只有一个取值 → 固定标签形态(合同 §4,不做假可调控件)。 */
  single: boolean;
}

/** 两档在「除 exclude 外的共同声明维度」上是否全部一致(反查组合的一致性判据)。 */
function tiersAgreeOnSharedKeys(
  left: CapabilityTier,
  right: CapabilityTier,
  mediaType: CapabilityMediaType,
  exclude: GenerationDimensionKey,
): boolean {
  const shared = tierDeclaredKeys(left, mediaType).filter(
    (key) => key !== exclude && tierDimensionValue(right, key) !== undefined,
  );
  return shared.every((key) => tierDimensionValue(left, key) === tierDimensionValue(right, key));
}

/**
 * 维度表推导:数据源 = active 档(裁决:可选值以 capability_tiers 实际数据为准,不硬编码 libTV 全集)。
 * - 某维度在全部 active 档上无人声明 → 维度行不出现(如现行档均无 generate_audio);
 * - 选项置灰(feasible=false)判据:当前档其他维度不动,查无档能取该值;
 * - currentTier 为 null 时(档位未就绪)只列值域,全部未选中、按「存在即可选」处理。
 */
export function listGenerationDimensions(
  tiers: readonly CapabilityTier[],
  mediaType: CapabilityMediaType,
  currentTier: CapabilityTier | null,
): GenerationDimension[] {
  const active = activeTiers(tiers);
  const dimensions: GenerationDimension[] = [];
  for (const def of GENERATION_DIMENSION_DEFS[mediaType]) {
    const values: GenerationDimensionValue[] = [];
    for (const tier of active) {
      const value = tierDimensionValue(tier, def.key);
      if (value !== undefined && !values.includes(value)) values.push(value);
    }
    if (values.length === 0) continue;
    const currentValue = currentTier ? tierDimensionValue(currentTier, def.key) : undefined;
    dimensions.push({
      key: def.key,
      label: def.label,
      single: values.length === 1,
      options: values.map((value) => ({
        value,
        label: dimensionValueLabel(def.key, value, mediaType),
        feasible: currentTier
          ? active.some((tier) => tierDimensionValue(tier, def.key) === value
              && tiersAgreeOnSharedKeys(tier, currentTier, mediaType, def.key))
          : true,
        selected: currentValue !== undefined && currentValue === value,
      })),
    });
  }
  return dimensions;
}

/**
 * 维度 popover footer 判定（S83/V-36 → S83b 验收 R1 → S83d 子集误判修复）：footer 是
 * 「为什么不全可点」的诚实出路说明,三种状态三种口径——
 * - 有「查无组合」置灰项 → MORE_TIERS_NOTE,正好是置灰项的出路说明;
 * - 有单值维度（该维度在全部 active 档上只有一个取值,组件渲固定标签）→ 也要交代:
 *   全量维度全单值（=只有一档,demo 视频页签、真栈单档）用 SINGLE_TIER_NOTE 明说现状;
 *   否则用 MORE_TIERS_NOTE;
 * - 全部维度多值且无置灰 → 不显示（恒显「即将开放」是假话,S83 原判定保留）。
 * S83 只看置灰项,把单值状态的 footer 删成了「点不了也不说为什么」的死胡同,S83b 修复。
 *
 * S83d：「只有一档」(SINGLE_TIER_NOTE) 的判定必须吃全量维度 allDimensions,不许吃被切开的
 * 子集——模型 popover 的子集只有 model_label 一条维度,every(single) 恒真,会在五档齐开时对
 * 用户说「当前只开放这一档」(子集单值≠只有一档的当场假话)。dimensions 仍是本浮层自己的
 * 子集:置灰项与单值行各是各浮层的,要分开解释;allDimensions 只在判「是否单档」时用。
 */
export function dimensionPopoverFooter(
  dimensions: readonly GenerationDimension[],
  allDimensions: readonly GenerationDimension[],
): string | undefined {
  const hasInfeasibleOption = dimensions.some((dimension) => dimension.options.some((option) => !option.feasible));
  if (hasInfeasibleOption) return MORE_TIERS_NOTE;
  const hasSingleValueDimension = dimensions.some((dimension) => dimension.single);
  if (!hasSingleValueDimension) return undefined;
  return allDimensions.every((dimension) => dimension.single) ? SINGLE_TIER_NOTE : MORE_TIERS_NOTE;
}

/**
 * 维度反查:把 key 维度改成 value,其余维度尽量保持,返回命中档;查无组合返回 null(界面置灰,不给选)。
 * 命中多档时取「与当前档共同维度一致数最多」者(行为最贴近用户预期),并列按 tier_id 字典序取确定性结果。
 */
export function resolveDimensionPick(
  tiers: readonly CapabilityTier[],
  currentTier: CapabilityTier,
  mediaType: CapabilityMediaType,
  key: GenerationDimensionKey,
  value: GenerationDimensionValue,
): CapabilityTier | null {
  const candidates = activeTiers(tiers).filter((tier) => tierDimensionValue(tier, key) === value
    && tiersAgreeOnSharedKeys(tier, currentTier, mediaType, key));
  if (candidates.length === 0) return null;
  if (candidates.includes(currentTier)) return currentTier;
  const score = (tier: CapabilityTier): number => tierDeclaredKeys(tier, mediaType)
    .filter((sharedKey) => tierDimensionValue(currentTier, sharedKey) !== undefined
      && tierDimensionValue(currentTier, sharedKey) === tierDimensionValue(tier, sharedKey))
    .length;
  return [...candidates].sort((left, right) => score(right) - score(left) || left.tier_id.localeCompare(right.tier_id))[0]!;
}

/* ---------- 展示口径 ---------- */

/** 维度值标签:比例原样;清晰度原样(数据真源,不美化);时长「N 秒」;数量「N 张/个」;音频「开/关」;
    音质「48kHz」;格式大写;模型=展示标签原样。 */
export function dimensionValueLabel(key: GenerationDimensionKey, value: GenerationDimensionValue, mediaType: CapabilityMediaType = "image"): string {
  if (key === "duration_seconds") return `${Number(value)} 秒`;
  if (key === "quantity") return `${Number(value)} ${mediaType === "image" ? "张" : "个"}`;
  if (key === "generate_audio") return value === true ? "开" : "关";
  if (key === "sample_rate") return `${Number(value) / 1000}kHz`;
  if (key === "format") return String(value).toUpperCase();
  return String(value);
}

/**
 * 参数摘要条(libTV 口径「16:9 · 720P · 5s · 1个 · 🔊」):只拼当前档实际声明的维度——
   时长未声明的档不显示「0 秒」(S66 随 R59 一并修的显示 bug 同口径)。 */
export function tierDimensionSummary(tier: CapabilityTier): string {
  const parts: string[] = [];
  const ratio = tierDimensionValue(tier, "aspect_ratio");
  if (ratio !== undefined) parts.push(String(ratio));
  const resolution = tierDimensionValue(tier, "resolution");
  if (resolution !== undefined) parts.push(String(resolution));
  const duration = tierDimensionValue(tier, "duration_seconds");
  if (typeof duration === "number" && duration > 0) parts.push(`${duration} 秒`);
  const sampleRate = tierDimensionValue(tier, "sample_rate");
  if (typeof sampleRate === "number" && sampleRate > 0) parts.push(`${sampleRate / 1000}kHz`);
  const format = tierDimensionValue(tier, "format");
  if (typeof format === "string" && format.length > 0) parts.push(format.toUpperCase());
  const quantity = tierDimensionValue(tier, "quantity");
  if (typeof quantity === "number" && quantity > 0) parts.push(`${quantity} ${tier.media_type === "image" ? "张" : "个"}`);
  const audio = tierDimensionValue(tier, "generate_audio");
  if (audio === true) parts.push("🔊");
  if (audio === false) parts.push("🔇");
  return parts.join(" · ");
}

/* 模型短名(modelShortName)已随多模型接缝退役:服务端 model_label/display_name
   本身就是人读标签,前端不再从真实型号 id 派生展示名(SOL-009:真实 model id 不出后端)。 */
