/*
 * S8 bug5 回归:全景球 水平旋转/球形半径 滑杆「无视觉变化」(DC 真栈实测)
 *
 * 复现结论(5174 dev + Playwright 像素指纹):
 * - 无全景图:滑杆假活(disabled=false),值进 store 但场景无全景球 → 画面指纹零变化;
 * - 有全景图(equirect 注入):旋转 0→240° 指纹变化、半径 30→10→100 指纹变化,链路完好。
 * 修复:无全景图时滑杆禁用并给「上传全景图后可实时调整」提示,不做假活控件。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("S8 bug5:全景球滑杆在无全景图时禁用,不做假活控件", () => {
  const source = readSource("./ui/ScenePanel.tsx");
  // 两个滑杆都必须随 panoramaUrl 缺省禁用
  const disabledCount = source.split("disabled={!panoramaUrl}").length - 1;
  assert.equal(disabledCount, 2, "水平旋转/球形半径两个滑杆都应在无全景图时禁用");
  assert.ok(source.includes("上传全景图后可实时调整"), "缺无全景图时的提示行");
});

test("S8 bug5:禁用态有视觉表达(降不透明+禁手势)", () => {
  const css = readSource("./ui/ScenePanel.css");
  assert.ok(css.includes('input[type="range"]:disabled'), "滑杆 disabled 态缺 CSS 表达");
});

test("S8 bug5:全景球消费链不被改坏——旋转/半径仍直连 store 与渲染 props", () => {
  const panel = readSource("./ui/ScenePanel.tsx");
  assert.ok(panel.includes("setSceneSettings({ panoramaRotation:"), "旋转滑杆必须写 scene.panoramaRotation");
  assert.ok(panel.includes("setSceneSettings({ panoramaRadius:"), "半径滑杆必须写 scene.panoramaRadius");
  const stage = readSource("./StageCanvas.tsx");
  assert.ok(stage.includes("degToRad(panoramaRotation)"), "全景球 mesh 必须消费 panoramaRotation");
  assert.ok(stage.includes("args={[panoramaRadius, 48, 32]}"), "全景球几何必须消费 panoramaRadius");
});
