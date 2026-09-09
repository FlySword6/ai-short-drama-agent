/* ============================================================
   k2-review-delivery.test.ts — K2-A 幕四「审与交」前端接通(剧本步 15-17)

   覆盖:
   1) review-delivery.ts 纯逻辑与 mapper(snake wire → camel,与后端
      reviews/mediaTypes.ts、delivery/manifest.ts+repository.ts 契约逐项对齐);
   2) demo-review-delivery.ts 彩排仓(裁决真改状态、交付真落账、未交齐镜头随状态变);
   3) production-progress.ts「已交付」终态(GP-26);
   4) 组件级渲染(renderToStaticMarkup):审核队列行/未交齐清单/交付核算/交付历史;
   5) version-modal 设主闸门(GP-22):rejected 不可设主 + 原因;
   6) 源码级接线守卫(s9 风格):生产页入口与 api 契约调用不回流。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeliveryGapList,
  DeliveryHistoryTable,
  DeliveryReadiness,
  ReviewQueueList,
} from "./components/review-delivery-panels";
import { reviewStatusLabelOf, setPrimaryGate } from "./components/version-modal";
import {
  applyDemoReviewDecisions,
  createDemoDelivery,
  demoDeliveredEpisodeIds,
  demoDeliveriesPage,
  demoDeliveryGaps,
  demoMediaReviewActions,
  demoMediaReviewQueuePage,
  demoReadyVideoIds,
  resetDemoReviewDelivery,
} from "./demo-review-delivery";
import { PRODUCTION_STEPS, inferProductionProgress, type ProductionShotRecord } from "./production-progress";
import {
  approveDecisionBodies,
  decisionSummaryCopy,
  deliveredEpisodeIdsFrom,
  deliveryGapFromUnknown,
  deliveryRecordFromUnknown,
  deliveryRecordPageFromUnknown,
  deliveryRecordScopeText,
  deliveryScopeLabel,
  gapReasonLabel,
  gatedManifestFromUnknown,
  mediaReviewActionFromUnknown,
  mediaReviewDecisionOutcomeFromUnknown,
  mediaReviewQueueItemFromUnknown,
  mediaReviewQueuePageFromUnknown,
  rejectDecisionBody,
  rejectionReasonError,
  reviewStatusLabel,
  shortManifestHash,
  summarizeDecisionOutcomes,
  type DeliveryRecord,
  type MediaReviewQueueItem,
} from "./review-delivery";
import type { Episode, Shot } from "./types";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/* ============================================================
   1) mapper:wire snake_case → 前端 camel(契约=后端 mediaRoutes.test /
      routes.test 断言过的键名)
   ============================================================ */

test("mapper:待审队列页(snake wire)归一为 camel,缺省字段有兜底", () => {
  const page = mediaReviewQueuePageFromUnknown({
    items: [{
      media_result_id: "m-1",
      shot_id: "s-1",
      shot_code: "G01",
      episode_id: "e-1",
      episode_no: 3,
      media_kind: "video",
      origin_kind: "generation",
      review_status: "rejected",
      persistence_status: "persisted",
      storage_url: "https://storage.example/v.mp4",
      mime_type: "video/mp4",
      duration_seconds: 4,
      is_primary: true,
      created_at: "2026-07-24T01:00:00.000Z",
    }],
    total: 1,
    page: 2,
    page_size: 10,
  });
  assert.equal(page.items[0]!.mediaResultId, "m-1");
  assert.equal(page.items[0]!.shotCode, "G01");
  assert.equal(page.items[0]!.episodeNo, 3);
  assert.equal(page.items[0]!.reviewStatus, "rejected");
  assert.equal(page.items[0]!.isPrimary, true);
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 10);
  // 未知状态回落 needs_review(不虚构新状态);非对象输入不炸
  assert.equal(mediaReviewQueueItemFromUnknown({ review_status: "weird" }).reviewStatus, "needs_review");
  assert.equal(mediaReviewQueuePageFromUnknown(null).items.length, 0);
});

