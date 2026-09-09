import assert from "node:assert/strict";
import test from "node:test";
import { reviewActionFromUnknown, reviewItemFromUnknown, reviewPolicyFromUnknown } from "./api";
import {
  DEMO_REVIEW_POLICIES,
  REVIEW_FILTER_OPTIONS,
  SUBMIT_BATCH_LIMIT,
  assetReviewBucket,
  demoReviewActions,
  demoReviewHint,
  effectiveStrategy,
  formatSubmitSummary,
  isTerminalStateConflict,
  isVersionConflict,
  mediaKindLabel,
  policyFor,
  rejectionReasonError,
  reviewActionLabel,
  reviewBucketLabel,
  reviewFilterMatches,
  reviewHintFromRecords,
  reviewStatusLabel,
  reviewerLabel,
  sortTrailRecords,
  submitBatchError,
  submitResultLine,
  summarizeSubmitResults,
  trailFlowLabel,
  withDemoReviewStatus,
} from "./components/review-actions";
import type { Asset, AssetReviewActionRecord, AssetReviewItem, ProjectReviewPolicy } from "./types";

function reviewItem(partial: Partial<AssetReviewItem> & { assetId: string }): AssetReviewItem {
  return { status: "pending_review", changed: false, reason: "already_pending_review", ...partial };
}

function trailRecord(partial: Partial<AssetReviewActionRecord> & { id: string }): AssetReviewActionRecord {
  return {
    projectId: "demo-project-2",
    assetId: "asset-1",
    action: "submitted",
    fromStatus: "automatic_review",
    toStatus: "pending_review",
    reviewerUserId: "user-1",
    reviewerDisplayName: "周岚（制片）",
    rejectionReason: null,
    createdAt: "2026-07-18T10:00:00.000Z",
    ...partial,
  };
}

