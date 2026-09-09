import { createHash } from "node:crypto";
import { assetEntities, assetMedia, assetReviewActions, assetSourceProjects, parseAssetClearance } from "../../db/schema.js";
import type { Database } from "../../db/client.js";

export const DIRECTOR_ASSET_EXPECTED_COUNT = 519;
export const DIRECTOR_ASSET_BUCKET = "drama-asset";
export const DIRECTOR_ASSET_PREFIX = "director-assets/v1/";
const deterministicNamespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const DIRECTOR_SOURCE_PROJECT_ID = deterministicUuid("director-assets:v1:source-project");

/**
 * Public, deliberately small classification map. Edit this map when Kimi adds
 * a new source directory; unknown paths are reported by dry-run and block apply.
 */
export const DIRECTOR_ASSET_PATH_CLASSIFICATIONS = [
  { pathPrefix: "human/", assetKind: "character", label: "角色" },
  { pathPrefix: "city-commercial/", assetKind: "scene", label: "场景" },
  { pathPrefix: "city-roads/", assetKind: "scene", label: "场景" },
  { pathPrefix: "city-suburban/", assetKind: "scene", label: "场景" },
  { pathPrefix: "interior/", assetKind: "scene", label: "场景" },
  { pathPrefix: "street/", assetKind: "scene", label: "场景" },
  { pathPrefix: "door/", assetKind: "prop", label: "道具" },
  { pathPrefix: "food/", assetKind: "prop", label: "道具" },
  { pathPrefix: "furniture/", assetKind: "prop", label: "道具" },
  { pathPrefix: "lamp/", assetKind: "prop", label: "道具" },
  { pathPrefix: "plant/", assetKind: "prop", label: "道具" },
  { pathPrefix: "prop/", assetKind: "prop", label: "道具" },
  { pathPrefix: "vehicle/", assetKind: "prop", label: "道具" },
  { pathPrefix: "window/", assetKind: "prop", label: "道具" },
  { pathPrefix: "clothing/", assetKind: "clothing", label: "服装" },
  { pathPrefix: "reference/", assetKind: "other", label: "参考" },
] as const;

export interface DirectorManifestAsset {
  id: string;
  name: string;
  category: string;
  source: string;
  license: string;
  tosKey: string;
  file: string;
  size: number;
  sha256: string;
  tags: string[];
}

export interface DirectorManifest {
  schemaVersion: number;
  generatedAt: string;
  assets: DirectorManifestAsset[];
}

export interface DirectorAssetImportPlan {
  sourceProject: Omit<typeof assetSourceProjects.$inferInsert, "createdAt" | "updatedAt">;
  assets: Array<{
    entity: Omit<typeof assetEntities.$inferInsert, "createdAt" | "updatedAt" | "deletedAt" | "deletedByUserId">;
    media: Omit<typeof assetMedia.$inferInsert, "createdAt" | "deletedAt" | "deletedByUserId">;
    auditAction: DirectorAssetReviewAction | null;
  }>;
}

export interface DirectorAssetReviewAction {
  id: string;
  assetEntityId: string;
  action: "approved" | "submitted";
  fromStatus: "automatic_review";
  toStatus: "approved" | "pending_review";
  reviewerUserId: string;
}

export interface DirectorAssetDryRun {
  total: number;
  typeDistribution: Record<string, number>;
  unrecognized: Array<{ id: string; tosKey: string }>;
}

/**
 * The upload receipt is intentionally treated as evidence, not a network source.
 * This importer never contacts TOS: all listed objects must already have been
 * uploaded and accepted in the Kimi handoff before metadata is registered.
 */
