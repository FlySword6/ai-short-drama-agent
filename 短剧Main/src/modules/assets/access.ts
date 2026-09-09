export type AssetVisibility = "personal" | "common";

export interface AssetAccessRecord {
  id: string;
  ownerUserId: string | null;
  visibility: AssetVisibility;
  status: string;
  deletedAt: Date | null;
}

export interface AssetDeletionReferences {
  activeProjectReferences: number;
  activeShotReferences: number;
  selectedMediaReferences: number;
  deliveryReferences: number;
}

export function canViewAsset(
  asset: AssetAccessRecord,
  actorId: string,
  includeTrash = false,
  allowUnapprovedCommon = false,
): boolean {
  if (asset.deletedAt && !includeTrash) return false;
  if (asset.visibility === "common") {
    return allowUnapprovedCommon || asset.status === "approved";
  }
  return asset.ownerUserId === actorId;
}

export function canReferenceAsset(asset: AssetAccessRecord, actorId: string): boolean {
  return !asset.deletedAt && canViewAsset(asset, actorId);
}

export function canManageAsset(asset: AssetAccessRecord, actorId: string): boolean {
  return asset.visibility === "personal" && asset.ownerUserId === actorId;
}

export function permanentDeletionBlockers(references: AssetDeletionReferences): string[] {
  const blockers: string[] = [];
  if (references.activeProjectReferences > 0) blockers.push("仍被项目引用");
  if (references.activeShotReferences > 0) blockers.push("仍被分镜引用");
  if (references.selectedMediaReferences > 0) blockers.push("仍是分镜主版本");
  if (references.deliveryReferences > 0) blockers.push("仍在交付记录中");
  return blockers;
}

export function assertCanViewAsset(asset: AssetAccessRecord, actorId: string, includeTrash = false): void {
  if (!canViewAsset(asset, actorId, includeTrash)) throw new Error("无权查看该资产");
}

export function assertCanReferenceAsset(asset: AssetAccessRecord, actorId: string): void {
  if (!canReferenceAsset(asset, actorId)) throw new Error("该资产不可引用");
}

export function assertCanManageAsset(asset: AssetAccessRecord, actorId: string): void {
  if (!canManageAsset(asset, actorId)) throw new Error("无权修改该资产");
}