test("mapper:裁决结果/审核轨迹/未交齐镜头/交付记录逐项归一", () => {
  const outcome = mediaReviewDecisionOutcomeFromUnknown({ media_result_id: "m-1", status: "accepted", changed: true, reason: "accepted" });
  assert.deepEqual(outcome, { mediaResultId: "m-1", status: "accepted", changed: true, reason: "accepted" });

  const action = mediaReviewActionFromUnknown({
    id: "a-1",
    project_id: "p-1",
    media_result_id: "m-1",
    action: "rejected",
    from_status: "needs_review",
    to_status: "rejected",
    reviewer_user_id: "u-1",
    reviewer_display_name: "丽芬",
    assigned_reviewer_user_id: "u-2",
    rejection_reason: "穿帮",
    created_at: "2026-07-24T02:00:00.000Z",
  });
  assert.equal(action.reviewerDisplayName, "丽芬");
  assert.equal(action.rejectionReason, "穿帮");
  assert.equal(action.toStatus, "rejected");

  assert.deepEqual(deliveryGapFromUnknown({ shot_id: "s-2", shot_code: "G02", reason: "video_not_accepted" }), {
    shotId: "s-2",
    shotCode: "G02",
    reason: "video_not_accepted",
  });
  // 未知 reason 回落 missing_video_primary(不发明原因)
  assert.equal(deliveryGapFromUnknown({ shot_id: "s", shot_code: "c", reason: "???" }).reason, "missing_video_primary");

  /* deliverables?partial=true 整体归一:gaps 必须转 camel(真栈实证:不映射会渲染空镜号) */
  const gated = gatedManifestFromUnknown({
    version: "v0.1",
    generated_at: "2026-07-24T01:00:00.000Z",
    project: { id: "p-1", name: "测试短剧" },
    episode: { id: "e-1", no: 1 },
    estimated_cost_fen: 100,
    estimated_cost_notice: "预估消耗，非云平台实际账单",
    items: [],
    partial: true,
    gaps: [{ shot_id: "s-2", shot_code: "G02", reason: "video_not_accepted" }],
  });
  assert.equal(gated.partial, true);
  assert.equal(gated.gaps[0]!.shotCode, "G02");
  assert.equal(gated.gaps[0]!.shotId, "s-2");
  assert.equal(gated.gaps[0]!.reason, "video_not_accepted");
  assert.equal(gated.episode.no, 1);

  const record = deliveryRecordFromUnknown({
    id: "d-1",
    project_id: "p-1",
    episode_id: "e-1",
    manifest_hash: "a".repeat(64),
    media_result_ids: ["v-1", "v-2"],
    partial: true,
    missing_shot_codes: ["G02"],
    purpose: "送审样片",
    delivered_by_user_id: "u-1",
    created_at: "2026-07-24T03:00:00.000Z",
  });
  assert.equal(record.manifestHash.length, 64);
  assert.deepEqual(record.missingShotCodes, ["G02"]);
  assert.equal(record.deliveredByUserId, "u-1");

  const page = deliveryRecordPageFromUnknown({ items: [record], total: 7, page: 1, page_size: 20 });
  assert.equal(page.total, 7);
  assert.equal(page.items[0]!.id, "d-1");
});

/* ============================================================
   2) 裁决纯逻辑:理由闸门/请求体/结果汇总
   ============================================================ */

test("拒绝理由闸门与后端 422 同口径:空/全空白被拦,有理由放行", () => {
  assert.ok(rejectionReasonError(""));
  assert.ok(rejectionReasonError("   "));
  assert.equal(rejectionReasonError("马蹄穿帮"), "");
  // 请求体 trim;批量通过去重且保序
  assert.deepEqual(rejectDecisionBody("m-1", "  穿帮  "), { media_result_id: "m-1", action: "reject", rejection_reason: "穿帮" });
  assert.deepEqual(approveDecisionBodies(["m-1", "m-2", "m-1", "", "m-3"]).map((body) => body.media_result_id), ["m-1", "m-2", "m-3"]);
});

