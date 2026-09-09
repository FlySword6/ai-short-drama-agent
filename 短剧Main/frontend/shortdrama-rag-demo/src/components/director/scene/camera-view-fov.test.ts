/**
 * cameraViewFov 单测（B5 机位视角变形修复）：
 * - 画布比画幅宽（宽画布装竖画幅）：FOV 不变，画幅区贴满上下边；
 * - 画布比画幅窄（竖画布装横画幅）：FOV 放大，水平视角与真实机位一致；
 * - auto 档（frameAspect = canvasAspect）：恒等。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { cameraViewFov } from "./camera-view-fov";

/** 水平 FOV（角度制）：由垂直 FOV 与宽高比推导 */
function hfovDeg(vfovDeg: number, aspect: number): number {
  return 2 * Math.atan(Math.tan((vfovDeg * Math.PI) / 360) * aspect) * (180 / Math.PI);
}

test("宽画布装竖画幅（9:16 on 16:9 画布）：垂直 FOV 不变", () => {
  // 画布 1.78 > 画幅 0.5625：画幅区贴满上下边，垂直视角即真实机位垂直视角
  assert.equal(cameraViewFov(40, 9 / 16, 16 / 9), 40);
});

test("竖画布装横画幅（16:9 on 9:16 画布）：FOV 放大且水平视角与真实机位一致", () => {
  const frameAspect = 16 / 9;
  const canvasAspect = 9 / 16;
  const realVfov = 40;
  const camFov = cameraViewFov(realVfov, frameAspect, canvasAspect);
  assert.ok(camFov > realVfov, `应放大（${camFov} > ${realVfov}）`);
  // 核心不变量：画布水平视角 = 真实机位水平视角（画幅区贴满左右边）
  assert.ok(Math.abs(hfovDeg(camFov, canvasAspect) - hfovDeg(realVfov, frameAspect)) < 1e-9);
});

test("auto 档（画幅=画布）：恒等", () => {
  assert.equal(cameraViewFov(40, 1.5, 1.5), 40);
});

test("极端竖画布不发散（canvasAspect 小量）", () => {
  const fov = cameraViewFov(40, 16 / 9, 0.2);
  assert.ok(Number.isFinite(fov) && fov > 0 && fov < 180);
});
