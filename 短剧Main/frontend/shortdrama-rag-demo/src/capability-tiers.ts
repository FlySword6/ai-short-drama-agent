/* ============================================================
   capability-tiers.ts — 模型能力档（合同 v0.3.0/model-capability-and-price-tiers.md）

   铁律（合同 §1/§4）：先有档,再有界面;没有档的参数组合,界面不给选。
   - 档是原子的：用户选的是档,不是自由拼参数；
   - 参数行渲染数据源 = GET /api/v1/generation/capability-tiers（登录即可读,已上线）；
     裁决 4：接口已上线,404/501 静默回落本地档的降级退役——任何接口错误原样抛给
     页面错误态如实显示;接口返回空数组 = 「档位未配置」错误（报 Sol,不静默用本地档）;
   - demo 模式走本地 fixture（不打降级标）：视频=合同附表已登记档；图片=S83(V-36) 起扩为
     同模型多档 fixture（DEMO_IMAGE_TIERS，S83b 起只用库里真实已登记档），否则单档下
     维度引擎数学上必然全 single,参数 popover 只剩固定标签（DC 判决 V-36「只是展示」的根因）；
   - 只有一个 active 档：参数行=固定标签（带档价）+ footer 如实交代「当前只开放这一档」,不可点；
   - 多档：档位选择器整档切换（本模块已备好选择逻辑,UI 随档数自动出现）。

   多模型接缝（SOL-20260803-009 / SOL-012/013,FABLE-007）：
   - 服务端档投影=安全展示字段 tier_id + display_name/provider_label/model_label/
     is_default/availability/capabilities + 不可变价;真实 provider/model 绑定不出后端;
   - 前端保存与提交只发 tier_id;展示只读上述标签字段;缺标签的档按 tier_id 如实显示,
     不得把缺字段的档错并成一个「configured」假值(旧 model_id 回落已退役);
   - 媒体类型三态 image/video/audio;计费单位 per_image/per_second/per_10k_characters
     (音频按万字符计价时展示不丢)。

   纯逻辑、零 DOM,node:test 直接 import（见 capability-tiers.test.ts）。
   ============================================================ */

import { ApiClientError, api } from "./api";

/* ---------- 合同 §2 数据形状 ---------- */

export type CapabilityTierStatus = "active" | "experimental" | "retired";
export type CapabilityMediaType = "image" | "video" | "audio";
export type CapabilityTierPriceUnit = "per_image" | "per_second" | "per_10k_characters";

export interface CapabilityTier {
  tier_id: string;
  media_type: CapabilityMediaType;
  /** 档展示名（服务端安全投影;无真实 provider/model 绑定）。 */
  display_name: string | null;
  /** 供应商展示标签（如「火山方舟」「MiniMax」;安全投影,非真实凭据绑定）。 */
  provider_label: string | null;
  /** 模型展示标签（如「seedream 5.0 pro」;安全投影,不是真实 model id）。 */
  model_label: string | null;
  is_default?: boolean;
  availability?: string;
  /** 冻结/未开通原因（后端给的中文人话，置灰时展示；#151 配置选项的灰档说明数据源）。 */
  availability_reason?: string;
  capabilities?: readonly string[];
  /** 提交 Provider 的完整参数组合（档是原子的,不拆单参数）。 */
  params: Record<string, string | number | boolean>;
  price: { unit: CapabilityTierPriceUnit; points: number };
  status: CapabilityTierStatus;
}

/* ---------- 初始档 fixture（合同附表已登记档=现状;仅 demo 模式与纯函数缺省使用,真栈绝不回落） ---------- */

export const FALLBACK_IMAGE_TIER: CapabilityTier = {
  tier_id: "img-seedream5pro-169-2k-1",
  media_type: "image",
  display_name: "Seedream 5 Pro",
  provider_label: "火山方舟",
  model_label: "Seedream 5 Pro",
  is_default: true,
  availability: "available",
  params: { aspect_ratio: "16:9", resolution: "2K", quantity: 1 },
  price: { unit: "per_image", points: 60 },
  status: "active",
};

