import { ProviderRequestError } from "../errors.js";
import type { GenerationProvider } from "../ports.js";
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

export type MinimaxFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MinimaxGenerationProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultSpeakerId?: string;
  timeoutMs?: number;
  fetchImpl?: MinimaxFetchLike;
}

type MinimaxOperation = "submit_image" | "submit_video" | "submit_audio" | "query_video";

const DEFAULT_BASE_URL = "https://api.minimaxi.com";
const DEFAULT_TIMEOUT_MS = 120_000;
const APPROVED_HOSTS = new Set(["api.minimaxi.com", "api-bj.minimaxi.com"]);
const DEFAULT_SPEAKER_ID = "male-qn-qingse";
const MAX_AUDIO_DURATION_MS = 120_000;
const MAX_PROVIDER_RESPONSE_BYTES = 96 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_INLINE_AUDIO_BYTES = 32 * 1024 * 1024;
const SAFE_USAGE_KEYS = new Set([
  "input_tokens",
  "output_tokens",
  "completion_tokens",
  "total_tokens",
  "generated_images",
  "output_seconds",
  "duration_seconds",
  "duration_ms",
  "original_duration_ms",
  "audio_length_ms",
  "usage_characters",
]);

/** MiniMax media adapter. It deliberately retains no vendor response text. */
export class MinimaxGenerationProvider implements GenerationProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: MinimaxFetchLike;

  constructor(private readonly options: MinimaxGenerationProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission> {
    if (request.mediaKind === "image") return this.submitImage(request, signal);
    if (request.mediaKind === "video") return this.submitVideo(request, signal);
    return this.submitAudio(request, signal);
  }

  async query(
    providerTaskId: string,
    request?: Pick<ProviderGenerationRequest, "model" | "mediaKind">,
    signal?: AbortSignal,
  ): Promise<ProviderResultSnapshot> {
    if (request?.mediaKind && request.mediaKind !== "video") {
      throw rejected("query_video", "当前能力不支持查询此类生成任务");
    }
    const taskId = providerTaskId.trim();
    if (!taskId) throw queryFailed("生成任务编号缺失，暂时无法查询进度");
    const payload = await this.requestJson(
      "query_video",
      `/v2/query/video_generation/${encodeURIComponent(taskId)}`,
      { method: "GET" },
      signal,
    );
    const task = taskRecord(payload);
    const status = normalizeVideoStatus(
      textAt(task, "status") ?? textAt(payload, "status") ?? textAt(dataRecord(payload), "status"),
    );
    const media = extractVideoMedia(payload);
    if (status.status === "succeeded" && media.length === 0) {
      throw queryFailed("生成已完成，但暂时无法取得成片，请稍后刷新");
    }
    return {
      status: status.status,
      providerTaskId: textAt(task, "id") ?? textAt(payload, "task_id") ?? textAt(payload, "id") ?? taskId,
      rawStatus: status.rawStatus,
      unknownStatus: status.unknownStatus,
      media,
      actualModelId: textAt(task, "model") ?? textAt(payload, "model") ?? textAt(dataRecord(payload), "model") ?? undefined,
      usage: safeUsage(payload),
      metadata: compact({
        taskId: textAt(task, "id") ?? textAt(payload, "task_id") ?? textAt(payload, "id"),
        durationSeconds: numberAt(task, "duration"),
        resolution: textAt(task, "resolution"),
        ratio: textAt(task, "ratio"),
      }),
    };
  }

  private async submitImage(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission> {
    assertBasics(request, "submit_image");
    const normalized = normalizeForMinimax(request);
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      // MiniMax officially supports inline base64 for image generation. Keep
      // the paid artifact in-process so the platform does not depend on a
      // second, temporary-provider-URL download before AIGC labeling/TOS.
      response_format: "base64",
      n: 1,
      aigc_watermark: true,
      aspect_ratio: normalized.parameters.ratio,
    };
    const references = normalized.references.filter((reference) => reference.kind === "image");
    if (references.length > 0) {
      body.subject_reference = references.map((reference) => ({
        type: "character",
        image_file: reference.url,
      }));
    }
    const payload = await this.requestJson("submit_image", "/v1/image_generation", {
      method: "POST", body: JSON.stringify(body),
    }, signal);
    const media = extractImageMedia(payload);
    if (media.length === 0) throw unknown("submit_image", "图片生成未返回可用结果，请稍后刷新任务列表后再重试");
    return { outcome: "succeeded", result: {
      status: "succeeded", rawStatus: "succeeded", media, actualModelId: request.model,
      parameterSnapshot: normalized.parameters, usage: safeUsage(payload), metadata: {},
    } };
  }

  private async submitVideo(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission> {
    assertBasics(request, "submit_video");
    const normalized = normalizeForMinimax(request);
    const payload = await this.requestJson("submit_video", "/v2/video_generation", {
      method: "POST", body: JSON.stringify({
        model: request.model,
        content: buildVideoContent(request.prompt, normalized.references),
        resolution: normalized.parameters.resolution,
        duration: normalized.parameters.durationSeconds,
        ratio: normalized.parameters.ratio,
        aigc_watermark: true,
      }),
    }, signal);
    const taskId = textAt(taskRecord(payload), "id")
      ?? textAt(payload, "task_id")
      ?? textAt(payload, "id")
      ?? textAt(dataRecord(payload), "task_id");
    if (!taskId) throw unknown("submit_video", "视频生成未能创建任务，请稍后刷新任务列表后再重试");
    return { outcome: "accepted", providerTaskId: taskId, rawStatus: textAt(payload, "status") ?? "queued" };
  }

  private async submitAudio(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission> {
    assertBasics(request, "submit_audio");
    const normalized = normalizeForMinimax(request);
    if (normalized.references.length > 0) throw rejected("submit_audio", "当前音频生成不支持参考素材，请移除后重试");
    const requestedAudioFormat = normalized.parameters.format ?? "mp3";
    if (requestedAudioFormat === "pcm") {
      throw rejected("submit_audio", "当前音频生成不支持 PCM，请改用 MP3 或 WAV");
    }
    const payload = await this.requestJson("submit_audio", "/v1/t2a_v2", {
      method: "POST", body: JSON.stringify({
        model: request.model,
        text: request.prompt,
        stream: false,
        // The synchronous API's native/default non-streaming format is hex.
        // Keeping bytes inline avoids a second temporary-URL download before
        // platform AIGC labeling and TOS persistence.
        output_format: "hex",
        subtitle_enable: true,
        subtitle_type: "sentence",
        voice_setting: {
          voice_id: normalized.parameters.speakerId
            ?? this.options.defaultSpeakerId?.trim()
            ?? DEFAULT_SPEAKER_ID,
        },
        audio_setting: {
          format: requestedAudioFormat,
          // MiniMax supports up to 44.1 kHz; 32 kHz is the documented
          // compatible default/example across speech-2.8 tiers.
          sample_rate: normalized.parameters.sampleRate ?? 32_000,
          channel: 1,
        },
        aigc_watermark: true,
      }),
    }, signal);
    const extraInfo = isRecord(payload.extra_info) ? payload.extra_info : {};
    const actualDurationMs = numberAt(extraInfo, "audio_length");
    if (!Number.isSafeInteger(actualDurationMs)
      || (actualDurationMs ?? 0) <= 0
      || (actualDurationMs ?? 0) > MAX_AUDIO_DURATION_MS) {
      throw unknown("submit_audio", "音频生成已完成，但缺少可核验的实测时长，请等待系统核对");
    }
    const reportedAudioFormat = normalizedAudioFormat(textAt(extraInfo, "audio_format"))
      ?? requestedAudioFormat;
    if (reportedAudioFormat !== requestedAudioFormat) {
      throw unknown("submit_audio", "音频生成已完成，但返回格式与请求不一致，请先查看任务状态，避免重复提交");
    }
    const media = extractAudioMedia(payload, reportedAudioFormat).map((item) => ({
      ...item,
      durationSeconds: actualDurationMs! / 1_000,
      actualDurationMs: actualDurationMs!,
      audioDurationPolicy: {
        source: "provider_reported" as const,
        maxDurationMs: MAX_AUDIO_DURATION_MS,
      },
    }));
    if (media.length === 0) throw unknown("submit_audio", "音频生成未返回可用结果，请稍后刷新任务列表后再重试");
    const usageCharacters = numberAt(extraInfo, "usage_characters");
    return { outcome: "succeeded", result: {
      status: "succeeded", rawStatus: "succeeded", media, actualModelId: request.model,
      parameterSnapshot: normalized.parameters,
      usage: compactUsage({
        usage_characters: usageCharacters,
        audio_length_ms: actualDurationMs,
      }),
      metadata: compact({
        actualDurationMs,
        usageCharacters,
      }),
    } };
  }

  private async requestJson(operation: MinimaxOperation, path: string, init: RequestInit, callerSignal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.options.apiKey.trim()) throw rejected(operation, "当前生成能力尚未配置，不会创建任务");
    if (!isApprovedMinimaxBaseUrl(this.baseUrl)) throw rejected(operation, "当前生成服务地址未获批准，不会创建任务");
    if (callerSignal?.aborted) throw rejected(operation, "本次生成已取消，不会创建任务");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers: {
          Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json", ...init.headers,
        }, signal: controller.signal });
      } catch {
        throw isQuery(operation)
          ? queryFailed("暂时无法查询生成进度，请稍后刷新")
          : unknown(operation, "暂时无法确认生成是否已提交，请先刷新任务列表后再重试");
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readJsonObject(response);
      } catch {
        if (isQuery(operation)) {
          throw queryFailed("生成进度响应超出安全上限或格式无效，请稍后刷新", response.status);
        }
        if (!response.ok && response.status < 500 && response.status !== 408) {
          throw rejected(operation, "生成请求未被服务接受，请检查提示词、参考素材和所选档位后重试", response.status);
        }
        throw unknown(operation, "暂时无法安全读取生成结果，请先刷新任务列表后再重试", response.status);
      }
      if (!response.ok || hasProviderError(payload)) {
        const message = isQuery(operation) ? "生成进度暂时无法读取，请稍后刷新" : "生成请求未被服务接受，请检查提示词、参考素材和所选档位后重试";
        if (isQuery(operation)) throw queryFailed(message, response.status);
        if (response.status >= 500 || response.status === 408) throw unknown(operation, "暂时无法确认生成是否已提交，请先刷新任务列表后再重试", response.status);
        throw rejected(operation, message, response.status);
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", abort);
    }
  }
}

