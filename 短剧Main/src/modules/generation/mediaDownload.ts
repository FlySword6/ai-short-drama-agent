import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import type { DownloadedMedia } from "./ports.js";
import type { FetchLike } from "./provider/arkGenerationProvider.js";

export interface MediaHostAddress {
  address: string;
  family: 4 | 6;
}

export type MediaHostLookup = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly MediaHostAddress[]>;
export type PinnedMediaRequest = (
  url: URL,
  target: MediaHostAddress,
  signal: AbortSignal,
) => Promise<IncomingMessage>;

export interface DownloadMediaOptions {
  /**
   * Trusted test transport only. Production downloads use a DNS-pinned HTTPS
   * request below so the address checked for SSRF is the address connected to.
   */
  fetchImpl?: FetchLike;
  lookupImpl?: MediaHostLookup;
  /** Trusted test seam; production defaults to the DNS-pinned HTTPS request. */
  requestImpl?: PinnedMediaRequest;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_PINNED_ADDRESS_ATTEMPTS = 8;
const HAPPY_EYEBALLS_MAX_DELAY_MS = 250;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/**
 * Hard-coded because this list is a security boundary, not a preference: a
 * mis-set environment variable must not be able to widen it at runtime.
 * The cost is that moving buckets or regions needs a code change — the
 * follow-up is to derive it from the resolved storage configuration so the
 * host can never drift away from where uploads actually land.
 */
const TLS_PINNED_PROVIDER_MEDIA_HOSTS = new Set([
  "ark-acg-cn-beijing.tos-cn-beijing.volces.com",
  "algeng-video-infer.oss-cn-shanghai.aliyuncs.com",
  // HappyHorse(阿里云百炼)成片结果域:video_url 24h 有效,persist 工人立即下载转存。
  "dashscope-result.oss-cn-beijing.aliyuncs.com",
  // Our own finished assets. Playback and delivery read these back from the
  // server, so leaving it out blocked the platform from serving its own media.
  "drama-asset.tos-cn-beijing.volces.com",
]);

export async function downloadMediaBytes(
  rawUrl: string,
  options: DownloadMediaOptions = {},
): Promise<DownloadedMedia> {
  const url = parseSafeHttpsUrl(rawUrl);
  if (options.signal?.aborted) throw new Error("Media download was cancelled");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be positive");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("timeoutMs must be a positive supported integer");
  }

  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const lookupImpl = options.lookupImpl ?? defaultMediaHostLookup;
    return options.fetchImpl
      ? await downloadWithTrustedFetch(url, options.fetchImpl, lookupImpl, maxBytes, controller.signal)
      : await downloadWithPinnedHttps(
          url,
          lookupImpl,
          options.requestImpl ?? requestPinnedHttps,
          maxBytes,
          controller.signal,
          deadlineAt,
        );
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function downloadWithTrustedFetch(
  initialUrl: URL,
  fetchImpl: FetchLike,
  lookupImpl: MediaHostLookup,
  maxBytes: number,
  signal: AbortSignal,
): Promise<DownloadedMedia> {
  let url = initialUrl;
  const visited = new Set<string>();

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    assertNotVisited(visited, url);
    await resolvePublicTargets(url, lookupImpl, signal);
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal,
    });
    if (response.redirected || (response.url && parseSafeHttpsUrl(response.url).toString() !== url.toString())) {
      await cancelResponseBody(response);
      throw new Error("Media transport followed an unexpected redirect");
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await cancelResponseBody(response);
      if (!location) throw new Error("Media redirect is missing a location");
      if (redirectCount >= MAX_REDIRECTS) throw new Error("Media download exceeded the redirect limit");
      url = parseRedirectUrl(location, url);
      continue;
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`Media download failed with HTTP ${response.status}`);
    }

    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > maxBytes) {
      await cancelResponseBody(response);
      throw new Error(`Media download exceeds the ${maxBytes} byte limit`);
    }

    const content = await readLimitedBody(response, maxBytes);
    return downloadedMedia(
      content,
      normalizeContentType(response.headers.get("content-type"), url.toString()),
      url.toString(),
    );
  }
  throw new Error("Media download exceeded the redirect limit");
}

