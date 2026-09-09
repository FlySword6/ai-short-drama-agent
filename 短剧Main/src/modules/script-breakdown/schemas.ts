import { z } from "zod";
import type { ScriptBreakdownDraft } from "./types.js";
import { characterAgeStages } from "./types.js";

/**
 * 草稿区的形状合同与领域上限。
 *
 * 模型不再自由吐 JSON——它只能按工具的入参 schema 调用(见 agent/tools.ts),
 * 所以这里剩下的是两件事:草稿回读的形状校验(draftFromUnknown),以及
 * 工作台和工具共用的那几条领域上限。
 */

export const SCENES_MAX = 60;
export const ASSETS_PER_KIND_MAX = 60;
export const SHOTS_PER_SCENE_MAX = 40;
export const SHOTS_TOTAL_MAX = 300;
export const SHOT_DURATION_SEC_MAX = 60;
/** 每 Segment 内 Shot 数上限（模板面板「分镜 Shot 数」配置；1..N 合法，缺省=自由）。 */
export const STORYBOARD_SHOTS_PER_SEGMENT_MAX = 12;

const sceneDivisionSchema = z.object({
  sceneIndex: z.number().int().min(0),
  name: z.string().nullable(),
  summary: z.string(),
  startLineIndex: z.number().int().min(0),
  endLineIndex: z.number().int().min(0),
});

const storedCandidateSchema = z.object({
  candidateId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

const storedCharacterCandidateSchema = storedCandidateSchema.extend({
  gender: z.string().nullable().optional().default(null),
  ageValue: z.number().int().nullable().optional().default(null),
  ageStage: z.enum(characterAgeStages).nullable().optional().default(null),
  appearance: z.string().nullable().optional().default(null),
  personalityTags: z.array(z.string()).optional().default([]),
  prelinkedAsset: z.object({
    assetEntityId: z.string(),
    name: z.string(),
    matchedBy: z.literal("exact_name"),
  }).strict().nullable().optional().default(null),
});

const storedCostumeCandidateSchema = storedCandidateSchema.extend({
  wearerNames: z.array(z.string()).optional().default([]),
  style: z.string().nullable().optional().default(null),
  color: z.string().nullable().optional().default(null),
  material: z.string().nullable().optional().default(null),
  occasion: z.string().nullable().optional().default(null),
});

const storedAudioCandidateSchema = storedCandidateSchema.extend({
  audioKind: z.enum(["character_voice", "narration", "sfx", "ambience", "other"]).optional().default("other"),
  speakerNames: z.array(z.string()).optional().default([]),
  sceneContext: z.string().nullable().optional().default(null),
  emotion: z.string().nullable().optional().default(null),
  durationHint: z.string().nullable().optional().default(null),
  transcriptSnippet: z.string().nullable().optional().default(null),
  soundCueText: z.string().nullable().optional().default(null),
  defaultAudioPromptSeed: z.string().nullable().optional().default(null),
});

const shotElementsSchema = z.object({
  subject: z.string().nullable(),
  action: z.string().nullable(),
  visual: z.string().nullable(),
  cameraLanguage: z.string().nullable(),
}).strict();

const shotCandidateSchema = z.object({
  candidateId: z.string(),
  shotNo: z.number().int(),
  sceneIndex: z.number().int(),
  lineIndices: z.array(z.number().int()),
  elements: shotElementsSchema.nullable().optional().default(null),
  storyboardDetail: z.object({
    segmentTitle: z.string().nullable(),
    shots: z.array(z.object({
      subjectAction: z.string().nullable(),
      physicsDetail: z.string().nullable(),
      cameraLanguage: z.string().nullable(),
      lighting: z.string().nullable(),
    })),
    lighting: z.string().nullable(),
    sfxLayers: z.array(z.string()),
    dialogue: z.array(z.object({
      speaker: z.string().nullable(),
      text: z.string(),
      lipSync: z.boolean(),
    })),
    assetDefinitions: z.array(z.object({ kind: z.string(), name: z.string() })),
    style: z.object({
      artStyle: z.string().nullable(),
      colorTone: z.string().nullable(),
      cameraStrategy: z.string().nullable(),
    }),
  }).nullable().optional().default(null),
  directorPrompt: z.string().nullable().optional().default(null),
  imagePrompt: z.string().nullable().optional().default(null),
  videoPrompt: z.string().nullable().optional().default(null),
  durationSec: z.number().int(),
  characterNames: z.array(z.string()),
  sceneNames: z.array(z.string()),
  propNames: z.array(z.string()),
  costumeNames: z.array(z.string()).optional().default([]),
  /** v0.9：阶段② assetDefinitions 的 audio 引用名；旧草稿缺省空数组。 */
  audioNames: z.array(z.string()).optional().default([]),
}).superRefine((shot, ctx) => {
  const hasLegacyPrompts = Boolean(
    shot.directorPrompt?.trim() || shot.imagePrompt?.trim() || shot.videoPrompt?.trim(),
  );
  if (!shot.elements && !hasLegacyPrompts) {
    ctx.addIssue({
      code: "custom",
      message: "分镜候选缺少结构化要素",
      path: ["elements"],
    });
  }
});

export const draftSchema = z.object({
  storySummary: z.string().optional(),
  sceneDivisions: z.array(sceneDivisionSchema).optional(),
  assetCandidates: z.object({
    characters: z.array(storedCharacterCandidateSchema),
    scenes: z.array(storedCandidateSchema),
    props: z.array(storedCandidateSchema),
    costumes: z.array(storedCostumeCandidateSchema),
    audios: z.array(storedAudioCandidateSchema),
  }).optional(),
  shotCandidates: z.array(shotCandidateSchema).optional(),
}).strict();

export function draftFromUnknown(value: unknown): ScriptBreakdownDraft {
  if (value === null || value === undefined) return {};
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("script_breakdown_runs.draft_json 形状非法,无法回读草稿");
  }
  return parsed.data;
}
