/* ============================================================
   review-delivery.ts — K2-A 幕四「审与交」产物审核 + 交付域(类型/归一/纯逻辑)

   契约真源(仓根,逐项核实,不许凭印象):
   - src/modules/reviews/routes.ts + mediaTypes.ts + mediaService.ts
     GET  /projects/:id/media-reviews            待审队列(status/episode_id/分页)
     POST /projects/:id/media-reviews/decisions  批量裁决(拒绝理由必填,1..200 条)
     GET  /projects/:id/media-reviews/:media_result_id/actions  单条产物审核轨迹
   - src/modules/delivery/routes.ts + service.ts + manifest.ts + repository.ts
     GET  /episodes/:id/deliverables?partial=    交付清单(partial 时带未交齐镜头)
     POST /episodes/:id/deliveries               交付落账(服务端重算清单快照)
     GET  /episodes/:id/deliveries               按集交付历史(分页)
   wire 全 snake_case(后端 success() 递归 toSnakeCaseJson,仓根 src/http/response.ts),
   下列 camelCase 类型由本文件 mapper 唯一归一,组件不直接读 wire 键名。
   ============================================================ */
import type { DeliverableManifest } from "./types";

/* ---------- 产物审核域(media-reviews) ---------- */

export const MEDIA_REVIEW_STATUSES = ["needs_review", "accepted", "rejected"] as const;
export type MediaReviewStatus = (typeof MEDIA_REVIEW_STATUSES)[number];

/** 队列单条产物(对应后端 MediaReviewQueueItem)。 */
export interface MediaReviewQueueItem {
  mediaResultId: string;
  shotId: string;
  shotCode: string;
  episodeId: string;
  episodeNo: number;
  mediaKind: string;
  originKind: string;
  reviewStatus: MediaReviewStatus;
  persistenceStatus: string;
  storageUrl: string | null;
  mimeType: string | null;
  durationSeconds: number | null;
  isPrimary: boolean;
  createdAt: string;
}

