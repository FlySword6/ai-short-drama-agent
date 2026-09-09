import type { StoryboardHeaderMap, StoryboardExcelRow } from "./types.js";

export class StoryboardFieldMapper {
  mapFields(
    sheetName: string,
    rowNumber: number,
    fields: Record<string, unknown>,
    headerMap: StoryboardHeaderMap,
  ): StoryboardExcelRow {
    const normalized = Object.fromEntries(
      Object.entries(fields)
        .map(([key, value]) => [String(key).trim(), String(value ?? "").trim()])
        .filter(([key]) => Boolean(key)),
    );
    return {
      sheetName,
      rowNumber,
      episode: valueByHeader(normalized, headerMap.episode),
      shotNo: valueByHeader(normalized, headerMap.shotNo),
      screenDescription: valueByHeader(normalized, headerMap.screenDescription),
      cameraMotion: valueByHeader(normalized, headerMap.cameraMotion),
      shotSizeAngle: valueByHeader(normalized, headerMap.shotSizeAngle),
      dialogue: valueByHeader(normalized, headerMap.dialogue),
      scene: valueByHeader(normalized, headerMap.scene),
      soundEffect: valueByHeader(normalized, headerMap.soundEffect),
      referenceImageNote: joinValues(normalized, headerMap.referenceImageHeaders),
      storyboardImageNote: joinValues(normalized, headerMap.storyboardImageHeaders),
      rawFields: normalized,
    };
  }
}

function valueByHeader(fields: Record<string, string>, header: string | null): string | null {
  if (!header) return null;
  const value = fields[header];
  return value || null;
}

function joinValues(fields: Record<string, string>, headers: string[]): string | null {
  const values = headers
    .map((header) => fields[header] ? `${header}：${fields[header]}` : "")
    .filter(Boolean);
  return values.length ? values.join("\n") : null;
}
