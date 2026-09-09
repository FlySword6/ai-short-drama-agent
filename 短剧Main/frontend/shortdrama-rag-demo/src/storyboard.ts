import { isRecord } from "./generation-quotes";
import type {
  Episode,
  Scene,
  StoryboardImportIssue,
  StoryboardImportPreviewData,
  StoryboardImportRecord,
  StoryboardPreviewRow,
} from "./types";

/**
 * 后端导入记录形状（src/modules/storyboard/routes.ts）：顶层 id + 嵌套 preview{rows, issues, can_confirm}。
 * 这里做一层防御性归一化，字段缺失时不让页面崩溃。
 */
export function storyboardImportFromUnknown(value: unknown): StoryboardImportRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  const rawPreview = isRecord(value.preview) ? value.preview : {};
  return {
    id: value.id,
    ...(typeof value.project_id === "string" ? { project_id: value.project_id } : {}),
    ...(typeof value.file_name === "string" ? { file_name: value.file_name } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.confirmed_at === "string" ? { confirmed_at: value.confirmed_at } : {}),
    ...(typeof value.created_at === "string" ? { created_at: value.created_at } : {}),
    ...(isRecord(value.confirmation_result) ? { confirmation_result: normaliseConfirmationResult(value.confirmation_result) } : {}),
    preview: normalisePreview(rawPreview),
  };
}

