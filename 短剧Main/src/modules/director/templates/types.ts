import { z } from "zod";

/**
 * 导演台站位/动作/镜头组合模版包的类型契约。
 * 模版 JSON 存放于 assets/director/templates/*.json，本文件是其 zod schema。
 */

export const POSE_PRESETS = [
  "stand",
  "tpose",
  "walk",
  "run",
  "sit",
  "squat",
  "kneelOne",
  "kneelBoth",
  "akimbo",
  "lean",
  "bow",
  "think",
  "fight",
  "kick",
  "throw",
  "push",
  "wave",
  "reach",
  "foldedArms",
  "phone",
] as const;

export const SHOT_SIZES = ["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"] as const;

export const FOCAL_LENGTHS = [16, 24, 35, 50, 85] as const;

export const TEMPLATE_CATEGORIES = [
  "dialogue",
  "confrontation",
  "emotion",
  "movement",
  "action",
  "establishing",
] as const;

export const BODY_TYPES = ["male", "female"] as const;

/**
 * 9:16 竖屏下各景别“人高占画面高度比例”的经验值，由《天尊》1289 镜分镜统计拟合。
 * ECU > 1 表示人高超出画面（裁切）。
 */
export const SHOT_SIZE_FILL_FRACTION: Record<ShotSize, number> = {
  EWS: 0.25,
  WS: 0.4,
  FS: 0.55,
  MS: 0.7,
  MCU: 0.85,
  CU: 1.0,
  ECU: 1.2,
};

const posePresetSchema = z.enum(POSE_PRESETS);
const shotSizeSchema = z.enum(SHOT_SIZES);
const focalLengthSchema = z.union([
  z.literal(16),
  z.literal(24),
  z.literal(35),
  z.literal(50),
  z.literal(85),
]);
const sideSchema = z.enum(["left", "right"]);
const roleSchema = z.string().min(1);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色必须是 #RRGGBB 形式");

const offsetSchema = z.object({
  x: z.number(),
  z: z.number(),
});

const facingSchema = z.union([
  z.object({ faceTo: roleSchema }),
  z.object({ headingDeg: z.number() }),
]);

const characterSchema = z.object({
  role: roleSchema,
  offset: offsetSchema,
  facing: facingSchema,
  pose: z.object({ preset: posePresetSchema }),
  height: z.number().min(0.5).max(2.5),
  bodyType: z.enum(BODY_TYPES),
  color: colorSchema,
});

const spacingSchema = z.object({
  between: z.tuple([roleSchema, roleSchema]),
  min: z.number().positive(),
  max: z.number().positive(),
});

const constraintsSchema = z.object({
  spacing: z.array(spacingSchema).optional(),
  keepSide: z.boolean().optional(),
});

const singleCameraSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("relational"),
  relation: z.literal("single"),
  subject: roleSchema,
  side: sideSchema,
  shotSize: shotSizeSchema.optional(),
  /** 直接指定拍摄距离（米）；给出时优先于 shotSize 反推。 */
  distanceM: z.number().positive().optional(),
  focalLength: focalLengthSchema,
  heightM: z.number().min(0.05).max(10).optional(),
  /** 相对主体朝向的侧偏角（度），默认 6。 */
  sideBiasDeg: z.number().min(0).max(45).optional(),
  /** 注视点高度占主体身高比例，默认 0.88（眼线）。 */
  targetHeightRatio: z.number().min(0).max(1).optional(),
  /** 主体可见身高比例（跪姿/坐姿 < 1），默认 1。 */
  visibleFraction: z.number().positive().max(1).optional(),
  rollDeg: z.number().min(-45).max(45).optional(),
});

const otsCameraSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("relational"),
  relation: z.literal("OTS"),
  near: roleSchema,
  far: roleSchema,
  side: sideSchema,
  focalLength: focalLengthSchema,
  /** 沿两人连线自近肩角色后退距离（米），默认 0.75。 */
  backM: z.number().positive().optional(),
  /** 垂直于连线的侧移距离（米），默认 0.45。 */
  sideM: z.number().min(0).optional(),
  rollDeg: z.number().min(-45).max(45).optional(),
});

const revCameraSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("relational"),
  relation: z.literal("REV"),
  /** 被镜像的机位名（必须先于本机位定义）。 */
  mirrorOf: z.string().min(1),
  focalLength: focalLengthSchema.optional(),
  rollDeg: z.number().min(-45).max(45).optional(),
});

const lookAtSchema = z.union([
  z.object({ role: roleSchema, heightRatio: z.number().min(0).max(1).optional() }),
  z.object({
    midpointOf: z.tuple([roleSchema, roleSchema]),
    heightRatio: z.number().min(0).max(1).optional(),
  }),
]);

const explicitCameraSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("explicit"),
  offset: offsetSchema,
  heightM: z.number().min(0.05).max(10).optional(),
  lookAt: lookAtSchema,
  focalLength: focalLengthSchema,
  rollDeg: z.number().min(-45).max(45).optional(),
});

export const cameraSpecSchema = z.union([
  singleCameraSchema,
  otsCameraSchema,
  revCameraSchema,
  explicitCameraSchema,
]);

