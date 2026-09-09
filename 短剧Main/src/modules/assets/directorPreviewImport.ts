import { createHash } from "node:crypto";
import { assetEntities, assetMedia, assetVariants } from "../../db/schema.js";
import type { Database } from "../../db/client.js";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  DIRECTOR_ASSET_BUCKET,
  DIRECTOR_ASSET_EXPECTED_COUNT,
  DIRECTOR_ASSET_PREFIX,
  deterministicUuid,
  validateDirectorManifest,
  type DirectorManifest,
} from "./directorManifestImport.js";
import { directorPreviewPaths } from "./directorPreviewRenderer.js";

export { DIRECTOR_ASSET_EXPECTED_COUNT, type DirectorManifest };

const DIRECTOR_PREVIEW_PREFIX = "asset-renditions/v1/director/";
const DIRECTOR_PREVIEW_SIZE = 512;
const DIRECTOR_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

export interface DirectorPreviewManifestEntry {
  sourceTosKey: string;
  sourceSha256: string;
  localFile: string;
  storageKey: string;
  outputSha256: string;
  width: number;
  height: number;
  descriptionZh: string;
  sourceSummary: string;
}

export interface DirectorPreviewManifest {
  schemaVersion: number;
  generatedAt: string;
  storageBucket: string;
  previews: DirectorPreviewManifestEntry[];
}

export interface DirectorPreviewAssetMediaRow {
  id: string;
  assetEntityId: string;
  assetVariantId: null;
  mediaKind: "image";
  viewAngle: "default";
  title: string;
  description: string;
  storageBucket: string;
  storagePath: string;
  storageUrl: null;
  widthPx: number;
  heightPx: number;
  format: "png";
  sha256: string;
  isPrimary: false;
  approved: true;
  sortOrder: 1;
  metadata: Record<string, unknown>;
}

export interface DirectorPreviewImportPlan {
  manifestGeneratedAt: string;
  media: DirectorPreviewAssetMediaRow[];
  descriptions: Array<{
    assetEntityId: string;
    previewMediaId: string;
    descriptionZh: string;
    sourceSummary: string;
  }>;
}

export function validateDirectorPreviewManifest(value: unknown, sourceManifest: unknown): asserts value is DirectorPreviewManifest {
  validateDirectorManifest(sourceManifest);
  if (!isRecord(value)) throw new Error("Director preview manifest must be an object");
  if (value.schemaVersion !== 1) throw new Error("Director preview manifest schemaVersion must be 1");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    throw new Error("Director preview manifest generatedAt must be an ISO timestamp");
  }
  if (value.storageBucket !== DIRECTOR_ASSET_BUCKET) {
    throw new Error(`Director preview manifest storageBucket must be ${DIRECTOR_ASSET_BUCKET}`);
  }
  if (!Array.isArray(value.previews) || value.previews.length !== DIRECTOR_ASSET_EXPECTED_COUNT) {
    throw new Error(`Director preview manifest must contain exactly ${DIRECTOR_ASSET_EXPECTED_COUNT} previews`);
  }

  const sourceByKey = new Map(sourceManifest.assets.map((asset) => [asset.tosKey, asset]));
  const sourceKeys = new Set<string>();
  const storageKeys = new Set<string>();
  for (const [index, preview] of value.previews.entries()) {
    if (!isRecord(preview)) throw new Error(`Director preview manifest entry ${index} must be an object`);
    for (const field of ["sourceTosKey", "sourceSha256", "localFile", "storageKey", "outputSha256", "descriptionZh", "sourceSummary"] as const) {
      if (typeof preview[field] !== "string" || !preview[field].trim()) {
        throw new Error(`Director preview manifest entry ${index} has invalid ${field}`);
      }
    }
    if (preview.width !== DIRECTOR_PREVIEW_SIZE || preview.height !== DIRECTOR_PREVIEW_SIZE) {
      throw new Error(`Director preview manifest entry ${index} has invalid dimensions`);
    }
    const entry = preview as unknown as DirectorPreviewManifestEntry;
    if (!entry.sourceTosKey.startsWith(DIRECTOR_ASSET_PREFIX) || !entry.sourceTosKey.endsWith(".glb")) {
      throw new Error(`Director preview manifest entry ${index} has invalid sourceTosKey`);
    }
    if (!entry.localFile.endsWith(".png") || !entry.storageKey.startsWith(DIRECTOR_PREVIEW_PREFIX) || !entry.storageKey.endsWith(".png")) {
      throw new Error(`Director preview manifest entry ${index} must bind a local and TOS PNG`);
    }
    if (!isSha256(entry.sourceSha256) || !isSha256(entry.outputSha256)) {
      throw new Error(`Director preview manifest entry ${index} has invalid SHA-256`);
    }
    if (entry.descriptionZh.trim().length < 8 || !hasChinese(entry.descriptionZh)) {
      throw new Error(`Director preview manifest entry ${index} requires a Chinese description`);
    }
    assertUnique(sourceKeys, entry.sourceTosKey, "sourceTosKey");
    assertUnique(storageKeys, entry.storageKey, "storageKey");
    const source = sourceByKey.get(entry.sourceTosKey);
    if (!source) throw new Error(`Director preview manifest entry ${index} source GLB is not in the director manifest`);
    if (source.sha256.toLowerCase() !== entry.sourceSha256.toLowerCase()) {
      throw new Error(`Director preview manifest entry ${index} source hash drift for ${entry.sourceTosKey}`);
    }
    const expectedPaths = directorPreviewPaths(source.tosKey, source.file);
    if (entry.localFile !== expectedPaths.localFile || entry.storageKey !== expectedPaths.storageKey) {
      throw new Error(`Director preview manifest entry ${index} output path drift for ${entry.sourceTosKey}`);
    }
  }
}