export function isApprovedMinimaxBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && APPROVED_HOSTS.has(url.hostname.toLowerCase())
      && !url.username
      && !url.password
      && (url.pathname === "" || url.pathname === "/")
      && !url.search
      && !url.hash;
  } catch { return false; }
}

function normalizeForMinimax(request: ProviderGenerationRequest): { parameters: GenerationParameters; references: GenerationReferenceSnapshot[] } {
  try {
    if (request.mediaKind === "image") {
      if (request.model !== "image-01" && request.model !== "image-01-live") {
        throw new V01GenerationContractError("当前图片能力仅支持 image-01 或 image-01-live");
      }
      const parameters = normalizeV01Parameters(request);
      const references = normalizeV01References("image", request.references, request.model);
      return { parameters, references };
    }
    if (request.mediaKind === "video") {
      if (request.model !== "MiniMax-H3") {
        throw new V01GenerationContractError("当前视频能力仅支持 MiniMax-H3");
      }
      const parameters = normalizeV01Parameters(request);
      const references = normalizeV01References("video", request.references, request.model);
      return { parameters, references };
    }
    if (request.model !== "speech-2.8-turbo" && request.model !== "speech-2.8-hd") {
      throw new V01GenerationContractError("当前音频能力仅支持 speech-2.8-turbo 或 speech-2.8-hd");
    }
    const parameters = normalizeV01Parameters(request);
    if (parameters.format === "pcm") {
      throw new V01GenerationContractError("当前 MiniMax 音频能力不支持 PCM 输出");
    }
    if (parameters.sampleRate !== undefined
      && ![8_000, 16_000, 22_050, 24_000, 32_000, 44_100].includes(parameters.sampleRate)) {
      throw new V01GenerationContractError("当前 MiniMax 音频能力不支持所选采样率");
    }
    const references = normalizeV01References("audio", request.references);
    return { parameters, references };
  } catch (error) {
    if (error instanceof V01GenerationContractError) throw rejected(`submit_${request.mediaKind}` as MinimaxOperation, error.message);
    throw error;
  }
}