async function downloadWithPinnedHttps(
  initialUrl: URL,
  lookupImpl: MediaHostLookup,
  requestImpl: PinnedMediaRequest,
  maxBytes: number,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<DownloadedMedia> {
  let url = initialUrl;
  const visited = new Set<string>();

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    assertNotVisited(visited, url);
    const targets = await resolvePublicTargets(url, lookupImpl, signal);
    const response = await requestPinnedHttpsWithFallback(
      url,
      targets,
      requestImpl,
      signal,
      deadlineAt,
    );
    const status = response.statusCode ?? 0;

    if (REDIRECT_STATUSES.has(status)) {
      const location = firstHeaderValue(response.headers.location);
      response.destroy();
      if (!location) throw new Error("Media redirect is missing a location");
      if (redirectCount >= MAX_REDIRECTS) throw new Error("Media download exceeded the redirect limit");
      url = parseRedirectUrl(location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`Media download failed with HTTP ${status}`);
    }

    const declaredLength = parseContentLength(firstHeaderValue(response.headers["content-length"]));
    if (declaredLength !== null && declaredLength > maxBytes) {
      response.destroy();
      throw new Error(`Media download exceeds the ${maxBytes} byte limit`);
    }

    const content = await readLimitedIncomingBody(response, maxBytes);
    return downloadedMedia(
      content,
      normalizeContentType(firstHeaderValue(response.headers["content-type"]), url.toString()),
      url.toString(),
    );
  }
  throw new Error("Media download exceeded the redirect limit");
}

function requestPinnedHttps(
  url: URL,
  target: MediaHostAddress,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(buildPinnedHttpsRequestOptions(url, target, signal), resolve);
    request.once("error", reject);
    request.end();
  });
}

/**
 * Pure request-options projection kept public for a no-network regression
 * test. The socket hostname is the validated address; Host/SNI retain the
 * original provider domain for HTTP routing and certificate verification.
 */
export function buildPinnedHttpsRequestOptions(
  url: URL,
  target: MediaHostAddress,
  signal: AbortSignal,
): HttpsRequestOptions {
  const originalHostname = normalizedHostname(url);
  return {
    protocol: "https:",
    hostname: target.address,
    family: target.family,
    port: url.port ? Number(url.port) : 443,
    method: "GET",
    path: `${url.pathname}${url.search}`,
    headers: {
      accept: "image/*, video/*, audio/*, application/octet-stream",
      "accept-encoding": "identity",
      host: url.host,
    },
    // Connecting to the validated address prevents a second DNS lookup. SNI
    // and certificate verification still use the provider's original host.
    servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
    agent: false,
    signal,
  };
}

async function requestPinnedHttpsWithFallback(
  url: URL,
  targets: readonly MediaHostAddress[],
  requestImpl: PinnedMediaRequest,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<IncomingMessage> {
  const candidates = pinnedAddressCandidates(targets);
  if (candidates.length === 0) throw new Error("Media host connection failed");
  if (signal.aborted) throw new Error("Media download was cancelled");

  return new Promise<IncomingMessage>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let nextIndex = 0;
    let failures = 0;
    let settled = false;
    let nextTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      signal.removeEventListener("abort", onParentAbort);
      if (nextTimer) clearTimeout(nextTimer);
      nextTimer = undefined;
    };
    const abortAttempts = () => {
      for (const controller of controllers) controller.abort();
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      abortAttempts();
      reject(error);
    };
    const onParentAbort = () => rejectOnce(new Error("Media download was cancelled"));
    const resolveOnce = (response: IncomingMessage, winner: AbortController) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      cleanup();
      for (const controller of controllers) {
        if (controller !== winner) controller.abort();
      }
      resolve(response);
    };
    const scheduleNext = () => {
      if (settled || nextTimer || nextIndex >= candidates.length) return;
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      const remainingCandidates = candidates.length - nextIndex;
      const delayMs = Math.min(
        HAPPY_EYEBALLS_MAX_DELAY_MS,
        Math.max(1, Math.floor(remainingMs / (remainingCandidates + 1))),
      );
      nextTimer = setTimeout(() => {
        nextTimer = undefined;
        launchNext();
      }, delayMs);
    };
    const launchNext = () => {
      if (settled) return;
      const target = candidates[nextIndex];
      if (!target) {
        if (failures === controllers.length) {
          rejectOnce(new Error("Media host connection failed"));
        }
        return;
      }
      nextIndex += 1;
      const controller = new AbortController();
      controllers.push(controller);
      const attemptSignal = AbortSignal.any([signal, controller.signal]);
      Promise.resolve().then(() => requestImpl(url, target, attemptSignal)).then(
        (response) => resolveOnce(response, controller),
        () => {
          failures += 1;
          if (settled) return;
          if (signal.aborted) {
            rejectOnce(new Error("Media download was cancelled"));
            return;
          }
          if (nextTimer) {
            clearTimeout(nextTimer);
            nextTimer = undefined;
          }
          if (nextIndex < candidates.length) {
            launchNext();
          } else if (failures === controllers.length) {
            rejectOnce(new Error("Media host connection failed"));
          }
        },
      );
      scheduleNext();
    };

    signal.addEventListener("abort", onParentAbort, { once: true });
    launchNext();
  });
}