export interface MediaReviewQueuePage {
  items: MediaReviewQueueItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 裁决请求体单条(snake_case,与后端 zod 合同一致)。 */
export interface MediaReviewDecisionBody {
  media_result_id: string;
  action: "approve" | "reject";
  rejection_reason?: string;
}

export interface MediaReviewDecisionOutcome {
  mediaResultId: string;
  status: MediaReviewStatus;
  changed: boolean;
  reason: "accepted" | "rejected" | "already_accepted" | "already_rejected" | string;
}

/** 审核轨迹单条(对应后端 MediaReviewActionRecord)。 */
export interface MediaReviewActionRecord {
  id: string;
  projectId: string;
  mediaResultId: string;
  action: "accepted" | "rejected" | "auto_accepted" | string;
  fromStatus: MediaReviewStatus;
  toStatus: MediaReviewStatus;
  reviewerUserId: string | null;
  reviewerDisplayName: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

/* ---------- 交付域(deliveries) ---------- */

export type DeliveryGapReason = "missing_video_primary" | "invalid_image_primary" | "video_not_accepted" | "image_not_accepted";

/** 交付门禁返回的未交齐镜头(对应后端 DeliveryGap)。 */
export interface DeliveryGap {
  shotId: string;
  shotCode: string;
  reason: DeliveryGapReason;
}

/** deliverables?partial= 的响应:清单 + partial 标记 + 未交齐镜头列表。 */
export interface GatedManifest extends DeliverableManifest {
  partial: boolean;
  gaps: DeliveryGap[];
}

/** 交付记录(对应后端 DeliveryRecord;manifest_hash 是内容指纹,内容不变重交同值)。 */
export interface DeliveryRecord {
  id: string;
  projectId: string;
  episodeId: string;
  manifestHash: string;
  mediaResultIds: string[];
  partial: boolean;
  missingShotCodes: string[];
  purpose: string | null;
  deliveredByUserId: string;
  createdAt: string;
}

export interface DeliveryRecordPage {
  items: DeliveryRecord[];
  total: number;
  page: number;
  pageSize: number;
}

/* ---------- 归一 mapper ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function first(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function reviewStatus(value: unknown): MediaReviewStatus {
  return value === "accepted" || value === "rejected" ? value : "needs_review";
}

export function mediaReviewQueueItemFromUnknown(value: unknown): MediaReviewQueueItem {
  const record = isRecord(value) ? value : {};
  return {
    mediaResultId: str(first(record, "media_result_id", "mediaResultId")),
    shotId: str(first(record, "shot_id", "shotId")),
    shotCode: str(first(record, "shot_code", "shotCode")),
    episodeId: str(first(record, "episode_id", "episodeId")),
    episodeNo: num(first(record, "episode_no", "episodeNo")),
    mediaKind: str(first(record, "media_kind", "mediaKind")),
    originKind: str(first(record, "origin_kind", "originKind")),
    reviewStatus: reviewStatus(first(record, "review_status", "reviewStatus")),
    persistenceStatus: str(first(record, "persistence_status", "persistenceStatus")),
    storageUrl: strOrNull(first(record, "storage_url", "storageUrl")),
    mimeType: strOrNull(first(record, "mime_type", "mimeType")),
    durationSeconds: numOrNull(first(record, "duration_seconds", "durationSeconds")),
    isPrimary: first(record, "is_primary", "isPrimary") === true,
    createdAt: str(first(record, "created_at", "createdAt")),
  };
}

export function mediaReviewQueuePageFromUnknown(value: unknown): MediaReviewQueuePage {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.items) ? record.items.map(mediaReviewQueueItemFromUnknown) : [];
  return {
    items,
    total: num(record.total, items.length),
    page: num(record.page, 1),
    pageSize: num(first(record, "page_size", "pageSize"), 20),
  };
}

export function mediaReviewDecisionOutcomeFromUnknown(value: unknown): MediaReviewDecisionOutcome {
  const record = isRecord(value) ? value : {};
  return {
    mediaResultId: str(first(record, "media_result_id", "mediaResultId")),
    status: reviewStatus(record.status),
    changed: record.changed === true,
    reason: str(record.reason),
  };
}

export function mediaReviewActionFromUnknown(value: unknown): MediaReviewActionRecord {
  const record = isRecord(value) ? value : {};
  return {
    id: str(record.id),
    projectId: str(first(record, "project_id", "projectId")),
    mediaResultId: str(first(record, "media_result_id", "mediaResultId")),
    action: str(record.action),
    fromStatus: reviewStatus(first(record, "from_status", "fromStatus")),
    toStatus: reviewStatus(first(record, "to_status", "toStatus")),
    reviewerUserId: strOrNull(first(record, "reviewer_user_id", "reviewerUserId")),
    reviewerDisplayName: strOrNull(first(record, "reviewer_display_name", "reviewerDisplayName")),
    rejectionReason: strOrNull(first(record, "rejection_reason", "rejectionReason")),
    createdAt: str(first(record, "created_at", "createdAt")),
  };
}

export function deliveryGapFromUnknown(value: unknown): DeliveryGap {
  const record = isRecord(value) ? value : {};
  const reason = str(record.reason);
  return {
    shotId: str(first(record, "shot_id", "shotId")),
    shotCode: str(first(record, "shot_code", "shotCode")),
    reason: reason === "invalid_image_primary" || reason === "video_not_accepted" || reason === "image_not_accepted"
      ? reason
      : "missing_video_primary",
  };
}

/** deliverables 响应归一:items 各字段本来就是 snake 形状(types.ts DeliverableItem),
    只有 partial/gaps 需要显式归一——gaps 的 shot_id/shot_code 必须转 camel,
    否则未交齐清单渲染空镜号。 */
export function gatedManifestFromUnknown(value: unknown): GatedManifest {
  const record = isRecord(value) ? value : {};
  const base = record as unknown as DeliverableManifest;
  return {
    ...base,
    items: Array.isArray(base.items) ? base.items : [],
    partial: record.partial === true,
    gaps: Array.isArray(record.gaps) ? record.gaps.map(deliveryGapFromUnknown) : [],
  };
}

export function deliveryRecordFromUnknown(value: unknown): DeliveryRecord {
  const record = isRecord(value) ? value : {};
  const ids = first(record, "media_result_ids", "mediaResultIds");
  const missing = first(record, "missing_shot_codes", "missingShotCodes");
  return {
    id: str(record.id),
    projectId: str(first(record, "project_id", "projectId")),
    episodeId: str(first(record, "episode_id", "episodeId")),
    manifestHash: str(first(record, "manifest_hash", "manifestHash")),
    mediaResultIds: Array.isArray(ids) ? ids.filter((item): item is string => typeof item === "string") : [],
    partial: record.partial === true,
    missingShotCodes: Array.isArray(missing) ? missing.filter((item): item is string => typeof item === "string") : [],
    purpose: strOrNull(record.purpose),
    deliveredByUserId: str(first(record, "delivered_by_user_id", "deliveredByUserId")),
    createdAt: str(first(record, "created_at", "createdAt")),
  };
}

export function deliveryRecordPageFromUnknown(value: unknown): DeliveryRecordPage {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.items) ? record.items.map(deliveryRecordFromUnknown) : [];
  return {
    items,
    total: num(record.total, items.length),
    page: num(record.page, 1),
    pageSize: num(first(record, "page_size", "pageSize"), 20),
  };
}

/* ---------- 用户语言标签 ---------- */

export function reviewStatusLabel(status: MediaReviewStatus | string): string {
  if (status === "accepted") return "已通过";
  if (status === "rejected") return "已拒绝";
  return "待审核";
}

export function reviewStatusTone(status: MediaReviewStatus | string): "warning" | "success" | "danger" {
  if (status === "accepted") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

/** 未交齐原因的用户语言(避开工程词;与后端 DeliveryGap.reason 一一对应)。 */
export function gapReasonLabel(reason: DeliveryGapReason | string): string {
  if (reason === "video_not_accepted") return "视频主版本未通过审核";
  if (reason === "image_not_accepted") return "图片主版本未通过审核";
  if (reason === "invalid_image_primary") return "图片主版本无效";
  return "还没有视频主版本";
}

export function deliveryScopeLabel(partial: boolean): string {
  return partial ? "部分交付" : "完整交付";
}

/** 交付动作标签(轨迹 accepted/rejected/auto_accepted)。 */
export function reviewActionLabel(action: string): string {
  if (action === "rejected") return "拒绝";
  if (action === "auto_accepted") return "自动通过";
  return "通过";
}

/* ---------- 裁决纯逻辑 ---------- */

/** 拒绝理由客户端闸门,与后端 mediaService 422 同口径(trim 后非空)。 */
export function rejectionReasonError(reason: string): string {
  return reason.trim() ? "" : "拒绝必须写明理由，打回才不会变成猜谜";
}

/** 整集批量通过的请求体(逐条 approve;id 去重并保持原顺序)。 */
export function approveDecisionBodies(mediaResultIds: readonly string[]): MediaReviewDecisionBody[] {
  const seen = new Set<string>();
  const bodies: MediaReviewDecisionBody[] = [];
  for (const id of mediaResultIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    bodies.push({ media_result_id: id, action: "approve" });
  }
  return bodies;
}

/** 单镜拒绝的请求体(理由 trim;调用前应先过 rejectionReasonError)。 */
export function rejectDecisionBody(mediaResultId: string, reason: string): MediaReviewDecisionBody {
  return { media_result_id: mediaResultId, action: "reject", rejection_reason: reason.trim() };
}

/** 裁决结果汇总:真正改变状态的通过/拒绝数 + 已是终态的跳过数。 */
export function summarizeDecisionOutcomes(outcomes: readonly MediaReviewDecisionOutcome[]): { approved: number; rejected: number; skipped: number } {
  let approved = 0;
  let rejected = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    if (!outcome.changed) {
      skipped += 1;
    } else if (outcome.status === "accepted") {
      approved += 1;
    } else if (outcome.status === "rejected") {
      rejected += 1;
    }
  }
  return { approved, rejected, skipped };
}

/** 汇总文案:有改变说改变,全是跳过说实话。 */
export function decisionSummaryCopy(summary: { approved: number; rejected: number; skipped: number }): string {
  const parts: string[] = [];
  if (summary.approved > 0) parts.push(`通过 ${summary.approved} 条`);
  if (summary.rejected > 0) parts.push(`拒绝 ${summary.rejected} 条`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} 条已是终态未重复处理`);
  return parts.length ? `${parts.join("，")}。` : "没有需要处理的产物。";
}

/* ---------- 交付纯逻辑 ---------- */

/** 交付内容指纹短显(全串留 title 悬浮)。 */
export function shortManifestHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/** 交付历史一行的范围描述:部分交付带未交齐镜号。 */
export function deliveryRecordScopeText(record: Pick<DeliveryRecord, "partial" | "missingShotCodes">): string {
  if (!record.partial) return "完整交付";
  const missing = record.missingShotCodes.filter(Boolean);
  return missing.length ? `部分交付 · ${missing.length} 镜未交齐` : "部分交付";
}

/** 已交付集 id 集合(进度终态判定的输入形状;每集至少一条交付记录即视为已交付)。 */
export function deliveredEpisodeIdsFrom(pages: ReadonlyArray<{ episodeId: string; total: number }>): ReadonlySet<string> {
  return new Set(pages.filter((page) => page.total > 0).map((page) => page.episodeId));
}
