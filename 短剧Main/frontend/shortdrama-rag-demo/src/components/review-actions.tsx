/* ============================================================
   W5-A 资产审核域：纯函数与本地 demo fixture
   （tsx --test 无法加载 .css，纯函数集中在本文件，src/review-actions.test.ts 直接覆盖；
   UI 组件在 review-panels.tsx，视图层 Tailwind v4 + components/ui 原语，无 CSS 文件。）

   合同口径（api.ts 已实现，响应 camelCase / 请求 snake_case）：
   - 资产四态来自 Asset.status：automatic_review / pending_review / approved / rejected；
   - 批量提审 ≤50 件，逐项 changed/reason，终态不重复流转；
   - 拒绝必须带 rejection_reason；终态再裁决 409（code 含 asset_review_terminal_state）；
   - 策略开关乐观锁：PUT 回传 expected_version，409 = 配置已被他人更新。
   ============================================================ */

import type {
  Asset,
  AssetReviewAction,
  AssetReviewActionRecord,
  AssetReviewItem,
  AssetReviewStatus,
  ProjectReviewPolicy,
  ReviewDefaultStrategy,
  ReviewMediaKind,
} from "../types";

/* ---------- 四态 pill：Asset.status → bucket → 文案/样式槽位（板02 图例） ---------- */

export type AssetReviewBucket = "auto" | "pending" | "approved" | "rejected";

/**
 * 资产本体审核四态。后端写入口径为 automatic_review / pending_review / approved / rejected；
 * demo 与早期数据另有 ready/pending/auto_approved。未知值并入「待审核」，不虚构其他态
 * asset-upload-modal 的旧映射不识别 automatic_review，本函数是审核域的唯一映射入口。
 */
export function assetReviewBucket(status?: string | null): AssetReviewBucket {
  const value = (status ?? "").trim().toLowerCase();
  if (value === "automatic_review" || value === "auto" || value === "auto_approved") return "auto";
  if (value === "approved" || value === "ready" || value === "passed") return "approved";
  if (value === "rejected" || value === "failed") return "rejected";
  return "pending";
}

export function reviewBucketLabel(bucket: AssetReviewBucket): string {
  if (bucket === "auto") return "自动审核";
  if (bucket === "approved") return "已通过";
  if (bucket === "rejected") return "已拒绝";
  return "待审核";
}

/** 服务端审核态文案（轨迹 fromStatus/toStatus 用）：与 pill 同一套四态文案。 */
export function reviewStatusLabel(status: string): string {
  return reviewBucketLabel(assetReviewBucket(status));
}

/** 审核状态筛选选项（板02：全部/自动审核/待审核/已通过/已拒绝）。 */
export const REVIEW_FILTER_OPTIONS: ReadonlyArray<{ value: AssetReviewBucket; label: string }> = [
  { value: "auto", label: "自动审核" },
  { value: "pending", label: "待审核" },
  { value: "approved", label: "已通过" },
  { value: "rejected", label: "已拒绝" },
];

/** 客户端审核状态过滤：空串 = 全部，其余按 bucket 精确匹配。 */
export function reviewFilterMatches(status: string | null | undefined, filter: AssetReviewBucket | ""): boolean {
  return !filter || assetReviewBucket(status) === filter;
}

/* ---------- 批量提审：件数护栏 + 结果摘要聚合（toast 汇总 + 逐条原因摘要区） ---------- */

export const SUBMIT_BATCH_LIMIT = 50;

export function submitBatchError(count: number): string {
  if (count <= 0) return "先勾选要提审的资产";
  if (count > SUBMIT_BATCH_LIMIT) return `一次最多提审 ${SUBMIT_BATCH_LIMIT} 件，请分批提交`;
  return "";
}

export interface SubmitSummary {
  total: number;
  /** changed=true 且 reason=submitted：本次真正进入待审队列。 */
  submitted: number;
  /** 已在待审队列，未重复提交。 */
  alreadyPending: number;
  /** already_approved / already_rejected：终态不重复流转。 */
  terminal: number;
}

export function summarizeSubmitResults(items: readonly AssetReviewItem[]): SubmitSummary {
  const summary: SubmitSummary = { total: items.length, submitted: 0, alreadyPending: 0, terminal: 0 };
  for (const item of items) {
    if (item.changed && item.reason === "submitted") summary.submitted += 1;
    else if (item.reason === "already_pending_review") summary.alreadyPending += 1;
    else if (item.reason === "already_approved" || item.reason === "already_rejected") summary.terminal += 1;
  }
  return summary;
}

