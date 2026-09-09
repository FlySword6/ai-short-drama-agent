import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { settings } from "../../config/env.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import {
  AppError,
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
} from "../../shared/errors.js";

type FetchLike = typeof fetch;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_CONCURRENT_READS_PER_USER = 4;
const activeReadsByUser = new Map<string, number>();
const SAFE_IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/x-ms-bmp",
]);

export interface TosPublicProxyOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface TosImageQuery {
  url?: string;
}

/**
 * 同源读取只允许登录用户读取配置桶内的安全位图，不接受调用方传入任意 URL。
 * SVG/HTML 等主动内容永远不从本站 origin 返回，避免把存储桶提升成脚本托管源。
 */
export async function registerTosPublicProxyRoutes(
  app: FastifyInstance,
  options: TosPublicProxyOptions = {},
): Promise<void> {
  const baseUrl = options.baseUrl ?? settings.tosPublicBaseUrl;
  const fetchImpl = options.fetchImpl ?? fetch;

  app.route({
    method: ["GET", "HEAD"],
    url: "/api/v1/media/tos-images",
    handler: async (request, reply) => {
      const user = requireCurrentUser(request);
      if (!baseUrl) {
        throw new AppError(503, "media_proxy_unconfigured", "图片读取服务尚未配置，请联系管理员", true);
      }

      const sourceUrl = (request.query as TosImageQuery).url;
      const target = resolveTosPublicSourceUrl(baseUrl, sourceUrl);
      const releaseReadSlot = reserveReadSlot(user.id);
      try {
        let upstream: Response;
        try {
          upstream = await fetchImpl(target, {
            method: request.method,
            redirect: "manual",
            headers: forwardRangeHeaders(request),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          const publicError = new AppError(
            502,
            "media_read_unavailable",
            "图片暂时无法读取，请稍后重试",
            true,
          );
          publicError.cause = error;
          throw publicError;
        }

        if (upstream.status === 404) throw new NotFoundError("图片不存在或已被移除");
        if (upstream.status === 304) {
          copySafeMediaHeaders(upstream, reply);
          return reply.code(304).send();
        }
        if (upstream.status === 416) {
          copySafeMediaHeaders(upstream, reply);
          return reply.code(416).send();
        }
        if (upstream.status !== 200 && upstream.status !== 206) {
          throw new AppError(502, "media_read_unavailable", "图片暂时无法读取，请稍后重试", true);
        }

        assertSafeImageResponse(upstream);
        copySafeMediaHeaders(upstream, reply);
        reply.header("x-content-type-options", "nosniff");
        reply.header("content-security-policy", "default-src 'none'; sandbox");
        reply.header("cross-origin-resource-policy", "same-origin");
        reply.code(upstream.status);
        if (request.method === "HEAD" || !upstream.body) return reply.send();

        const bytes = await readBodyWithinLimit(upstream.body, MAX_IMAGE_BYTES);
        // Recompute after bounded reading instead of trusting a stale or
        // malicious upstream Content-Length header.
        reply.removeHeader("content-length");
        reply.header("content-length", String(bytes.byteLength));
        return reply.send(bytes);
      } finally {
        releaseReadSlot();
      }
    },
  });
}

export function resolveTosPublicSourceUrl(
  baseUrl: string,
  sourceUrl: string | undefined,
): URL {
  const normalizedBase = new URL(baseUrl);
  if (!["http:", "https:"].includes(normalizedBase.protocol)) {
    throw new Error("TOS_PUBLIC_BASE_URL must use http or https");
  }
  if (!sourceUrl?.trim()) {
    throw new BadRequestError("图片地址不正确，请重新选择");
  }
  let target: URL;
  try {
    target = new URL(sourceUrl);
  } catch {
    throw new BadRequestError("图片地址不正确，请重新选择");
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) {
    throw new BadRequestError("图片地址不正确，请重新选择");
  }

  const basePath = normalizedBase.pathname.endsWith("/")
    ? normalizedBase.pathname
    : `${normalizedBase.pathname}/`;
  if (target.origin !== normalizedBase.origin || !target.pathname.startsWith(basePath)) {
    throw new BadRequestError("图片地址不正确，请重新选择");
  }
  return target;
}

function reserveReadSlot(userId: string): () => void {
  const active = activeReadsByUser.get(userId) ?? 0;
  if (active >= MAX_CONCURRENT_READS_PER_USER) {
    throw new AppError(429, "media_read_busy", "正在读取的图片较多，请稍后再试", true);
  }
  activeReadsByUser.set(userId, active + 1);
  return () => {
    const remaining = (activeReadsByUser.get(userId) ?? 1) - 1;
    if (remaining <= 0) activeReadsByUser.delete(userId);
    else activeReadsByUser.set(userId, remaining);
  };
}

async function readBodyWithinLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("image exceeds proxy limit");
        throw new PayloadTooLargeError("图片超过 12 MB，暂时无法读取");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function forwardRangeHeaders(request: FastifyRequest): HeadersInit {
  const headers: Record<string, string> = {};
  copyRequestHeader(request, headers, "range");
  copyRequestHeader(request, headers, "if-range");
  copyRequestHeader(request, headers, "if-none-match");
  copyRequestHeader(request, headers, "if-modified-since");
  return headers;
}

function copyRequestHeader(
  request: FastifyRequest,
  target: Record<string, string>,
  name: "range" | "if-range" | "if-none-match" | "if-modified-since",
): void {
  const value = request.headers[name];
  if (typeof value === "string") target[name] = value;
}

function assertSafeImageResponse(upstream: Response): void {
  const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!SAFE_IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new AppError(415, "unsupported_media_type", "这不是可读取的图片，请重新选择图片");
  }
  const contentLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new PayloadTooLargeError("图片超过 12 MB，暂时无法读取");
  }
}

function copySafeMediaHeaders(upstream: Response, reply: FastifyReply): void {
  for (const name of [
    "content-type",
    "content-length",
    "cache-control",
    "etag",
    "last-modified",
    "accept-ranges",
    "content-range",
  ]) {
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }
}
