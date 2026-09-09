import { isRecord } from "../../../shared/json.js";
import { ProviderRequestError } from "../errors.js";
import type { GenerationProvider } from "../ports.js";
import type {
  ProviderGenerationRequest,
  ProviderMediaResult,
  ProviderResultSnapshot,
  ProviderSubmission,
} from "../types.js";
import type { FetchLike } from "./arkGenerationProvider.js";

type HappyHorseOperation = "submit_video" | "query_video";

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_REFERENCE_IMAGES = 1;
const MAX_REFERENCE_IMAGES = 9;
const MIN_DURATION_SECONDS = 3;
const MAX_DURATION_SECONDS = 15;
const VIDEO_SYNTHESIS_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
const SUPPORTED_RESOLUTIONS: Record<string, true> = { "480P": true, "720P": true, "1080P": true };

/**
 * Approved DashScope hosts only: business-workspace domains (deployment
 * configured prefix, pinned host shape) plus the two official legacy domains
 * the vendor still serves — dashscope.aliyuncs.com (cn-beijing) and
 * dashscope-intl.aliyuncs.com (ap-southeast-1). Both alternatives are
 * anchored, so lookalike suffixes are rejected. The Bearer key and every
 * reference-image URL must never leave for an unapproved origin.
 */
const APPROVED_HAPPYHORSE_HOST_PATTERN =
  /^([a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com|dashscope(?:-intl)?\.aliyuncs\.com)$/;

export interface HappyHorseGenerationProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export function isApprovedHappyHorseBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return APPROVED_HAPPYHORSE_HOST_PATTERN.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * HappyHorse 用 `[Image N]` 按 media 数组顺序指代参考图，而平台冻结快照是
 * Seedance 口径的「图片N」。只追加一段映射前缀，绝不改写用户原 prompt。
 */
export function buildHappyHorsePrompt(userPrompt: string, imageCount: number): string {
  if (imageCount <= 0) return userPrompt;
  const mapping = Array.from({ length: imageCount }, (_, index) => `[Image ${index + 1}]=图片${index + 1}`).join("、");
  return `参考图对应:${mapping}。${userPrompt}`;
}

export class HappyHorseGenerationProvider implements GenerationProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: HappyHorseGenerationProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission> {
    // HappyHorse 只有参考生视频;图片/音频不会落到这个适配器上,直接拒绝。
    if (request.mediaKind !== "video") {
      throw new ProviderRequestError(
        "当前生成能力尚未配置，不会创建任务",
        request.mediaKind === "image" ? "submit_image" : "submit_audio",
        "rejected",
        false,
        "PROVIDER_NOT_CONFIGURED",
      );
    }
    assertRequestBasics(request);

    const imageReferences = request.references.filter((reference) => reference.kind === "image");
    if (imageReferences.length < MIN_REFERENCE_IMAGES || imageReferences.length > MAX_REFERENCE_IMAGES) {
      throw new ProviderRequestError(
        `HappyHorse 参考图需 1–9 张,当前 ${imageReferences.length} 张`,
        "submit_video",
        "rejected",
        false,
      );
    }

    const parameters = request.parameters;
    const durationSeconds = parameters.durationSeconds;
    if (
      typeof durationSeconds !== "number"
      || !Number.isInteger(durationSeconds)
      || durationSeconds < MIN_DURATION_SECONDS
      || durationSeconds > MAX_DURATION_SECONDS
    ) {
      throw new ProviderRequestError(
        `HappyHorse 视频时长需 ${MIN_DURATION_SECONDS}–${MAX_DURATION_SECONDS} 的整数秒`,
        "submit_video",
        "rejected",
        false,
      );
    }

    const body = {
      model: request.model,
      input: {
        prompt: buildHappyHorsePrompt(request.prompt, imageReferences.length),
        media: imageReferences.map((reference) => ({ type: "reference_image", url: reference.url })),
      },
      parameters: {
        resolution: normalizeHappyHorseResolution(parameters.resolution),
        ratio: typeof parameters.ratio === "string" && parameters.ratio.trim() ? parameters.ratio : "9:16",
        duration: durationSeconds,
        watermark: parameters.watermark === true,
        // seed 不传:保持供应商随机性,平台侧不回显 seed。
      },
    };

    const payload = await this.requestJson(
      "submit_video",
      VIDEO_SYNTHESIS_PATH,
      {
        method: "POST",
        headers: { "X-DashScope-Async": "enable" },
        body: JSON.stringify(body),
      },
      signal,
    );
    const output = nestedRecord(payload, "output");
    const providerTaskId = output ? textAt(output, "task_id") : null;
    if (!providerTaskId) {
      throw new ProviderRequestError(
        "视频生成未能创建任务，请稍后重试",
        "submit_video",
        "unknown",
        false,
      );
    }
    return {
      outcome: "accepted",
      providerTaskId,
      rawStatus: output ? textAt(output, "task_status") ?? undefined : undefined,
    };
  }

  async query(
    providerTaskId: string,
    _request?: Pick<ProviderGenerationRequest, "model" | "mediaKind">,
    signal?: AbortSignal,
  ): Promise<ProviderResultSnapshot> {
    const taskId = providerTaskId.trim();
    if (!taskId) {
      throw new ProviderRequestError(
        "生成任务编号缺失，暂时无法查询进度",
        "query_video",
        "query_failed",
        false,
      );
    }

    const payload = await this.requestJson(
      "query_video",
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET" },
      signal,
    );
    const output = nestedRecord(payload, "output") ?? {};
    const rawStatus = textAt(output, "task_status");
    if (!rawStatus) {
      throw new ProviderRequestError(
        "暂时无法确认生成进度，请稍后刷新",
        "query_video",
        "query_failed",
        true,
      );
    }

    switch (rawStatus) {
      case "PENDING":
        return {
          status: "pending",
          providerTaskId: taskId,
          rawStatus,
          media: [],
        };
      case "RUNNING":
        return {
          status: "running",
          providerTaskId: taskId,
          rawStatus,
          media: [],
        };
      case "SUCCEEDED": {
        const videoUrl = typeof output.video_url === "string" && output.video_url.trim() ? output.video_url.trim() : undefined;
        if (!videoUrl) {
          throw new ProviderRequestError(
            "生成已完成，但暂时无法取得成片，请稍后刷新",
            "query_video",
            "query_failed",
            true,
          );
        }
        const media: ProviderMediaResult[] = [{ kind: "video", temporaryUrl: videoUrl, providerResultKey: "video-0" }];
        const usage = nestedRecord(payload, "usage");
        return {
          status: "succeeded",
          providerTaskId: taskId,
          rawStatus,
          media,
          usage: compactUsage({
            duration: numberAt(usage, "duration"),
            output_video_duration: numberAt(usage, "output_video_duration"),
            SR: numberAt(usage, "SR"),
            ratio: numberAt(usage, "ratio"),
          }),
          metadata: compactRecord({
            submitTime: textAt(output, "submit_time"),
            endTime: textAt(output, "end_time"),
            ratio: textAt(output, "ratio"),
            SR: textAt(output, "SR"),
          }),
        };
      }
      case "FAILED": {
        const errorCode = textAt(output, "code");
        const errorMessage = textAt(output, "message");
        return {
          status: "failed",
          providerTaskId: taskId,
          rawStatus,
          media: [],
          errorCode: errorCode ?? "TASK_FAILED",
          errorMessage: errorMessage ?? "视频生成失败，请检查提示词、参考素材和所选档位后重试",
        };
      }
      case "CANCELED":
        return {
          status: "failed",
          providerTaskId: taskId,
          rawStatus,
          media: [],
          errorCode: "TASK_CANCELED",
          errorMessage: "生成任务已被取消",
        };
      case "UNKNOWN":
      default:
        // 未知状态不翻成终态:现有恢复链按 unknown 处理(unknownStatus 落库透传)。
        return {
          status: "failed",
          providerTaskId: taskId,
          rawStatus,
          unknownStatus: true,
          media: [],
        };
    }
  }

  private async requestJson(
    operation: HappyHorseOperation,
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.options.apiKey.trim()) {
      throw new ProviderRequestError(
        "当前生成能力尚未配置，不会创建任务",
        operation,
        isQueryOperation(operation) ? "query_failed" : "rejected",
        false,
      );
    }
    if (callerSignal?.aborted) {
      throw new ProviderRequestError(
        "本次生成已取消，不会创建任务",
        operation,
        isQueryOperation(operation) ? "query_failed" : "rejected",
        false,
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
            ...init.headers,
          },
          signal: controller.signal,
        });
      } catch {
        throw new ProviderRequestError(
          isQueryOperation(operation)
            ? "暂时无法查询生成进度，请稍后刷新"
            : "暂时无法确认生成是否已提交，请先刷新任务列表后再重试",
          operation,
          isQueryOperation(operation) ? "query_failed" : "unknown",
          true,
        );
      }

      let payload: Record<string, unknown>;
      try {
        payload = await readJsonObject(response);
      } catch {
        throw new ProviderRequestError(
          isQueryOperation(operation)
            ? "暂时无法读取生成进度，请稍后刷新"
            : "暂时无法确认生成是否已提交，请先刷新任务列表后再重试",
          operation,
          isQueryOperation(operation) ? "query_failed" : "unknown",
          true,
        );
      }
      const providerError = extractProviderError(payload);
      const queryReturnedFailedResult = isQueryOperation(operation)
        && response.ok
        && ["FAILED", "CANCELED"].includes(textAt(nestedRecord(payload, "output") ?? {}, "task_status") ?? "");
      if (!response.ok || (providerError.message && !queryReturnedFailedResult)) {
        const message = isQueryOperation(operation)
          ? "生成进度暂时无法读取，请稍后刷新"
          : "生成请求未被服务接受，请检查提示词、参考素材和所选档位后重试";
        if (isQueryOperation(operation)) {
          throw new ProviderRequestError(
            message,
            operation,
            "query_failed",
            response.status >= 500 || response.status === 408 || response.status === 429,
            providerError.code,
            response.status,
          );
        }
        const isUnknown = response.status >= 500 || response.status === 408;
        throw new ProviderRequestError(
          message,
          operation,
          isUnknown ? "unknown" : "rejected",
          isUnknown || response.status === 429,
          providerError.code,
          response.status,
        );
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", abort);
    }
  }
}

