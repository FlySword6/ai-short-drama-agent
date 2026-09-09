/**
 * Seedance 2.0 参考物提交前预检(合同 docs/contracts/v0.2.0/rough-cut-generation-mapping.md
 * 第三节「参考图约束」):宽高比 [0.4, 2.5]、边长 [300, 6000]px、≤30MB。
 *
 * 当前 schema 可检项只有图片尺寸(asset_media.width_px/height_px,可空);
 * 字节大小与音视频时长没有持久化字段,不可测,已在
 * docs/validation/v0.2.0-generation-mapping-fix-handoff.md 登记。
 * 尺寸未知的历史资产放行(API 会自行拒绝,此处不阻断存量)。
 */
export const REFERENCE_IMAGE_MIN_EDGE_PX = 300;
export const REFERENCE_IMAGE_MAX_EDGE_PX = 6000;
export const REFERENCE_IMAGE_MIN_ASPECT_RATIO = 0.4;
export const REFERENCE_IMAGE_MAX_ASPECT_RATIO = 2.5;

export interface ReferenceImageDimension {
  widthPx: number | null;
  heightPx: number | null;
}

/** Returns a human-readable violation message, or null when the image passes. */
export function referenceImageViolation(media: ReferenceImageDimension): string | null {
  const { widthPx, heightPx } = media;
  if (!widthPx || !heightPx || widthPx <= 0 || heightPx <= 0) return null;
  if (widthPx < REFERENCE_IMAGE_MIN_EDGE_PX || heightPx < REFERENCE_IMAGE_MIN_EDGE_PX) {
    return `参考图边长不能小于 ${REFERENCE_IMAGE_MIN_EDGE_PX}px(当前 ${widthPx}×${heightPx})`;
  }
  if (widthPx > REFERENCE_IMAGE_MAX_EDGE_PX || heightPx > REFERENCE_IMAGE_MAX_EDGE_PX) {
    return `参考图边长不能超过 ${REFERENCE_IMAGE_MAX_EDGE_PX}px(当前 ${widthPx}×${heightPx})`;
  }
  const ratio = widthPx / heightPx;
  if (ratio < REFERENCE_IMAGE_MIN_ASPECT_RATIO || ratio > REFERENCE_IMAGE_MAX_ASPECT_RATIO) {
    return `参考图宽高比需在 ${REFERENCE_IMAGE_MIN_ASPECT_RATIO}~${REFERENCE_IMAGE_MAX_ASPECT_RATIO} 之间(当前 ${widthPx}×${heightPx})`;
  }
  return null;
}
