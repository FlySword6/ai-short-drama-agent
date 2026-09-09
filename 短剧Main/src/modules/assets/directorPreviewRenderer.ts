import { createHash } from "node:crypto";
import path from "node:path";
import {
  DIRECTOR_ASSET_EXPECTED_COUNT,
  DIRECTOR_ASSET_PREFIX,
  validateDirectorManifest,
  type DirectorManifest,
} from "./directorManifestImport.js";

export interface DirectorPreviewDescription {
  sourceTosKey: string;
  descriptionZh: string;
  sourceSummary: string;
}
export interface DirectorPreviewDescriptionManifest {
  schemaVersion: number;
  generatedAt: string;
  descriptions: DirectorPreviewDescription[];
}

export interface DirectorPreviewRenderJob {
  sourceTosKey: string;
  sourceSha256: string;
  sourceFile: string;
  localFile: string;
  storageKey: string;
  descriptionZh: string;
  sourceSummary: string;
}

export interface DirectorPreviewPaths {
  sourceFile: string;
  localFile: string;
  storageKey: string;
}

export interface DirectorPreviewCacheEntry {
  sourceTosKey: string;
  sourceSha256: string;
  outputSha256: string;
}

/** The renderer is deliberately a single-origin browser workload. */
export function isDirectorPreviewRequestAllowed(requestUrl: string, port: number): boolean {
  try {
    const url = new URL(requestUrl);
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port === String(port)
      && url.origin === `http://127.0.0.1:${port}`;
  } catch {
    return false;
  }
}

/** A PNG is reusable only when both the source identity and prior output agree. */
export function canReuseDirectorPreview(
  job: Pick<DirectorPreviewRenderJob, "sourceTosKey" | "sourceSha256">,
  outputSha256: string,
  previous: DirectorPreviewCacheEntry | undefined,
): boolean {
  return Boolean(
    previous
    && previous.sourceTosKey === job.sourceTosKey
    && previous.sourceSha256.toLowerCase() === job.sourceSha256.toLowerCase()
    && previous.outputSha256.toLowerCase() === outputSha256.toLowerCase(),
  );
}

/**
 * GLB is expected to embed all render resources. Rejecting URI references keeps
 * GLTFLoader from resolving sibling files, even on the otherwise allowed origin.
 */
export function assertDirectorPreviewGlbHasNoExternalUris(content: Buffer): void {
  if (content.length < 20 || content.readUInt32LE(0) !== 0x46546c67 || content.readUInt32LE(4) !== 2) {
    throw new Error("Director preview source must be a valid GLB v2");
  }
  const declaredLength = content.readUInt32LE(8);
  const jsonLength = content.readUInt32LE(12);
  const jsonType = content.readUInt32LE(16);
  if (declaredLength !== content.length || jsonType !== 0x4e4f534a || 20 + jsonLength > content.length) {
    throw new Error("Director preview source has an invalid GLB JSON chunk");
  }
  let document: unknown;
  try {
    document = JSON.parse(content.subarray(20, 20 + jsonLength).toString("utf8").trim());
  } catch {
    throw new Error("Director preview source has invalid GLB JSON");
  }
  rejectExternalUris(document);
}

export function validateDirectorPreviewDescriptions(
  value: unknown,
  sourceManifest: DirectorManifest,
): asserts value is DirectorPreviewDescriptionManifest {
  validateDirectorManifest(sourceManifest);
  if (!isRecord(value)) throw new Error("Director preview descriptions must be an object");
  if (value.schemaVersion !== 1) throw new Error("Director preview descriptions schemaVersion must be 1");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    throw new Error("Director preview descriptions generatedAt must be an ISO timestamp");
  }
  if (!Array.isArray(value.descriptions) || value.descriptions.length !== DIRECTOR_ASSET_EXPECTED_COUNT) {
    throw new Error(`Director preview descriptions must contain exactly ${DIRECTOR_ASSET_EXPECTED_COUNT} entries`);
  }
  const sourceKeys = new Set(sourceManifest.assets.map((asset) => asset.tosKey));
  const seen = new Set<string>();
  for (const [index, raw] of value.descriptions.entries()) {
    if (!isRecord(raw)) throw new Error(`Director preview description ${index} must be an object`);
    const sourceTosKey = text(raw.sourceTosKey);
    const descriptionZh = text(raw.descriptionZh);
    const sourceSummary = text(raw.sourceSummary);
    if (!sourceTosKey || !sourceKeys.has(sourceTosKey)) {
      throw new Error(`Director preview description ${index} does not match a source GLB`);
    }
    if (seen.has(sourceTosKey)) throw new Error(`Director preview descriptions duplicate ${sourceTosKey}`);
    if (!descriptionZh || descriptionZh.length < 8 || !/[\u3400-\u9fff]/u.test(descriptionZh)) {
      throw new Error(`Director preview description ${index} requires a reviewed Chinese description`);
    }
    if (!sourceSummary) throw new Error(`Director preview description ${index} requires a source summary`);
    seen.add(sourceTosKey);
  }
  if (seen.size !== sourceKeys.size) {
    throw new Error("Director preview descriptions do not cover every source GLB");
  }
}

export function buildDirectorPreviewRenderJobs(
  sourceManifest: DirectorManifest,
  descriptions: DirectorPreviewDescriptionManifest,
): DirectorPreviewRenderJob[] {
  validateDirectorPreviewDescriptions(descriptions, sourceManifest);
  const bySource = new Map(descriptions.descriptions.map((item) => [item.sourceTosKey, item]));
  return sourceManifest.assets.map((asset) => {
    const description = bySource.get(asset.tosKey);
    if (!description) throw new Error(`Director preview description is missing: ${asset.tosKey}`);
    const paths = directorPreviewPaths(asset.tosKey, asset.file);
    return {
      sourceTosKey: asset.tosKey,
      sourceSha256: asset.sha256.toLowerCase(),
      ...paths,
      descriptionZh: description.descriptionZh.trim(),
      sourceSummary: description.sourceSummary.trim(),
    };
  });
}

export function directorPreviewPaths(sourceTosKey: string, sourceFile: string): DirectorPreviewPaths {
  if (!sourceTosKey.startsWith(DIRECTOR_ASSET_PREFIX) || !sourceTosKey.endsWith(".glb")) {
    throw new Error("Director preview source must be a GLB under the accepted TOS prefix");
  }
  const relative = sourceTosKey.slice(DIRECTOR_ASSET_PREFIX.length);
  const normalized = path.posix.normalize(relative);
  if (
    !relative
    || relative.startsWith("/")
    || relative.includes("\\")
    || normalized !== relative
    || normalized === "."
    || normalized.startsWith("../")
    || sourceFile !== relative
  ) {
    throw new Error("Director preview source file must exactly match its safe TOS-relative path");
  }
  const parsed = path.posix.parse(relative);
  const outputRelative = path.posix.join(parsed.dir, `${parsed.name}.png`);
  const sourceIdentityDigest = createHash("sha256").update(sourceTosKey).digest("hex");
  return {
    sourceFile: path.posix.join("runtime/director-assets", relative),
    localFile: path.posix.join("runtime/director-previews", outputRelative),
    storageKey: `asset-renditions/v1/director/${sourceIdentityDigest}.png`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rejectExternalUris(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectExternalUris);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "uri" && typeof child === "string" && !child.startsWith("data:")) {
      throw new Error("Director preview GLB must not reference external URIs");
    }
    rejectExternalUris(child);
  }
}