function buildVideoContent(prompt: string, references: GenerationReferenceSnapshot[]): Record<string, unknown>[] {
  return [{ type: "text", text: prompt }, ...references.map((reference) => reference.kind === "image"
    ? { type: "image_url", image_url: { url: reference.url }, role: reference.role ?? "reference_image" }
    : reference.kind === "video"
      ? { type: "video_url", video_url: { url: reference.url }, role: reference.role ?? "reference_video" }
      : { type: "audio_url", audio_url: { url: reference.url }, role: reference.role ?? "reference_audio" })];
}

function normalizeVideoStatus(value: string | null): { status: "pending" | "running" | "succeeded" | "failed"; rawStatus: string; unknownStatus: boolean } {
  const rawStatus = value?.trim().toLowerCase() ?? "";
  if (["queued", "queueing", "pending", "preparing", "waiting"].includes(rawStatus)) {
    return { status: "pending", rawStatus, unknownStatus: false };
  }
  if (["processing", "running", "in_progress"].includes(rawStatus)) return { status: "running", rawStatus, unknownStatus: false };
  if (["success", "succeeded", "completed"].includes(rawStatus)) return { status: "succeeded", rawStatus, unknownStatus: false };
  if (["failed", "fail", "cancelled", "expired"].includes(rawStatus)) return { status: "failed", rawStatus, unknownStatus: false };
  return { status: "running", rawStatus, unknownStatus: true };
}

