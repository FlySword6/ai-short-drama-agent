import { readSessionToken } from "../auth-token";
import { handleUnauthorizedResponse } from "../api";

const API_PREFIX = "/api/vnext";

export interface VnextProject {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface VnextGraphNode {
  id: string;
  kind: "scene" | "asset" | "task" | "note";
  label: string;
  position: { x: number; y: number };
  data?: Record<string, string | number | boolean | null>;
}

export interface VnextGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface VnextGraphDocument {
  schema_version: 1;
  nodes: VnextGraphNode[];
  edges: VnextGraphEdge[];
}

export interface VnextLastWrite {
  kind: "human" | "agent";
  user_id: string | null;
  at: string;
}

export interface VnextGraphSnapshot {
  project_id: string;
  revision: number;
  document: VnextGraphDocument;
  updated_at: string;
  /** 服务端 GraphDocument revision 事实:页面上的「Agent 状态」只能来自这里。 */
  last_write: VnextLastWrite | null;
}

export interface VnextShotPlanDraft {
  schema_version: 1;
  characters: Array<{ key: string; name: string; description: string }>;
  scenes: Array<{ key: string; title: string; summary: string; position: number }>;
  shots: Array<{
    key: string;
    scene_key: string;
    position: number;
    shot_size: string;
    camera_movement: string;
    action: string;
    rhythm: string;
    dialogue: string;
    sound: string;
  }>;
  warnings: string[];
}

export interface VnextScriptRun {
  id: string;
  project_id: string;
  status: "queued" | "running" | "draft" | "partial_failure" | "failed" | "confirmed";
  progress: number;
  current_stage: "queued" | "reading" | "structuring" | "validating" | "ready" | "failed" | "confirmed";
  draft: VnextShotPlanDraft | null;
  error: { code: string; message: string; retryable: boolean } | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

export interface VnextFormalShotPlan {
  confirmation_id: string;
  confirmed_at: string;
  characters: Array<{ id: string; key: string; name: string; description: string }>;
  scenes: Array<{ id: string; key: string; title: string; summary: string; position: number }>;
  shots: Array<{
    id: string;
    scene_id: string;
    key: string;
    position: number;
    shot_size: string;
    camera_movement: string;
    action: string;
    rhythm: string;
    dialogue: string;
    sound: string;
  }>;
}

export interface VnextScriptWorkbench {
  run: VnextScriptRun | null;
  formal_facts: VnextFormalShotPlan | null;
}

export interface VnextLegacyAsset {
  id: string;
  library_name: string;
  source_system: string;
  source_id: string;
  name: string;
  asset_kind: "character" | "scene" | "prop";
  media_kind: "image" | "video" | "audio";
  media_url: string;
  media_sha256: string;
  snapshot_at: string;
  snapshot_version: string;
  review_status: "approved" | "pending_review" | "rejected";
  registration_status: "not_required" | "pending" | "active" | "processing" | "failed" | "unknown";
  registration_id: string | null;
  registration_failure_code: string | null;
  registration_failure_reason: string | null;
}
export class VnextApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = readSessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, { ...init, headers });
  } catch {
    throw new VnextApiError("无法连接 vNext 服务，请确认后端已启动", 0, "network_error");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: T; error?: { message?: string; code?: string; details?: unknown } } | null;
  if (!response.ok) {
    handleUnauthorizedResponse(response.status, `${API_PREFIX}${path}`);
    throw new VnextApiError(body?.error?.message ?? "vNext 请求失败", response.status, body?.error?.code, body?.error?.details);
  }
  return body?.ok === true ? body.data as T : body as T;
}

export const vnextApi = {
  listProjects: (input: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor) query.set("cursor", input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<{ items: VnextProject[]; next_cursor: string | null }>(`/projects${suffix}`);
  },
  createProject: (name: string) => request<VnextProject>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  graph: (projectId: string) => request<VnextGraphSnapshot>(`/projects/${encodeURIComponent(projectId)}/graph`),
  saveGraph: (projectId: string, expectedRevision: number, document: VnextGraphDocument) => request<VnextGraphSnapshot>(
    `/projects/${encodeURIComponent(projectId)}/graph`,
    { method: "PUT", body: JSON.stringify({ expected_revision: expectedRevision, document }) },
  ),
  scriptWorkbench: (projectId: string) => request<VnextScriptWorkbench>(
    `/projects/${encodeURIComponent(projectId)}/script-workbench`,
  ),
  createScriptRun: (projectId: string, input: {
    source_kind: "paste" | "upload";
    file_name?: string;
    script_content: string;
    client_idempotency_key: string;
  }) => request<{ run: VnextScriptRun; outcome: "created" | "replayed" }>(
    `/projects/${encodeURIComponent(projectId)}/script-runs`,
    { method: "POST", body: JSON.stringify(input) },
  ),
  retryScriptRun: (runId: string) => request<{
    run: VnextScriptRun;
    outcome: "created" | "replayed";
  }>(
    `/script-runs/${encodeURIComponent(runId)}/retry`,
    { method: "POST" },
  ),
  confirmScriptRun: (runId: string, clientIdempotencyKey: string) => request<{ formal_facts: VnextFormalShotPlan }>(
    `/script-runs/${encodeURIComponent(runId)}/confirm`,
    { method: "POST", body: JSON.stringify({ client_idempotency_key: clientIdempotencyKey }) },
  ),
  legacyLibrary: () => request<{ items: VnextLegacyAsset[] }>("/assets/legacy-library"),
  retryLegacyRegistration: (assetId: string) => request<{ asset: VnextLegacyAsset }>(
    `/assets/${encodeURIComponent(assetId)}/registration/retry`, { method: "POST" },
  ),
};
