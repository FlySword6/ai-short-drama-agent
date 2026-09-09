/* ============================================================
   global-jump-menu.tsx — 项目壳「全局跳转」入口（K-goal-02 包 N2）

   背景：双壳互斥替换，一进项目，全局三项只剩「←返回」和 ⌘K 两条出路，
   违反 NN/g「全局导航稳定可见」（藏起来的导航可发现性近砍半）。
   形态：图标按钮 + Radix 菜单，常驻项目壳顶栏右组——一眼可见（不藏头像）、
   只占一格（克制）、语义不污染头像；菜单 = 全局三项 + ⌘K 快路径提示，
   行数 4 ≤ 7（克制判据 K2）。全局壳维持现状不动；跳转路径与全局壳主导航同口径。

   交互由 Radix 保证（focus trap/方向键/Esc/碰撞定位/portal）；
   视觉走 ui/dropdown-menu wrapper 与内联 token 类，本文件 css-free、可被 node:test import。
   显式 React import：仓根门禁（node:test + tsx，classic JSX）渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { ChartBar, Compass, FolderOpen, ImageSquare, MagnifyingGlass } from "@phosphor-icons/react";
import { navigate } from "../routing";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** 菜单结构唯一真源（测试断言用）；path 与全局壳主导航（app.tsx GlobalHeader）同口径。 */
export const GLOBAL_JUMP_ITEMS = [
  { key: "projects", label: "项目管理", path: "/projects" },
  { key: "assets", label: "资产中心", path: "/assets?scope=personal" },
  { key: "dashboard", label: "数据看板", path: "/dashboard" },
] as const;

/** 图标惰性求值：顶层 JSX 会让 node:test 的 classic transform 找不到 React。 */
function itemIcon(key: string): React.JSX.Element {
  if (key === "projects") return <FolderOpen />;
  if (key === "assets") return <ImageSquare />;
  return <ChartBar />;
}

export function GlobalJumpMenu({ shortcut, onOpenPalette }: {
  /** 分平台快捷键提示（⌘K / Ctrl+K），由调用方按当前平台算好传入。 */
  shortcut: string;
  onOpenPalette: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          icon={<Compass />}
          aria-label="全局跳转"
          title="全局跳转（项目管理 / 资产中心 / 数据看板）"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {GLOBAL_JUMP_ITEMS.map((item) => (
          <DropdownMenuItem key={item.key} onSelect={() => navigate(item.path)}>
            {itemIcon(item.key)}
            {item.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenPalette}>
          <MagnifyingGlass />
          命令面板
          <kbd className="ml-auto rounded-sm border border-border-1 bg-surface-2 px-1.5 py-px font-mono text-[10px] leading-4 text-ink-3">{shortcut}</kbd>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
