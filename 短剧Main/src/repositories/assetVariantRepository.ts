import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { assetEntities, assetVariants, type AssetVariantRow } from "../db/schema.js";
import type { AssetVariantData, JsonObject } from "../domain/assets/types.js";

export class AssetVariantRepository {
  constructor(private readonly db: Database) {}

  async getByUniqueKey(input: {
    assetEntityId: string;
    variantKind: string;
    name: string;
  }): Promise<AssetVariantRow | undefined> {
    const rows = await this.db
      .select()
      .from(assetVariants)
      .where(and(
        eq(assetVariants.assetEntityId, input.assetEntityId),
        eq(assetVariants.variantKind, input.variantKind),
        eq(assetVariants.name, input.name),
      ))
      .limit(1);
    return rows[0];
  }

  async getByIds(ids: string[]): Promise<AssetVariantRow[]> {
    if (!ids.length) return [];
    return this.db.select().from(assetVariants).where(inArray(assetVariants.id, ids));
  }

  async save(input: AssetVariantData): Promise<AssetVariantRow> {
    const existing = await this.getByUniqueKey(input);
    const entityRows = await this.db
      .select({ visibility: assetEntities.visibility })
      .from(assetEntities)
      .where(eq(assetEntities.id, input.assetEntityId))
      .limit(1);
    const personal = entityRows[0]?.visibility === "personal";
    const now = new Date();
    const values = {
      assetEntityId: input.assetEntityId,
      variantKind: input.variantKind,
      name: input.name,
      description: input.description ?? null,
      usageContext: input.usageContext ?? null,
      visualPrompt: input.visualPrompt ?? null,
      approved: personal ? true : input.approved ?? null,
      status: personal ? "approved" : input.status ?? "pending_review",
      isPrimary: input.isPrimary ?? false,
      sortOrder: input.sortOrder ?? 0,
      sourceFileUrl: input.sourceFileUrl ?? null,
      sourceText: input.sourceText ?? null,
      metadata: input.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      const rows = await this.db.update(assetVariants).set(values).where(eq(assetVariants.id, existing.id)).returning();
      const updated = rows[0];
      if (!updated) throw new Error("Failed to update asset variant");
      return updated;
    }

    const rows = await this.db.insert(assetVariants).values({ id: crypto.randomUUID(), ...values }).returning();
    const created = rows[0];
    if (!created) throw new Error("Failed to create asset variant");
    return created;
  }

  toData(row: AssetVariantRow): AssetVariantData {
    return {
      id: row.id,
      assetEntityId: row.assetEntityId,
      variantKind: row.variantKind,
      name: row.name,
      description: row.description,
      usageContext: row.usageContext,
      visualPrompt: row.visualPrompt,
      approved: row.approved,
      status: row.status,
      isPrimary: row.isPrimary,
      sortOrder: row.sortOrder,
      sourceFileUrl: row.sourceFileUrl,
      sourceText: row.sourceText,
      metadata: row.metadata as JsonObject,
    };
  }
}
