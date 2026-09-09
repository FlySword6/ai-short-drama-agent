import { createHash } from "node:crypto";
import sharp from "sharp";
import type { AssetEntityData, StoredImage } from "../domain/assets/types.js";
import { TosStorage } from "../integrations/tosStorage.js";
import { safePathPart } from "../shared/files.js";
import { mapConcurrent } from "../shared/concurrency.js";
import type { ExcelAssetRow, ExcelRowImage } from "./excelParser.js";

const IMAGE_UPLOAD_CONCURRENCY = 8;

export class ExcelImageUploadService {
  constructor(private readonly tos: TosStorage = new TosStorage()) {}

  async uploadRowImages(row: ExcelAssetRow, asset: AssetEntityData): Promise<StoredImage[]> {
    const primaryIndex = choosePrimaryImageIndex(row.images);
    const uploaded = await mapConcurrent(row.images, IMAGE_UPLOAD_CONCURRENCY, async (image, index) =>
      this.uploadSingle(row, asset, image, index, primaryIndex),
    );
    return uploaded.filter((item): item is StoredImage => item !== null);
  }

  async uploadSingle(
    row: ExcelAssetRow,
    asset: AssetEntityData,
    image: ExcelRowImage | undefined,
    index: number,
    primaryIndex: number,
  ): Promise<StoredImage | null> {
    if (!image) return null;
    const sha256 = createHash("sha256").update(image.buffer).digest("hex");
    const info = await imageInfo(image.buffer);
    const storagePath = buildStoragePath(row, asset, image, index);
    const stored = await this.tos.uploadBytes(
      image.buffer,
      storagePath,
      image.contentType ?? "application/octet-stream",
    );
    return {
      ...image,
      storageBucket: stored.bucket,
      storagePath: stored.storagePath,
      storageUrl: stored.storageUrl,
      width: info.width,
      height: info.height,
      format: info.format ?? image.extension.slice(1),
      sha256,
      isPrimary: index === primaryIndex,
      sortOrder: index,
    };
  }
}

export { choosePrimaryImageIndex as chooseRowPrimaryIndex };

export function choosePrimaryImageIndex(images: readonly ExcelRowImage[]): number {
  const primaryByDesign = images.findIndex((image) => {
    const header = image.columnHeader ?? "";
    return header.includes("人设图") && (header.includes("定稿") || header.includes("定妆"));
  });
  if (primaryByDesign >= 0) return primaryByDesign;
  const primaryByFinal = images.findIndex((image) => {
    const header = image.columnHeader ?? "";
    return header.includes("定稿") || header.includes("定妆");
  });
  return primaryByFinal >= 0 ? primaryByFinal : 0;
}

function buildStoragePath(row: ExcelAssetRow, asset: AssetEntityData, image: ExcelRowImage, index: number): string {
  const extension = image.extension.startsWith(".") ? image.extension : `.${image.extension}`;
  return [
    "prod",
    "asset",
    safePathPart(asset.sourceProjectName ?? "unknown"),
    safePathPart(asset.name),
    `${safePathPart(row.sheetName)}_row_${row.rowNumber}_${safePathPart(image.columnHeader ?? "image")}_image_${image.imageIndex ?? index}${extension}`,
  ].join("/");
}

async function imageInfo(content: Buffer): Promise<{ width: number | null; height: number | null; format: string | null }> {
  try {
    const info = await sharp(content).metadata();
    return { width: info.width ?? null, height: info.height ?? null, format: info.format ?? null };
  } catch {
    return { width: null, height: null, format: null };
  }
}
