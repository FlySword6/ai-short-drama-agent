/* ============================================================
   lite-shot-videos.tsx — Lite 分镜卡段⑤「这一镜出过的片」
   （P-18a 段⑤ 收纳行 + P-18c 产物面，就地展开，不跳页不弹窗）。

   口径（原型说明 §八）：
   - 出片产物在分镜页看得完整：看片/定成片/下载都不离开分镜页；
     视频页保留做整集横向列表与打包，两者不冲突。
   - 「原片转存中」不许省：模型给的视频地址只留一天，转存没完成不亮下载；
     界面如实说在转存、存好才给下载。
   - 「定成这一镜的片」= 成片指定（与图片侧「通过并选用」同一层语义，人在把关）：
     有终审权一次动作走完（需要时先审核通过再指定），无权限看「等审核 · 谁能过」。
   - 失败卡给人话原因 + 下一步；任务 wire 无实际扣费字段，扣费不断言（回执登记）。
   ============================================================ */
import { CaretDown, CaretUp, DownloadSimple, Play } from "@phosphor-icons/react";
import { useState } from "react";
import type { GenerationTask, MediaVersion } from "../../types";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { humanErrorMessage } from "../batch-generate-drawer";
import type { CapabilityGate } from "../../capabilities-state";
import { CapabilityUnavailableInline } from "../../components/capability-notice";
import { formatPlaybackClock } from "../../components/version-modal";
import { mediaDownloadable } from "./lite-media-entries";

/** 面板消费的在飞/失败视频任务视图（页面的 TrackedLiteTask 取子集，解耦页面状态机）。 */
export interface LiteVideoTaskView {
  requestId: string;
  task: GenerationTask;
  timedOut: boolean;
}

