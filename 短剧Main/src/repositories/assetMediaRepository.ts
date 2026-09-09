import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  mediaProvenanceSubjects,
  type AssetMediaRow,
} from "../db/schema.js";
import type { JsonObject } from "../domain/assets/types.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";

export interface AssetMediaInput {
  assetEntityId: string;
  assetVariantId?: string | null;
  mediaKind: string;
  viewAngle?: string | null;
  title?: string | null;
  description?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  storageUrl?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  format?: string | null;
  sha256?: string | null;
  isPrimary: boolean;
  approved?: boolean | null;
  sortOrder: number;
  metadata?: JsonObject;
}

export class AssetMediaRepository {
  constructor(private readonly db: Database) {}

  async create(input: AssetMediaInput): Promise<AssetMediaRow> {
    return this.db.transaction(async (transaction) => {
      const id = crypto.randomUUID();
      const now = new Date();
      const entityRows = await transaction
        .select({ visibility: assetEntities.visibility })
        .from(assetEntities)
        .where(eq(assetEntities.id, input.assetEntityId))
        .limit(1);
      if (!entityRows[0]) throw new NotFoundError("资产不存在");
      if (input.assetVariantId) {
        const variantRows = await transaction
          .select({ assetEntityId: assetVariants.assetEntityId })
          .from(assetVariants)
          .where(and(
            eq(assetVariants.id, input.assetVariantId),
            isNull(assetVariants.deletedAt),
          ))
          .limit(1);
        if (variantRows[0]?.assetEntityId !== input.assetEntityId) {
          throw new ConflictError("资产变体不属于所选资产", "asset_variant_mismatch");
        }
      }
      const personal = entityRows[0]?.visibility === "personal";
      const rows = await transaction.insert(assetMedia).values({
        id,
        assetEntityId: input.assetEntityId,
        assetVariantId: input.assetVariantId ?? null,
        mediaKind: input.mediaKind,
        viewAngle: input.viewAngle ?? null,
        title: input.title ?? null,
        description: input.description ?? null,
        storageBucket: input.storageBucket ?? null,
        storagePath: input.storagePath ?? null,
        storageUrl: input.storageUrl ?? null,
        widthPx: input.widthPx ?? null,
        heightPx: input.heightPx ?? null,
        format: input.format ?? null,
        sha256: input.sha256 ?? null,
        isPrimary: input.isPrimary,
        approved: personal ? true : input.approved ?? null,
        sortOrder: input.sortOrder,
        metadata: input.metadata ?? {},
        createdAt: now,
      }).returning();
      const created = rows[0];
      if (!created) throw new Error("Failed to create asset media");
      // This repository is used only by workbook/image ingest. Those bytes
      // came from outside the generation system, so write the immutable
      // source fact in the same transaction instead of inferring it later
      // from mutable metadata.
      await transaction.insert(mediaProvenanceSubjects).values({
        assetMediaId: id,
        mediaResultId: null,
        sourceChannel: "external_upload",
        sourceGenerationAttemptId: null,
        providerAssetId: null,
        observedAt: now,
      });
      return created;
    });
  }

  async findById(id: string): Promise<AssetMediaRow | undefined> {
    const rows = await this.db
      .select()
      .from(assetMedia)
      .where(and(eq(assetMedia.id, id), isNull(assetMedia.deletedAt)))
      .limit(1);
    return rows[0];
  }
}