function normaliseConfirmationResult(result: Record<string, unknown>): NonNullable<StoryboardImportRecord["confirmation_result"]> {
  return {
    ...(isStringArray(result.created_episode_ids) ? { created_episode_ids: result.created_episode_ids } : {}),
    ...(isStringArray(result.created_scene_ids) ? { created_scene_ids: result.created_scene_ids } : {}),
    ...(isStringArray(result.created_shot_ids) ? { created_shot_ids: result.created_shot_ids } : {}),
    ...(typeof result.imported_shot_count === "number" ? { imported_shot_count: result.imported_shot_count } : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalisePreview(rawPreview: Record<string, unknown>): StoryboardImportPreviewData {
  const rows = Array.isArray(rawPreview.rows)
    ? rawPreview.rows.filter(isRecord).map(normaliseRow)
    : [];
  const issues = Array.isArray(rawPreview.issues)
    ? rawPreview.issues.filter(isRecord).map(normaliseIssue)
    : [];
  return {
    rows,
    issues,
    can_confirm: rawPreview.can_confirm === true,
    ...(typeof rawPreview.episode_count === "number" ? { episode_count: rawPreview.episode_count } : {}),
    ...(typeof rawPreview.scene_count === "number" ? { scene_count: rawPreview.scene_count } : {}),
    ...(typeof rawPreview.shot_count === "number" ? { shot_count: rawPreview.shot_count } : {}),
  };
}

function normaliseRow(row: Record<string, unknown>): StoryboardPreviewRow {
  return {
    ...(typeof row.source_sheet === "string" ? { source_sheet: row.source_sheet } : {}),
    ...(typeof row.source_row === "number" ? { source_row: row.source_row } : {}),
    ...(typeof row.episode_no === "number" ? { episode_no: row.episode_no } : {}),
    ...(typeof row.scene_name === "string" ? { scene_name: row.scene_name } : {}),
    ...(typeof row.shot_no === "string" || typeof row.shot_no === "number" ? { shot_no: row.shot_no } : {}),
    ...(typeof row.sort_order === "number" ? { sort_order: row.sort_order } : {}),
    ...(typeof row.screen_description === "string" ? { screen_description: row.screen_description } : {}),
    ...(typeof row.camera_movement === "string" ? { camera_movement: row.camera_movement } : {}),
    ...(typeof row.shot_size_angle === "string" ? { shot_size_angle: row.shot_size_angle } : {}),
    ...(typeof row.dialogue === "string" ? { dialogue: row.dialogue } : {}),
    ...(typeof row.sound_effect === "string" ? { sound_effect: row.sound_effect } : {}),
    ...(typeof row.reference_image_note === "string" ? { reference_image_note: row.reference_image_note } : {}),
    ...(typeof row.storyboard_image_note === "string" ? { storyboard_image_note: row.storyboard_image_note } : {}),
    ...(isStringRecord(row.raw_fields) ? { raw_fields: row.raw_fields } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function normaliseIssue(issue: Record<string, unknown>): StoryboardImportIssue {
  return {
    level: issue.level === "error" ? "error" : "warning",
    message: typeof issue.message === "string" && issue.message ? issue.message : "解析出现问题",
    ...(typeof issue.code === "string" ? { code: issue.code } : {}),
    ...(typeof issue.source_row === "number" ? { source_row: issue.source_row } : {}),
  };
}

export function storyboardIssues(record: StoryboardImportRecord, level: StoryboardImportIssue["level"]): StoryboardImportIssue[] {
  return record.preview.issues.filter((issue) => issue.level === level);
}

export function canConfirmStoryboardImport(record: StoryboardImportRecord): boolean {
  return record.preview.can_confirm && storyboardIssues(record, "error").length === 0;
}

/* ---------- K2N(GP-07):导入预览的场景绑定试算 ----------
   后端预览响应只有每行 scene_name 字符串,没有匹配结果/候选/绑定状态
   (实查 src/modules/storyboard/routes.ts toResponse;确认时按「集内精确同名」复用,
   否则新建场景,见 repository.ts confirm)。这里的试算把同一规则在导入前摆给用户核对:
   按名命中=将绑定到已有场景;相近名只进候选,绝不自动绑定。 */

export type SceneBindingStatus = "matched" | "candidates" | "unmatched" | "new_episode";

export interface SceneBindingCandidate {
  id: string;
  name: string;
}

export interface SceneBindingTrial {
  /** 归一化后的「集:场景名」键,同行数合并。 */
  key: string;
  episode_no: number;
  scene_name: string;
  status: SceneBindingStatus;
  matched: SceneBindingCandidate | null;
  candidates: SceneBindingCandidate[];
  row_count: number;
}

/** 候选上限:相近名只作人工核对提示,列太多反而淹没重点。 */
const SCENE_CANDIDATE_LIMIT = 5;

/** 场景名比较键:去全部空白(全角空格、换行缩进不造成假未命中)。 */
function sceneNameKey(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "");
}

export function sceneBindingTrialKey(episodeNo: number, sceneName: string): string {
  return `${episodeNo}:${sceneNameKey(sceneName)}`;
}

export function trialSceneBindings(
  rows: StoryboardPreviewRow[],
  episodes: Pick<Episode, "id" | "episode_no">[],
  scenesByEpisodeId: ReadonlyMap<string, Pick<Scene, "id" | "name">[]>,
): SceneBindingTrial[] {
  const trials: SceneBindingTrial[] = [];
  const byKey = new Map<string, SceneBindingTrial>();
  for (const row of rows) {
    const episodeNo = typeof row.episode_no === "number" ? row.episode_no : null;
    const sceneName = (row.scene_name ?? "").trim();
    if (episodeNo === null || !sceneName) continue;
    const key = sceneBindingTrialKey(episodeNo, sceneName);
    const seen = byKey.get(key);
    if (seen) {
      seen.row_count += 1;
      continue;
    }
    const episode = episodes.find((item) => item.episode_no === episodeNo);
    const trial: SceneBindingTrial = {
      key,
      episode_no: episodeNo,
      scene_name: sceneName,
      status: "unmatched",
      matched: null,
      candidates: [],
      row_count: 1,
    };
    if (!episode) {
      trial.status = "new_episode";
    } else {
      const target = sceneNameKey(sceneName);
      const scenes = scenesByEpisodeId.get(episode.id) ?? [];
      const exact = scenes.find((scene) => sceneNameKey(scene.name) === target);
      if (exact) {
        trial.status = "matched";
        trial.matched = { id: exact.id, name: exact.name };
      } else {
        trial.candidates = scenes
          .filter((scene) => {
            const name = sceneNameKey(scene.name);
            return name.length >= 2 && target.length >= 2 && (name.includes(target) || target.includes(name));
          })
          .slice(0, SCENE_CANDIDATE_LIMIT)
          .map((scene) => ({ id: scene.id, name: scene.name }));
        trial.status = trial.candidates.length > 0 ? "candidates" : "unmatched";
      }
    }
    byKey.set(key, trial);
    trials.push(trial);
  }
  return trials;
}
