/* ============================================================
   task-queue-entry.tsx — K2W「全局生产任务队列」顶栏入口与队列面板

   DC 痛点:「我在图片页生成了两张图片,然后没有地方让我可以知道
   我提交的任务是什么状态,只能被动等待。」

   形态:顶栏右组常驻图标按钮(ListChecks)+ 在途数徽标(0 不显示数字,克制),
   点开是队列面板——任务、所处阶段(排队中·第N位/生成中/已失败)、预计、
   失败原因;点任务跳对应镜工作台。挂在壳层(全局壳/项目壳三处右组),
   切页不丢;任一时刻只渲染一处,天然无重复轮询。

   数据真源(不重造):
   - 在途 = K2J 会话台账(sessionStorage)+ GET /api/v1/generations/:id,
     轮询复用 K2J 素材卡徽标 3s 模式(Promise.allSettled,403/404 与终态
     忘台账,failed 留台账停轮该任务,无在途即停拍);
   - 终态通知近条目 = GET /api/v1/generation-attempt-notifications,
     面板打开时拉一次(右下角 Dock 15s 轮询已在跑,这里不重复轮)。

   视觉走 ui/dropdown-menu wrapper(Radix)与内联 token 类,本文件 css-free、
   可被 node:test import。显式 React import:仓根门禁(classic JSX)与
   Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle, ImageSquare, ListChecks, MusicNote, VideoCamera, WarningCircle } from "@phosphor-icons/react";
import { ApiClientError, api } from "../api";
import { demoGenerationQueueNotifications, demoGenerationQueueTasks } from "../demo";
import { forgetGenerationRequest } from "../generation-task-recovery";
import {
  activeTaskCount,
  listAllGenerationRequests,
  queueEstimateText,
  queueFailureText,
  queueItemPath,
  queueMediaKindText,
  queuePhaseText,
  splitQueueRows,
  taskQueuePhase,
  type QueueLedgerEntry,
  type TaskQueueRow,
} from "../generation-task-queue";
import { navigate, notificationResultPath } from "../routing";
import { relativeTimeLabel } from "../ui";
import type { GenerationAttemptNotification, GenerationTask } from "../types";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** 台账本地扫描拍(纯 sessionStorage 读,无网络):提交动作发生在子页面、壳不重渲,靠它 3s 内感知新任务。 */
const LEDGER_SCAN_MS = 3000;
/** 在途网络轮询拍 = K2J 素材卡徽标同款 3s;只在有在途任务时启动,无在途即停(省电克制)。 */
const TASK_POLL_MS = 3000;

interface QueueState {
  rows: TaskQueueRow[];
  activeCount: number;
  notifications: GenerationAttemptNotification[];
}

