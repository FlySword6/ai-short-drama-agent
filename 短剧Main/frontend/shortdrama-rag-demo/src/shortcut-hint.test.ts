/* ============================================================
   shortcut-hint.test.ts — S46 B-6 快捷键分平台与判定 纯逻辑断言
   R44③:Mac ⌘K / Win Ctrl+K 分平台显示;⌘J/Ctrl+J=AI 工作区边栏。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { isAssistantToggleEvent, isPaletteToggleEvent, platformIsMac, shortcutLabel } from "./shortcut-hint";

test("B-6: 平台判定——Mac/iOS 系为 mac,Win/Linux 不是", () => {
  assert.equal(platformIsMac("MacIntel"), true);
  assert.equal(platformIsMac("iPhone"), true);
  assert.equal(platformIsMac("iPad"), true);
  assert.equal(platformIsMac("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), true);
  assert.equal(platformIsMac("Win32"), false);
  assert.equal(platformIsMac("Linux x86_64"), false);
  assert.equal(platformIsMac("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), false);
});

test("B-6: 快捷键展示分平台——Mac=⌘K/⌘J,Win=Ctrl+K/Ctrl+J", () => {
  assert.equal(shortcutLabel("MacIntel", "K"), "⌘K");
  assert.equal(shortcutLabel("MacIntel", "J"), "⌘J");
  assert.equal(shortcutLabel("Win32", "K"), "Ctrl+K");
  assert.equal(shortcutLabel("Win32", "J"), "Ctrl+J");
  assert.equal(shortcutLabel("Linux x86_64", "K"), "Ctrl+K");
});

test("B-6: ⌘K/Ctrl+K=命令面板;⌘J/Ctrl+J=AI 工作区;互不串键,裸键不触发", () => {
  const on = (metaKey: boolean, ctrlKey: boolean, key: string) => ({ metaKey, ctrlKey, key });
  assert.equal(isPaletteToggleEvent(on(true, false, "k")), true);
  assert.equal(isPaletteToggleEvent(on(false, true, "K")), true);
  assert.equal(isPaletteToggleEvent(on(false, false, "k")), false);
  assert.equal(isPaletteToggleEvent(on(true, false, "j")), false);
  assert.equal(isAssistantToggleEvent(on(true, false, "j")), true);
  assert.equal(isAssistantToggleEvent(on(false, true, "J")), true);
  assert.equal(isAssistantToggleEvent(on(false, false, "j")), false);
  assert.equal(isAssistantToggleEvent(on(true, false, "k")), false);
});
