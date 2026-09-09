/* ============================================================
   s66-gen-node.test.ts — S66 libTV 三段式生成节点卡验收断言

   验收口径(S66 任务包 + Fable 裁决):
   1. 布局:编辑条在上、画布/播放器在中、生成卡在下(libTV 三段式,源码顺序即渲染顺序);
   2. 能力映射不做假按钮:planned 灰显项 tooltip 必带「规划中」,wired 项 tooltip 不带;
      功能位清单与 libTV 规格逐项对齐(防漂移);needs_media 项 tooltip 写明在场条件;
   3. 参数维度化 popover:维度行来自 listGenerationDimensions(值域全来自 active 档);
   4. ⚡实时估价走 simpleEstimate(不创建报价行),且 ⚡ 在发送键旁(源码顺序);
   5. 禁用一律 aria-disabled(灰显项仍可聚焦/悬浮出 tooltip),不用 disabled 属性。

   写法纪律同 dc-verdicts.test.ts:只读真实源码/数据真源,不读文档。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  IMAGE_CHIPS,
  IMAGE_EDIT_FEATURES,
  VIDEO_CHIPS,
  VIDEO_EDIT_FEATURES,
  VIDEO_MODES,
  plannedTooltip,
  type GenNodeFeatureSlot,
} from "./gen-node-capability";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const workbench = readSource("./pages/workbench-page.tsx");
const featuresComponent = readSource("./components/gen-node-features.tsx");
const popoverComponent = readSource("./components/gen-params-popover.tsx");

const ALL_SLOTS: readonly GenNodeFeatureSlot[] = [
  ...IMAGE_EDIT_FEATURES,
  ...VIDEO_EDIT_FEATURES,
  ...IMAGE_CHIPS,
  ...VIDEO_CHIPS,
  ...VIDEO_MODES,
];

test("S66 布局:libTV 三段式——编辑条在上、画布在中、生成卡在下(源码顺序)", () => {
  const editBar = workbench.indexOf("<GenNodeEditBar");
  const stage = workbench.indexOf("<MediaStage");
  const genCard = workbench.indexOf('aria-label={tab === "video" ? "生成输入" : undefined}');
  assert.ok(editBar !== -1, "节点编辑条未接进 workbench");
  assert.ok(stage !== -1, "画布 MediaStage 不在");
  assert.ok(genCard !== -1, "生成卡(生成输入组)不在");
  assert.ok(editBar < stage, "编辑条必须在画布上方(libTV 三段式)");
  assert.ok(stage < genCard, "生成卡必须在画布下方(libTV 三段式)");
});

test("S66 功能位清单与 libTV 规格逐项对齐(防漂移)", () => {
  assert.deepEqual(
    IMAGE_EDIT_FEATURES.map((slot) => slot.label),
    ["人像质感调节", "全景", "多角度", "打光", "九宫格", "高清", "宫格切分", "下载", "全屏"],
    "图片节点编辑条功能位与 libTV 规格不齐",
  );
  assert.deepEqual(
    VIDEO_EDIT_FEATURES.map((slot) => slot.label),
    ["剪辑", "裁剪", "高清", "解析", "智能去字幕", "音频分离", "画面编辑", "下载", "全屏"],
    "视频节点编辑条功能位与 libTV 规格不齐",
  );
  /* K-goal-04 条 1:add-ref 标签去文字「+」(图标已是 Plus,两个加号重复)——libTV 原规格的
     有意偏离,留图标承载动作义(仓内 Button/chip 惯例),标签与兄弟 chip 同为名词短语。 */
  assert.deepEqual(IMAGE_CHIPS.map((slot) => slot.label), ["参考", "标记", "风格"], "图片生成卡 chips 与规格不齐");
  assert.deepEqual(
    VIDEO_CHIPS.map((slot) => slot.label),
    ["参考", "标记", "特效", "角色库", "运镜"],
    "视频生成卡 chips 与规格不齐",
  );
  assert.deepEqual(
    VIDEO_MODES.map((slot) => slot.label),
    ["文生视频", "全能参考", "图生视频", "首尾帧", "图片参考"],
    "视频模式选择器与 libTV 规格不齐",
  );
});