export async function verifyDirectorPreviewPng(
  content: Buffer,
  entry: Pick<DirectorPreviewManifestEntry, "outputSha256" | "width" | "height" | "localFile">,
): Promise<void> {
  if (!content.length || content.length > DIRECTOR_PREVIEW_MAX_BYTES) {
    throw new Error(`Director preview PNG has an unsafe size: ${entry.localFile}`);
  }
  const metadata = await sharp(content, {
    limitInputPixels: DIRECTOR_PREVIEW_SIZE * DIRECTOR_PREVIEW_SIZE,
  }).metadata();
  if (
    metadata.format !== "png"
    || metadata.width !== entry.width
    || metadata.height !== entry.height
    || metadata.width !== DIRECTOR_PREVIEW_SIZE
    || metadata.height !== DIRECTOR_PREVIEW_SIZE
  ) {
    throw new Error(`Director preview PNG metadata drift: ${entry.localFile}`);
  }
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (actualSha256 !== entry.outputSha256.toLowerCase()) {
    throw new Error(`Director preview PNG hash drift: ${entry.localFile}`);
  }
}

export function buildDirectorPreviewImportPlan(previewManifest: DirectorPreviewManifest, sourceManifest: DirectorManifest): DirectorPreviewImportPlan {
  validateDirectorPreviewManifest(previewManifest, sourceManifest);
  const media: DirectorPreviewAssetMediaRow[] = [];
  const descriptions: DirectorPreviewImportPlan["descriptions"] = [];
  for (const preview of previewManifest.previews) {
    const sourceIdentity = `${previewManifest.storageBucket}:${preview.sourceTosKey}`;
    const sourceMediaId = deterministicUuid(`director-assets:v1:media:${sourceIdentity}`);
    const assetEntityId = deterministicUuid(`director-assets:v1:entity:${sourceIdentity}`);
    // Source object identity owns the preview row. Output changes refresh the
    // same row/renditions instead of leaving an obsolete active preview beside it.
    const previewMediaId = deterministicUuid(`director-assets:v1:preview-media:${sourceIdentity}`);
    const metadata = {
      role: "director_3d_preview",
      sourceMediaId,
      sourceTosKey: preview.sourceTosKey,
      sourceSha256: preview.sourceSha256,
      sourceSummary: preview.sourceSummary,
      localFile: preview.localFile,
    };
    media.push({
      id: previewMediaId,
      assetEntityId,
      assetVariantId: null,
      mediaKind: "image",
      viewAngle: "default",
      title: "3D 预览图",
      description: preview.descriptionZh,
      storageBucket: previewManifest.storageBucket,
      storagePath: preview.storageKey,
      storageUrl: null,
      widthPx: preview.width,
      heightPx: preview.height,
      format: "png",
      sha256: preview.outputSha256,
      isPrimary: false,
      approved: true,
      sortOrder: 1,
      metadata,
    });
    descriptions.push({
      assetEntityId,
      previewMediaId,
      descriptionZh: preview.descriptionZh,
      sourceSummary: preview.sourceSummary,
    });
  }
  return { manifestGeneratedAt: previewManifest.generatedAt, media, descriptions };
}

