/* ============================================================
   voice-catalog.ts — 音色库(S44):数据只来自 GET /api/v1/audio/voices
   (音色词表,迁移 033),不再使用本地 fixture。audition_url 由批量
   预渲染脚本写回;为空的音色试听按钮置灰,不做"点了没反应"的假按钮。
   ============================================================ */

import { api, ApiClientError } from "./api";

export interface VoiceCatalogVoice {
  id: string;
  displayName: string;
  language?: string;
  category?: string;
  gender?: string;
  auditionUrl?: string;
}

export interface VoiceCatalogResult {
  voices: VoiceCatalogVoice[];
  /** 词表为空(种子未播/全部停用)时后端给的明确说明;筛选无命中不会有。 */
  reason?: string;
}

export async function fetchVoiceCatalog(): Promise<VoiceCatalogResult> {
  const raw = await api.request<unknown>("/audio/voices");
  return voiceCatalogFromUnknown(raw);
}

export function voiceCatalogFromUnknown(value: unknown): VoiceCatalogResult {
  if (!isRecord(value) || !Array.isArray(value.voices)) {
    throw new ApiClientError("音色库响应格式不正确", { code: "invalid_response" });
  }
  const voices = value.voices.map((item, index) => voiceFromUnknown(item, index));
  const reason = typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : undefined;
  return { voices, ...(reason ? { reason } : {}) };
}

function voiceFromUnknown(value: unknown, index: number): VoiceCatalogVoice {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    throw new ApiClientError(`音色库第 ${index + 1} 条格式不正确`, { code: "invalid_response" });
  }
  return {
    id: value.id,
    displayName: textOr(value.display_name, value.id),
    ...optionalText(value, "language"),
    ...optionalText(value, "category"),
    ...optionalText(value, "gender"),
    ...camelText(value, "audition_url", "auditionUrl"),
  };
}

function optionalText(record: Record<string, unknown>, key: "language" | "category" | "gender") {
  const value = record[key];
  return typeof value === "string" && value.trim() ? { [key]: value.trim() } : {};
}

function camelText(record: Record<string, unknown>, snake: string, camel: string) {
  const value = record[snake];
  return typeof value === "string" && value.trim() ? { [camel]: value.trim() } : {};
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** 分类 chips:按目录返回顺序去重(词表 sort 即展示顺序)。 */
export function voiceCategories(voices: readonly VoiceCatalogVoice[]): string[] {
  const seen: string[] = [];
  for (const voice of voices) {
    if (voice.category && !seen.includes(voice.category)) seen.push(voice.category);
  }
  return seen;
}

export function matchesVoice(voice: VoiceCatalogVoice, query: string, category: string): boolean {
  if (category && voice.category !== category) return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [voice.id, voice.displayName, voice.language ?? "", voice.category ?? "", voice.gender ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