test("S66 能力映射:planned 灰显项 tooltip 必带「规划中」,wired 项不带", () => {
  const debts: string[] = [];
  for (const slot of ALL_SLOTS) {
    if (slot.state === "planned" && !plannedTooltip(slot).includes("规划中")) {
      debts.push(`${slot.label}(${slot.id}) 是 planned 但 tooltip 不带「规划中」——灰显没交代`);
    }
    if (slot.state === "wired" && slot.tooltip.includes("规划中")) {
      debts.push(`${slot.label}(${slot.id}) 标 wired 却带「规划中」——真能力被写成假能力`);
    }
    if (slot.state === "needs_media" && !slot.tooltip) {
      debts.push(`${slot.label}(${slot.id}) 是 needs_media 但没写在场条件 tooltip`);
    }
  }
  assert.deepEqual(debts, [], `能力映射欠账(共 ${debts.length} 项):\n${debts.join("\n")}`);
});

test("S66 接线:编辑条/chips/模式选择器的数据源=gen-node-capability 映射数组", () => {
  assert.ok(
    workbench.includes('features={activeKind === "image" ? IMAGE_EDIT_FEATURES : VIDEO_EDIT_FEATURES}'),
    "编辑条未接 IMAGE/VIDEO_EDIT_FEATURES 映射",
  );
  assert.ok(
    workbench.includes('features={activeKind === "image" ? IMAGE_CHIPS : VIDEO_CHIPS}'),
    "chips 未接 IMAGE/VIDEO_CHIPS 映射",
  );
  assert.ok(workbench.includes("modes={VIDEO_MODES}"), "模式选择器未接 VIDEO_MODES 映射");
});

test("S66 禁用形态:灰显项用 aria-disabled(可聚焦/可悬浮 tooltip),不用 disabled 属性", () => {
  assert.ok(featuresComponent.includes("aria-disabled={!enabled}"), "功能位按钮未用 aria-disabled 闸门");
  assert.ok(!featuresComponent.includes(" disabled="), "灰显项用了 disabled 属性,tooltip 悬浮不到");
});

test("S66 参数维度化:popover 维度行来自 listGenerationDimensions,查无组合置灰", () => {
  /* S83c:两个 popover 连同维度推导从 workbench 内联抽进 TierDimensionPopovers
     (gen-params-popover.tsx),守卫跟接线走,口径不变。 */
  assert.ok(workbench.includes("TierDimensionPopovers"), "workbench 未接 TierDimensionPopovers 维度 popover 接线");
  assert.ok(popoverComponent.includes("listGenerationDimensions("), "popover 接线未从 listGenerationDimensions 推导维度行");
  assert.ok(workbench.includes("resolveDimensionPick("), "workbench 未接 resolveDimensionPick 维度反查切档");
  assert.ok(popoverComponent.includes("option.feasible"), "popover 未按 feasible 置灰查无档的组合");
  assert.ok(popoverComponent.includes("dimension.single"), "popover 未把单值维度渲染成固定标签(合同 §4)");
});

test("S66 底条:⚡实时估价走 simpleEstimate(不创建报价行),且 ⚡ 在发送键旁", () => {
  assert.ok(workbench.includes("api.simpleEstimate"), "页面实时估价未走 simpleEstimate");
  const barStart = workbench.indexOf("生成卡底条");
  assert.ok(barStart !== -1, "生成卡底条标记不在");
  const estimateAt = workbench.indexOf("estimate.text", barStart);
  /* K-goal-04 条 4:发送键=直接提交(startGeneration),不再进确认抽屉——改回弹窗此处必红 */
  const sendAt = workbench.indexOf("onClick={() => void startGeneration(activeKind)}", barStart);
  assert.ok(estimateAt !== -1, "底条没有 ⚡ 估价(estimate.text)");
  assert.ok(sendAt !== -1, "底条没有发送键(直接提交 startGeneration)");
  assert.ok(estimateAt < sendAt, "⚡ 必须在发送键旁(之前)");
  assert.ok(workbench.includes("Lightning"), "⚡ 图标未接");
  assert.ok(
    workbench.includes('estimate.state === "error"') && workbench.includes("setEstimateRevision"),
    "估价被拒缺「如实置灰 + 重试」接线",
  );
});

test("S66 模板切档(V-07 接线):选中模板消费 imageGenerationParameters 并按维度反查", () => {
  assert.ok(workbench.includes("imageGenerationParameters("), "workbench 未消费模板参数");
  assert.ok(!workbench.includes("只预填提示词"), "「只预填提示词」静默失效文案仍在");
});
