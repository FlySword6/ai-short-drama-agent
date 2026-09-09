/* ============================================================
   lane-generation-tracker.ts — 参考栏条目级生成任务跟踪（S16 条 2，纯逻辑）

   DC 实测缺口：「做了道具和光影的参考图，进入工作台看不到各栏生成中的
   任务状态和预览，不知道能不能标记就绪。」

   数据源口径（诚实边界）：
   - 任务注册表=前端 localStorage（按 shot 键控）：提交时记录
     (requestId, 来源参考组, kind)——同一浏览器刷新/重进可见；
   - 状态=既有 GET /generations/:id 轮询（页面可见时 ~6s，隐藏暂停）；
   - 跨浏览器/跨设备的任务归组需要列表接口带 shot_id+lane 上下文
     （generationData 目前不带）——接口缺口已报 Fable，本模块不造假。
   ============================================================ */
import type { GenerationMediaKind, GenerationStatus, GenerationTask } from "./types";
import { businessErrorMessage } from "./error-copy";

/* ---------- 任务注册表（localStorage，按 shot 键控） ---------- */

export interface LaneTaskRecord {
  requestId: string;
  /** 发起时的来源参考组（attachTarget）；null=快速通道（不归组，不在参考栏出卡）。 */
  lane: string | null;
  kind: GenerationMediaKind;
  submittedAt: string;
}

/** 每个素材最多跟踪的任务条数（超出按提交时间淘汰最旧）。 */
export const LANE_TASK_LIMIT = 12;

