import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { assetEntities, type AssetEntityRow } from "../db/schema.js";
import type { AssetEntityData, JsonObject } from "../domain/assets/types.js";

function rowToData(row: AssetEntityRow): AssetEntityData {
  return {
    id: row.id,
    sourceProjectId: row.sourceProjectId,
    sourceProjectName: row.sourceProjectName,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility as "personal" | "common",
    assetKind: row.assetKind,
    role: row.role as AssetEntityData["role"],
    usageMode: row.usageMode as AssetEntityData["usageMode"],
    name: row.name,
    displayName: row.displayName,
    intro: row.intro,
    appearance: row.appearance,
    ageValue: row.ageValue,
    gender: row.gender,
    heightCm: row.heightCm,
    hairDescription: row.hairDescription,
    outfitDescription: row.outfitDescription,
    category: row.category,
    styleTags: row.styleTags,
    approved: row.approved,
    reuseScope: row.reuseScope,
    status: row.status,
    sourceFileUrl: row.sourceFileUrl,
    metadata: row.metadata as JsonObject,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    useCount: row.useCount,
    deletedAt: row.deletedAt,
    deletedByUserId: row.deletedByUserId,
  };
}

export class AssetEntityRepository {
  constructor(private readonly db: Database) {}

  async getById(id: string): Promise<AssetEntityRow | undefined> {
    const rows = await this.db
      .select()
      .from(assetEntities)
      .where(eq(assetEntities.id, id))
      .limit(1);
    return rows[0];
  }

  async getByIds(ids: string[]): Promise<AssetEntityRow[]> {
    if (!ids.length) return [];
    return this.db.select().from(assetEntities).where(inArray(assetEntities.id, ids));
  }

  async getByUniqueKey(input: {
    sourceProjectId?: string | null;
    ownerUserId?: string | null;
    assetKind: string;
    name: string;
  }): Promise<AssetEntityRow | undefined> {
    const projectCondition = input.sourceProjectId
      ? eq(assetEntities.sourceProjectId, input.sourceProjectId)
      : isNull(assetEntities.sourceProjectId);
    const ownerCondition = input.ownerUserId
      ? eq(assetEntities.ownerUserId, input.ownerUserId)
      : isNull(assetEntities.ownerUserId);
    const rows = await this.db
      .select()
      .from(assetEntities)
      .where(and(ownerCondition, projectCondition, eq(assetEntities.assetKind, input.assetKind), eq(assetEntities.name, input.name)))
      .limit(1);
    return rows[0];
  }

  async save(asset: AssetEntityData): Promise<AssetEntityRow> {
    if (!asset.name.trim()) throw new Error("Asset name cannot be empty");
    const existing = await this.getByUniqueKey({
      sourceProjectId: asset.sourceProjectId,
      ownerUserId: asset.ownerUserId,
      assetKind: asset.assetKind,
      name: asset.name,
    });
    const now = new Date();
    const visibility = asset.visibility ?? "personal";
    const personal = visibility === "personal";
    const values = {
      sourceProjectId: asset.sourceProjectId ?? null,
      sourceProjectName: asset.sourceProjectName ?? null,
      ownerUserId: asset.ownerUserId ?? null,
      visibility,
      assetKind: asset.assetKind,
      // Older CLI/ingest callers do not send control fields. Re-ingesting the
      // same logical asset must not erase a classification that a human added
      // later. An explicit null still clears the field.
      role: asset.role === undefined ? existing?.role ?? null : asset.role,
      usageMode: asset.usageMode === undefined ? existing?.usageMode ?? null : asset.usageMode,
      name: asset.name,
      displayName: asset.displayName ?? asset.name,
      intro: asset.intro ?? null,
      appearance: asset.appearance ?? null,
      ageValue: asset.ageValue ?? null,
      gender: asset.gender ?? null,
      heightCm: asset.heightCm ?? null,
      hairDescription: asset.hairDescription ?? null,
      outfitDescription: asset.outfitDescription ?? null,
      category: asset.category ?? null,
      styleTags: asset.styleTags ?? [],
      approved: personal ? true : asset.approved ?? null,
      reuseScope: asset.reuseScope ?? "all_projects",
      status: personal ? "approved" : asset.status ?? "pending_review",
      sourceFileUrl: asset.sourceFileUrl ?? null,
      metadata: asset.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      useCount: existing?.useCount ?? 0,
      deletedAt: existing?.deletedAt ?? null,
      deletedByUserId: existing?.deletedByUserId ?? null,
    };

    if (existing) {
      // 上面那次 getByUniqueKey 到这次 UPDATE 之间，审核或删除事务可能已经提交。
      // 把这些字段指回目标行本身，避免重新入库时用查询时刻的旧快照覆写更新的事实。
      // 个人资产不参与审核状态机（见 041 迁移），所以只有通用资产需要这层保护。
      const reviewFacts = personal
        ? { approved: values.approved, status: values.status }
        : { approved: sql`${assetEntities.approved}`, status: sql`${assetEntities.status}` };
      const rows = await this.db
        .update(assetEntities)
        .set({
          ...values,
          ...reviewFacts,
          role: asset.role === undefined ? sql`${assetEntities.role}` : values.role,
          usageMode: asset.usageMode === undefined ? sql`${assetEntities.usageMode}` : values.usageMode,
          deletedAt: sql`${assetEntities.deletedAt}`,
          deletedByUserId: sql`${assetEntities.deletedByUserId}`,
          useCount: sql`${assetEntities.useCount}`,
        })
        .where(eq(assetEntities.id, existing.id))
        .returning();
      const updated = rows[0];
      if (!updated) throw new Error("Failed to update asset entity");
      return updated;
    }

    const rows = await this.db
      .insert(assetEntities)
      .values({ id: crypto.randomUUID(), ...values })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("Failed to create asset entity");
    return created;
  }

  toData(row: AssetEntityRow): AssetEntityData {
    return rowToData(row);
  }
}
