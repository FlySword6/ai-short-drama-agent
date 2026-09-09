import { settings } from "../../config/env.js";

export type AssetMediaDisplayVariant = "thumbnail" | "detail";

export interface AssetMediaDisplaySpec {
  readonly kind: AssetMediaDisplayVariant;
  readonly processSpec: string;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly format: "webp";
}

export const ASSET_MEDIA_DISPLAY_SPECS: Record<AssetMediaDisplayVariant, AssetMediaDisplaySpec> = {
  thumbnail: { kind: "thumbnail", processSpec: "image/resize,m_fill,w_320,h_180/format,webp", targetWidth: 320, targetHeight: 180, format: "webp" },
  detail: { kind: "detail", processSpec: "image/resize,m_lfit,w_1280,h_720/format,webp", targetWidth: 1280, targetHeight: 720, format: "webp" },
};

export interface AssetMediaDisplayInput {
  /** Current source bytes; stale renditions for an older source are never public. */
  sourceSha256: string | null | undefined;
  renditions: readonly AssetMediaDisplayRenditionInput[];
  /** Test and isolated callers may pass a base explicitly. */
  displayBaseUrl?: string | null;
  /** The bucket represented by displayBaseUrl. Defaults to the configured TOS bucket. */
  displayBucket?: string | null;
}

export interface AssetMediaDisplayRenditionInput {
  renditionKind: string;
  strategy: string;
  status: string;
  storageBucket: string | null | undefined;
  storagePath: string | null | undefined;
  sourceSha256: string | null | undefined;
  widthPx: number | null | undefined;
  heightPx: number | null | undefined;
  format: string | null | undefined;
  sha256: string | null | undefined;
  checkedAt: Date | string | null | undefined;
}

export interface AssetMediaDisplay extends AssetMediaDisplaySpec {
  readonly url: string;
  /** Verified bytes, not the resize ceiling from the process spec. */
  readonly width: number;
  readonly height: number;
}

export interface AssetMediaDisplaySet {
  readonly thumbnail: AssetMediaDisplay | null;
  readonly detail: AssetMediaDisplay | null;
}

/**
 * Builds public URLs only from independently stored, verified rendition
 * objects. Source media rows are deliberately not an accepted input: callers
 * cannot accidentally turn an original object key into a display URL.
 */
export function buildAssetMediaDisplay(input: AssetMediaDisplayInput): AssetMediaDisplaySet | null {
  const baseUrl = input.displayBaseUrl ?? settings.assetMediaDisplayBaseUrl ?? settings.tosPublicBaseUrl;
  const displayBucket = input.displayBucket?.trim() || settings.tosBucket?.trim();
  const base = normalizeDisplayBaseUrl(baseUrl);
  if (!base) return null;

  const thumbnail = displayVariant(
    base,
    displayBucket,
    input.sourceSha256,
    input.renditions,
    ASSET_MEDIA_DISPLAY_SPECS.thumbnail,
  );
  const detail = displayVariant(
    base,
    displayBucket,
    input.sourceSha256,
    input.renditions,
    ASSET_MEDIA_DISPLAY_SPECS.detail,
  );
  return thumbnail || detail ? { thumbnail, detail } : null;
}

const locatorFieldTerms = new Set([
  "bucket",
  "download",
  "file",
  "filename",
  "filepath",
  "key",
  "location",
  "locator",
  "path",
  "uri",
  "url",
]);

const locatorFieldPrefixes = /^(?:asset|download|file|local|media|object|original|private|provider|remote|s3|source|storage|tos|upload)/u;
const dangerousLocatorString = /[\\/]|^\s*(?:data|blob):/iu;
const redacted = Symbol("asset-storage-metadata-redacted");

/**
 * Removes reconstructable storage locators from public JSON metadata.
 *
 * Historical records have used arbitrary key casing and separators, so keys
 * are classified by their locator components rather than a finite blacklist.
 * A locator-shaped string is also removed wherever it appears, including in
 * otherwise business-named fields and nested arrays.
 */
