/* ============================================================
   palette-trigger.tsx — 命令面板入口(搜索框形态,S46 B-6,R44③)

   参照样例:搜索栏内联快捷键提示,分平台(Mac ⌘K / Win Ctrl+K)——
   不再只有一个放大镜图标。窄屏收成图标按钮(提示进 title);
   S73:收窄断点 900→1180——顶栏三组在 901–1180px 被右组挤爆(nav 钮内文字折行),
   搜索框文字/kbd 先收,图标入口保留。
   显式 React import:仓根门禁(node:test + tsx,classic JSX)渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";

export function PaletteTrigger({ shortcut, onClick }: {
  /** 分平台快捷键提示(⌘K / Ctrl+K),由调用方按当前平台算好传入。 */
  shortcut: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`命令面板（${shortcut}）`}
      aria-label={`命令面板（${shortcut}）`}
      className="flex min-w-0 items-center gap-2 rounded-md border border-border-1 bg-surface-1 px-2.5 py-1.5 text-xs text-ink-4 transition-colors duration-[var(--duration-1)] ease-out-quart hover:border-border-2 hover:text-ink-2"
    >
      <MagnifyingGlass aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate max-[1180px]:hidden">搜索、跳转与命令</span>
      <kbd className="rounded-sm border border-border-1 bg-surface-2 px-1.5 py-px font-mono text-[10px] leading-4 text-ink-3 max-[1180px]:hidden">{shortcut}</kbd>
    </button>
  );
}
