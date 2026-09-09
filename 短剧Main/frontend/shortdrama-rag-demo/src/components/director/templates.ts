/**
 * 3D 导演台 · 模版实例化合入（POST /director/templates/:id/apply 的返回 → 当前场景）
 *
 * 后端 instantiateTemplate 输出 DirectorScene（objects: SceneMannequin[] / cameras: SceneCamera[]，
 * 见 src/modules/director/templates/types.ts），本模块把它合入 store：
 * - 素模：position/rotation 原样；pose.preset 映射为姿势 id；height 折算为统一缩放
 *   （store 的身高由 bodyType 决定：scale = height / BODIES[bodyType].height）；
 *   joints 后端固定 null → store 空微调 {}。
 * - 机位：position/target/focalLength 原样（rollDeg store 不支持，
 *   连同 meta/templateId 一起经 noteObjectExtras 暂存，保存快照时透传留痕）。
 * - id 全部由 store.addObject 重新分配，重复应用同一模版不会撞 id。
 * - 返回值带 sourceAction（template:apply:<id>），workspace 在下一次保存时写入版本留痕。
 */
import { noteObjectExtras } from "./snapshot";
import { BODIES } from "./scene/bodies";
import { useDirectorStore } from "./store";
import { FOCAL_LENGTHS } from "./types";
import type { BodyTypeId, FocalLength, Vec3 } from "./types";

interface TemplateVec3 {
  x: number;
  y: number;
  z: number;
}

interface TemplateMannequin {
  id: string;
  role?: string;
  name: string;
  type: "mannequin";
  bodyType?: string;
  color?: string;
  height?: number;
  pose?: { preset?: string } | null;
  transform: { position: TemplateVec3; rotation?: TemplateVec3; scale?: TemplateVec3 };
}

interface TemplateCamera {
  id: string;
  name: string;
  type: "camera";
  focalLength?: number;
  target: TemplateVec3;
  transform: { position: TemplateVec3 };
  rollDeg?: number;
  meta?: Record<string, unknown>;
}

export interface TemplateApplyScene {
  templateId: string;
  templateName: string;
  objects: TemplateMannequin[];
  cameras: TemplateCamera[];
}

export interface MergeTemplateResult {
  addedObjectIds: string[];
  addedCameraIds: string[];
  /** 来源动作标记：保存场景时写入版本 sourceAction 留痕 */
  sourceAction: string;
  templateName: string;
}

const toVec = (value: TemplateVec3 | undefined, fallback: Vec3): Vec3 =>
  value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
    ? [value.x, value.y, value.z]
    : fallback;

function readBodyType(value: string | undefined): BodyTypeId {
  // 后端模版只有 male/female，这里兼容全量体型 id，未命中回落 male
  switch (value) {
    case "female":
    case "wide":
    case "muscular":
    case "slim":
    case "teen":
    case "child":
    case "chibi":
      return value;
    default:
      return "male";
  }
}

/** 防御性解析 apply 响应（unknown → TemplateApplyScene），结构不符抛 Error */
export function parseTemplateApplyScene(input: unknown): TemplateApplyScene {
  const record = input as Record<string, unknown> | null;
  if (!record || !Array.isArray(record["objects"]) || !Array.isArray(record["cameras"])) {
    throw new Error("模版实例化响应结构无法识别（缺少 objects/cameras）");
  }
  return {
    templateId: typeof record["templateId"] === "string" ? record["templateId"] : "unknown",
    templateName: typeof record["templateName"] === "string" ? record["templateName"] : "未命名模版",
    objects: record["objects"] as TemplateMannequin[],
    cameras: record["cameras"] as TemplateCamera[],
  };
}

/** 把实例化场景合入当前 store（追加，不清空现有对象）；返回新增 id 与来源动作 */
export function mergeTemplateScene(scene: TemplateApplyScene): MergeTemplateResult {
  const store = useDirectorStore.getState();
  const addedObjectIds: string[] = [];
  const addedCameraIds: string[] = [];

  for (const object of scene.objects) {
    const bodyType = readBodyType(object.bodyType);
    const height =
      typeof object.height === "number" && object.height > 0 ? object.height : BODIES[bodyType].height;
    // 身高折算统一缩放（保留三位小数；1.75m 男性 ≈ 0.994 接近原生体型）
    const uniform = Math.round((height / BODIES[bodyType].height) * 1000) / 1000;
    const color =
      typeof object.color === "string" && /^#[0-9a-fA-F]{6}$/.test(object.color)
        ? object.color.toUpperCase()
        : "#9AA0A8";
    const id = store.addObject({
      name: object.name || "角色",
      type: "mannequin",
      visible: true,
      transform: {
        position: toVec(object.transform?.position, [0, 0, 0]),
        rotation: toVec(object.transform?.rotation, [0, 0, 0]),
        scale: [uniform, uniform, uniform],
      },
      color,
      bodyType,
      pose: object.pose?.preset ?? "stand",
      joints: {},
    });
    noteObjectExtras(id, { templateId: scene.templateId, role: object.role ?? object.name });
    addedObjectIds.push(id);
  }

  for (const camera of scene.cameras) {
    const focalLength = (FOCAL_LENGTHS as readonly number[]).includes(Number(camera.focalLength))
      ? (Number(camera.focalLength) as FocalLength)
      : 35;
    const id = store.addObject({
      name: camera.name || "机位",
      type: "camera",
      visible: true,
      transform: {
        position: toVec(camera.transform?.position, [3, 2.2, 4]),
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      focalLength,
      target: toVec(camera.target, [0, 1, 0]),
    });
    noteObjectExtras(id, {
      templateId: scene.templateId,
      ...(camera.rollDeg !== undefined ? { rollDeg: camera.rollDeg } : {}),
      ...(camera.meta ? { meta: camera.meta } : {}),
    });
    addedCameraIds.push(id);
  }

  return {
    addedObjectIds,
    addedCameraIds,
    sourceAction: `template:apply:${scene.templateId}`,
    templateName: scene.templateName,
  };
}
