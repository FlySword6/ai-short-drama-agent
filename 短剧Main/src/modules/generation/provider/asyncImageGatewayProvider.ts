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

export type AsyncImageGatewayFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AsyncImageGatewayProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: AsyncImageGatewayFetchLike;
}

type AsyncImageModelId = "gpt-image-2-suchuang" | "nanobanana-2" | "nanobanana-lite";

interface AsyncImageModelDefinition {
  endpoint: string;
  sizes: ReadonlySet<string>;
  aspectRatios?: ReadonlySet<string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const QUERY_ENDPOINT = "/api/async/detail";
const GPT_IMAGE_SIZES = new Set([
  "auto", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4",
  "21:9", "9:21", "1:3", "3:1", "2:1", "1:2",
]);
const NANOBANANA_LITE_RATIOS = new Set([
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "21:9",
]);
const NANOBANANA_2_RATIOS = new Set([
  ...NANOBANANA_LITE_RATIOS,
  "1:4", "1:8", "4:1", "8:1",
]);

const MODEL_DEFINITIONS: Readonly<Record<AsyncImageModelId, AsyncImageModelDefinition>> = {
  "gpt-image-2-suchuang": {
    endpoint: "/api/async/image_gpt",
    sizes: GPT_IMAGE_SIZES,
  },
  "nanobanana-lite": {
    endpoint: "/api/async/image_nanoBanana2Lite",
    sizes: new Set(["1K"]),
    aspectRatios: NANOBANANA_LITE_RATIOS,
  },
  "nanobanana-2": {
    endpoint: "/api/async/image_nanoBanana2",
    sizes: new Set(["1K", "2K", "4K"]),
    aspectRatios: NANOBANANA_2_RATIOS,
  },
};

/**
 * Generic asynchronous image gateway. Product/model differences live in the
 * route definitions above; changing the company-owned gateway address never
 * changes business-layer request code.
 */
export class AsyncImageGatewayProvider implements GenerationProvider {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: AsyncImageGatewayFetchLike;

