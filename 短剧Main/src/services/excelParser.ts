import ExcelJS from "exceljs";
import type { UploadedImage } from "../domain/assets/types.js";
import { extensionOf } from "../shared/files.js";
import { textValue } from "../shared/values.js";
import { ExcelImageExtractor } from "./excelImageExtractor.js";

export interface ExcelRowImage extends UploadedImage {
  buffer: Buffer;
}

export interface ExcelAssetRow {
  sheetName: string;
  sourceFileName: string;
  rowNumber: number;
  fields: Record<string, string>;
  images: ExcelRowImage[];
}

export class ExcelAssetParser {
  private readonly imageExtractor = new ExcelImageExtractor();

  async parse(buffer: Buffer, fileName: string): Promise<ExcelAssetRow[]> {
    const workbook = new ExcelJS.Workbook();
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const data = arrayBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(data);
    const rows: ExcelAssetRow[] = [];

    for (const worksheet of workbook.worksheets) {
      if (this.shouldSkipSheet(worksheet.name)) continue;
      const matrix = this.readSheet(worksheet);
      const headerIndex = this.findHeaderRow(matrix);
      if (headerIndex < 0) continue;
      const headers = matrix[headerIndex] ?? [];
      const pending: Array<{ rowNumber: number; fields: Record<string, string> }> = [];
      for (let index = headerIndex + 1; index < matrix.length; index += 1) {
        const values = matrix[index] ?? [];
        const fields = this.buildFields(headers, values);
        if (Object.values(fields).some(Boolean)) pending.push({ rowNumber: index + 1, fields });
      }
      const validRowNumbers = pending.map((item) => item.rowNumber);
      const imagesByRow = this.readImages(workbook, worksheet, fileName, headers, validRowNumbers);
      rows.push(...pending.map((item) => ({
        sheetName: worksheet.name,
        sourceFileName: fileName,
        rowNumber: item.rowNumber,
        fields: item.fields,
        images: imagesByRow.get(item.rowNumber) ?? [],
      })));
    }
    return rows;
  }

  private readSheet(worksheet: ExcelJS.Worksheet): string[][] {
    const rows: string[][] = [];
    for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const values: string[] = [];
      for (let column = 1; column <= worksheet.columnCount; column += 1) {
        values.push(cellText(row.getCell(column)));
      }
      rows.push(values);
    }
    return rows;
  }

  private findHeaderRow(rows: string[][]): number {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    rows.slice(0, 30).forEach((row, index) => {
      const cells = row.filter(Boolean);
      if (!cells.length) return;
      const shortCount = cells.filter((cell) => cell.length <= 30).length;
      const longCount = cells.filter((cell) => cell.length > 80).length;
      const uniqueCount = new Set(cells).size;
      const duplicateCount = cells.length - uniqueCount;
      let score = cells.length * 2 + shortCount - longCount * 4 - duplicateCount * 5;
      if (cells.length <= 2) score -= 10;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  private buildFields(headers: string[], values: string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    headers.forEach((header, index) => {
      const value = values[index] ?? "";
      if (header && value) fields[header] = value;
    });
    return fields;
  }

  private readImages(
    workbook: ExcelJS.Workbook,
    worksheet: ExcelJS.Worksheet,
    fileName: string,
    headers: string[],
    validRowNumbers: number[],
  ): Map<number, ExcelRowImage[]> {
    const result = new Map<number, ExcelRowImage[]>();
    worksheet.getImages().forEach((image, imageIndex) => {
      const extracted = this.imageExtractor.extractFromWorkbook(workbook, worksheet, imageIndex, fileName);
      if (!extracted) return;
      const topLeft = image.range?.tl;
      if (!topLeft || !validRowNumbers.length) return;
      const bottomRight = image.range?.br;
      const centerRow = ((topLeft.row + (bottomRight?.row ?? topLeft.row)) / 2) + 1;
      const rowNumber = validRowNumbers.reduce((nearest, candidate) =>
        Math.abs(candidate - centerRow) < Math.abs(nearest - centerRow) ? candidate : nearest,
      validRowNumbers[0] ?? 1);
      const columnNumber = Math.floor(topLeft.col) + 1;
      const extension = extracted.extension || `.${extensionOf(fileName).slice(1) || "jpg"}`;
      const item: ExcelRowImage = {
        buffer: extracted.content,
        fileName: `${worksheet.name}-${imageIndex}${extension}`,
        contentType: extracted.contentType,
        extension,
        sheetName: worksheet.name,
        row: rowNumber,
        col: columnNumber,
        columnHeader: headers[columnNumber - 1] ?? "",
        imageIndex,
      };
      const existing = result.get(rowNumber) ?? [];
      existing.push(item);
      result.set(rowNumber, existing);
    });
    return result;
  }

  private shouldSkipSheet(name: string): boolean {
    return ["使用说明", "说明", "README", "readme"].some((keyword) => name.includes(keyword));
  }
}

function cellText(cell: ExcelJS.Cell): string {
  let value: unknown = cell.value;
  const master = (cell as ExcelJS.Cell & { master?: ExcelJS.Cell }).master;
  if ((value === null || value === undefined) && master) value = master.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("result" in value) return textValue(value.result);
    if ("text" in value) return textValue(value.text);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => ("text" in item ? textValue(item.text) : "")).join("").trim();
    }
  }
  return textValue(value);
}
