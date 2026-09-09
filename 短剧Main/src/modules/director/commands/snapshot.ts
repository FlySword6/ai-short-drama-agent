import { z } from "zod";

/**
 * 导演台场景快照（DirectorSceneSnapshot）契约。
 * 这是 scene 持久化、命令 executor、前端与 Pi 共用的同一份结构定义；
 * 与模版实例化输出同为 camelCase 数据契约（loose object：模版字段
 * templateId/promptHints 等原样透传，不参与命令计算）。
 */

export const SCENE_ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:3", "3:4"] as const;

export const vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const transformSchema = z.object({
  position: vec3Schema,
  rotation: vec3Schema.default({ x: 0, y: 0, z: 0 }),
  scale: vec3Schema.default({ x: 1, y: 1, z: 1 }),
});

/** 局部变换补丁（set_transform 用）：至少提供一个分量。 */
export const transformPatchSchema = z.object({
  position: vec3Schema.optional(),
  rotation: vec3Schema.optional(),
  scale: vec3Schema.optional(),
}).refine((value) => value.position !== undefined || value.rotation !== undefined || value.scale !== undefined, {
  message: "transform 至少提供 position/rotation/scale 之一",
});

export const poseSchema = z.looseObject({
  preset: z.string().min(1),
});

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色必须是 #RRGGBB 形式");

export const attachedAssetSchema = z.looseObject({
  assetEntityId: z.string().uuid(),
  assetMediaId: z.string().uuid().nullable().default(null),
  name: z.string().min(1).max(128).optional(),
});

export const sceneObjectSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  transform: transformSchema,
  pose: poseSchema.optional(),
  attachments: z.array(attachedAssetSchema).default([]),
});

export const sceneCameraSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal("camera").default("camera"),
  name: z.string().min(1),
  focalLength: z.number().positive(),
  target: vec3Schema,
  transform: z.looseObject({ position: vec3Schema }),
  rollDeg: z.number().min(-45).max(45).optional(),
});

export const aspectRatioSchema = z.enum(SCENE_ASPECT_RATIOS);

export const environmentSchema = z.looseObject({
  preset: z.string().min(1).default("studio"),
  backgroundColor: colorSchema.default("#1E1E1E"),
  ambientLight: z.number().min(0).max(1).default(0.6),
  groundVisible: z.boolean().default(true),
});

/** set_environment 的环境补丁：字段全部可选但至少一项。 */
export const environmentPatchSchema = z.looseObject({
  preset: z.string().min(1).optional(),
  backgroundColor: colorSchema.optional(),
  ambientLight: z.number().min(0).max(1).optional(),
  groundVisible: z.boolean().optional(),
}).refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  { message: "patch 至少提供一个环境字段" },
);

export const DEFAULT_SCENE_ENVIRONMENT = {
  preset: "studio",
  backgroundColor: "#1E1E1E",
  ambientLight: 0.6,
  groundVisible: true,
};

export const sceneSnapshotSchema = z.looseObject({
  schemaVersion: z.literal(1),
  objects: z.array(sceneObjectSchema).default([]),
  cameras: z.array(sceneCameraSchema).default([]),
  selectedObjectId: z.string().min(1).nullable().default(null),
  activeCameraId: z.string().min(1).nullable().default(null),
  aspectRatio: aspectRatioSchema.default("9:16"),
  environment: environmentSchema.default(DEFAULT_SCENE_ENVIRONMENT),
});

export type SceneVec3 = z.infer<typeof vec3Schema>;
export type SceneTransform = z.infer<typeof transformSchema>;
export type SceneTransformPatch = z.infer<typeof transformPatchSchema>;
export type ScenePose = z.infer<typeof poseSchema>;
export type AttachedAsset = z.infer<typeof attachedAssetSchema>;
export type SceneObject = z.infer<typeof sceneObjectSchema>;
export type SceneCamera = z.infer<typeof sceneCameraSchema>;
export type SceneAspectRatio = z.infer<typeof aspectRatioSchema>;
export type SceneEnvironment = z.infer<typeof environmentSchema>;
export type SceneEnvironmentPatch = z.infer<typeof environmentPatchSchema>;
export type SceneSnapshot = z.infer<typeof sceneSnapshotSchema>;
