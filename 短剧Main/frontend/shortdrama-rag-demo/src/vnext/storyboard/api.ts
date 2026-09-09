import { readSessionToken } from "../../auth-token";
import { handleUnauthorizedResponse } from "../../api";

const API_PREFIX = "/api/vnext";

export interface StoryboardVersion { id: string; cell_id: string; version: number; prompt: string; source: Record<string, unknown>; media_url: string; media_sha256: string; provider: string; model: string; billing_receipt_id: string; created_at: string; }
export interface StoryboardCell { id: string; shot_id: string; position: number; version: StoryboardVersion; }
export interface StoryboardBoard { id: string; project_id: string; confirmation_id: string; version: number; source_kind: "shot_plan" | "redraw"; base_board_id: string | null; redrawn_cell_id: string | null; redrawn_cell_version_id: string | null; created_at: string; cells: StoryboardCell[]; }
export interface StoryboardApiError extends Error { status: number; code?: string; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = readSessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  let response: Response;
  try { response = await fetch(`${API_PREFIX}${path}`, { ...init, headers }); } catch { throw failure("无法连接故事板服务，请确认后端已启动", 0, "network_error"); }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: T; error?: { message?: string; code?: string } } | null;
  if (!response.ok) { handleUnauthorizedResponse(response.status, `${API_PREFIX}${path}`); throw failure(body?.error?.message ?? "故事板请求失败", response.status, body?.error?.code); }
  return body?.ok === true ? body.data as T : body as T;
}
function failure(message: string, status: number, code?: string): StoryboardApiError { return Object.assign(new Error(message), { status, code }); }

export const storyboardApi = {
  load: (projectId: string, confirmationId: string) => request<{ board: StoryboardBoard | null }>(`/projects/${encodeURIComponent(projectId)}/storyboard?confirmation_id=${encodeURIComponent(confirmationId)}`),
  generate: (projectId: string, confirmationId: string, key: string) => request<{ board: StoryboardBoard; outcome: "created" | "replayed" }>(`/projects/${encodeURIComponent(projectId)}/storyboard`, { method: "POST", body: JSON.stringify({ confirmation_id: confirmationId, client_idempotency_key: key, paid_confirmation: true }) }),
  redraw: (projectId: string, confirmationId: string, cellId: string, prompt: string, key: string) => request<{ board: StoryboardBoard; outcome: "created" | "replayed" }>(`/projects/${encodeURIComponent(projectId)}/storyboard/cells/${encodeURIComponent(cellId)}/redraw`, { method: "POST", body: JSON.stringify({ confirmation_id: confirmationId, prompt, client_idempotency_key: key, paid_confirmation: true }) }),
};
