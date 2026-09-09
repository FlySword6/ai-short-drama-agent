/* ============================================================
   capability-status.ts — 「AI 能力状态」一处收敛（S46-A / 走查 P0-1）

   心智模型：每个能力 = 模型(有/无) × 档位(有/无) × 开关(启/停)。
   工作台(图片/视频)、实验室、剧本拆解页共用同一份判定与文案,
   消灭「设置页绿点 / 档位红字 / AI 辅助未启用」三种矛盾话术：
   - 模型维 = GET /api/v1/admin/config-status 槽位（登录即可读）；
   - 档位维 = capability-tiers 接口（空数组 = 未配置,裁决 4 不回落本地档）；
   - 开关维 = config-status 的 ai_gateway.enabled（仅 AI 辅助有开关）；
   - 角色口径：admin/operator 给「去配置」直达,member 写明缺哪一项、找管理员——
     不再对管理员说「请联系管理员」（死循环）;角色本身还没读到时（unknown）两条路都说,
     不拿「没读到」当「不是管理员」——网关挂掉时权限往往一起读不到,正是最容易说反的时刻。

   纯逻辑、零 DOM,node:test 直接 import（见 capability-status.test.ts）。
   ============================================================ */

import type { PlatformRoleForCopy } from "./operations";

/* ---------- 类型 ---------- */

/** ai_assist = 剧本拆解/提示词起草等 AI 辅助（LLM 网关）;image/video = 生成能力。 */
export type CapabilityKind = "image" | "video" | "ai_assist";
export type CapabilityDimension = "model" | "tier" | "switch";
/** ok=就绪;missing=未配置;off=已停用（仅开关维）;unknown=读取失败;na=该能力无此维。 */
export type DimensionState = "ok" | "missing" | "off" | "unknown" | "na";

export interface CapabilityStatus {
  kind: CapabilityKind;
  model: DimensionState;
  tier: DimensionState;
  switch: DimensionState;
  /** 模型显示名（仅管理员经 config-status 可见;成员/读取失败为 null）。 */
  modelName: string | null;
}

export interface ConfigStatusSlotView {
  key: string;
  configured: boolean;
  modelDisplayName?: string | null;
}

/** 合成一维所需的原始事实;整体读取失败时对应字段给 null（= unknown,不虚构）。 */
export interface CapabilityStatusFacts {
  kind: CapabilityKind;
  /** config-status 槽位表;读取失败 null。 */
  slots: ConfigStatusSlotView[] | null;
  /** AI 网关开关;读取失败 null（仅 ai_assist 消费）。 */
  aiGatewayEnabled: boolean | null;
  /** 档位接口结果：数组（空=未配置）;读取失败 null;ai_assist 传 null 但不被消费。 */
  tiers: readonly unknown[] | null;
}

export interface CapabilityProblem {
  dimension: CapabilityDimension;
  state: "missing" | "off" | "unknown";
}

export type CapabilityAction = "configure" | "contact_admin" | "retry" | null;

export interface CapabilityStatusCopy {
  title: string;
  detail: string;
  action: CapabilityAction;
}

/* ---------- 文案零件 ---------- */

export function capabilityLabel(kind: CapabilityKind): string {
  if (kind === "image") return "图片生成";
  if (kind === "video") return "视频生成";
  return "AI 辅助";
}

export function dimensionLabel(dimension: CapabilityDimension): string {
  if (dimension === "model") return "模型";
  if (dimension === "tier") return "档位";
  return "开关";
}

/** 缺项的用户语言描述（名词短语,可直接枚举）。 */
function problemNoun(problem: CapabilityProblem): string {
  if (problem.state === "unknown") return `${dimensionLabel(problem.dimension)}状态读取失败`;
  if (problem.dimension === "model") return "模型未配置";
  if (problem.dimension === "tier") return "生成档位未配置";
  return "开关未开启";
}

/* ---------- 判定 ---------- */

function slotFor(slots: readonly ConfigStatusSlotView[] | null, key: string): ConfigStatusSlotView | null {
  return slots?.find((slot) => slot.key === key) ?? null;
}

