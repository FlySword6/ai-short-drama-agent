import { AppError } from "../../shared/errors.js";
import { ProviderRequestError } from "../generation/errors.js";
import type { GenerationProvider } from "../generation/ports.js";
import { ArkGenerationProvider, type FetchLike } from "../generation/provider/arkGenerationProvider.js";
import { SeedAudioProvider } from "../generation/provider/seedAudioProvider.js";
import type {
  ProviderGenerationRequest,
  ProviderResultSnapshot,
  ProviderSubmission,
} from "../generation/types.js";

export type ProviderReplicaScenario =
  | "success"
  | "content_safety"
  | "authentication_failed"
  | "rate_limited"
  | "missing_result";

export interface ProviderReplicaCall {
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
}

/**
 * HTTP-level provider replica. It feeds documented Ark / Seed Audio shapes
 * through the production adapters instead of maintaining a second parser.
 */
export class ArkByteProviderReplica implements GenerationProvider {
  readonly calls: ProviderReplicaCall[] = [];
  private readonly ark: ArkGenerationProvider;
  private readonly audio: SeedAudioProvider;
  private readonly videoQueryCounts = new Map<string, number>();
  private videoTaskCount = 0;

  constructor(private readonly scenario: ProviderReplicaScenario = "success") {
    const fetchImpl: FetchLike = (url, init) => this.fetch(url, init);
    this.ark = new ArkGenerationProvider({
      apiKey: "mock-never-sent",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      timeoutMs: 5_000,
      fetchImpl,
    });
    this.audio = new SeedAudioProvider({
      apiKey: "mock-never-sent",
      endpoint: "https://openspeech.bytedance.com/api/v3/tts/create",
      timeoutMs: 5_000,
      fetchImpl,
    });
  }

  submit(
    request: ProviderGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ProviderSubmission> {
    return request.mediaKind === "audio"
      ? this.audio.submit(request, signal)
      : this.ark.submit(request, signal);
  }

  query(
    providerTaskId: string,
    request?: Pick<ProviderGenerationRequest, "model" | "mediaKind">,
    signal?: AbortSignal,
  ): Promise<ProviderResultSnapshot> {
    return request?.mediaKind === "audio"
      ? this.audio.query()
      : this.ark.query(providerTaskId, request, signal);
  }

  private async fetch(
    rawUrl: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(typeof rawUrl === "string" || rawUrl instanceof URL
      ? rawUrl.toString()
      : rawUrl.url);
    const method = init?.method ?? "GET";
    const body = jsonBody(init?.body);
    this.calls.push({ method, pathname: url.pathname, body });

    if (this.scenario === "authentication_failed") {
      return url.pathname === "/api/v3/tts/create"
        ? jsonResponse({ code: 4010001, message: "replica credential rejected" }, 401)
        : jsonResponse({
            error: {
              code: "AuthenticationError",
              message: "replica credential rejected",
            },
          }, 401);
    }
    if (this.scenario === "rate_limited") {
      return jsonResponse({
        error: { code: "QuotaExceeded", message: "replica quota exceeded" },
      }, 429);
    }
    if (url.pathname === "/api/v3/tts/create") {
      if (this.scenario === "content_safety") {
        return jsonResponse({ code: 45001125, message: "replica text rejected" });
      }
      if (this.scenario === "missing_result") {
        return jsonResponse({ code: 0, duration: 3, original_duration: 3 });
      }
      return jsonResponse({
        code: 0,
        url: "https://provider-replica.invalid/audio/result.mp3",
        duration: 3,
        original_duration: 3,
        subtitle: {
          sentences: [{
            text: "模拟音频",
            start_time: 0,
            end_time: 3_000,
          }],
        },
      }, 200, { "X-Tt-Logid": "mock-seed-audio-log-1" });
    }

    if (url.pathname.endsWith("/images/generations")) {
      if (this.scenario === "content_safety") {
        return jsonResponse({
          error: {
            code: "InputTextSensitiveContentDetected",
            message: "replica content rejected",
          },
        }, 400);
      }
      if (this.scenario === "missing_result") return jsonResponse({ data: [], usage: {} });
      return jsonResponse({
        model: text(body?.model) ?? "mock-image-model",
        created: 1_786_000_000,
        data: [{ url: "https://provider-replica.invalid/image/result.webp" }],
        usage: { generated_images: 1, output_tokens: 1_024, total_tokens: 1_024 },
      });
    }

    if (url.pathname.endsWith("/contents/generations/tasks") && method === "POST") {
      if (this.scenario === "content_safety") {
        return jsonResponse({
          error: {
            code: "InputTextSensitiveContentDetected",
            message: "replica content rejected",
          },
        }, 400);
      }
      if (this.scenario === "missing_result") return jsonResponse({ status: "queued" });
      this.videoTaskCount += 1;
      return jsonResponse({ id: `mock-video-task-${this.videoTaskCount}`, status: "queued" });
    }

    if (url.pathname.includes("/contents/generations/tasks/") && method === "GET") {
      const taskId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "mock-video-task-1");
      const count = (this.videoQueryCounts.get(taskId) ?? 0) + 1;
      this.videoQueryCounts.set(taskId, count);
      if (count === 1) {
        return jsonResponse({ id: taskId, status: "running", content: [] });
      }
      if (this.scenario === "missing_result") {
        return jsonResponse({ id: taskId, status: "succeeded", content: [] });
      }
      return jsonResponse({
        id: taskId,
        status: "succeeded",
        model: "mock-video-model",
        duration: 4,
        ratio: "9:16",
        resolution: "720p",
        content: [{
          type: "video_url",
          video_url: "https://provider-replica.invalid/video/result.mp4",
        }],
        usage: { completion_tokens: 320, total_tokens: 320 },
      });
    }

    return jsonResponse({ error: { code: "NotFound", message: "replica route missing" } }, 404);
  }
}

export async function executeReplicaProvider(
  provider: GenerationProvider,
  request: ProviderGenerationRequest,
): Promise<{
  attemptId: string;
  timeline: Array<{
    state: "accepted" | "running" | "succeeded";
    offsetMs: number;
  }>;
}> {
  try {
    const submission = await provider.submit(request);
    if (submission.outcome === "succeeded") {
      return {
        attemptId: submission.providerTaskId ?? submission.result.media[0]?.providerResultKey
          ?? `mock-${crypto.randomUUID()}`,
        timeline: [
          { state: "accepted", offsetMs: 0 },
          { state: "running", offsetMs: 40 },
          { state: "succeeded", offsetMs: 80 },
        ],
      };
    }
    const first = await provider.query(submission.providerTaskId, request);
    if (first.status !== "running" && first.status !== "pending") {
      throw new AppError(502, "mock_provider_timing_invalid", "供应商复刻时序不正确");
    }
    const second = await provider.query(submission.providerTaskId, request);
    if (second.status !== "succeeded" || second.media.length === 0) {
      throw new AppError(502, "mock_provider_result_missing", "供应商复刻没有返回可用媒体");
    }
    return {
      attemptId: submission.providerTaskId,
      timeline: [
        { state: "accepted", offsetMs: 0 },
        { state: "running", offsetMs: 120 },
        { state: "succeeded", offsetMs: 360 },
      ],
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ProviderRequestError) {
      throw new AppError(
        error.httpStatus === 429 ? 429 : 422,
        error.providerCode?.trim() || "mock_provider_rejected",
        error.message,
        error.retryable,
      );
    }
    throw error;
  }
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function jsonBody(value: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
