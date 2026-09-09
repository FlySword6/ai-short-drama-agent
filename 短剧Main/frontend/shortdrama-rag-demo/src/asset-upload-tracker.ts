/* ============================================================
   asset-upload-tracker.ts — S42 图片上传入库任务的等待期视图模型(纯逻辑)

   口径与 S29 生成任务同源(不许另造一套):
   - 排位只对 queued 给值(与 worker 领取顺序一致),processing/终态不编数字;
   - ETA = 近 20 条成功任务耗时中位数,样本不足服务端给 null → 不显示耗时行
     (前端不补默认分钟数,也不摆「暂无估计」状态自述,S46 B-3);
   - 失败原因服务端已人话化,原样透传,缺省才兜底一句。
   ============================================================ */
import { formatEstimatedDuration } from "./lane-generation-tracker";
import type { AssetUploadNotification, AssetUploadTask } from "./types";

/** 上传任务落库(终态提醒出现)时 Dock 广播的窗口事件,资产库列表据此刷新。 */
export const ASSET_UPLOAD_SETTLED_EVENT = "shortdrama:asset-upload-settled";

/** 在途上传任务数变化时 Dock 广播的窗口事件(detail.active = 当前在途数),资产库头部计数据此并入在途。 */
export const ASSET_UPLOAD_ACTIVITY_EVENT = "shortdrama:asset-upload-activity";

/**
 * S46 C-2:头部「待入库」= 列表内待入库 + 在途上传任务数。
 * 上传在途时资产行尚未创建,不把在途并入就会 toast 说「入库中」、计数却说「0 待入库」。
 */
export function assetLibraryPendingCount(listPendingCount: number, activeUploadCount: number): number {
  return listPendingCount + Math.max(0, activeUploadCount);
}

/** Excel 资产表保持同步批量解析(一文件多资产,无单任务视图);图片走异步队列。 */
export const ASSET_UPLOAD_FILE_ACCEPT = [
  ".xlsx",
  ".xlsm",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".avi",
  ".mkv",
  ".mp3",
  ".wav",
  ".ogg",
  ".opus",
  "image/*",
  "video/*",
  "audio/*",
  "audio/mpeg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/ogg",
  "audio/opus",
].join(",");

export function isExcelUploadFile(fileName: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(fileName);
}

export function isVideoUploadFile(fileName: string): boolean {
  return /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(fileName);
}

export function isAudioUploadFile(fileName: string, mimeType = ""): boolean {
  if (/\.(mp3|wav|ogg|opus)$/i.test(fileName)) return true;
  if (/\.(m4a|aac|flac|pcm)$/i.test(fileName)) return false;
  return ["audio/mpeg", "audio/wav", "audio/wave", "audio/x-wav", "audio/ogg", "audio/opus"].includes(mimeType.trim().toLowerCase());
}

export function audioTraitListFromInput(value: string): string[] {
  return value
    .split(/[,，、\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function uploadTaskIsActive(status: AssetUploadTask["status"] | string | undefined): boolean {
  return status === "queued" || status === "processing";
}

/** 状态徽章文案(大众认知:排队中/入库中/已入库/失败)。 */
export function uploadTaskStatusLabel(task: AssetUploadTask | null | undefined): string {
  switch (task?.status) {
    case "queued": return "排队中";
    case "processing": return "入库中";
    case "succeeded": return "已入库";
    case "failed": return "失败";
    default: return "已提交";
  }
}

/** 只对 queued 给排位(与 worker 领取顺序一致);其余一律 null,不编数字。 */
export function uploadTaskQueuePositionText(task: AssetUploadTask | null | undefined): string | null {
  if (task?.status !== "queued") return null;
  const position = task.queue_position;
  if (!Number.isInteger(position) || !position || position < 1) return null;
  return `排队第 ${position} 位`;
}

/** 历史样本中位数;样本不足就不显示耗时行（不编分钟数,也不摆「暂无估计」状态自述）。 */
export function uploadTaskEstimatedDurationText(task: AssetUploadTask | null | undefined): string | null {
  if (!task || !uploadTaskIsActive(task.status)) return null;
  const seconds = task.estimated_duration_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return `预计总耗时约 ${formatEstimatedDuration(seconds)}`;
}

/** Dock 活跃卡片模型(组件唯一取数口)。 */
export interface UploadTaskCardModel {
  id: string;
  fileName: string;
  statusLabel: string;
  queuePositionText: string | null;
  estimatedDurationText: string | null;
}

/**
 * 展示用文件名:S46 B-3——机器串文件名(UUID/长哈希/长数字串,常见于外部分发导出)
 * 裸露在提醒卡上对创作者零辨识度,统一显示为「未命名图片+扩展名」;
 * 人类可读的原名原样显示。
 */
export function uploadDisplayFileName(fileName: string): string {
  const name = fileName.trim();
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  const extension = dot > 0 ? name.slice(dot) : "";
  const machineId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stem)
    || /^[0-9a-f]{24,}$/i.test(stem)
    || /^\d{16,}$/.test(stem);
  return machineId ? `未命名图片${extension}` : name;
}

export function uploadTaskCardModel(task: AssetUploadTask): UploadTaskCardModel {
  return {
    id: task.id,
    fileName: uploadDisplayFileName(task.original_file_name),
    statusLabel: uploadTaskStatusLabel(task),
    queuePositionText: uploadTaskQueuePositionText(task),
    estimatedDurationText: uploadTaskEstimatedDurationText(task),
  };
}

/** 终态提醒文案：成功报资产名，失败只读取服务端公开文案。 */
export function uploadNotificationText(notification: AssetUploadNotification): { title: string; body: string } {
  if (notification.status === "succeeded") {
    return {
      title: "图片已入库",
      body: notification.result_asset_name
        ? `「${notification.result_asset_name}」已加入个人资产库。`
        : "已加入个人资产库。",
    };
  }
  return {
    title: "图片入库失败",
    body: notification.display_reason?.trim() || "图片入库没成：请重新上传该图片。",
  };
}
