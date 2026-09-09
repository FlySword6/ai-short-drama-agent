import { ProviderRequestError } from "../errors.js";
import type { GenerationProvider } from "../ports.js";
import { normalizeArkVideoStatus } from "../status.js";
import type {
  GenerationParameters,
  GenerationReferenceSnapshot,
  ProviderGenerationRequest,
  ProviderMediaResult,
  ProviderResultSnapshot,
  ProviderSubmission,
} from "../types.js";
import {
  normalizeV01Parameters,
  normalizeV01References,
  V01GenerationContractError,
} from "../v01Contract.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ArkGenerationProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

type ArkOperation = "submit_image" | "submit_video" | "query_video";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_TIMEOUT_MS = 120_000;

export class ArkGenerationProvider implements GenerationProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: ArkGenerationProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission> {
    if (request.mediaKind === "image") return this.submitImage(request, signal);
    if (request.mediaKind === "video") return this.submitVideo(request, signal);
    // Audio moved to the openspeech TTS adapter (S39); Ark keeps image/video only.
    throw new ProviderRequestError(
      "当前音频生成能力尚未配置，不会创建任务",
      "submit_audio",
      "rejected",
      false,
      "PROVIDER_NOT_CONFIGURED",
    );
  }

  async query(
    providerTaskId: string,
    request?: Pick<ProviderGenerationRequest, "model" | "mediaKind">,
    signal?: AbortSignal,
  ): Promise<ProviderResultSnapshot> {
    if (request?.mediaKind === "audio") {
      // Audio moved to the openspeech TTS adapter (S39); Ark keeps image/video only.
      throw new ProviderRequestError(
        "当前音频生成能力尚未配置，不会查询任务",
        "query_audio",
        "query_failed",
        false,
        "PROVIDER_NOT_CONFIGURED",
      );
    }
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
      `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET" },
      signal,
    );
    const rawStatus = textAt(payload, "status");
    if (!rawStatus) {
      throw new ProviderRequestError(
        "暂时无法确认生成进度，请稍后刷新",
        "query_video",
        "query_failed",
        true,
      );
    }

    const normalized = normalizeArkVideoStatus(rawStatus);
    const media = extractVideoMedia(payload);
    if (normalized.status === "succeeded" && !media.some((item) => item.kind === "video")) {
      throw new ProviderRequestError(
        "生成已完成，但暂时无法取得成片，请稍后刷新",
        "query_video",
        "query_failed",
        true,
      );
    }

    const providerError = extractProviderError(payload);
    const completionTokens = nestedNumberAt(payload, "usage", "completion_tokens");
    const totalTokens = nestedNumberAt(payload, "usage", "total_tokens");
    return {
      status: normalized.status,
      providerTaskId: textAt(payload, "id") ?? taskId,
      rawStatus: normalized.rawStatus,
      unknownStatus: normalized.unknownStatus,
      media,
      errorCode: providerError.code,
      errorMessage: providerError.message,
      actualModelId: textAt(payload, "model") ?? undefined,
      usage: compactUsage({
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        duration_seconds: numberAt(payload, "duration"),
      }),
      metadata: compactRecord({
        durationSeconds: numberAt(payload, "duration"),
        ratio: textAt(payload, "ratio"),
        resolution: textAt(payload, "resolution"),
        seed: numberAt(payload, "seed"),
        completionTokens,
        totalTokens,
      }),
    };
  }

  private async submitImage(
    request: ProviderGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ProviderSubmission> {
    assertRequestBasics(request, "submit_image");
    const normalized = normalizeProviderContract(request, "submit_image");
    const imageReferences = normalized.references
      .filter((reference) => reference.kind === "image")
      .map((reference) => reference.url);

    // 组图禁用通过“不发送该参数”表达：Seedream 5.0 Pro 不识别
    // sequential_image_generation（显式发送会被 400 拒），4.x 缺省即 disabled。
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      response_format: "url",
      stream: false,
      size: normalized.parameters.size,
      watermark: false,
    };
    if (imageReferences.length === 1) body.image = imageReferences[0];
    if (imageReferences.length > 1) body.image = imageReferences;

    const payload = await this.requestJson(
      "submit_image",
      "/images/generations",
      { method: "POST", body: JSON.stringify(body) },
      signal,
    );
    const dataError = extractDataError(payload);
    if (dataError.message) {
      throw new ProviderRequestError(
        "图片生成未能提交，请检查提示词、参考素材和所选档位后重试",
        "submit_image",
        "rejected",
        false,
        dataError.code,
        200,
      );
    }
    const media = extractImageMedia(payload);
    if (media.length === 0) {
      throw new ProviderRequestError(
        "图片生成未返回可用结果，请稍后重试",
        "submit_image",
        "unknown",
        false,
      );
    }

    const generatedImages = nestedNumberAt(payload, "usage", "generated_images");
    const outputTokens = nestedNumberAt(payload, "usage", "output_tokens");
    const totalTokens = nestedNumberAt(payload, "usage", "total_tokens");
    return {
      outcome: "succeeded",
      result: {
        status: "succeeded",
        rawStatus: "succeeded",
        media,
        actualModelId: textAt(payload, "model") ?? request.model,
        parameterSnapshot: normalized.parameters,
        usage: compactUsage({
          generated_images: generatedImages,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
        }),
        metadata: compactRecord({
          model: textAt(payload, "model"),
          created: numberAt(payload, "created"),
          generatedImages,
          outputTokens,
          totalTokens,
        }),
      },
    };
  }

  private async submitVideo(
    request: ProviderGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ProviderSubmission> {
    assertRequestBasics(request, "submit_video");
    const normalized = normalizeProviderContract(request, "submit_video");
    const body: Record<string, unknown> = {
      model: request.model,
      content: buildVideoContent(request.prompt, normalized.references),
      ratio: normalized.parameters.ratio,
      resolution: normalized.parameters.resolution,
      duration: normalized.parameters.durationSeconds,
      watermark: false,
      generate_audio: normalized.parameters.generateAudio,
    };

    const payload = await this.requestJson(
      "submit_video",
      "/contents/generations/tasks",
      { method: "POST", body: JSON.stringify(body) },
      signal,
    );
    const providerTaskId = textAt(payload, "id");
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
      rawStatus: textAt(payload, "status") ?? "queued",
    };
  }

  private async requestJson(
    operation: ArkOperation,
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
        response = await this.fetchImpl(/^https:\/\//i.test(path) ? path : `${this.baseUrl}${path}`, {
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
        && normalizeArkVideoStatus(textAt(payload, "status")).status === "failed";
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

function normalizeProviderContract(
  request: ProviderGenerationRequest,
  operation: "submit_image" | "submit_video",
): { parameters: GenerationParameters; references: GenerationReferenceSnapshot[] } {
  try {
    const parameters = normalizeV01Parameters(request);
    const references = normalizeV01References(request.mediaKind, request.references, request.model);
    return { parameters, references };
  } catch (error) {
    if (error instanceof V01GenerationContractError) {
      throw new ProviderRequestError(error.message, operation, "rejected", false);
    }
    throw error;
  }
}

function isQueryOperation(operation: ArkOperation): operation is "query_video" {
  return operation === "query_video";
}

function assertRequestBasics(request: ProviderGenerationRequest, operation: ArkOperation): void {
  if (!request.model.trim() || !request.prompt.trim()) {
    throw new ProviderRequestError(
      "生成模型或提示词缺失，请补全后重试",
      operation,
      "rejected",
      false,
    );
  }
}

const REFERENCE_LABELS: Record<GenerationReferenceSnapshot["kind"], string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

/**
 * Seedance rejects a request whose prompt never names the attached reference
 * material: the contract requires 「图片1」/「视频1」/「音频1」 addressed by the
 * material's order within its own modality, and forbids pasting the Asset ID.
 * First/last-frame slots are anchors rather than reference material, so they
 * take no number.
 */
function referenceAddressingPrefix(references: GenerationReferenceSnapshot[]): string {
  const counts = new Map<string, number>();
  const labels: string[] = [];
  for (const reference of references) {
    if (reference.role === "first_frame" || reference.role === "last_frame") continue;
    const next = (counts.get(reference.kind) ?? 0) + 1;
    counts.set(reference.kind, next);
    labels.push(`${REFERENCE_LABELS[reference.kind]}${next}`);
  }
  if (labels.length === 0) return "";
  return `参考素材：${labels.join("、")}。`;
}

function buildVideoContent(
  prompt: string,
  references: GenerationReferenceSnapshot[],
): Record<string, unknown>[] {
  const prefix = referenceAddressingPrefix(references);
  const content: Record<string, unknown>[] = [{
    type: "text",
    text: prefix ? `${prefix}${prompt}` : prompt,
  }];
  for (const reference of references) {
    // The role is mandatory at the API boundary: when it is absent, Seedance
    // falls back to positional semantics and silently treats the first image
    // as the first frame. Reference material must never be promoted that way.
    if (reference.kind === "image") {
      content.push({
        type: "image_url",
        image_url: { url: reference.url },
        role: reference.role ?? "reference_image",
      });
    } else if (reference.kind === "video") {
      content.push({
        type: "video_url",
        video_url: { url: reference.url },
        role: reference.role ?? "reference_video",
      });
    } else {
      content.push({
        type: "audio_url",
        audio_url: { url: reference.url },
        role: reference.role ?? "reference_audio",
      });
    }
  }
  return content;
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

function extractImageMedia(payload: Record<string, unknown>): ProviderMediaResult[] {
  const data = payload.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const directUrl = urlValue(item.url);
    const imageContent = item.imagecontent;
    const nestedItems = Array.isArray(imageContent)
      ? imageContent
      : imageContent === undefined ? [] : [imageContent];
    const nested = nestedItems.flatMap((nestedItem, nestedIndex) => {
      const url = urlValue(nestedItem);
      return url ? [{
        kind: "image" as const,
        temporaryUrl: url,
        providerResultKey: `image-${index}-${nestedIndex}`,
      }] : [];
    });
    return directUrl
      ? [{ kind: "image" as const, temporaryUrl: directUrl, providerResultKey: `image-${index}` }, ...nested]
      : nested;
  });
}

function extractVideoMedia(payload: Record<string, unknown>): ProviderMediaResult[] {
  const content = payload.content;
  const items = Array.isArray(content) ? content : isRecord(content) ? [content] : [];
  const results: ProviderMediaResult[] = [];
  for (const [index, item] of items.entries()) {
    if (!isRecord(item)) continue;
    const videoUrl = urlValue(item.video_url) ?? (item.type === "video_url" ? urlValue(item.url) : undefined);
    if (videoUrl) {
      results.push({ kind: "video", temporaryUrl: videoUrl, providerResultKey: `video-${index}` });
    }
    const lastFrameUrl = urlValue(item.last_frame_url)
      ?? (item.type === "image_url" ? urlValue(item.image_url) ?? urlValue(item.url) : undefined);
    if (lastFrameUrl) {
      results.push({
        kind: "last_frame",
        temporaryUrl: lastFrameUrl,
        providerResultKey: `last-frame-${index}`,
      });
    }
  }
  return results;
}

function extractProviderError(payload: Record<string, unknown>): { code?: string; message?: string } {
  const error = payload.error;
  if (!isRecord(error)) return {};
  return {
    code: textAt(error, "code") ?? undefined,
    message: textAt(error, "message") ?? undefined,
  };
}

function extractDataError(payload: Record<string, unknown>): { code?: string; message?: string } {
  const data = payload.data;
  if (!Array.isArray(data)) return {};
  for (const item of data) {
    if (!isRecord(item)) continue;
    const errors = Array.isArray(item.error) ? item.error : [item.error];
    for (const error of errors) {
      if (!isRecord(error)) continue;
      const message = textAt(error, "message");
      if (message) return { code: textAt(error, "code") ?? undefined, message };
    }
  }
  return {};
}

function urlValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value)) return textAt(value, "url") ?? undefined;
  return undefined;
}

function textAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function nestedNumberAt(
  record: Record<string, unknown>,
  parentKey: string,
  key: string,
): number | undefined {
  const parent = record[parentKey];
  return isRecord(parent) ? numberAt(parent, key) : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));
}

function compactUsage(record: Record<string, number | undefined>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