const moveSchema = z.object({
  type: z.string().min(1),
  fromCamera: z.string().min(1).optional(),
  toCamera: z.string().min(1).optional(),
  note: z.string().optional(),
});

export const directorTemplateSchema = z.object({
  schemaVersion: z.literal(1),
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "id 必须是 kebab-case"),
  name: z.string().min(1),
  category: z.enum(TEMPLATE_CATEGORIES),
  tags: z.array(z.string().min(1)).min(1),
  characterCount: z.number().int().min(1).max(8),
  mood: z.array(z.string().min(1)).min(1),
  axisOfAction: z.object({ from: roleSchema, to: roleSchema }).optional(),
  origin: z
    .object({
      x: z.number(),
      z: z.number(),
      headingDeg: z.number().default(0),
    })
    .optional(),
  characters: z.array(characterSchema).min(1).max(8),
  constraints: constraintsSchema.optional(),
  cameras: z.array(cameraSpecSchema).min(2).max(6),
  moves: z.array(moveSchema).optional(),
  promptHints: z.object({ zh: z.string().min(1), en: z.string().min(1) }),
  dataSource: z.string().min(1),
});

export type PosePreset = z.infer<typeof posePresetSchema>;
export type ShotSize = z.infer<typeof shotSizeSchema>;
export type FocalLength = z.infer<typeof focalLengthSchema>;
export type CameraSide = z.infer<typeof sideSchema>;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export type BodyType = (typeof BODY_TYPES)[number];
export type TemplateCharacter = z.infer<typeof characterSchema>;
export type CameraSpec = z.infer<typeof cameraSpecSchema>;
export type SingleCameraSpec = z.infer<typeof singleCameraSchema>;
export type OtsCameraSpec = z.infer<typeof otsCameraSchema>;
export type RevCameraSpec = z.infer<typeof revCameraSchema>;
export type ExplicitCameraSpec = z.infer<typeof explicitCameraSchema>;
export type TemplateMove = z.infer<typeof moveSchema>;
export type DirectorTemplate = z.infer<typeof directorTemplateSchema>;

/** apply 请求体（API 与 instantiate 共用）。 */
export const applyOptionsSchema = z.object({
  origin: z
    .object({
      x: z.number().optional(),
      z: z.number().optional(),
      headingDeg: z.number().optional(),
    })
    .optional(),
  headingDeg: z.number().optional(),
  roleAssignments: z
    .record(
      z.string(),
      z.object({
        name: z.string().min(1).optional(),
        bodyType: z.enum(BODY_TYPES).optional(),
        color: colorSchema.optional(),
        height: z.number().min(0.5).max(2.5).optional(),
      }),
    )
    .optional(),
});

export type ApplyOptions = z.infer<typeof applyOptionsSchema>;
export type RoleAssignment = NonNullable<ApplyOptions["roleAssignments"]>[string];

/* ---------- 实例化输出（导演台场景 JSON 契约） ---------- */

export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SceneMannequin {
  id: string;
  role: string;
  name: string;
  type: "mannequin";
  bodyType: BodyType;
  color: string;
  height: number;
  pose: { preset: PosePreset };
  /** 关节级姿态由前端按 preset 展开，实例化输出固定为 null。 */
  joints: null;
  transform: {
    position: Vec3;
    /** 角度制欧拉角；y 为朝向（0 = +z，90 = +x）。 */
    rotation: Vec3;
    scale: Vec3;
  };
}

export interface SceneCamera {
  id: string;
  name: string;
  type: "camera";
  focalLength: FocalLength;
  target: Vec3;
  transform: { position: Vec3 };
  rollDeg?: number;
  meta: {
    kind: "relational" | "explicit";
    relation?: "single" | "OTS" | "REV";
    side?: CameraSide;
    shotSize?: ShotSize;
    subjectRoles: string[];
  };
}

export interface DirectorScene {
  schemaVersion: 1;
  templateId: string;
  templateName: string;
  category: TemplateCategory;
  applied: {
    origin: { x: number; z: number; headingDeg: number };
    roles: Record<string, { name: string; bodyType: BodyType; color: string; height: number }>;
  };
  objects: SceneMannequin[];
  cameras: SceneCamera[];
  axis: {
    fromRole: string;
    toRole: string;
    from: Vec2;
    to: Vec2;
  } | null;
  moves?: TemplateMove[];
  promptHints: { zh: string; en: string };
}

/* ---------- instantiate/validate 内部解析结果 ---------- */

export interface ResolvedCharacter {
  role: string;
  name: string;
  bodyType: BodyType;
  color: string;
  height: number;
  pose: PosePreset;
  /** 世界坐标，y = 0。 */
  position: Vec3;
  /** 世界朝向（度，0 = +z，90 = +x）。 */
  facingYawDeg: number;
  /** 世界朝向单位向量（xz 平面）。 */
  facingDir: Vec2;
}

export interface ResolvedCamera {
  name: string;
  kind: "relational" | "explicit";
  relation?: "single" | "OTS" | "REV";
  position: Vec3;
  target: Vec3;
  focalLength: FocalLength;
  rollDeg?: number;
  declaredSide?: CameraSide;
  shotSize?: ShotSize;
  /** 该机位画面覆盖的角色 role 集合。 */
  coveredRoles: string[];
}
