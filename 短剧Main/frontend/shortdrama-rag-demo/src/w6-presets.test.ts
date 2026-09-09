/* ============================================================
   w6-presets.test.ts — W6-1 生图预设模板库验收断言
   纯逻辑：14 预设齐全性与两组分组、{content} 替换（script_text > title >
   引导语）、参数合并（模板 ratio/size 覆盖、watermark/sequential 保留）、
   选中-取消切换。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import {
  IMAGE_FALLBACK_RATIO,
  IMAGE_FALLBACK_SIZE,
  IMAGE_PRESETS,
  IMAGE_PRESET_GROUPS,
  PRESET_CONTENT_HINT,
  PRESET_CONTENT_TOKEN,
  applyPresetPrompt,
  findImagePreset,
  imageGenerationParameters,
  presetBadgeLabel,
  presetRatioNote,
  presetsInGroup,
  resolvePresetContent,
  togglePresetSelection,
} from "./image-presets";

/* ---------- 14 预设齐全性与两组分组 ---------- */

test("预设齐全：共 14 个，id 全局唯一", () => {
  assert.equal(IMAGE_PRESETS.length, 14);
  assert.equal(new Set(IMAGE_PRESETS.map((preset) => preset.id)).size, 14);
  for (const preset of IMAGE_PRESETS) {
    assert.ok(preset.name.trim(), `${preset.id} 缺名称`);
    assert.ok(preset.prompt.includes(PRESET_CONTENT_TOKEN), `${preset.id} 缺 {content} 占位符`);
    assert.ok(preset.parameters.ratio.trim(), `${preset.id} 缺 ratio`);
    assert.ok(preset.parameters.size.trim(), `${preset.id} 缺 size`);
  }
});

test("两组分组：分镜叙事 9 个 + 设定图 5 个，组序固定", () => {
  assert.deepEqual(
    IMAGE_PRESET_GROUPS.map((group) => group.key),
    ["storyboard", "design"],
  );
  assert.deepEqual(
    IMAGE_PRESET_GROUPS.map((group) => group.label),
    ["分镜叙事", "设定图"],
  );
  assert.equal(presetsInGroup("storyboard").length, 9);
  assert.equal(presetsInGroup("design").length, 5);
  // 分组并集 = 全部预设，不丢不重
  assert.equal(presetsInGroup("storyboard").length + presetsInGroup("design").length, IMAGE_PRESETS.length);
});

test("关键模板文案与默认参数按定稿落位", () => {
  const grid9 = findImagePreset("grid-9");
  assert.equal(grid9?.name, "九宫格分镜");
  assert.deepEqual(grid9?.parameters, { ratio: "1:1", size: "2K" });
  const pano = findImagePreset("pano-720");
  assert.equal(pano?.name, "720全景");
  assert.deepEqual(pano?.parameters, { ratio: "21:9", size: "2K" });
  assert.equal(findImagePreset("storyboard-blocking")?.group, "storyboard");
  assert.equal(findImagePreset("character-sheet")?.group, "design");
  assert.equal(findImagePreset("不存在"), null);
  assert.equal(findImagePreset(null), null);
});

/* ---------- {content} 替换 ---------- */

test("内容替换：有 script_text 用 script_text", () => {
  assert.equal(
    resolvePresetContent({ script_text: "  任天野夜闯总督府  ", title: "夜闯" }),
    "任天野夜闯总督府",
  );
});

test("内容替换：无 script_text 用 title", () => {
  assert.equal(resolvePresetContent({ script_text: "", title: "夜闯总督府" }), "夜闯总督府");
  assert.equal(resolvePresetContent({ script_text: null, title: " 夜闯 " }), "夜闯");
});

test("内容替换：两者皆空回落引导语（可手填）", () => {
  assert.equal(resolvePresetContent({ script_text: "", title: "" }), PRESET_CONTENT_HINT);
  assert.equal(resolvePresetContent(null), PRESET_CONTENT_HINT);
  assert.equal(resolvePresetContent(undefined), PRESET_CONTENT_HINT);
});

test("模板预填：{content} 全部替换，文案其余部分逐字保留", () => {
  const preset = findImagePreset("storyboard")!;
  const filled = applyPresetPrompt(preset, { script_text: "雨夜追杀", title: null });
  assert.ok(!filled.includes(PRESET_CONTENT_TOKEN));
  assert.ok(filled.startsWith("电影级故事板：雨夜追杀。"));
  assert.ok(filled.endsWith("阅读顺序从左到右、从上到下。"));
  // 空分镜 → 引导语进文案，不留空占位
  const hint = applyPresetPrompt(preset, null);
  assert.ok(hint.includes(PRESET_CONTENT_HINT));
  // 多个占位符（若模板含多个）也全部替换
  const double = applyPresetPrompt({ ...preset, prompt: "A{content}B{content}C" }, { script_text: "X" });
  assert.equal(double, "AXBXC");
});

