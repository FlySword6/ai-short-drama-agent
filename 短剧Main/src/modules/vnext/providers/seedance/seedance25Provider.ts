/**
 * Seedance 2.5 provider adapter.
 *
 * Uses the Ark `/contents/generations/tasks` REST API with the Seedance 2.5
 * endpoint model.  The `generate_audio` flag enables native audio (dialogue,
 * narration, ambience, action SFX); BGM is disabled by default and must not
 * be enabled here without explicit human confirmation.
 *
 * Fail-closed contract:
 * - No apiKey or no endpointModel → throws before any network call.
 * - HTTP 429 → VnextProviderRequestError outcome="rejected" (rate limited; no auto-retry).
 * - Network error / timeout → outcome="unknown" (submission state uncertain).
 * - Unknown provider status → treat as running (prevents spurious terminal transitions).
 */

import { VnextProviderRequestError } from "../../generation/errors.js";
import {
  SEEDANCE25_LOCKED_DURATION_SECONDS,
  SEEDANCE25_LOCKED_RATIO,
  Seedance25ContractViolationError,
  resolveSeedance25ReferenceRole,
  validateSeedance25SubmitContract,
} from "../../generation/seedance25Constraints.js";
import type { VnextVideoProvider } from "../videoProvider.js";
import type {
  Seedance25ProviderOptions,
  Seedance25QueryResult,
  Seedance25SubmitRequest,
  Seedance25SubmitResult,
} from "./types.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_TIMEOUT_MS = 120_000;
const SUBMIT_PATH = "/contents/generations/tasks";
const QUERY_PATH_PREFIX = "/contents/generations/tasks/";

export class Seedance25Provider implements VnextVideoProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: Seedance25ProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  readonly id = "seedance_2_5";

  checkReadiness(): { ok: true; modelId: string } | { ok: false; reason: string } {
    if (!this.options.apiKey.trim()) {
      return { ok: false, reason: "Seedance 2.5 能力尚未配置（缺少 ARK_API_KEY）" };
    }
    if (!this.options.endpointModel.trim()) {
      return { ok: false, reason: "Seedance 2.5 端点未配置（缺少 ARK_VIDEO_MODEL_2_5）" };
    }
    return { ok: true, modelId: this.options.endpointModel };
  }

  resolveParameters(raw: Record<string, unknown>): Record<string, unknown> {
    const ratio = typeof raw["ratio"] === "string" && raw["ratio"].trim()
      ? raw["ratio"].trim()
      : "9:16";
    const resolution = typeof raw["resolution"] === "string" && raw["resolution"].trim()
      ? raw["resolution"].trim()
      : "720p";
    const durationSeconds = typeof raw["durationSeconds"] === "number"
      && (raw["durationSeconds"] > 0 || raw["durationSeconds"] === SEEDANCE25_LOCKED_DURATION_SECONDS)
      ? raw["durationSeconds"]
      : 4;
    return { ratio, resolution, durationSeconds };
  }

  lockedTaskParameters(): Record<string, unknown> {
    // 临时委托，#444 第 3/4 步移除。
    return {
      ratio: SEEDANCE25_LOCKED_RATIO,
      durationSeconds: SEEDANCE25_LOCKED_DURATION_SECONDS,
    };
  }

  isLocalContractViolation(error: unknown): { violated: true; code: string } | { violated: false } {
    return error instanceof Seedance25ContractViolationError
      ? { violated: true, code: error.code }
      : { violated: false };
  }

  async submit(request: Seedance25SubmitRequest, signal?: AbortSignal): Promise<Seedance25SubmitResult> {
    this.assertConfigured("submit");
    validateSeedance25SubmitContract(request);

    const body: Record<string, unknown> = {
      model: this.options.endpointModel,
      content: buildVideoContent(request.prompt, request.references),
      ratio: request.ratio,
      resolution: request.resolution,
      duration: request.durationSeconds,
      watermark: false,
      // native audio: dialogue/narration/ambience/SFX; BGM is disabled unless
      // this flag is absent, in which case the provider default (no audio) applies.
      generate_audio: request.nativeAudio,
    };

    const payload = await this.call("submit", SUBMIT_PATH, { method: "POST", body: JSON.stringify(body) }, signal);
    const providerTaskId = textAt(payload, "id");
    if (!providerTaskId) {
      throw new VnextProviderRequestError(
        "Seedance 2.5 视频生成未能创建任务，请稍后重试",
        "submit",
        "unknown",
        false,
      );
    }
    return { providerTaskId, rawStatus: textAt(payload, "status") ?? "queued" };
  }

  async query(providerTaskId: string, signal?: AbortSignal): Promise<Seedance25QueryResult> {
    this.assertConfigured("query");
    const taskId = providerTaskId.trim();
    if (!taskId) {
      throw new VnextProviderRequestError(
        "生成任务编号缺失，暂时无法查询进度",
        "query",
        "query_failed",
        false,
      );
    }

    const payload = await this.call(
      "query",
      `${QUERY_PATH_PREFIX}${encodeURIComponent(taskId)}`,
      { method: "GET" },
      signal,
    );

    const rawStatus = textAt(payload, "status");
    if (!rawStatus) {
      throw new VnextProviderRequestError(
        "暂时无法确认生成进度，请稍后刷新",
        "query",
        "query_failed",
        true,
      );
    }

    const normalized = normalizeStatus(rawStatus);
    const mediaUrls = extractVideoUrls(payload);

    if (normalized.status === "succeeded" && mediaUrls.length === 0) {
      throw new VnextProviderRequestError(
        "生成已完成，但暂时无法取得成片，请稍后刷新",
        "query",
        "query_failed",
        true,
      );
    }

    return {
      status: normalized.status,
      rawStatus: normalized.rawStatus,
      unknownStatus: normalized.unknownStatus,
      providerTaskId: textAt(payload, "id") ?? taskId,
      mediaUrls,
      errorCode: providerErrorCode(payload),
      errorMessage: providerErrorMessage(payload),
      actualModelId: textAt(payload, "model") ?? undefined,
      durationSeconds: numberAt(payload, "duration") ?? undefined,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private assertConfigured(op: string): void {
    if (!this.options.apiKey.trim()) {
      throw new VnextProviderRequestError(
        "当前 Seedance 2.5 生成能力尚未配置（缺少 ARK_API_KEY），不会创建任务",
        op,
        op === "query" ? "query_failed" : "rejected",
        false,
        "PROVIDER_NOT_CONFIGURED",
      );
    }
    if (!this.options.endpointModel.trim()) {
      throw new VnextProviderRequestError(
        "当前 Seedance 2.5 端点未配置（缺少 ARK_VIDEO_MODEL_2_5），不会创建任务",
        op,
        op === "query" ? "query_failed" : "rejected",
        false,
        "PROVIDER_NOT_CONFIGURED",
      );
    }
  }

  private async call(
    operation: string,
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (callerSignal?.aborted) {
      throw new VnextProviderRequestError(
        "本次生成已取消，不会创建任务",
        operation,
        operation === "query" ? "query_failed" : "rejected",
        false,
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortOnCaller = () => controller.abort();
    callerSignal?.addEventListener("abort", abortOnCaller, { once: true });

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
            ...(init.headers as Record<string, string> | undefined),
          },
          signal: controller.signal,
        });
      } catch {
        throw new VnextProviderRequestError(
          operation === "query"
            ? "暂时无法查询 Seedance 2.5 生成进度，请稍后刷新"
            : "暂时无法确认 Seedance 2.5 是否已提交，请先刷新任务列表后再重试",
          operation,
          operation === "query" ? "query_failed" : "unknown",
          true,
        );
      }

      // 429: rate limited — rejected, no auto-retry
      if (response.status === 429) {
        throw new VnextProviderRequestError(
          "Seedance 2.5 接口限流，当前无法提交新任务，请稍后再试",
          operation,
          "rejected",
          false,
          "RATE_LIMITED",
          429,
        );
      }

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new VnextProviderRequestError(
          "Seedance 2.5 返回了无法解析的响应",
          operation,
          operation === "query" ? "query_failed" : "unknown",
          true,
        );
      }

      if (!response.ok) {
        const errMsg = nestedText(body, "error", "message") ?? nestedText(body, "message") ?? "未知错误";
        const errCode = nestedText(body, "error", "code") ?? nestedText(body, "code") ?? undefined;
        throw new VnextProviderRequestError(
          `Seedance 2.5 请求失败（${response.status}）：${errMsg}`,
          operation,
          operation === "query" ? "query_failed" : "rejected",
          response.status >= 500,
          errCode,
          response.status,
        );
      }

      return body;
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", abortOnCaller);
    }
  }
}

