import ExcelJS from "exceljs";
import { extensionOf } from "../shared/files.js";

export interface ExcelImageFile {
  sheetName: string;
  imageIndex: number;
  content: Buffer;
  extension: string;
  contentType: string;
}

interface RawExcelImage {
  buffer?: ArrayBuffer | Uint8Array;
  extension?: string;
}

export class ExcelImageExtractor {
  async extractOne(buffer: Buffer, sheetName: string, imageIndex: number, fileName = "upload.xlsx"): Promise<ExcelImageFile> {
    const workbook = new ExcelJS.Workbook();
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    await workbook.xlsx.load(arrayBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) throw new Error(`Excel sheet not found: ${sheetName}`);
    const image = this.extractFromWorkbook(workbook, worksheet, imageIndex, fileName);
    if (!image) {
      throw new RangeError(`image_index out of range: ${imageIndex}, sheet=${sheetName}, image_count=${worksheet.getImages().length}`);
    }
    return { ...image, sheetName, imageIndex };
  }

  extractFromWorkbook(
    workbook: ExcelJS.Workbook,
    worksheet: ExcelJS.Worksheet,
    imageIndex: number,
    fileName = "upload.xlsx",
  ): Omit<ExcelImageFile, "sheetName" | "imageIndex"> | null {
    const image = worksheet.getImages()[imageIndex];
    if (!image) return null;
    const raw = workbook.getImage(Number(image.imageId)) as unknown as RawExcelImage;
    if (!raw.buffer) return null;
    const extension = normalizeExtension(raw.extension ?? extensionOf(fileName).slice(1));
    return {
      content: raw.buffer instanceof Uint8Array
        ? Buffer.from(raw.buffer)
        : Buffer.from(new Uint8Array(raw.buffer)),
      extension: `.${extension}`,
      contentType: contentTypeFor(extension),
    };
  }
}

function normalizeExtension(value: string): string {
  const extension = value.toLowerCase().replace(/^\./, "").trim() || "png";
  return extension === "jpeg" ? "jpg" : extension;
}

function contentTypeFor(extension: string): string {
  const mapping: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mapping[extension] ?? "application/octet-stream";
}
