/* ============================================================
   demo-review-delivery.ts — K2-A 幕四彩排用的离线演示数据仓(只在 demo 模式读)

   为什么存在:审计(GP-27 + demo 未覆盖清单)指出幕四在 demo 里演不了——审核队列、
   部分交付、交付历史都是真接口,demo 一律弹「离线演示不提交」。本文件给这三个界面
   一份可变内存仓:裁决会真改状态、交付会真落账(页面刷新后回到初始 fixture),
   让步 15-17 在 demo 里能从头走一遍。

   语义纪律:
   - 初始队列从 demoShotMedia(demo.ts)派生,状态单一真源,不另写一份;
   - 字段形状与后端契约一致(MediaReviewQueueItem / DeliveryRecord),不发明字段;
   - demo 项目的审核策略按「先审后交」口径演示:待审核与已拒绝都不进交付,
     与后端 pending_review 策略的闸门语义一致;
   - 一切改动只在内存,标注「离线演示」。
   ============================================================ */
import { demoEpisodes, demoShotMedia, demoShots, demoUser } from "./demo";
import type {
  DeliveryGap,
  DeliveryRecord,
  DeliveryRecordPage,
  MediaReviewActionRecord,
  MediaReviewDecisionBody,
  MediaReviewDecisionOutcome,
  MediaReviewQueueItem,
  MediaReviewQueuePage,
  MediaReviewStatus,
} from "./review-delivery";

interface DemoQueueEntry {
  item: MediaReviewQueueItem;
  /** 最近一次裁决留痕(谁、何时、理由);初始已通过的为 null(视为自动通过)。 */
  lastAction: { action: "accepted" | "rejected"; reason: string | null; at: string; by: string | null } | null;
}

const DEMO_PROJECT_ID = "demo-project-2";
const DEMO_EPISODE_ID = "demo-episode-1";

let queueEntries: DemoQueueEntry[] | null = null;
let records: DeliveryRecord[] | null = null;

