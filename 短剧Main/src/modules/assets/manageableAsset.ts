import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { assetEntities, type AssetEntityRow } from "../../db/schema.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { canManageAsset, type AssetAccessRecord } from "./access.js";

export async function requireManageableAsset(
  db: Database,
  actorId: string,
  assetId: string,
): Promise<AssetEntityRow> {
  const [asset] = await db.select().from(assetEntities)
    .where(eq(assetEntities.id, assetId)).limit(1);
  return assertManageableAsset(asset, actorId);
}

/**
 * Serialises every primary-media change for one asset on the asset row.
 * This must be called inside the transaction that clears and selects primary
 * media, before checking the current owner and visibility.
 */
export async function lockAndRequireManageableAsset(
  db: Database,
  actorId: string,
  assetId: string,
): Promise<AssetEntityRow> {
  const [asset] = await db.select().from(assetEntities)
    .where(eq(assetEntities.id, assetId)).limit(1).for("update");
  return assertManageableAsset(asset, actorId);
}

function assertManageableAsset(
  asset: AssetEntityRow | undefined,
  actorId: string,
): AssetEntityRow {
  if (!asset || asset.deletedAt) throw new NotFoundError("资产不存在");
  if (asset.visibility !== "personal" && asset.visibility !== "common") {
    throw new ForbiddenError("修改资产没成：资产权限信息异常，请刷新后重试。");
  }
  const access: AssetAccessRecord = {
    id: asset.id,
    ownerUserId: asset.ownerUserId,
    visibility: asset.visibility,
    status: asset.status,
    deletedAt: asset.deletedAt,
  };
  if (!canManageAsset(access, actorId)) {
    throw new ForbiddenError(asset.visibility === "common"
      ? "通用资产为只读，不能修改"
      : "无权修改该资产");
  }
  return asset;
}
