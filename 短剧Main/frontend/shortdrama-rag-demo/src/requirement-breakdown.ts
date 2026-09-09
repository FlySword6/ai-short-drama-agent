/* ============================================================
   requirement-breakdown.ts — 「文字描述 → 生产需求拆解」纯逻辑层（K2 彩排包）

   契约状态：v0.2.0《文字描述 → 生产需求与控制包拆解契约》
   READY_FOR_FABLE_DECISION——**未批准**。本模块严守两条边界：
   1. 不私加契约字段：以下类型逐字对应契约 §4–§8（snake_case 归一成驼峰，
      与 api.ts 现有 FromUnknown 惯例一致）；契约没有的一律不进类型。
   2. 不接真后端：模块内只有纯逻辑与「彩排假 run 状态机」（rehearsal，
      全内存、零网络、fixture 由调用方注入）。api.ts 的八个函数等
      Fable 批准契约后另包进行，本文件不 import api.ts。

   决策中立设计（Fable 原话：「别把实现写死在某个选项上，给我留出改的余地」）：
   「已选候选解析」收敛成唯一纯函数 resolveSelectedCandidate——
   输入=已加载候选集合 + selected_candidate_id + 可选摘要；
   裁决①（已选候选必内嵌）生效时它自动走 resolved 分支，零改动；
   裁决②（详情加 selected_candidate 摘要字段）生效时页面把摘要传进
   第三个入参（一行），走 summary 分支；两个都没批的当前=placeholder
   中性占位，不伪造名字与缩略图。

   纯逻辑、零 DOM，node:test 直接 import（requirement-breakdown.test.ts）。
   ============================================================ */

import type { LaneDomainId, LaneVocabulary } from "./lane-vocabulary";

/* ---------- 契约形状（§4–§8，驼峰归一；未批准，不增不减） ---------- */

export type BreakdownScope =
  | { kind: "episode"; episodeId: string }
  | { kind: "scene"; sceneId: string }
  | { kind: "shot"; shotId: string }
  | { kind: "free_text"; projectId: string };

export type BreakdownScopeKind = BreakdownScope["kind"];

export type BreakdownRunStatus =
  | "queued"
  | "running"
  | "draft"
  | "failed"
  | "confirmed"
  | "discarded"
  | "superseded";

export type BreakdownStageKey = "extract_requirements" | "match_assets" | "validate_draft";
export type BreakdownStageStatus = "pending" | "running" | "succeeded" | "failed";

export interface BreakdownRun {
  id: string;
  version: number;
  projectId: string;
  scope: BreakdownScope;
  status: BreakdownRunStatus;
  currentStage: BreakdownStageKey | null;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
}

export type MatchStatus = "matched" | "partially_matched" | "missing" | "retrieval_unavailable";

export type MissingReason =
  | "no_candidate"
  | "low_confidence"
  | "missing_media"
  | "clearance_blocked"
  | "outside_project_scope"
  | "retrieval_unavailable";

export type SelectionBlocker = "clearance_blocked" | "review_not_approved" | "outside_project_scope";
export type ControlPackageBlocker = "missing_media" | "media_incompatible";

export interface BreakdownCandidate {
  candidateId: string;
  assetEntityId: string;
  assetMediaId: string | null;
  displayName: string;
  mediaKind: "image" | "video" | "audio" | "model_3d" | null;
  matchScore: number;
  matchedAttributes: string[];
  unmetAttributes: string[];
  thumbnailUrl: string | null;
  canPreview: boolean;
  canSelect: boolean;
  canAddToControlPackage: boolean;
  selectionBlockers: SelectionBlocker[];
  controlPackageBlockers: ControlPackageBlocker[];
}

export type BreakdownDecision =
  | { status: "unreviewed"; selectedCandidateId: null }
  | { status: "accepted"; selectedCandidateId: string }
  | { status: "kept_missing"; selectedCandidateId: null }
  | { status: "dismissed"; selectedCandidateId: null };

/** 契约 §8.2：请求是判别联合——keep_missing/dismiss 不能带 candidate_id。 */
export type BreakdownDecisionInput =
  | { action: "accept_candidate"; candidateId: string }
  | { action: "keep_missing" }
  | { action: "dismiss" };

