/* ============================================================
   shortcut-hint.ts — 快捷键提示分平台(S46 B-6,R44③;纯逻辑)

   Mac 显示 ⌘K/⌘J,Windows/Linux 显示 Ctrl+K/Ctrl+J——不写死 ⌘。
   平台判定做成入参(可测),浏览器侧经 currentPlatform() 注入。
   快捷键判定也收在这里:⌘K/Ctrl+K=命令面板,⌘J/Ctrl+J=AI 工作区边栏。
   ============================================================ */

/** 平台串(navigator.platform 或 userAgent)是否 Mac/iOS 系。 */
export function platformIsMac(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** 组合键展示:Mac=⌘+键,其余=Ctrl+键。 */
export function shortcutLabel(platform: string, key: string): string {
  return platformIsMac(platform) ? `⌘${key}` : `Ctrl+${key}`;
}

/** 浏览器当前平台串;非浏览器环境兜底 mac(展示用,不影响功能)。 */
export function currentPlatform(): string {
  if (typeof navigator === "undefined") return "mac";
  return navigator.platform || navigator.userAgent;
}

export interface ShortcutEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  key: string;
}

/** ⌘K / Ctrl+K = 命令面板开关。 */
export function isPaletteToggleEvent(event: ShortcutEventLike): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

/** ⌘J / Ctrl+J = AI 工作区边栏折叠开关(对齐 Claude 桌面端的面板开合习惯)。 */
export function isAssistantToggleEvent(event: ShortcutEventLike): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j";
}