export function redactAssetStorageMetadata(value: unknown): unknown {
  const result = redactMetadataValue(value);
  return result === redacted ? undefined : result;
}

function redactMetadataValue(value: unknown): unknown | typeof redacted {
  if (typeof value === "string") return isDangerousLocatorString(value) ? redacted : value;
  if (Array.isArray(value)) {
    return value
      .map(redactMetadataValue)
      .filter((child): child is Exclude<typeof child, typeof redacted> => child !== redacted);
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isLocatorFieldName(key)) continue;
    const sanitized = redactMetadataValue(child);
    if (sanitized !== redacted) output[key] = sanitized;
  }
  return output;
}

function isLocatorFieldName(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (parts.some((part) => locatorFieldTerms.has(part))) return true;

  const compact = parts.join("");
  if (!compact) return false;
  if (/(?:url|uri|path|download|location|locator|bucket)$/u.test(compact)) return true;
  if (/(?:key|file|filename|filepath)$/u.test(compact)) return locatorFieldPrefixes.test(compact);
  if (/^(?:s3|storage|tos)(?:object)?identity$/u.test(compact)) return true;
  return false;
}

function isDangerousLocatorString(value: string): boolean {
  return dangerousLocatorString.test(value);
}

function displayVariant(
  base: string,
  displayBucket: string | undefined,
  sourceSha256: string | null | undefined,
  renditions: readonly AssetMediaDisplayRenditionInput[],
  spec: AssetMediaDisplaySpec,
): AssetMediaDisplay | null {
  const rendition = renditions.find((candidate) =>
    candidate.renditionKind === spec.kind
    && candidate.strategy === "stored_object"
    && candidate.status === "healthy"
    && isSha256(sourceSha256)
    && candidate.sourceSha256 === sourceSha256
    && isVerifiedRendition(candidate, spec)
  );
  const storageBucket = rendition?.storageBucket?.trim();
  const storagePath = rendition?.storagePath?.trim();
  if (
    !rendition
    || !storageBucket
    || !storagePath
    || (displayBucket && storageBucket !== displayBucket)
    // Rendition objects use a dedicated opaque namespace. A legacy source key
    // or an old source-derived process row can never be projected publicly.
    || !isAssetMediaRenditionStoragePath(storagePath)
  ) return null;
  const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
  return {
    ...spec,
    url: new URL(`${base}/${encodedPath}`).toString(),
    width: rendition.widthPx!,
    height: rendition.heightPx!,
  };
}

/**
 * Only application-generated, opaque WebP rendition keys are public.  Keeping
 * this grammar exact makes `.`/`..`, encoded traversal and legacy source names
 * invalid before URL resolution can normalize them outside the namespace.
 */
export function isAssetMediaRenditionStoragePath(value: string | null | undefined): value is string {
  return typeof value === "string"
    && /^asset-renditions\/v1\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/u.test(value);
}

function isVerifiedRendition(
  rendition: AssetMediaDisplayRenditionInput,
  spec: AssetMediaDisplaySpec,
): boolean {
  if (
    rendition.format?.trim().toLowerCase() !== spec.format
    || !isSha256(rendition.sourceSha256)
    || !isSha256(rendition.sha256)
    || !rendition.checkedAt
    || !Number.isInteger(rendition.widthPx)
    || !Number.isInteger(rendition.heightPx)
    || rendition.widthPx! < 1
    || rendition.heightPx! < 1
  ) return false;
  if (spec.kind === "thumbnail") {
    return rendition.widthPx === spec.targetWidth && rendition.heightPx === spec.targetHeight;
  }
  return rendition.widthPx! <= spec.targetWidth && rendition.heightPx! <= spec.targetHeight;
}

function isSha256(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function normalizeDisplayBaseUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}
