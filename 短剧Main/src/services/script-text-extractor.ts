import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

/** 提取结果:sourceFormat 区分纯文本类(txt/md 记 txt)、docx 与 pdf。 */
export interface ExtractedScriptText {
  text: string;
  sourceFormat: "txt" | "docx" | "pdf";
}

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);
const DOCX_EXTENSIONS = new Set([".docx"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
export const SCRIPT_TEXT_EXTENSIONS = [...TEXT_EXTENSIONS, ...DOCX_EXTENSIONS, ...PDF_EXTENSIONS];

/** 路由层快速判断扩展名是否受支持(协议层校验,不读 buffer)。 */
export function isScriptTextFile(filename: string): boolean {
  const ext = extname(filename);
  return TEXT_EXTENSIONS.has(ext) || DOCX_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext);
}

/**
 * 剧本文本提取器:把上传的 .txt/.md/.docx 文件提取成纯文本。
 * 与 storyboard/parser.ts 同风格(无状态 class),供 LiteScriptService 注入。
 * 解析完全在后端——前端不加文件解析库,bundle 不涨。
 */
export class ScriptTextExtractor {
  async extract(filename: string, buffer: Buffer): Promise<ExtractedScriptText> {
    const ext = extname(filename);
    if (TEXT_EXTENSIONS.has(ext)) {
      return { text: normalisePlainText(buffer.toString("utf-8")), sourceFormat: "txt" };
    }
    if (DOCX_EXTENSIONS.has(ext)) {
      const result = await mammoth.extractRawText({ buffer });
      return { text: normalisePlainText(result.value), sourceFormat: "docx" };
    }
    if (PDF_EXTENSIONS.has(ext)) {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        return { text: normalisePlainText(result.text), sourceFormat: "pdf" };
      } finally {
        await parser.destroy();
      }
    }
    throw new Error(`unsupported_script_extension:${ext || "无扩展名"}`);
  }
}

/** 去除 UTF-8 BOM、行尾归一 \n、trim 首尾空白。 */
function normalisePlainText(raw: string): string {
  return raw
    .replace(/^﻿/u, "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .trim();
}

function extname(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}