function pinnedAddressCandidates(
  targets: readonly MediaHostAddress[],
): MediaHostAddress[] {
  const selected: MediaHostAddress[] = [];
  const seen = new Set<string>();
  const add = (target: MediaHostAddress | undefined) => {
    if (!target || selected.length >= MAX_PINNED_ADDRESS_ATTEMPTS) return;
    const key = `${target.family}:${target.address}`;
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(target);
  };
  const first = targets[0];
  add(first);
  // DNS APIs often group every AAAA record before every A record. Reserve the
  // second slot for the other family so the safety cap cannot remove the very
  // fallback Happy Eyeballs is meant to provide.
  add(targets.find((target) => target.family !== first?.family));
  for (const target of targets) add(target);
  return selected;
}

async function resolvePublicTargets(
  url: URL,
  lookupImpl: MediaHostLookup,
  signal: AbortSignal,
): Promise<readonly MediaHostAddress[]> {
  if (signal.aborted) throw new Error("Media download was cancelled");
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  let addresses: readonly MediaHostAddress[];
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await awaitWithAbort(lookupImpl(hostname, signal), signal);
    } catch {
      if (signal.aborted) throw new Error("Media download was cancelled");
      throw new Error("Media host could not be resolved");
    }
  }
  if (signal.aborted) throw new Error("Media download was cancelled");
  if (addresses.length === 0) throw new Error("Media host could not be resolved");
  if (addresses.some(({ address, family }) => isIP(address) !== family)) {
    throw new Error("Media URL must not target a private or reserved host");
  }
  if (addresses.some(({ address }) => isNonPublicIpAddress(address))
    && !addresses.every(({ address }) => (
      !isNonPublicIpAddress(address)
      || isApprovedProviderFakeIp(hostname, address)
    ))) {
    throw new Error("Media URL must not target a private or reserved host");
  }
  return [...addresses];
}

/**
 * Some controlled developer networks map public HTTPS hosts into RFC 2544's
 * 198.18.0.0/15 benchmark range before a local proxy forwards the socket.
 * Permit only that fake-IP shape for explicitly reviewed provider media
 * domains. The production request still pins the checked address and verifies
 * the provider hostname through SNI/certificate validation.
 */
function isApprovedProviderFakeIp(hostname: string, address: string): boolean {
  if (!TLS_PINNED_PROVIDER_MEDIA_HOSTS.has(hostname)) return false;
  const octets = parseIpv4Octets(address);
  return Boolean(octets && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
}

async function defaultMediaHostLookup(
  hostname: string,
  _signal?: AbortSignal,
): Promise<readonly MediaHostAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap(({ address, family }) => (
    family === 4 || family === 6 ? [{ address, family }] : []
  ));
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Media download was cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new Error("Media download was cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function downloadedMedia(content: Buffer, contentType: string, url: string): DownloadedMedia {
  return {
    content,
    contentType,
    byteLength: content.byteLength,
    extension: extensionForContentType(contentType, url),
  };
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("media size limit exceeded");
        throw new Error(`Media download exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readLimitedIncomingBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new Error(`Media download exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function parseSafeHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Media URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("Media URL must use HTTPS");
  if (url.username || url.password) throw new Error("Media URL must not contain credentials");
  if (url.port && Number(url.port) !== 443) throw new Error("Media URL must use the standard HTTPS port");
  const hostname = normalizedHostname(url);
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || (isIP(hostname) !== 0 && isNonPublicIpAddress(hostname))
  ) {
    throw new Error("Media URL must not target a private host");
  }
  url.hash = "";
  return url;
}

function parseRedirectUrl(location: string, currentUrl: URL): URL {
  let nextUrl: URL;
  try {
    nextUrl = new URL(location, currentUrl);
  } catch {
    throw new Error("Media redirect location is invalid");
  }
  return parseSafeHttpsUrl(nextUrl.toString());
}

function assertNotVisited(visited: Set<string>, url: URL): void {
  const value = url.toString();
  if (visited.has(value)) throw new Error("Media download encountered a redirect loop");
  visited.add(value);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best effort.
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isNonPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isNonPublicIpv4(address);
  if (family === 6) return isNonPublicIpv6(address);
  return true;
}

function isNonPublicIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) return true;
  const [first = 0, second = 0] = octets;
  return first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 2)
    || (first === 192 && second === 88 && octets[2] === 99)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113)
    || first === 0
    || first >= 224;
}