test("裁决结果汇总:改变/终态跳过分开计数,汇总文案说实话", () => {
  const summary = summarizeDecisionOutcomes([
    { mediaResultId: "m-1", status: "accepted", changed: true, reason: "accepted" },
    { mediaResultId: "m-2", status: "rejected", changed: true, reason: "rejected" },
    { mediaResultId: "m-3", status: "accepted", changed: false, reason: "already_accepted" },
  ]);
  assert.deepEqual(summary, { approved: 1, rejected: 1, skipped: 1 });
  assert.ok(decisionSummaryCopy(summary).includes("通过 1 条"));
  assert.ok(decisionSummaryCopy(summary).includes("拒绝 1 条"));
  assert.ok(decisionSummaryCopy(summary).includes("1 条已是终态"));
  assert.equal(decisionSummaryCopy({ approved: 0, rejected: 0, skipped: 0 }), "没有需要处理的产物。");
});

test("标签与短显:状态/未交齐原因/范围/指纹", () => {
  assert.equal(reviewStatusLabel("needs_review"), "待审核");
  assert.equal(reviewStatusLabel("accepted"), "已通过");
  assert.equal(reviewStatusLabel("rejected"), "已拒绝");
  assert.equal(gapReasonLabel("missing_video_primary"), "还没有视频主版本");
  assert.equal(gapReasonLabel("video_not_accepted"), "视频主版本未通过审核");
  assert.equal(deliveryScopeLabel(true), "部分交付");
  assert.equal(deliveryScopeLabel(false), "完整交付");
  assert.equal(shortManifestHash("a".repeat(64)), `${"a".repeat(12)}…`);
  assert.equal(deliveryRecordScopeText({ partial: true, missingShotCodes: ["5", "6"] }), "部分交付 · 2 镜未交齐");
  assert.equal(deliveryRecordScopeText({ partial: false, missingShotCodes: [] }), "完整交付");
  assert.deepEqual([...deliveredEpisodeIdsFrom([{ episodeId: "e-1", total: 2 }, { episodeId: "e-2", total: 0 }])], ["e-1"]);
});

/* ============================================================
   3) demo 彩排仓:初始剧情 → 裁决改状态 → 未交齐随状态变 → 交付落账
   ============================================================ */

test("demo 初始:第 1 集 14 条产物,待审核 2 条(素材2/4候选粗剪),已拒绝 1 条(素材5候选)", () => {
  /* K2-P(GP-27 重做):主版本 5 镜全过审可交付+#6 缺口;待审/已拒绝由非主版本候选承担,
     队列三页签都有内容且不挡交付(交付只数视频主版本)。 */
  resetDemoReviewDelivery();
  const all = demoMediaReviewQueuePage({ status: "needs_review", episodeId: "demo-episode-1", page: 1, pageSize: 50 });
  assert.equal(all.total, 2);
  assert.deepEqual(all.items.map((item) => item.mediaResultId), ["demo-video-2b", "demo-video-4b"]);
  assert.ok(all.items.every((item) => !item.isPrimary), "待审候选不应占主版本位");
  const rejected = demoMediaReviewQueuePage({ status: "rejected", episodeId: "demo-episode-1", page: 1, pageSize: 50 });
  assert.equal(rejected.total, 1);
  assert.equal(rejected.items[0]!.mediaResultId, "demo-video-5b");
  const accepted = demoMediaReviewQueuePage({ status: "accepted", episodeId: "demo-episode-1", page: 1, pageSize: 50 });
  assert.equal(accepted.total, 11);
  // 其他集没有产物(如实空页,不凑数)
  assert.equal(demoMediaReviewQueuePage({ status: "needs_review", episodeId: "demo-episode-2", page: 1, pageSize: 50 }).total, 0);
  // 初始未交齐 = 素材6(缺口镜,没有视频主版本);5 镜主版本过审可交付
  assert.deepEqual(demoDeliveryGaps("demo-episode-1").map((gap) => gap.shotCode), ["6"]);
  assert.deepEqual(demoDeliveryGaps("demo-episode-1").map((gap) => gap.reason), ["missing_video_primary"]);
  assert.equal(demoReadyVideoIds("demo-episode-1").length, 5);
});

