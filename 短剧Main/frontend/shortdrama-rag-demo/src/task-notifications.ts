/* ============================================================
  task-notifications.ts — 生成任务终态提醒（S29/S42）轮询·确认·跳转的单一来源。
  完整版右下 Dock 与 Lite 顶栏提醒徽标共用同一份逻辑，不许两处各写一套
  （与 notificationResultPath 收敛进 routing.ts 同款口径）。
  ============================================================ */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { GenerationAttemptNotification } from "./types";
import { navigate, notificationResultPath } from "./routing";

/** 终态提醒轮询周期：后台任务成功/失败后 15s 内浮出；切回标签页立即刷新。 */
export const GENERATION_NOTIFICATION_POLL_MS = 15_000;

export interface GenerationNotificationCenter {
  notifications: GenerationAttemptNotification[];
  acknowledge: (notification: GenerationAttemptNotification) => Promise<void>;
  openResult: (notification: GenerationAttemptNotification) => void;
}

/**
 * S29: 持久站内提醒（不是邮件/短信/浏览器推送）。标签页隐藏时不轮询，回到应用立即刷新，
 * 让创作者可以先去干别的而不错过已完成任务。未确认的提醒不许消失。
 * S42: 与上传入库进度同规的等待期口径——生成任务终态提醒同一套轮询。
 */
export function useGenerationNotifications(enabled: boolean): GenerationNotificationCenter {
  const [notifications, setNotifications] = useState<GenerationAttemptNotification[]>([]);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setNotifications([]);
      return;
    }
    let active = true;
    const refresh = async (): Promise<void> => {
      if (document.hidden || inFlight.current) return;
      inFlight.current = true;
      try {
        const generationResult = await api.generationAttemptNotifications();
        if (!active) return;
        setNotifications(generationResult.items);
      } catch {
        // Notification delivery must not block the creator's current page.
      } finally {
        inFlight.current = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), GENERATION_NOTIFICATION_POLL_MS);
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  async function acknowledge(notification: GenerationAttemptNotification): Promise<void> {
    try {
      await api.acknowledgeGenerationAttemptNotification(notification.id);
      setNotifications((current) => current.filter((item) => item.id !== notification.id));
    } catch {
      // Keep the card visible: an unacknowledged reminder must not disappear.
    }
  }

  function openResult(notification: GenerationAttemptNotification): void {
    navigate(notificationResultPath(notification));
    void acknowledge(notification);
  }

  return { notifications, acknowledge, openResult };
}
