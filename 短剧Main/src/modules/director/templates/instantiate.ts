// Framing math adapted from blockout (Apache-2.0), © Sam Wasserman
// https://github.com/wassermanproductions/blockout
// 借鉴其 applyFraming 的参数化机位思路（OTS 后退+侧移、single 按景别反推距离、REV 镜像），
// 坐标系与竖屏景别参数按本项目导演台契约（y 向上、角度制、9:16）自行实现。
import {
  SHOT_SIZE_FILL_FRACTION,
  type ApplyOptions,
  type CameraSpec,
  type DirectorScene,
  type DirectorTemplate,
  type FocalLength,
  type ResolvedCamera,
  type ResolvedCharacter,
  type SceneCamera,
  type SceneMannequin,
  type ShotSize,
  type Vec2,
  type Vec3,
} from "./types.js";
import { TemplateApplyError, validateInstantiatedScene } from "./validate.js";

const DEG2RAD = Math.PI / 180;

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function vec3(x: number, y: number, z: number): Vec3 {
  return { x: round4(x), y: round4(y), z: round4(z) };
}

/** 绕 +Y 轴旋转（度）：x' = x·cos + z·sin，z' = -x·sin + z·cos。+90° 把 +x 转到 -z。 */
function rotate2(v: Vec2, deg: number): Vec2 {
  const rad = deg * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: v.x * cos + v.z * sin, z: -v.x * sin + v.z * cos };
}

function normalize2(v: Vec2): Vec2 {
  const length = Math.hypot(v.x, v.z);
  if (length < 1e-9) throw new TemplateApplyError("存在两点重合，无法确定方向");
  return { x: v.x / length, z: v.z / length };
}

function sub2(a: Vec3, b: Vec3): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

/** 轴线方向的左侧法向（轴 from→to 沿 +x 时 left 指向 -z）。 */
function leftPerp(axisDir: Vec2): Vec2 {
  return { x: axisDir.z, z: -axisDir.x };
}

/**
 * 按景别反推拍摄距离。
 * 竖屏 9:16 用传感器长边近似垂直视场：vfov = 2·atan(18/focalLength)；
 * 距离 = (visibleFraction × height) / (2·tan(vfov/2) × fillFraction)。
 */
export function distanceForShotSize(
  shotSize: ShotSize,
  focalLength: FocalLength,
  heightM: number,
  visibleFraction = 1,
): number {
  const vfov = 2 * Math.atan(18 / focalLength);
  const fillFraction = SHOT_SIZE_FILL_FRACTION[shotSize];
  return (visibleFraction * heightM) / (2 * Math.tan(vfov / 2) * fillFraction);
}

interface AppliedOrigin {
  x: number;
  z: number;
  headingDeg: number;
}

function resolveOrigin(template: DirectorTemplate, options: ApplyOptions): AppliedOrigin {
  return {
    x: options.origin?.x ?? template.origin?.x ?? 0,
    z: options.origin?.z ?? template.origin?.z ?? 0,
    headingDeg: options.headingDeg ?? options.origin?.headingDeg ?? template.origin?.headingDeg ?? 0,
  };
}

function toWorld(local: Vec2, origin: AppliedOrigin): Vec2 {
  const rotated = rotate2(local, origin.headingDeg);
  return { x: rotated.x + origin.x, z: rotated.z + origin.z };
}