test("demo 裁决:校验口径与后端一致(无理由/重复/通过带理由都报错),终态不重复流转", () => {
  resetDemoReviewDelivery();
  assert.throws(() => applyDemoReviewDecisions([]), /至少选择一条产物裁决/);
  assert.throws(() => applyDemoReviewDecisions([{ media_result_id: "demo-video-2b", action: "reject" }]), /拒绝产物时必须填写拒绝理由/);
  assert.throws(() => applyDemoReviewDecisions([{ media_result_id: "demo-video-2b", action: "approve", rejection_reason: "x" }]), /通过产物时不能填写拒绝理由/);
  assert.throws(() => applyDemoReviewDecisions([
    { media_result_id: "demo-video-2b", action: "approve" },
    { media_result_id: "demo-video-2b", action: "approve" },
  ]), /不能重复/);
  // 已拒绝是终态:再裁决 changed=false
  const terminal = applyDemoReviewDecisions([{ media_result_id: "demo-video-5b", action: "reject", rejection_reason: "再拒一次" }]);
  assert.equal(terminal[0]!.changed, false);
  assert.equal(terminal[0]!.reason, "already_rejected");
});

test("demo 走一遍:单镜拒绝 → 批量通过 → 部分交付落账 → 历史与终态同步", () => {
  resetDemoReviewDelivery();
  // 单镜拒绝素材2候选(理由必填)
  const rejected = applyDemoReviewDecisions([rejectDecisionBody("demo-video-2b", "节奏拖沓，重剪")]);
  assert.equal(rejected[0]!.changed, true);
  // 批量通过剩余待审(素材4候选)
  const approved = applyDemoReviewDecisions(approveDecisionBodies(["demo-video-4b"]));
  assert.equal(approved[0]!.changed, true);
  // 未交齐仍是素材6(缺口镜;候选版本不进交付核算)
  assert.deepEqual(demoDeliveryGaps("demo-episode-1").map((gap) => gap.shotCode), ["6"]);
  const record = createDemoDelivery("demo-episode-1", { purpose: "送审样片 v2" });
  assert.equal(record.partial, true);
  assert.deepEqual(record.missingShotCodes, ["6"]);
  assert.equal(record.mediaResultIds.length, 5);
  assert.equal(record.purpose, "送审样片 v2");
  assert.equal(record.manifestHash.length, 64);
  // 内容不变重交同指纹
  const again = createDemoDelivery("demo-episode-1", {});
  assert.equal(again.manifestHash, record.manifestHash);
  assert.equal(again.purpose, null);
  // 历史:新记录在前,初始历史在;已交付集含第 1 集
  const history = demoDeliveriesPage("demo-episode-1", 1, 20);
  assert.equal(history.total, 3);
  assert.equal(history.items[0]!.id, again.id);
  assert.ok(demoDeliveredEpisodeIds().has("demo-episode-1"));
  // 空集交付报错(与后端 409 同文案)
  assert.throws(() => createDemoDelivery("demo-episode-2", {}), /当前分集没有可交付的主版本媒体/);
  // 轨迹:素材5候选的初始拒绝留痕(理由+打回人),素材2候选追加最新拒绝
  const trail5b = demoMediaReviewActions("demo-video-5b");
  assert.equal(trail5b[0]!.rejectionReason, "马蹄穿帮，这镜要重拍");
  const trail2b = demoMediaReviewActions("demo-video-2b");
  assert.equal(trail2b[0]!.action, "rejected");
  assert.equal(trail2b[0]!.rejectionReason, "节奏拖沓，重剪");
  assert.ok(trail2b[0]!.reviewerDisplayName);
});

