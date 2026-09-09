/* ============================================================
   global-jump-menu.test.ts — K-goal-02 包 N2「项目内全局入口」验收断言
   ① 菜单结构：全局三项固定顺序（项目管理 → 资产中心 → 数据看板），
      跳转路径与全局壳主导航（GlobalHeader）同口径
   ② 克制判据 K2：菜单总行数（三项 + 命令面板行）≤ 7
   ③ 渲染断言：入口 = 顶栏图标按钮（aria-label「全局跳转」+ Compass 图标，
      title 一眼可见三项去处），不藏进头像菜单
   ④ 接线（app.tsx）：项目壳右组挂 GlobalJumpMenu（快捷提示与开面板回调接线），
      且排在命令面板按钮之前；全局壳 GlobalHeader 源码段零出现（维持现状不动）
   ⑤ demo 可用：组件不依赖后端接口
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GLOBAL_JUMP_ITEMS, GlobalJumpMenu } from "./components/global-jump-menu";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const appSource = readSource("./app.tsx");
const menuSource = readSource("./components/global-jump-menu.tsx");

/* ---------- ① 菜单结构：三项固定顺序，路径与全局壳同口径 ---------- */

test("菜单三项固定顺序：项目管理 → 资产中心 → 数据看板", () => {
  assert.deepEqual(
    GLOBAL_JUMP_ITEMS.map((item) => item.label),
    ["项目管理", "资产中心", "数据看板"],
  );
  assert.equal(new Set(GLOBAL_JUMP_ITEMS.map((item) => item.key)).size, GLOBAL_JUMP_ITEMS.length);
});

test("跳转路径与全站导航同口径（/projects、/assets?scope=personal、/dashboard 由 rail 承载）", () => {
  // 2026-08-02 Fable 改锚:R2 壳后三去处的载体=app-rail 主导航;口径断言随载体迁移,菜单项表继续锁值。
  assert.deepEqual(
    GLOBAL_JUMP_ITEMS.map((item) => item.path),
    ["/projects", "/assets?scope=personal", "/dashboard"],
  );
  const railSource = readFileSync(new URL("./components/app-rail.tsx", import.meta.url), "utf8");
  for (const item of GLOBAL_JUMP_ITEMS) {
    assert.ok(
      railSource.includes(`"${item.path}"`),
      `rail 主导航缺 ${item.path}，菜单与全站壳口径漂移`,
    );
  }
});

/* ---------- ② 克制判据 K2：菜单总行数 ≤ 7 ---------- */

test("K2：菜单总行数（全局三项 + 命令面板行）≤ 7", () => {
  const PALETTE_ROW = 1;
  assert.ok(
    GLOBAL_JUMP_ITEMS.length + PALETTE_ROW <= 7,
    `菜单行数 ${GLOBAL_JUMP_ITEMS.length + PALETTE_ROW} 超出 K2 上限 7`,
  );
});

/* ---------- ③ 渲染断言：项目壳存在全局入口（不藏头像） ---------- */

test("渲染：入口是顶栏图标按钮，aria-label「全局跳转」，title 列全三项去处", () => {
  const html = renderToStaticMarkup(
    React.createElement(GlobalJumpMenu, { shortcut: "⌘K", onOpenPalette: () => undefined }),
  );
  assert.ok(html.includes("<button"), "入口应为按钮");
  assert.ok(html.includes('aria-label="全局跳转"'), "触发按钮缺可访问名「全局跳转」");
  assert.ok(
    html.includes("项目管理") && html.includes("资产中心") && html.includes("数据看板"),
    "title 应一眼列全三项去处",
  );
  assert.ok(html.includes("<svg"), "缺 Compass 图标");
});

test("菜单内容：三项经 DropdownMenuItem 渲染，命令面板行带平台快捷键 kbd 提示", () => {
  assert.ok(menuSource.includes("./ui/dropdown-menu"), "未走 ui/dropdown-menu wrapper");
  assert.ok(menuSource.includes("GLOBAL_JUMP_ITEMS.map"), "三项应来自唯一真源映射");
  assert.ok(menuSource.includes("DropdownMenuItem"), "缺菜单项");
  assert.ok(menuSource.includes("onOpenPalette"), "命令面板行未接开面板回调");
  assert.ok(menuSource.includes("<kbd") && menuSource.includes("{shortcut}"), "缺 ⌘K/Ctrl+K kbd 提示");
});

/* ---------- ④ 接线（app.tsx）：项目壳挂、全局壳不动 ---------- */

test("接线：GlobalJumpMenu 组件退役，跳转入口收编 rail 的命令面板钮", () => {
  // 2026-08-02 Fable 改锚:R2 壳后顶栏右组退役,三项去处=rail 主导航,面板入口=rail ⌘K 钮;
  // 本断言守「不残留旧挂载 + 新入口在场」,防旧组件回潮。
  assert.ok(!appSource.includes("<GlobalJumpMenu"), "app.tsx 不应再挂 GlobalJumpMenu(已随顶栏退役)");
  const railSource = readFileSync(new URL("./components/app-rail.tsx", import.meta.url), "utf8");
  assert.ok(
    railSource.includes("PaletteTrigger") || railSource.includes("命令面板"),
    "rail 缺命令面板入口(跳转项的新载体)",
  );
});

test("接线：全局壳维持现状——GlobalHeader 源码段不出现 GlobalJumpMenu", () => {
  const globalHeader = appSource.slice(appSource.indexOf("function GlobalHeader"), appSource.indexOf("function navButtonClass"));
  assert.ok(!globalHeader.includes("GlobalJumpMenu"), "全局壳 GlobalHeader 不应挂 GlobalJumpMenu");
});

/* ---------- ⑤ demo 可用：无后端依赖 ---------- */

test("组件不调用后端接口：demo 模式下同样可用", () => {
  assert.ok(!menuSource.includes('from "../api"'), "global-jump-menu.tsx 不应引入 api");
});
