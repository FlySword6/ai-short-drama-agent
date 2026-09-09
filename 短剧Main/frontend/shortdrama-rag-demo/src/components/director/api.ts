/**
 * 3D 导演台 · 后端 API 客户端
 *
 * 生产路径直接复用 Fable 的 src/api.ts 单例（import { api } from "../../api"）：
 * 同一 token 键（shortdrama_v01_token）、同一 {ok:true,data} 信封解包、
 * 同一 401 → UNAUTHORIZED_EVENT 联动、FormData 不手设 Content-Type。
 * 本模块不改动公共文件，只做导演台端点的薄封装；
 * 测试路径保留 FetchLike 注入（tsx --test 无真实后端，mock 路径抛同一个 ApiClientError）。
 */
import { api, ApiClientError } from "../../api";
import type { DirectorSceneSnapshot } from "./snapshot";

/** 与全局 fetch 同形的最小签名（测试用假实现注入） */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const API_PREFIX = "/api/v1";

/** mock 路径的信封解析（与 src/api.ts parseFailure 同语义，抛同一个 ApiClientError） */
async function mockFetchEnvelope<T>(
  path: string,
  init: { method?: string; body?: BodyInit | null },
  fetchImpl: FetchLike,
): Promise<T> {
  const response = await fetchImpl(`${API_PREFIX}${path}`, { ...init, headers: {} });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON 响应按无体处理
  }
  if (!response.ok) {
    const record = (payload ?? {}) as Record<string, unknown>;
    const errorField = record["error"];
    if (errorField && typeof errorField === "object") {
      const error = errorField as Record<string, unknown>;
      throw new ApiClientError(
        typeof error["message"] === "string" ? error["message"] : `请求失败（HTTP ${response.status}）`,
        {
          status: response.status,
          code: typeof error["code"] === "string" ? error["code"] : undefined,
          details: error["details"] ?? null,
        },
      );
    }
    throw new ApiClientError(
      typeof errorField === "string" ? errorField : `请求失败（HTTP ${response.status}）`,
      { status: response.status },
    );
  }
  const envelope = payload as Record<string, unknown> | null;
  if (envelope && envelope["ok"] === true && "data" in envelope) {
    return envelope["data"] as T;
  }
  return payload as T;
}

function directorFetch<T>(
  path: string,
  init: { method?: string; body?: BodyInit | null } = {},
  fetchImpl?: FetchLike,
): Promise<T> {
  if (fetchImpl) return mockFetchEnvelope(path, init, fetchImpl);
  return api.request<T>(path, init);
}

/* ──────────────────────────── 场景版本 ──────────────────────────── */

export interface DirectorSceneResponse {
  id: string;
  projectId: string;
  status: string;
  currentVersion: number;
  snapshot: unknown;
}

export interface DirectorSceneSaveResponse extends DirectorSceneResponse {
  savedVersion?: { id: string; version: number; sourceAction?: string | null };
}

/** GET /api/v1/projects/:projectId/director/scene（无场景时后端 404） */
export function getDirectorScene(projectId: string, fetchImpl?: FetchLike): Promise<DirectorSceneResponse> {
  return directorFetch(`/projects/${encodeURIComponent(projectId)}/director/scene`, {}, fetchImpl);
}

export interface SaveDirectorSceneInput {
  sceneVersion: number;
  snapshot: DirectorSceneSnapshot;
  sourceAction?: string;
  status?: "draft" | "saved";
}

/** PUT /api/v1/projects/:projectId/director/scene（sceneVersion 乐观锁，409 冲突） */
export function putDirectorScene(
  projectId: string,
  input: SaveDirectorSceneInput,
  fetchImpl?: FetchLike,
): Promise<DirectorSceneSaveResponse> {
  return directorFetch(
    `/projects/${encodeURIComponent(projectId)}/director/scene`,
    { method: "PUT", body: JSON.stringify(input) },
    fetchImpl,
  );
}

/* ──────────────────────────── 截图入资产 ──────────────────────────── */

export interface DirectorCaptureResponse {
  assetEntityId: string;
  assetMediaId: string;
  title: string;
  storageUrl: string;
  widthPx: number;
  heightPx: number;
}

/** POST /api/v1/projects/:projectId/director/captures（multipart PNG，201 创建） */
export function postDirectorCapture(
  projectId: string,
  formData: FormData,
  fetchImpl?: FetchLike,
): Promise<DirectorCaptureResponse> {
  return directorFetch(
    `/projects/${encodeURIComponent(projectId)}/director/captures`,
    { method: "POST", body: formData },
    fetchImpl,
  );
}

/* ──────────────────────────── 模版包 ──────────────────────────── */

export interface DirectorTemplateSummary {
  id: string;
  name: string;
  category: string;
  tags: string[];
  characterCount: number;
  mood: string[];
  cameraCount: number;
  dataSource: string;
}

/** GET /api/v1/director/templates */
export async function listDirectorTemplates(fetchImpl?: FetchLike): Promise<DirectorTemplateSummary[]> {
  const data = await directorFetch<{ templates: DirectorTemplateSummary[] }>(
    "/director/templates",
    {},
    fetchImpl,
  );
  return data.templates;
}

/** POST /api/v1/director/templates/:id/apply（实例化出演播室场景 JSON） */
export function applyDirectorTemplate(
  templateId: string,
  options: Record<string, unknown> = {},
  fetchImpl?: FetchLike,
): Promise<unknown> {
  return directorFetch(
    `/director/templates/${encodeURIComponent(templateId)}/apply`,
    { method: "POST", body: JSON.stringify(options) },
    fetchImpl,
  );
}

/* ──────────────────────────── 命令批量校验（预留：Pi SSE 接线用） ──────────────────────────── */

/** POST /api/v1/projects/:projectId/director/commands/validate */
export function validateDirectorCommands(
  projectId: string,
  body: { sceneId: string; sceneVersion: number; commands: unknown[] },
  fetchImpl?: FetchLike,
): Promise<{ valid: boolean; commandCount: number; sceneId: string; sceneVersion: number }> {
  return directorFetch(
    `/projects/${encodeURIComponent(projectId)}/director/commands/validate`,
    { method: "POST", body: JSON.stringify(body) },
    fetchImpl,
  );
}

export { ApiClientError };