// ─── Status normalizer ────────────────────────────────────────────────────────

function normalizeStatus(raw: string): { status: "pending" | "running" | "succeeded" | "failed"; rawStatus: string; unknownStatus: boolean } {
  const s = raw.trim().toLowerCase();
  switch (s) {
    case "queued":
    case "pending":
      return { status: "pending", rawStatus: s, unknownStatus: false };
    case "running":
    case "in_progress":
    case "processing":
      return { status: "running", rawStatus: s, unknownStatus: false };
    case "succeeded":
    case "completed":
      return { status: "succeeded", rawStatus: s, unknownStatus: false };
    case "failed":
    case "cancelled":
    case "expired":
      return { status: "failed", rawStatus: s, unknownStatus: false };
    default:
      // Unknown provider status must not become a terminal state.
      return { status: "running", rawStatus: s, unknownStatus: true };
  }
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

function textAt(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function nestedText(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" && cur.trim() ? cur.trim() : undefined;
}

function numberAt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function extractVideoUrls(payload: Record<string, unknown>): string[] {
  const urls: string[] = [];
  collectVideoUrls(payload.content, urls);
  collectVideoUrls(payload.choices, urls);
  return [...new Set(urls)];
}

function collectVideoUrls(value: unknown, urls: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectVideoUrls(item, urls);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const key of ["video_url", "url"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() && (key === "video_url" || record.type === "video_url")) {
      urls.push(candidate.trim());
    } else if (typeof candidate === "object" && candidate !== null) {
      const nested = (candidate as Record<string, unknown>).url;
      if (typeof nested === "string" && nested.trim() && (key === "video_url" || record.type === "video_url")) urls.push(nested.trim());
    }
  }
  for (const nested of Object.values(record)) collectVideoUrls(nested, urls);
}

function providerErrorCode(payload: Record<string, unknown>): string | undefined {
  return nestedText(payload, "error", "code") ?? nestedText(payload, "error_code") ?? undefined;
}

function providerErrorMessage(payload: Record<string, unknown>): string | undefined {
  return nestedText(payload, "error", "message") ?? nestedText(payload, "error_message") ?? undefined;
}

function buildVideoContent(prompt: string, refs: Seedance25SubmitRequest["references"]): unknown[] {
  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const ref of refs) {
    const role = resolveSeedance25ReferenceRole(ref);
    if (ref.kind === "image") {
      content.push({ type: "image_url", image_url: { url: ref.url }, role });
    } else if (ref.kind === "video") {
      content.push({ type: "video_url", video_url: { url: ref.url }, role });
    } else {
      content.push({ type: "audio_url", audio_url: { url: ref.url }, role });
    }
  }
  return content;
}
