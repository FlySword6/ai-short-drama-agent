import { createRequire } from "node:module";
import { settings } from "../config/env.js";
import { ExternalServiceError } from "../shared/errors.js";

export interface StoredObject {
  bucket: string;
  storagePath: string;
  storageUrl: string;
}

export interface TosClientLike {
  putObject?(input: Record<string, unknown>): Promise<unknown>;
  deleteObject?(input: Record<string, unknown>): Promise<unknown>;
  headObject?(input: Record<string, unknown>): Promise<unknown>;
  getObjectV2?(input: Record<string, unknown>): Promise<unknown>;
  getPreSignedUrl?(input: Record<string, unknown>): Promise<unknown>;
}

interface TosModuleLike {
  TosClient?: new (options: Record<string, unknown>) => TosClientLike;
  Client?: new (options: Record<string, unknown>) => TosClientLike;
}

const require = createRequire(import.meta.url);

export class TosStorage {
  private client: TosClientLike | undefined;

  constructor(private readonly dependencies: TosStorageDependencies = {}) {}

  async uploadBytes(content: Buffer, storagePath: string, contentType: string): Promise<StoredObject> {
    const config = this.requireConfig();
    const bucket = config.bucket;

    const client = this.getClient();
    await this.call(client, "putObject", {
      bucket,
      key: storagePath,
      body: content,
      contentType,
    });

    const publicBaseUrl = settings.tosPublicBaseUrl?.replace(/\/$/, "");
    // This is canonical object metadata, not an access grant. Provider inputs
    // for private objects are minted by createDownloadUrl at their use site.
    const baseUrl = publicBaseUrl ?? objectUrlBase(bucket, config.endpoint);
    return {
      bucket,
      storagePath,
      storageUrl: `${baseUrl}/${storagePath.split("/").map(encodeURIComponent).join("/")}`,
    };
  }

  async deleteObject(storagePath: string): Promise<void> {
    const bucket = this.requireConfig().bucket;
    const key = storagePath.trim();
    if (!key) throw new ExternalServiceError("TOS", "Storage path is required");
    await this.call(this.getClient(), "deleteObject", { bucket, key });
  }

  async headObject(storagePath: string, bucket?: string): Promise<TosObjectHead> {
    const response = await this.call(this.getClient(), "headObject", { bucket: this.resolveBucket(bucket), key: this.requireStoragePath(storagePath) });
    const data = responseData(response);
    const contentLength = numberValue(data.contentLength ?? data["content-length"]);
    if (contentLength === undefined) throw new ExternalServiceError("TOS", "TOS HEAD response did not include content length");
    return {
      contentLength,
      contentType: stringValue(data.contentType ?? data["content-type"]) ?? null,
      etag: stringValue(data.etag ?? data.eTag) ?? null,
      lastModified: stringValue(data.lastModified ?? data["last-modified"]) ?? null,
    };
  }

  async readObjectBytes(storagePath: string, options: ReadObjectBytesOptions): Promise<Buffer> {
    const { maxBytes, process } = options;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ExternalServiceError("TOS", "Read limit must be a positive integer");
    const key = this.requireStoragePath(storagePath);
    const bucket = this.resolveBucket(options.bucket);
    const head = await this.headObject(key, bucket);
    if (!process && head.contentLength > maxBytes) {
      throw new ExternalServiceError("TOS", `Object exceeds the ${maxBytes} byte limit`);
    }
    const request: Record<string, unknown> = {
      bucket,
      key,
      dataType: "buffer",
      rangeStart: 0,
      rangeEnd: maxBytes - 1,
    };
    if (process?.trim()) request.process = process.trim();
    const response = await this.call(this.getClient(), "getObjectV2", request);
    const content = responseData(response).content;
    const buffer = toBuffer(content);
    if (!buffer || buffer.length > maxBytes) throw new ExternalServiceError("TOS", `Object exceeds the ${maxBytes} byte limit`);
    return buffer;
  }