function resolveCharacters(
  template: DirectorTemplate,
  options: ApplyOptions,
  origin: AppliedOrigin,
): ResolvedCharacter[] {
  const assignments = options.roleAssignments ?? {};
  for (const role of Object.keys(assignments)) {
    if (!template.characters.some((character) => character.role === role)) {
      throw new TemplateApplyError("选定的角色不在这个场景模板里");
    }
  }

  return template.characters.map((character) => {
    const assignment = assignments[character.role] ?? {};
    const height = assignment.height ?? character.height;

    // 朝向：faceTo 用模版本地坐标求方向角；headingDeg 直接用本地偏航。世界偏航 = 本地偏航 + origin 旋转。
    let localYawDeg: number;
    if ("faceTo" in character.facing) {
      const faceToRole = character.facing.faceTo;
      const target = template.characters.find((candidate) => candidate.role === faceToRole);
      if (!target) throw new TemplateApplyError("角色朝向找不到对应人物");
      const dir = {
        x: target.offset.x - character.offset.x,
        z: target.offset.z - character.offset.z,
      };
      localYawDeg = Math.atan2(dir.x, dir.z) / DEG2RAD;
    } else {
      localYawDeg = character.facing.headingDeg;
    }
    const worldYawDeg = ((localYawDeg + origin.headingDeg) % 360 + 360) % 360;
    const worldPosition = toWorld(character.offset, origin);

    return {
      role: character.role,
      name: assignment.name ?? character.role,
      bodyType: assignment.bodyType ?? character.bodyType,
      color: assignment.color ?? character.color,
      height,
      pose: character.pose.preset,
      position: { x: worldPosition.x, y: 0, z: worldPosition.z },
      facingYawDeg: worldYawDeg,
      facingDir: { x: Math.sin(worldYawDeg * DEG2RAD), z: Math.cos(worldYawDeg * DEG2RAD) },
    };
  });
}

function axisDirection(
  template: DirectorTemplate,
  byRole: Map<string, ResolvedCharacter>,
  cameraName: string,
): { axisDir: Vec2; axisFrom: ResolvedCharacter; axisTo: ResolvedCharacter } {
  const axis = template.axisOfAction;
  if (!axis) throw new TemplateApplyError("这个机位缺少人物站位关系，暂时不能生成");
  const axisFrom = byRole.get(axis.from);
  const axisTo = byRole.get(axis.to);
  if (!axisFrom || !axisTo) throw new TemplateApplyError("机位所需的人物站位不完整");
  return {
    axisDir: normalize2(sub2(axisTo.position, axisFrom.position)),
    axisFrom,
    axisTo,
  };
}

function resolveSingle(
  camera: Extract<CameraSpec, { relation: "single" }>,
  byRole: Map<string, ResolvedCharacter>,
): ResolvedCamera {
  const subject = byRole.get(camera.subject);
  if (!subject) throw new TemplateApplyError("机位的拍摄对象不存在");
  const distance =
    camera.distanceM ?? distanceForShotSize(camera.shotSize as ShotSize, camera.focalLength, subject.height, camera.visibleFraction ?? 1);
  // 机位沿“主体朝向反方向（视线反向）+ side 侧偏”退距：left 为正偏角，right 为负偏角。
  const signedBias = (camera.side === "left" ? 1 : -1) * (camera.sideBiasDeg ?? 6);
  const dir = rotate2(subject.facingDir, signedBias);
  return {
    name: camera.name,
    kind: "relational",
    relation: "single",
    position: {
      x: subject.position.x + dir.x * distance,
      y: camera.heightM ?? 1.5,
      z: subject.position.z + dir.z * distance,
    },
    target: {
      x: subject.position.x,
      y: (camera.targetHeightRatio ?? 0.88) * subject.height,
      z: subject.position.z,
    },
    focalLength: camera.focalLength,
    rollDeg: camera.rollDeg,
    declaredSide: camera.side,
    shotSize: camera.shotSize,
    coveredRoles: [subject.role],
  };
}