function extractImageMedia(payload: Record<string, unknown>): ProviderMediaResult[] {
  const inline = stringsFrom(payload, ["image_base64"]);
  if (inline.length > 0) {
    return inline.map((contentBase64, index) => {
      const bytes = decodeCanonicalBase64(
        contentBase64,
        MAX_INLINE_IMAGE_BYTES,
        "submit_image",
        "图片",
      );
      return {
        kind: "image",
        inlineContent: {
          contentBase64,
          contentType: recognizedImageContentType(bytes),
        },
        providerResultKey: `image-${index}`,
      };
    });
  }
  // Compatibility only: older/regional deployments may still return a URL
  // even when base64 was requested.
  return urlsFrom(payload, ["image_urls", "images", "url"])
    .map((url, index) => ({ kind: "image", temporaryUrl: url, providerResultKey: `image-${index}` }));
}
function extractAudioMedia(
  payload: Record<string, unknown>,
  audioFormat: "mp3" | "wav",
): ProviderMediaResult[] {
  const audioHex = textAt(dataRecord(payload), "audio") ?? textAt(payload, "audio");
  if (audioHex && /^(?:[0-9a-fA-F]{2})+$/.test(audioHex)) {
    if (audioHex.length / 2 > MAX_INLINE_AUDIO_BYTES) {
      throw unknown("submit_audio", "音频生成已完成，但返回内容超出安全上限，请先查看任务状态，避免重复提交");
    }
    const bytes = Buffer.from(audioHex, "hex");
    if (audioFormat === "wav"
      && (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "RIFF"
        || bytes.subarray(8, 12).toString("ascii") !== "WAVE")) {
      throw unknown("submit_audio", "音频生成已完成，但 WAV 内容无法核验，请先查看任务状态，避免重复提交");
    }
    if (audioFormat === "mp3" && !hasMp3Magic(bytes)) {
      throw unknown("submit_audio", "音频生成已完成，但 MP3 内容无法核验，请先查看任务状态，避免重复提交");
    }
    return [{
      kind: "audio",
      inlineContent: {
        contentBase64: bytes.toString("base64"),
        contentType: audioFormat === "wav" ? "audio/wav" : "audio/mpeg",
      },
      providerResultKey: "audio-0",
    }];
  }
  // Compatibility only: accept URL-shaped results from older/regional
  // deployments even though the request asks for inline hex.
  return urlsFrom(payload, ["audio_url", "audio", "url"])
    .map((url, index) => ({ kind: "audio", temporaryUrl: url, providerResultKey: `audio-${index}` }));
}

function decodeCanonicalBase64(
  contentBase64: string,
  maxBytes: number,
  operation: Exclude<MinimaxOperation, "query_video">,
  mediaLabel: string,
): Buffer {
  if (
    contentBase64.length === 0
    || contentBase64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(contentBase64)
  ) {
    throw unknown(operation, `${mediaLabel}生成已完成，但内联内容无法安全解析，请先查看任务状态，避免重复提交`);
  }
  const estimatedBytes = Math.floor(contentBase64.length * 3 / 4)
    - (contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0 || estimatedBytes > maxBytes) {
    throw unknown(operation, `${mediaLabel}生成已完成，但内联内容超出安全上限，请先查看任务状态，避免重复提交`);
  }
  return Buffer.from(contentBase64, "base64");
}