export interface BreakdownRequirement {
  id: string;
  ordinal: number;
  /** 开放词表（契约 §13.4）；界面分组读 lane-vocabulary 同一快照，未知 key 不炸。 */
  laneKey: string;
  requiredAssetKindKey: string;
  displayName: string;
  needDescription: string;
  match: {
    status: MatchStatus;
    /** 契约 §8.1：详情每项只内嵌前 5 个候选；更多走游标。彩排 fixture 全量给，
        「已加载集合」由页面切片模拟（前 5 + 展开加载更多）。 */
    candidates: BreakdownCandidate[];
    missingReasons: MissingReason[];
  };
  decision: BreakdownDecision;
  generationBrief: { capability: "image" | "video" | "audio" | "director_scene"; brief: string } | null;
}

export interface BreakdownSummary {
  requirementCount: number;
  matchedCount: number;
  partiallyMatchedCount: number;
  missingCount: number;
  needsDecisionCount: number;
}

/** 契约 §8.1：详情响应每项需求只内嵌前 5 个候选，更多走游标接口。 */
export const BREAKDOWN_EMBEDDED_CANDIDATE_COUNT = 5;

/* ---------- 运行状态 / 阶段文案表（沿用剧本页 RUN_STATUS_META/STAGE_STATUS_META 模式） ---------- */

type BadgeTone = "accent" | "success" | "warning" | "danger" | "neutral";

export const BREAKDOWN_RUN_STATUS_META: Record<BreakdownRunStatus, { label: string; tone: BadgeTone }> = {
  queued: { label: "排队中", tone: "warning" },
  running: { label: "拆解中", tone: "accent" },
  draft: { label: "待确认", tone: "warning" },
  failed: { label: "拆解失败", tone: "danger" },
  confirmed: { label: "已确认", tone: "success" },
  discarded: { label: "已放弃", tone: "neutral" },
  superseded: { label: "已被替换", tone: "neutral" },
};

export const BREAKDOWN_STAGE_ORDER: readonly { key: BreakdownStageKey; label: string }[] = [
  { key: "extract_requirements", label: "拆需求" },
  { key: "match_assets", label: "配资产" },
  { key: "validate_draft", label: "校草稿" },
];

export const BREAKDOWN_STAGE_STATUS_META: Record<BreakdownStageStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "等待", tone: "neutral" },
  running: { label: "进行中", tone: "accent" },
  succeeded: { label: "完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
};

/** 由 run.status + currentStage 推导三段阶段态（界面不存第二份阶段事实）。 */
export function breakdownStageStates(run: Pick<BreakdownRun, "status" | "currentStage">): { key: BreakdownStageKey; label: string; status: BreakdownStageStatus }[] {
  const currentIndex = run.currentStage ? BREAKDOWN_STAGE_ORDER.findIndex((stage) => stage.key === run.currentStage) : -1;
  return BREAKDOWN_STAGE_ORDER.map((stage, index) => {
    let status: BreakdownStageStatus = "pending";
    if (run.status === "draft" || run.status === "confirmed") status = "succeeded";
    else if (run.status === "running") {
      if (index < currentIndex) status = "succeeded";
      else if (index === currentIndex) status = "running";
    } else if (run.status === "failed") {
      if (index < currentIndex) status = "succeeded";
      else if (index === currentIndex) status = "failed";
    }
    return { key: stage.key, label: stage.label, status };
  });
}

/* ---------- match 四态（设计 §3：缺失是生产常态不用红；红只留给出错） ---------- */

export const MATCH_STATUS_META: Record<MatchStatus, { label: string; tone: BadgeTone; hint: string }> = {
  matched: { label: "已有", tone: "success", hint: "有可直接用的候选" },
  partially_matched: { label: "部分满足", tone: "warning", hint: "有候选，但还有未满足的属性" },
  missing: { label: "缺失", tone: "neutral", hint: "暂时没有可见候选，缺失是生产常态" },
  retrieval_unavailable: { label: "资产库暂不可查", tone: "accent", hint: "需求已拆出，但资产库暂时不可查；可先决定，候选稍后重试匹配" },
};

export const MISSING_REASON_LABEL: Record<MissingReason, string> = {
  no_candidate: "资产库里还没有能对上的",
  low_confidence: "匹配把握不足，先按缺失处理",
  missing_media: "有实体但还缺媒体文件",
  clearance_blocked: "版权许可未完成",
  outside_project_scope: "不在本项目可用范围",
  retrieval_unavailable: "资产库暂时不可查",
};