export function validateKimiDirectorUploadReceipt(receipt: string): void {
  const requirements: Array<[string, RegExp]> = [
    ["uploaded=518 / skipped=1（canary）/ failed=0", /uploaded\s*=\s*518\s*\/\s*skipped\s*=\s*1\s*[（(]canary[）)]\s*\/\s*failed\s*=\s*0/i],
    ["匿名 HEAD 200 = 519/519", /匿名\s*HEAD\s*200\s*=\s*519\s*\/\s*519/i],
    ["drama-asset / cn-beijing / director-assets/v1/", /drama-asset\s*\/\s*cn-beijing\s*\/\s*director-assets\/v1\//i],
  ];
  for (const [description, pattern] of requirements) {
    if (!pattern.test(receipt)) throw new Error(`Kimi upload receipt is incomplete: missing ${description}`);
  }
}

export function validateDirectorManifest(value: unknown): asserts value is DirectorManifest {
  if (!isRecord(value)) throw new Error("Director manifest must be an object");
  if (value.schemaVersion !== 1) throw new Error("Director manifest schemaVersion must be 1");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    throw new Error("Director manifest generatedAt must be an ISO timestamp");
  }
  if (!Array.isArray(value.assets) || value.assets.length !== DIRECTOR_ASSET_EXPECTED_COUNT) {
    throw new Error(`Director manifest must contain exactly ${DIRECTOR_ASSET_EXPECTED_COUNT} assets`);
  }

  const ids = new Set<string>();
  const tosKeys = new Set<string>();
  const sha256s = new Set<string>();
  for (const [index, asset] of value.assets.entries()) {
    if (!isRecord(asset)) throw new Error(`Director manifest asset ${index} must be an object`);
    const fields = ["id", "name", "category", "source", "license", "tosKey", "file", "sha256"] as const;
    for (const field of fields) {
      if (typeof asset[field] !== "string" || !asset[field].trim()) {
        throw new Error(`Director manifest asset ${index} has invalid ${field}`);
      }
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Director manifest asset ${index} has invalid size`);
    }
    if (!Array.isArray(asset.tags) || asset.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
      throw new Error(`Director manifest asset ${index} has invalid tags`);
    }
    if (!asset.tosKey.startsWith(DIRECTOR_ASSET_PREFIX) || !asset.tosKey.endsWith(".glb")) {
      throw new Error(`Director manifest asset ${index} must use ${DIRECTOR_ASSET_PREFIX}*.glb`);
    }
    if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) {
      throw new Error(`Director manifest asset ${index} has invalid sha256`);
    }
    assertUnique(ids, asset.id, `id at asset ${index}`);
    assertUnique(tosKeys, asset.tosKey, `tosKey at asset ${index}`);
    assertUnique(sha256s, asset.sha256, `sha256 at asset ${index}`);
  }
}

export function deterministicUuid(value: string): string {
  const namespace = Buffer.from(deterministicNamespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespace).update(value, "utf8").digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function classifyDirectorAssetPath(tosKey: string): { assetKind: string; label: string } | null {
  if (!tosKey.startsWith(DIRECTOR_ASSET_PREFIX)) return null;
  const relativePath = tosKey.slice(DIRECTOR_ASSET_PREFIX.length);
  // Kimi's manifest is `<source>/<classification>/<file>`, while the map stays
  // source-independent so the next supplier does not need a new importer.
  const directorySegments = relativePath.split("/").slice(0, -1);
  const match = DIRECTOR_ASSET_PATH_CLASSIFICATIONS.find((item) => {
    const category = item.pathPrefix.slice(0, -1);
    return directorySegments.includes(category);
  });
  return match ? { assetKind: match.assetKind, label: match.label } : null;
}

export function summarizeDirectorAssetDryRun(manifest: DirectorManifest): DirectorAssetDryRun {
  validateDirectorManifest(manifest);
  const typeDistribution: Record<string, number> = {};
  const unrecognized: Array<{ id: string; tosKey: string }> = [];
  for (const asset of manifest.assets) {
    const classification = classifyDirectorAssetPath(asset.tosKey);
    if (!classification) {
      unrecognized.push({ id: asset.id, tosKey: asset.tosKey });
      continue;
    }
    typeDistribution[classification.assetKind] = (typeDistribution[classification.assetKind] ?? 0) + 1;
  }
  return { total: manifest.assets.length, typeDistribution, unrecognized };
}

export function buildDirectorAssetImportPlan(manifest: DirectorManifest, input: {
  bucket: string;
  publicBaseUrl: string;
  receiptAcceptedAt: string;
  reviewState?: "approved" | "pending";
  reviewerUserId?: string;
}): DirectorAssetImportPlan {
  validateDirectorManifest(manifest);
  if (input.bucket !== DIRECTOR_ASSET_BUCKET) {
    throw new Error(`TOS_BUCKET must be ${DIRECTOR_ASSET_BUCKET} for the accepted director upload receipt`);
  }
  const publicBaseUrl = normalizePublicBaseUrl(input.publicBaseUrl);
  const summary = summarizeDirectorAssetDryRun(manifest);
  if (summary.unrecognized.length) {
    throw new Error(`Director manifest has ${summary.unrecognized.length} unrecognized path(s); update DIRECTOR_ASSET_PATH_CLASSIFICATIONS before apply`);
  }
  const receiptAcceptedAt = new Date(input.receiptAcceptedAt);
  if (Number.isNaN(receiptAcceptedAt.valueOf())) throw new Error("receiptAcceptedAt must be an ISO timestamp");
  const approved = input.reviewState !== "pending";

  return {
    sourceProject: {
      id: DIRECTOR_SOURCE_PROJECT_ID,
      name: "Kimi 3D 导演台资产库",
      code: "director-assets-v1",
      description: "Kimi 已上传并验收的 3D 导演台 GLB 参考资产",
      projectType: "director_asset_library",
      metadata: {
        importSource: "kimi_director_upload_receipt",
        bucket: input.bucket,
        prefix: DIRECTOR_ASSET_PREFIX,
        manifestGeneratedAt: manifest.generatedAt,
        manifestAssetCount: manifest.assets.length,
        receiptAcceptedAt: receiptAcceptedAt.toISOString(),
      },
    },
    assets: manifest.assets.map((asset) => {
      const classification = classifyDirectorAssetPath(asset.tosKey);
      if (!classification) throw new Error(`Director asset path is not classified: ${asset.tosKey}`);
      // The TOS object identity is the import identity. Display names and source IDs may change.
      const objectIdentity = `${input.bucket}:${asset.tosKey}`;
      const entityId = deterministicUuid(`director-assets:v1:entity:${objectIdentity}`);
      const mediaId = deterministicUuid(`director-assets:v1:media:${objectIdentity}`);
      const storageUrl = `${publicBaseUrl}/${encodeTosKey(asset.tosKey)}`;
      const provenance = {
        tosObjectIdentity: objectIdentity,
        manifestId: asset.id,
        source: asset.source,
        license: asset.license,
        tosKey: asset.tosKey,
        sourceFile: asset.file,
        sizeBytes: asset.size,
        sha256: asset.sha256,
        tags: asset.tags,
        importSource: "kimi_director_upload_receipt",
      };
      return {
        entity: {
          id: entityId,
          sourceProjectId: DIRECTOR_SOURCE_PROJECT_ID,
          sourceProjectName: "Kimi 3D 导演台资产库",
          ownerUserId: null,
          visibility: "common",
          assetKind: classification.assetKind,
          name: asset.name,
          displayName: asset.name,
          intro: `3D 导演台参考资产：${asset.category}`,
          appearance: null,
          ageValue: null,
          gender: null,
          heightCm: null,
          hairDescription: null,
          outfitDescription: null,
          category: asset.category,
          styleTags: asset.tags,
          approved: approved ? true : null,
          reuseScope: "all_projects",
          status: approved ? "approved" : "pending_review",
          sourceFileUrl: storageUrl,
          metadata: provenance,
          useCount: 0,
        },
        media: {
          id: mediaId,
          assetEntityId: entityId,
          assetVariantId: null,
          mediaKind: "model_3d",
          viewAngle: null,
          title: asset.name,
          description: `GLB：${asset.category}`,
          storageBucket: input.bucket,
          storagePath: asset.tosKey,
          storageUrl,
          widthPx: null,
          heightPx: null,
          format: "glb",
          sha256: asset.sha256,
          isPrimary: true,
          approved: approved ? true : null,
          sortOrder: 0,
          metadata: { ...provenance, classificationLabel: classification.label },
        },
        auditAction: input.reviewerUserId
          ? {
            id: deterministicUuid(`director-assets:v1:review-action:${objectIdentity}:${approved ? "approved" : "pending_review"}`),
            assetEntityId: entityId,
            action: approved ? "approved" : "submitted",
            fromStatus: "automatic_review",
            toStatus: approved ? "approved" : "pending_review",
            reviewerUserId: input.reviewerUserId,
          }
          : null,
      };
    }),
  };
}

export async function applyDirectorAssetImportPlan(db: Database, plan: DirectorAssetImportPlan): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(assetSourceProjects).values({
      ...plan.sourceProject,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: assetSourceProjects.id,
      set: {
        name: plan.sourceProject.name,
        code: plan.sourceProject.code,
        description: plan.sourceProject.description,
        projectType: plan.sourceProject.projectType,
        metadata: plan.sourceProject.metadata,
        updatedAt: now,
      },
    });

    for (const item of plan.assets) {
      // entity 类型允许携带 clearance；一旦携带就必须过唯一的共享校验，
      // 缺省位取 fail-safe 默认值，未知位或非布尔值在落库前抛错。
      const entity = item.entity.clearance === undefined
        ? item.entity
        : { ...item.entity, clearance: parseAssetClearance(item.entity.clearance) };
      await tx.insert(assetEntities).values({
        ...entity,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        deletedByUserId: null,
      }).onConflictDoUpdate({
        target: assetEntities.id,
        set: {
          ...without(entity, ["id"]),
          updatedAt: now,
          deletedAt: null,
          deletedByUserId: null,
        },
      });
      await tx.insert(assetMedia).values({
        ...item.media,
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      }).onConflictDoUpdate({
        target: assetMedia.id,
        set: {
          ...without(item.media, ["id"]),
          deletedAt: null,
          deletedByUserId: null,
        },
      });
      if (item.auditAction) {
        await tx.insert(assetReviewActions).values({
          id: item.auditAction.id,
          projectId: null,
          assetEntityId: item.auditAction.assetEntityId,
          action: item.auditAction.action,
          fromStatus: item.auditAction.fromStatus,
          toStatus: item.auditAction.toStatus,
          reviewerUserId: item.auditAction.reviewerUserId,
          rejectionReason: null,
          createdAt: now,
        }).onConflictDoUpdate({
          target: assetReviewActions.id,
          set: {
            projectId: null,
            assetEntityId: item.auditAction.assetEntityId,
            action: item.auditAction.action,
            fromStatus: item.auditAction.fromStatus,
            toStatus: item.auditAction.toStatus,
            reviewerUserId: item.auditAction.reviewerUserId,
            rejectionReason: null,
          },
        });
      }
    }
  });
}

function normalizePublicBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TOS_PUBLIC_BASE_URL must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("TOS_PUBLIC_BASE_URL must use http or https");
  }
  return value.replace(/\/+$/, "");
}

function encodeTosKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function assertUnique(seen: Set<string>, value: string, description: string): void {
  if (seen.has(value)) throw new Error(`Director manifest has duplicate ${description}`);
  seen.add(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function without<T extends Record<string, unknown>>(value: T, keys: string[]): Omit<T, keyof T> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, keyof T>;
}
