import { z } from "zod";
import type { ShotPlanDraft } from "./types.js";

export const MAX_SHOT_PLAN_DIAGNOSTICS = 200;
const MAX_SHOT_PLAN_DIAGNOSTIC_LENGTH = 255;
const text = z.string().trim().min(1).max(4_000);
const key = z.string().trim().min(1).max(128);

const character = z.object({
  key,
  name: z.string().trim().min(1).max(160),
  description: text,
}).strict();

const scene = z.object({
  key,
  title: z.string().trim().min(1).max(240),
  summary: text,
  position: z.number().int().min(0),
}).strict();

const shot = z.object({
  key,
  sceneKey: key,
  position: z.number().int().min(0),
  shotSize: z.string().trim().min(1).max(64),
  cameraMovement: z.string().trim().min(1).max(160),
  action: text,
  rhythm: z.string().trim().min(1).max(160),
  dialogue: text,
  sound: text,
}).strict();

export const shotPlanDraftSchema = z.object({
  schemaVersion: z.literal(1),
  characters: z.array(character).min(1).max(200),
  scenes: z.array(scene).min(1).max(500),
  shots: z.array(shot).min(1).max(5_000),
  // Provider warnings and explicit partial diagnostics share this durable JSON
  // field, so every merge is normalized to this single shared limit.
  warnings: z.array(
    z.string().trim().min(1).max(MAX_SHOT_PLAN_DIAGNOSTIC_LENGTH),
  ).max(MAX_SHOT_PLAN_DIAGNOSTICS),
}).strict().superRefine((draft, context) => {
  uniqueKeys(draft.characters.map((item) => item.key), "characters", context);
  uniqueKeys(draft.scenes.map((item) => item.key), "scenes", context);
  uniqueKeys(draft.shots.map((item) => item.key), "shots", context);
  uniquePositions(draft.scenes.map((item) => item.position), ["scenes"], context);
  const sceneKeys = new Set(draft.scenes.map((item) => item.key));
  const shotPositionsByScene = new Map<string, Set<number>>();
  for (const [index, item] of draft.shots.entries()) {
    if (!sceneKeys.has(item.sceneKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shots", index, "sceneKey"],
        message: "镜头引用了不存在的场景",
      });
    }
    const positions = shotPositionsByScene.get(item.sceneKey) ?? new Set<number>();
    if (positions.has(item.position)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shots", index, "position"],
        message: "同一场景内的镜头位置必须唯一",
      });
    }
    positions.add(item.position);
    shotPositionsByScene.set(item.sceneKey, positions);
  }
});

export function validateShotPlanDraft(value: unknown): ShotPlanDraft {
  return shotPlanDraftSchema.parse(value);
}

export function mergeShotPlanDiagnostics(...sources: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const diagnostic of sources.flat()) {
    const normalized = diagnostic.trim().slice(0, MAX_SHOT_PLAN_DIAGNOSTIC_LENGTH);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
    if (merged.length === MAX_SHOT_PLAN_DIAGNOSTICS) break;
  }
  return merged;
}

function uniqueKeys(values: string[], path: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "草稿键必须唯一" });
  }
}

function uniquePositions(
  values: number[],
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "场景位置必须唯一" });
  }
}