/** 契约 §7：完全不可见的候选只贡献匿名汇总——名字/ID/缩略图绝不出现。
    返回 null=没有需要匿名说明的；有则给「另有 N 个候选因版权或项目范围不可见」。 */
export function anonymousHiddenSummary(missingReasons: readonly MissingReason[]): string | null {
  const count = missingReasons.filter((reason) => reason === "clearance_blocked" || reason === "outside_project_scope").length;
  if (count === 0) return null;
  return `另有 ${count} 个候选因版权或项目范围不可见`;
}

/* ---------- 候选两层谓词（契约 §7：可曝光不可采用 ≠ 完全不可见；shot 双 true 闸） ---------- */

/** 「用这个」是否可用。shot 作用域必须 canSelect && canAddToControlPackage 双 true。 */
export function canAcceptCandidate(scopeKind: BreakdownScopeKind, candidate: BreakdownCandidate): boolean {
  return candidateAcceptBlocker(scopeKind, candidate) === null;
}

/** 不可选用的原因（人话，一行）；可用返回 null。谓词优先级=契约列出顺序。 */
export function candidateAcceptBlocker(scopeKind: BreakdownScopeKind, candidate: BreakdownCandidate): string | null {
  if (candidate.selectionBlockers.includes("clearance_blocked")) return "版权许可未完成，不能选用";
  if (candidate.selectionBlockers.includes("review_not_approved")) return "审核未通过，不能选用";
  if (candidate.selectionBlockers.includes("outside_project_scope")) return "不在本项目可用范围，不能选用";
  if (!candidate.canSelect) return "暂不能选用";
  if (scopeKind === "shot" && !candidate.canAddToControlPackage) {
    if (candidate.controlPackageBlockers.includes("missing_media")) return "还缺媒体文件，不能进控制包";
    if (candidate.controlPackageBlockers.includes("media_incompatible")) return "媒体类型与本条需求不匹配，不能进控制包";
    return "暂不能进控制包";
  }
  return null;
}

/** accept 按钮措辞：shot=「用这个」（进控制包）；其他作用域只建立满足关系，说「记为满足」。 */
export function acceptActionLabel(scopeKind: BreakdownScopeKind): string {
  return scopeKind === "shot" ? "用这个" : "记为满足";
}

/* ---------- 已选候选解析（决策中立唯一收敛点；Fable 裁决留余地） ---------- */

/** 裁决选项②的预留形状（契约未批：当前详情响应没有这个字段）。
    批了②时后端给 display_name + thumbnail_url，页面原样透传到这里。 */
export interface SelectedCandidateSummary {
  displayName: string;
  thumbnailUrl: string | null;
}

export type SelectedCandidateView =
  | { kind: "resolved"; candidate: BreakdownCandidate }
  | { kind: "summary"; summary: SelectedCandidateSummary }
  | { kind: "placeholder" };

/** 占位文案（当前实现）：如实说明，不伪造名字与缩略图。 */
export const SELECTED_CANDIDATE_PLACEHOLDER = "已选的参考不在本页，展开加载更多后可见";

/**
 * 已选候选解析——已选候选可能不在内嵌前 5（契约 §8.1 只内嵌前 5 个候选）。
 * 当前实现（两个裁决选项都没批）：在已加载集合内找到才渲染，找不到显中性占位。
 * - 批①（已选候选必内嵌）：候选必在已加载集合 → 自动走 resolved，本函数零改动；
 * - 批②（摘要字段）：页面把 selected_candidate 传进第三个入参（一行接入）→ summary 分支。
 */
export function resolveSelectedCandidate(input: {
  loadedCandidates: readonly BreakdownCandidate[];
  selectedCandidateId: string;
  selectedCandidateSummary?: SelectedCandidateSummary | null;
}): SelectedCandidateView {
  const found = input.loadedCandidates.find((candidate) => candidate.candidateId === input.selectedCandidateId);
  if (found) return { kind: "resolved", candidate: found };
  if (input.selectedCandidateSummary) return { kind: "summary", summary: input.selectedCandidateSummary };
  return { kind: "placeholder" };
}

/* ---------- 逐项决定草稿标记（「候选 ≠ 成员」：finalize 前只说「待采用」） ---------- */