/** DB-only apply. Preview PNG bytes must already exist; no TOS operation is possible here. */
export async function applyDirectorPreviewImportPlan(db: Database, plan: DirectorPreviewImportPlan): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const media of plan.media) {
      const binding = directorPreviewSourceBinding(media);
      const currentEntity = (await tx.select({
        id: assetEntities.id,
        deletedAt: assetEntities.deletedAt,
      }).from(assetEntities)
        .where(eq(assetEntities.id, media.assetEntityId))
        .limit(1)
        .for("update"))[0];
      if (!currentEntity || currentEntity.deletedAt) {
        throw new Error(`Director asset entity is missing: ${media.assetEntityId}`);
      }

      // The preview manifest is only a proposal. Apply always rebinds it to the
      // live, locked GLB row so a stale/offline manifest cannot create an
      // approved preview for deleted, unreviewed, moved or changed source bytes.
      const source = (await tx.select().from(assetMedia)
        .where(eq(assetMedia.id, binding.sourceMediaId))
        .limit(1)
        .for("update"))[0];
      if (
        !source
        || source.deletedAt
        || source.approved !== true
        || source.mediaKind !== "model_3d"
        || source.format?.toLowerCase() !== "glb"
        || source.assetEntityId !== media.assetEntityId
        || source.assetVariantId !== media.assetVariantId
        || source.storageBucket !== media.storageBucket
        || source.storagePath !== binding.sourceTosKey
        || source.sha256?.toLowerCase() !== binding.sourceSha256
      ) {
        throw new Error(`Director preview source is not the current approved GLB: ${binding.sourceMediaId}`);
      }
      if (source.assetVariantId) {
        const variant = (await tx.select().from(assetVariants)
          .where(eq(assetVariants.id, source.assetVariantId))
          .limit(1)
          .for("update"))[0];
        if (!variant || variant.deletedAt || variant.assetEntityId !== media.assetEntityId) {
          throw new Error(`Director preview source variant is no longer active: ${source.assetVariantId}`);
        }
      }

      await tx.insert(assetMedia).values({ ...media, createdAt: now, deletedAt: null, deletedByUserId: null }).onConflictDoUpdate({
        target: assetMedia.id,
        set: { ...without(media, ["id"]), deletedAt: null, deletedByUserId: null },
      });
    }
    for (const description of plan.descriptions) {
      const current = (await tx.select({ metadata: assetEntities.metadata })
        .from(assetEntities)
        .where(eq(assetEntities.id, description.assetEntityId))
        .limit(1))[0];
      if (!current) throw new Error(`Director asset entity is missing: ${description.assetEntityId}`);
      await tx.update(assetEntities).set({
        intro: description.descriptionZh,
        metadata: {
          ...current.metadata,
          visual_description_zh: description.descriptionZh,
          visual_description_source: description.sourceSummary,
          director_preview_media_id: description.previewMediaId,
        },
        updatedAt: now,
      }).where(eq(assetEntities.id, description.assetEntityId));
    }
  });
}

function directorPreviewSourceBinding(media: DirectorPreviewAssetMediaRow): {
  sourceMediaId: string;
  sourceSha256: string;
  sourceTosKey: string;
} {
  const { sourceMediaId, sourceSha256, sourceTosKey, role } = media.metadata;
  if (
    role !== "director_3d_preview"
    || typeof sourceMediaId !== "string"
    || !sourceMediaId
    || typeof sourceSha256 !== "string"
    || !isSha256(sourceSha256)
    || typeof sourceTosKey !== "string"
    || !sourceTosKey
  ) {
    throw new Error(`Director preview source binding is invalid: ${media.id}`);
  }
  return {
    sourceMediaId,
    sourceSha256: sourceSha256.toLowerCase(),
    sourceTosKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function hasChinese(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function assertUnique(seen: Set<string>, value: string, field: string): void {
  if (seen.has(value)) throw new Error(`Director preview manifest has duplicate ${field}`);
  seen.add(value);
}

function without<T extends object>(value: T, keys: string[]): Omit<T, keyof T> {
  const copy = Object.assign({}, value) as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as Omit<T, keyof T>;
}