/** 三维合成：config-status 槽位（模型）× 档位接口（档位）× 网关开关（开关,仅 ai_assist）。 */
export function resolveCapabilityStatus(facts: CapabilityStatusFacts): CapabilityStatus {
  const slotKey = facts.kind === "ai_assist" ? "llm" : facts.kind;
  const slot = slotFor(facts.slots, slotKey);
  const model: DimensionState = facts.slots === null ? "unknown" : slot?.configured ? "ok" : "missing";
  const tier: DimensionState = facts.kind === "ai_assist"
    ? "na"
    : facts.tiers === null ? "unknown" : facts.tiers.length > 0 ? "ok" : "missing";
  const switchState: DimensionState = facts.kind === "ai_assist"
    ? (facts.aiGatewayEnabled === null ? "unknown" : facts.aiGatewayEnabled ? "ok" : "off")
    : "na";
  return {
    kind: facts.kind,
    model,
    tier,
    switch: switchState,
    modelName: slot?.modelDisplayName ?? null,
  };
}

/** 未就绪维度清单（ok/na 不算问题;unknown 单列——它是读取失败,不是缺配置）。 */
export function capabilityProblems(status: CapabilityStatus): CapabilityProblem[] {
  const problems: CapabilityProblem[] = [];
  const dims: Array<[CapabilityDimension, DimensionState]> = [
    ["model", status.model],
    ["tier", status.tier],
    ["switch", status.switch],
  ];
  for (const [dimension, state] of dims) {
    if (state === "missing" || state === "off") problems.push({ dimension, state });
    else if (state === "unknown") problems.push({ dimension, state: "unknown" });
  }
  return problems;
}

export function capabilityReady(status: CapabilityStatus): boolean {
  return capabilityProblems(status).length === 0;
}

/** 管理员口径（去配置直达）：只有确知是 admin/operator 才算;unknown 不在这儿判——见下面三分叉。 */
export function canConfigureCapability(role: PlatformRoleForCopy): boolean {
  return role === "admin" || role === "operator";
}

/* ---------- 状态条文案（用户语言;错误态必给出路） ---------- */

export function capabilityStatusCopy(
  status: CapabilityStatus,
  role: PlatformRoleForCopy,
): CapabilityStatusCopy {
  const problems = capabilityProblems(status);
  const label = capabilityLabel(status.kind);
  if (problems.length === 0) {
    return { title: `${label}已就绪`, detail: "", action: null };
  }
  const onlyUnknown = problems.every((problem) => problem.state === "unknown");
  if (onlyUnknown) {
    return {
      title: `${label}状态读取失败`,
      detail: "配置状态没读上来，重试一次；还不行再找管理员。",
      action: "retry",
    };
  }
  const missing = problems.filter((problem) => problem.state !== "unknown").map(problemNoun);
  const suffix = problems.some((problem) => problem.state === "unknown") ? "；另有状态读取失败" : "";
  if (canConfigureCapability(role)) {
    return {
      title: `${label}还差一步`,
      detail: `缺${missing.join("、")}${suffix}。到「全局设置」配好对应项，这里会立即恢复。`,
      action: "configure",
    };
  }
  /* 还不知道这个人是谁的时候，两条路都摆出来：不假设他不是管理员
     （网关挂了正好也读不到权限，那会儿最不该对管理员说「请联系管理员」）。 */
  if (role === "unknown") {
    return {
      title: `${label}暂不可用`,
      detail: `缺${missing.join("、")}${suffix}。能配的话到「全局设置」配好对应项，否则找管理员开通，配好后这里会立即恢复。`,
      action: "configure",
    };
  }
  return {
    title: `${label}暂不可用`,
    detail: `缺${missing.join("、")}${suffix}。请找管理员开通，配好后这里会立即恢复。`,
    action: "contact_admin",
  };
}

/* ---------- 已知错误码 → 统一口径（toast 兜底,角色感知） ---------- */

/** ai 模块 503 与档位空表的用户语言解释;未知错误返回 null（调用方走原文）。 */
export function capabilityErrorCopy(
  error: { status?: number; code?: string } | null | undefined,
  role: PlatformRoleForCopy,
): string | null {
  if (!error || error.status !== 503) return null;
  /* 三分叉，不是二分叉：角色还没读到时两条路都说，不替接口把人判成非管理员。 */
  if (error.code === "ai_gateway_disabled") {
    if (canConfigureCapability(role)) return "AI 辅助未开启：到「全局设置」开启后再试";
    return role === "unknown"
      ? "AI 辅助未开启：到「全局设置」开启，或找管理员开启后再试"
      : "AI 辅助未开启，找管理员开启后再试";
  }
  if (error.code === "ai_gateway_not_configured") {
    if (canConfigureCapability(role)) return "AI 辅助模型未配置：到「全局设置」配好后再试";
    return role === "unknown"
      ? "AI 辅助模型未配置：到「全局设置」配好，或找管理员配好后再试"
      : "AI 辅助模型未配置，找管理员配好后再试";
  }
  return null;
}
