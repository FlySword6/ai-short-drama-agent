/**
 * UserMenu — 头像下拉菜单（Radix DropdownMenu 原语版）。
 * 交互由 Radix 保证：focus trap、方向键、Esc、碰撞定位、portal（不怕顶栏 stacking context）。
 * 三项：个人信息（只读诚实态 Modal）/ 设置 / 退出登录。
 * CSS 由 app.tsx 统一引入（user-menu.css），本文件保持可被 node:test import。
 */
import * as React from "react";
import { GearSix, SignOut, User, UserCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { navigate } from "../routing";
import type { User as UserType } from "../types";
import { Modal } from "../ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** 菜单结构唯一真源（测试断言用）。 */
export const USER_MENU_ITEMS = [
  { key: "profile", label: "个人信息", action: "profile" },
  { key: "settings", label: "设置", action: "settings" },
  { key: "logout", label: "退出登录", action: "logout" },
] as const;

export const PROFILE_READONLY_NOTE = "资料编辑即将开放，当前为只读。";

/** 图标惰性求值：顶层 JSX 会让 node:test 的 classic transform 找不到 React。 */
function itemIcon(key: string): React.JSX.Element {
  if (key === "profile") return <UserCircle />;
  if (key === "settings") return <GearSix />;
  return <SignOut />;
}

export function UserMenu({ user, onLogout, compact = false, creditsRow, menuSide = "bottom" }: {
  user: UserType;
  onLogout: () => void;
  compact?: boolean;
  /** S73:积分余额行(AccountCreditsMenuRow,全宽度显示——R2 壳后 pill 退役,
     rail 只剩余额快览,本行=余额/今日剩余/日额度三数的唯一明细位)。
     F09:行提菜单顶部,亮度提正文档。 */
  creditsRow?: React.ReactNode;
  /** rail 底组实例传 right(菜单向右开,不回头盖住 rail);页面右上等常规位用 bottom。 */
  menuSide?: "bottom" | "right";
}): React.JSX.Element {
  const [profileOpen, setProfileOpen] = useState(false);

  function run(action: string): void {
    if (action === "profile") setProfileOpen(true);
    else if (action === "settings") navigate("/settings");
    else if (action === "logout") onLogout();
  }

  /* UIFIX2-B:rail 位账号触发器改 rail 惯例(icon 方块+9px 截断标签)。
     旧 pill(边框+图标+文字)在 72px 栏宽里装不下,居中溢出两侧、左缘被视口硬裁字头
     (DC 走查实证「本地管理员」只见「地管理员」);新结构截断只发生在尾部,
     全名进 title/aria,任何长度可读。 */
  const trigger = compact ? (
    <DropdownMenuTrigger
      className="flex w-14 flex-col items-center gap-1 rounded-lg px-1 py-1.5 transition-colors duration-[var(--duration-1)] ease-out-quart hover:bg-tk-hover"
      aria-label={`账号菜单：${user.display_name}`}
      title={user.display_name}
    >
      <span className="flex size-8 items-center justify-center rounded-md bg-tk-elevated text-ink-3">
        <User className="size-[18px]" aria-hidden="true" />
      </span>
      <span className="max-w-full truncate text-[9px] leading-none text-ink-3">{user.display_name}</span>
    </DropdownMenuTrigger>
  ) : (
    <DropdownMenuTrigger
      className="inline-flex min-h-[34px] max-w-full items-center gap-2 overflow-hidden rounded-full border border-border-2 px-3 text-xs text-ink-2 transition-colors duration-[var(--duration-1)] ease-out-quart hover:text-ink-1 [&_svg]:size-4"
      aria-label={`账号菜单：${user.display_name}`}
      title={user.display_name}
    >
      <User aria-hidden="true" />
      <span className="truncate">{user.display_name}</span>
      <SignOut aria-hidden="true" />
    </DropdownMenuTrigger>
  );

  return (
    <>
      <DropdownMenu>
        {trigger}
        <DropdownMenuContent align="end" side={menuSide}>
          {creditsRow ? (
            <>
              {creditsRow}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuLabel className="max-w-[240px] truncate" title={user.username}>{user.username}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {USER_MENU_ITEMS.map((item) => (
            <DropdownMenuItem key={item.key} destructive={item.action === "logout"} onSelect={() => run(item.action)}>
              {itemIcon(item.key)}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {profileOpen ? (
        <Modal title="个人信息" size="small" onClose={() => setProfileOpen(false)}>
          <div className="user-profile">
            <dl>
              <dt>显示名称</dt><dd>{user.display_name}</dd>
              <dt>账号</dt><dd>{user.username}</dd>
            </dl>
            <p className="user-profile-note">{PROFILE_READONLY_NOTE}</p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
