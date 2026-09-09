/* ============================================================
   settings-page.test.ts — 设置页验收断言
   ① API 设置槽位常量与诚实态文案（G1 去开发化）
   ② 页签描述按当前页签（S9-10）
   ③ #151：三个「本机保存、不进生成」的假面板（全局风格/全局提示词/提示词管理）
      已退役且不得回归——项目级替代在项目设置抽屉（docs/design/prd-v2/project.md §四）
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MODEL_SLOTS,
  MODEL_SLOTS_SECRET_NOTE,
  SETTINGS_SECTION_DESCRIPTION,
  settingsSectionFromSearch,
  slotModelName,
  type SettingsSectionKey,
} from "./pages/settings-page";

const pageSource = readFileSync(new URL("./pages/settings-page.tsx", import.meta.url), "utf8");

/* ---------- ① API 设置槽位（G1 去开发化）与密钥文案 ---------- */

test("模型槽位四项：图片生成/视频生成/对话助手/语义检索，不出现环境变量名", () => {
  assert.deepEqual(
    MODEL_SLOTS.map((slot) => [slot.key, slot.label]),
    [
      ["image", "图片生成"],
      ["video", "视频生成"],
      ["llm", "对话助手"],
      ["vector", "语义检索"],
    ],
  );
  assert.ok(MODEL_SLOTS_SECRET_NOTE.includes("密钥由服务端管理"), "缺「密钥由服务端管理」口径");
  for (const slot of MODEL_SLOTS) {
    assert.ok(!("envKey" in slot), `${slot.label} 仍带环境变量名`);
  }
});

test("slotModelName：只认 configured 真数据，查不到/非媒体槽位回落 null", () => {
  const models = [
    { id: "m1", displayName: "Seedream 4.5", mediaKind: "image" as const, configurationStatus: "configured" as const },
    { id: "m2", displayName: "GPT Image 2", mediaKind: "image" as const, configurationStatus: "unconfigured" as const },
    { id: "m3", displayName: "Seedance 2.0", mediaKind: "video" as const, configurationStatus: "configured" as const },
  ];
  const image = MODEL_SLOTS.find((slot) => slot.key === "image")!;
  const video = MODEL_SLOTS.find((slot) => slot.key === "video")!;
  const llm = MODEL_SLOTS.find((slot) => slot.key === "llm")!;
  assert.equal(slotModelName(image, models), "Seedream 4.5");
  assert.equal(slotModelName(video, models), "Seedance 2.0");
  assert.equal(slotModelName(llm, models), null, "非媒体槽位不取注册表");
  assert.equal(slotModelName(image, null), null, "接口不可用不虚构");
  assert.equal(slotModelName(image, [{ ...models[1]! }]), null, "只有未配置模型时回落 null");
});

test("密钥说明文案：无禁词空炮话术（S10 起 AI 日志已点亮，旧空态断言移至 s10-audit-logs.test.ts）", () => {
  const banned = /敬请期待|即将上线|coming\s*soon/i;
  assert.ok(!banned.test(MODEL_SLOTS_SECRET_NOTE), `出现禁词：${MODEL_SLOTS_SECRET_NOTE}`);
});

/* ---------- ② 页签描述（S9-10；#151 起四个页签） ---------- */

test("页签描述：四个页签各有对应描述，旧开发视角话术清场", () => {
  const keys: SettingsSectionKey[] = ["api", "defaults", "logs", "releases"];
  for (const key of keys) assert.ok(SETTINGS_SECTION_DESCRIPTION[key].trim(), `缺 ${key} 页签描述`);
  assert.ok(SETTINGS_SECTION_DESCRIPTION.api.includes("只存在这台设备的浏览器里"), "API 设置缺本机说明");
  for (const key of keys) assert.ok(!SETTINGS_SECTION_DESCRIPTION[key].includes("自动迁移"), `${key} 仍是开发视角话术`);
});

test("深链解析：未知/已退役的 section 一律回「默认生成参数」", () => {
  assert.equal(settingsSectionFromSearch(""), "defaults");
  assert.equal(settingsSectionFromSearch("?section=releases"), "releases");
  assert.equal(settingsSectionFromSearch("?section=prompts"), "defaults", "已退役页签不得落进去");
  assert.equal(settingsSectionFromSearch("?section=style"), "defaults");
  assert.equal(settingsSectionFromSearch("?section=global-prompt"), "defaults");
});

/* ---------- ③ #151：假保存面板退役且不得回归 ---------- */

test("「全局风格」「全局提示词」「提示词管理」三个本机保存面板已删，源码零残留", () => {
  for (const banned of ["GLOBAL_STYLE_KEY", "GLOBAL_PROMPT_KEY", "PROMPT_TEMPLATES_KEY", "GlobalStylePanel", "GlobalPromptPanel", "PromptTemplatesPanel", "PROMPT_TEMPLATE_PRESETS"]) {
    assert.ok(!pageSource.includes(banned), `已退役面板残留「${banned}」`);
  }
  for (const banned of ["当前仅保存", "注入逻辑待生成链接线"]) {
    assert.ok(!pageSource.includes(banned), `虚假期望文案残留「${banned}」`);
  }
});