export const FALLBACK_VIDEO_TIER: CapabilityTier = {
  tier_id: "vid-seedance20fast-916-720p-4s",
  media_type: "video",
  display_name: "Seedance 2.0 Fast",
  provider_label: "火山方舟",
  model_label: "Seedance 2.0 Fast",
  is_default: true,
  availability: "available",
  params: { aspect_ratio: "9:16", resolution: "720p", duration_seconds: 4 },
  price: { unit: "per_second", points: 80 },
  status: "active",
};

/** 音频 demo 档（seed audio 1.0,合同附表已登记;按秒计价）。 */
export const FALLBACK_AUDIO_TIER: CapabilityTier = {
  tier_id: "aud-seedaudio10-30s",
  media_type: "audio",
  display_name: "Seed Audio 1.0",
  provider_label: "火山语音",
  model_label: "Seed Audio 1.0",
  is_default: true,
  availability: "available",
  params: { original_duration_seconds: 30 },
  price: { unit: "per_second", points: 12 },
  status: "active",
};

/* S83(V-36) → S83b 返工（验收 R2）：demo 图片档 fixture 只用 dev 库 pricing_rules
   真实已登记的档——3 比例 × 1K(30 积分/张)/2K(60 积分/张)，真 tier_id 真价
   （合同 v0.3.0 附表 + scripts/seed-pricing-tiers.mts）。不造库外档、不自定价：
   上一轮的 4K 档「120 积分/张」与 2/4 张档在库里没有任何 pricing rule 支撑,已全部撤掉。
   6 条真档中缺省不放 1:1·1K(img-seedream5pro-11-1k-1)：用真 id 真价留一个「查无组合」
   缺口演示置灰（选 1:1 后 1K 灰；选 1K 后 1:1 灰），而不是编 4K。
   数量维度随之回到单值固定标签（库里图片档全部 qty=1）——这是数据事实,不是 UI 缺陷。
   首档 = FALLBACK_IMAGE_TIER（缺省选中口径不变）;只服务 demo 模式,真栈绝不回落（裁决 4）。 */
export const DEMO_IMAGE_TIERS: readonly CapabilityTier[] = [
  FALLBACK_IMAGE_TIER,
  { ...FALLBACK_IMAGE_TIER, tier_id: "img-seedream5pro-916-2k-1", is_default: false, params: { aspect_ratio: "9:16", resolution: "2K", quantity: 1 } },
  { ...FALLBACK_IMAGE_TIER, tier_id: "img-seedream5pro-11-2k-1", is_default: false, params: { aspect_ratio: "1:1", resolution: "2K", quantity: 1 } },
  { ...FALLBACK_IMAGE_TIER, tier_id: "img-seedream5pro-169-1k-1", is_default: false, params: { aspect_ratio: "16:9", resolution: "1K", quantity: 1 }, price: { unit: "per_image", points: 30 } },
  { ...FALLBACK_IMAGE_TIER, tier_id: "img-seedream5pro-916-1k-1", is_default: false, params: { aspect_ratio: "9:16", resolution: "1K", quantity: 1 }, price: { unit: "per_image", points: 30 } },
];

/* ---------- 视图逻辑 ---------- */

/** 计费单位中文（音频按万字符计价不丢:per_10k_characters→万字符）。 */
export function priceUnitLabel(unit: CapabilityTierPriceUnit): string {
  if (unit === "per_second") return "秒";
  if (unit === "per_10k_characters") return "万字符";
  return "张";
}

/** 档价标签：「60 积分/张」「80 积分/秒」「2 积分/万字符」;接口档价缺失（0）时不显示,不虚构价格。 */
export function tierPriceLabel(tier: CapabilityTier): string {
  if (!Number.isFinite(tier.price.points) || tier.price.points <= 0) return "";
  return `${tier.price.points} 积分/${priceUnitLabel(tier.price.unit)}`;
}

/** 档位标签：图片「16:9 · 2K · 1 张 · 60 积分/张」；视频「9:16 · 720p · 4 秒 · 80 积分/秒」；
    音频「30 秒 · 12 积分/秒」（合同 §4 示例口径+档价）。
    S66（R59 附带修）：档未声明时长时不虚构「0 秒」——时长段直接省略。 */
