import { readSessionToken } from "../../auth-token";
import { handleUnauthorizedResponse } from "../../api";
import type { GenerationControlPackage, GenerationTosMediaItem, PendingGenerationIntent } from "../generation/api";

const API_PREFIX = "/api/vnext";

// ─── Video segment version types ─────────────────────────────────────────────

export type VideoChangeType = "register" | "modify" | "extend";

export interface VideoVersion {
  id: string;
  project_id: string;
  chain_id: string;
  version_no: number;
  change_type: VideoChangeType;
  origin_version_id: string | null;
  source_task_id: string;
  source_attempt_id: string;
  control_package_id: string;
  control_package_version: number;
  provider: string;
  model: string;
  prompt: string;
  parameters: Record<string, unknown>;
  tos_media: GenerationTosMediaItem[];
  estimated_cost_fen: number;
  actual_cost_fen: number | null;
  created_at: string;
}

export interface VideoChangeDraft {
  id: string;
  origin_version_id: string;
  change_type: "modify" | "extend";
  intent_id: string;
  created_at: string;
}

export interface VideoChangeDraftResult {
  draft: VideoChangeDraft;
  pending_intent: PendingGenerationIntent;
  control_package: GenerationControlPackage | null;
  outcome: "created" | "replayed";
}

export interface VideoChangeDraftRequest {
  change_type: "modify" | "extend";
  client_idempotency_key: string;
  references: GenerationControlPackage["references"];
  final_prompt: string;
  model: string;
  parameters: Record<string, unknown>;
  no_bgm: boolean;
  model_availability: GenerationControlPackage["model_availability"];
  estimated_cost_fen: number;
}

export class VideoVersionApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

// ─── Request helper ───────────────────────────────────────────────────────────

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = readSessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, { ...init, headers });
  } catch {
    throw new VideoVersionApiError("无法连接 vNext 服务，请确认后端已启动", 0, "network_error");
  }
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    data?: T;
    error?: { message?: string; code?: string };
  } | null;
  if (!response.ok) {
    handleUnauthorizedResponse(response.status, `${API_PREFIX}${path}`);
    throw new VideoVersionApiError(
      body?.error?.message ?? "视频段版本请求失败",
      response.status,
      body?.error?.code,
    );
  }
  return body?.ok === true ? (body.data as T) : (body as T);
}

// ─── API client ───────────────────────────────────────────────────────────────

export const videoVersionApi = {
  /** Refresh recovery: every chain's versions with task/cost/TOS media facts. */
  listVersions: (projectId: string) =>
    request<{ items: VideoVersion[] }>(`/projects/${encodeURIComponent(projectId)}/video-versions`),

  /**
   * Append a version from a succeeded generation task. Idempotent on the
   * source attempt: re-attaching replays the existing version.
   */
  attachVersion: (projectId: string, taskId: string) =>
    request<{ version: VideoVersion; outcome: "created" | "replayed" }>(
      `/projects/${encodeURIComponent(projectId)}/video-versions`,
      { method: "POST", body: JSON.stringify({ task_id: taskId }) },
    ),

  /**
   * Start a modify/extend draft on a saved version. Writes reviewable rows
   * only — no provider call; the human confirms via the generation flow.
   */
  createChangeDraft: (projectId: string, versionId: string, input: VideoChangeDraftRequest) =>
    request<VideoChangeDraftResult>(
      `/projects/${encodeURIComponent(projectId)}/video-versions/${encodeURIComponent(versionId)}/change-drafts`,
      { method: "POST", body: JSON.stringify(input) },
    ),
};
