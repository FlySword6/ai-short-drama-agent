import { ArkChatClient } from "../../integrations/arkClient.js";
import { isRecord } from "../../shared/json.js";
import type { StoryboardHeaderMap } from "./types.js";

export interface StoryboardHeaderMapperDependencies {
  llm?: ArkChatClient;
}

export class StoryboardHeaderMapper {
  constructor(private readonly llm = new ArkChatClient()) {}

  async mapHeaders(sheetName: string, headers: string[]): Promise<StoryboardHeaderMap> {
    const cleaned = headers.map((header) => header.trim()).filter(Boolean);
    if (!cleaned.length) return emptyHeaderMap();
    const heuristic = heuristicHeaderMap(cleaned);
    if (hasConfidentStoryboardHeaders(heuristic)) return heuristic;
    const prompt = [
      "你是短剧分镜 Excel 表头识别助手。请根据 sheet 名和表头列表，把标准字段映射到真实 Excel 表头。",
      `sheet 名：${sheetName}`,
      `Excel 表头：${JSON.stringify(cleaned)}`,
      "标准字段：episode, shot_no, screen_description, camera_motion, shot_size_angle, dialogue, scene, sound_effect, reference_image_headers, storyboard_image_headers。",
      "只能返回真实存在的表头；不存在返回 null 或空数组；只输出 JSON。",
    ].join("\n");
    let value: unknown;
    try {
      value = await this.llm.completeJson(prompt);
    } catch {
      return heuristic;
    }
    if (!isRecord(value)) return heuristic;
    return {
      episode: validHeader(value.episode, cleaned),
      shotNo: validHeader(value.shot_no, cleaned),
      screenDescription: validHeader(value.screen_description, cleaned),
      cameraMotion: validHeader(value.camera_motion, cleaned),
      shotSizeAngle: validHeader(value.shot_size_angle, cleaned),
      dialogue: validHeader(value.dialogue, cleaned),
      scene: validHeader(value.scene, cleaned),
      soundEffect: validHeader(value.sound_effect, cleaned),
      referenceImageHeaders: validHeaderList(value.reference_image_headers, cleaned),
      storyboardImageHeaders: validHeaderList(value.storyboard_image_headers, cleaned),
    };
  }
}

function hasConfidentStoryboardHeaders(headers: StoryboardHeaderMap): boolean {
  return Boolean(
    headers.shotNo
    && headers.screenDescription
    && (headers.episode || headers.scene),
  );
}

export function emptyHeaderMap(): StoryboardHeaderMap {
  return {
    episode: null,
    shotNo: null,
    screenDescription: null,
    cameraMotion: null,
    shotSizeAngle: null,
    dialogue: null,
    scene: null,
    soundEffect: null,
    referenceImageHeaders: [],
    storyboardImageHeaders: [],
  };
}

function validHeader(value: unknown, headers: string[]): string | null {
  return typeof value === "string" && headers.includes(value.trim()) ? value.trim() : null;
}

function validHeaderList(value: unknown, headers: string[]): string[] {
  return Array.isArray(value)
    ? value.map((item) => validHeader(item, headers)).filter((item): item is string => Boolean(item))
    : [];
}

function firstMatching(headers: string[], keywords: string[]): string | null {
  return headers.find((header) => keywords.some((keyword) => header.includes(keyword))) ?? null;
}

function heuristicHeaderMap(headers: string[]): StoryboardHeaderMap {
  const result = emptyHeaderMap();
  result.episode = firstMatching(headers, ["集数", "剧集", "集"]);
  result.shotNo = firstMatching(headers, ["镜号", "镜头号", "分镜号"]);
  result.screenDescription = firstMatching(headers, ["画面", "镜头画面", "画面描述"]);
  result.cameraMotion = firstMatching(headers, ["镜头运动", "运镜", "摄影运动"]);
  result.shotSizeAngle = firstMatching(headers, ["景别", "视角", "景别/视角"]);
  result.dialogue = firstMatching(headers, ["台词", "对白"]);
  result.scene = firstMatching(headers, ["场景", "场景名", "地点"]);
  result.soundEffect = firstMatching(headers, ["音效", "声音", "环境声"]);
  result.referenceImageHeaders = headers.filter((header) => ["参考画面", "参考图", "静态帧"].some((keyword) => header.includes(keyword)));
  result.storyboardImageHeaders = headers.filter((header) => ["分镜图", "故事板图", "分镜画面"].some((keyword) => header.includes(keyword)));
  return result;
}
