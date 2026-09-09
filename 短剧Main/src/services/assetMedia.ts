import type { AssetMediaInput } from "../repositories/assetMediaRepository.js";
import type { StoredImage } from "../domain/assets/types.js";

export function detectMediaKind(assetKind: string, columnHeader?: string): string {
  const header = columnHeader ?? "";
  if (assetKind === "character") {
    if (header.includes("人设图") || header.includes("人物设定") || header.includes("定稿") || header.includes("定妆")) return "character_final";
    if (header.includes("三视图") || header.includes("多视图")) return "character_turnaround";
    if (header.includes("服装") || header.includes("服饰")) return "costume_reference";
  }
  if (assetKind === "scene") {
    if (header.includes("定稿") || header.includes("定妆")) return "scene_final";
    if (header.includes("多视图") || header.includes("三视图")) return "scene_multi_view";
    if (header.includes("参考")) return "scene_reference";
  }
  if (header.includes("服装") || header.includes("服饰")) return "costume_reference";
  return "other";
}

export function mediaSortOrder(kind: string, current: number): number {
  if (["character_final", "scene_final"].includes(kind)) return 100 + current;
  if (["character_turnaround", "scene_multi_view"].includes(kind)) return 200 + current;
  if (kind === "costume_reference") return 300 + current;
  if (kind === "scene_reference") return 400 + current;
  return 900 + current;
}

export function buildMediaInput(
  entityId: string,
  asset: { assetKind: string; name: string; approved?: boolean | null; sourceProjectName?: string | null },
  image: StoredImage,
  assetVariantId?: string | null,
): AssetMediaInput {
  const mediaKind = detectMediaKind(asset.assetKind, image.columnHeader);
  const label = (image.columnHeader ?? "图片").replace(/[：:()（）]/g, "").replaceAll("按需", "").trim() || "图片";
  const projectName = normalizeProjectName(asset.sourceProjectName);
  return {
    assetEntityId: entityId,
    assetVariantId: assetVariantId ?? null,
    mediaKind,
    viewAngle: "unknown",
    title: `${asset.name}${label}`,
    description: `来自${projectName}${image.sheetName ?? "未知表"}的${asset.name}${label}`,
    storageBucket: image.storageBucket,
    storagePath: image.storagePath,
    storageUrl: image.storageUrl,
    widthPx: image.width,
    heightPx: image.height,
    format: image.format,
    sha256: image.sha256,
    isPrimary: Boolean(image.isPrimary),
    approved: asset.approved,
    sortOrder: mediaSortOrder(mediaKind, image.sortOrder ?? 0),
    metadata: {
      source_project_name: asset.sourceProjectName ?? null,
      source_sheet_name: image.sheetName ?? null,
      source_row_number: image.row ?? null,
      source_col_number: image.col ?? null,
      column_header: image.columnHeader ?? null,
      image_index: image.imageIndex ?? null,
    },
  };
}

function normalizeProjectName(sourceProjectName?: string | null): string {
  const name = sourceProjectName?.trim() || "未知项目";
  return name.startsWith("《") && name.endsWith("》") ? name : `《${name}》`;
}