/* 内容指纹:与后端同语义(内容不变重交同值),demo 用本地可复算的 64 位十六进制。 */
function demoManifestHash(mediaResultIds: readonly string[]): string {
  const text = [...mediaResultIds].sort().join("|");
  let hash = 0x811c9dc5;
  let out = "";
  while (out.length < 64) {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index) + out.length;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function initialQueueEntries(): DemoQueueEntry[] {
  const episode = demoEpisodes[0]!;
  const entries: DemoQueueEntry[] = [];
  for (const shot of demoShots) {
    for (const media of demoShotMedia[shot.id] ?? []) {
      const status = (media.review_status === "accepted" || media.review_status === "rejected"
        ? media.review_status
        : "needs_review") as MediaReviewStatus;
      entries.push({
        item: {
          mediaResultId: media.id,
          shotId: shot.id,
          shotCode: shot.shot_no,
          episodeId: shot.episode_id,
          episodeNo: episode.episode_no,
          mediaKind: media.media_kind ?? "video",
          originKind: "generation",
          reviewStatus: status,
          persistenceStatus: media.persistence_status ?? "persisted",
          storageUrl: media.storage_url ?? null,
          mimeType: media.media_kind === "video" ? "video/mp4" : "image/svg+xml",
          durationSeconds: media.media_kind === "video" ? 4 : null,
          isPrimary: media.is_primary === true,
          createdAt: media.created_at ?? "2026-07-21T10:00:00Z",
        },
        lastAction: status === "rejected"
          /* 初始已拒绝候选(demo-video-5b)的拒绝留痕:让「已拒绝」页签能演示理由与打回人。 */
          ? { action: "rejected", reason: "马蹄穿帮，这镜要重拍", at: "2026-07-22T09:40:00Z", by: demoUser.display_name }
          : null,
      });
    }
  }
  return entries;
}

function initialDeliveryRecords(): DeliveryRecord[] {
  /* 一条历史交付:上周交过 3 镜送审,素材 4/5/6 当时未交齐——演示「部分交付」落账形状。 */
  return [{
    id: "demo-delivery-1",
    projectId: DEMO_PROJECT_ID,
    episodeId: DEMO_EPISODE_ID,
    manifestHash: demoManifestHash(["demo-video-1", "demo-video-2", "demo-video-3"]),
    mediaResultIds: ["demo-video-1", "demo-video-2", "demo-video-3"],
    partial: true,
    missingShotCodes: ["4", "5", "6"],
    purpose: "送审样片",
    deliveredByUserId: demoUser.id,
    createdAt: "2026-07-22T10:20:00Z",
  }];
}

function queue(): DemoQueueEntry[] {
  if (!queueEntries) queueEntries = initialQueueEntries();
  return queueEntries;
}

function deliveries(): DeliveryRecord[] {
  if (!records) records = initialDeliveryRecords();
  return records;
}

/** 测试隔离用:把内存仓退回初始 fixture。 */
export function resetDemoReviewDelivery(): void {
  queueEntries = null;
  records = null;
}

/* ---------- 审核队列 ---------- */

export function demoMediaReviewQueuePage(input: {
  status: MediaReviewStatus;
  episodeId?: string;
  page: number;
  pageSize: number;
}): MediaReviewQueuePage {
  const items = queue()
    .map((entry) => entry.item)
    .filter((item) => (!input.episodeId || item.episodeId === input.episodeId) && item.reviewStatus === input.status);
  const start = (input.page - 1) * input.pageSize;
  return {
    items: items.slice(start, start + input.pageSize),
    total: items.length,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/** 与后端 mediaService.decide 同口径的校验与流转(报错文案保持一致)。 */
export function applyDemoReviewDecisions(bodies: readonly MediaReviewDecisionBody[]): MediaReviewDecisionOutcome[] {
  if (bodies.length === 0) throw new Error("至少选择一条产物裁决");
  const seen = new Set<string>();
  for (const body of bodies) {
    if (seen.has(body.media_result_id)) throw new Error("批量裁决的 media_result_id 不能重复");
    seen.add(body.media_result_id);
    if (body.action === "reject" && !body.rejection_reason?.trim()) throw new Error("拒绝产物时必须填写拒绝理由");
    if (body.action === "approve" && body.rejection_reason !== undefined) throw new Error("通过产物时不能填写拒绝理由");
  }
  return bodies.map((body) => {
    const entry = queue().find((candidate) => candidate.item.mediaResultId === body.media_result_id);
    if (!entry) return { mediaResultId: body.media_result_id, status: "needs_review" as MediaReviewStatus, changed: false, reason: "not_found" };
    const target: MediaReviewStatus = body.action === "approve" ? "accepted" : "rejected";
    if (entry.item.reviewStatus === target) {
      return { mediaResultId: entry.item.mediaResultId, status: target, changed: false, reason: target === "accepted" ? "already_accepted" : "already_rejected" };
    }
    entry.item.reviewStatus = target;
    entry.lastAction = {
      action: target,
      reason: body.action === "reject" ? body.rejection_reason?.trim() ?? null : null,
      at: new Date().toISOString(),
      by: demoUser.display_name,
    };
    return { mediaResultId: entry.item.mediaResultId, status: target, changed: true, reason: target };
  });
}

/** 审核轨迹:初始拒绝/自动通过各一条,用户裁决后追加最新一条。 */
export function demoMediaReviewActions(mediaResultId: string): MediaReviewActionRecord[] {
  const entry = queue().find((candidate) => candidate.item.mediaResultId === mediaResultId);
  if (!entry) return [];
  const actions: MediaReviewActionRecord[] = [];
  if (entry.lastAction) {
    actions.push({
      id: `demo-action-${entry.item.mediaResultId}`,
      projectId: DEMO_PROJECT_ID,
      mediaResultId: entry.item.mediaResultId,
      action: entry.lastAction.action,
      fromStatus: "needs_review",
      toStatus: entry.lastAction.action,
      reviewerUserId: entry.lastAction.by ? demoUser.id : null,
      reviewerDisplayName: entry.lastAction.by,
      rejectionReason: entry.lastAction.reason,
      createdAt: entry.lastAction.at,
    });
  } else if (entry.item.reviewStatus === "accepted") {
    actions.push({
      id: `demo-action-${entry.item.mediaResultId}`,
      projectId: DEMO_PROJECT_ID,
      mediaResultId: entry.item.mediaResultId,
      action: "auto_accepted",
      fromStatus: "needs_review",
      toStatus: "accepted",
      reviewerUserId: null,
      reviewerDisplayName: null,
      rejectionReason: null,
      createdAt: entry.item.createdAt,
    });
  }
  return actions;
}

/* ---------- 交付 ---------- */

/** 未交齐镜头:没有视频主版本,或视频主版本未通过审核(demo 按先审后交口径)。 */
export function demoDeliveryGaps(episodeId: string): DeliveryGap[] {
  if (episodeId !== DEMO_EPISODE_ID) return [];
  const gaps: DeliveryGap[] = [];
  for (const shot of demoShots) {
    const entry = queue().find((candidate) => candidate.item.shotId === shot.id && candidate.item.mediaKind === "video" && candidate.item.isPrimary);
    if (!entry) {
      gaps.push({ shotId: shot.id, shotCode: shot.shot_no, reason: "missing_video_primary" });
    } else if (entry.item.reviewStatus !== "accepted") {
      gaps.push({ shotId: shot.id, shotCode: shot.shot_no, reason: "video_not_accepted" });
    }
  }
  return gaps;
}

/** 当前可交付的视频主版本 id(已通过审核的)。 */
export function demoReadyVideoIds(episodeId: string): string[] {
  if (episodeId !== DEMO_EPISODE_ID) return [];
  return queue()
    .filter((entry) => entry.item.mediaKind === "video" && entry.item.isPrimary && entry.item.reviewStatus === "accepted")
    .map((entry) => entry.item.mediaResultId);
}

/** 交付落账(与后端同口径:partial=有未交齐镜头;全无可交付时报错)。 */
export function createDemoDelivery(episodeId: string, input: { purpose?: string | null }): DeliveryRecord {
  const ready = demoReadyVideoIds(episodeId);
  if (!ready.length) throw new Error("当前分集没有可交付的主版本媒体");
  const gaps = demoDeliveryGaps(episodeId);
  const record: DeliveryRecord = {
    id: `demo-delivery-${Date.now()}`,
    projectId: DEMO_PROJECT_ID,
    episodeId,
    manifestHash: demoManifestHash(ready),
    mediaResultIds: ready,
    partial: gaps.length > 0,
    missingShotCodes: gaps.map((gap) => gap.shotCode),
    purpose: input.purpose?.trim() ? input.purpose.trim() : null,
    deliveredByUserId: demoUser.id,
    createdAt: new Date().toISOString(),
  };
  deliveries().unshift(record);
  return record;
}

export function demoDeliveriesPage(episodeId: string, page: number, pageSize: number): DeliveryRecordPage {
  const items = deliveries().filter((record) => record.episodeId === episodeId);
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

/** 已交付集 id 集合(进度终态判定用)。 */
export function demoDeliveredEpisodeIds(): ReadonlySet<string> {
  return new Set(deliveries().map((record) => record.episodeId));
}
