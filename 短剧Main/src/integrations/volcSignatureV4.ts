import { createHash, createHmac } from "node:crypto";
import { ExternalServiceError } from "../shared/errors.js";

/**
 * Volcengine (火山引擎) IAM V4 request signing — a pure HMAC-SHA256 signature
 * chain with zero framework dependencies. Ported from origin/dev's
 * `ark-v4-signature.ts` (unchanged algorithm) so future 管控类 OpenAPI callers
 * (素材上传、内容审核等) can sign requests without depending on any SDK.
 *
 * This module only exports signing functions; it does not call any existing
 * route or service yet.
 */

const ALGORITHM = "HMAC-SHA256";
const CONTENT_TYPE = "application/json";

export interface ArkV4SignatureInput {
  action: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  securityToken?: string;
  endpoint: string;
  region?: string;
  service?: string;
  version?: string;
  now?: Date;
}

export interface ArkV4SignedRequest {
  url: string;
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** Encodes one OpenAPI query component using the RFC 3986 signing rules. */
export function encodeArkQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Produces the SHA-256 hexadecimal digest used by Ark V4 signing. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Signs one Ark OpenAPI POST request without performing network I/O. */
export function signArkV4Request(input: ArkV4SignatureInput): ArkV4SignedRequest {
  const endpoint = new URL(input.endpoint);
  const region = input.region ?? "cn-beijing";
  const service = input.service ?? "ark";
  const version = input.version ?? "2024-01-01";
  const now = input.now ?? new Date();
  const xDate = formatArkUtcDate(now);
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const queryPairs: Array<[string, string]> = [
    ["Action", input.action],
    ["Version", version],
  ];
  const canonicalQuery = queryPairs
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) => `${encodeArkQueryComponent(key)}=${encodeArkQueryComponent(value)}`,
    )
    .join("&");
  const securityToken = input.securityToken?.trim();
  const canonicalHeaderValues: Array<[string, string]> = [
    ["content-type", CONTENT_TYPE],
    ["host", endpoint.host],
    ["x-content-sha256", payloadHash],
    ["x-date", xDate],
  ];
  if (securityToken) {
    canonicalHeaderValues.push(["x-security-token", securityToken]);
  }
  canonicalHeaderValues.sort(([left], [right]) => left.localeCompare(right));
  const canonicalHeaders = canonicalHeaderValues
    .map(([key, value]) => `${key}:${value.trim()}`)
    .join("\n");
  const signedHeaders = canonicalHeaderValues.map(([key]) => key).join(";");
  const canonicalPath = endpoint.pathname || "/";
  const canonicalRequest = [
    "POST",
    canonicalPath,
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = [
    ALGORITHM,
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = hmacSha256(input.secretAccessKey, shortDate);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, service);
  const signingKey = hmacSha256(serviceKey, "request");
  const signature = hmacSha256(signingKey, stringToSign).toString("hex");
  const authorization =
    `${ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = new URL(endpoint.toString());
  url.search = canonicalQuery;
  const headers: Record<string, string> = {
    Host: endpoint.host,
    "Content-Type": CONTENT_TYPE,
    "X-Content-Sha256": payloadHash,
    "X-Date": xDate,
    Authorization: authorization,
  };
  if (securityToken) headers["X-Security-Token"] = securityToken;

  return {
    url: url.toString(),
    headers,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** Computes an HMAC-SHA256 digest for one signing-key derivation step. */
function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** Formats one timestamp using Ark's UTC request-date representation. */
function formatArkUtcDate(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new ExternalServiceError("Ark", "invalid signing date");
  }
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}`
    + `${pad(value.getUTCDate())}T${pad(value.getUTCHours())}`
    + `${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`
  );
}
