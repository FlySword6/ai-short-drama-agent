/**
 * P6 阶段②输出解析器（§2 P6 B / §2.6 F）。
 *
 * 把模型单次结构化输出（JSON 文本）解析成分镜候选。两种形状共用一个出口：
 * - skill 态：segments[].shots[]（数量 = 模板面板「分镜 Shot 数」配置恰好 N，
 *   未配置自由 ≥1）→ storyboardDetail 落全量，
 *   video_prompt 由模型按生效模板成文（skill 合同），非空校验；
 * - 降级态（STORYBOARD_SKILL_TEXT 被清空）：segments[] 顶层带 video_prompt，
 *   storyboardDetail 恒 null，校验降为最小集。
 *
 * 校验失败返回人话 issues，不抛异常——由服务层如实记成 run 失败，前端可重试。
 */
import { SHOT_DURATION_SEC_MAX, SHOTS_TOTAL_MAX } from "./schemas.js";
import type { ShotStoryboardDetail } from "./types.js";

export interface StoryboardSegmentAsset {
  kind: string;
  name: string;
}

export interface ParsedStoryboardShot {
  segmentTitle: string;
  /** 所属场次序号（阶段①产出的 sceneDivisions[].sceneIndex）；模型没给则 null。 */
  sceneRef: number | null;
  /** 覆盖的剧本行号闭区间 [start, end]。 */
  coveredLineRange: [number, number];
  durationSec: number;
  /** 引用资产（含五类可解析 + 三类参考通道）。 */
  assets: StoryboardSegmentAsset[];
  /** 成文分镜提示词：skill 态与降级态均由模型直出（skill 合同）。 */
  videoPrompt: string | null;
  /** skill 态全量；降级态 null（§2.6 F）。 */
  storyboardDetail: ShotStoryboardDetail | null;
}

export interface ParseStoryboardResult {
  shots: ParsedStoryboardShot[];
  /** 非空 = 解析/校验失败，run 应判失败。 */
  issues: string[];
}

/** skill 态允许的资产引用 kind（资产页全部 8 类 tab）。 */
const ALLOWED_ASSET_KINDS: Record<string, true> = {
  character: true,
  scene: true,
  prop: true,
  costume: true,
  audio: true,
  light_ref: true,
  photo_ref: true,
  video_ref: true,
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asDurationSec(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= SHOT_DURATION_SEC_MAX) {
    return value;
  }
  return fallback;
}

function extractJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  // 模型偶尔包一层 ```json 围栏。
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export interface ParseStoryboardInput {
  /** 模型返回的原文（期望单个 JSON 对象）。 */
  content: string;
  /** 剧本总行数（行覆盖校验用）。 */
  lineCount: number;
  /** skill 删除降级态（§2.6 F）。 */
  degraded: boolean;
  /** 每段恰好拆几个 Shot（模板面板「分镜 Shot 数」，1..MAX）；null=自由（≥1）。降级态恒 null。 */
  shotsPerSegment: number | null;
  /** 资产库合法名集合（引用必须 ∈）。 */
  knownAssetNames: ReadonlySet<string>;
  /** duration_sec 缺失/非法时的兜底时长。 */
  fallbackDurationSec: number;
}