/** toast 汇总文案：只报件数，逐条原因进结果摘要区，不刷屏。 */
export function formatSubmitSummary(summary: SubmitSummary): string {
  const parts: string[] = [];
  if (summary.submitted > 0) parts.push(`新提审 ${summary.submitted} 件`);
  if (summary.alreadyPending > 0) parts.push(`${summary.alreadyPending} 件已在待审队列`);
  if (summary.terminal > 0) parts.push(`${summary.terminal} 件已是终态，未重复流转`);
  return parts.length ? parts.join("；") : "没有可提审的资产";
}

/** 结果摘要区逐条原因：一件一行，说清去向。 */
export function submitResultLine(item: AssetReviewItem, assetLabel: string): string {
  if (item.changed && item.reason === "submitted") return `「${assetLabel}」已送进待审队列`;
  if (item.reason === "already_pending_review") return `「${assetLabel}」已在待审队列，未重复提交`;
  if (item.reason === "already_approved") return `「${assetLabel}」已通过终审，不重复流转`;
  if (item.reason === "already_rejected") return `「${assetLabel}」已拒绝留档，不重复流转`;
  return `「${assetLabel}」状态未变化`;
}

/* ---------- 拒绝理由校验（空理由禁止提交） ---------- */

export function rejectionReasonError(reason: string): string {
  return reason.trim() ? "" : "拒绝必须写明理由，打回才不会变成猜谜";
}

/* ---------- 409 判定辅助（策略乐观锁冲突 / 终态裁决冲突） ---------- */

/** 策略 PUT 的版本冲突：服务端 409 即视为配置被他人更新。 */
export function isVersionConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 409;
}

