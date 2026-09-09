/* ============================================================
  lite-task-notification-badge.tsx — Lite 顶栏任务提醒徽标（2026-08-19 用户裁定 B）：
  完整版右下 Dock 在 Lite 收敛为顶栏铃铛徽标，点击展开终态提醒面板（「顶部剧集条旁
  数量徽标，点击展开」）。轮询/确认/跳转与完整版共用 task-notifications.ts，
  卡片渲染共用 components/generation-notification-card.tsx——不许两处各写一套。
  面板本体抽成无 hook 的 LiteTaskNotificationPanel，Node 环境可 renderToStaticMarkup 真渲染断言。
  ============================================================ */
/* 显式 React import：node:test + tsx classic JSX 渲染断言与 Vite react-jsx 双兼容
   （与 credits-pill / asset-shared 同一先例——面板本体在 s29 测试里做真渲染断言）。 */
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Bell } from "@phosphor-icons/react";
import type { GenerationAttemptNotification } from "../../types";
import { useGenerationNotifications } from "../../task-notifications";
import { GenerationNotificationCard } from "../../components/generation-notification-card";

const VISIBLE_CARDS = 3;

/** 面板本体（纯展示）：卡片列表 + 「还有 N 条」摘要；空态给一句轻提示。 */
export function LiteTaskNotificationPanel({
  notifications,
  onOpen,
  onAcknowledge,
}: {
  notifications: GenerationAttemptNotification[];
  onOpen: (notification: GenerationAttemptNotification) => void;
  onAcknowledge: (notification: GenerationAttemptNotification) => Promise<void>;
}): React.JSX.Element {
  const visible = notifications.slice(0, VISIBLE_CARDS);
  const remaining = notifications.length - visible.length;
  if (visible.length === 0) {
    return <p className="px-2 py-2 text-xs text-ink-2">暂无新的任务提醒</p>;
  }
  return (
    <>
      {visible.map((notification) => (
        <GenerationNotificationCard key={notification.id} notification={notification} onOpen={onOpen} onAcknowledge={onAcknowledge} />
      ))}
      {remaining > 0 ? <p className="px-2 text-xs text-ink-2">还有 {remaining} 条任务更新，处理当前提醒后继续显示。</p> : null}
    </>
  );
}

/** 顶栏铃铛徽标：数量徽标（>0 才显数字）+ 点击展开面板；外部点击 / Escape 关闭。 */
export function LiteTaskNotificationBadge({ demoMode }: { demoMode: boolean }): React.JSX.Element {
  const { notifications, acknowledge, openResult } = useGenerationNotifications(!demoMode);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const count = notifications.length;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={count > 0 ? `任务提醒，${count} 条未处理` : "任务提醒"}
        aria-expanded={open}
        className="relative inline-flex size-9 items-center justify-center rounded-sm text-ink-2 transition-colors duration-[var(--duration-1)] ease-out-quart hover:bg-surface-2 hover:text-ink-1"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell className="size-[18px]" />
        {count > 0 ? (
          <span
            aria-live="polite"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-2 text-[10px] font-medium leading-none text-white"
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="任务提醒"
          className="absolute right-0 top-full z-[var(--z-toast)] mt-2 flex max-h-[70vh] w-[min(360px,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto rounded-md border border-border-2 bg-surface-1 p-3 shadow-[var(--shadow-1)]"
        >
          <LiteTaskNotificationPanel
            notifications={notifications}
            onOpen={(notification) => {
              setOpen(false);
              openResult(notification);
            }}
            onAcknowledge={(notification) => {
              setOpen(false);
              return acknowledge(notification);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
