import { settings } from "../config/env.js";
import type { JsonObject } from "../domain/assets/types.js";
import { ExternalServiceError } from "../shared/errors.js";
import { toJsonObject } from "../shared/json.js";

export type LasVideoTaskStatus = "pending" | "running" | "completed" | "failed";

export interface LasVideoUnderstandingSubmitInput {
  videoUrl: string;
  query: string;
  taskTemplate: string;
  fps: number;
  mediaResolution: string;
  reasoningEffort: string;
  modelName?: string;
}

export interface LasVideoUnderstandingSubmission {
  taskId: string;
  raw: JsonObject;
}

export interface LasVideoUnderstandingPollResult {
  status: LasVideoTaskStatus;
  raw: JsonObject;
}

export interface LasVideoUnderstandingPort {
  submit(input: LasVideoUnderstandingSubmitInput): Promise<LasVideoUnderstandingSubmission>;
  poll(taskId: string): Promise<LasVideoUnderstandingPollResult>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface VolcLasVideoUnderstandingClientOptions {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_LAS_BASE_URL = "https://operator.las.cn-beijing.volces.com";

export class VolcLasVideoUnderstandingClient implements LasVideoUnderstandingPort {
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly modelName: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: VolcLasVideoUnderstandingClientOptions = {}) {
    this.enabled = options.enabled ?? settings.volcLasVideoUnderstandingEnabled;
    this.baseUrl = (options.baseUrl ?? settings.lasBaseUrl ?? DEFAULT_LAS_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? settings.lasApiKey;
    this.modelName = options.modelName ?? settings.lasVideoUnderstandingModel;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(input: LasVideoUnderstandingSubmitInput): Promise<LasVideoUnderstandingSubmission> {
    this.assertConfigured();
    const operatorId = "las_video_understanding";
    const operatorVersion = "v1";
    console.info("[volc-las-video] submit request", {
      endpoint: this.endpointLabel("/api/v1/submit"),
      operator_id: operatorId,
      operator_version: operatorVersion,
      task_template: input.taskTemplate,
      fps: input.fps,
      media_resolution: input.mediaResolution,
      reasoning_effort: input.reasoningEffort,
      model_name: input.modelName ?? this.modelName ?? null,
      has_video_url: Boolean(input.videoUrl),
      timeout_ms: this.timeoutMs,
    });
    const payload = await this.request("/api/v1/submit", {
      operator_id: operatorId,
      operator_version: operatorVersion,
      data: {
        video_url: input.videoUrl,
        query: input.query,
        task_template: input.taskTemplate,
        fps: input.fps,
        media_resolution: input.mediaResolution,
        reasoning_effort: input.reasoningEffort,
        model_name: input.modelName ?? this.modelName,
        use_responses_api: false,
      },
    });
    const taskId = stringAt(payload, "metadata", "task_id")
      ?? stringAt(payload, "data", "task_id")
      ?? stringAt(payload, "task_id");
    if (!taskId) throw new ExternalServiceError("Volc LAS", "submit response omitted task_id");
    console.info("[volc-las-video] submit success", {
      task_id: taskId,
      business_code: stringAt(payload, "metadata", "business_code") ?? stringAt(payload, "business_code") ?? null,
    });
    return { taskId, raw: payload };
  }

  async poll(taskId: string): Promise<LasVideoUnderstandingPollResult> {
    this.assertConfigured();
    const trimmed = taskId.trim();
    if (!trimmed) throw new ExternalServiceError("Volc LAS", "task_id is required");
    console.info("[volc-las-video] poll request", {
      endpoint: this.endpointLabel("/api/v1/poll"),
      task_id: trimmed,
      timeout_ms: this.timeoutMs,
    });
    const payload = await this.request("/api/v1/poll", {
      operator_id: "las_video_understanding",
      operator_version: "v1",
      task_id: trimmed,
    });
    const status = normalizeTaskStatus(
      stringAt(payload, "metadata", "task_status")
        ?? stringAt(payload, "data", "task_status")
        ?? stringAt(payload, "task_status")
        ?? stringAt(payload, "status"),
    );
    console.info("[volc-las-video] poll result", {
      task_id: trimmed,
      status,
      raw_status: stringAt(payload, "metadata", "task_status")
        ?? stringAt(payload, "data", "task_status")
        ?? stringAt(payload, "task_status")
        ?? stringAt(payload, "status")
        ?? null,
      business_code: stringAt(payload, "metadata", "business_code") ?? stringAt(payload, "business_code") ?? null,
    });
    return {
      status,
      raw: payload,
    };
  }

  private assertConfigured(): void {
    if (!this.enabled) throw new ExternalServiceError("Volc LAS", "video understanding is disabled");
    if (!this.apiKey) throw new ExternalServiceError("Volc LAS", "missing LAS_API_KEY configuration");
  }

  private async request(path: string, body: Record<string, unknown>): Promise<JsonObject> {
    let response: Response;
    const startedAt = performance.now();
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      console.error("[volc-las-video] request transport failed", {
        endpoint: this.endpointLabel(path),
        duration_ms: Math.round(performance.now() - startedAt),
        ...transportFailureLogFields(error),
      });
      throw new ExternalServiceError("Volc LAS", "request failed");
    }
    if (!response.ok) {
      console.error("[volc-las-video] request http failed", {
        endpoint: this.endpointLabel(path),
        status: response.status,
        status_text: response.statusText,
      });
      throw new ExternalServiceError("Volc LAS", `request failed with status ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      console.error("[volc-las-video] response json parse failed", {
        endpoint: this.endpointLabel(path),
        status: response.status,
      });
      throw new ExternalServiceError("Volc LAS", "response returned invalid JSON");
    }
    const object = toJsonObject(payload);
    const businessCode = stringAt(object, "metadata", "business_code") ?? stringAt(object, "business_code");
    if (businessCode && businessCode !== "0") {
      console.error("[volc-las-video] request business failed", {
        endpoint: this.endpointLabel(path),
        business_code: businessCode,
        error_msg: stringAt(object, "metadata", "error_msg") ?? stringAt(object, "error_msg") ?? null,
      });
      throw new ExternalServiceError("Volc LAS", stringAt(object, "metadata", "error_msg") ?? "business error");
    }
    return object;
  }

  private endpointLabel(path: string): string {
    try {
      const url = new URL(`${this.baseUrl}${path}`);
      return `${url.origin}${url.pathname}`;
    } catch {
      return path;
    }
  }
}

function normalizeTaskStatus(value: string | null): LasVideoTaskStatus {
  const normalized = (value ?? "").trim().toUpperCase();
  if (normalized === "COMPLETED" || normalized === "SUCCEEDED" || normalized === "SUCCESS") return "completed";
  if (normalized === "FAILED" || normalized === "FAIL" || normalized === "ERROR" || normalized === "TIMEOUT") return "failed";
  if (normalized === "RUNNING" || normalized === "PROCESSING") return "running";
  return "pending";
}

function transportFailureLogFields(error: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
  };
  const cause = error instanceof Error && "cause" in error
    ? (error as { cause?: unknown }).cause
    : null;
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    result.cause_name = record.name;
    result.cause_message = record.message;
    result.cause_code = record.code;
    result.cause_errno = record.errno;
    result.cause_syscall = record.syscall;
    result.cause_hostname = record.hostname ?? record.host;
    result.cause_port = record.port;
    result.cause_address = record.address;
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined && value !== ""));
}

function stringAt(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}
