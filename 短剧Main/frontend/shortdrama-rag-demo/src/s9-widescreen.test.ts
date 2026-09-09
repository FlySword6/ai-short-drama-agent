/* ============================================================
   s9-widescreen.test.ts — S9-12 宽屏分层宽度策略断言
   生产型页面（生产/工作台/资产中心/数据看板/项目列表/素材智能体）放开限宽
   max-w-[1920px]；阅读型页面（设置/版本预告/参考测试/404）维持 max-w-[1200px]；
   页面级横向溢出在根容器 overflow-x:clip（肇事源=AI 工作区面板收起态）；
   卡片网格 auto-fill minmax 自适应列数（壳放宽后列数自然 3→4-5）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const app = readSource("./app.tsx");
const globalPages = readSource("./pages/global-pages.tsx");
const projectPages = readSource("./pages/project-pages.tsx");
const operationsPages = readSource("./pages/operations-pages.tsx");
const materialAgent = readSource("./pages/material-agent-page.tsx");
const settings = readSource("./pages/settings-page.tsx");
const referenceTests = readSource("./pages/reference-tests-page.tsx");

test("S9-12a：生产型页面壳放开限宽 max-w-[1920px]", () => {
  // 项目列表 + 资产中心（global-pages 两处 section 壳）
  assert.equal(globalPages.match(/max-w-\[1920px\]/g)?.length, 2, "global-pages 项目列表/资产中心壳未放开");
  // 生产页 + 项目资产页（project-pages 三处）
  assert.equal(projectPages.match(/max-w-\[1920px\]/g)?.length, 3, "project-pages 生产页/项目资产壳未放开");
  // 数据看板/回收站共用 PAGE_SHELL
  assert.ok(operationsPages.includes('PAGE_SHELL = "mx-auto flex w-full max-w-[1920px]'), "operations PAGE_SHELL 未放开");
  // 素材智能体
  assert.ok(materialAgent.includes("max-w-[1920px]"), "素材智能体壳未放开");
  // 生产型页面不再残留 1200 壳
  assert.ok(!globalPages.includes("max-w-[1200px]"), "global-pages 残留 1200 壳");
  assert.ok(!projectPages.includes("max-w-[1200px]"), "project-pages 残留 1200 壳");
});

test("S9-12b：阅读型页面维持 max-w-[1200px]", () => {
  assert.ok(settings.includes("max-w-[1200px]"), "设置/版本预告页应维持 1200（行长可读性）");
  assert.ok(referenceTests.includes("max-w-[1200px]"), "参考测试页应维持 1200");
  assert.ok(app.includes("max-w-[1200px]"), "404 页应维持 1200");
});

test("S9-12c：页面级横向溢出根裁剪", () => {
  assert.ok(app.includes("min-h-dvh flex-col [overflow-x:clip]"), "根容器缺 overflow-x:clip（AI 面板收起态会顶出横向滚动条）");
});

test("S9-12d：卡片网格 auto-fill minmax 列数自适应", () => {
  // 壳放宽后列数由 minmax 自然增长（窄 3 → 宽 4-5），不写死列数
  assert.ok(projectPages.includes("grid-cols-[repeat(auto-fill,minmax(230px,1fr))]"), "素材网格未用 auto-fill");
  assert.ok(globalPages.includes("grid-cols-[repeat(auto-fill,minmax(240px,1fr))]"), "资产网格未用 auto-fill");
  assert.ok(globalPages.includes("grid-cols-[repeat(auto-fill,minmax(320px,1fr))]"), "项目卡网格未用 auto-fill");
  assert.ok(!projectPages.includes("grid-cols-3"), "素材网格写死列数");
});
