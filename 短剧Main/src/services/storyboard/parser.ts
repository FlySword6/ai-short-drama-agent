import ExcelJS from "exceljs";
import JSZip from "jszip";
import { StoryboardFieldMapper } from "./fieldMapper.js";
import { StoryboardHeaderMapper } from "./headerMapper.js";
import type { StoryboardExcelRow } from "./types.js";

const SPREADSHEET_MAIN_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

export interface StoryboardParserDependencies {
  headerMapper?: StoryboardHeaderMapper;
  fieldMapper?: StoryboardFieldMapper;
}

export class StoryboardExcelParser {
  private readonly headerMapper: StoryboardHeaderMapper;
  private readonly fieldMapper: StoryboardFieldMapper;

  constructor(dependencies: StoryboardParserDependencies = {}) {
    this.headerMapper = dependencies.headerMapper ?? new StoryboardHeaderMapper();
    this.fieldMapper = dependencies.fieldMapper ?? new StoryboardFieldMapper();
  }

  async parse(buffer: Buffer): Promise<StoryboardExcelRow[]> {
    const workbook = new ExcelJS.Workbook();
    const compatibleBuffer = await normalizeSpreadsheetNamespacePrefixes(buffer);
    const arrayBuffer = compatibleBuffer.buffer.slice(
      compatibleBuffer.byteOffset,
      compatibleBuffer.byteOffset + compatibleBuffer.byteLength,
    ) as ArrayBuffer;
    const data = arrayBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(data);
    const result: StoryboardExcelRow[] = [];
    for (const worksheet of workbook.worksheets) {
      const headerResult = this.findHeaderRow(worksheet);
      if (!headerResult) continue;
      const [headerRow, headers] = headerResult;
      const headerMap = await this.headerMapper.mapHeaders(worksheet.name, headers);
      for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const fields = this.readRow(worksheet, rowNumber, headers);
        if (!Object.values(fields).some(Boolean)) continue;
        result.push(this.fieldMapper.mapFields(worksheet.name, rowNumber, fields, headerMap));
      }
    }
    return result;
  }

  private findHeaderRow(worksheet: ExcelJS.Worksheet): [number, string[]] | null {
    const maxScanRows = Math.min(worksheet.rowCount, 10);
    for (let rowNumber = 1; rowNumber <= maxScanRows; rowNumber += 1) {
      const headers = this.readHeaders(worksheet, rowNumber);
      if (headers.length >= 3 && this.isStoryboardSheet(worksheet.name, headers)) return [rowNumber, headers];
    }
    return null;
  }

  private readHeaders(worksheet: ExcelJS.Worksheet, rowNumber: number): string[] {
    const row = worksheet.getRow(rowNumber);
    const headers: string[] = [];
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const value = cellText(row.getCell(column).value);
      if (value) headers.push(value);
    }
    return headers;
  }

  private readRow(worksheet: ExcelJS.Worksheet, rowNumber: number, headers: string[]): Record<string, string> {
    const row = worksheet.getRow(rowNumber);
    const fields: Record<string, string> = {};
    for (let column = 1; column <= headers.length; column += 1) {
      const header = headers[column - 1];
      if (!header) continue;
      fields[header] = cellText(row.getCell(column).value);
    }
    return fields;
  }

  private isStoryboardSheet(sheetName: string, headers: string[]): boolean {
    if (sheetName.includes("分镜")) return true;
    const text = headers.join(" ");
    const keywords = ["镜号", "镜头", "画面", "台词", "场景", "视角", "音效"];
    return keywords.filter((keyword) => text.includes(keyword)).length >= 3;
  }
}

async function normalizeSpreadsheetNamespacePrefixes(buffer: Buffer): Promise<Buffer> {
  const archive = await JSZip.loadAsync(buffer);
  const xmlEntries = Object.values(archive.files).filter((entry) => !entry.dir && entry.name.endsWith(".xml"));
  let changed = false;
  for (const entry of xmlEntries) {
    const xml = await entry.async("string");
    const normalized = normalizeSpreadsheetXml(xml);
    if (normalized !== xml) {
      archive.file(entry.name, normalized);
      changed = true;
    }
  }

  return changed
    ? Buffer.from(await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
    : buffer;
}

function normalizeSpreadsheetXml(xml: string): string {
  const prefix = spreadsheetNamespacePrefix(xml);
  if (!prefix) return xml;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const elementPattern = new RegExp(`<(/?)${escapedPrefix}:`, "g");
  let normalized = xml.replace(elementPattern, "<$1");
  if (!new RegExp(`\\sxmlns=(['\"])${escapeRegExp(SPREADSHEET_MAIN_NAMESPACE)}\\1`).test(normalized)) {
    const prefixedDeclaration = new RegExp(
      `xmlns:${escapedPrefix}=(['\"])${escapeRegExp(SPREADSHEET_MAIN_NAMESPACE)}\\1`,
    );
    normalized = normalized.replace(
      prefixedDeclaration,
      `xmlns="${SPREADSHEET_MAIN_NAMESPACE}" xmlns:${prefix}="${SPREADSHEET_MAIN_NAMESPACE}"`,
    );
  }
  return normalized;
}

function spreadsheetNamespacePrefix(xml: string): string | null {
  const root = xml.match(/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<([A-Za-z_][A-Za-z0-9_.-]*):[A-Za-z_][A-Za-z0-9_.-]*(?=[\s>])/);
  const prefix = root?.[1];
  if (!prefix || root.index === undefined) return null;
  const openingTagStart = root.index + root[0].lastIndexOf("<");
  const openingTagEnd = xml.indexOf(">", openingTagStart);
  if (openingTagEnd < 0) return null;
  const openingTag = xml.slice(openingTagStart, openingTagEnd + 1);
  const declaration = new RegExp(
    `\\sxmlns:${escapeRegExp(prefix)}=(['\"])${escapeRegExp(SPREADSHEET_MAIN_NAMESPACE)}\\1`,
  );
  return declaration.test(openingTag) ? prefix : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("result" in value) return String(value.result ?? "").trim();
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => ("text" in item ? String(item.text) : "")).join("").trim();
    }
  }
  return String(value).trim();
}