export function tierLabel(tier: CapabilityTier): string {
  const price = tierPriceLabel(tier);
  if (tier.media_type === "audio") {
    const duration = typeof tier.params.original_duration_seconds === "number" && tier.params.original_duration_seconds > 0
      ? `${tier.params.original_duration_seconds} 秒`
      : typeof tier.params.duration_seconds === "number" && tier.params.duration_seconds > 0
        ? `${tier.params.duration_seconds} 秒`
        : "";
    return [duration, price].filter(Boolean).join(" · ") || tier.tier_id;
  }
  const ratio = typeof tier.params.aspect_ratio === "string" ? tier.params.aspect_ratio : "";
  if (tier.media_type === "image") {
    const resolution = typeof tier.params.resolution === "string" ? tier.params.resolution : "";
    const quantity = typeof tier.params.quantity === "number" ? tier.params.quantity : 1;
    return [[ratio, resolution, `${quantity} 张`].filter(Boolean).join(" · "), price]
      .filter(Boolean)
      .join(" · ");
  }
  const resolution = typeof tier.params.resolution === "string" ? tier.params.resolution : "?";
  const duration = typeof tier.params.duration_seconds === "number" && tier.params.duration_seconds > 0
    ? `${tier.params.duration_seconds} 秒`
    : "";
  return [`${ratio} · ${resolution}`, duration, price].filter(Boolean).join(" · ");
}

/** 模型展示标签(多模型接缝):model_label → display_name → tier_id 逐级回落;
   缺标签时如实显示 tier_id,不再并成「configured」假值。 */
export function tierModelLabel(tier: CapabilityTier): string {
  return tier.model_label?.trim() || tier.display_name?.trim() || tier.tier_id;
}

/** demo 估价纯函数（S83/V-36）：按选中档档价如实推导——图片 档价×张数;视频/音频 档价×秒数;
    万字符档按 1 个计费单位估(字符数提交时才定,demo 不虚构)。真栈走 simpleEstimate,不用本函数。 */
export function demoEstimatePoints(tier: CapabilityTier): number {
  if (tier.price.unit === "per_10k_characters") return tier.price.points;
  const multiplier = tier.price.unit === "per_second"
    ? (typeof tier.params.duration_seconds === "number" ? tier.params.duration_seconds
      : typeof tier.params.original_duration_seconds === "number" ? tier.params.original_duration_seconds : 1)
    : (typeof tier.params.quantity === "number" ? tier.params.quantity : 1);
  return tier.price.points * multiplier;
}

/** 只渲染 active 档（experimental/retired 不上界面,合同 §4「没有档的参数组合,界面不给选」）。 */
export function activeTiers(tiers: readonly CapabilityTier[]): CapabilityTier[] {
  return tiers.filter((tier) => tier.status === "active");
}

/** v1.6.4(快乐马预览):预览档识别键 = params.preview===true(设计文档 §2.1/§3)。
    正式级联过滤预览档、预览弹窗只取预览档,共用这一个识别函数。 */
export function isPreviewTier(tier: CapabilityTier): boolean {
  return tier.params.preview === true;
}

/* ---------- #172：项目设定参与默认选档（批量弹窗与单镜面板同一来源） ---------- */

/** 项目生成设定里参与选档的两维；清晰度按媒介由调用方先选好（图片 1K/2K、视频 720p/1080p,不互相映射）。 */
export interface ProjectTierPreference {
  aspectRatio: string | null;
  resolution: string | null;
}

/** 可提交档：active 且未冻结（availability 缺省按可用,与 project-config 的选项口径一致）。 */
function submittableTiers(tiers: readonly CapabilityTier[]): CapabilityTier[] {
  return activeTiers(tiers).filter((tier) => tier.availability === undefined || tier.availability === "available");
}

