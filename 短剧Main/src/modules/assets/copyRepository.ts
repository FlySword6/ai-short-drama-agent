import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { assetEntities, assetMedia, assetVariants } from "../../db/schema.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";

export interface PersonalAssetCopyResult {
  assetId: string;
  sourceAssetId: string;
  created: boolean;
  copiedVariantCount: number;
  copiedMediaCount: number;
}

/**
 * Creates an editable personal snapshot of a common asset. Media rows are
 * copied as references to the same TOS objects; bytes are never duplicated.
 * The partial unique index on owner + source makes retries idempotent.
 */
export class AssetCopyRepository {
  constructor(private readonly db: Database) {}

  async copyCommonToPersonal(
    actorId: string,
    sourceAssetId: string,
  ): Promise<PersonalAssetCopyResult> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const source = (await db.select().from(assetEntities).where(and(
        eq(assetEntities.id, sourceAssetId),
        eq(assetEntities.visibility, "common"),
        eq(assetEntities.status, "approved"),
        isNull(assetEntities.deletedAt),
      )).limit(1))[0];
      if (!source) throw new NotFoundError("通用资产不存在");
      if (source.copiedFromAssetEntityId) {
        throw new ConflictError(
          "导入没成：这项资产已经来自通用库，不能重复导入。",
          "asset_copy_source_is_copy",
        );
      }

      const existing = await findActiveCopy(db, actorId, source.id);
      if (existing) return summarizeCopy(db, existing.id, source.id, false);

      const now = new Date();
      const copyId = randomUUID();
      const created = (await db.insert(assetEntities).values({
        id: copyId,
        copiedFromAssetEntityId: source.id,
        sourceProjectId: source.sourceProjectId,
        sourceProjectName: source.sourceProjectName,
        ownerUserId: actorId,
        visibility: "personal",
        assetKind: source.assetKind,
        role: source.role,
        usageMode: source.usageMode,
        name: source.name,
        displayName: source.displayName,
        intro: source.intro,
        appearance: source.appearance,
        ageValue: source.ageValue,
        gender: source.gender,
        heightCm: source.heightCm,
        hairDescription: source.hairDescription,
        outfitDescription: source.outfitDescription,
        category: source.category,
        styleTags: source.styleTags,
        approved: true,
        reuseScope: source.reuseScope,
        status: "approved",
        sourceFileUrl: source.sourceFileUrl,
        metadata: withLineage(source.metadata, "common_asset_copy", source.id),
        createdAt: now,
        updatedAt: now,
        useCount: 0,
        deletedAt: null,
        deletedByUserId: null,
      }).onConflictDoNothing().returning({ id: assetEntities.id }))[0];

      if (!created) {
        const concurrent = await findActiveCopy(db, actorId, source.id);
        if (!concurrent) throw new Error("Failed to resolve concurrent asset copy");
        return summarizeCopy(db, concurrent.id, source.id, false);
      }

      const sourceVariants = await db.select().from(assetVariants).where(and(
        eq(assetVariants.assetEntityId, source.id),
        isNull(assetVariants.deletedAt),
      )).orderBy(asc(assetVariants.sortOrder), asc(assetVariants.createdAt));
      const variantIds = new Map<string, string>();
      if (sourceVariants.length) {
        await db.insert(assetVariants).values(sourceVariants.map((variant) => {
          const id = randomUUID();
          variantIds.set(variant.id, id);
          return {
            id,
            assetEntityId: copyId,
            variantKind: variant.variantKind,
            name: variant.name,
            description: variant.description,
            usageContext: variant.usageContext,
            visualPrompt: variant.visualPrompt,
            approved: true,
            status: "approved",
            isPrimary: variant.isPrimary,
            sortOrder: variant.sortOrder,
            sourceFileUrl: variant.sourceFileUrl,
            sourceText: variant.sourceText,
            metadata: withLineage(variant.metadata, "common_asset_variant_copy", variant.id),
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            deletedByUserId: null,
          };
        }));
      }

      const sourceMedia = await db.select().from(assetMedia).where(and(
        isNull(assetMedia.deletedAt),
        or(
          eq(assetMedia.assetEntityId, source.id),
          ...(sourceVariants.length
            ? [inArray(assetMedia.assetVariantId, sourceVariants.map((variant) => variant.id))]
            : []),
        ),
      )).orderBy(asc(assetMedia.sortOrder), asc(assetMedia.createdAt));
      if (sourceMedia.length) {
        await db.insert(assetMedia).values(sourceMedia.map((media) => ({
          id: randomUUID(),
          assetEntityId: media.assetEntityId ? copyId : null,
          assetVariantId: media.assetVariantId ? variantIds.get(media.assetVariantId) ?? null : null,
          mediaKind: media.mediaKind,
          viewAngle: media.viewAngle,
          title: media.title,
          description: media.description,
          storageBucket: media.storageBucket,
          storagePath: media.storagePath,
          storageUrl: media.storageUrl,
          widthPx: media.widthPx,
          heightPx: media.heightPx,
          format: media.format,
          sha256: media.sha256,
          isPrimary: media.isPrimary,
          approved: true,
          sortOrder: media.sortOrder,
          metadata: withLineage(media.metadata, "common_asset_media_reference", media.id),
          createdAt: now,
          deletedAt: null,
          deletedByUserId: null,
        })));
      }

      // 采用次数是排序代理指标，只在首次成功创建个人副本时累加。
      // 幂等重放和并发冲突返回既有副本，不得重复计数。
      await db.update(assetEntities).set({
        useCount: sql`${assetEntities.useCount} + 1`,
      }).where(eq(assetEntities.id, source.id));

      return {
        assetId: copyId,
        sourceAssetId: source.id,
        created: true,
        copiedVariantCount: sourceVariants.length,
        copiedMediaCount: sourceMedia.length,
      };
    });
  }
}

async function findActiveCopy(db: Database, actorId: string, sourceAssetId: string) {
  return (await db.select({ id: assetEntities.id }).from(assetEntities).where(and(
    eq(assetEntities.ownerUserId, actorId),
    eq(assetEntities.visibility, "personal"),
    eq(assetEntities.copiedFromAssetEntityId, sourceAssetId),
    isNull(assetEntities.deletedAt),
  )).limit(1))[0];
}

async function summarizeCopy(
  db: Database,
  assetId: string,
  sourceAssetId: string,
  created: boolean,
): Promise<PersonalAssetCopyResult> {
  const variants = await db.select({ id: assetVariants.id }).from(assetVariants).where(and(
    eq(assetVariants.assetEntityId, assetId),
    isNull(assetVariants.deletedAt),
  ));
  const media = await db.select({ id: assetMedia.id }).from(assetMedia).where(and(
    isNull(assetMedia.deletedAt),
    or(
      eq(assetMedia.assetEntityId, assetId),
      ...(variants.length ? [inArray(assetMedia.assetVariantId, variants.map((row) => row.id))] : []),
    ),
  ));
  return {
    assetId,
    sourceAssetId,
    created,
    copiedVariantCount: variants.length,
    copiedMediaCount: media.length,
  };
}

export function withLineage(
  metadata: Record<string, unknown>,
  relation: string,
  sourceId: string,
): Record<string, unknown> {
  return {
    ...metadata,
    source_lineage: {
      relation,
      source_id: sourceId,
    },
  };
}