function normalizeHappyHorseResolution(value: unknown): string {
  if (typeof value !== "string") return "720P";
  const upper = value.trim().toUpperCase();
  return SUPPORTED_RESOLUTIONS[upper] ? upper : "720P";
}

function isQueryOperation(operation: HappyHorseOperation): operation is "query_video" {
  return operation === "query_video";
}

function assertRequestBasics(request: ProviderGenerationRequest): void {
  if (!request.model.trim() || !request.prompt.trim()) {
    throw new ProviderRequestError(
      "生成模型或提示词缺失，请补全后重试",
      "submit_video",
      "rejected",
      false,
    );
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function extractProviderError(payload: Record<string, unknown>): { code?: string; message?: string } {
  // DashScope 把提交失败放在顶层 code/message,查询失败放在 output.code/message。
  const topCode = textAt(payload, "code");
  const topMessage = textAt(payload, "message");
  if (topCode || topMessage) {
    return { code: topCode ?? undefined, message: topMessage ?? undefined };
  }
  const output = payload.output;
  if (!isRecord(output)) return {};
  return {
    code: textAt(output, "code") ?? undefined,
    message: textAt(output, "message") ?? undefined,
  };
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}


function textAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberAt(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));
}

function compactUsage(record: Record<string, number | undefined>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