function parseIpv4Octets(address: string): number[] | null {
  const octets = address.split(".").map(Number);
  return octets.length === 4
    && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function isNonPublicIpv6(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (!bytes) return true;

  const isIpv4Mapped = bytes.slice(0, 10).every((value) => value === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
  if (isIpv4Mapped) {
    return isNonPublicIpv4(bytes.slice(12).join("."));
  }

  // Public provider endpoints should resolve to global unicast space. This
  // conservative allow rule excludes loopback, ULA, link-local, multicast,
  // NAT64 and other special-use prefixes.
  if ((bytes[0]! & 0xe0) !== 0x20) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01) {
    if (bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
    if (bytes[2] === 0x00 && bytes[3] === 0x02 && bytes[4] === 0x00 && bytes[5] === 0x00) return true;
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
    if (bytes[2] === 0x00 && ((bytes[3]! & 0xf0) === 0x10 || (bytes[3]! & 0xf0) === 0x20)) return true;
  }
  return (bytes[0] === 0x20 && bytes[1] === 0x02) // 6to4
    || (
      bytes[0] === 0x3f
      && bytes[1] === 0xff
      && (bytes[2]! & 0xf0) === 0x00
    ); // IANA documentation 3fff::/20
}

function parseIpv6Bytes(address: string): number[] | null {
  if (address.includes("%")) return null;
  let normalized = address.toLowerCase();
  const embeddedIpv4Index = normalized.lastIndexOf(":");
  if (normalized.includes(".") && embeddedIpv4Index >= 0) {
    const ipv4 = parseIpv4Octets(normalized.slice(embeddedIpv4Index + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    normalized = `${normalized.slice(0, embeddedIpv4Index)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  if (words.length !== 8) return null;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeContentType(value: string | null, url: string): string {
  const header = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (header?.startsWith("image/") || header?.startsWith("video/") || header?.startsWith("audio/")) return header;
  if (header && header !== "application/octet-stream") {
    throw new Error(`Unsupported media content type: ${header}`);
  }
  return inferContentTypeFromUrl(url) ?? "application/octet-stream";
}

function inferContentTypeFromUrl(url: string): string | undefined {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".mov")) return "video/quicktime";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".m4a")) return "audio/mp4";
  if (path.endsWith(".aac")) return "audio/aac";
  if (path.endsWith(".ogg")) return "audio/ogg";
  return undefined;
}

function extensionForContentType(contentType: string, url?: string): string {
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/pcm": "pcm",
  };
  return extensions[contentType]
    ?? (url ? new URL(url).pathname.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() : undefined)
    ?? "bin";
}

/**
 * Converts provider-supplied inline base64 media into the same shape a
 * download would produce, so persistence treats both paths uniformly.
 */
export function inlineDownloadedMedia(
  input: { contentBase64: string; contentType: string },
  options: { maxBytes?: number } = {},
): DownloadedMedia {
  const contentType = input.contentType.trim().toLowerCase();
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/") && !contentType.startsWith("audio/")) {
    throw new Error(`Unsupported media content type: ${contentType}`);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be positive");
  const encoded = input.contentBase64.trim();
  if (!encoded) throw new Error("Inline media content is empty");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Inline media content is not canonical base64");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const estimatedBytes = (encoded.length / 4) * 3 - padding;
  if (estimatedBytes > maxBytes) {
    throw new Error(`Inline media exceeds the ${maxBytes} byte limit`);
  }
  const content = Buffer.from(encoded, "base64");
  if (content.byteLength === 0) {
    throw new Error("Inline media content is empty");
  }
  if (content.byteLength > maxBytes) {
    throw new Error(`Inline media exceeds the ${maxBytes} byte limit`);
  }
  return {
    content,
    contentType,
    byteLength: content.byteLength,
    extension: extensionForContentType(contentType),
  };
}
