export interface ProductionReviewAsset {
  id: string;
  name: string | null;
  visibility: string;
  status: string;
}

export type ProductionReviewDestination = "参考控制包" | "付费生成";

export interface ProductionReviewRejectionDetails {
  kind: "reference_asset_review_required";
  asset_entity_id: string;
  asset_media_id?: string;
  asset_name: string;
  review_status: string;
  review_status_label: string;
  destination: ProductionReviewDestination;
  display_message: string;
}

export interface ProductionReviewRejection {
  message: string;
  details: ProductionReviewRejectionDetails;
}

/**
 * Common-library assets are production inputs only after an explicit approval.
 * Personal assets stay outside this review gate; their ownership/project access
 * is enforced independently by each consuming repository.
 */
export function commonAssetReviewRejection(
  asset: ProductionReviewAsset,
  destination: ProductionReviewDestination,
  assetMediaId?: string,
): ProductionReviewRejection | null {
  if (asset.visibility !== "common" || asset.status === "approved") return null;
  const assetName = asset.name?.trim() || asset.id;
  const reviewStatusLabel = assetReviewStatusLabel(asset.status);
  const message = `资产《${assetName}》尚未通过审核（当前：${reviewStatusLabel}），不能用于${destination}，请先完成通用资产审核`;
  return {
    message,
    details: {
      kind: "reference_asset_review_required",
      asset_entity_id: asset.id,
      ...(assetMediaId ? { asset_media_id: assetMediaId } : {}),
      asset_name: assetName,
      review_status: asset.status,
      review_status_label: reviewStatusLabel,
      destination,
      display_message: message,
    },
  };
}

/** Compatibility projection for callers that only need the display copy. */
export function commonAssetReviewRejectionMessage(
  asset: ProductionReviewAsset,
  destination: ProductionReviewDestination,
): string | null {
  return commonAssetReviewRejection(asset, destination)?.message ?? null;
}

export function assetReviewStatusLabel(status: string): string {
  switch (status) {
    case "automatic_review":
      return "自动审核中";
    case "pending_review":
      return "待审核";
    case "rejected":
      return "已拒绝";
    case "approved":
      return "已通过";
    default:
      return "状态异常";
  }
}
