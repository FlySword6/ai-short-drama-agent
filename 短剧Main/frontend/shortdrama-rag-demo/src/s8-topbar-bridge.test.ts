/* ============================================================
   s8-topbar-bridge.test.ts — S8 导演台衔接流 + 顶栏改版源码级合同断言
   （P0 导出=保存并归组 / P1-7 环境分组菜单 / P1-8 模版分组 / P1-9 帮助浮层，
   模式照 workbench-w9.test.ts 的源码锚点断言）
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const topBar = readSource("./components/director/ui/TopBar.tsx");
const workbench = readSource("./pages/workbench-page.tsx");
const saveCapture = readSource("./components/director/export/saveCapture.ts");

/* ---------- P0：四类导出主按钮=保存并归组（衔接流） ---------- */

test("P0 源码级：导出菜单主按钮走「保存并归组」一步管线", () => {
  assert.ok(topBar.includes("runSaveAndGroup"), "缺保存并归组主处理器");
  assert.ok(topBar.includes("renderStaticExport"), "未消费渲染管线");
  assert.ok(topBar.includes("saveBlobToLibrary"), "未消费入资产库管线");
  assert.ok(topBar.includes("静态 · 保存并归组"), "导出菜单缺主分组标签");
  // 归组走 onExported 宿主路径（shot/grid→场景组，depth→运镜组）
  assert.ok(topBar.includes("存资产库并归「场景」组") && topBar.includes("存资产库并归「运镜」组"), "缺归组去向说明");
});

test("P0 源码级：「下载到本地」降为次要，「保存到资产库」独立菜单项已删除", () => {
  assert.ok(topBar.includes("下载到本地"), "缺下载次要分组");
  assert.ok(topBar.includes("ds-tb-menu__item--minor"), "下载项未弱化（minor 样式）");
  assert.ok(!topBar.includes("保存到资产库"), "独立「保存到资产库」菜单项/文案仍在");
  assert.ok(!topBar.includes("runSaveCapture"), "旧 runSaveCapture 处理器仍在");
});

test("P0 源码级：无宿主归组回调=仅存资产库并提示引入路径；demo 模式降级不写", () => {
  assert.ok(topBar.includes("已入资产库，可在项目里引入"), "缺独立路由成功 toast");
  assert.ok(topBar.includes("isDirectorDemoMode"), "demo 判定缺失");
  assert.ok(topBar.includes("离线演示不写入资产库"), "demo 降级 toast 缺失");
});

test("P0 源码级：运镜小样=录制并归组（视频暂不入资产库，不造假）", () => {
  assert.ok(topBar.includes("录制并归组"), "运镜主按钮未改「录制并归组」");
  assert.ok(topBar.includes("视频暂不入资产库"), "缺视频不入库的明示文案");
});

test("P0 源码级：保存管线 saveCapture.ts = 渲染 + POST captures 通用入口", () => {
  assert.ok(saveCapture.includes("renderStaticExport"), "缺静态导出渲染入口");
  assert.ok(saveCapture.includes("saveBlobToLibrary"), "缺通用 Blob 入库入口");
  assert.ok(saveCapture.includes("postDirectorCapture"), "未走 captures 端点");
});

test("P0 源码级：工作台归组 toast 带「去工作台查看」+ 目标组 ~2s 高亮", () => {
  assert.ok(workbench.includes("去工作台查看"), "toast 缺「去工作台查看」动作钮");
  assert.ok(workbench.includes("goToLaneOnHome"), "缺跳转+高亮处理器");
  assert.ok(workbench.includes("laneFlash"), "缺高亮状态");
  assert.ok(workbench.includes("LANE_FLASH_CLASS"), "缺高亮样式映射");
  // S24-D：高亮选择器与组件结构解耦——section 带 data-lane，样式按属性命中，不再绑 aria-label 文案
  assert.ok(workbench.includes("[&_section[data-lane="), "高亮选择器未走 data-lane 属性");
  assert.ok(readSource("./components/reference-lanes.tsx").includes("data-lane={lane.id}"), "参考清单 section 缺 data-lane 锚点");
  assert.ok(workbench.includes("2000"), "高亮时长 ~2s 缺失");
  // 已入库资产以其 assetId 为归组条目主键（幂等）
  assert.ok(workbench.includes("workshop:director-"), "缺导演台归组条目前缀");
});

/* ---------- P1-7：环境分组菜单 ---------- */

test("P1-7 源码级：环境下拉改分组菜单，数据同源 env-presets（只读 import）", () => {
  assert.ok(topBar.includes('from "../env-presets"'), "未 import env-presets");
  assert.ok(topBar.includes("ENV_PRESET_MENU"), "未消费分组菜单数据");
  assert.ok(topBar.includes("ENV_PRESET_LABELS"), "当前档名未走同源 labels");
  assert.ok(topBar.includes("ds-tb-env__cell--on"), "当前环境高亮缺失");
  assert.ok(!topBar.includes("ENVIRONMENTS"), "本地两档 ENVIRONMENTS 常量仍在");
});

/* ---------- P1-8：模版分组菜单 ---------- */

test("P1-8 源码级：模版菜单按 category 中文分组（纯逻辑在 topbar-helpers）", () => {
  assert.ok(topBar.includes("groupTemplatesByCategory"), "未消费分组函数");
  assert.ok(topBar.includes("templateGroups"), "分组结果未渲染");
  assert.ok(topBar.includes('from "./topbar-helpers"'), "分组逻辑未独立成模块");
});

/* ---------- P1-9：帮助浮层 + gizmo 字母标 ---------- */

test("P1-9 源码级：「?」帮助浮层列契约快捷键；gizmo 平移字母标 G", () => {
  assert.ok(topBar.includes("DIRECTOR_SHORTCUTS"), "未消费快捷键契约清单");
  assert.ok(topBar.includes('aria-label="快捷键帮助"'), "「?」钮缺可访问名");
  assert.ok(topBar.includes("ds-tb-help__kbd"), "帮助浮层缺键位样式");
  assert.ok(topBar.includes('{ mode: "translate", label: "平移", hotkey: "G" }'), "平移字母标未改 G");
  assert.ok(!topBar.includes('hotkey: "V"'), "旧 V 字母标仍在");
});

/* ---------- S9-0：顶栏集时间线（数字块→素材段块）+ 连播/交付拆分 ---------- */

const appShell = readSource("./app.tsx");

/* 块 2(2026-08-03):镜级工作台退役,顶栏三装备(集时间线 pager/整集连播/交付快捷键)随之退场。
   职能承接:时间线→块 1 集视图时间线带+场级工作台镜列表;整集连播→生产页「预览全集」
   (block2-route-retire 正向断言);交付下载→连播弹窗页脚与交付弹窗(demo-act4 K2U 合同)。
   此处仅留负向守卫防回潮。 */
test("块 2 源码级：镜级页头装备已退场,app.tsx 无残留", () => {
  assert.ok(!appShell.includes('aria-label="集时间线"'), "镜级顶栏集时间线残留");
  assert.ok(!appShell.includes("WorkbenchShotPager"), "镜级 pager 组件残留");
  assert.ok(!appShell.includes("本集连播与交付"), "旧「本集连播与交付」连体按钮回潮");
});