/** 决定后的草稿标记。finalized=false 一律「待采用」（不说已加入控制包）；
    finalize 成功后才允许换「已采用」（设计 §3 不说谎口径）。 */
export function decisionDraftLabel(
  decision: BreakdownDecision,
  selectedName: string | null,
  finalized: boolean,
): string | null {
  if (decision.status === "accepted") {
    const name = selectedName ?? "已选参考";
    return finalized ? `已采用 · ${name}` : `待采用 · ${name}`;
  }
  if (decision.status === "kept_missing") return "就缺着";
  if (decision.status === "dismissed") return "不需要";
  return null;
}

/* ---------- 清单摘要 / 过滤 / 未决定定位 ---------- */

export function summarizeRequirements(requirements: readonly BreakdownRequirement[]): BreakdownSummary {
  let matched = 0;
  let partial = 0;
  let missing = 0;
  let undecided = 0;
  for (const requirement of requirements) {
    if (requirement.match.status === "matched") matched += 1;
    else if (requirement.match.status === "partially_matched") partial += 1;
    else if (requirement.match.status === "missing") missing += 1;
    if (requirement.decision.status === "unreviewed") undecided += 1;
  }
  return {
    requirementCount: requirements.length,
    matchedCount: matched,
    partiallyMatchedCount: partial,
    missingCount: missing,
    needsDecisionCount: undecided,
  };
}

export type RequirementFilter = "all" | "undecided" | "missing";

export function filterRequirements(
  requirements: readonly BreakdownRequirement[],
  filter: RequirementFilter,
): BreakdownRequirement[] {
  if (filter === "undecided") return requirements.filter((requirement) => requirement.decision.status === "unreviewed");
  if (filter === "missing") return requirements.filter((requirement) => requirement.match.status === "missing");
  return [...requirements];
}

/** 422 incomplete_breakdown_decisions 的未决定项定位（保持 ordinal 顺序）。 */
export function undecidedRequirementIds(requirements: readonly BreakdownRequirement[]): string[] {
  return requirements.filter((requirement) => requirement.decision.status === "unreviewed").map((requirement) => requirement.id);
}

/* ---------- lane 分组（开放词表 §13.4：未知 lane_key 默认呈现，不炸 UI） ---------- */

export interface RequirementLaneGroup {
  domainId: LaneDomainId | "other";
  domainLabel: string;
  laneKey: string;
  laneLabel: string;
  items: BreakdownRequirement[];
}