/* ---------- 参数合并 ---------- */

test("参数合并：模板 ratio/size 覆盖，watermark/sequential 恒定保留", () => {
  assert.deepEqual(imageGenerationParameters(findImagePreset("grid-25")), {
    ratio: "1:1",
    size: "2K",
    watermark: false,
    sequential_image_generation: "disabled",
  });
  assert.deepEqual(imageGenerationParameters(findImagePreset("pano-720")), {
    ratio: "21:9",
    size: "2K",
    watermark: false,
    sequential_image_generation: "disabled",
  });
});

test("参数合并：未选模板回落 V0.1.1 固定参数", () => {
  assert.deepEqual(imageGenerationParameters(null), {
    ratio: IMAGE_FALLBACK_RATIO,
    size: IMAGE_FALLBACK_SIZE,
    watermark: false,
    sequential_image_generation: "disabled",
  });
  assert.deepEqual(imageGenerationParameters(undefined).ratio, "16:9");
});

/* ---------- 选中-取消切换 ---------- */

test("选中-取消：点同一枚取消（回 null），点另一枚改选", () => {
  assert.equal(togglePresetSelection(null, "grid-9"), "grid-9");
  assert.equal(togglePresetSelection("grid-9", "grid-9"), null);
  assert.equal(togglePresetSelection("grid-9", "pano-720"), "pano-720");
  // 取消后可再选
  assert.equal(togglePresetSelection(togglePresetSelection("grid-9", "grid-9"), "grid-9"), "grid-9");
});

/* ---------- S59：模板画幅与档画幅不一致明示（G06/G07 回归吸收） ---------- */

test("画幅明示：模板 ratio ≠ 档 ratio 给变形警示；一致/缺档/未选模板不警示", () => {
  const grid9 = findImagePreset("grid-9")!;
  const note = presetRatioNote(grid9, "16:9");
  assert.ok(note?.includes("出图会变形"), "画幅不一致缺变形警示");
  assert.ok(note?.includes("1:1") && note.includes("16:9"), "警示未同时给出模板画幅与档画幅");
  assert.ok(note?.includes("九宫格分镜"), "警示未点名模板");
  // 画幅一致 / 档未加载（null）/ 未选模板 → 不警示
  assert.equal(presetRatioNote(grid9, "1:1"), null);
  assert.equal(presetRatioNote(grid9, null), null);
  assert.equal(presetRatioNote(grid9, undefined), null);
  assert.equal(presetRatioNote(null, "16:9"), null);
  // 16:9 模板在 16:9 档下不警示（设定图族全员）
  assert.equal(presetRatioNote(findImagePreset("storyboard"), "16:9"), null);
  assert.equal(presetRatioNote(findImagePreset("character-sheet"), "16:9"), null);
});

test("画幅明示覆盖：5 张非 16:9 模板在当前 16:9 档下全部出警示（不得静默）", () => {
  const mismatched = IMAGE_PRESETS.filter((preset) => presetRatioNote(preset, "16:9") !== null).map((preset) => preset.id);
  assert.deepEqual(mismatched.sort(), ["grid-25", "grid-4-plot", "grid-9", "multi-camera-9", "pano-720"].sort());
});

/* ---------- S73 + V-07:模板卡副标随行为说全(预填之外,切档/无档不许说漏) ---------- */

test("S73 模板卡副标:值域内「预填+按画幅切档」,无档如实「无 N:N 档」,值域未就绪保持中性", () => {
  const grid9 = findImagePreset("grid-9")!; // 1:1
  const pano = findImagePreset("pano-720")!; // 21:9
  const storyboard = findImagePreset("storyboard")!; // 16:9
  const ratios = new Set(["16:9", "1:1"]);
  assert.equal(presetBadgeLabel(grid9, ratios), "预填提示词 · 按 1:1 切档", "值域内模板必须把「切档」说上(V-07 修复后 badge 说少了)");
  assert.equal(presetBadgeLabel(pano, ratios), "预填提示词 · 无 21:9 档", "无档模板不许谎称切档");
  assert.equal(presetBadgeLabel(storyboard, ratios), "预填提示词 · 按 16:9 切档");
  assert.equal(presetBadgeLabel(grid9, null), "预填提示词", "值域未就绪(档位读取中/失败)保持中性,不断言「无档」");
  assert.equal(presetBadgeLabel(grid9, new Set()), "预填提示词 · 无 1:1 档", "空值域=知道没有,如实说无档");
});