function recognizedImageContentType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  throw unknown("submit_image", "图片生成已完成，但图片格式无法核验，请先查看任务状态，避免重复提交");
}

function hasMp3Magic(bytes: Buffer): boolean {
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") {
    return true;
  }
  if (bytes.length < 2 || bytes[0] !== 0xff) return false;
  const second = bytes[1]!;
  const versionBits = (second >> 3) & 0b11;
  const layerBits = (second >> 1) & 0b11;
  return (second & 0xe0) === 0xe0 && versionBits !== 0b01 && layerBits !== 0b00;
}

function extractVideoMedia(payload: Record<string, unknown>): ProviderMediaResult[] {
  return urlsFrom(payload, ["video_url", "video", "download_url", "url"])
    .map((url, index) => ({ kind: "video", temporaryUrl: url, providerResultKey: `video-${index}` }));
}
function urlsFrom(payload: Record<string, unknown>, keys: string[]): string[] {
  return stringsFrom(payload, keys, true);
}
function stringsFrom(payload: Record<string, unknown>, keys: string[], urlsOnly = false): string[] {
  const task = taskRecord(payload);
  const candidates = [
    payload,
    dataRecord(payload),
    task,
    isRecord(payload.file) ? payload.file : {},
    isRecord(task.content) ? task.content : {},
  ];
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key];
      const values = Array.isArray(value) ? value : [value];
      const strings = values.flatMap((item) => typeof item === "string"
        ? [item.trim()]
        : urlsOnly && isRecord(item)
          ? [textAt(item, "url") ?? textAt(item, "download_url") ?? ""]
          : []).filter(Boolean);
      if (strings.length) return strings;
    }
  }
  return [];
}
function safeUsage(payload: Record<string, unknown>): Record<string, number> {
  const task = taskRecord(payload);
  const usage = task.usage ?? dataRecord(payload).usage ?? payload.usage;
  if (!isRecord(usage)) return {};
  const safe: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (SAFE_USAGE_KEYS.has(key)
      && typeof value === "number"
      && Number.isFinite(value)
      && value >= 0) {
      safe[key] = value;
    }
  }
  return safe;
}
function compactUsage(
  record: Record<string, number | undefined>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => (
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0
    )),
  );
}
function hasProviderError(payload: Record<string, unknown>): boolean { const base = dataRecord(payload).base_resp ?? payload.base_resp; if (isRecord(base) && Number(base.status_code ?? 0) !== 0) return true; return isRecord(payload.error) || (isRecord(dataRecord(payload).error)); }
function dataRecord(payload: Record<string, unknown>): Record<string, unknown> { return isRecord(payload.data) ? payload.data : {}; }
function taskRecord(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.task) ? payload.task : {};
}
async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("provider response exceeds safe byte limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("provider response exceeds safe byte limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  const value: unknown = text.trim() ? JSON.parse(text) : {};
  if (!isRecord(value)) throw new Error("provider response is not a JSON object");
  return value;
}
function normalizedAudioFormat(value: string | null): "mp3" | "wav" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "mp3" || normalized === "wav") return normalized;
  return undefined;
}
function textAt(record: Record<string, unknown>, key: string): string | null { const value = record[key]; return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null; }
function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function compact(record: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)); }
function assertBasics(request: ProviderGenerationRequest, operation: MinimaxOperation): void { if (!request.model.trim() || !request.prompt.trim()) throw rejected(operation, "生成模型或提示词缺失，请补全后重试"); }
function isQuery(operation: MinimaxOperation): operation is "query_video" { return operation === "query_video"; }
function rejected(operation: MinimaxOperation, message: string, httpStatus?: number): ProviderRequestError { return new ProviderRequestError(message, operation, isQuery(operation) ? "query_failed" : "rejected", false, undefined, httpStatus); }
function unknown(operation: Exclude<MinimaxOperation, "query_video">, message: string, httpStatus?: number): ProviderRequestError { return new ProviderRequestError(message, operation, "unknown", true, undefined, httpStatus); }
function queryFailed(message: string, httpStatus?: number): ProviderRequestError { return new ProviderRequestError(message, "query_video", "query_failed", false, undefined, httpStatus); }