/**
 * 项目设定推导默认档（#172）：
 * - 设了画幅+清晰度 → 完全匹配的可提交档里最便宜;
 * - 清晰度查无完全匹配 → 保画幅：同画幅可提交档里最便宜;
 * - 只设了一个维度 → 按该维度过滤后取最便宜;
 * - 完全没设定 / 设定查无可提交档 → null（调用方续走各自的全局缺省链,不伪造匹配）。
 * 同价并列按 tier_id 字典序取确定性结果。
 */
export function resolveProjectDefaultTier(
  tiers: readonly CapabilityTier[],
  preference: ProjectTierPreference | null,
): CapabilityTier | null {
  if (!preference) return null;
  const { aspectRatio, resolution } = preference;
  if (!aspectRatio && !resolution) return null;
  const pool = submittableTiers(tiers);
  const byPreference = (tier: CapabilityTier, withResolution: boolean): boolean =>
    (!aspectRatio || tier.params.aspect_ratio === aspectRatio)
    && (!withResolution || !resolution || tier.params.resolution === resolution);
  const exact = pool.filter((tier) => byPreference(tier, true));
  const candidates = exact.length > 0 ? exact : pool.filter((tier) => byPreference(tier, false));
  if (candidates.length === 0) return null;
  return [...candidates].sort((left, right) => left.price.points - right.price.points || left.tier_id.localeCompare(right.tier_id))[0]!;
}

/** 档位选择：active 档内按 tier_id 找；其后 #172 项目设定档;再缺省回落 is_default 档,最后首个 active 档。 */
export function resolveSelectedTier(
  tiers: readonly CapabilityTier[],
  selectedId: string | null,
  projectPreference?: ProjectTierPreference | null,
): CapabilityTier | null {
  const active = activeTiers(tiers);
  if (active.length === 0) return null;
  return active.find((tier) => tier.tier_id === selectedId)
    ?? resolveProjectDefaultTier(tiers, projectPreference ?? null)
    ?? active.find((tier) => tier.is_default === true)
    ?? active[0]!;
}

export const MORE_TIERS_NOTE = "更多档位即将开放";

/** 全维度单值（库内只有一个 active 档）时 popover footer 的如实现状说明（S83b 验收 R1）。 */
export const SINGLE_TIER_NOTE = "当前只开放这一档，更多档位即将开放";

/** 初始档表：demo 模式 fixture 与纯函数缺省档（真栈页面不得以它顶替接口结果——裁决 4）。 */
export const FALLBACK_TIERS: Record<CapabilityMediaType, readonly CapabilityTier[]> = {
  image: [FALLBACK_IMAGE_TIER],
  video: [FALLBACK_VIDEO_TIER],
  audio: [FALLBACK_AUDIO_TIER],
};

/** 档 → 生成提交参数（映射到后端现行 GenerationParameters/quantity 字段名；
 *  档外组合界面不给选,后端报价/创建按档校验,422 不蒙混）。 */
export function tierSubmitInput(tier: CapabilityTier): { parameters: Record<string, string | number | boolean>; quantity: number } {
  if (tier.media_type === "audio") {
    /* 音频档原子直通（original_duration_seconds 等档冻参数原样提交,不拆不编）。 */
    return { parameters: { ...tier.params }, quantity: 1 };
  }
  if (tier.media_type === "image") {
    const { aspect_ratio, resolution, quantity, ...rest } = tier.params;
    return {
      parameters: {
        ...rest,
        ...(typeof aspect_ratio === "string" ? { ratio: aspect_ratio } : {}),
        ...(typeof resolution === "string" ? { size: resolution } : {}),
      },
      quantity: typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 1 ? quantity : 1,
    };
  }
  const { aspect_ratio, resolution, duration_seconds, ...rest } = tier.params;
  return {
    parameters: {
      ...rest,
      ratio: typeof aspect_ratio === "string" ? aspect_ratio : "9:16",
      resolution: typeof resolution === "string" ? resolution : "720p",
      duration_seconds: typeof duration_seconds === "number" ? duration_seconds : 4,
    },
    quantity: 1,
  };
}

/* ---------- 拉取（裁决 4：接口已上线,不再静默回落本地档） ---------- */