export function groupRequirementsByLane(
  requirements: readonly BreakdownRequirement[],
  vocabulary: LaneVocabulary,
): RequirementLaneGroup[] {
  const domainSort = new Map(vocabulary.domains.map((domain) => [domain.id, domain.sort]));
  const domainLabel = new Map(vocabulary.domains.map((domain) => [domain.id, domain.label]));
  const laneById = new Map(vocabulary.entries.map((entry) => [entry.id, entry]));
  const groups = new Map<string, RequirementLaneGroup & { domainSort: number; laneSort: number }>();
  for (const requirement of requirements) {
    const lane = laneById.get(requirement.laneKey);
    const domainId = lane?.domain ?? "other";
    const key = `${domainId}:${requirement.laneKey}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        domainId,
        domainLabel: domainId === "other" ? "其他" : (domainLabel.get(domainId) ?? domainId),
        laneKey: requirement.laneKey,
        laneLabel: lane?.displayName ?? requirement.laneKey,
        domainSort: lane ? (domainSort.get(lane.domain) ?? 99) : 99,
        laneSort: lane?.sort ?? 99,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(requirement);
  }
  return [...groups.values()]
    .sort((a, b) => a.domainSort - b.domainSort || a.laneSort - b.laneSort || a.laneKey.localeCompare(b.laneKey))
    .map(({ domainSort: _domainSort, laneSort: _laneSort, ...group }) => group);
}

/* ---------- 契约 §10 错误码 → 人话与界面行为（逐字采用契约人话列） ---------- */

export type BreakdownErrorBehavior =
  | "input_inline" /* 400 输入幕 inline 红字，焦点回文本框 */
  | "fullscreen_not_found" /* 404 整屏 + 返回 */
  | "toast_to_confirmed" /* 409 already_finalized：toast + 切完成幕只读 */
  | "banner_refresh" /* 409 stale：清单幕顶部横幅 + 刷新 */
  | "toast_highlight" /* 409 conflict：toast + 按 details 高亮需求卡 */
  | "bottom_incomplete" /* 422 incomplete：底部红字计数 + 过滤切待决定 + 逐卡标红 */
  | "banner_retry_run" /* 422 output_invalid：横幅 + 重新拆解 */
  | "capability_unavailable" /* 503：走 capabilityErrorCopy 统一口径 */
  | "fallback";

export interface BreakdownErrorCopy {
  message: string;
  behavior: BreakdownErrorBehavior;
  /** details.requirement_ids（409 conflict / 422 incomplete 用）。 */
  requirementIds: string[];
}

function requirementIdsFromDetails(details: unknown): string[] {
  if (!details || typeof details !== "object") return [];
  const value = (details as { requirement_ids?: unknown }).requirement_ids;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 模型原始错误与原始响应不透传；未知 code 回落 error.message（与现有页面一致）。
    入参同时接受 wire 错误包（details.requirement_ids，snake_case）与前端归一形状
    （顶层 requirementIds 数组，彩排状态机/将来 FromUnknown 的产出）。 */
export function breakdownErrorCopy(
  error: { status?: number; code?: string; message?: string; details?: unknown; requirementIds?: unknown } | null | undefined,
): BreakdownErrorCopy {
  const code = error?.code ?? "";
  const directIds = Array.isArray(error?.requirementIds)
    ? error.requirementIds.filter((item): item is string => typeof item === "string")
    : [];
  const requirementIds = directIds.length > 0 ? directIds : requirementIdsFromDetails(error?.details);
  switch (code) {
    case "invalid_breakdown_input":
      return { message: "描述内容不完整，请补充后再试", behavior: "input_inline", requirementIds };
    case "breakdown_scope_not_found":
      return { message: "没有找到对应的制作内容", behavior: "fullscreen_not_found", requirementIds };
    case "breakdown_already_finalized":
      return { message: "这次拆解已经处理过", behavior: "toast_to_confirmed", requirementIds };
    case "stale_breakdown_version":
      return { message: "内容刚被其他人更新，请刷新后再提交", behavior: "banner_refresh", requirementIds };
    case "breakdown_confirmation_conflict":
      return { message: "有参考素材已经不可用，请重新确认", behavior: "toast_highlight", requirementIds };
    case "incomplete_breakdown_decisions":
      return { message: "还有生产需求等你决定", behavior: "bottom_incomplete", requirementIds };
    case "breakdown_output_invalid":
      return { message: "拆解结果不完整，请重试", behavior: "banner_retry_run", requirementIds };
    case "ai_gateway_unavailable":
      return { message: "AI 服务暂不可用，已保留当前内容", behavior: "capability_unavailable", requirementIds };
    default:
      return { message: error?.message || "操作失败，请重试", behavior: "fallback", requirementIds };
  }
}

/* ---------- 按作用域的确认弹窗与完成文案（设计 §2 幕 4/幕 5 变体） ---------- */

export function finalizeConfirmCopy(scopeKind: BreakdownScopeKind): string {
  if (scopeKind === "shot") return "确认采用？选中的参考会写入这个分镜的控制包，缺失项不创建生成任务。";
  if (scopeKind === "scene") return "确认采用？保存本场的生产需求与满足关系，不会改动任何控制包。";
  if (scopeKind === "episode") return "确认采用？保存本集的生产需求与满足关系，不会改动任何控制包。";
  return "确认采用？保存为项目的前期需求，不产生分镜或控制包。";
}

/** 完成幕结果摘要。满足关系与实际使用分开说：只有 shot 说「写入控制包参考」。 */
export function confirmedResultCopy(
  scopeKind: BreakdownScopeKind,
  counts: { requirements: number; fulfillments: number; controlRefs: number },
): string {
  if (scopeKind === "shot") {
    return `已写入需求 ${counts.requirements} 条、满足关系 ${counts.fulfillments} 条；写入控制包参考 ${counts.controlRefs} 项。`;
  }
  return `已保存需求 ${counts.requirements} 条、满足关系 ${counts.fulfillments} 条（记下可以满足，不代表本次实际使用）。`;
}

/** viewer 底部条说明（契约 §9：owner|editor 才能确认；admin 不越权）。 */
export const BREAKDOWN_VIEWER_NOTE = "只有项目负责人和编辑能确认采用";

/* ============================================================
   彩排假 run 状态机（rehearsal）
   ——契约批准前的形态彩排：全内存、零网络，fixture 由调用方注入
   （demo.ts），本模块不内置任何假数据。状态迁移与契约 §6/§8 对齐：
   queued → running（逐阶段）→ draft → confirmed/discarded/failed，
   resume 产生新 run、旧 run 变 superseded。
   ============================================================ */

export interface RehearsalDestination {
  label: string;
  path: string;
}

export interface RehearsalRunState {
  run: BreakdownRun;
  requirements: BreakdownRequirement[];
  /** finalize 成功的结果（契约 §8.3 成功响应形状，驼峰归一）。 */
  result: { requirementIds: string[]; fulfillmentIds: string[]; controlPackageRefIds: string[] } | null;
  /** failed 时的人话原因（彩排只有手工构造才出现）。 */
  failureMessage: string | null;
  /** 入口写入的作用域面包屑与去向（界面不反向推导项目结构）。 */
  scopeLabel: string;
  sourceText: string;
  primaryDestination: RehearsalDestination | null;
  returnDestination: RehearsalDestination;
  /** resume 产生的新 run 记录它替换了谁（契约 §8.4 supersedes_run_id）。 */
  supersedesRunId: string | null;
}

export interface CreateRehearsalRunInput {
  /** 幂等键（契约 §5.1）：同项目同键返回既有运行，连点不重复建。 */
  idempotencyKey: string;
  projectId: string;
  scope: BreakdownScope;
  scopeLabel: string;
  sourceText: string;
  /** fixture 注入的需求模板（函数产出新副本，决定写在副本上）。 */
  requirements: BreakdownRequirement[];
  promptVersion?: string;
  primaryDestination?: RehearsalDestination | null;
  returnDestination: RehearsalDestination;
  /** 测试用固定时间/id；缺省取当前时间与递增序号。 */
  now?: string;
  runId?: string;
}

const rehearsalRuns = new Map<string, RehearsalRunState>();
const rehearsalIdempotencyKeys = new Map<string, string>();
let rehearsalSequence = 0;

/** 浏览器/Node 都可用的幂等键生成（入口每次对话生成一次）。 */
export function newRehearsalIdempotencyKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof cryptoApi?.randomUUID === "function" ? cryptoApi.randomUUID() : `key-${Date.now()}-${++rehearsalSequence}`;
}

function cloneRequirements(requirements: readonly BreakdownRequirement[]): BreakdownRequirement[] {
  return requirements.map((requirement) => ({
    ...requirement,
    match: {
      ...requirement.match,
      candidates: requirement.match.candidates.map((candidate) => ({
        ...candidate,
        matchedAttributes: [...candidate.matchedAttributes],
        unmetAttributes: [...candidate.unmetAttributes],
        selectionBlockers: [...candidate.selectionBlockers],
        controlPackageBlockers: [...candidate.controlPackageBlockers],
      })),
      missingReasons: [...requirement.match.missingReasons],
    },
    decision: { ...requirement.decision },
    generationBrief: requirement.generationBrief ? { ...requirement.generationBrief } : null,
  }));
}

/** 创建彩排 run（初始 queued/extract_requirements）。同幂等键返回既有运行。 */
export function createRehearsalRun(input: CreateRehearsalRunInput): RehearsalRunState {
  const idemKey = `${input.projectId}:${input.idempotencyKey}`;
  const existingId = rehearsalIdempotencyKeys.get(idemKey);
  if (existingId) {
    const existing = rehearsalRuns.get(existingId);
    if (existing) return existing;
  }
  const now = input.now ?? new Date().toISOString();
  const id = input.runId ?? `rehearsal-run-${Date.now().toString(36)}-${++rehearsalSequence}`;
  const state: RehearsalRunState = {
    run: {
      id,
      version: 1,
      projectId: input.projectId,
      scope: input.scope,
      status: "queued",
      currentStage: "extract_requirements",
      promptVersion: input.promptVersion ?? "production-requirements.v1",
      createdAt: now,
      updatedAt: now,
    },
    requirements: cloneRequirements(input.requirements),
    result: null,
    failureMessage: null,
    scopeLabel: input.scopeLabel,
    sourceText: input.sourceText,
    primaryDestination: input.primaryDestination ?? null,
    returnDestination: input.returnDestination,
    supersedesRunId: null,
  };
  rehearsalRuns.set(id, state);
  rehearsalIdempotencyKeys.set(idemKey, id);
  return state;
}

export function getRehearsalRun(runId: string): RehearsalRunState | null {
  return rehearsalRuns.get(runId) ?? null;
}

/** 状态机步进：queued → running(三段逐阶段) → draft。其他状态原样返回。 */
export function advanceRehearsalRun(state: RehearsalRunState, now?: string): RehearsalRunState {
  const stamp = now ?? new Date().toISOString();
  const { run } = state;
  if (run.status === "queued") {
    return { ...state, run: { ...run, status: "running", currentStage: "extract_requirements", updatedAt: stamp } };
  }
  if (run.status !== "running") return state;
  if (run.currentStage === "extract_requirements") {
    return { ...state, run: { ...run, currentStage: "match_assets", updatedAt: stamp } };
  }
  if (run.currentStage === "match_assets") {
    return { ...state, run: { ...run, currentStage: "validate_draft", updatedAt: stamp } };
  }
  return { ...state, run: { ...run, status: "draft", currentStage: null, updatedAt: stamp } };
}

export function tickRehearsalRun(runId: string, now?: string): RehearsalRunState | null {
  const state = rehearsalRuns.get(runId);
  if (!state) return null;
  const next = advanceRehearsalRun(state, now);
  rehearsalRuns.set(runId, next);
  return next;
}

export interface RehearsalDecisionOutcome {
  ok: boolean;
  state: RehearsalRunState;
  /** 同内容重复提交=true（契约 §8.2：返回当前决定，不重复写，版本不加）。 */
  idempotent: boolean;
  message?: string;
}

function decisionFromInput(input: BreakdownDecisionInput): BreakdownDecision {
  if (input.action === "accept_candidate") return { status: "accepted", selectedCandidateId: input.candidateId };
  if (input.action === "keep_missing") return { status: "kept_missing", selectedCandidateId: null };
  return { status: "dismissed", selectedCandidateId: null };
}

function sameDecision(a: BreakdownDecision, b: BreakdownDecision): boolean {
  return a.status === b.status && a.selectedCandidateId === b.selectedCandidateId;
}

/** 逐项决定（只写草稿，不动控制包）。换决定覆盖旧草稿、run version +1。 */
export function decideRehearsal(
  runId: string,
  requirementId: string,
  input: BreakdownDecisionInput,
  now?: string,
): RehearsalDecisionOutcome {
  const state = rehearsalRuns.get(runId);
  if (!state) return { ok: false, state: null as unknown as RehearsalRunState, idempotent: false, message: "没有找到这次拆解运行" };
  if (state.run.status !== "draft") {
    return { ok: false, state, idempotent: false, message: "这次拆解当前不能决定" };
  }
  const requirement = state.requirements.find((item) => item.id === requirementId);
  if (!requirement) return { ok: false, state, idempotent: false, message: "没有找到这条需求" };
  if (input.action === "accept_candidate") {
    const candidate = requirement.match.candidates.find((item) => item.candidateId === input.candidateId);
    if (!candidate) return { ok: false, state, idempotent: false, message: "没有找到这个候选" };
    const blocker = candidateAcceptBlocker(state.run.scope.kind, candidate);
    if (blocker) return { ok: false, state, idempotent: false, message: blocker };
  }
  const nextDecision = decisionFromInput(input);
  if (sameDecision(requirement.decision, nextDecision)) {
    return { ok: true, state, idempotent: true };
  }
  const stamp = now ?? new Date().toISOString();
  const next: RehearsalRunState = {
    ...state,
    run: { ...state.run, version: state.run.version + 1, updatedAt: stamp },
    requirements: state.requirements.map((item) => (item.id === requirementId ? { ...item, decision: nextDecision } : item)),
  };
  rehearsalRuns.set(runId, next);
  return { ok: true, state: next, idempotent: false };
}

export type RehearsalFinalizeOutcome =
  | { ok: true; state: RehearsalRunState }
  | { ok: false; status: number; code: string; message: string; requirementIds: string[] };

/** 原子最终提交（契约 §8.3）：任一未决定 → 422 列未决定项；shot 作用域
    已采用候选写控制包引用计数；成功一次性 confirmed。 */
export function finalizeRehearsalRun(runId: string, now?: string): RehearsalFinalizeOutcome {
  const state = rehearsalRuns.get(runId);
  if (!state) return { ok: false, status: 404, code: "breakdown_scope_not_found", message: "没有找到对应的制作内容", requirementIds: [] };
  if (state.run.status === "confirmed") {
    return { ok: false, status: 409, code: "breakdown_already_finalized", message: "这次拆解已经处理过", requirementIds: [] };
  }
  if (state.run.status !== "draft") {
    return { ok: false, status: 409, code: "stale_breakdown_version", message: "内容刚被其他人更新，请刷新后再提交", requirementIds: [] };
  }
  const undecided = undecidedRequirementIds(state.requirements);
  if (undecided.length > 0) {
    return { ok: false, status: 422, code: "incomplete_breakdown_decisions", message: "还有生产需求等你决定", requirementIds: undecided };
  }
  const accepted: { requirementId: string; candidate: BreakdownCandidate }[] = [];
  for (const requirement of state.requirements) {
    if (requirement.decision.status !== "accepted") continue;
    const candidate = requirement.match.candidates.find((item) => item.candidateId === requirement.decision.selectedCandidateId);
    if (candidate) accepted.push({ requirementId: requirement.id, candidate });
  }
  const controlRefs = state.run.scope.kind === "shot" ? accepted.filter((item) => item.candidate.canAddToControlPackage) : [];
  const stamp = now ?? new Date().toISOString();
  const next: RehearsalRunState = {
    ...state,
    run: { ...state.run, status: "confirmed", version: state.run.version + 1, updatedAt: stamp },
    result: {
      requirementIds: state.requirements.map((requirement) => requirement.id),
      fulfillmentIds: accepted.map((item) => `fulfillment-${item.requirementId}`),
      controlPackageRefIds: controlRefs.map((item) => `control-ref-${item.requirementId}`),
    },
  };
  rehearsalRuns.set(runId, next);
  return { ok: true, state: next };
}

/** 放弃（契约 §8.4）：draft|failed → discarded；重复放弃返回当前状态。 */
export function discardRehearsalRun(runId: string, now?: string): RehearsalRunState | null {
  const state = rehearsalRuns.get(runId);
  if (!state) return null;
  if (state.run.status === "discarded") return state;
  if (state.run.status !== "draft" && state.run.status !== "failed") return state;
  const stamp = now ?? new Date().toISOString();
  const next: RehearsalRunState = {
    ...state,
    run: { ...state.run, status: "discarded", version: state.run.version + 1, updatedAt: stamp },
  };
  rehearsalRuns.set(runId, next);
  return next;
}

/** 恢复（契约 §8.4）：只有 failed|discarded 可恢复；创建新 run（保留原输入与
    人工决定快照，重新执行候选匹配），旧 run 变 superseded。 */
export function resumeRehearsalRun(
  runId: string,
  input: { idempotencyKey: string; now?: string; newRunId?: string },
): { previous: RehearsalRunState; next: RehearsalRunState } | null {
  const state = rehearsalRuns.get(runId);
  if (!state) return null;
  if (state.run.status !== "failed" && state.run.status !== "discarded") return null;
  const stamp = input.now ?? new Date().toISOString();
  const previous: RehearsalRunState = {
    ...state,
    run: { ...state.run, status: "superseded", version: state.run.version + 1, updatedAt: stamp },
  };
  rehearsalRuns.set(runId, previous);
  const next = createRehearsalRun({
    idempotencyKey: input.idempotencyKey,
    projectId: state.run.projectId,
    scope: state.run.scope,
    scopeLabel: state.scopeLabel,
    sourceText: state.sourceText,
    requirements: state.requirements,
    promptVersion: state.run.promptVersion,
    primaryDestination: state.primaryDestination,
    returnDestination: state.returnDestination,
    now: stamp,
    runId: input.newRunId,
  });
  const withLink: RehearsalRunState = { ...next, supersedesRunId: runId };
  rehearsalRuns.set(withLink.run.id, withLink);
  return { previous, next: withLink };
}

/** 测试辅助：清空全部彩排 run（node:test 用例间隔离）。 */
export function resetRehearsalRunsForTest(): void {
  rehearsalRuns.clear();
  rehearsalIdempotencyKeys.clear();
  rehearsalSequence = 0;
}
