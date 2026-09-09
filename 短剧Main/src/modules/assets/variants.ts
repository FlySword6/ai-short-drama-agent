import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { assetEntities, assetVariants } from "../../db/schema.js";
import type { AssetVariantData, JsonObject } from "../../domain/assets/types.js";
import { AssetEntityRepository } from "../../repositories/assetEntityRepository.js";
import { AssetVariantRepository } from "../../repositories/assetVariantRepository.js";
import { VectorSyncService } from "../../services/vectorSyncService.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { canViewAsset, type AssetAccessRecord } from "./access.js";
import { lockAndRequireManageableAsset } from "./manageableAsset.js";

export interface CreateAssetVariantInput {
  actorId: string;
  assetId: string;
  name: string;
  variantKind: string;
  description?: string | null;
  usageContext?: string | null;
  visualPrompt?: string | null;
  isPrimary: boolean;
  sortOrder: number;
  episodeNos?: number[];
}

export interface AssetVariantServiceDependencies {
  vectorSync?: Pick<VectorSyncService, "syncVariant">;
}

/**
 * 人设变体的写入与读取。变体是资产的子对象:写入串行在资产行锁上,
 * is_primary 部分唯一索引(asset_entity_id, variant_kind)要求同事物同
 * 类主标记先清后立。向量同步是搜索旁路,失败不允许拖垮写入。
 */
export class AssetVariantService {
  private readonly vectorSync: Pick<VectorSyncService, "syncVariant">;

  constructor(
    private readonly db: Database,
    dependencies: AssetVariantServiceDependencies = {},
  ) {
    this.vectorSync = dependencies.vectorSync ?? new VectorSyncService();
  }

  async list(actorId: string, assetId: string): Promise<AssetVariantData[]> {
    await this.requireVisible(actorId, assetId);
    const repository = new AssetVariantRepository(this.db);
    const rows = await this.db.select().from(assetVariants).where(and(
      eq(assetVariants.assetEntityId, assetId),
      isNull(assetVariants.deletedAt),
    )).orderBy(asc(assetVariants.sortOrder), asc(assetVariants.createdAt));
    return rows.map((row) => repository.toData(row));
  }

  async create(input: CreateAssetVariantInput): Promise<AssetVariantData> {
    const { variant, parent } = await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const parentRow = await lockAndRequireManageableAsset(db, input.actorId, input.assetId);
      if (input.isPrimary) {
        await db.update(assetVariants).set({ isPrimary: false, updatedAt: new Date() }).where(and(
          eq(assetVariants.assetEntityId, input.assetId),
          eq(assetVariants.variantKind, input.variantKind),
          eq(assetVariants.isPrimary, true),
          isNull(assetVariants.deletedAt),
        ));
      }
      const repository = new AssetVariantRepository(db);
      const metadata: JsonObject = {};
      if (input.episodeNos?.length) metadata.episode_nos = input.episodeNos;
      const personal = parentRow.visibility === "personal";
      const row = await repository.save({
        assetEntityId: input.assetId,
        variantKind: input.variantKind,
        name: input.name,
        description: input.description ?? null,
        usageContext: input.usageContext ?? null,
        visualPrompt: input.visualPrompt ?? null,
        approved: personal ? true : null,
        status: personal ? "approved" : "pending_review",
        isPrimary: input.isPrimary,
        sortOrder: input.sortOrder,
        metadata,
      });
      return { variant: repository.toData(row), parent: new AssetEntityRepository(db).toData(parentRow) };
    });
    await this.vectorSync.syncVariant(variant, parent).catch((error: unknown) => {
      console.error("[asset-variant] vector sync failed", error);
    });
    return variant;
  }

  private async requireVisible(actorId: string, assetId: string): Promise<void> {
    const [asset] = await this.db.select({
      id: assetEntities.id,
      ownerUserId: assetEntities.ownerUserId,
      visibility: assetEntities.visibility,
      status: assetEntities.status,
      deletedAt: assetEntities.deletedAt,
    }).from(assetEntities).where(eq(assetEntities.id, assetId)).limit(1);
    if (!asset || asset.deletedAt) throw new NotFoundError("资产不存在");
    if (asset.visibility !== "personal" && asset.visibility !== "common") {
      throw new ForbiddenError("查看资产没成：资产权限信息异常，请刷新后重试。");
    }
    const record: AssetAccessRecord = {
      id: asset.id,
      ownerUserId: asset.ownerUserId,
      visibility: asset.visibility,
      status: asset.status,
      deletedAt: asset.deletedAt,
    };
    if (!canViewAsset(record, actorId)) throw new ForbiddenError("无权查看该资产");
  }
}
