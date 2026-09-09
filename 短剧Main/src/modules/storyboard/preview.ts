import type { StoryboardExcelRow } from "../../services/storyboard/types.js";
import type { StoryboardPreview, StoryboardPreviewIssue, StoryboardPreviewShot } from "./types.js";

export function buildStoryboardPreview(sourceRows: StoryboardExcelRow[]): StoryboardPreview {
  const issues: StoryboardPreviewIssue[] = [];
  const rows: StoryboardPreviewShot[] = [];
  const seenShots = new Set<string>();
  const sceneKeys = new Set<string>();
  const episodeNumbers = new Set<number>();
  let lastEpisodeNo = 1;

  sourceRows.forEach((source, index) => {
    const episodeNo = parsePositiveInteger(source.episode) ?? inferEpisodeFromSheet(source.sheetName) ?? lastEpisodeNo;
    lastEpisodeNo = episodeNo;
    const shotCode = normalizedText(source.shotNo);
    const sceneName = normalizedText(source.scene) || "未分场";

    if (!shotCode) {
      issues.push({
        level: "error",
        code: "missing_shot_code",
        message: "缺少镜号，无法确认导入",
        sourceRow: source.rowNumber,
      });
      return;
    }

    const identity = `${episodeNo}:${shotCode}`;
    if (seenShots.has(identity)) {
      issues.push({
        level: "error",
        code: "duplicate_shot_code",
        message: `第 ${episodeNo} 集镜号 ${shotCode} 重复`,
        sourceRow: source.rowNumber,
      });
      return;
    }
    seenShots.add(identity);

    if (!normalizedText(source.screenDescription)) {
      issues.push({
        level: "warning",
        code: "missing_screen_description",
        message: `第 ${episodeNo} 集镜号 ${shotCode} 没有画面描述`,
        sourceRow: source.rowNumber,
      });
    }

    rows.push({
      sourceSheet: source.sheetName,
      sourceRow: source.rowNumber,
      episodeNo,
      sceneName,
      shotCode,
      sortOrder: index + 1,
      screenDescription: nullableText(source.screenDescription),
      cameraMovement: nullableText(source.cameraMotion),
      shotSizeAngle: nullableText(source.shotSizeAngle),
      dialogue: nullableText(source.dialogue),
      soundEffect: nullableText(source.soundEffect),
      referenceImageNote: nullableText(source.referenceImageNote),
      storyboardImageNote: nullableText(source.storyboardImageNote),
      rawFields: source.rawFields,
    });
    episodeNumbers.add(episodeNo);
    sceneKeys.add(`${episodeNo}:${sceneName}`);
  });

  if (!sourceRows.length) {
    issues.push({
      level: "error",
      code: "empty_storyboard",
      message: "没有识别到分镜数据",
      sourceRow: 0,
    });
  }

  return {
    rows,
    issues,
    episodeCount: episodeNumbers.size,
    sceneCount: sceneKeys.size,
    shotCount: rows.length,
    canConfirm: rows.length > 0 && !issues.some((issue) => issue.level === "error"),
  };
}

function normalizedText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = normalizedText(value);
  return normalized || null;
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function inferEpisodeFromSheet(sheetName: string): number | null {
  const match = sheetName.match(/(?:第\s*)?(\d+)\s*集/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
