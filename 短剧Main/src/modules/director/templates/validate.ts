import { AppError } from "../../../shared/errors.js";
import type {
  DirectorTemplate,
  ResolvedCamera,
  ResolvedCharacter,
  Vec2,
} from "./types.js";

/** apply/实例化校验失败统一抛 422，由全局错误处理器包成 {ok:false,error}。 */
export class TemplateApplyError extends AppError {
  constructor(message: string, details: unknown | null = null) {
    super(422, "template_apply_failed", message, false, details);
    this.name = "TemplateApplyError";
  }
}

const EPS = 1e-9;

function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function normalize2(v: Vec2): Vec2 {
  const length = Math.hypot(v.x, v.z);
  if (length < EPS) throw new TemplateApplyError("存在两点重合，无法确定方向");
  return { x: v.x / length, z: v.z / length };
}

/**
 * 点 P 相对有向轴线（from→to）的侧向叉积符号。
 * 世界约定：y 向上、右手系；轴 from→to 沿 +x 时，z < 0 一侧为 "left"。
 */
export function axisCross(axisFrom: Vec2, axisTo: Vec2, point: Vec2): number {
  const dir = normalize2({ x: axisTo.x - axisFrom.x, z: axisTo.z - axisFrom.z });
  return dir.x * (point.z - axisFrom.z) - dir.z * (point.x - axisFrom.x);
}

export function sideOfPoint(axisFrom: Vec2, axisTo: Vec2, point: Vec2): "left" | "right" | "on-axis" {
  const cross = axisCross(axisFrom, axisTo, point);
  if (Math.abs(cross) < EPS) return "on-axis";
  return cross < 0 ? "left" : "right";
}

/**
 * 模版加载时的静态结构校验（registry 读入每个 JSON 后执行）。
 * 失败抛 Error（资产损坏属于部署期问题，fail fast）。
 */
export function validateTemplateDefinition(template: DirectorTemplate): void {
  const fail = (reason: string): never => {
    throw new Error(`模版 ${template.id} 结构不合法: ${reason}`);
  };

  const roles = new Set<string>();
  for (const character of template.characters) {
    if (roles.has(character.role)) fail(`角色 ${character.role} 重复定义`);
    roles.add(character.role);
  }
  if (template.characterCount !== template.characters.length) {
    fail(`characterCount=${template.characterCount} 与实际角色数 ${template.characters.length} 不一致`);
  }
  const requireRole = (role: string, where: string): void => {
    if (!roles.has(role)) fail(`${where} 引用了不存在的角色 ${role}`);
  };

  for (const character of template.characters) {
    if ("faceTo" in character.facing) {
      requireRole(character.facing.faceTo, `角色 ${character.role} 的 facing.faceTo`);
      if (character.facing.faceTo === character.role) fail(`角色 ${character.role} 的 facing.faceTo 不能指向自己`);
    }
  }

  const axis = template.axisOfAction;
  if (axis) {
    requireRole(axis.from, "axisOfAction.from");
    requireRole(axis.to, "axisOfAction.to");
    if (axis.from === axis.to) fail("axisOfAction 两端不能是同一角色");
  }

  for (const spacing of template.constraints?.spacing ?? []) {
    requireRole(spacing.between[0], "constraints.spacing");
    requireRole(spacing.between[1], "constraints.spacing");
    if (spacing.min > spacing.max) fail(`spacing ${spacing.between.join("/")} 的 min 大于 max`);
  }
  if (template.constraints?.keepSide && !axis) fail("keepSide 校验需要声明 axisOfAction");

  const cameraNames = new Set<string>();
  for (const camera of template.cameras) {
    if (cameraNames.has(camera.name)) fail(`机位 ${camera.name} 重复定义`);
    if (camera.kind === "relational") {
      if (camera.relation === "single") {
        requireRole(camera.subject, `机位 ${camera.name} 的 subject`);
        if (!camera.shotSize && camera.distanceM === undefined) {
          fail(`机位 ${camera.name} 缺少 shotSize 与 distanceM，无法确定拍摄距离`);
        }
      } else if (camera.relation === "OTS") {
        requireRole(camera.near, `机位 ${camera.name} 的 near`);
        requireRole(camera.far, `机位 ${camera.name} 的 far`);
        if (camera.near === camera.far) fail(`机位 ${camera.name} 的 near 与 far 不能相同`);
        if (!axis) fail(`OTS 机位 ${camera.name} 需要模版声明 axisOfAction`);
      } else {
        if (!cameraNames.has(camera.mirrorOf)) fail(`REV 机位 ${camera.name} 的 mirrorOf 必须引用先于它定义的机位`);
        if (!axis) fail(`REV 机位 ${camera.name} 需要模版声明 axisOfAction`);
      }
    } else {
      if ("role" in camera.lookAt) {
        requireRole(camera.lookAt.role, `机位 ${camera.name} 的 lookAt`);
      } else {
        requireRole(camera.lookAt.midpointOf[0], `机位 ${camera.name} 的 lookAt.midpointOf`);
        requireRole(camera.lookAt.midpointOf[1], `机位 ${camera.name} 的 lookAt.midpointOf`);
      }
    }
    cameraNames.add(camera.name);
  }

  for (const move of template.moves ?? []) {
    if (move.fromCamera && !cameraNames.has(move.fromCamera)) fail(`moves 引用了不存在的机位 ${move.fromCamera}`);
    if (move.toCamera && !cameraNames.has(move.toCamera)) fail(`moves 引用了不存在的机位 ${move.toCamera}`);
  }
}

