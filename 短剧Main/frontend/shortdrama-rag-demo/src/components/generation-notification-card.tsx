/* ============================================================
  generation-notification-card.tsx — 生成任务终态提醒卡（S29）。
  完整版右下 Dock 与 Lite 顶栏提醒徽标共用同一张卡：成功卡显式确认，
  失败卡 10s 自动确认消退（hover 暂停倒计时）。不许两处各写一套。
  ============================================================ */
/* 显式 React import：node:test + tsx classic JSX 渲染断言与 Vite react-jsx 双兼容
   （与 credits-pill / asset-shared 同一先例——本卡在 s29 测试里做真渲染断言）。 */
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { GenerationAttemptNotification } from "../types";
import { businessErrorMessage } from "../error-copy";
import { cn } from "./ui/cn";
import { Button } from "./ui/button";

/** v1.9 十.5：失败终态卡 10s 自动确认消退；hover 暂停倒计时。成功卡保持显式确认。
    （完整版 Dock 的上传失败卡也走它，故导出。） */
export const FAILURE_AUTO_ACK_MS = 10_000;

export function FailureAutoAckSection({
  onAck,
  className,
  children,
}: {
  onAck: () => void;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(FAILURE_AUTO_ACK_MS);
  const lastTickRef = useRef(Date.now());
  const onAckRef = useRef(onAck);
  onAckRef.current = onAck;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (!paused) remainingRef.current -= now - lastTickRef.current;
      lastTickRef.current = now;
      if (!paused && remainingRef.current <= 0) {
        window.clearInterval(timer);
        onAckRef.current();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [paused]);
  return (
    <section className={className} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      {children}
    </section>
  );
}

const GENERATION_KIND_LABEL: Record<GenerationAttemptNotification["media_kind"], string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

/** 生成任务终态卡（成功=「查看结果」，失败=「查看任务」；均带「知道了」显式确认）。 */
export function GenerationNotificationCard({
  notification,
  onOpen,
  onAcknowledge,
}: {
  notification: GenerationAttemptNotification;
  onOpen: (notification: GenerationAttemptNotification) => void;
  onAcknowledge: (notification: GenerationAttemptNotification) => Promise<void>;
}): React.JSX.Element {
  const kind = GENERATION_KIND_LABEL[notification.media_kind];
  const succeeded = notification.status === "succeeded";
  if (succeeded) {
    return (
      <section className={cn("glass-panel flex gap-3 rounded-md border px-4 py-3 shadow-[var(--shadow-1)]", "border-success/30")}>
        <CheckCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <strong className="text-sm text-success">{`${kind}任务已完成`}</strong>
          <p className="mt-0.5 text-xs text-ink-2">结果已保存，可继续查看或归入当前工作。</p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => onOpen(notification)}>查看结果</Button>
            <Button size="sm" variant="ghost" onClick={() => void onAcknowledge(notification)}>知道了</Button>
          </div>
        </div>
      </section>
    );
  }
  return (
    <FailureAutoAckSection onAck={() => void onAcknowledge(notification)} className={cn("glass-panel flex gap-3 rounded-md border px-4 py-3 shadow-[var(--shadow-1)]", "border-danger/40")}>
      <WarningCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <strong className="text-sm text-danger">{`${kind}任务失败`}</strong>
        <p className="mt-0.5 text-xs text-ink-2">{businessErrorMessage(notification.display_reason, "生成没成：请打开任务查看详情后重试。")}</p>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => onOpen(notification)}>查看任务</Button>
          <Button size="sm" variant="ghost" onClick={() => void onAcknowledge(notification)}>知道了</Button>
        </div>
      </div>
    </FailureAutoAckSection>
  );
}