  constructor(private readonly options: AsyncImageGatewayProviderOptions) {
    const baseUrl = asyncImageGatewayBaseUrl(options.baseUrl);
    if (!baseUrl) throw new Error("Async image gateway base URL is not approved");
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(
    request: ProviderGenerationRequest,
    callerSignal?: AbortSignal,
  ): Promise<ProviderSubmission> {
    const model = requireModel(request);
    const body = requestBody(request, MODEL_DEFINITIONS[model]);
    const payload = await this.requestJson(
      "POST",
      MODEL_DEFINITIONS[model].endpoint,
      body,
      "submit",
      callerSignal,
    );
    if (numberAt(payload, "code") !== 200) {
      throw providerRejected("图片生成请求未被服务接受，请检查提示词和所选档位后重试");
    }
    const taskId = textAt(recordAt(payload, "data"), "id");
    if (!taskId) {
      throw providerUnknown("暂时无法确认图片生成是否已提交，请先刷新任务列表后再重试");
    }
    return {
      outcome: "accepted",
      providerTaskId: taskId,
      rawStatus: "0",
    };
  }

  async query(
    providerTaskId: string,
    request?: Pick<ProviderGenerationRequest, "model" | "mediaKind">,
    callerSignal?: AbortSignal,
  ): Promise<ProviderResultSnapshot> {
    if (!providerTaskId.trim() || request?.mediaKind !== "image") {
      throw providerQueryRejected("图片任务编号或模型信息无效");
    }
    const model = requireModelIdentity(request.model);
    const payload = await this.requestJson(
      "GET",
      QUERY_ENDPOINT,
      undefined,
      "query",
      callerSignal,
      { id: providerTaskId.trim() },
    );
    if (numberAt(payload, "code") !== 200) {
      throw providerQueryFailed("暂时无法查询图片生成结果，请稍后重试");
    }
    const data = recordAt(payload, "data");
    const rawStatus = numberAt(data, "status");
    if (rawStatus === undefined) {
      throw providerQueryFailed("图片生成状态暂时无法识别，请稍后重试");
    }
    if (rawStatus === 0 || rawStatus === 1) {
      return {
        status: rawStatus === 0 ? "pending" : "running",
        providerTaskId: providerTaskId.trim(),
        rawStatus: String(rawStatus),
        media: [],
        actualModelId: model,
      };
    }
    if (rawStatus === 2) {
      const media = resultMedia(data);
      if (media.length === 0) {
        throw providerQueryFailed("图片生成已完成，但没有可安全读取的图片结果");
      }
      return {
        status: "succeeded",
        providerTaskId: providerTaskId.trim(),
        rawStatus: String(rawStatus),
        media,
        usage: { generated_images: media.length },
        actualModelId: model,
      };
    }
    if (rawStatus === 3 || rawStatus === 4 || rawStatus === -1) {
      return {
        status: "failed",
        providerTaskId: providerTaskId.trim(),
        rawStatus: String(rawStatus),
        media: [],
        actualModelId: model,
        errorCode: "PROVIDER_TASK_FAILED",
        errorMessage: "图片生成失败，请调整提示词或参数后重试",
      };
    }
    return {
      status: "running",
      providerTaskId: providerTaskId.trim(),
      rawStatus: String(rawStatus),
      unknownStatus: true,
      media: [],
      actualModelId: model,
    };
  }

  private async requestJson(
    method: "GET" | "POST",
    pathname: string,
    body: Record<string, unknown> | undefined,
    operation: "submit" | "query",
    callerSignal?: AbortSignal,
    query?: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown>> {
    if (!this.options.apiKey.trim()) {
      throw operation === "submit"
        ? providerRejected("当前公司图片网关尚未配置，不会创建任务")
        : providerQueryRejected("当前公司图片网关尚未配置");
    }
    if (callerSignal?.aborted) {
      throw operation === "submit"
        ? providerRejected("本次生成已取消，不会创建任务")
        : providerQueryRejected("本次查询已取消");
    }
    const endpoint = gatewayEndpoint(this.baseUrl, pathname, query);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method,
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: this.options.apiKey,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch {
        throw operation === "submit"
          ? providerUnknown("暂时无法确认图片生成是否已提交，请先刷新任务列表后再重试")
          : providerQueryFailed("暂时无法查询图片生成结果，请稍后重试");
      }
      const payload = await readJsonObject(response).catch(() => undefined);
      if (!response.ok || !payload) {
        if (operation === "submit" && response.status < 500 && response.status !== 408) {
          throw providerRejected(
            "图片生成请求未被服务接受，请检查提示词和所选档位后重试",
            response.status,
          );
        }
        throw operation === "submit"
          ? providerUnknown(
              "暂时无法确认图片生成是否已提交，请先刷新任务列表后再重试",
              response.status,
            )
          : providerQueryFailed("暂时无法查询图片生成结果，请稍后重试", response.status);
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", abort);
    }
  }
}

export function isApprovedAsyncImageGatewayBaseUrl(rawUrl: string): boolean {
  return asyncImageGatewayBaseUrl(rawUrl) !== undefined;
}

function asyncImageGatewayBaseUrl(rawUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || isIP(hostname) !== 0
  ) return undefined;
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

function gatewayEndpoint(
  baseUrl: URL,
  pathname: string,
  query?: Readonly<Record<string, string>>,
): string {
  const endpoint = new URL(baseUrl.toString());
  const basePath = baseUrl.pathname.replace(/\/+$/u, "");
  const routePath = basePath.endsWith("/api") && pathname.startsWith("/api/")
    ? pathname.slice("/api".length)
    : pathname;
  endpoint.pathname = `${basePath}${routePath}`;
  for (const [key, value] of Object.entries(query ?? {})) {
    endpoint.searchParams.set(key, value);
  }
  return endpoint.toString();
}

function requireModel(request: ProviderGenerationRequest): AsyncImageModelId {
  if (request.mediaKind !== "image" || request.quantity !== 1 || !request.prompt.trim()) {
    throw providerRejected("当前网关只接受一次一张的图片生成请求");
  }
  return requireModelIdentity(request.model);
}

function requireModelIdentity(model: string): AsyncImageModelId {
  const normalized = model.trim();
  if (!(normalized in MODEL_DEFINITIONS)) {
    throw providerRejected("当前图片模型不在公司网关审核清单内");
  }
  return normalized as AsyncImageModelId;
}

function requestBody(
  request: ProviderGenerationRequest,
  definition: AsyncImageModelDefinition,
): Record<string, unknown> {
  const size = requiredEnum(request.parameters.size, definition.sizes, "图片尺寸");
  const urls = referenceUrls(request);
  if (!definition.aspectRatios) {
    assertAllowedParameterKeys(request.parameters, ["size"]);
    return {
      prompt: request.prompt,
      size,
      ...(urls.length > 0 ? { urls } : {}),
    };
  }
  assertAllowedParameterKeys(request.parameters, ["size", "aspectRatio"]);
  const aspectRatio = requiredEnum(
    request.parameters.aspectRatio,
    definition.aspectRatios,
    "图片比例",
  );
  return {
    prompt: request.prompt,
    size,
    aspectRatio,
    ...(urls.length > 0 ? { urls } : {}),
  };
}

function assertAllowedParameterKeys(
  parameters: GenerationParameters,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(parameters).find((key) => !allowed.has(key));
  if (unknown) throw providerRejected("当前图片档位包含网关不支持的参数");
}

function requiredEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): string {
  if (typeof value !== "string" || !allowed.has(value.trim())) {
    throw providerRejected(`${label}不在当前模型支持清单内`);
  }
  return value.trim();
}

function referenceUrls(request: ProviderGenerationRequest): string[] {
  const urls: string[] = [];
  for (const reference of request.references) {
    if (reference.kind !== "image" || !isSafeHttpsUrl(reference.url)) {
      throw providerRejected("当前图片网关只支持 HTTPS 图片参考");
    }
    urls.push(reference.url);
  }
  return urls;
}

function resultMedia(data: Record<string, unknown>): ProviderMediaResult[] {
  // Verified against one paid company-account response on 2026-08-07:
  // successful image URLs are returned as data.result: string[].
  // Do not accept undocumented look-alike fields; a supplier contract change
  // must fail visibly instead of silently persisting the wrong value.
  return [...new Set(stringArrayAt(data, "result"))].flatMap((temporaryUrl, index) => (
    isSafeHttpsUrl(temporaryUrl)
      ? [{
          kind: "image" as const,
          temporaryUrl,
          providerResultKey: `result-${index}`,
        }]
      : []
  ));
}

function isSafeHttpsUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("response too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("response too large");
  const payload = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!isRecord(payload)) throw new Error("response must be an object");
  return payload;
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function textAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) return Number(value);
  return undefined;
}

function stringArrayAt(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim())
    : [];
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
    true,
    "SUBMISSION_OUTCOME_UNKNOWN",
    httpStatus,
  );
}

function providerQueryRejected(message: string): ProviderRequestError {
  return new ProviderRequestError(
    message,
    "query",
    "query_failed",
    false,
    "INVALID_PROVIDER_INPUT",
  );
}

function providerQueryFailed(message: string, httpStatus?: number): ProviderRequestError {
  return new ProviderRequestError(
    message,
    "query",
    "query_failed",
    true,
    "PROVIDER_QUERY_FAILED",
    httpStatus,
  );
}