function useGenerationTaskQueue(demoMode: boolean, open: boolean): QueueState {
  const [ledger, setLedger] = useState<QueueLedgerEntry[]>([]);
  const [tasksById, setTasksById] = useState<Record<string, GenerationTask>>({});
  /** 已忘台账的 requestId(终态成功/取消,或服务端 403/404):本地遮罩,不等下一次扫描。 */
  const [goneIds, setGoneIds] = useState<ReadonlySet<string>>(() => new Set());
  /** 面板打开时解析的展示名/跳链参数(唯一 projectId/shotId 各一次,不重复拉)。 */
  const [resolvedById, setResolvedById] = useState<Record<string, { projectName?: string; shotLabel?: string; episodeId: string | null }>>({});
  const [notifications, setNotifications] = useState<GenerationAttemptNotification[]>([]);

  /* 台账扫描:常驻本地拍(成本≈0,零网络);不可读(隐私模式等)时退化为空队列。 */
  useEffect(() => {
    if (demoMode) return;
    const scan = () => {
      try {
        setLedger(listAllGenerationRequests(window.sessionStorage));
      } catch {
        setLedger([]);
      }
    };
    scan();
    const timer = window.setInterval(scan, LEDGER_SCAN_MS);
    return () => window.clearInterval(timer);
  }, [demoMode]);

  const activeLedger = useMemo(
    () => ledger.filter((entry) => !goneIds.has(entry.requestId)),
    [ledger, goneIds],
  );

  /* 在途集合 key:未终态(含首拍前未知)任务才轮;failed 留台账但移出轮询集,
     settled 忘台账后随之移出;集合为空 = 不启动/停拍。 */
  const pollingKey = activeLedger
    .filter((entry) => {
      const phase = taskQueuePhase(tasksById[entry.requestId]);
      return phase === "queued" || phase === "running";
    })
    .map((entry) => entry.requestId)
    .join(",");

  useEffect(() => {
    if (demoMode || !pollingKey) return;
    let active = true;
    let timer = 0;
    const ids = pollingKey.split(",");
    const entries = activeLedger.filter((entry) => ids.includes(entry.requestId));
    const tick = async (): Promise<void> => {
      /* 隐藏标签页不丢拍只延拍(与 Dock 的 hidden 口径同规,后台不空转网络)。 */
      if (document.hidden) {
        timer = window.setTimeout(() => void tick(), TASK_POLL_MS);
        return;
      }
      const results = await Promise.allSettled(entries.map((entry) => api.generation(entry.requestId)));
      if (!active) return;
      const fresh: GenerationTask[] = [];
      const forget: QueueLedgerEntry[] = [];
      let hasActive = false;
      let settledAny = false;
      results.forEach((result, index) => {
        const entry = entries[index]!;
        if (result.status === "rejected") {
          // 服务端已无此任务(403/404)→ 忘台账;其余失败保留旧态,下一拍再试
          if (result.reason instanceof ApiClientError && [403, 404].includes(result.reason.status)) forget.push(entry);
          else hasActive = true;
          return;
        }
        fresh.push(result.value);
        const phase = taskQueuePhase(result.value);
        if (phase === "settled") {
          forget.push(entry);
          settledAny = true;
        } else if (phase !== "failed") {
          /* failed:留台账(工作台可恢复失败卡重试),并自动移出下一拍轮询集 */
          hasActive = true;
        }
      });
      if (fresh.length > 0) {
        setTasksById((previous) => ({ ...previous, ...Object.fromEntries(fresh.map((task) => [task.generation_request_id, task])) }));
      }
      if (forget.length > 0) {
        try {
          for (const entry of forget) forgetGenerationRequest(window.sessionStorage, entry.projectId, entry.shotId, entry.mediaKind);
        } catch { /* 台账清理失败不阻塞展示 */ }
        setGoneIds((previous) => new Set([...previous, ...forget.map((entry) => entry.requestId)]));
      }
      /* 与 K2J 同规:终态广播,开着的生产页/素材卡自己刷新,不假装列表已最新。 */
      if (settledAny) window.dispatchEvent(new Event("production-progress-changed"));
      if (active && hasActive) timer = window.setTimeout(() => void tick(), TASK_POLL_MS);
    };
    void tick();
    return () => { active = false; window.clearTimeout(timer); };
    // pollingKey(在途集合)变化才重开轮询;entries 由 pollingKey 派生
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, pollingKey]);

  /* 面板打开时解析展示名与跳链参数(台账不存 episodeId,api.shot 顺带拿回);
     解析失败如实留空,名称行不造假名。 */
  const ledgerKey = activeLedger.map((entry) => entry.requestId).join(",");
  useEffect(() => {
    if (demoMode || !open) return;
    const unresolved = activeLedger.filter((entry) => !resolvedById[entry.requestId]);
    if (unresolved.length === 0) return;
    let active = true;
    const projectNames = new Map<string, Promise<string | undefined>>();
    for (const entry of unresolved) {
      if (!projectNames.has(entry.projectId)) {
        projectNames.set(entry.projectId, api.project(entry.projectId).then((project) => project.name).catch(() => undefined));
      }
    }
    void Promise.all(unresolved.map(async (entry) => {
      const [projectName, shot] = await Promise.all([
        projectNames.get(entry.projectId)!,
        api.shot(entry.shotId).catch(() => null),
      ]);
      return [entry.requestId, {
        projectName,
        shotLabel: shot ? shot.title || `素材 #${shot.shot_no}` : undefined,
        episodeId: shot?.episode_id ?? null,
      }] as const;
    })).then((entries) => {
      if (!active || entries.length === 0) return;
      setResolvedById((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
    });
    return () => { active = false; };
    // resolvedById 不挂依赖:已解析条目不重复拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, open, ledgerKey]);

  /* 终态通知近条目:面板打开时拉一次(Dock 15s 轮询已在跑,不重复轮);
     只留已完成——失败由台账在途区表达,同一失败不两处刷屏。 */
  useEffect(() => {
    if (demoMode || !open) return;
    let active = true;
    api.generationAttemptNotifications(5)
      .then((data) => { if (active) setNotifications(data.items.filter((item) => item.status === "succeeded")); })
      .catch(() => { if (active) setNotifications([]); });
    return () => { active = false; };
  }, [demoMode, open]);

  const rows = useMemo<TaskQueueRow[]>(() => {
    if (demoMode) return demoGenerationQueueTasks;
    return activeLedger.map((entry) => ({ entry, task: tasksById[entry.requestId], ...resolvedById[entry.requestId] }));
  }, [demoMode, activeLedger, tasksById, resolvedById]);

  return {
    rows,
    activeCount: activeTaskCount(rows.map((row) => row.task)),
    notifications: demoMode ? demoGenerationQueueNotifications : notifications,
  };
}

/** 阶段徽章配色:queued=提醒黄、running=进行中 accent、failed=危险红;settled 不进面板。 */
function phaseToneClass(task: GenerationTask | undefined): string {
  switch (taskQueuePhase(task)) {
    case "queued":
      return "text-warning";
    case "running":
      return "text-accent-text";
    case "failed":
      return "text-danger";
    default:
      return "text-ink-3";
  }
}

function mediaKindIcon(kind: "image" | "video" | "audio", className: string): React.JSX.Element {
  if (kind === "video") return <VideoCamera aria-hidden="true" className={className} />;
  if (kind === "audio") return <MusicNote aria-hidden="true" className={className} />;
  return <ImageSquare aria-hidden="true" className={className} />;
}

/**
 * 队列面板纯渲染(无状态):在途区(排队中/生成中)→ 需要处理(已失败+原因)→ 最近完成。
 * 测试直接渲染本组件;入口组件只负责状态与跳转。
 */
export function TaskQueuePanelView({ demoMode, rows, notifications, onOpenRow, onOpenNotification }: {
  demoMode: boolean;
  rows: readonly TaskQueueRow[];
  notifications: readonly GenerationAttemptNotification[];
  onOpenRow: (row: TaskQueueRow) => void;
  onOpenNotification: (notification: GenerationAttemptNotification) => void;
}): React.JSX.Element {
  const { activeRows, failedRows } = splitQueueRows(rows);
  return (
    <div className="flex max-h-[min(460px,70vh)] w-[min(340px,calc(100vw-2rem))] flex-col overflow-y-auto">
      <div className="flex items-baseline justify-between px-3 pb-1 pt-2.5">
        <strong className="text-xs font-semibold text-ink-1">任务队列</strong>
        <span className="text-[11px] text-ink-3">{activeRows.length > 0 ? `${activeRows.length} 个在途` : "没有在途任务"}</span>
      </div>
      {demoMode ? <p className="px-3 pb-1 text-[11px] text-warning">离线演示 · 示例任务,不会提交真实生成</p> : null}
      {rows.length === 0 && notifications.length === 0 ? (
        <p className="px-3 pb-3 pt-1 text-xs text-ink-2">在分镜工作台提交生成后,任务进度会出现在这里,切到别的页面也能看到。</p>
      ) : null}
      {activeRows.map((row) => {
        const estimate = queueEstimateText(row.task);
        return (
          <DropdownMenuItem key={row.entry.requestId} className="items-start gap-2.5 px-3 py-2.5" onSelect={() => onOpenRow(row)}>
            {mediaKindIcon(row.entry.mediaKind, "mt-0.5 size-4 shrink-0 text-ink-3")}
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs font-medium text-ink-1">
                  {row.projectName ?? `${queueMediaKindText(row.entry.mediaKind)}任务`}{row.shotLabel ? ` · ${row.shotLabel}` : ""}
                </span>
                <span className={cn("shrink-0 text-[11px] font-medium", phaseToneClass(row.task))}>{queuePhaseText(row.task)}</span>
              </span>
              <span className="mt-0.5 block text-[11px] text-ink-3">
                {queueMediaKindText(row.entry.mediaKind)}任务{estimate ? ` · ${estimate}` : ""}
              </span>
            </span>
          </DropdownMenuItem>
        );
      })}
      {failedRows.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>需要处理</DropdownMenuLabel>
          {failedRows.map((row) => (
            <DropdownMenuItem key={row.entry.requestId} className="items-start gap-2.5 px-3 py-2.5" onSelect={() => onOpenRow(row)}>
              <WarningCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-medium text-ink-1">
                    {row.projectName ?? `${queueMediaKindText(row.entry.mediaKind)}任务`}{row.shotLabel ? ` · ${row.shotLabel}` : ""}
                  </span>
                  <span className="shrink-0 text-[11px] font-medium text-danger">{queuePhaseText(row.task)}</span>
                </span>
                <span className="mt-0.5 block text-[11px] text-danger">{queueFailureText(row.task)}</span>
                <span className="mt-0.5 block text-[11px] text-ink-3">{queueMediaKindText(row.entry.mediaKind)}任务 · 点本行去工作台重试</span>
              </span>
            </DropdownMenuItem>
          ))}
        </>
      ) : null}
      {notifications.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>最近完成</DropdownMenuLabel>
          {notifications.map((notification) => (
            <DropdownMenuItem key={notification.id} className="items-center gap-2.5 px-3 py-2" onSelect={() => onOpenNotification(notification)}>
              <CheckCircle aria-hidden="true" className="size-4 shrink-0 text-success" />
              <span className="min-w-0 flex-1 truncate text-xs text-ink-1">{queueMediaKindText(notification.media_kind)}任务已完成</span>
              <span className="shrink-0 text-[11px] text-ink-3">{relativeTimeLabel(notification.created_at)}</span>
            </DropdownMenuItem>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** 顶栏常驻入口:图标 + 在途数徽标(0 时不显示数字,克制),点开队列面板。 */
export function TaskQueueEntry({ demoMode }: { demoMode: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { rows, activeCount, notifications } = useGenerationTaskQueue(demoMode, open);
  const label = activeCount > 0 ? `任务队列,${activeCount} 个任务在途` : "任务队列";

  function openRow(row: TaskQueueRow): void {
    setOpen(false);
    navigate(queueItemPath(row.entry.projectId, row.entry.shotId, row.episodeId ?? null));
  }

  function openNotification(notification: GenerationAttemptNotification): void {
    setOpen(false);
    navigate(notificationResultPath(notification));
    /* 与 Dock 的 openResult 同语义:看过即确认;确认失败不阻塞跳转。 */
    if (!demoMode) void api.acknowledgeGenerationAttemptNotification(notification.id).catch(() => {});
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-8" icon={<ListChecks />} aria-label={label} title={label}>
          {activeCount > 0 ? (
            <span aria-hidden="true" className="absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-accent-ink [font-family:var(--font-mono)]">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="p-1">
        <TaskQueuePanelView demoMode={demoMode} rows={rows} notifications={notifications} onOpenRow={openRow} onOpenNotification={openNotification} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
