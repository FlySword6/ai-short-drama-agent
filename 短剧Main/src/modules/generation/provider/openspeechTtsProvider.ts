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
  normalizeV01Parameters,
  normalizeV01References,
  assertAudioSource,
  V01GenerationContractError,
} from "../v01Contract.js";
import type { FetchLike } from "./arkGenerationProvider.js";

export interface OpenspeechTtsProviderOptions {
  /** 语音控制台 access token;鉴权头是 `Bearer;${token}`(分号),不是 Ark 的空格形式。 */
  token: string;
  /** 语音控制台 appid,与 access token 成对出现。 */
  appId: string;
  /** Verified full submit URL; absent is deliberately fail-closed, no default is guessed. */
  endpoint?: string;
  /** 控制台分配的 cluster;官方文档默认 volcano_tts。 */
  cluster?: string;
  /**
   * Exact, public DNS hosts approved for a non-default openspeech endpoint.
   * This is intentionally an exact-host list: wildcards, IP literals, and
   * loopback names are never accepted because this adapter sends the
   * credential with its request.
   */
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const OFFICIAL_OPENSPEECH_TTS_HOSTS = new Set(["openspeech.bytedance.com"]);
const DEFAULT_CLUSTER = "volcano_tts";
const DEFAULT_TIMEOUT_MS = 120_000;
/** 官方文档硬性上限:request.text 的 UTF-8 字节数(建议 300 字符以内)。 */
const MAX_TEXT_UTF8_BYTES = 1024;
/** 文档仅列出这三个采样率;其他取值不猜测、不放行。 */
const VERIFIED_SAMPLE_RATES = new Set([8000, 16000, 24000]);
/**
 * 供应商业务码归一(待 Fable 确认):HTTP 200 不代表成功,只有 code 3000 成功。
 * 明确的输入/权限类失败不重试;服务端/限流类按「提交结果未知但可重试」处理;
 * reqid 重复说明原请求可能已被受理,归为未知且不重试。未识别的码一律未知、不重试。
 */
const REJECTED_VENDOR_CODES = new Set([3001, 3010, 3011, 3050]);
const RETRYABLE_UNKNOWN_VENDOR_CODES = new Set([3003, 3005, 3030, 3031, 3032, 3040]);
const DUPLICATE_REQID_VENDOR_CODE = 3006;

const ENCODING_CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

/**
 * 火山 openspeech 语音合成(合同 v0.2.0 sound-workshop 第八节供应商事实)。
 * 同步接口:一次 POST 直接返回 base64 音频,没有查询端点,没有临时 URL。
 * 与 Ark 的鉴权格式不同:`Authorization: Bearer;${token}` 是分号,不能复用
 * 图片/视频路径的 `Bearer ${key}`。
 */
export class OpenspeechTtsProvider implements GenerationProvider {
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenspeechTtsProviderOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission> {
    if (request.mediaKind !== "audio") {
      throw new ProviderRequestError(
        "openspeech TTS provider only accepts audio requests; no provider request was sent",
        "submit_audio",
        "rejected",
        false,
        "PROVIDER_NOT_CONFIGURED",
      );
    }
    if (!request.model.trim() || !request.prompt.trim()) {
      throw new ProviderRequestError(
        "openspeech TTS model and prompt are required",
        "submit_audio",
        "rejected",
        false,
      );
    }
    const normalized = normalizeProviderContract(request);
    const endpoint = this.requireEndpoint();
    const token = this.options.token.trim();
    const appId = this.options.appId.trim();
    if (!token || !appId) {
      throw new ProviderRequestError(
        "openspeech TTS credential (appid/access token) is not configured; no provider request was sent",
        "submit_audio",
        "rejected",
        false,
        "PROVIDER_NOT_CONFIGURED",
      );
    }
    const parameters = this.requireSupportedParameters(normalized.parameters);
    if (normalized.references.length > 0) {
      // 复刻(参考音频克隆)不在一期范围;宁可拒绝也不静默丢弃参考输入。
      throw new ProviderRequestError(
        "The configured openspeech TTS endpoint has no verified voice-clone reference shape",
        "submit_audio",
        "rejected",
        false,
        "UNSUPPORTED_PROVIDER_INPUT",
      );
    }
    const text = request.prompt;
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_UTF8_BYTES) {
      throw new ProviderRequestError(
        `openspeech TTS text exceeds the verified ${MAX_TEXT_UTF8_BYTES} UTF-8 byte limit`,
        "submit_audio",
        "rejected",
        false,
        "INVALID_PROVIDER_INPUT",
      );
    }

