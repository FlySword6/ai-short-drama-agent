import { readSessionToken } from "../../auth-token";
import { handleUnauthorizedResponse } from "../../api";

const API_PREFIX = "/api/vnext";

export interface GenerationReference {
  reference_id: string;
  reference_version_id: string;
  label: string;
  reason: string;
  position: number;
  capability_snapshot: { version: string; captured_at: string; capabilities: string[] };
}
export interface GenerationControlPackage {
  id: string;
  project_id: string;
  version: number;
  references: GenerationReference[];
  final_prompt: string;
  model: string;
  parameters: Record<string, unknown>;
  no_bgm: boolean;
  model_availability: { status: "available" | "unavailable"; checked_at: string; reason?: string };
  estimated_cost_fen: number;
}
export interface PendingGenerationIntent {
  id: string;
  control_package_id: string;
  control_package_version: number;
  references: GenerationReference[];
  final_prompt: string;
  model: string;
  parameters: Record<string, unknown>;
  no_bgm: boolean;
  estimated_cost_fen: number;
  status: "pending_confirmation";
  created_at: string;
}
export interface GenerationWorkbench {
  control_package: GenerationControlPackage | null;
  pending_intent: PendingGenerationIntent | null;
}

// ─── Generation task types ───────────────────────────────────────────────────

export type GenerationTaskStatus = "created" | "running" | "succeeded" | "failed";

export type GenerationAttemptStatus =
  | "created"
  | "submitting"
  | "provider_queued"
  | "provider_running"
  | "provider_succeeded"
  | "copying_to_tos"
  | "succeeded"
  | "failed"
  | "unknown_outcome";

export interface GenerationTosMediaItem {
  provider_result_key: string;
  storage_bucket: string;
  object_key: string;
  storage_url: string;
  mime_type: string;
  sha256: string;
  duration_seconds: number | null;
  copied_at: string;
}

export interface GenerationAttempt {
  id: string;
  attempt_no: number;
  status: GenerationAttemptStatus;
  provider_task_id: string | null;
  tos_media: GenerationTosMediaItem[];
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface GenerationTask {
  id: string;
  project_id: string;
  intent_id: string;
  control_package_id: string;
  control_package_version: number;
  references: GenerationReference[];
  provider: string;
  model: string;
  prompt: string;
  no_bgm: boolean;
  parameters: Record<string, unknown>;
  estimated_cost_fen: number;
  status: GenerationTaskStatus;
  created_at: string;
}

export interface GenerationTaskView {
  task: GenerationTask;
  latest_attempt: GenerationAttempt | null;
}

// ─── API error ───────────────────────────────────────────────────────────────

export class GenerationIntentApiError extends Error {
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
    throw new GenerationIntentApiError("无法连接 vNext 服务，请确认后端已启动", 0, "network_error");
  }
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    data?: T;
    error?: { message?: string; code?: string };
  } | null;
  if (!response.ok) {
    handleUnauthorizedResponse(response.status, `${API_PREFIX}${path}`);
    throw new GenerationIntentApiError(
      body?.error?.message ?? "生成控制包请求失败",
      response.status,
      body?.error?.code,
    );
  }
  return body?.ok === true ? (body.data as T) : (body as T);
}

// ─── API client ───────────────────────────────────────────────────────────────

export const generationIntentApi = {
  /** Fetch the current generation workbench (control package + pending intent). */
  workbench: (projectId: string) =>
    request<GenerationWorkbench>(`/projects/${encodeURIComponent(projectId)}/generation-workbench`),

  saveControlPackage: (
    projectId: string,
    input: Omit<GenerationControlPackage, "id" | "project_id" | "version">,
  ) =>
    request<{ control_package: GenerationControlPackage }>(
      `/projects/${encodeURIComponent(projectId)}/control-package`,
      { method: "PUT", body: JSON.stringify(input) },
    ),

  createPendingIntent: (projectId: string, clientIdempotencyKey: string) =>
    request<{ pending_intent: PendingGenerationIntent; outcome: "created" | "replayed" }>(
      `/projects/${encodeURIComponent(projectId)}/pending-generation-intents`,
      { method: "POST", body: JSON.stringify({ client_idempotency_key: clientIdempotencyKey }) },
    ),

  /**
   * Confirm a pending intent — creates a generation task and first attempt.
   * Idempotent on (intentId, clientIdempotencyKey).
   */
  confirmIntent: (
    projectId: string,
    intentId: string,
    clientIdempotencyKey: string,
  ) =>
    request<GenerationTaskView>(
      `/projects/${encodeURIComponent(projectId)}/generation-tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          intent_id: intentId,
          client_idempotency_key: clientIdempotencyKey,
        }),
      },
    ),

  /** Poll the generation task status for the recovery/status surface. */
  getTaskStatus: (projectId: string, taskId: string) =>
    request<GenerationTaskView>(
      `/projects/${encodeURIComponent(projectId)}/generation-tasks/${encodeURIComponent(taskId)}`,
    ),
};
