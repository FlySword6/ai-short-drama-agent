import { randomUUID } from "node:crypto";
import { ProviderRequestError } from "../errors.js";
import type { GenerationProvider } from "../ports.js";
import type {
  GenerationParameters,
  ProviderGenerationRequest,
  ProviderMediaResult,
  ProviderResultSnapshot,
  ProviderSubmission,
} from "../types.js";
import {
  AUDIO_MAX_TEXT_PROMPT_LENGTH,
  assertAudioSource,
  normalizeV01Parameters,
  normalizeV01References,
  V01GenerationContractError,
} from "../v01Contract.js";
import type { FetchLike } from "./arkGenerationProvider.js";
import { isApprovedOpenspeechTtsUrl } from "./openspeechTtsProvider.js";

export interface SeedAudioProviderOptions {
  apiKey: string;
  /** Exact v3 create URL. It stays deployment-owned and has no guessed default. */
  endpoint?: string;
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_SAMPLE_RATE = 48_000;
const SEED_AUDIO_MAX_PROVIDER_DURATION_MS = 120_000;
const CONTENT_SAFETY_MESSAGES: Readonly<Record<number, string>> = {
  45001104: "音频内容未通过安全检查，请调整描述后重试",
  45001125: "文字内容未通过安全检查，请调整描述后重试",
  45001127: "参考音频未通过安全检查，请更换素材",
  45001130: "参考图片未通过安全检查，请更换素材",
};

/**
 * 豆包音频生成 v3 adapter.
 *
 * This intentionally lives beside the legacy OpenSpeech v1 TTS adapter.
 * Deployments opt into v3 with a separate API key, so the old protocol can be
 * removed later without turning a credential migration into a flag day.
 */
export class SeedAudioProvider implements GenerationProvider {
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: SeedAudioProviderOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(
    request: ProviderGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ProviderSubmission> {
    if (request.mediaKind !== "audio") {
      throw rejected("Seed Audio 只接受音频生成任务", "PROVIDER_NOT_CONFIGURED");
    }
    const model = request.model.trim();
    const prompt = request.prompt.trim();
    if (!model || !prompt) {
      throw rejected("Seed Audio 模型和文字描述不能为空", "INVALID_PROVIDER_INPUT");
    }
    if (prompt.length > AUDIO_MAX_TEXT_PROMPT_LENGTH) {
      throw rejected(
        `Seed Audio 文字描述不能超过 ${AUDIO_MAX_TEXT_PROMPT_LENGTH} 个字符`,
        "INVALID_PROVIDER_INPUT",
      );
    }

    const endpoint = this.requireEndpoint();
    const apiKey = this.options.apiKey.trim();
    if (!apiKey) {
      throw rejected("Seed Audio API Key 未配置，未发送供应商请求", "PROVIDER_NOT_CONFIGURED");
    }

    const normalized = normalizeProviderContract(request);
    const requestId = randomUUID();
    const parameters = normalized.parameters;
    const body = {
      model,
      text_prompt: prompt,
      references: buildReferences(parameters, normalized.references),
      audio_config: {
        format: parameters.format ?? "mp3",
        sample_rate: parameters.sampleRate ?? DEFAULT_SAMPLE_RATE,
        ...(parameters.speechRate !== undefined ? { speech_rate: parameters.speechRate } : {}),
        ...(parameters.loudnessRate !== undefined ? { loudness_rate: parameters.loudnessRate } : {}),
        ...(parameters.pitchRate !== undefined ? { pitch_rate: parameters.pitchRate } : {}),
        enable_subtitle: parameters.enableSubtitle ?? true,
      },
      watermark: {
        aigc_watermark: parameters.aigcWatermarkEnabled ?? false,
        // Platform-side AIGC labeling is the only verified persistence path.
        // Do not enable a provider field until a paid result and metadata
        // inspection prove its exact semantics and compatibility.
        aigc_metadata: { enable: false },
      },
    };

    const { payload, logId } = await this.requestJson(
      endpoint,
      apiKey,
      requestId,
      body,
      signal,
    );
    const code = vendorCodeAt(payload);
    if (code !== undefined && code !== 0) throw vendorFailure(code, payload);

    const audioBase64 = textAt(payload, "audio") ?? textAt(payload, "data");
    const temporaryUrl = textAt(payload, "url");
    if (!audioBase64 && !temporaryUrl) {
      throw new ProviderRequestError(
        "Seed Audio 返回成功但没有音频内容",
        "submit_audio",
        "unknown",
        false,
      );
    }

    const durationMs = secondsToMilliseconds(numberAt(payload, "duration"));
    const originalDurationMs = secondsToMilliseconds(numberAt(payload, "original_duration"));
    if (!originalDurationMs) {
      throw new ProviderRequestError(
        "Seed Audio 返回成功但缺少计费原始时长",
        "submit_audio",
        "unknown",
        false,
      );
    }

    const format = parameters.format ?? "mp3";
    const providerResultKey = logId ?? requestId;
    const subtitle = normalizedSubtitle(payload.subtitle, durationMs);
    const media: ProviderMediaResult = {
      kind: "audio",
      providerResultKey,
      ...(audioBase64
        ? {
            inlineContent: {
              contentBase64: audioBase64,
              contentType: contentTypeForFormat(format),
            },
          }
        : { temporaryUrl: temporaryUrl! }),
      ...(durationMs ? {
        durationSeconds: durationMs / 1_000,
        actualDurationMs: durationMs,
      } : {}),
      audioDurationPolicy: {
        source: "provider_reported",
        maxDurationMs: SEED_AUDIO_MAX_PROVIDER_DURATION_MS,
      },
      ...(subtitle ? { subtitle } : {}),
    };

    return {
      outcome: "succeeded",
      providerTaskId: providerResultKey,
      result: {
        status: "succeeded",
        providerTaskId: providerResultKey,
        rawStatus: "succeeded",
        media: [media],
        actualModelId: model,
        parameterSnapshot: normalized.parameters,
        usage: { original_duration_ms: originalDurationMs },
        metadata: compactRecord({
          requestId,
          logId,
          durationMs,
          originalDurationMs,
          providerAigcMetadataRequested: false,
        }),
      },
    };
  }

  async query(): Promise<ProviderResultSnapshot> {
    throw rejected("Seed Audio 是同步接口，没有可轮询任务", "PROVIDER_NOT_CONFIGURED");
  }

  private requireEndpoint(): string {
    const endpoint = this.options.endpoint?.trim() ?? "";
    if (!endpoint) {
      throw rejected("Seed Audio 提交地址未配置，未发送供应商请求", "PROVIDER_NOT_CONFIGURED");
    }
    if (!isApprovedSeedAudioUrl(endpoint, this.options.allowedHosts)) {
      throw rejected("Seed Audio 提交地址不在允许范围，未发送供应商请求", "PROVIDER_ENDPOINT_NOT_ALLOWED");
    }
    return endpoint.replace(/\/+$/, "");
  }

  private async requestJson(
    endpoint: string,
    apiKey: string,
    requestId: string,
    body: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<{ payload: Record<string, unknown>; logId?: string }> {
    if (callerSignal?.aborted) {
      throw rejected("Seed Audio 请求在提交前已取消");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": apiKey,
            "X-Api-Request-Id": requestId,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new ProviderRequestError(
          "Seed Audio 提交结果未知，请等待系统核对",
          "submit_audio",
          "unknown",
          true,
        );
      }

      const logId = response.headers.get("X-Tt-Logid")?.trim() || undefined;
      if (response.status === 401 || response.status === 403) {
        throw new ProviderRequestError(
          `Seed Audio 认证或权限被拒绝（HTTP ${response.status}）`,
          "submit_audio",
          "rejected",
          false,
          undefined,
          response.status,
        );
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readJsonObject(response);
      } catch {
        throw new ProviderRequestError(
          "Seed Audio 返回内容无法解析，提交结果未知",
          "submit_audio",
          "unknown",
          true,
          undefined,
          response.status,
        );
      }

      const code = vendorCodeAt(payload);
      if (!response.ok) {
        if (code !== undefined) throw vendorFailure(code, payload, response.status);
        if (response.status >= 500 || response.status === 408) {
          throw new ProviderRequestError(
            `Seed Audio 服务暂不可用（HTTP ${response.status}）`,
            "submit_audio",
            "unknown",
            true,
            undefined,
            response.status,
          );
        }
        throw new ProviderRequestError(
          `Seed Audio 请求未被接受（HTTP ${response.status}）`,
          "submit_audio",
          "rejected",
          response.status === 429,
          undefined,
          response.status,
        );
      }
      return { payload, ...(logId ? { logId } : {}) };
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", abort);
    }
  }
}

function buildReferences(
  parameters: GenerationParameters,
  references: ProviderGenerationRequest["references"],
): Array<Record<string, string>> {
  // v3 的公版/复刻音色也属于 references。assertAudioSource has already
  // rejected speaker + audio/image reference mixes before this mapping runs.
  if (parameters.speakerId) return [{ speaker: parameters.speakerId.trim() }];
  return references.map((reference): Record<string, string> => (
    reference.kind === "image"
      ? { image_url: reference.url }
      : { audio_url: reference.url }
  ));
}

/** The v3 API key must never be sent to a legacy or deployment-invented path. */
export function isApprovedSeedAudioUrl(
  value: string,
  configuredAllowedHosts?: readonly string[],
): boolean {
  if (!isApprovedOpenspeechTtsUrl(value, configuredAllowedHosts)) return false;
  try {
    const url = new URL(value);
    return url.pathname === "/api/v3/tts/create" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function normalizeProviderContract(
  request: ProviderGenerationRequest,
): { parameters: GenerationParameters; references: ProviderGenerationRequest["references"] } {
  try {
    const parameters = normalizeV01Parameters(request);
    const references = normalizeV01References(request.mediaKind, request.references, request.model);
    assertAudioSource(parameters, references);
    return { parameters, references };
  } catch (error) {
    if (error instanceof V01GenerationContractError) {
      throw rejected(error.message, "INVALID_PROVIDER_INPUT");
    }
    throw error;
  }
}

function vendorFailure(
  code: number,
  payload: Record<string, unknown>,
  httpStatus = 200,
): ProviderRequestError {
  const providerCode = `SEEDAUDIO_${code}`;
  const message = CONTENT_SAFETY_MESSAGES[code]
    ?? textAt(payload, "message")
    ?? `Seed Audio 返回错误码 ${code}`;
  const leadingDigit = String(Math.abs(code))[0];
  if (leadingDigit === "4") {
    return new ProviderRequestError(
      message,
      "submit_audio",
      "rejected",
      httpStatus === 429,
      providerCode,
      httpStatus,
    );
  }
  if (leadingDigit === "5") {
    return new ProviderRequestError(
      message,
      "submit_audio",
      "unknown",
      true,
      providerCode,
      httpStatus,
    );
  }
  return new ProviderRequestError(
    message,
    "submit_audio",
    "unknown",
    false,
    providerCode,
    httpStatus,
  );
}

function rejected(message: string, providerCode?: string): ProviderRequestError {
  return new ProviderRequestError(
    message,
    "submit_audio",
    "rejected",
    false,
    providerCode,
  );
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("response is not an object");
  return value;
}

function vendorCodeAt(payload: Record<string, unknown>): number | undefined {
  const value = payload.code;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function textAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function secondsToMilliseconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function normalizedSubtitle(
  value: unknown,
  durationMs: number | undefined,
): Record<string, unknown> | undefined {
  if (!durationMs || !isRecord(value) || !Array.isArray(value.sentences)) return undefined;
  const cues = value.sentences.flatMap((sentence) => {
    if (!isRecord(sentence)) return [];
    const words = Array.isArray(sentence.words) ? sentence.words : [];
    if (words.length > 0) {
      return words.flatMap((word) => timedCue(word, durationMs));
    }
    return timedCue(sentence, durationMs);
  });
  return cues.length > 0 ? { cues } : undefined;
}

function timedCue(
  value: unknown,
  durationMs: number,
): Array<{ text: string; start: number; end: number }> {
  if (!isRecord(value)) return [];
  const text = textAt(value, "text");
  const startMs = numberAt(value, "start_time");
  const endMs = numberAt(value, "end_time");
  if (!text
    || startMs === undefined
    || endMs === undefined
    || startMs < 0
    || endMs < startMs
    || endMs > durationMs + 1) return [];
  return [{
    text,
    start: Math.round(startMs) / 1_000,
    end: Math.round(endMs) / 1_000,
  }];
}

function contentTypeForFormat(format: string): string {
  if (format === "mp3") return "audio/mpeg";
  if (format === "wav") return "audio/wav";
  if (format === "pcm") return "audio/pcm";
  return "application/octet-stream";
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