/** 条目序号（「第 02 条」）：创建时间升序排位，01 起补零。 */
function entryNo(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function timeLabel(createdAt: string | null | undefined): string {
  if (!createdAt) return "时间未知";
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return "时间未知";
  return parsed.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function durationCode(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return formatPlaybackClock(seconds);
}

/** 下载闸门：原片转存完成（persisted）才给下载（§8.4 硬约束）。 */
function videoDownloadable(video: MediaVersion): boolean {
  return mediaDownloadable(video);
}

/** 播放态缩略格：未播=深色格 + 播放键 + 时间码；点开就地 <video> 播放。 */
function VideoTile({ video, size, badge }: {
  video: MediaVersion;
  /** 收纳行 44×44（sm），产物面 180×320（lg）。 */
  size: "sm" | "lg";
  badge?: string;
}): React.JSX.Element {
  const [playing, setPlaying] = useState(false);
  const code = durationCode(video.duration_seconds);
  if (playing && video.storage_url) {
    return (
      <video
        className={cn("bg-black object-cover", size === "sm" ? "size-11 rounded-lg" : "aspect-[9/16] w-full")}
        controls
        autoPlay
        src={video.storage_url}
        aria-label="播放这一条"
      />
    );
  }
  return (
    <button
      type="button"
      aria-label="播放这一条"
      disabled={!video.storage_url}
      onClick={() => setPlaying(true)}
      className={cn(
        "group relative flex items-center justify-center overflow-hidden bg-surface-2",
        size === "sm" ? "size-11 rounded-lg" : "aspect-[9/16] w-full",
      )}
    >
      <span className={cn(
        "flex items-center justify-center rounded-full bg-black/55 text-ink-1",
        size === "sm" ? "size-5" : "size-13 border border-white/30",
      )}>
        <Play aria-hidden="true" className={size === "sm" ? "size-3" : "size-6"} weight="fill" />
      </span>
      {code ? <span className="absolute bottom-1 left-1 font-mono text-[10px] text-ink-1">{code}</span> : null}
      {badge ? <span className="absolute left-1 top-1 rounded-sm bg-accent px-2 text-[10px] leading-4 text-accent-ink">{badge}</span> : null}
    </button>
  );
}

export function LiteShotVideos({ shotNo, videos, tasks, reviewGate, onReloadCapabilities, reviewerHint, busyId, demoMode, onSetPrimary, onDownload, onRetryTask, onRefreshTask, hideWhenEmpty = false }: {
  shotNo: string;
  videos: readonly MediaVersion[];
  tasks: readonly LiteVideoTaskView[];
  /** 终审权四值闸门：读取中留占位、读不到给重试、无权说等审核、可裁决出定片钮。 */
  reviewGate: CapabilityGate;
  onReloadCapabilities: () => void;
  reviewerHint: string;
  busyId: string | null;
  demoMode: boolean;
  onSetPrimary: (video: MediaVersion) => void;
  onDownload: (video: MediaVersion) => void;
  onRetryTask: (requestId: string) => void;
  onRefreshTask: (requestId: string) => void;
  /** 既无产物也无在飞任务时不渲染空态教学位（制作页卡片用它收窄卡高）。 */
  hideWhenEmpty?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const ordered = [...videos].sort((left, right) => (left.created_at ?? "").localeCompare(right.created_at ?? ""));
  const primaryIndex = ordered.findIndex((video) => video.is_primary === true);
  const primary = primaryIndex >= 0 ? ordered[primaryIndex]! : null;
  const activeTasks = tasks.filter((tracked) => tracked.task.status === "pending" || tracked.task.status === "running");
  const failedTasks = tasks.filter((tracked) => tracked.task.status === "failed");
  const totalCount = ordered.length + activeTasks.length + failedTasks.length;

  /* 空态（没有在飞也没有产物）：教学位，不收成一行条；hideWhenEmpty 时整块不渲染。 */
  if (totalCount === 0) {
    if (hideWhenEmpty) return <></>;
    return (
      <p className="rounded-xl border border-border-1 bg-surface-1 px-4 py-3 text-sm text-ink-2" aria-label={`第 ${shotNo} 镜出片产物`}>
        <strong className="font-medium">这一镜还没出片。</strong>
        <span className="text-ink-3">挑一张定下来，或者直接带参考出片。出好的片会排在这儿，能看能下载。</span>
      </p>
    );
  }

  return (
    <section className="rounded-xl border border-border-1 bg-surface-1" aria-label={`第 ${shotNo} 镜出片产物`}>
      {/* 收纳态一行：缩略格 + 计数 + 下载成片 + 看这批 */}
      <div className="flex min-h-13 flex-wrap items-center gap-3 px-4 py-2.5">
        <span className="shrink-0 text-[13px] text-ink-2">这一镜出过的片</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {ordered.slice(0, 4).map((video) => <VideoTile key={video.id} video={video} size="sm" />)}
          {ordered.length > 4 ? <span className="font-mono text-xs text-ink-3">+{ordered.length - 4}</span> : null}
          {activeTasks.length > 0 ? <span className="text-xs text-ink-3">{activeTasks.length} 条出片中</span> : null}
        </span>
        <span className="font-mono text-xs text-ink-3">
          {ordered.length} 条{primary ? ` · 已定第 ${entryNo(primaryIndex)} 条为这一镜的成片` : ""}
        </span>
        {primary ? (
          <Button size="sm" variant="primary" icon={<DownloadSimple />} loading={busyId === primary.id} disabled={!videoDownloadable(primary)} onClick={() => onDownload(primary)}>下载成片</Button>
        ) : null}
        <Button size="sm" variant="ghost" icon={expanded ? <CaretUp /> : <CaretDown />} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "看这批"}
        </Button>
      </div>

      {expanded ? (
        <div className="border-t border-border-1 px-4 py-3">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h4 className="text-sm font-medium text-ink-1">出过 {totalCount} 条</h4>
            <p className="min-w-0 flex-1 text-xs text-ink-3">同一镜可以出很多条，只有一条会成为这一镜的成片；其余的留着比对，不删。</p>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            {ordered.map((video, index) => {
              const isPrimary = video.is_primary === true;
              const downloadable = videoDownloadable(video);
              const needsReview = video.review_status === "needs_review";
              return (
                <div key={video.id} className="flex w-32 flex-col gap-1.5">
                  <span className={cn(
                    "relative overflow-hidden rounded-lg border",
                    isPrimary ? "border-accent ring-2 ring-accent/40" : "border-border-1",
                  )}>
                    {downloadable ? (
                      <VideoTile video={video} size="lg" badge={isPrimary ? "这镜的成片" : undefined} />
                    ) : (
                      <span className="relative flex aspect-[9/16] w-full items-center justify-center bg-surface-2 px-3 text-center">
                        <span className="text-[11px] leading-4 text-ink-3">原片正在存进我们这儿，大概一分钟。存好才给下载。</span>
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-ink-3">
                    {entryNo(index)} · {isPrimary ? "已定" : downloadable ? "出好了" : "原片转存中"} · {timeLabel(video.created_at)}
                  </span>
                  {isPrimary ? (
                    <Button size="sm" variant="primary" icon={<DownloadSimple />} loading={busyId === video.id} onClick={() => onDownload(video)}>下载这条</Button>
                  ) : downloadable ? (
                    <span className="flex flex-col gap-1">
                      {needsReview && reviewGate === "loading" ? (
                        /* 权限还在读：留等高空位，不先说等审核再改口。 */
                        <span className="h-7" aria-hidden="true" />
                      ) : needsReview && reviewGate === "unavailable" ? (
                        <CapabilityUnavailableInline onRetry={onReloadCapabilities} />
                      ) : needsReview && reviewGate === "denied" ? (
                        <span className="rounded-md bg-surface-2/85 px-2 py-2 text-[11px] leading-4 text-ink-2" role="status">
                          等审核<br />{reviewerHint} 能过这条
                        </span>
                      ) : (
                        <Button size="sm" variant="outline" loading={busyId === video.id} onClick={() => onSetPrimary(video)}>定成这一镜的片</Button>
                      )}
                      <Button size="sm" variant="outline" icon={<DownloadSimple />} loading={busyId === video.id} onClick={() => onDownload(video)}>下载</Button>
                    </span>
                  ) : null}
                </div>
              );
            })}
            {activeTasks.map((tracked, taskIndex) => {
              const estimate = tracked.task.estimated_duration_seconds;
              return (
                <div key={tracked.requestId} className="flex w-32 flex-col gap-1.5">
                  <span className="relative flex aspect-[9/16] w-full items-center justify-center overflow-hidden rounded-lg border border-border-1 bg-surface-2/75 px-3 text-center">
                    <span className="absolute inset-x-6 top-1/2 h-0.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                    <span className="text-[11px] leading-4 text-ink-2">
                      正在出片{typeof estimate === "number" && estimate > 0 ? ` · 大概还要 ${Math.max(1, Math.ceil(estimate / 60))} 分钟` : ""}<br />
                      可以离开这一页，回来接着看。
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-ink-3">{entryNo(ordered.length + taskIndex)} · 出片中</span>
                  {tracked.timedOut ? (
                    <Button size="sm" variant="outline" loading={busyId === tracked.requestId} onClick={() => onRefreshTask(tracked.requestId)}>立即刷新</Button>
                  ) : null}
                </div>
              );
            })}
            {failedTasks.map((tracked, failIndex) => (
              <div key={tracked.requestId} className="flex w-32 flex-col gap-1.5">
                <span className="flex aspect-[9/16] w-full flex-col items-start justify-center gap-1 rounded-lg border border-danger/50 bg-surface-2 px-3" role="alert">
                  <strong className="text-[11px] font-medium text-danger">没出成</strong>
                  <span className="text-[11px] leading-4 text-ink-2">{humanErrorMessage(tracked.task.display_reason, "服务没有返回具体原因")}</span>
                </span>
                <span className="font-mono text-[11px] text-ink-3">{entryNo(ordered.length + activeTasks.length + failIndex)} · 没出成 · {timeLabel(tracked.task.updated_at ?? tracked.task.created_at)}</span>
                <Button size="sm" variant="danger-outline" disabled={demoMode} onClick={() => onRetryTask(tracked.requestId)}>重新出这条</Button>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-border-1 pt-2 text-[11px] leading-5 text-ink-4">
            「定成这一镜的片」= 这一条就是本镜交付用的那条，下载与打包都按它走；换一条随时可以改，旧的留着。
            下载给的是我们自己存下来的那份原片——模型那边给的地址只留一天，我们不拿它糊弄你。
          </p>
        </div>
      ) : null}
    </section>
  );
}
