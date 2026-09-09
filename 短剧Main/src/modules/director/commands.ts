import { z } from "zod";
import { AppError } from "../../shared/errors.js";
import {
  aspectRatioSchema,
  attachedAssetSchema,
  environmentSchema,
  environmentPatchSchema,
  poseSchema,
  sceneCameraSchema,
  sceneObjectSchema,
  transformPatchSchema,
  vec3Schema,
} from "./commands/snapshot.js";

/**
 * DirectorCommand 合同：导演台 14 种命令的结构与校验（本期不接 Pi，只定契约）。
 * 每条命令都带 projectId/sceneId/sceneVersion（乐观锁）与类型化 payload；
 * 执行语义（applyCommand/undo 纯函数）在 commands/executor.ts，
 * inverse 由 executor 在应用时生成，调用方据此实现撤销栈。
 */

const commandBase = {
  projectId: z.string().uuid(),
  sceneId: z.string().uuid(),
  sceneVersion: z.number().int().min(0),
};

const objectIdSchema = z.string().min(1);

export const addObjectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("add_object"),
  payload: z.object({ object: sceneObjectSchema }),
});

export const duplicateObjectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("duplicate_object"),
  payload: z.object({
    objectId: objectIdSchema,
    newObjectId: objectIdSchema.optional(),
    name: z.string().min(1).max(128).optional(),
  }),
});

export const deleteObjectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("delete_object"),
  payload: z.object({ objectId: objectIdSchema }),
});

export const selectObjectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("select_object"),
  payload: z.object({ objectId: objectIdSchema.nullable() }),
});

export const setTransformCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_transform"),
  payload: z.object({
    objectId: objectIdSchema,
    transform: transformPatchSchema,
  }),
});

export const setPoseCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_pose"),
  payload: z.object({
    objectId: objectIdSchema,
    pose: poseSchema,
  }),
});

export const addCameraCommandSchema = z.object({
  ...commandBase,
  type: z.literal("add_camera"),
  payload: z.object({ camera: sceneCameraSchema }),
});

export const setCameraCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_camera"),
  payload: z.object({
    cameraId: objectIdSchema,
    patch: z.looseObject({
      name: z.string().min(1).max(128).optional(),
      focalLength: z.number().positive().optional(),
      target: vec3Schema.optional(),
      position: vec3Schema.optional(),
      rollDeg: z.number().min(-45).max(45).nullable().optional(),
    }).refine(
      (value) => Object.values(value).some((item) => item !== undefined),
      { message: "patch 至少提供一个机位字段" },
    ),
  }),
});

export const setAspectRatioCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_aspect_ratio"),
  payload: z.object({ aspectRatio: aspectRatioSchema }),
});

export const setEnvironmentCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_environment"),
  payload: z.object({ patch: environmentPatchSchema }),
});

export const attachAssetCommandSchema = z.object({
  ...commandBase,
  type: z.literal("attach_asset"),
  payload: z.object({
    objectId: objectIdSchema,
    asset: attachedAssetSchema,
  }),
});

/** 动作类命令：不改变快照（持久化/截图/撤销各有专门通道），executor 中为恒等。 */
export const saveSceneCommandSchema = z.object({
  ...commandBase,
  type: z.literal("save_scene"),
});

export const captureViewCommandSchema = z.object({
  ...commandBase,
  type: z.literal("capture_view"),
  payload: z.looseObject({
    cameraId: objectIdSchema.optional(),
    label: z.string().max(128).optional(),
  }).optional(),
});

export const undoCommandSchema = z.object({
  ...commandBase,
  type: z.literal("undo"),
});

export const directorCommandSchema = z.discriminatedUnion("type", [
  addObjectCommandSchema,
  duplicateObjectCommandSchema,
  deleteObjectCommandSchema,
  selectObjectCommandSchema,
  setTransformCommandSchema,
  setPoseCommandSchema,
  addCameraCommandSchema,
  setCameraCommandSchema,
  setAspectRatioCommandSchema,
  setEnvironmentCommandSchema,
  attachAssetCommandSchema,
  saveSceneCommandSchema,
  captureViewCommandSchema,
  undoCommandSchema,
]);

export const DIRECTOR_COMMAND_TYPES = [
  "add_object",
  "duplicate_object",
  "delete_object",
  "select_object",
  "set_transform",
  "set_pose",
  "add_camera",
  "set_camera",
  "set_aspect_ratio",
  "set_environment",
  "attach_asset",
  "save_scene",
  "capture_view",
  "undo",
] as const;

/* ---------- 逆操作（inverse）合同：applyCommand 的输出、undo 的输入 ---------- */

export const commandInverseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noop"), reason: z.string().optional() }),
  z.object({
    type: z.literal("add_object"),
    collection: z.enum(["objects", "cameras"]),
    object: z.union([sceneObjectSchema, sceneCameraSchema]),
  }),
  z.object({ type: z.literal("delete_object"), objectId: objectIdSchema }),
  z.object({
    type: z.literal("set_transform"),
    objectId: objectIdSchema,
    /** 撤销时整体替换 transform；机位只有 position，故 rotation/scale 可选。 */
    transform: z.looseObject({
      position: vec3Schema,
      rotation: vec3Schema.optional(),
      scale: vec3Schema.optional(),
    }),
  }),
  z.object({
    type: z.literal("set_pose"),
    objectId: objectIdSchema,
    pose: poseSchema,
  }),
  z.object({
    type: z.literal("set_camera"),
    cameraId: objectIdSchema,
    camera: sceneCameraSchema,
  }),
  z.object({ type: z.literal("select_object"), objectId: objectIdSchema.nullable() }),
  z.object({ type: z.literal("set_aspect_ratio"), aspectRatio: aspectRatioSchema }),
  z.object({ type: z.literal("set_environment"), environment: environmentSchema }),
  z.object({
    type: z.literal("attach_asset"),
    objectId: objectIdSchema,
    asset: attachedAssetSchema,
  }),
  z.object({
    type: z.literal("detach_asset"),
    objectId: objectIdSchema,
    assetEntityId: z.string().uuid(),
  }),
]);

export type DirectorCommand = z.infer<typeof directorCommandSchema>;
export type DirectorCommandType = (typeof DIRECTOR_COMMAND_TYPES)[number];
export type CommandInverse = z.infer<typeof commandInverseSchema>;

/** 批量校验请求体（POST .../director/commands/validate）。 */
export const validateCommandsBodySchema = z.object({
  sceneId: z.string().uuid(),
  sceneVersion: z.number().int().min(0),
  commands: z.array(directorCommandSchema).min(1).max(100),
});

export type ValidateCommandsBody = z.infer<typeof validateCommandsBodySchema>;

/** 命令校验失败（引用不存在的对象等），统一 422。 */
export class CommandValidationError extends AppError {
  constructor(message: string, details: unknown | null = null) {
    super(422, "command_validation_failed", message, false, details);
    this.name = "CommandValidationError";
  }
}
