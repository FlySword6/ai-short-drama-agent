/* ============================================================
   lite-telemetry.ts — Lite 试点效率事件（#93）

   只收 UUID、枚举、计数和布尔值；不接受剧本、提示词、名称、账号或错误原文。
   每条事件固定 project_id + episode_id，镜/任务/媒体按动作追加，供事件时间戳
   计算阶段耗时，并按集统计尝试、返工和选用次数。发送失败沿用 telemetry 静默纪律。
   ============================================================ */
import { track } from "../../telemetry";

interface LiteEventBase {
  projectId: string;
  episodeId: string;
}

export type LiteTelemetryInput =
  | (LiteEventBase & { event: "lite_episode_opened" })
  | (LiteEventBase & {
      event: "lite_script_submitted";
      runId: string;
      rework: boolean;
      outcome: "created" | "existing";
    })
  | (LiteEventBase & {
      event: "lite_script_confirmed";
      runId: string;
      mode: "auto" | "manual";
      outcome: "confirmed" | "already_confirmed";
      sceneCount: number;
      shotCount: number;
      completedAt?: string;
    })
  | (LiteEventBase & {
      event: "lite_script_discarded";
      runId: string;
    })
  | (LiteEventBase & {
      event: "lite_script_failed";
      runId: string;
      completedAt?: string;
    })
  | (LiteEventBase & {
      event: "lite_shot_mutated";
      shotId: string;
      action: "created" | "updated" | "deleted";
    })
  | (LiteEventBase & {
      event: "lite_generation_submitted";
      shotId: string;
      requestId: string;
      mediaKind: "image" | "video" | "audio";
      preview: boolean;
    })
  | (LiteEventBase & {
      event: "lite_media_selected";
      shotId: string;
      mediaId: string;
      mediaKind: "image" | "video" | "audio";
      approvedInAction: boolean;
    });

export interface PendingLiteRun {
  runId: string;
}

function pendingLiteRunKey(projectId: string, episodeId: string): string {
  return `shortdrama_lite_telemetry_run:${encodeURIComponent(projectId)}:${encodeURIComponent(episodeId)}`;
}

export function rememberPendingLiteRun(
  storage: Storage,
  projectId: string,
  episodeId: string,
  pending: PendingLiteRun,
): void {
  try {
    storage.setItem(pendingLiteRunKey(projectId, episodeId), JSON.stringify(pending));
  } catch { /* 恢复台账不可用时不挡创作主流程 */ }
}

export function readPendingLiteRun(
  storage: Storage,
  projectId: string,
  episodeId: string,
): PendingLiteRun | null {
  try {
    const value = JSON.parse(storage.getItem(pendingLiteRunKey(projectId, episodeId)) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    return typeof record.runId === "string" && record.runId.length > 0
      ? { runId: record.runId }
      : null;
  } catch {
    return null;
  }
}

export function forgetPendingLiteRun(storage: Storage, projectId: string, episodeId: string): void {
  try {
    storage.removeItem(pendingLiteRunKey(projectId, episodeId));
  } catch { /* 清理失败最多导致同 run 重报一次，不挡主流程 */ }
}

export interface LiteTelemetryPayload {
  event: LiteTelemetryInput["event"];
  props: Record<string, string | number | boolean>;
}

export function toLiteTelemetryPayload(input: LiteTelemetryInput): LiteTelemetryPayload {
  const base = {
    project_id: input.projectId,
    episode_id: input.episodeId,
  };
  switch (input.event) {
    case "lite_episode_opened":
      return { event: input.event, props: base };
    case "lite_script_submitted":
      return {
        event: input.event,
        props: { ...base, run_id: input.runId, rework: input.rework, outcome: input.outcome },
      };
    case "lite_script_confirmed":
      return {
        event: input.event,
        props: {
          ...base,
          run_id: input.runId,
          mode: input.mode,
          outcome: input.outcome,
          scene_count: input.sceneCount,
          shot_count: input.shotCount,
          ...(input.completedAt ? { completed_at: input.completedAt } : {}),
        },
      };
    case "lite_script_discarded":
      return { event: input.event, props: { ...base, run_id: input.runId } };
    case "lite_script_failed":
      return {
        event: input.event,
        props: { ...base, run_id: input.runId, ...(input.completedAt ? { completed_at: input.completedAt } : {}) },
      };
    case "lite_shot_mutated":
      return { event: input.event, props: { ...base, shot_id: input.shotId, action: input.action } };
    case "lite_generation_submitted":
      return {
        event: input.event,
        props: {
          ...base,
          shot_id: input.shotId,
          request_id: input.requestId,
          media_kind: input.mediaKind,
          preview: input.preview,
        },
      };
    case "lite_media_selected":
      return {
        event: input.event,
        props: {
          ...base,
          shot_id: input.shotId,
          media_id: input.mediaId,
          media_kind: input.mediaKind,
          approved_in_action: input.approvedInAction,
        },
      };
  }
}

export function trackLiteEvent(input: LiteTelemetryInput): void {
  const payload = toLiteTelemetryPayload(input);
  track(payload.event, payload.props);
}
