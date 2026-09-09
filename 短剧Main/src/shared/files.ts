import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const EXCEL_EXTENSIONS = new Set([".xlsx", ".xlsm"]);
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
export const UPLOADS_ROOT = path.resolve("runtime", "uploads");

export function extensionOf(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

export function safePathPart(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^[_\.]+|[_\.]+$/g, "") || "unknown";
}

export function safeFileName(fileName: string): string {
  return path.basename(fileName || "upload.bin").replace(/[\r\n]/g, "_");
}

export function extractProjectName(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName));
  const quoted = stem.match(/《(.+?)》/);
  return quoted?.[1]?.trim() || stem;
}

export async function saveUpload(fileName: string, buffer: Buffer): Promise<string> {
  const directory = path.join(UPLOADS_ROOT, randomUUID().replaceAll("-", ""));
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, safeFileName(fileName));
  await writeFile(filePath, buffer);
  return filePath;
}

export async function cleanupUpload(filePath: string): Promise<boolean> {
  const root = path.resolve(UPLOADS_ROOT);
  const directory = path.resolve(path.dirname(filePath));
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  await rm(directory, { recursive: true, force: true });
  return true;
}