/* ============================================================
   4) 进度「已交付」终态(GP-26)
   ============================================================ */

const episode: Episode = { id: "e-1", project_id: "p-1", episode_no: 1, status: "active" };
const readyShot: Shot = { id: "s-1", episode_id: "e-1", shot_no: "1", selected_image_result_id: "i-1", selected_video_result_id: "v-1" };

function readyRecords(): ProductionShotRecord[] {
  return [{
    episode,
    shot: readyShot,
    media: [
      { id: "i-1", media_kind: "image", persistence_status: "persisted", storage_url: "https://x/i.png" },
      { id: "v-1", media_kind: "video", persistence_status: "persisted", storage_url: "https://x/v.mp4" },
    ],
  }];
}

test("进度终态:全集有交付记录 → delivered(索引越过上一步);没有 → 停在 delivery;不传集合 → 旧行为", () => {
  assert.equal(PRODUCTION_STEPS.at(-1)!.key, "delivered");
  assert.equal(PRODUCTION_STEPS.length, 6);
  const delivered = inferProductionProgress(readyRecords(), new Set(["e-1"]));
  assert.equal(delivered.current, "delivered");
  assert.equal(delivered.currentIndex, PRODUCTION_STEPS.length - 1);
  assert.equal(delivered.actionLabel, "查看交付历史");
  // 另一集没交付记录 → 不停在终态(不说谎)
  const twoEpisodes = [...readyRecords(), { episode: { ...episode, id: "e-2" }, shot: { ...readyShot, id: "s-2", episode_id: "e-2" }, media: readyRecords()[0]!.media }];
  assert.equal(inferProductionProgress(twoEpisodes, new Set(["e-1"])).current, "delivery");
  // 兼容旧调用(工作台 NextPendingShotEntry 不传集合):永不误报已交付
  assert.equal(inferProductionProgress(readyRecords()).current, "delivery");
  // 空记录不受集合影响
  assert.equal(inferProductionProgress([], new Set(["e-1"])).current, "storyboard");
});

/* ============================================================
   5) 组件级渲染(renderToStaticMarkup,不经 Radix 壳)
   ============================================================ */

const queueItem: MediaReviewQueueItem = {
  mediaResultId: "m-1",
  shotId: "s-1",
  shotCode: "5",
  episodeId: "e-1",
  episodeNo: 1,
  mediaKind: "video",
  originKind: "generation",
  reviewStatus: "needs_review",
  persistenceStatus: "persisted",
  storageUrl: "https://x/v.mp4",
  mimeType: "video/mp4",
  durationSeconds: 4,
  isPrimary: true,
  createdAt: "2026-07-24T01:00:00.000Z",
};

function renderQueueList(props: Partial<Parameters<typeof ReviewQueueList>[0]>): string {
  return renderToStaticMarkup(React.createElement(ReviewQueueList, {
    items: [queueItem],
    status: "needs_review",
    episodeNo: 1,
    canWrite: true,
    busy: "",
    expandedId: null,
    projectId: "p-1",
    demoMode: true,
    onApprove: () => undefined,
    onReject: () => undefined,
    onToggleTrail: () => undefined,
    ...props,
  }));
}

