import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, isNull, or } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  users,
} from "../src/db/schema.js";
import { AssetCatalogService } from "../src/modules/assets/catalog.js";
import {
  DrizzleAssetMediaUploadRepository,
  type PersistUploadedAssetMediaInput,
} from "../src/modules/assets/mediaUpload.js";

const databaseUrl = process.env.OPS_TEST_DATABASE_URL;

test("PostgreSQL 并发修改资产主版本时始终只保留一个主版本", {
  skip: !databaseUrl,
}, async () => {
  const handle = createDatabase(databaseUrl);
  const { db } = handle;
  const now = new Date();
  const actorId = randomUUID();
  const assetId = randomUUID();
  const variantId = randomUUID();
  const existingMediaIds = Array.from({ length: 4 }, () => randomUUID());
  const uploadedMediaIds = Array.from({ length: 4 }, () => randomUUID());

  try {
    await db.insert(users).values({
      id: actorId,
      username: `asset-race-${actorId.slice(0, 8)}`,
      displayName: "资产并发测试",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(assetEntities).values({
      id: assetId,
      sourceProjectId: null,
      sourceProjectName: null,
      ownerUserId: actorId,
      visibility: "personal",
      assetKind: "character",
      name: "并发主版本资产",
      displayName: null,
      intro: null,
      appearance: null,
      ageValue: null,
      gender: null,
      heightCm: null,
      hairDescription: null,
      outfitDescription: null,
      category: null,
      styleTags: [],
      approved: true,
      reuseScope: "all_projects",
      status: "approved",
      sourceFileUrl: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      useCount: 0,
      deletedAt: null,
      deletedByUserId: null,
    });
    await db.insert(assetVariants).values({
      id: variantId,
      assetEntityId: assetId,
      variantKind: "costume",
      name: "服装变体",
      description: null,
      usageContext: null,
      visualPrompt: null,
      approved: true,
      status: "approved",
      isPrimary: true,
      sortOrder: 0,
      sourceFileUrl: null,
      sourceText: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await db.insert(assetMedia).values(existingMediaIds.map((id, index) => ({
      id,
      assetEntityId: index === 3 ? null : assetId,
      assetVariantId: index === 3 ? variantId : null,
      mediaKind: "image",
      viewAngle: "front",
      title: `已有版本-${index + 1}`,
      description: null,
      storageBucket: "test-bucket",
      storagePath: `test/${id}.png`,
      storageUrl: `https://storage.example/test/${id}.png`,
      widthPx: 1_024,
      heightPx: 1_024,
      format: "png",
      sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
      isPrimary: index === 0,
      approved: true,
      sortOrder: index,
      metadata: {},
      createdAt: now,
      deletedAt: null,
      deletedByUserId: null,
    })));

    const catalog = new AssetCatalogService(db);
    const uploader = new DrizzleAssetMediaUploadRepository(db);
    const setPrimaryTargets = [
      existingMediaIds[1]!,
      existingMediaIds[2]!,
      existingMediaIds[3]!,
      existingMediaIds[0]!,
      existingMediaIds[2]!,
      existingMediaIds[3]!,
    ];
    const primaryChanges = setPrimaryTargets.map((mediaId) => (
      catalog.setPrimary(actorId, assetId, mediaId)
    ));
    const uploads = uploadedMediaIds.map((mediaId, index) => (
      uploader.persistUploadedMedia(uploadInput({
        actorId,
        assetId,
        mediaId,
        index,
      }))
    ));

    await Promise.all([...primaryChanges, ...uploads]);

    const rows = await db.select().from(assetMedia).where(and(
      isNull(assetMedia.deletedAt),
      or(
        eq(assetMedia.assetEntityId, assetId),
        eq(assetMedia.assetVariantId, variantId),
      ),
    ));
    const primaries = rows.filter((row) => row.isPrimary);
    assert.equal(primaries.length, 1, "实体和变体媒体合计只能有一个主版本");
    assert.equal(rows.filter((row) => uploadedMediaIds.includes(row.id)).length, 4);
    const uploadedSortOrders = rows
      .filter((row) => uploadedMediaIds.includes(row.id))
      .map((row) => row.sortOrder);
    assert.equal(new Set(uploadedSortOrders).size, uploadedSortOrders.length, "并发上传版本序号不能重复");
  } finally {
    await db.delete(assetMedia).where(or(
      eq(assetMedia.assetEntityId, assetId),
      eq(assetMedia.assetVariantId, variantId),
    )).catch(() => undefined);
    await db.delete(assetVariants).where(eq(assetVariants.id, variantId)).catch(() => undefined);
    await db.delete(assetEntities).where(eq(assetEntities.id, assetId)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

function uploadInput(input: {
  actorId: string;
  assetId: string;
  mediaId: string;
  index: number;
}): PersistUploadedAssetMediaInput {
  const storagePath = `test/${input.mediaId}.png`;
  return {
    actorId: input.actorId,
    assetId: input.assetId,
    mediaId: input.mediaId,
    originalFileName: `并发上传-${input.index + 1}.png`,
    declaredContentType: "image/png",
    title: `并发上传-${input.index + 1}`,
    description: undefined,
    isPrimary: true,
    sha256: input.mediaId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    media: {
      kind: "image",
      format: "png",
      extension: "png",
      contentType: "image/png",
      width: 1_024,
      height: 1_024,
    },
    stored: {
      bucket: "test-bucket",
      storagePath,
      storageUrl: `https://storage.example/${storagePath}`,
    },
  };
}