/**
 * 实例化结果校验：间距约束、keepSide 越轴、角色机位覆盖、景别距离合理性。
 * 任何一条不满足即抛 TemplateApplyError（422）。
 */
export function validateInstantiatedScene(
  template: DirectorTemplate,
  characters: ResolvedCharacter[],
  cameras: ResolvedCamera[],
): void {
  const byRole = new Map(characters.map((character) => [character.role, character]));

  // 1. 间距约束
  for (const spacing of template.constraints?.spacing ?? []) {
    const first = byRole.get(spacing.between[0]);
    const second = byRole.get(spacing.between[1]);
    if (!first || !second) continue; // 静态校验已拦截
    const distance = dist2(first.position, second.position);
    if (distance < spacing.min - 1e-6 || distance > spacing.max + 1e-6) {
      throw new TemplateApplyError(
        `角色 ${spacing.between[0]}/${spacing.between[1]} 间距 ${distance.toFixed(2)}m 超出约束 [${spacing.min}, ${spacing.max}]m`,
      );
    }
  }

  // 2. keepSide 越轴校验：所有机位必须位于动作轴线同一侧，且与声明的 side 一致
  if (template.constraints?.keepSide && template.axisOfAction) {
    const axisFrom = byRole.get(template.axisOfAction.from)?.position;
    const axisTo = byRole.get(template.axisOfAction.to)?.position;
    if (axisFrom && axisTo) {
      let expectedSide: "left" | "right" | undefined;
      for (const camera of cameras) {
        const side = sideOfPoint(axisFrom, axisTo, camera.position);
        if (side === "on-axis") {
          throw new TemplateApplyError(`机位 ${camera.name} 压在动作轴线上，无法保持轴线同侧`);
        }
        expectedSide ??= side;
        if (side !== expectedSide) {
          throw new TemplateApplyError(
            `机位 ${camera.name} 位于轴线 ${side} 侧，与其他机位（${expectedSide} 侧）不一致，构成越轴`,
          );
        }
        if (camera.declaredSide && camera.declaredSide !== side) {
          throw new TemplateApplyError(
            `机位 ${camera.name} 声明 side=${camera.declaredSide}，但实际位于轴线 ${side} 侧`,
          );
        }
      }
    }
  }

  // 3. 每个角色至少被一个机位覆盖
  const covered = new Set(cameras.flatMap((camera) => camera.coveredRoles));
  for (const character of characters) {
    if (!covered.has(character.role)) {
      throw new TemplateApplyError(`角色 ${character.role} 没有被任何机位覆盖`);
    }
  }

  // 4. 景别距离合理性与机位安全性
  for (const camera of cameras) {
    const targetDistance = dist2(camera.position, camera.target);
    if (targetDistance < 0.3 || targetDistance > 30) {
      throw new TemplateApplyError(
        `机位 ${camera.name} 与拍摄目标距离 ${targetDistance.toFixed(2)}m 超出合理范围 [0.3, 30]m`,
      );
    }
    if (camera.position.y < 0.05 || camera.position.y > 10) {
      throw new TemplateApplyError(`机位 ${camera.name} 高度 ${camera.position.y.toFixed(2)}m 超出合理范围 [0.05, 10]m`);
    }
    for (const character of characters) {
      // relational 机位按构造贴近被摄角色（如 OTS 近肩），对被覆盖角色豁免碰撞检查
      if (camera.kind === "relational" && camera.coveredRoles.includes(character.role)) continue;
      const clearance = dist2(camera.position, character.position);
      if (clearance < 0.25) {
        throw new TemplateApplyError(
          `机位 ${camera.name} 与角色 ${character.role} 距离 ${clearance.toFixed(2)}m，发生穿模`,
        );
      }
    }
  }
}
