/* ============================================================
   s46b-palette-trigger.test.ts — S46 B-6 命令面板入口(搜索框形态)组件渲染断言
   R44③:搜索栏内联快捷键提示,分平台(Mac ⌘K / Win Ctrl+K)。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaletteTrigger } from "./components/palette-trigger";
import { shortcutLabel } from "./shortcut-hint";

function render(shortcut: string): string {
  return renderToStaticMarkup(React.createElement(PaletteTrigger, { shortcut, onClick: () => undefined }));
}

test("B-6 渲染:Mac 平台内联显示 ⌘K,title/aria 同口径", () => {
  const kbd = shortcutLabel("MacIntel", "K");
  const html = render(kbd);
  assert.ok(html.includes("<kbd"), "缺 kbd 内联提示");
  assert.ok(html.includes("⌘K"), "Mac 未显示 ⌘K");
  assert.ok(html.includes("搜索、跳转与命令"), "缺搜索框提示文字");
  assert.ok(html.includes('title="命令面板（⌘K）"'), "title 未带平台快捷键");
  assert.ok(html.includes('aria-label="命令面板（⌘K）"'), "aria-label 未带平台快捷键");
});

test("B-6 渲染:Windows 平台内联显示 Ctrl+K,不出现 ⌘", () => {
  const html = render(shortcutLabel("Win32", "K"));
  assert.ok(html.includes("Ctrl+K"), "Win 未显示 Ctrl+K");
  assert.ok(!html.includes("⌘"), "Win 平台误显示 ⌘");
});

test("B-6 渲染:是按钮不是输入框——点开命令面板,不抢焦点输入", () => {
  const html = render("⌘K");
  assert.ok(html.includes("<button"), "入口应为按钮");
  assert.ok(!html.includes("<input"), "入口不应是 input");
});
