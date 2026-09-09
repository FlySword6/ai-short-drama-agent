/* ============================================================
   capability-notice.tsx — 「权限信息没读到」的唯一说法与唯一重试入口

   权限读不到时界面只许说两件事：没读到、点这里再读一次。
   不许退化成「你没有权限」，也不许只是把按钮藏起来——藏起来的按钮
   在用户眼里和被降权是一回事。

   四种位置各一件：整页闸门 / 壳层横条 / 行内小位 / 按钮位占位。
   ============================================================ */
import * as React from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import type { CapabilitiesState } from "../capabilities-state";
import { Button } from "./ui/button";
import { EmptyState, LoadingState } from "./ui/primitives";
import { cn } from "./ui/cn";

const CAPABILITY_UNAVAILABLE_TITLE = "权限信息没读到";
const CAPABILITY_UNAVAILABLE_DETAIL = "这会儿没能确认你在这里能做什么，相关操作先不显示。点重试再读一次。";

/** 整页闸门的读不到态（后台页/项目消耗页这类整页只对某些人开放的地方）。 */
export function CapabilityUnavailablePage({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <EmptyState
      title={CAPABILITY_UNAVAILABLE_TITLE}
      description={CAPABILITY_UNAVAILABLE_DETAIL}
      action={<Button variant="primary" icon={<ArrowClockwise />} onClick={onRetry}>重试</Button>}
      mascot="shrug"
    />
  );
}

/** 整页闸门的读取中态：先不下结论，更不能先出拒绝页。 */
export function CapabilityCheckingPage(): React.JSX.Element {
  return <LoadingState label="正在确认权限" />;
}

/** 壳层横条：左栏导航、页签这类不适合摆错误条的地方，少了入口统一在这儿交代。 */
export function CapabilityUnavailableBar({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-5 py-2 text-xs text-warning" role="status">
      <strong className="font-medium">{CAPABILITY_UNAVAILABLE_TITLE}</strong>
      <span className="text-ink-2">一些入口暂时不显示——这是没读到，不是你没权限。</span>
      <button type="button" className="ml-auto font-medium text-warning underline underline-offset-[3px]" onClick={onRetry}>重试</button>
    </div>
  );
}

/** 行内小位：长在候选图底部、按钮位这类窄地方。 */
export function CapabilityUnavailableInline({ onRetry, className }: { onRetry: () => void; className?: string }): React.JSX.Element {
  return (
    <span className={cn("flex flex-wrap items-center gap-1.5 rounded-md bg-surface-2/85 px-2 py-1 text-[11px] leading-4 text-ink-2", className)} role="status">
      <span>{CAPABILITY_UNAVAILABLE_TITLE}</span>
      <button type="button" className="font-medium text-accent-text underline underline-offset-[3px]" onClick={onRetry}>重试</button>
    </span>
  );
}

/**
 * 动作按钮位在权限落地前摆什么：
 * 读取中给等宽 disabled 占位（按钮先无后有地闪一下，比慢一点更难受）；
 * 读不到给「没读到 · 重试」；已拿到时返回 null，由调用方按判定自己出按钮或拒绝文案。
 */
export function CapabilityActionSlot({ state, label, className }: {
  state: CapabilitiesState;
  /** 占位用的按钮文案：与真按钮同字，宽度才不跳。 */
  label: string;
  className?: string;
}): React.JSX.Element | null {
  if (state.status === "loading") {
    return <Button variant="outline" size="sm" disabled className={className} aria-hidden="true">{label}</Button>;
  }
  if (state.status === "unavailable") return <CapabilityUnavailableInline onRetry={state.reload} className={className} />;
  return null;
}