function resolveOts(
  camera: Extract<CameraSpec, { relation: "OTS" }>,
  template: DirectorTemplate,
  byRole: Map<string, ResolvedCharacter>,
): ResolvedCamera {
  const near = byRole.get(camera.near);
  const far = byRole.get(camera.far);
  if (!near || !far) throw new TemplateApplyError("近景和远景的人物不完整");
  const { axisDir } = axisDirection(template, byRole, camera.name);
  // 近肩角色沿两人连线后退 backM，再沿动作轴线 side 侧法向侧移 sideM；side 相对模版轴线判定，保证双边 OTS 同侧。
  const retreat = normalize2(sub2(near.position, far.position));
  const sidePerp = leftPerp(axisDir);
  const sideSign = camera.side === "left" ? 1 : -1;
  const back = camera.backM ?? 0.75;
  const side = camera.sideM ?? 0.45;
  return {
    name: camera.name,
    kind: "relational",
    relation: "OTS",
    position: {
      x: near.position.x + retreat.x * back + sidePerp.x * side * sideSign,
      y: 0.92 * near.height,
      z: near.position.z + retreat.z * back + sidePerp.z * side * sideSign,
    },
    target: { x: far.position.x, y: 0.88 * far.height, z: far.position.z },
    focalLength: camera.focalLength,
    rollDeg: camera.rollDeg,
    declaredSide: camera.side,
    coveredRoles: [near.role, far.role],
  };
}

/** 沿动作轴线做轴向镜像：翻转平行于轴线的分量，保留侧向分量，因此镜像后仍在轴线同侧。 */
function mirrorAlongAxis(point: Vec3, midpoint: Vec2, axisDir: Vec2): Vec3 {
  const vx = point.x - midpoint.x;
  const vz = point.z - midpoint.z;
  const along = vx * axisDir.x + vz * axisDir.z;
  return {
    x: midpoint.x + vx - 2 * along * axisDir.x,
    y: point.y,
    z: midpoint.z + vz - 2 * along * axisDir.z,
  };
}

function resolveRev(
  camera: Extract<CameraSpec, { relation: "REV" }>,
  template: DirectorTemplate,
  byRole: Map<string, ResolvedCharacter>,
  resolvedByName: Map<string, ResolvedCamera>,
): ResolvedCamera {
  const source = resolvedByName.get(camera.mirrorOf);
  if (!source) {
    throw new TemplateApplyError("镜像机位缺少参照机位");
  }
  const { axisDir, axisFrom, axisTo } = axisDirection(template, byRole, camera.name);
  const midpoint = {
    x: (axisFrom.position.x + axisTo.position.x) / 2,
    z: (axisFrom.position.z + axisTo.position.z) / 2,
  };
  const swapAcrossAxis = (role: string): string => {
    if (template.axisOfAction && role === template.axisOfAction.from) return template.axisOfAction.to;
    if (template.axisOfAction && role === template.axisOfAction.to) return template.axisOfAction.from;
    return role;
  };
  return {
    name: camera.name,
    kind: "relational",
    relation: "REV",
    position: mirrorAlongAxis(source.position, midpoint, axisDir),
    target: mirrorAlongAxis(source.target, midpoint, axisDir),
    focalLength: camera.focalLength ?? source.focalLength,
    rollDeg: camera.rollDeg ?? (source.rollDeg !== undefined ? -source.rollDeg : undefined),
    declaredSide: source.declaredSide,
    shotSize: source.shotSize,
    coveredRoles: source.coveredRoles.map(swapAcrossAxis),
  };
}

function resolveExplicit(
  camera: Extract<CameraSpec, { kind: "explicit" }>,
  byRole: Map<string, ResolvedCharacter>,
  origin: AppliedOrigin,
): ResolvedCamera {
  const position = toWorld(camera.offset, origin);
  let target: Vec3;
  let coveredRoles: string[];
  if ("role" in camera.lookAt) {
    const character = byRole.get(camera.lookAt.role);
    if (!character) throw new TemplateApplyError("机位看向的角色不存在");
    target = {
      x: character.position.x,
      y: (camera.lookAt.heightRatio ?? 0.6) * character.height,
      z: character.position.z,
    };
    coveredRoles = [character.role];
  } else {
    const first = byRole.get(camera.lookAt.midpointOf[0]);
    const second = byRole.get(camera.lookAt.midpointOf[1]);
    if (!first || !second) throw new TemplateApplyError("机位看向的人物不完整");
    target = {
      x: (first.position.x + second.position.x) / 2,
      y: ((first.height + second.height) / 2) * (camera.lookAt.heightRatio ?? 0.6),
      z: (first.position.z + second.position.z) / 2,
    };
    coveredRoles = [first.role, second.role];
  }
  return {
    name: camera.name,
    kind: "explicit",
    position: { x: position.x, y: camera.heightM ?? 1.5, z: position.z },
    target,
    focalLength: camera.focalLength,
    rollDeg: camera.rollDeg,
    coveredRoles,
  };
}

