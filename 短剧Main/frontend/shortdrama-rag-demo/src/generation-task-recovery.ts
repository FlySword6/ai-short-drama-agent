import type { GenerationMediaKind, GenerationTask } from "./types";

export type GenerationTaskStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** 列举台账需要遍历键：sessionStorage/localStorage 都满足。 */
export type GenerationTaskListStorage = GenerationTaskStorage & Pick<Storage, "length" | "key">;

/* K2W：全局任务队列跨项目列举台账时按同一前缀解析（generation-task-queue.ts），不许两处各写一份。 */
export const KEY_PREFIX = "shortdrama_v01_generation_request";

function taskKey(
  projectId: string,
  shotId: string,
  mediaKind: GenerationMediaKind,
): string {
  return `${KEY_PREFIX}:${projectId}:${shotId}:${mediaKind}`;
}

export function rememberGenerationRequest(
  storage: GenerationTaskStorage,
  projectId: string,
  shotId: string,
  mediaKind: GenerationMediaKind,
  requestId: string,
): void {
  if (!requestId.trim()) return;
  storage.setItem(taskKey(projectId, shotId, mediaKind), requestId);
}

export function forgetGenerationRequest(
  storage: GenerationTaskStorage,
  projectId: string,
  shotId: string,
  mediaKind: GenerationMediaKind,
): void {
  storage.removeItem(taskKey(projectId, shotId, mediaKind));
}

export async function recoverGenerationTask(
  storage: GenerationTaskStorage,
  projectId: string,
  shotId: string,
  mediaKind: GenerationMediaKind,
  load: (requestId: string) => Promise<GenerationTask>,
): Promise<GenerationTask | null> {
  const requestId = storage.getItem(taskKey(projectId, shotId, mediaKind));
  if (!requestId) return null;
  return load(requestId);
}

/* ---------- K2J：项目级台账读取（批量提交后素材卡徽标用） ---------- */

/** 台账中一条在途任务：分镜 + 媒体类型 + 请求 id。 */
export interface TrackedGenerationRequest {
  shotId: string;
  mediaKind: GenerationMediaKind;
  requestId: string;
}

/** 按项目列举全部台账条目。键形损坏或值为空的条目跳过，不整列作废。 */
export function listGenerationRequests(
  storage: GenerationTaskListStorage,
  projectId: string,
): TrackedGenerationRequest[] {
  const prefix = `${KEY_PREFIX}:${projectId}:`;
  const items: TrackedGenerationRequest[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const mediaKind: GenerationMediaKind | null = rest.endsWith(":video") ? "video" : rest.endsWith(":image") ? "image" : null;
    if (!mediaKind) continue;
    const shotId = rest.slice(0, -(mediaKind.length + 1));
    const requestId = storage.getItem(key);
    if (!shotId || !requestId) continue;
    items.push({ shotId, mediaKind, requestId });
  }
  return items;
}

/* ---------- K2J：素材卡徽标三态判定（纯函数，组件只负责渲染） ---------- */

/**
 * queued = 任一任务排队中（带最小本地队列顺位，null 表示服务端暂未给顺位）；
 * running = 无排队但有生成中（含未识别的非终态，保守按生成中处理）；
 * failed = 任一失败（最优先，需要人处理）；
 * settled = 全部终态（成功/取消）：调用方清台账，徽标消失；
 * none = 没有可查任务。
 */
export type ShotGenerationBadge =
  | { kind: "queued"; queuePosition: number | null }
  | { kind: "running" }
  | { kind: "failed" }
  | { kind: "settled" }
  | { kind: "none" };

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "cancelled"]);

export function shotGenerationBadge(tasks: GenerationTask[]): ShotGenerationBadge {
  if (tasks.length === 0) return { kind: "none" };
  if (tasks.some((task) => task.status === "failed")) return { kind: "failed" };
  const pending = tasks.filter((task) => task.status === "pending");
  if (pending.length > 0) {
    const positions = pending
      .map((task) => task.queue_position)
      .filter((position): position is number => typeof position === "number");
    return { kind: "queued", queuePosition: positions.length > 0 ? Math.min(...positions) : null };
  }
  if (tasks.some((task) => !TERMINAL_STATUSES.has(task.status))) return { kind: "running" };
  return { kind: "settled" };
}

/** 徽标文案；settled/none 不显示徽标。 */
export function shotGenerationBadgeText(badge: ShotGenerationBadge): string | null {
  switch (badge.kind) {
    case "queued":
      return badge.queuePosition === null ? "排队中" : `排队中 · 第 ${badge.queuePosition} 位`;
    case "running":
      return "生成中";
    case "failed":
      return "失败 · 去工作台重试";
    default:
      return null;
  }
}