    const reqid = randomUUID();
    const encoding = (parameters.format ?? "mp3") as string;
    const controls = structuredAudioControls(parameters, request.audioPromptDimensions);
    const body = {
      app: {
        appid: appId,
        // 文档说明该字段当前无鉴权作用但必须非空;不在这里重复喷洒真实 token。
        token: "placeholder",
        cluster: this.options.cluster?.trim() || DEFAULT_CLUSTER,
      },
      user: { uid: "shortdrama" },
      audio: {
        voice_type: parameters.speakerId,
        encoding,
        ...(parameters.sampleRate !== undefined ? { rate: parameters.sampleRate } : {}),
        ...(controls.speedRatio !== undefined ? { speed_ratio: controls.speedRatio } : {}),
        ...(controls.loudnessRatio !== undefined ? { loudness_ratio: controls.loudnessRatio } : {}),
        ...(controls.emotion ? { emotion: controls.emotion } : {}),
      },
      request: {
        reqid,
        text,
        operation: "query",
        with_timestamp: 1,
      },
    };
    const payload = await this.requestJson(endpoint, token, body, signal);
    const vendorCode = vendorCodeAt(payload);
    if (vendorCode !== 3000) {
      throw vendorFailure(vendorCode, payload);
    }
    const data = textAt(payload, "data");
    if (!data) {
      throw new ProviderRequestError(
        "openspeech TTS succeeded without audio data",
        "submit_audio",
        "unknown",
        false,
      );
    }
    const responseReqid = textAt(payload, "reqid") ?? reqid;
    const addition = isRecord(payload.addition) ? payload.addition : {};
    const rawDurationMs = numberAt(addition, "duration");
    const durationMs = rawDurationMs !== undefined && Number.isSafeInteger(rawDurationMs) && rawDurationMs > 0
      ? rawDurationMs
      : undefined;
    const subtitle = timedSubtitleFromFrontend(addition.frontend, durationMs);
    // The verified OpenSpeech response contract has no AIGC receipt field.
    // Request-side enable flags describe intent only, so this adapter leaves
    // compliance metadata absent until Fable/DC provide a verified evidence
    // mechanism. The service will then fail closed before TOS persistence.
    const media: ProviderMediaResult = {
      kind: "audio",
      inlineContent: {
        contentBase64: data,
        contentType: ENCODING_CONTENT_TYPES[encoding] ?? "application/octet-stream",
      },
      providerResultKey: responseReqid,
      // 供应商返回的是毫秒字符串;诚实换算,不凑整、不冒充冻结时长。
      ...(durationMs !== undefined
        ? { durationSeconds: durationMs / 1000, actualDurationMs: durationMs }
        : {}),
      ...(subtitle !== undefined ? { subtitle } : {}),
    };
    return {
      outcome: "succeeded",
      providerTaskId: responseReqid,
      result: {
        status: "succeeded",
        providerTaskId: responseReqid,
        rawStatus: "succeeded",
        media: [media],
        actualModelId: request.model,
        parameterSnapshot: normalized.parameters,
        usage: compactNumberRecord({ duration_ms: durationMs }),
        metadata: compactRecord({
          reqid: responseReqid,
          durationMs,
          ...(controls.mappedAudioDimensions.length > 0
            ? { mappedAudioDimensions: controls.mappedAudioDimensions }
            : {}),
          ...(controls.unmappedAudioDimensions.length > 0
            ? { unmappedAudioDimensions: controls.unmappedAudioDimensions }
            : {}),
        }),
      },
    };
  }

  async query(): Promise<ProviderResultSnapshot> {
    // 同步接口:成功响应在 submit 里已经返回,没有可供轮询的供应商任务。
    throw new ProviderRequestError(
      "openspeech TTS is synchronous; there is no query endpoint",
      "query_audio",
      "query_failed",
      false,
      "PROVIDER_NOT_CONFIGURED",
    );
  }

  private requireEndpoint(): string {
    const endpoint = this.options.endpoint?.trim();
    if (!endpoint) {
      throw new ProviderRequestError(
        "openspeech TTS endpoint is not configured; no provider request was sent",
        "submit_audio",
        "rejected",
        false,
        "PROVIDER_NOT_CONFIGURED",
      );
    }
    if (!isApprovedOpenspeechTtsUrl(endpoint, this.options.allowedHosts)) {
      throw new ProviderRequestError(
        "openspeech TTS endpoint host is not approved; no provider request was sent",
        "submit_audio",
        "rejected",
        false,
        "PROVIDER_ENDPOINT_NOT_ALLOWED",
      );
    }
    return endpoint.replace(/\/+$/, "");
  }

