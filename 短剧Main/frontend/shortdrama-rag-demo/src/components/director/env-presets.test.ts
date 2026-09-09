/*
 * S8-7 光影预置扩充验收:十档预置 + 三组菜单数据合同。
 * 渲染消费在 StageCanvas(EnvironmentStage),菜单 UI 在 TopBar——两处同源 import 本文件。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ENV_PRESETS, ENV_PRESET_LABELS, ENV_PRESET_MENU } from "./env-presets";

const EXPECTED_KEYS = [
  "studio",
  "indoor_warm",
  "night_cold",
  "candlelight",
  "day_clear",
  "dusk",
  "overcast_soft",
  "moonlight",
  "backlit_silhouette",
  "neon_night",
] as const;

test("S8-7:预置十档齐全,每档=环境光+主光+色调组合", () => {
  assert.deepEqual(Object.keys(ENV_PRESETS).sort(), [...EXPECTED_KEYS].sort());
  for (const key of EXPECTED_KEYS) {
    const preset = ENV_PRESETS[key];
    assert.ok(preset.hemi.intensity > 0, `${key} 缺环境光`);
    assert.ok(preset.key.intensity > 0 && preset.key.color, `${key} 缺主光`);
    assert.ok(preset.exposure > 0 && preset.floor, `${key} 缺色调(曝光/地面色)`);
    assert.ok(ENV_PRESET_LABELS[key], `${key} 缺中文名`);
  }
});

test("S8-7:菜单分室内/室外/风格化三组,覆盖全部预置,常用置顶", () => {
  assert.deepEqual(ENV_PRESET_MENU.map((group) => group.label), ["室内", "室外", "风格化"]);
  const menuValues = ENV_PRESET_MENU.flatMap((group) => group.items.map((item) => item.value));
  assert.deepEqual([...menuValues].sort(), [...EXPECTED_KEYS].sort(), "菜单必须覆盖全部预置且无重");
  // 常用置顶:默认预置棚拍亮调排菜单第一
  assert.equal(ENV_PRESET_MENU[0]!.items[0]!.value, "studio");
  // 菜单文案与预置中文名同源
  for (const group of ENV_PRESET_MENU) {
    for (const item of group.items) {
      assert.equal(item.label, ENV_PRESET_LABELS[item.value]);
    }
  }
});
