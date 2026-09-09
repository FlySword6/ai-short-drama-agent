/* ============================================================
   generation-task-queue.ts — K2W「全局生产任务队列」纯函数层

   DC 痛点:「我在图片页生成了两张图片,然后没有地方让我可以知道
   我提交的任务是什么状态,只能被动等待。」

   在途真源 = K2J 会话台账(sessionStorage,workbench/批量提交时
   rememberGenerationRequest 写入)+ GET /api/v1/generations/:id
   单任务查询(仓内唯一在途状态源);终态通知近条目 =
   GET /api/v1/generation-attempt-notifications(K2G 首页动态条同源)。
   本模块只有纯函数:跨项目台账列举、阶段分桶、在途计数、文案、跳链。
   组件见 components/task-queue-entry.tsx。

   接缝(后端未补,本包不造):generationData 不序列化 shot_id/episode_id,
   跨会话/跨设备的在途归组列表要后端补字段才有真源;本会话内可见
   由台账覆盖(见 docs/validation/k2-taskqueue.md)。
   ============================================================ */
import { KEY_PREFIX, type GenerationTaskListStorage } from "./generation-task-recovery";
import { humanErrorMessage } from "./pages/batch-generate-drawer";
import { projectStoryboardPath } from "./routing";
import type { GenerationMediaKind, GenerationTask } from "./types";

/** 跨项目台账条目:在 K2J TrackedGenerationRequest 上补 projectId(全局队列按项目归组)。 */
export interface QueueLedgerEntry {
  projectId: string;
  shotId: string;
  mediaKind: GenerationMediaKind;
  requestId: string;
}

/**
 * 跨项目列举全部台账条目(全局队列的在途全集)。
 * 键形 = KEY_PREFIX:projectId:shotId:mediaKind(projectId/shotId 均不含冒号);
 * 键形损坏或值为空的条目跳过,不整列作废——与 K2J listGenerationRequests 同一纪律。
 */
export function listAllGenerationRequests(storage: GenerationTaskListStorage): QueueLedgerEntry[] {
  const prefix = `${KEY_PREFIX}:`;
  const items: QueueLedgerEntry[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const mediaKind: GenerationMediaKind | null = rest.endsWith(":video") ? "video" : rest.endsWith(":image") ? "image" : null;
    if (!mediaKind) continue;
    const middle = rest.slice(0, -(mediaKind.length + 1));
    const separator = middle.indexOf(":");
    if (separator <= 0) continue;
    const projectId = middle.slice(0, separator);
    const shotId = middle.slice(separator + 1);
    const requestId = storage.getItem(key);
    if (!projectId || !shotId || !requestId) continue;
    items.push({ projectId, shotId, mediaKind, requestId });
  }
  return items;
}

/** 面板行模型:台账条目 + 已查到的任务 + 解析后的展示名/跳链参数(demo fixture 同形)。 */
export interface TaskQueueRow {
  entry: QueueLedgerEntry;
  task?: GenerationTask;
  /** 项目名(api.project 解析);未解析到不显示名称行,不造假名。 */
  projectName?: string;
  /** 镜标签(分镜 title 或「素材 N」);未解析到不显示。 */
  shotLabel?: string;
  /** 跳链参数(api.shot 解析);null/undefined 回落项目生产页。 */
  episodeId?: string | null;
}

/* ---------- 阶段分桶(与 K2J 徽标同一语义,粒度细到单任务) ---------- */

export type TaskQueuePhase = "queued" | "running" | "failed" | "settled";

const SETTLED_STATUSES: ReadonlySet<string> = new Set(["succeeded", "cancelled"]);

/**
 * 单任务阶段:failed 终态保留(需要人处理);succeeded/cancelled → settled(调用方清台账);
 * pending → queued;running 与其他未识别非终态保守 → running;
 * task 未查到(首拍前)乐观 queued——登记即排队,与 K2J 徽标首拍口径一致,不闪空。
 */
export function taskQueuePhase(task: GenerationTask | undefined): TaskQueuePhase {
  if (!task) return "queued";
  if (task.status === "failed") return "failed";
  if (SETTLED_STATUSES.has(task.status)) return "settled";
  if (task.status === "pending") return "queued";
  return "running";
}

/** 顶栏徽标在途数 = 未终态(queued+running)任务数;failed 是终态不计数,settled 已清出台账。 */
export function activeTaskCount(tasks: readonly (GenerationTask | undefined)[]): number {
  return tasks.filter((task) => {
    const phase = taskQueuePhase(task);
    return phase === "queued" || phase === "running";
  }).length;
}

/** 面板分桶:在途区(queued+running)与需要处理区(failed);settled 行不进面板(已清台账)。 */
export function splitQueueRows(rows: readonly TaskQueueRow[]): { activeRows: TaskQueueRow[]; failedRows: TaskQueueRow[] } {
  const activeRows: TaskQueueRow[] = [];
  const failedRows: TaskQueueRow[] = [];
  for (const row of rows) {
    const phase = taskQueuePhase(row.task);
    if (phase === "queued" || phase === "running") activeRows.push(row);
    else if (phase === "failed") failedRows.push(row);
  }
  return { activeRows, failedRows };
}

/** 阶段文案:排队中带服务端队列顺位(null 如实省略);settled 不显示。 */
export function queuePhaseText(task: GenerationTask | undefined): string {
  switch (taskQueuePhase(task)) {
    case "queued": {
      const position = typeof task?.queue_position === "number" ? task.queue_position : null;
      return position === null ? "排队中" : `排队中 · 第 ${position} 位`;
    }
    case "running":
      return "生成中";
    case "failed":
      return "已失败";
    default:
      return "";
  }
}

/**
 * 预计时长文案:estimated_duration_seconds 为 null(真实历史样本不足,见
 * generation/routes.ts S29 注释)时如实不显示,前端不补默认分钟数。
 */
export function queueEstimateText(task: GenerationTask | undefined): string | null {
  const seconds = task?.estimated_duration_seconds;
  if (typeof seconds !== "number" || seconds <= 0) return null;
  if (seconds < 60) return `预计约 ${Math.round(seconds)} 秒`;
  return `预计约 ${Math.round(seconds / 60)} 分钟`;
}

/** 失败原因一句人话(仓内 humanErrorMessage;K2V 错误映射合入后可换源,不换口径)。
    多模型接缝:display_reason 已是服务端脱敏人话,直读;humanErrorMessage 兜底防裸串。 */
export function queueFailureText(task: GenerationTask | undefined): string | null {
  if (!task || task.status !== "failed") return null;
  return humanErrorMessage(task.display_reason ?? "", "任务失败,去工作台看任务卡");
}

/** 媒体类型文案(三态:图片/视频/音频)。 */
export function queueMediaKindText(mediaKind: GenerationMediaKind): string {
  return mediaKind === "video" ? "视频" : mediaKind === "audio" ? "音频" : "图片";
}

/**
 * 面板行跳链:有 episodeId 直达对应镜工作台;拿不到(解析失败/分镜已删)
 * 回落项目生产页,不跳死链。episodeId 由组件侧 api.shot(shotId) 解析
 * (台账不存 episodeId;demo fixture 直接带)。
 */
export function queueItemPath(projectId: string, shotId: string, episodeId: string | null): string {
  if (episodeId) {
    return `${projectStoryboardPath(projectId)}/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(shotId)}`;
  }
  return projectStoryboardPath(projectId);
}
