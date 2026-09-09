import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { assetEntities, assetMedia, assetVariants, type AssetEntityRow, type AssetMediaRow, type AssetVariantRow } from "../db/schema.js";

export class AssetSearchRepository {
  constructor(private readonly db: Database) {}

  async searchEntities(query: string, limit: number, userId?: string): Promise<AssetEntityRow[]> {
    const pattern = `%${escapeLike(query)}%`;
    return this.db
      .select()
      .from(assetEntities)
      .where(and(
        isNull(assetEntities.deletedAt),
        userId
          ? or(
            and(eq(assetEntities.visibility, "common"), eq(assetEntities.status, "approved")),
            eq(assetEntities.ownerUserId, userId),
          )
          : and(eq(assetEntities.visibility, "common"), eq(assetEntities.status, "approved")),
        or(
          ilike(assetEntities.name, pattern),
          ilike(assetEntities.displayName, pattern),
          ilike(assetEntities.sourceProjectName, pattern),
          sql`${assetEntities.styleTags} @> ${JSON.stringify([query])}::jsonb`,
        ),
      ))
      .limit(limit);
  }

  async searchVariants(query: string, limit: number): Promise<AssetVariantRow[]> {
    const pattern = `%${escapeLike(query)}%`;
    return this.db
      .select()
      .from(assetVariants)
      .where(or(
        ilike(assetVariants.name, pattern),
        ilike(assetVariants.description, pattern),
        ilike(assetVariants.usageContext, pattern),
        ilike(assetVariants.visualPrompt, pattern),
      ))
      .limit(limit);
  }

  async primaryMedia(input: { assetEntityId: string; assetVariantId?: string }): Promise<AssetMediaRow | undefined> {
    const conditions = [and(eq(assetMedia.assetEntityId, input.assetEntityId), isNotNull(assetMedia.storageUrl), isNull(assetMedia.deletedAt))];
    if (input.assetVariantId) {
      conditions.push(eq(assetMedia.assetVariantId, input.assetVariantId));
    }
    const rows = await this.db
      .select()
      .from(assetMedia)
      .where(and(...conditions))
      .orderBy(desc(assetMedia.isPrimary), asc(assetMedia.sortOrder), asc(assetMedia.createdAt))
      .limit(1);
    return rows[0];
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