export function parseStoryboardOutput(input: ParseStoryboardInput): ParseStoryboardResult {
  const issues: string[] = [];
  const parsed = extractJsonObject(input.content);
  if (!parsed) return { shots: [], issues: ["拆镜输出不是合法 JSON 对象,请重试。"] };

  const segments = Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!segments || segments.length === 0) {
    return { shots: [], issues: ["拆镜输出没有 segments,请重试。"] };
  }
  if (segments.length > SHOTS_TOTAL_MAX) {
    return { shots: [], issues: [`拆镜数量 ${segments.length} 超过上限 ${SHOTS_TOTAL_MAX}。`] };
  }

  const shots: ParsedStoryboardShot[] = [];
  let expectedStart = 0;

  segments.forEach((raw, index) => {
    const segment = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!segment) {
      issues.push(`第 ${index + 1} 个分镜不是对象。`);
      return;
    }
    const segmentTitle = asString(segment.segment_title) ?? `分镜 ${index + 1}`;

    const sceneRef = typeof segment.scene_ref === "number" && Number.isInteger(segment.scene_ref)
      && segment.scene_ref >= 0 ? segment.scene_ref : null;

    // —— 行覆盖：[start, end] 闭区间，相邻紧接、铺满全集。
    const range = Array.isArray(segment.covered_line_range) ? segment.covered_line_range : null;
    const start = range && typeof range[0] === "number" && Number.isInteger(range[0]) ? range[0] : null;
    const end = range && typeof range[1] === "number" && Number.isInteger(range[1]) ? range[1] : null;
    if (start === null || end === null || start < 0 || end < start || end >= input.lineCount) {
      issues.push(`第 ${index + 1} 个分镜「${segmentTitle}」的行号范围无效。`);
      return;
    }
    if (start !== expectedStart) {
      issues.push(`第 ${index + 1} 个分镜「${segmentTitle}」应从第 ${expectedStart} 行开始,收到第 ${start} 行。`);
    }
    expectedStart = end + 1;

    // —— 资产引用必须 ∈ 资产库。
    const rawAssets = Array.isArray(segment.assets)
      ? segment.assets
      : Array.isArray(segment.reference_assets)
        ? segment.reference_assets
        : [];
    const assets: StoryboardSegmentAsset[] = [];
    for (const rawAsset of rawAssets) {
      const asset = rawAsset && typeof rawAsset === "object" && !Array.isArray(rawAsset)
        ? rawAsset as Record<string, unknown>
        : null;
      const name = asString(asset?.name);
      const kind = asString(asset?.kind) ?? "prop";
      if (!name) continue;
      if (!input.degraded && !ALLOWED_ASSET_KINDS[kind]) {
        issues.push(`第 ${index + 1} 个分镜引用了未知资产类型「${kind}」。`);
        continue;
      }
      if (!input.knownAssetNames.has(name)) {
        issues.push(`第 ${index + 1} 个分镜引用了资产库之外的资产「${name}」。`);
        continue;
      }
      assets.push({ kind, name });
    }

    const durationSec = asDurationSec(segment.duration_sec, input.fallbackDurationSec);

    if (input.degraded) {
      // 降级态：video_prompt 模型直出，最小校验（§2.6 F：非空即可）。
      const videoPrompt = asString(segment.video_prompt);
      if (!videoPrompt) {
        issues.push(`第 ${index + 1} 个分镜「${segmentTitle}」没有成文分镜提示词。`);
        return;
      }
      shots.push({
        segmentTitle,
        sceneRef,
        coveredLineRange: [start, end],
        durationSec,
        assets,
        videoPrompt,
        storyboardDetail: null,
      });
      return;
    }

    // skill 态：Shot 四模块完整。数量 = 模板面板「分镜 Shot 数」配置（恰好 N）；未配置自由（≥1）。
    const rawShots = Array.isArray(segment.shots) ? segment.shots : [];
    if (input.shotsPerSegment !== null) {
      if (rawShots.length !== input.shotsPerSegment) {
        issues.push(`第 ${index + 1} 个分镜「${segmentTitle}」应含 ${input.shotsPerSegment} 个 Shot,收到 ${rawShots.length} 个。`);
      }
    } else if (rawShots.length < 1) {
      issues.push(`第 ${index + 1} 个分镜「${segmentTitle}」没有 Shot,至少需要 1 个。`);
    }
    const detailShots = rawShots.map((rawShot) => {
      const shot = rawShot && typeof rawShot === "object" && !Array.isArray(rawShot)
        ? rawShot as Record<string, unknown>
        : {};
      return {
        subjectAction: asString(shot.subject_action),
        physicsDetail: asString(shot.physics_detail),
        cameraLanguage: asString(shot.camera_language),
        lighting: asString(shot.lighting),
      };
    });

    const audio = segment.audio && typeof segment.audio === "object" && !Array.isArray(segment.audio)
      ? segment.audio as Record<string, unknown>
      : {};
    const sfxLayers = Array.isArray(audio.sfx_layers)
      ? audio.sfx_layers.map(asString).filter((value): value is string => value !== null)
      : [];
    const dialogue = (Array.isArray(audio.dialogue) ? audio.dialogue : []).map((rawLine) => {
      const line = rawLine && typeof rawLine === "object" && !Array.isArray(rawLine)
        ? rawLine as Record<string, unknown>
        : {};
      return {
        speaker: asString(line.speaker),
        text: asString(line.text) ?? "",
        lipSync: line.lip_sync === true,
      };
    }).filter((line) => line.text.length > 0);

    const rawStyle = segment.style && typeof segment.style === "object" && !Array.isArray(segment.style)
      ? segment.style as Record<string, unknown>
      : {};

    // skill 态：成文提示词由模型按生效模板写（skill 合同），非空才收。
    const videoPrompt = asString(segment.video_prompt);
    if (!videoPrompt) {
      issues.push(`第 ${index + 1} 个分镜「${segmentTitle}」没有成文分镜提示词。`);
      return;
    }

    shots.push({
      segmentTitle,
      sceneRef,
      coveredLineRange: [start, end],
      durationSec,
      assets,
      videoPrompt,
      storyboardDetail: {
        segmentTitle,
        shots: detailShots,
        lighting: asString(rawStyle.lighting),
        sfxLayers,
        dialogue,
        assetDefinitions: assets,
        style: {
          artStyle: asString(rawStyle.art_style),
          colorTone: asString(rawStyle.color_tone),
          cameraStrategy: asString(rawStyle.camera_strategy),
        },
      },
    });
  });

  if (issues.length === 0 && expectedStart !== input.lineCount) {
    issues.push(`分镜行覆盖到第 ${expectedStart - 1} 行为止,剧本共 ${input.lineCount} 行,没有铺满。`);
  }

  return { shots, issues };
}