  /**
   * V0.1 的语速/音量滑杆可线性映射到已核验的 provider ratio 字段;
   * 音高没有供应商字段，仍必须在 fetch 前拒绝，不能悄悄丢弃。
   */
  private requireSupportedParameters(parameters: GenerationParameters): GenerationParameters {
    if (parameters.pitchRate !== undefined) {
      throw new ProviderRequestError(
        "openspeech TTS pitch control is unsupported by the verified provider contract",
        "submit_audio",
        "rejected",
        false,
        "UNSUPPORTED_PROVIDER_INPUT",
      );
    }
    if (parameters.sampleRate !== undefined && !VERIFIED_SAMPLE_RATES.has(parameters.sampleRate)) {
      throw new ProviderRequestError(
        "openspeech TTS sample rate is not in the verified 8000/16000/24000 set",
        "submit_audio",
        "rejected",
        false,
        "UNSUPPORTED_PROVIDER_INPUT",
      );
    }
    return parameters;
  }

  private async requestJson(
    endpoint: string,
    token: string,
    body: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (callerSignal?.aborted) {
      throw new ProviderRequestError(
        "openspeech TTS request was cancelled before submission",
        "submit_audio",
        "rejected",
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
        response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            // 供应商事实:鉴权头是 `Bearer;${token}`(分号)。与 Ark 图片/视频
            // 路径的 `Bearer ${key}`(空格)是两种格式,两边都有测试锁。
            Authorization: `Bearer;${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new ProviderRequestError(
          "openspeech TTS submission outcome is unknown",
          "submit_audio",
          "unknown",
          true,
        );
      }

      let payload: Record<string, unknown>;
      try {
        payload = await readJsonObject(response);
      } catch {
        throw new ProviderRequestError(
          "openspeech TTS submission outcome is unknown",
          "submit_audio",
          "unknown",
          true,
        );
      }
      if (!response.ok) {
        const vendorCode = vendorCodeAt(payload);
        const message = vendorMessage(payload) ?? `openspeech HTTP ${response.status}`;
        if (response.status >= 500 || response.status === 408) {
          throw new ProviderRequestError(
            message,
            "submit_audio",
            "unknown",
            true,
            vendorCode !== undefined ? openspeechProviderCode(vendorCode) : undefined,
            response.status,
          );
        }
        throw new ProviderRequestError(
          message,
          "submit_audio",
          "rejected",
          response.status === 429,
          vendorCode !== undefined ? openspeechProviderCode(vendorCode) : undefined,
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

function vendorFailure(vendorCode: number | undefined, payload: Record<string, unknown>): ProviderRequestError {
  const message = vendorMessage(payload)
    ?? `openspeech TTS returned ${vendorCode === undefined ? "an unparseable result code" : `code ${vendorCode}`}`;
  if (vendorCode !== undefined && REJECTED_VENDOR_CODES.has(vendorCode)) {
    return new ProviderRequestError(
      message,
      "submit_audio",
      "rejected",
      false,
      openspeechProviderCode(vendorCode),
      200,
    );
  }
  if (vendorCode !== undefined && RETRYABLE_UNKNOWN_VENDOR_CODES.has(vendorCode)) {
    return new ProviderRequestError(
      message,
      "submit_audio",
      "unknown",
      true,
      openspeechProviderCode(vendorCode),
      200,
    );
  }
  if (vendorCode === DUPLICATE_REQID_VENDOR_CODE) {
    // reqid 已存在 = 原请求可能已被受理;按未知处理,但相同 reqid 重试注定失败。
    return new ProviderRequestError(
      message,
      "submit_audio",
      "unknown",
      false,
      openspeechProviderCode(vendorCode),
      200,
    );
  }
  return new ProviderRequestError(
    message,
    "submit_audio",
    "unknown",
    false,
    vendorCode !== undefined ? openspeechProviderCode(vendorCode) : undefined,
    200,
  );
}

function openspeechProviderCode(vendorCode: number): string {
  return `OPENSPEECH_${vendorCode}`;
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
      throw new ProviderRequestError(error.message, "submit_audio", "rejected", false);
    }
    throw error;
  }
}

/** Shared with the factory so a bad TTS host cannot create a quote first. */
export function isApprovedOpenspeechTtsUrl(value: string, configuredAllowedHosts?: readonly string[]): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return OFFICIAL_OPENSPEECH_TTS_HOSTS.has(host) || approvedConfiguredHosts(configuredAllowedHosts).has(host);
  } catch {
    return false;
  }
}

function approvedConfiguredHosts(configuredAllowedHosts: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((configuredAllowedHosts ?? [])
    .map((host) => host.trim().toLowerCase())
    .filter(isPublicDnsHost));
}

function isPublicDnsHost(host: string): boolean {
  // Exact DNS names only. This rules out localhost, IPv4/IPv6 literals,
  // wildcard suffixes, and ambiguous dotless names before fetch receives the
  // credential-bearing request. (The URL parser normalizes obfuscated IPv4
  // forms such as `0x7f.1` to dotted-quad, so one dotted-quad check suffices.)
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host);
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

function vendorCodeAt(payload: Record<string, unknown>): number | undefined {
  const code = payload.code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "string" && code.trim() && Number.isFinite(Number(code))) return Number(code);
  return undefined;
}

function vendorMessage(payload: Record<string, unknown>): string | undefined {
  return textAt(payload, "message") ?? textAt(payload, "Message") ?? undefined;
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

function compactNumberRecord(record: Record<string, number | undefined>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

/**
 * The product sliders use -50…100. Mapping `1 + value / 100` lands exactly
 * in the provider's documented ranges: speed 0.5…2 and loudness 0.5…2.
 * The free-text director dimensions stay out of spoken text. The documented
 * `emotion` field receives `performanceEmotion` verbatim; its value enum is
 * not verified, so the result snapshot records that as a requested mapping.
 * Every other non-empty direction is recorded as unmapped rather than silently
 * claimed as applied.
 */
interface StructuredAudioControls {
  speedRatio?: number;
  loudnessRatio?: number;
  emotion?: string;
  /** Dimension names sent to a documented provider field, not a claim of output quality. */
  mappedAudioDimensions: string[];
  /** Non-empty directions that are deliberately not sent until a field mapping is verified. */
  unmappedAudioDimensions: string[];
}

function structuredAudioControls(
  parameters: GenerationParameters,
  dimensions: ProviderGenerationRequest["audioPromptDimensions"],
): StructuredAudioControls {
  const emotion = typeof dimensions?.performanceEmotion === "string"
    ? dimensions.performanceEmotion.trim()
    : "";
  const unmappedAudioDimensions = dimensions
    ? ([
      "voiceReference",
      "paceAndPauses",
      "languageAndAccent",
      "vocalDistance",
      "continuity",
    ] as const).filter((key) => dimensions[key].trim().length > 0)
    : [];
  return {
    ...(parameters.speechRate !== undefined ? { speedRatio: ratioFromSlider(parameters.speechRate) } : {}),
    ...(parameters.loudnessRate !== undefined ? { loudnessRatio: ratioFromSlider(parameters.loudnessRate) } : {}),
    ...(emotion ? { emotion } : {}),
    mappedAudioDimensions: emotion ? ["performanceEmotion->emotion"] : [],
    unmappedAudioDimensions,
  };
}

function ratioFromSlider(value: number): number {
  return Math.round((1 + value / 100) * 1_000) / 1_000;
}

/** Convert OpenSpeech `addition.frontend` into provider-neutral timed cues. */
function timedSubtitleFromFrontend(value: unknown, durationMs: number | undefined): Record<string, unknown> | undefined {
  if (!durationMs) return undefined;
  const parsed = parseJsonValue(value);
  const cues = collectTimedCues(parsed, durationMs);
  return cues.length > 0 ? { cues } : undefined;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function collectTimedCues(value: unknown, durationMs: number, depth = 0): Array<{ text: string; start: number; end: number }> {
  if (depth > 8 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectTimedCues(item, durationMs, depth + 1));
  if (!isRecord(value)) return [];

  const text = cueText(value);
  const start = timestampAt(value, ["start", "start_time", "startTime", "begin", "begin_time"]);
  const end = timestampAt(value, ["end", "end_time", "endTime", "finish", "finish_time"]);
  const cue = text && start !== undefined && end !== undefined
    ? normalizeTimedCue(text, start, end, durationMs)
    : undefined;
  return [
    ...(cue ? [cue] : []),
    ...Object.values(value).flatMap((item) => collectTimedCues(item, durationMs, depth + 1)),
  ];
}

function cueText(record: Record<string, unknown>): string | undefined {
  for (const key of ["text", "word", "content", "character", "char"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function timestampAt(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = numberAt(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeTimedCue(
  text: string,
  start: number,
  end: number,
  durationMs: number,
): { text: string; start: number; end: number } | undefined {
  const durationSeconds = durationMs / 1_000;
  const valuesAreMilliseconds = Math.max(Math.abs(start), Math.abs(end)) > durationSeconds + 0.0001;
  const normalizedStart = valuesAreMilliseconds ? start / 1_000 : start;
  const normalizedEnd = valuesAreMilliseconds ? end / 1_000 : end;
  if (!Number.isFinite(normalizedStart)
    || !Number.isFinite(normalizedEnd)
    || normalizedStart < 0
    || normalizedEnd < normalizedStart
    || normalizedEnd > durationSeconds + 0.001) return undefined;
  return {
    text,
    start: Math.round(normalizedStart * 1_000) / 1_000,
    end: Math.round(normalizedEnd * 1_000) / 1_000,
  };
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