test("审核队列行:待审核给通过/拒绝;已拒绝明示不能设主且不出动作;只读角色不出动作", () => {
  const pending = renderQueueList({});
  assert.ok(pending.includes("素材 #5"), "镜号缺失");
  assert.ok(pending.includes("待审核"), "状态徽标缺失");
  assert.ok(pending.includes("通过"), "缺通过按钮");
  assert.ok(pending.includes("拒绝"), "缺拒绝按钮");
  assert.ok(pending.includes("主版本"), "主版本徽标缺失");

  const rejected = renderQueueList({ items: [{ ...queueItem, reviewStatus: "rejected" }], status: "rejected" });
  assert.ok(rejected.includes("已拒绝"), "拒绝徽标缺失");
  assert.ok(rejected.includes("不能设为主版本"), "rejected 设主拦截说明缺失(GP-22)");
  assert.ok(!rejected.includes(">通过<"), "终态不应出通过按钮");

  const readonly = renderQueueList({ canWrite: false });
  assert.ok(!readonly.includes(">通过<"), "只读角色不应出通过按钮");

  const empty = renderQueueList({ items: [] });
  assert.ok(empty.includes("这一集没有待审核的产物"), "空态人话缺失");
});

test("交付核算:部分交付逐镜列出未交齐(哪镜差、差在哪);全齐给完整交付", () => {
  const partial = renderToStaticMarkup(React.createElement(DeliveryReadiness, {
    readyCount: 4,
    totalShots: 6,
    gaps: [
      { shotId: "s-5", shotCode: "5", reason: "video_not_accepted" },
      { shotId: "s-6", shotCode: "6", reason: "missing_video_primary" },
    ],
  }));
  assert.ok(partial.includes("4 / 6 镜可交付"), "可交付计数缺失");
  assert.ok(partial.includes("部分交付"), "部分交付徽标缺失");
  assert.ok(partial.includes("素材 #5"), "未交齐镜号缺失");
  assert.ok(partial.includes("视频主版本未通过审核"), "未交齐原因缺失");
  assert.ok(partial.includes("素材 #6"), "第二未交齐镜号缺失");
  assert.ok(partial.includes("还没有视频主版本"), "缺主版本原因缺失");

  const full = renderToStaticMarkup(React.createElement(DeliveryReadiness, { readyCount: 6, totalShots: 6, gaps: [] }));
  assert.ok(full.includes("可以完整交付"), "完整交付徽标缺失");
  assert.ok(!full.includes("部分交付 ·"), "全齐不应列未交齐");

  const gapList = renderToStaticMarkup(React.createElement(DeliveryGapList, { gaps: [{ shotId: "s-6", shotCode: "6", reason: "image_not_accepted" }] }));
  assert.ok(gapList.includes("图片主版本未通过审核"), "图片未过审原因缺失");
});

test("交付历史表:时间/范围/未交齐/用途/交付人/指纹;成员名解析,退出成员如实标注", () => {
  const record: DeliveryRecord = {
    id: "d-1",
    projectId: "p-1",
    episodeId: "e-1",
    manifestHash: "b".repeat(64),
    mediaResultIds: ["v-1", "v-2", "v-3", "v-4", "v-5"],
    partial: true,
    missingShotCodes: ["6"],
    purpose: "送审样片",
    deliveredByUserId: "u-1",
    createdAt: "2026-07-24T03:00:00.000Z",
  };
  const html = renderToStaticMarkup(React.createElement(DeliveryHistoryTable, { records: [record], memberNames: { "u-1": "丽芬" } }));
  assert.ok(html.includes("部分交付"), "范围徽标缺失");
  assert.ok(html.includes("5 条产物"), "产物数缺失");
  assert.ok(html.includes("第 6 镜"), "未交齐镜号缺失");
  assert.ok(html.includes("送审样片"), "用途缺失");
  assert.ok(html.includes("丽芬"), "交付人显示名缺失");
  assert.ok(html.includes("b".repeat(12)), "内容指纹短显缺失");
  assert.ok(html.includes(`title="${"b".repeat(64)}"`), "指纹全串应留 title 悬浮");

  const former = renderToStaticMarkup(React.createElement(DeliveryHistoryTable, { records: [{ ...record, deliveredByUserId: "u-gone" }], memberNames: {} }));
  assert.ok(former.includes("已退出的成员"), "退出成员应如实标注而非裸 id");

  const empty = renderToStaticMarkup(React.createElement(DeliveryHistoryTable, { records: [], memberNames: {} }));
  assert.ok(empty.includes("本集还没有交付记录"), "历史空态缺失");
});

