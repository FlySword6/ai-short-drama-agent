import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ProviderRequestError } from "../errors.js";
import type { GenerationProvider } from "../ports.js";
import type {
  GenerationParameters,
  ProviderGenerationRequest,
  ProviderMediaResult,
  ProviderResultSnapshot,
  ProviderSubmission,
} from "../types.js";

export type OpenAiCompatibleFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAiCompatibleImageProviderOptions {
  apiKey: string;
  baseUrl: string;
  approvedBaseUrlSha256: string;
  approvedModelIds: readonly string[];
  timeoutMs?: number;
  fetchImpl?: OpenAiCompatibleFetchLike;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_RESPONSE_BYTES = 96 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 64 * 1024 * 1024;
const POLICY_APPROVED_MODEL_IDS = new Set([
  "gpt-image-2",
  "gemini-3.1-pro-image",
]);
const SAFE_USAGE_KEYS = new Set([
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "generated_images",
]);

/**
 * Company-aggregator adapter for the OpenAI Images-compatible contract.
 * It is intentionally image-only and synchronous: unsupported modalities,
 * references, redirects, and unbounded provider bodies all fail before a
 * paid request can be mistaken for a known result.
 */
export class OpenAiCompatibleImageProvider implements GenerationProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: OpenAiCompatibleFetchLike;

  constructor(private readonly options: OpenAiCompatibleImageProviderOptions) {
    if (!isApprovedOpenAiCompatibleBaseUrl(
      options.baseUrl,
      options.approvedBaseUrlSha256,
    )) {
      throw new Error("OpenAI-compatible base URL is not approved");
    }
    if (
      options.approvedModelIds.length === 0
      || options.approvedModelIds.some((model) => !POLICY_APPROVED_MODEL_IDS.has(model))
      || new Set(options.approvedModelIds).size !== options.approvedModelIds.length
    ) {
      throw new Error("OpenAI-compatible model allowlist is not approved");
    }
    this.endpoint = imageGenerationEndpoint(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(
    request: ProviderGenerationRequest,
    callerSignal?: AbortSignal,
  ): Promise<ProviderSubmission> {
    assertImageRequest(request, this.options.approvedModelIds);
    const body = requestBody(request);
    const payload = await this.requestJson(body, callerSignal);
    const media = extractImageMedia(payload);
    if (media.length === 0) {
      throw providerUnknown("图片生成已返回，但没有可安全读取的图片结果");
    }
    return {
      outcome: "succeeded",
      result: {
        status: "succeeded",
        rawStatus: "succeeded",
        media,
        actualModelId: textAt(payload, "model") ?? request.model,
        parameterSnapshot: parameterSnapshot(body),
        usage: safeUsage(payload),
        metadata: {},
      },
    };
  }

  async query(
    _providerTaskId: string,
    _request?: Pick<ProviderGenerationRequest, "model" | "mediaKind">,
    _signal?: AbortSignal,
  ): Promise<ProviderResultSnapshot> {
    throw new ProviderRequestError(
      "当前图片接口同步返回结果，不支持按任务编号查询",
      "query",
      "query_failed",
      false,
      "PROVIDER_NOT_CONFIGURED",
    );
  }

  private async requestJson(
    body: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.options.apiKey.trim()) {
      throw providerRejected("当前公司聚合生成能力尚未配置，不会创建任务");
    }
    if (callerSignal?.aborted) {
      throw providerRejected("本次生成已取消，不会创建任务");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw providerUnknown("暂时无法确认图片生成是否已提交，请先刷新任务列表后再重试");
      }

      let payload: Record<string, unknown>;
      try {
        payload = await readJsonObject(response);
      } catch {
        if (!response.ok && response.status < 500 && response.status !== 408) {
          throw providerRejected(
            "图片生成请求未被服务接受，请检查提示词和所选档位后重试",
            response.status,
          );
        }
        throw providerUnknown(
          "暂时无法安全读取图片生成结果，请先刷新任务列表后再重试",
          response.status,
        );
      }
      if (!response.ok) {
        if (response.status < 500 && response.status !== 408) {
          throw providerRejected(
            "图片生成请求未被服务接受，请检查提示词和所选档位后重试",
            response.status,
          );
        }
        throw providerUnknown(
          "暂时无法确认图片生成是否已提交，请先刷新任务列表后再重试",
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

export function isApprovedOpenAiCompatibleBaseUrl(
  rawUrl: string,
  expectedSha256: string | undefined,
): boolean {
  const actual = openAiCompatibleBaseUrlSha256(rawUrl);
  return Boolean(
    actual
    && expectedSha256
    && /^[0-9a-f]{64}$/u.test(expectedSha256)
    && actual === expectedSha256,
  );
}

export function openAiCompatibleBaseUrlSha256(rawUrl: string): string | undefined {
  const identity = openAiCompatibleBaseUrlIdentity(rawUrl);
  return identity
    ? createHash("sha256").update(identity).digest("hex")
    : undefined;
}

function openAiCompatibleBaseUrlIdentity(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.hostname
  ) return undefined;
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || isIP(hostname) !== 0
  ) return undefined;
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (pathname !== "/" && !pathname.endsWith("/v1")) return undefined;
  return `https|${hostname}|${url.port || "443"}|${pathname}`;
}

function imageGenerationEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath.endsWith("/v1") ? basePath : `${basePath}/v1`}/images/generations`;
  return url.toString();
}

function assertImageRequest(
  request: ProviderGenerationRequest,
  approvedModelIds: readonly string[],
): void {
  if (request.mediaKind !== "image") {
    throw providerRejected("当前公司聚合适配器只支持图片生成");
  }
  if (!request.model.trim() || !request.prompt.trim()) {
    throw providerRejected("图片模型和提示词不能为空");
  }
  if (!approvedModelIds.includes(request.model.trim())) {
    throw providerRejected("当前图片模型不在公司网关审核清单内");
  }
  if (request.quantity !== 1) {
    throw providerRejected("一次人工点击只能创建一张图片");
  }
  if (request.references.length > 0) {
    throw providerRejected("当前公司聚合图片档尚未验证参考图，不会发起调用");
  }
}

function requestBody(request: ProviderGenerationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model.trim(),
    prompt: request.prompt,
    n: 1,
  };
  const size = normalizedSize(request.parameters);
  if (size) body.size = size;
  const quality = request.parameters.quality;
  if (quality !== undefined) {
    if (quality !== "low" && quality !== "medium" && quality !== "high") {
      throw providerRejected("当前图片质量档位无效");
    }
    body.quality = quality;
  }
  return body;
}

function normalizedSize(parameters: GenerationParameters): string | undefined {
  const value = parameters.size ?? parameters.resolution;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw providerRejected("当前图片尺寸无效");
  const normalized = value.trim();
  if (normalized === "1K") {
    const aspectRatio = parameters.aspectRatio ?? parameters.aspect_ratio ?? parameters.ratio;
    if (aspectRatio === undefined || aspectRatio === "1:1") return "1024x1024";
    if (aspectRatio === "16:9") return "1536x1024";
    if (aspectRatio === "9:16") return "1024x1536";
    throw providerRejected("当前图片比例无效");
  }
  if (!/^\d{2,5}x\d{2,5}$/u.test(normalized)) {
    throw providerRejected("当前图片尺寸必须是明确的宽x高像素值");
  }
  return normalized;
}

function parameterSnapshot(body: Record<string, unknown>): GenerationParameters {
  return {
    ...(typeof body.size === "string" ? { size: body.size } : {}),
    ...(typeof body.quality === "string" ? { quality: body.quality } : {}),
  };
}

function extractImageMedia(payload: Record<string, unknown>): ProviderMediaResult[] {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const first = data[0];
  if (!isRecord(first)) return [];
  const contentBase64 = textAt(first, "b64_json");
  if (contentBase64) {
    const contentType = validateInlineImage(contentBase64);
    return [{
      kind: "image",
      inlineContent: { contentBase64, contentType },
      providerResultKey: "data-0",
    }];
  }
  const temporaryUrl = textAt(first, "url");
  if (!temporaryUrl || !isSafeHttpsResultUrl(temporaryUrl)) return [];
  return [{
    kind: "image",
    temporaryUrl,
    providerResultKey: "data-0",
  }];
}

function validateInlineImage(contentBase64: string): string {
  if (
    contentBase64.length === 0
    || contentBase64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(contentBase64)
  ) {
    throw providerUnknown("图片生成返回了无法安全解析的内联图片");
  }
  const estimatedBytes = Math.floor(contentBase64.length * 3 / 4)
    - (contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_INLINE_IMAGE_BYTES) {
    throw providerUnknown("图片生成返回的内联图片超出安全上限");
  }
  const prefix = Buffer.from(contentBase64.slice(0, 32), "base64");
  if (prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    prefix.subarray(0, 4).toString("ascii") === "RIFF"
    && prefix.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  throw providerUnknown("图片生成返回了无法识别的图片格式");
}

function isSafeHttpsResultUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password;
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared !== undefined && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("response too large");
  }
  if (!response.body) throw new Error("response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const payload = JSON.parse(Buffer.concat(chunks, received).toString("utf8")) as unknown;
  if (!isRecord(payload)) throw new Error("response must be an object");
  return payload;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeUsage(payload: Record<string, unknown>): Record<string, number> {
  const usage = isRecord(payload.usage) ? payload.usage : {};
  return Object.fromEntries(Object.entries(usage).flatMap(([key, value]) => (
    SAFE_USAGE_KEYS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0
      ? [[key, value]]
      : []
  )));
}

function textAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerRejected(message: string, httpStatus?: number): ProviderRequestError {
  return new ProviderRequestError(
    message,
    "submit_image",
    "rejected",
    false,
    "INVALID_PROVIDER_INPUT",
    httpStatus,
  );
}

function providerUnknown(message: string, httpStatus?: number): ProviderRequestError {
  return new ProviderRequestError(
    message,
    "submit_image",
    "unknown",
    false,
    undefined,
    httpStatus,
  );
}