  async createDownloadUrl(storagePath: string, options: CreateDownloadUrlOptions = {}): Promise<DownloadUrl> {
    const expiresSeconds = options.expiresSeconds ?? 300;
    if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > 900) {
      throw new ExternalServiceError("TOS", "Presigned GET expiry must be between 60 and at most 900 seconds");
    }
    const request: Record<string, unknown> = {
      bucket: this.resolveBucket(options.bucket),
      key: this.requireStoragePath(storagePath),
      method: "GET",
      expires: expiresSeconds,
    };
    if (options.fileName?.trim()) {
      request.response = { contentDisposition: contentDisposition(options.fileName.trim()) };
    }
    const url = await this.call(this.getClient(), "getPreSignedUrl", request);
    if (options.responseContentType?.trim()) {
      const response = (request.response ?? {}) as Record<string, unknown>;
      response.contentType = options.responseContentType.trim();
      request.response = response;
    }
    if (!isHttpsUrl(url)) throw new ExternalServiceError("TOS", "TOS SDK returned an invalid presigned URL");
    return { url, expiresAt: new Date(Date.now() + expiresSeconds * 1_000) };
  }

  private getClient(): TosClientLike {
    if (this.client) return this.client;
    if (this.dependencies.client) return this.dependencies.client;
    const config = this.requireConfig();
    let moduleValue: TosModuleLike;
    try {
      moduleValue = require("@volcengine/tos-sdk") as TosModuleLike;
    } catch {
      throw new ExternalServiceError("TOS", "@volcengine/tos-sdk is not available");
    }
    const Constructor = moduleValue.TosClient ?? moduleValue.Client;
    if (!Constructor) throw new ExternalServiceError("TOS", "TOS SDK client constructor is unavailable");
    try {
      this.client = new Constructor({
        accessKeyId: config.accessKey,
        accessKeySecret: config.secretKey,
        region: config.region,
        endpoint: normalizeTosSdkEndpoint(config.endpoint),
      });
    } catch (error) {
      throw sanitizedTosError(error);
    }
    return this.client;
  }

  private requireConfig(): ResolvedTosStorageConfig {
    const config = this.dependencies.config ?? {
      bucket: settings.tosBucket,
      endpoint: settings.tosEndpoint,
      accessKey: settings.tosAccessKey,
      secretKey: settings.tosSecretKey,
      region: settings.tosRegion,
    };
    const bucket = config.bucket;
    const endpoint = config.endpoint;
    const accessKey = config.accessKey;
    const secretKey = config.secretKey;
    if (!bucket || !endpoint || !accessKey || !secretKey) {
      throw new ExternalServiceError("TOS", "TOS bucket/endpoint/uploader credentials are required");
    }
    return {
      bucket,
      endpoint,
      accessKey,
      secretKey,
      region: config.region,
    };
  }

  private requireStoragePath(storagePath: string): string {
    const key = storagePath.trim();
    if (!key) throw new ExternalServiceError("TOS", "Storage path is required");
    return key;
  }

  private resolveBucket(bucket: string | undefined): string {
    const value = bucket?.trim() || this.requireConfig().bucket;
    if (!value) throw new ExternalServiceError("TOS", "TOS bucket is required");
    return value;
  }

  private async call(client: TosClientLike, method: keyof TosClientLike, input: Record<string, unknown>): Promise<unknown> {
    const operation = client[method];
    if (typeof operation !== "function") throw new ExternalServiceError("TOS", `TOS SDK ${method} is unavailable`);
    try {
      return await operation.call(client, input);
    } catch (error) {
      throw sanitizedTosError(error);
    }
  }
}

export interface TosObjectHead {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface ReadObjectBytesOptions {
  bucket?: string;
  maxBytes: number;
  process?: string;
}

export interface CreateDownloadUrlOptions {
  bucket?: string;
  expiresSeconds?: number;
  fileName?: string;
  responseContentType?: string;
  responseContentType?: string;
}

export interface DownloadUrl {
  url: string;
  expiresAt: Date;
}

export interface TosStorageConfig {
  bucket?: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  region: string;
}

interface ResolvedTosStorageConfig {
  bucket: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface TosStorageDependencies {
  client?: TosClientLike;
  config?: TosStorageConfig;
}

type TosFailureCategory = "access_denied" | "object_not_found" | "service_unavailable" | "request_failed";

interface SanitizedTosError extends ExternalServiceError {
  readonly category: TosFailureCategory;
}

function responseData(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object") return {};
  const record = response as Record<string, unknown>;
  return record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : record;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function contentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * TOS SDK errors can include object keys, endpoint host names, request IDs and
 * provider response bodies. Keep only a small operational category and retry
 * decision; the raw error must not leave this adapter.
 */
function sanitizedTosError(error: unknown): SanitizedTosError {
  const statusCode = tosStatusCode(error);
  const category: TosFailureCategory = statusCode === 403
    ? "access_denied"
    : statusCode === 404
      ? "object_not_found"
      : statusCode !== undefined && statusCode >= 500
        ? "service_unavailable"
        : "request_failed";
  const retryable = category === "service_unavailable" || category === "request_failed";
  const sanitized = new ExternalServiceError("TOS", "request failed");
  Object.defineProperties(sanitized, {
    category: { value: category, enumerable: false },
    retryable: { value: retryable, enumerable: true },
  });
  return sanitized as SanitizedTosError;
}

function tosStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const candidates = [
    record.statusCode,
    record.status,
    record.httpStatusCode,
    record.$metadata && typeof record.$metadata === "object" && (record.$metadata as Record<string, unknown>).httpStatusCode,
    record.response && typeof record.response === "object" && (record.response as Record<string, unknown>).statusCode,
  ];
  return candidates.find((value): value is number => typeof value === "number" && Number.isInteger(value));
}

/**
 * The previous TOS configuration accepts a full URL, while the Node SDK
 * expects a host name and adds the https scheme itself.
 */
export function normalizeTosSdkEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).host;
  } catch {
    return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
}

function objectUrlBase(bucket: string, endpoint: string): string {
  const host = normalizeTosSdkEndpoint(endpoint);
  return `https://${host === bucket || host.startsWith(`${bucket}.`) ? host : `${bucket}.${host}`}`;
}