/* ============================================================
   6) version-modal 设主闸门(GP-22)
   ============================================================ */

test("设主闸门:rejected 不可选并给原因;is_primary 不可重复设;accepted/待审核放行", () => {
  const rejected = setPrimaryGate({ review_status: "rejected", is_primary: false });
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.reason.includes("审核已拒绝"));
  assert.ok(rejected.reason.includes("审核队列"), "原因应指去审核队列看理由");
  assert.equal(setPrimaryGate({ review_status: "accepted", is_primary: true }).allowed, false);
  assert.equal(setPrimaryGate({ review_status: "accepted", is_primary: false }).allowed, true);
  assert.equal(setPrimaryGate({ review_status: "needs_review", is_primary: false }).allowed, true);
  assert.equal(reviewStatusLabelOf({ review_status: "rejected" }), "已拒绝");
  assert.equal(reviewStatusLabelOf({ review_status: "accepted" }), "已通过");
  assert.equal(reviewStatusLabelOf({ review_status: "needs_review" }), "待审核");
  assert.equal(reviewStatusLabelOf({ review_status: undefined }), null);
});

/* ============================================================
   7) 源码级接线守卫(s9 风格):入口/契约调用/深链不回流
   ============================================================ */

test("api.ts 接通 media-reviews 与 deliveries 契约(审计:前端曾零调用)", () => {
  const apiSource = readSource("./api.ts");
  assert.ok(apiSource.includes("/media-reviews${queryString"), "缺待审队列调用");
  assert.ok(apiSource.includes("/media-reviews/decisions"), "缺批量裁决调用");
  assert.ok(apiSource.includes("/media-reviews/${encodeURIComponent(mediaResultId)}/actions"), "缺审核轨迹调用");
  assert.ok(apiSource.includes("/deliveries${queryString({ page, page_size: pageSize })}"), "缺交付历史调用");
  assert.ok(apiSource.includes("/deliveries`,") && apiSource.includes("partial: input.partial === true"), "缺交付落账调用");
  assert.ok(apiSource.includes("review_status"), "MediaVersion 未映射 review_status(GP-22 前提)");
});

test("生产页有审核队列/交付入口与深链,入口文案不混资产审核", () => {
  const pages = readSource("./pages/project-pages.tsx");
  assert.ok(pages.includes("审核队列"), "缺审核队列入口");
  assert.ok(pages.includes("交付本集"), "缺交付入口");
  assert.ok(pages.includes("MediaReviewQueueModal") && pages.includes("EpisodeDeliveryModal"), "两个弹窗未挂载");
  assert.ok(pages.includes('params.get("delivery")'), "缺交付深链");
  assert.ok(pages.includes("episode-delivered"), "落账后未通知进度条");
});

test("demo fixture 单一真源:队列从 demoShotMedia 派生,stepper 不再固定空媒体(GP-27)", () => {
  const demoStore = readSource("./demo-review-delivery.ts");
  assert.ok(demoStore.includes("demoShotMedia"), "彩排仓应从 demoShotMedia 派生");
  const stepper = readSource("./production-stepper.tsx");
  assert.ok(!stepper.includes("shot, media: [] }"), "demo 进度记录不应再固定空媒体(旧写法)");
  assert.ok(stepper.includes("media: demoShotMedia[shot.id]"), "stepper 应读共享媒体 fixture");
  const demo = readSource("./demo.ts");
  assert.ok(demo.includes("selected_video_result_id"), "demo 素材应有已选视频主版本");
});
