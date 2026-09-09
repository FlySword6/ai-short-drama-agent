import { parseJsonValue, toJsonObject } from "../../shared/json.js";
import type {
  NormalizedVideoUnderstanding,
  VideoReferenceSubtype,
  VideoTimelineSegment,
} from "./types.js";

const VIDEO_SUBTYPES = new Set<VideoReferenceSubtype>([
  "action_reference",
  "camera_motion_reference",
  "scene_atmosphere_reference",
  "finished_style_reference",
  "other",
]);

const MAX_LIST_ITEMS = 20;
const MAX_TIMELINE_ITEMS = 30;

export function normalizeVideoUnderstanding(raw: unknown, fallbackName: string): NormalizedVideoUnderstanding {
  const candidate = extractStructuredResult(raw);
  const summary = stringField(candidate, "summary")
    ?? stringField(candidate, "caption")
    ?? stringField(candidate, "description")
    ?? stringField(candidate, "result")
    ?? fallbackName;
  return {
    summary: limitText(summary, 2_000),
    video_subtype: videoSubtype(stringField(candidate, "video_subtype")),
    scene: limitText(stringField(candidate, "scene") ?? "", 512),
    characters: stringList(candidate.characters),
    actions: stringList(candidate.actions),
    camera_motion: stringList(candidate.camera_motion ?? candidate.cameraMotion),
    visual_style: stringList(candidate.visual_style ?? candidate.visualStyle),
    audio_cues: stringList(candidate.audio_cues ?? candidate.audioCues),
    timeline: timelineList(candidate.timeline ?? candidate.segments),
    tags: stringList(candidate.tags),
  };
}

export function buildVideoVectorText(input: NormalizedVideoUnderstanding): string {
  const lines = [
    "素材类型：参考视频",
    input.summary ? `摘要：${input.summary}` : "",
    input.scene ? `场景：${input.scene}` : "",
    input.characters.length ? `角色：${input.characters.join("、")}` : "",
    input.actions.length ? `动作：${input.actions.join("、")}` : "",
    input.camera_motion.length ? `运镜：${input.camera_motion.join("、")}` : "",
    input.visual_style.length ? `视觉风格：${input.visual_style.join("、")}` : "",
    input.audio_cues.length ? `声音线索：${input.audio_cues.join("、")}` : "",
    input.timeline.length
      ? `时间线：${input.timeline.map((item) => `${formatTime(item.start)}-${formatTime(item.end)} ${item.description}`).join("；")}`
      : "",
    input.tags.length ? `标签：${input.tags.join("、")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function buildVideoEntityVectorText(assetName: string, mediaVectorText: string): string {
  return [assetName.trim(), mediaVectorText.trim()].filter(Boolean).join("\n");
}

export function buildVideoAppearanceText(input: NormalizedVideoUnderstanding): string {
  const lines = [
    input.scene ? `场景：${input.scene}` : "",
    input.characters.length ? `角色：${input.characters.join("、")}` : "",
    input.actions.length ? `动作：${input.actions.join("、")}` : "",
    input.camera_motion.length ? `运镜：${input.camera_motion.join("、")}` : "",
    input.audio_cues.length ? `声音线索：${input.audio_cues.join("、")}` : "",
    input.timeline.length
      ? `时间线：${input.timeline.map((item) => `${formatTime(item.start)}-${formatTime(item.end)} ${item.description}`).join("；")}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function buildVideoOutfitDescriptionText(_input: NormalizedVideoUnderstanding): string {
  // outfit_description is semantically clothing; visual style belongs in metadata/style_tags.
  return "";
}

export function videoUnderstandingQuery(): string {
  return [
    "请分析这个短剧参考视频，输出严格 JSON，不要 Markdown，不要解释。",
    "需要识别视频整体摘要、参考类型、主要场景、人物或角色类型、关键动作、运镜、视觉风格、声音线索、关键时间线片段和适合检索的标签。",
    "video_subtype 只能是 action_reference / camera_motion_reference / scene_atmosphere_reference / finished_style_reference / other。",
    "timeline 每项必须包含 start、end、description，start/end 单位为秒。",
    "只输出 JSON 对象，字段为 summary, video_subtype, scene, characters, actions, camera_motion, visual_style, audio_cues, timeline, tags。",
  ].join("\n");
}

function extractStructuredResult(raw: unknown): Record<string, unknown> {
  const object = toJsonObject(raw);
  const data = toJsonObject(object.data);
  for (const value of [
    data.final_summary,
    data.summary,
    data.result,
    data.output,
    object.result,
    object.output,
    object.data,
    object,
  ]) {
    const parsed = parseCandidate(value);
    if (parsed) return parsed;
  }
  return object;
}

function parseCandidate(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = parseJsonValue(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return { summary: value };
  }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : null;
}

function stringList(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[、,，;；\n]/u)
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    const text = typeof item === "string"
      ? limitText(item, 64).trim()
      : item && typeof item === "object" && !Array.isArray(item)
        ? objectText(item as Record<string, unknown>)
        : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= MAX_LIST_ITEMS) break;
  }
  return result;
}

function objectText(value: Record<string, unknown>): string {
  for (const key of ["content", "description", "caption", "event", "name", "text"]) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return limitText(item, 64).trim();
  }
  return "";
}

function timelineList(value: unknown): VideoTimelineSegment[] {
  if (!Array.isArray(value)) return [];
  const result: VideoTimelineSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const object = item as Record<string, unknown>;
    const start = numberField(object.start ?? object.start_time ?? object.startTime);
    const end = numberField(object.end ?? object.end_time ?? object.endTime);
    const description = typeof object.description === "string" && object.description.trim()
      ? object.description.trim()
      : typeof object.caption === "string" && object.caption.trim()
        ? object.caption.trim()
        : "";
    if (start === null || end === null || !description) continue;
    result.push({ start, end, description: limitText(description, 500) });
    if (result.length >= MAX_TIMELINE_ITEMS) break;
  }
  return result;
}

function numberField(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function videoSubtype(value: string | null): VideoReferenceSubtype {
  return value && VIDEO_SUBTYPES.has(value as VideoReferenceSubtype)
    ? value as VideoReferenceSubtype
    : "other";
}

function limitText(value: string, maxLength: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function formatTime(value: number): string {
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}s`;
}
