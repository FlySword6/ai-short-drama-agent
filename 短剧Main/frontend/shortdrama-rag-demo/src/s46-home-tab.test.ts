/* ============================================================
   s46-home-tab.test.ts — S46 C-6 工作台内层首页页签改名 源码级验收断言
   C-6：工作台页内层第一个页签又叫「工作台」——自嵌套命名。改「控制包」，
      与 S9-17 既有领域词「工作台参考控制包」对齐（首页=参考清单六组+
      就绪标记+素材级生成按钮，正是控制包）。只改页签标签：
      页面级身份（tablist aria-label、sr-only h1）与「去工作台查看」
      衔接流文案（s8-topbar-bridge 钉住）不动。
   纯 readSource 源码断言，不 import 页面组件（tsx 按仓根 tsconfig 编译，无 react-jsx）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const workbench = readSource("./pages/workbench-page.tsx");

test("C-6a：内层首页页签改名「控制包」", () => {
  assert.ok(workbench.includes('["home", "控制包"]'), "home 页签未改名「控制包」");
});

test("C-6b：自嵌套的旧「工作台」页签标签下线", () => {
  assert.ok(!workbench.includes('["home", "工作台"]'), "home 页签仍叫「工作台」");
});

test("C-6c：页面级身份不动——tablist aria-label 与 sr-only h1 仍是「工作台」", () => {
  assert.ok(workbench.includes('aria-label="工作台页签"'));
  assert.ok(workbench.includes('<h1 className="sr-only">工作台</h1>'));
});

test("C-6d：S8 衔接流「去工作台查看」toast 文案不动（s8-topbar-bridge 钉住）", () => {
  assert.ok(workbench.includes("去工作台查看"), "「去工作台查看」被误改");
});
