/**
 * cameraMotions 单测：六预设的端点几何 + 采样缓动（纯逻辑，node:test 直跑）。
 * 断言的是运镜语义而不是实现细节：推拉改距离不改方向、摇不改机位、
 * 环绕保距半周、跟随锁目标横移。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MOTION_DURATIONS,
  MOTION_PRESETS,
  followAimFor,
  motionEase,
  motionEndPose,
  sampleMotion,
} from "./cameraMotions";
import type { CameraObject, SceneObject, Vec3 } from "../types";

function fakeCamera(position: Vec3, target: Vec3): CameraObject {
  return {
    id: "cam-1",
    name: "机位 1",
    type: "camera",
    visible: true,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    focalLength: 35,
    target,
  };
}

function fakeObject(position: Vec3): SceneObject {
  return {
    id: "obj-1",
    name: "角色 1",
    type: "mannequin",
    visible: true,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    color: "#9AA0A8",
    bodyType: "male",
    pose: "stand",
    joints: {},
  };
}

const close = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

const vecClose = (actual: Vec3, expected: Vec3, eps = 1e-6) => {
  close(actual[0], expected[0], eps);
  close(actual[1], expected[1], eps);
  close(actual[2], expected[2], eps);
};

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("运镜预设表", () => {
  it("六预设齐全、顺序冻结，跟随是唯一需要选中对象的预设", () => {
    assert.deepEqual(
      MOTION_PRESETS.map((preset) => preset.id),
      ["dolly-in", "dolly-out", "pan-left", "pan-right", "orbit", "follow"],
    );
    assert.deepEqual(
      MOTION_PRESETS.map((preset) => preset.label),
      ["推近", "拉远", "左摇", "右摇", "环绕", "跟随"],
    );
    assert.deepEqual(
      MOTION_PRESETS.filter((preset) => preset.needsFollowTarget).map((preset) => preset.id),
      ["follow"],
    );
  });

  it("时长档位冻结为 3/5/8 秒", () => {
    assert.deepEqual([...MOTION_DURATIONS], [3, 5, 8]);
  });
});

describe("motionEase 缓动", () => {
  it("端点不动、中点恰半、单调递增", () => {
    assert.equal(motionEase(0), 0);
    assert.equal(motionEase(1), 1);
    assert.equal(motionEase(0.5), 0.5);
    let previous = 0;
    for (let t = 0.05; t <= 1; t += 0.05) {
      const value = motionEase(t);
      assert.ok(value > previous, `t=${t} 应严格递增`);
      previous = value;
    }
  });

  it("越界输入被钳制", () => {
    assert.equal(motionEase(-0.5), 0);
    assert.equal(motionEase(1.5), 1);
  });
});

describe("推近 / 拉远", () => {
  const camera = fakeCamera([0, 2, 10], [0, 1, 0]);

  it("推近终点：距离缩到 60%，方向共线，注视点不变", () => {
    const end = motionEndPose("dolly-in", camera)!;
    close(dist(end.position, end.target), dist(camera.transform.position, camera.target) * 0.6);
    vecClose(end.target, camera.target);
    // 位移方向与视线方向共线（叉积≈0）
    const view: Vec3 = [0 - 0, 1 - 2, 0 - 10];
    const move: Vec3 = [end.position[0] - 0, end.position[1] - 2, end.position[2] - 10];
    close(view[1] * move[2] - view[2] * move[1], 0);
    close(view[2] * move[0] - view[0] * move[2], 0);
    assert.ok(move[2] < 0, "向目标方向移动");
  });

  it("拉远终点：距离放大到 160%，远离目标", () => {
    const end = motionEndPose("dolly-out", camera)!;
    close(dist(end.position, end.target), dist(camera.transform.position, camera.target) * 1.6);
    assert.ok(end.position[2] > 10, "背离目标后退");
  });
});

describe("左摇 / 右摇", () => {
  const camera = fakeCamera([0, 2, 10], [0, 1, 0]);

  it("机位不动，视线水平转 25°", () => {
    for (const id of ["pan-left", "pan-right"] as const) {
      const end = motionEndPose(id, camera)!;
      vecClose(end.position, camera.transform.position);
      const from: Vec3 = [0, -1, -10];
      const to: Vec3 = [end.target[0] - 0, end.target[1] - 2, end.target[2] - 10];
      // 转角 = 25°（用水平投影夹角，垂直分量不变）
      const fromH = Math.hypot(from[0], from[2]);
      const toH = Math.hypot(to[0], to[2]);
      const cos = (from[0] * to[0] + from[2] * to[2]) / (fromH * toH);
      close(Math.acos(cos), (25 * Math.PI) / 180, 1e-6);
      close(to[1], from[1], 1e-6);
    }
  });

  it("左摇向左、右摇向右（叉积 y 分量异号）", () => {
    const left = motionEndPose("pan-left", camera)!;
    const right = motionEndPose("pan-right", camera)!;
    const from: Vec3 = [0, -1, -10];
    const crossY = (to: Vec3) => from[2] * (to[0] - 0) - from[0] * (to[2] - 10);
    assert.ok(crossY(left.target) > 0, "左摇朝左手侧");
    assert.ok(crossY(right.target) < 0, "右摇朝右手侧");
  });
});

describe("环绕", () => {
  it("绕注视点 180°：距离与高度不变，落在起点正对面", () => {
    const camera = fakeCamera([3, 2, 4], [0, 1, 0]);
    const end = motionEndPose("orbit", camera)!;
    close(dist(end.position, end.target), dist(camera.transform.position, camera.target));
    close(end.position[1], 2); // 高度不变
    // 180° 后 position - target = -(原 position - target)
    close(end.position[0] - 0, -(3 - 0));
    close(end.position[2] - 0, -(4 - 0));
    vecClose(end.target, camera.target);
  });
});

describe("跟随", () => {
  it("注视点 = 对象落地中心 +1m；机位水平横移、高度不变、位移 ⊥ 视线", () => {
    const object = fakeObject([1, 0, 2]);
    const aim = followAimFor(object);
    vecClose(aim, [1, 1, 2]);

    const camera = fakeCamera([1, 1.6, 8], [1, 1, 2]);
    const end = motionEndPose("follow", camera, aim)!;
    vecClose(end.target, aim);
    close(end.position[1], 1.6, 1e-6);
    const truck: Vec3 = [end.position[0] - 1, 0, end.position[2] - 8];
    const truckLen = Math.hypot(truck[0], truck[2]);
    close(truckLen, Math.max(0.8, dist([1, 1.6, 8], aim) * 0.3), 1e-6);
    // 横移方向与水平视线垂直
    const viewH: [number, number] = [aim[0] - 1, aim[2] - 8];
    close(truck[0] * viewH[0] + truck[2] * viewH[1], 0, 1e-6);
  });

  it("近距离时横移有 0.8m 下限；缺跟随目标返回 null", () => {
    const camera = fakeCamera([0, 1, 1], [0, 1, 0]);
    const end = motionEndPose("follow", camera, [0, 1, 0])!;
    const truckLen = Math.hypot(end.position[0] - 0, end.position[2] - 1);
    close(truckLen, 0.8, 1e-6);
    assert.equal(motionEndPose("follow", camera), null);
  });
});

describe("sampleMotion 采样", () => {
  it("t=0 严格等于当前机位，t=1 等于终点", () => {
    const camera = fakeCamera([3, 2, 4], [0, 1, 0]);
    for (const preset of MOTION_PRESETS) {
      const aim = preset.needsFollowTarget ? [0, 1, 0] as Vec3 : undefined;
      const start = sampleMotion(preset.id, camera, 0, aim)!;
      vecClose(start.position, camera.transform.position);
      vecClose(start.target, camera.target);
      const finish = sampleMotion(preset.id, camera, 1, aim)!;
      const end = motionEndPose(preset.id, camera, aim)!;
      vecClose(finish.position, end.position);
      vecClose(finish.target, end.target);
    }
  });

  it("中点位移恰好一半（smoothstep 中点=0.5）", () => {
    const camera = fakeCamera([0, 2, 10], [0, 1, 0]);
    const mid = sampleMotion("dolly-in", camera, 0.5)!;
    const end = motionEndPose("dolly-in", camera)!;
    close(mid.position[2], (10 + end.position[2]) / 2, 1e-6);
  });

  it("follow 缺 aim 采样返回 null", () => {
    assert.equal(sampleMotion("follow", fakeCamera([0, 1, 1], [0, 1, 0]), 0.5), null);
  });
});