function policy(partial: Partial<ProjectReviewPolicy> & { mediaKind: "image" | "video" }): ProjectReviewPolicy {
  return {
    id: "policy-1",
    projectId: "demo-project-2",
    defaultStrategy: "pending_review",
    updatedByUserId: "user-1",
    version: 1,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

/* ---------- 四态 pill 映射（板02：自动审核/待审核/已通过/已拒绝） ---------- */

test("assetReviewBucket：服务端四态口径精确映射", () => {
  assert.equal(assetReviewBucket("automatic_review"), "auto");
  assert.equal(assetReviewBucket("pending_review"), "pending");
  assert.equal(assetReviewBucket("approved"), "approved");
  assert.equal(assetReviewBucket("rejected"), "rejected");
});

test("assetReviewBucket：demo 与早期数据归并，未知值并入待审核", () => {
  assert.equal(assetReviewBucket("ready"), "approved");
  assert.equal(assetReviewBucket("passed"), "approved");
  assert.equal(assetReviewBucket("auto"), "auto");
  assert.equal(assetReviewBucket("auto_approved"), "auto");
  assert.equal(assetReviewBucket("pending"), "pending");
  assert.equal(assetReviewBucket("failed"), "rejected");
  assert.equal(assetReviewBucket("something-else"), "pending");
  assert.equal(assetReviewBucket(""), "pending");
  assert.equal(assetReviewBucket(null), "pending");
  assert.equal(assetReviewBucket(undefined), "pending");
  assert.equal(assetReviewBucket(" AUTOMATIC_REVIEW "), "auto");
});

test("reviewBucketLabel / reviewStatusLabel：四态文案与 pill 一致", () => {
  assert.equal(reviewBucketLabel("auto"), "自动审核");
  assert.equal(reviewBucketLabel("pending"), "待审核");
  assert.equal(reviewBucketLabel("approved"), "已通过");
  assert.equal(reviewBucketLabel("rejected"), "已拒绝");
  assert.equal(reviewStatusLabel("automatic_review"), "自动审核");
  assert.equal(reviewStatusLabel("approved"), "已通过");
});

test("REVIEW_FILTER_OPTIONS：筛选项就是板02 的四态", () => {
  assert.deepEqual(REVIEW_FILTER_OPTIONS.map((option) => option.value), ["auto", "pending", "approved", "rejected"]);
  assert.deepEqual(REVIEW_FILTER_OPTIONS.map((option) => option.label), ["自动审核", "待审核", "已通过", "已拒绝"]);
});

test("reviewFilterMatches：空筛选放行全部，其余按 bucket 匹配", () => {
  assert.equal(reviewFilterMatches("approved", ""), true);
  assert.equal(reviewFilterMatches("automatic_review", "auto"), true);
  assert.equal(reviewFilterMatches("ready", "approved"), true);
  assert.equal(reviewFilterMatches("pending_review", "pending"), true);
  assert.equal(reviewFilterMatches("approved", "pending"), false);
  assert.equal(reviewFilterMatches("rejected", "auto"), false);
});

/* ---------- 批量提审：件数护栏 + 摘要聚合 ---------- */

test("submitBatchError：空选择与超上限拦截，50 件以内放行", () => {
  assert.match(submitBatchError(0), /先勾选/);
  assert.match(submitBatchError(SUBMIT_BATCH_LIMIT + 1), /最多提审 50 件/);
  assert.equal(submitBatchError(1), "");
  assert.equal(submitBatchError(SUBMIT_BATCH_LIMIT), "");
});

test("summarizeSubmitResults：changed/reason 聚合成四档计数", () => {
  const summary = summarizeSubmitResults([
    reviewItem({ assetId: "a1", changed: true, reason: "submitted" }),
    reviewItem({ assetId: "a2", changed: true, reason: "submitted" }),
    reviewItem({ assetId: "a3", reason: "already_pending_review" }),
    reviewItem({ assetId: "a4", status: "approved", reason: "already_approved" }),
    reviewItem({ assetId: "a5", status: "rejected", reason: "already_rejected" }),
  ]);
  assert.deepEqual(summary, { total: 5, submitted: 2, alreadyPending: 1, terminal: 2 });
});

test("summarizeSubmitResults：reason=submitted 但 changed=false 不计入新提审", () => {
  const summary = summarizeSubmitResults([reviewItem({ assetId: "a1", changed: false, reason: "submitted" })]);
  assert.equal(summary.submitted, 0);
  assert.equal(summary.total, 1);
});

test("formatSubmitSummary：toast 只报汇总件数", () => {
  assert.equal(
    formatSubmitSummary({ total: 5, submitted: 3, alreadyPending: 1, terminal: 1 }),
    "新提审 3 件；1 件已在待审队列；1 件已是终态，未重复流转",
  );
  assert.equal(formatSubmitSummary({ total: 2, submitted: 2, alreadyPending: 0, terminal: 0 }), "新提审 2 件");
  assert.equal(formatSubmitSummary({ total: 0, submitted: 0, alreadyPending: 0, terminal: 0 }), "没有可提审的资产");
  assert.equal(formatSubmitSummary({ total: 1, submitted: 0, alreadyPending: 0, terminal: 1 }), "1 件已是终态，未重复流转");
});

test("submitResultLine：逐条原因说明去向，不刷屏", () => {
  assert.equal(submitResultLine(reviewItem({ assetId: "a1", changed: true, reason: "submitted" }), "任天野"), "「任天野」已送进待审队列");
  assert.equal(submitResultLine(reviewItem({ assetId: "a2", reason: "already_pending_review" }), "李承瑶"), "「李承瑶」已在待审队列，未重复提交");
  assert.equal(submitResultLine(reviewItem({ assetId: "a3", status: "approved", reason: "already_approved" }), "巷口雨夜"), "「巷口雨夜」已通过终审，不重复流转");
  assert.equal(submitResultLine(reviewItem({ assetId: "a4", status: "rejected", reason: "already_rejected" }), "银边短刀"), "「银边短刀」已拒绝留档，不重复流转");
});

/* ---------- 拒绝理由校验 ---------- */

test("rejectionReasonError：空理由禁止提交", () => {
  assert.match(rejectionReasonError(""), /理由/);
  assert.match(rejectionReasonError("   "), /理由/);
  assert.equal(rejectionReasonError("服装朝代不符"), "");
});

/* ---------- 409 判定辅助 ---------- */

test("isVersionConflict：只看 409（策略乐观锁冲突）", () => {
  assert.equal(isVersionConflict({ status: 409, code: "review_policy_version_conflict" }), true);
  assert.equal(isVersionConflict({ status: 400 }), false);
  assert.equal(isVersionConflict(new Error("boom")), false);
  assert.equal(isVersionConflict(null), false);
  assert.equal(isVersionConflict("409"), false);
});

test("isTerminalStateConflict：409 且 code 含 asset_review_terminal_state", () => {
  assert.equal(isTerminalStateConflict({ status: 409, code: "asset_review_terminal_state" }), true);
  assert.equal(isTerminalStateConflict({ status: 409, code: "prefix_asset_review_terminal_state_suffix" }), true);
  assert.equal(isTerminalStateConflict({ status: 409, code: "review_policy_version_conflict" }), false);
  assert.equal(isTerminalStateConflict({ status: 409 }), false);
  assert.equal(isTerminalStateConflict({ status: 400, code: "asset_review_terminal_state" }), false);
});

/* ---------- 策略开关 ---------- */

test("policyFor / effectiveStrategy：按 mediaKind 取策略，缺省回落安全默认待审", () => {
  const policies = [policy({ mediaKind: "image", defaultStrategy: "automatic", version: 3 })];
  assert.equal(policyFor(policies, "image")?.version, 3);
  assert.equal(policyFor(policies, "video"), null);
  assert.equal(effectiveStrategy(policyFor(policies, "image")), "automatic");
  assert.equal(effectiveStrategy(policyFor(policies, "video")), "pending_review");
  assert.equal(effectiveStrategy(null), "pending_review");
  assert.equal(effectiveStrategy(undefined), "pending_review");
  assert.equal(mediaKindLabel("image"), "图片");
  assert.equal(mediaKindLabel("video"), "视频");
});

test("DEMO_REVIEW_POLICIES：图片默认待审、视频自动过审，两种档位都可演示", () => {
  assert.equal(effectiveStrategy(policyFor(DEMO_REVIEW_POLICIES, "image")), "pending_review");
  assert.equal(effectiveStrategy(policyFor(DEMO_REVIEW_POLICIES, "video")), "automatic");
});

/* ---------- 审核轨迹 ---------- */

test("reviewActionLabel / reviewerLabel / trailFlowLabel", () => {
  assert.equal(reviewActionLabel("submitted"), "提审");
  assert.equal(reviewActionLabel("approved"), "通过");
  assert.equal(reviewActionLabel("rejected"), "拒绝");
  assert.equal(reviewerLabel(trailRecord({ id: "r1", reviewerDisplayName: " 陈默（导演） " })), "陈默（导演）");
  assert.equal(reviewerLabel(trailRecord({ id: "r2", reviewerDisplayName: null })), "未留名审核人");
  assert.equal(trailFlowLabel(trailRecord({ id: "r3", fromStatus: "pending_review", toStatus: "rejected" })), "待审核 → 已拒绝");
});

test("sortTrailRecords：新→旧排序且不改原数组", () => {
  const records = [
    trailRecord({ id: "old", createdAt: "2026-07-18T10:00:00.000Z" }),
    trailRecord({ id: "new", createdAt: "2026-07-19T09:00:00.000Z" }),
    trailRecord({ id: "mid", createdAt: "2026-07-18T16:00:00.000Z" }),
  ];
  const sorted = sortTrailRecords(records);
  assert.deepEqual(sorted.map((record) => record.id), ["new", "mid", "old"]);
  assert.deepEqual(records.map((record) => record.id), ["old", "new", "mid"]);
});

test("reviewHintFromRecords：审核人取最近经手人，拒绝理由取最近一次拒绝", () => {
  const hint = reviewHintFromRecords([
    trailRecord({ id: "r1", action: "submitted", reviewerDisplayName: "周岚（制片）", createdAt: "2026-07-18T10:00:00.000Z" }),
    trailRecord({ id: "r2", action: "rejected", reviewerDisplayName: "陈默（导演）", rejectionReason: "光位不符", createdAt: "2026-07-19T09:00:00.000Z" }),
  ]);
  assert.equal(hint.reviewerName, "陈默（导演）");
  assert.equal(hint.rejectionReason, "光位不符");
  assert.deepEqual(reviewHintFromRecords([]), { reviewerName: undefined, rejectionReason: undefined });
});

/* ---------- demo fixture ---------- */

test("withDemoReviewStatus / demoReviewHint / demoReviewActions：离线演示四态可渲染", () => {
  const base: Asset = { id: "asset-knife", asset_kind: "prop", status: "pending" };
  assert.equal(withDemoReviewStatus(base).status, "rejected");
  const untouched: Asset = { id: "asset-costume", asset_kind: "costume", status: "ready" };
  assert.equal(withDemoReviewStatus(untouched).status, "ready");
  assert.equal(demoReviewHint("asset-lin").reviewerName, "周岚（制片）");
  assert.equal(demoReviewHint("asset-knife").rejectionReason, "刀刃反光穿帮，和夜戏光位对不上");
  assert.deepEqual(demoReviewHint("asset-ren"), {});
  const trail = demoReviewActions("asset-knife");
  assert.equal(trail.length, 2);
  assert.equal(trail.every((record) => record.assetId === "asset-knife"), true);
  assert.equal(demoReviewActions("asset-ren").length > 0, true);
  assert.deepEqual(demoReviewActions("unknown-asset"), []);
});

/* ---------- H 线 P0-1：api.ts reviews 域键名归一（wire 全 snake_case，后端 success() 递归 toSnakeCaseJson） ---------- */

test("reviewPolicyFromUnknown：snake wire → camel；未知/缺省策略回落安全默认待审", () => {
  const policy = reviewPolicyFromUnknown({
    id: "policy-1",
    project_id: "p1",
    media_kind: "image",
    default_strategy: "pending_review",
    updated_by_user_id: "u1",
    version: 2,
    created_at: "2026-07-15T09:00:00.000Z",
    updated_at: "2026-07-18T09:30:00.000Z",
  });
  assert.deepEqual(policy, {
    id: "policy-1",
    projectId: "p1",
    mediaKind: "image",
    defaultStrategy: "pending_review",
    reviewerUserId: null,
    updatedByUserId: "u1",
    version: 2,
    createdAt: "2026-07-15T09:00:00.000Z",
    updatedAt: "2026-07-18T09:30:00.000Z",
  });
  /* #187 就地审核：指定审核人键透传（lite 分镜页终审权镜像判定用）。 */
  assert.equal(reviewPolicyFromUnknown({ id: null, project_id: "p1", media_kind: "image", default_strategy: "pending_review", reviewer_user_id: "u-rev" }).reviewerUserId, "u-rev");
  // 未持久化的安全默认（id null / version 0）形状保留
  const unpersisted = reviewPolicyFromUnknown({ id: null, project_id: "p1", media_kind: "video", default_strategy: "automatic", updated_by_user_id: null, version: 0, created_at: null, updated_at: null });
  assert.equal(unpersisted.id, null);
  assert.equal(unpersisted.version, 0);
  assert.equal(unpersisted.defaultStrategy, "automatic");
  // wire 缺/未知值不虚构自动过审
  assert.equal(reviewPolicyFromUnknown({ project_id: "p1" }).defaultStrategy, "pending_review");
  assert.equal(reviewPolicyFromUnknown({ default_strategy: " AUTO " }).defaultStrategy, "pending_review");
});

test("reviewActionFromUnknown：snake wire 全字段归一（含后端 routes.test 佐证的 reviewer_display_name/rejection_reason）", () => {
  const record = reviewActionFromUnknown({
    id: "ra-1",
    project_id: "p1",
    asset_id: "a1",
    action: "rejected",
    from_status: "pending_review",
    to_status: "rejected",
    reviewer_user_id: "u1",
    reviewer_display_name: "陈默（导演）",
    rejection_reason: "人物服装不符合设定",
    created_at: "2026-07-19T09:12:00.000Z",
  });
  assert.deepEqual(record, {
    id: "ra-1",
    projectId: "p1",
    assetId: "a1",
    action: "rejected",
    fromStatus: "pending_review",
    toStatus: "rejected",
    reviewerUserId: "u1",
    reviewerDisplayName: "陈默（导演）",
    rejectionReason: "人物服装不符合设定",
    createdAt: "2026-07-19T09:12:00.000Z",
  });
  // null 字段保持 null，不变成 undefined/"null" 字符串
  const sparse = reviewActionFromUnknown({ id: "ra-2", action: "submitted", reviewer_display_name: null, rejection_reason: null });
  assert.equal(sparse.reviewerDisplayName, null);
  assert.equal(sparse.rejectionReason, null);
  assert.equal(sparse.projectId, null);
});

test("崩溃簇回归：snake wire 轨迹经归一后 sortTrailRecords/trailFlowLabel/reviewHintFromRecords 不再 TypeError", () => {
  const wire = [
    { id: "ra-old", asset_id: "a1", action: "submitted", from_status: "automatic_review", to_status: "pending_review", reviewer_user_id: "u1", reviewer_display_name: "周岚（制片）", rejection_reason: null, created_at: "2026-07-18T10:00:00.000Z" },
    { id: "ra-new", asset_id: "a1", action: "rejected", from_status: "pending_review", to_status: "rejected", reviewer_user_id: "u2", reviewer_display_name: "陈默（导演）", rejection_reason: "光位不符", created_at: "2026-07-19T09:00:00.000Z" },
  ];
  const records = wire.map(reviewActionFromUnknown);
  // createdAt 恒为 string（旧读法 created_at 未归一时 localeCompare undefined 直接崩页）
  assert.deepEqual(sortTrailRecords(records).map((record) => record.id), ["ra-new", "ra-old"]);
  assert.equal(trailFlowLabel(records[0]!), "自动审核 → 待审核");
  const hint = reviewHintFromRecords(records);
  assert.equal(hint.reviewerName, "陈默（导演）");
  assert.equal(hint.rejectionReason, "光位不符");
  // created_at 缺失也不崩（兜底空串参与排序）
  assert.doesNotThrow(() => sortTrailRecords([reviewActionFromUnknown({ id: "ra-x" })]));
});

test("reviewItemFromUnknown：snake wire 归一，latest_action 嵌套同步归一", () => {
  const item = reviewItemFromUnknown({
    asset_id: "a1",
    status: "pending_review",
    changed: true,
    reason: "submitted",
    latest_action: { id: "ra-1", asset_id: "a1", action: "submitted", from_status: "automatic_review", to_status: "pending_review", reviewer_user_id: "u1", reviewer_display_name: null, rejection_reason: null, created_at: "2026-07-19T08:40:00.000Z" },
  });
  assert.equal(item.assetId, "a1");
  assert.equal(item.changed, true);
  assert.equal(item.latestAction?.fromStatus, "automatic_review");
  assert.equal(item.latestAction?.createdAt, "2026-07-19T08:40:00.000Z");
  // reason 未知值回落 submitted（不进入 already_* 计数）；latest_action 缺失给 undefined
  const fallback = reviewItemFromUnknown({ asset_id: "a2", reason: "something_new" });
  assert.equal(fallback.reason, "submitted");
  assert.equal(fallback.latestAction, undefined);
  // 归一后的 item 可直接进提审摘要聚合
  const summary = summarizeSubmitResults([item, reviewItemFromUnknown({ asset_id: "a3", status: "approved", changed: false, reason: "already_approved" })]);
  assert.deepEqual(summary, { total: 2, submitted: 1, alreadyPending: 0, terminal: 1 });
});