export interface CapabilityTiersResult {
  tiers: CapabilityTier[];
  /** true=demo 模式 fixture（图片=S83 起多档,见 DEMO_IMAGE_TIERS;不算假数据,不打降级标）；真栈恒 false。 */
  fallback: boolean;
}

/** 接口返回空数组的口径（裁决 4）：不静默用本地档,页面错误态如实显示并报 Sol。
    S46-A：角色中立文案——对管理员说「请联系管理员」是死循环,改为「由管理员配置」，
    角色感知的话术（去配置直达/找管理员）由 capability-status 状态条承担。 */
export const TIER_UNCONFIGURED_MESSAGE = "生成档位未配置，由管理员配置后即可生成";
export const TIER_UNCONFIGURED_CODE = "capability_tiers_unconfigured";

const PRICE_UNITS: readonly string[] = ["per_image", "per_second", "per_10k_characters"];

/** 服务端原始行 → 合同形状（防御式;字段缺失的行整行丢弃,不凑数、不并假值）。
    多模型接缝:只收安全展示字段(tier_id/display_name/provider_label/model_label/...);
    真实 provider/model 绑定不应出现在 wire 上,出现了也不读(字段黑名单见合同测试)。 */
function tierFromRaw(value: Record<string, unknown>): CapabilityTier | null {
  const tierId = typeof value.tier_id === "string" ? value.tier_id : "";
  const mediaType = value.media_type === "image" || value.media_type === "video" || value.media_type === "audio" ? value.media_type : null;
  const params = value.params && typeof value.params === "object" && !Array.isArray(value.params)
    ? value.params as CapabilityTier["params"]
    : null;
  const status = value.status === "active" || value.status === "experimental" || value.status === "retired" ? value.status : null;
  if (!tierId || !mediaType || !params || !status) return null;
  const priceRaw = value.price && typeof value.price === "object" ? value.price as Record<string, unknown> : {};
  const unit = typeof priceRaw.unit === "string" && PRICE_UNITS.includes(priceRaw.unit) ? priceRaw.unit as CapabilityTierPriceUnit : "per_image";
  return {
    tier_id: tierId,
    media_type: mediaType,
    display_name: typeof value.display_name === "string" ? value.display_name : null,
    provider_label: typeof value.provider_label === "string" ? value.provider_label : null,
    model_label: typeof value.model_label === "string" ? value.model_label : null,
    ...(value.is_default === true ? { is_default: true } : {}),
    ...(typeof value.availability === "string" ? { availability: value.availability } : {}),
    ...(typeof value.availability_reason === "string" ? { availability_reason: value.availability_reason } : {}),
    ...(Array.isArray(value.capabilities) ? { capabilities: value.capabilities.filter((item): item is string => typeof item === "string") } : {}),
    params,
    price: {
      unit,
      points: typeof priceRaw.points === "number" && Number.isFinite(priceRaw.points) ? priceRaw.points : 0,
    },
    status,
  };
}

/**
 * 拉取能力档：demo 模式走本地 fixture（图片=DEMO_IMAGE_TIERS 多档,视频/音频=初始单档）；真栈走合同接口。
 * 裁决 4：接口 404/501 降级退役——任何接口错误（含 404/501/网络/5xx）原样抛出,
 * 交页面错误态如实显示;接口返回空数组按「档位未配置」错误抛出（报 Sol）,
 * 都不静默回落本地档（本地档不是真档,拿它提交必 422,还会让界面假装可用）。
 */
export async function listCapabilityTiers(mediaType: CapabilityMediaType, demoMode: boolean, options?: { includeFrozen?: boolean }): Promise<CapabilityTiersResult> {
  if (demoMode) {
    return { tiers: mediaType === "image" ? [...DEMO_IMAGE_TIERS] : [...FALLBACK_TIERS[mediaType]], fallback: true };
  }
  const raw = await api.capabilityTiers(mediaType, options?.includeFrozen === true);
  const tiers = raw.map(tierFromRaw).filter((tier): tier is CapabilityTier => tier !== null);
  if (tiers.length === 0) throw new ApiClientError(TIER_UNCONFIGURED_MESSAGE, { code: TIER_UNCONFIGURED_CODE });
  return { tiers, fallback: false };
}