const KEY_PREFIX = "shortdrama_lane_tasks_v1:";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadLaneTaskRecords(storage: StorageLike, shotId: string): LaneTaskRecord[] {
  try {
    const raw = storage.getItem(`${KEY_PREFIX}${shotId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LaneTaskRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record) => record && typeof record.requestId === "string" && record.requestId);
  } catch {
    return [];
  }
}

function saveLaneTaskRecords(storage: StorageLike, shotId: string, records: readonly LaneTaskRecord[]): void {
  try {
    storage.setItem(`${KEY_PREFIX}${shotId}`, JSON.stringify(records.slice(0, LANE_TASK_LIMIT)));
  } catch {
    /* 存储满/私密模式静默降级：任务跟踪仅本次会话可见 */
  }
}

/** 提交时注册（按 requestId 去重；最新在前）。 */
export function registerLaneTask(storage: StorageLike, shotId: string, record: LaneTaskRecord): LaneTaskRecord[] {
  const current = loadLaneTaskRecords(storage, shotId).filter((item) => item.requestId !== record.requestId);
  const next = [record, ...current].slice(0, LANE_TASK_LIMIT);
  saveLaneTaskRecords(storage, shotId, next);
  return next;
}

/** 归入完成/用户清除后摘除。 */
export function unregisterLaneTask(storage: StorageLike, shotId: string, requestId: string): LaneTaskRecord[] {
  const next = loadLaneTaskRecords(storage, shotId).filter((item) => item.requestId !== requestId);
  saveLaneTaskRecords(storage, shotId, next);
  return next;
}

/* ---------- 状态与阶段语义 ---------- */

export function laneTaskIsActive(status: GenerationStatus | string | undefined): boolean {
  return status === "pending" || status === "running";
}

/** 状态徽章文案（大众认知：排队中/生成中/失败/完成/已取消）。 */
export function laneTaskStatusLabel(task: GenerationTask | null | undefined): string {
  if (!task) return "已提交";
  switch (task.status) {
    case "pending": return "排队中";
    case "running": return "生成中";
    case "succeeded": return "完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    default: return "已提交";
  }
}

/**
 * 阶段语义（没有百分比就用阶段词）：已提交 → 排队中 → 生成中 → 落库中 → 完成。
 * 终态优先于 phase（失败/取消的 attempt 也可能 phase=complete，别显示「完成」误导）。
 */
export function laneTaskStageLabel(task: GenerationTask | null | undefined): string {
  if (!task) return "已提交";
  if (["succeeded", "failed", "cancelled"].includes(task.status)) return laneTaskStatusLabel(task);
  const phase = task.phase ?? "";
  if (phase === "created" || phase === "submitting") return "已提交";
  if (phase === "provider_queued") return "排队中";
  if (phase === "provider_running") return "生成中";
  if (phase === "provider_succeeded" || phase === "persisting") return "落库中";
  if (phase === "complete") return "完成";
  return laneTaskStatusLabel(task);
}

/**
 * The only queue rank we can state truthfully is the local worker's next-claim
 * order. A provider-side "排队中" phase intentionally has no number here.
 */
export function laneTaskQueuePositionText(task: GenerationTask | null | undefined): string | null {
  if (task?.status !== "pending" || task.phase !== "created") return null;
  const position = task.queue_position;
  if (!Number.isInteger(position) || !position || position < 1) return null;
  return `本地待提交第 ${position} 位`;
}

/** Historical median only: no fallback duration is invented for small samples.
    S46 B-3:样本不足不显示耗时行(不编分钟数,也不摆「暂无估计」状态自述)。 */
export function laneTaskEstimatedDurationText(task: GenerationTask | null | undefined): string | null {
  if (!task || !laneTaskIsActive(task.status)) return null;
  const seconds = task.estimated_duration_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return `预计总耗时约 ${formatEstimatedDuration(seconds)}`;
}

/** S42: 上传队列与生成任务共用同一套耗时措辞,避免两套进度口径。 */
export function formatEstimatedDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded} 秒`;
  const minutes = Math.floor(rounded / 60);
  const remainderSeconds = rounded % 60;
  if (minutes < 60) return remainderSeconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remainderSeconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${remainderMinutes} 分`;
}

/* ---------- 失败文案（人话；条 3：outcome-unknown 单列） ---------- */

/** 提交结果未知（网络层断，任务真实状态不可知;稳定 error_code 判定,原文不读）。 */
export function laneTaskOutcomeUnknown(task: GenerationTask | null | undefined): boolean {
  if (!task || task.status !== "failed") return false;
  return task.error_code === "unknown";
}

/**
 * 失败原因人话展示（R96 全局判据 + 多模型接缝 FABLE-007）：
 * - 失败原因只读服务端脱敏 display_reason;error-copy 双保险(已知串映射/中文透传/技术串兜底);
 * - outcome-unknown 由稳定 error_code 判定,不再嗅探原文。
 */
export function laneTaskFailureText(task: GenerationTask | null | undefined): string | null {
  if (!task || task.status !== "failed") return null;
  if (laneTaskOutcomeUnknown(task)) return businessErrorMessage(task.display_reason, "提交结果暂时未知，请稍后到任务列表看状态");
  return businessErrorMessage(task.display_reason, "生成失败，可重试");
}

/* ---------- 卡片视图模型（组件唯一取数口） ---------- */

export interface LaneTaskCardModel {
  requestId: string;
  kind: GenerationMediaKind;
  /** 徽章：排队中/生成中/失败/完成/已取消。 */
  statusLabel: string;
  /** 阶段词：已提交/排队中/生成中/落库中/完成。 */
  stageLabel: string;
  active: boolean;
  failed: boolean;
  succeeded: boolean;
  failureText: string | null;
  /** outcome-unknown 专用：给重试入口。 */
  retryable: boolean;
  /** S29：只在 created 阶段显示的本地 worker 顺位。 */
  queuePositionText: string | null;
  /** S29：本地顺位之外的等待期信息;S46 B-3 起历史样本不足时为 null(不显示耗时行)。 */
  estimatedDurationText: string | null;
  /** 成功后的预览媒体（缩略图+归入用 id）。 */
  media: { id: string; url: string } | null;
}

export function laneTaskCardModel(record: LaneTaskRecord, task: GenerationTask | null | undefined): LaneTaskCardModel {
  const media = task?.media_results?.find((item) => item.media_kind === record.kind) ?? task?.media_results?.[0] ?? null;
  const mediaUrl = media?.thumbnail_url || media?.storage_url || "";
  return {
    requestId: record.requestId,
    kind: record.kind,
    statusLabel: laneTaskStatusLabel(task),
    stageLabel: laneTaskStageLabel(task),
    active: laneTaskIsActive(task?.status),
    failed: task?.status === "failed",
    succeeded: task?.status === "succeeded",
    failureText: laneTaskFailureText(task),
    retryable: task?.status === "failed",
    queuePositionText: laneTaskQueuePositionText(task),
    estimatedDurationText: laneTaskEstimatedDurationText(task),
    media: media && mediaUrl ? { id: media.id, url: mediaUrl } : null,
  };
}

/** 就绪联动：各栏进行中的任务计数（非阻断提示用）。 */
export function inflightLaneTaskCount(records: readonly LaneTaskRecord[], tasksById: Readonly<Record<string, GenerationTask>>): number {
  return records.filter((record) => record.lane && laneTaskIsActive(tasksById[record.requestId]?.status)).length;
}

/** 参考栏取卡：某栏的任务卡片列表（注册表顺序=最新在前）。 */
export function laneTaskCardsForLane(lane: string, records: readonly LaneTaskRecord[], tasksById: Readonly<Record<string, GenerationTask>>): LaneTaskCardModel[] {
  return records.filter((record) => record.lane === lane).map((record) => laneTaskCardModel(record, tasksById[record.requestId] ?? null));
}