/** 终态再裁决冲突：409 且 code 含 asset_review_terminal_state。 */
export function isTerminalStateConflict(error: unknown): boolean {
  if (!isVersionConflict(error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.includes("asset_review_terminal_state");
}

/* ---------- 自动待审开关（按 mediaKind 分开；安全默认 = 待审） ---------- */

export function policyFor(policies: readonly ProjectReviewPolicy[] | null | undefined, mediaKind: ReviewMediaKind): ProjectReviewPolicy | null {
  return policies?.find((policy) => policy.mediaKind === mediaKind) ?? null;
}

/** id=null/version=0 表示安全默认未持久化，按待审处理（types.ts 合同注释）。 */
export function effectiveStrategy(policy: ProjectReviewPolicy | null | undefined): ReviewDefaultStrategy {
  return policy?.defaultStrategy ?? "pending_review";
}

export function mediaKindLabel(kind: ReviewMediaKind): string {
  return kind === "image" ? "图片" : "视频";
}

/* ---------- 审核轨迹：动作文案 + 排序 + 卡片提示行提取 ---------- */

export function reviewActionLabel(action: AssetReviewAction): string {
  if (action === "approved") return "通过";
  if (action === "rejected") return "拒绝";
  return "提审";
}

export function reviewerLabel(record: Pick<AssetReviewActionRecord, "reviewerDisplayName">): string {
  return record.reviewerDisplayName?.trim() || "未留名审核人";
}

/** 新→旧排序，不改原数组。 */
export function sortTrailRecords(records: readonly AssetReviewActionRecord[]): AssetReviewActionRecord[] {
  return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function trailFlowLabel(record: Pick<AssetReviewActionRecord, "fromStatus" | "toStatus">): string {
  return `${reviewStatusLabel(record.fromStatus)} → ${reviewStatusLabel(record.toStatus)}`;
}

/** 板02 卡片提示行的数据来源：审核人 = 最近一条记录的经手人；拒绝理由 = 最近一次拒绝的理由。 */
export interface ReviewHint {
  reviewerName?: string;
  rejectionReason?: string;
}

export function reviewHintFromRecords(records: readonly AssetReviewActionRecord[]): ReviewHint {
  const sorted = sortTrailRecords(records);
  const latest = sorted[0];
  const rejected = sorted.find((record) => record.action === "rejected" && record.rejectionReason?.trim());
  return {
    reviewerName: latest?.reviewerDisplayName?.trim() || undefined,
    rejectionReason: rejected?.rejectionReason?.trim() || undefined,
  };
}

/* ---------- demo fixture：四态资产 / 策略 / 提示行 / 轨迹（禁改 demo.ts，fixture 落在这里） ---------- */

/** 离线演示的四态覆盖：项目资产页/详情页/资产中心在 demoMode 下叠加，真实接口不受影响。 */
const DEMO_REVIEW_STATUS: Record<string, string> = {
  "asset-ren": "approved",
  "asset-lin": "pending_review",
  "asset-harbor": "automatic_review",
  "asset-knife": "rejected",
  "common-palace": "pending_review",
  "common-costume": "approved",
};

export function withDemoReviewStatus(asset: Asset): Asset {
  const status = DEMO_REVIEW_STATUS[asset.id];
  return status ? { ...asset, status } : asset;
}

const DEMO_REVIEW_HINTS: Record<string, ReviewHint> = {
  "asset-lin": { reviewerName: "周岚（制片）" },
  "asset-knife": { rejectionReason: "刀刃反光穿帮，和夜戏光位对不上" },
  "common-palace": { reviewerName: "周岚（制片）" },
};

export function demoReviewHint(assetId: string): ReviewHint {
  return DEMO_REVIEW_HINTS[assetId] ?? {};
}

/** 图片默认待审（已持久化 v2）、视频自动过审（已持久化 v1），两种档位都能在离线演示里看到。 */
export const DEMO_REVIEW_POLICIES: ProjectReviewPolicy[] = [
  { id: "demo-policy-image", projectId: "demo-project-2", mediaKind: "image", defaultStrategy: "pending_review", updatedByUserId: "demo-user", version: 2, createdAt: "2026-07-15T09:00:00.000Z", updatedAt: "2026-07-18T09:30:00.000Z" },
  { id: "demo-policy-video", projectId: "demo-project-2", mediaKind: "video", defaultStrategy: "automatic", updatedByUserId: "demo-user", version: 1, createdAt: "2026-07-15T09:00:00.000Z", updatedAt: "2026-07-16T14:10:00.000Z" },
];

function demoTrailRecord(partial: Pick<AssetReviewActionRecord, "id" | "assetId" | "action" | "fromStatus" | "toStatus" | "reviewerDisplayName" | "createdAt"> & { rejectionReason?: string | null }): AssetReviewActionRecord {
  return {
    projectId: "demo-project-2",
    reviewerUserId: "demo-reviewer",
    rejectionReason: null,
    ...partial,
  };
}

export function demoReviewActions(assetId: string): AssetReviewActionRecord[] {
  const records: Record<string, AssetReviewActionRecord[]> = {
    "asset-ren": [
      demoTrailRecord({ id: "demo-ra-ren-2", assetId, action: "approved", fromStatus: "pending_review", toStatus: "approved", reviewerDisplayName: "陈默（导演）", createdAt: "2026-07-18T11:02:00.000Z" }),
      demoTrailRecord({ id: "demo-ra-ren-1", assetId, action: "submitted", fromStatus: "automatic_review", toStatus: "pending_review", reviewerDisplayName: "周岚（制片）", createdAt: "2026-07-18T10:20:00.000Z" }),
    ],
    "asset-lin": [
      demoTrailRecord({ id: "demo-ra-lin-1", assetId, action: "submitted", fromStatus: "automatic_review", toStatus: "pending_review", reviewerDisplayName: "周岚（制片）", createdAt: "2026-07-19T08:40:00.000Z" }),
    ],
    "asset-knife": [
      demoTrailRecord({ id: "demo-ra-knife-2", assetId, action: "rejected", fromStatus: "pending_review", toStatus: "rejected", reviewerDisplayName: "陈默（导演）", rejectionReason: "刀刃反光穿帮，和夜戏光位对不上", createdAt: "2026-07-19T09:12:00.000Z" }),
      demoTrailRecord({ id: "demo-ra-knife-1", assetId, action: "submitted", fromStatus: "automatic_review", toStatus: "pending_review", reviewerDisplayName: "周岚（制片）", createdAt: "2026-07-19T08:50:00.000Z" }),
    ],
    "common-palace": [
      demoTrailRecord({ id: "demo-ra-palace-1", assetId, action: "submitted", fromStatus: "automatic_review", toStatus: "pending_review", reviewerDisplayName: "周岚（制片）", createdAt: "2026-07-20T10:05:00.000Z" }),
    ],
  };
  return records[assetId] ?? [];
}

/* ---------- K2U D-17：demo 会话内资产审核仓(只在内存,刷新复原,不提交后端) ----------
   原判(幕四片段断点 4):填理由「确认拒绝」→ toast「离线演示不提交审核」,状态不变。
   本仓让裁决/提审在 demo 会话里真翻转(pending→approved/rejected、→pending_review)
   并留痕(轨迹面板/卡片提示行/状态徽标同步变),与真栈同口径:
   拒绝无理由拦下(与后端 422 同文案)、终态不重复流转。
   注意:本仓管「资产实体审核」(资产页/详情页);幕四「产物审核队列」(媒体产物)
   的会话仓在 demo-review-delivery.ts(K2A),两个域不混。 */
let demoSessionRecords: AssetReviewActionRecord[] = [];
let demoSessionRevision = 0;

/** 测试隔离用：清空会话留痕并推进版本号。 */
export function resetDemoAssetReviewSession(): void {
  demoSessionRecords = [];
  demoSessionRevision += 1;
}

/** 会话留痕版本号：轨迹面板据此重读（裁决引起的列表重渲染会带上新值）。 */
export function demoAssetReviewSessionRevision(): number {
  return demoSessionRevision;
}

function appendSessionRecord(record: AssetReviewActionRecord): AssetReviewActionRecord {
  demoSessionRecords = [...demoSessionRecords, record];
  demoSessionRevision += 1;
  return record;
}

/** 会话裁决：pending → approved/rejected；拒绝理由必填（与真栈 422 同文案，客户端先拦）。 */
export function applyDemoAssetDecision(input: {
  assetId: string;
  action: "approve" | "reject";
  fromStatus: string;
  reason?: string;
  reviewerName: string;
}): AssetReviewActionRecord {
  if (input.action === "reject") {
    const message = rejectionReasonError(input.reason ?? "");
    if (message) throw new Error(message);
  }
  const toStatus: AssetReviewStatus = input.action === "approve" ? "approved" : "rejected";
  return appendSessionRecord({
    id: `demo-session-ra-${demoSessionRecords.length + 1}`,
    projectId: "demo-project-2",
    assetId: input.assetId,
    action: toStatus,
    fromStatus: (input.fromStatus || "pending_review") as AssetReviewStatus,
    toStatus,
    reviewerUserId: "demo-user",
    reviewerDisplayName: input.reviewerName,
    rejectionReason: input.action === "reject" ? input.reason?.trim() ?? null : null,
    createdAt: new Date().toISOString(),
  });
}

/** 会话批量提审：逐项出 AssetReviewItem（changed/reason 与真栈同口径）；
    新进待审的补 submitted 留痕；已在待审/终态不重复流转。 */
export function applyDemoAssetSubmissions(assets: ReadonlyArray<Pick<Asset, "id" | "status">>, reviewerName: string): AssetReviewItem[] {
  return assets.map((asset) => {
    const current = (asset.status ?? "automatic_review") as AssetReviewStatus;
    const bucket = assetReviewBucket(current);
    if (bucket === "pending") return { assetId: asset.id, status: current, changed: false, reason: "already_pending_review" };
    if (bucket === "approved") return { assetId: asset.id, status: current, changed: false, reason: "already_approved" };
    if (bucket === "rejected") return { assetId: asset.id, status: current, changed: false, reason: "already_rejected" };
    const latestAction = appendSessionRecord({
      id: `demo-session-ra-${demoSessionRecords.length + 1}`,
      projectId: "demo-project-2",
      assetId: asset.id,
      action: "submitted",
      fromStatus: current,
      toStatus: "pending_review",
      reviewerUserId: "demo-user",
      reviewerDisplayName: reviewerName,
      rejectionReason: null,
      createdAt: new Date().toISOString(),
    });
    return { assetId: asset.id, status: "pending_review" as AssetReviewStatus, changed: true, reason: "submitted", latestAction };
  });
}

/** 审核轨迹 = 初始 fixture + 会话留痕（排序在调用方 sortTrailRecords）。 */
export function demoAssetReviewTrail(assetId: string): AssetReviewActionRecord[] {
  return [...demoReviewActions(assetId), ...demoSessionRecords.filter((record) => record.assetId === assetId)];
}