/**
 * 实例化模版：origin{x,z,headingDeg} + roleAssignments → 导演台场景 JSON。
 * 输出坐标为世界坐标（米，y 向上）；rotation 为角度制。
 * 失败抛 TemplateApplyError（间距/越轴/覆盖/距离不合理，或角色指派错误）。
 */
export function instantiateTemplate(template: DirectorTemplate, options: ApplyOptions = {}): DirectorScene {
  const origin = resolveOrigin(template, options);
  const characters = resolveCharacters(template, options, origin);
  const byRole = new Map(characters.map((character) => [character.role, character]));

  const cameras: ResolvedCamera[] = [];
  const resolvedByName = new Map<string, ResolvedCamera>();
  for (const camera of template.cameras) {
    let resolved: ResolvedCamera;
    if (camera.kind === "explicit") {
      resolved = resolveExplicit(camera, byRole, origin);
    } else if (camera.relation === "single") {
      resolved = resolveSingle(camera, byRole);
    } else if (camera.relation === "OTS") {
      resolved = resolveOts(camera, template, byRole);
    } else {
      resolved = resolveRev(camera, template, byRole, resolvedByName);
    }
    cameras.push(resolved);
    resolvedByName.set(resolved.name, resolved);
  }

  validateInstantiatedScene(template, characters, cameras);

  const objects: SceneMannequin[] = characters.map((character) => ({
    id: `mannequin-${character.role}`,
    role: character.role,
    name: character.name,
    type: "mannequin",
    bodyType: character.bodyType,
    color: character.color,
    height: character.height,
    pose: { preset: character.pose },
    joints: null,
    transform: {
      position: vec3(character.position.x, 0, character.position.z),
      rotation: { x: 0, y: round2(character.facingYawDeg), z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  }));

  const sceneCameras: SceneCamera[] = cameras.map((camera, index) => ({
    id: `camera-${index + 1}`,
    name: camera.name,
    type: "camera",
    focalLength: camera.focalLength,
    target: vec3(camera.target.x, camera.target.y, camera.target.z),
    transform: { position: vec3(camera.position.x, camera.position.y, camera.position.z) },
    ...(camera.rollDeg !== undefined ? { rollDeg: camera.rollDeg } : {}),
    meta: {
      kind: camera.kind,
      ...(camera.relation ? { relation: camera.relation } : {}),
      ...(camera.declaredSide ? { side: camera.declaredSide } : {}),
      ...(camera.shotSize ? { shotSize: camera.shotSize } : {}),
      subjectRoles: camera.coveredRoles,
    },
  }));

  const axis = template.axisOfAction
    ? (() => {
        const from = byRole.get(template.axisOfAction.from);
        const to = byRole.get(template.axisOfAction.to);
        if (!from || !to) return null;
        return {
          fromRole: from.role,
          toRole: to.role,
          from: { x: round4(from.position.x), z: round4(from.position.z) },
          to: { x: round4(to.position.x), z: round4(to.position.z) },
        };
      })()
    : null;

  return {
    schemaVersion: 1,
    templateId: template.id,
    templateName: template.name,
    category: template.category,
    applied: {
      origin,
      roles: Object.fromEntries(
        characters.map((character) => [
          character.role,
          { name: character.name, bodyType: character.bodyType, color: character.color, height: character.height },
        ]),
      ),
    },
    objects,
    cameras: sceneCameras,
    axis,
    ...(template.moves ? { moves: template.moves } : {}),
    promptHints: template.promptHints,
  };
}
