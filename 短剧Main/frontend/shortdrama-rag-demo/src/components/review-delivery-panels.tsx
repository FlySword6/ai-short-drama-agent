/* ============================================================
   review-delivery-panels.tsx — K2-A 幕四「审与交」两个弹窗(剧本步 15-17)

   1) MediaReviewQueueModal  产物审核待审队列(GP-21):
      按集过滤 + 服务端分页;整集批量通过;单镜拒绝理由必填(客户端先拦,
      与后端 422 同口径);rejected 产物明示「不能设为主版本」(GP-22 的可预见性);
      每条产物可展开审核轨迹(谁、何时、理由)。
   2) EpisodeDeliveryModal   交付本集(GP-24/GP-25):
      未交齐镜头逐镜列出(哪镜差、差在哪);确认后 POST 落账;交付历史按集可查
      (时间/范围/谁交付/未交齐镜号/内容指纹)。

   数据纪律:真栈走 api(media-reviews / deliveries 契约,demo 走
   demo-review-delivery.ts 的可变内存仓——裁决与落账在 demo 里也真发生
   (页面刷新回初始 fixture),不再弹「离线演示不提交」。
   视图层:Tailwind utility + ui 原语;本文件不 import 任何 CSS。
   ============================================================ */
import {
  ArrowClockwise,
  Check,
  CheckCircle,
  ClipboardText,
  FileText,
  BracketsCurly,
  PaperPlaneTilt,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
/* 显式 React import:门禁(node:test + tsx classic JSX)渲染断言与 Vite react-jsx 双兼容(同 ui.tsx)。 */
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import {
  applyDemoReviewDecisions,
  createDemoDelivery,
  demoDeliveriesPage,
  demoDeliveryGaps,
  demoMediaReviewActions,
  demoMediaReviewQueuePage,
  demoReadyVideoIds,
} from "../demo-review-delivery";
import { humanErrorMessage } from "../pages/batch-generate-drawer";
import { ListPager, type PageRuntimeProps } from "../pages/global-pages";
import {
  approveDecisionBodies,
  decisionSummaryCopy,
  deliveryScopeLabel,
  gapReasonLabel,
  rejectDecisionBody,
  rejectionReasonError,
  reviewActionLabel,
  reviewStatusLabel,
  reviewStatusTone,
  shortManifestHash,
  summarizeDecisionOutcomes,
  type DeliveryGap,
  type DeliveryRecord,
  type DeliveryRecordPage,
  type MediaReviewActionRecord,
  type MediaReviewDecisionOutcome,
  type MediaReviewQueueItem,
  type MediaReviewQueuePage,
  type MediaReviewStatus,
} from "../review-delivery";
import type { Episode } from "../types";
import { Button, EmptyState, ErrorState, LoadingState, formatDateTime } from "../ui";
import { cn } from "./ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Badge, Textarea } from "./ui/primitives";

const PAGE_SIZE = 20;

/* ---------- 小组件:状态徽标 / 分段开关(与既有面板同款) ---------- */

export function ReviewStatusBadge({ status }: { status: MediaReviewStatus | string }): React.JSX.Element {
  return <Badge tone={reviewStatusTone(status)}>{reviewStatusLabel(status)}</Badge>;
}

function SegmentedTabs<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}): React.JSX.Element {
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-border-1 bg-surface-0 p-1" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-sm text-ink-2 transition-colors hover:text-ink-1",
            value === option.value && "bg-surface-2 text-ink-1 shadow-sm",
          )}
          onClick={() => onChange(option.value)}
        >{option.label}</button>
      ))}
    </div>
  );
}

/* ---------- 取数 hook:统一 loading/error/reload(与 useResource 同语义,支持写后重读) ---------- */

function useAsyncData<T>(load: () => Promise<T>, deps: readonly unknown[]): { data: T | null; loading: boolean; error: string; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string }>({ data: null, loading: true, error: "" });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: "" }));
    void load().then((data) => {
      if (active) setState({ data, loading: false, error: "" });
    }).catch((reason: unknown) => {
      if (active) setState({ data: null, loading: false, error: humanErrorMessage(reason, "读取失败") });
    });
    return () => { active = false; };
    // 调用方通过 deps 控制重读键(同 useResource 的约定)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, revision, ...deps]);
  return { ...state, reload };
}

/* ============================================================
   弹窗一:产物审核待审队列
   ============================================================ */

export interface MediaReviewQueueModalProps {
  projectId: string;
  episodes: Episode[];
  initialEpisodeId?: string;
  demoMode: boolean;
  /** 审核动作(批量通过/拒绝)的显隐唯一判据;只读角色可看队列与轨迹。 */
  canWrite: boolean;
  notify: PageRuntimeProps["notify"];
  onClose: () => void;
}

export function MediaReviewQueueModal({ projectId, episodes, initialEpisodeId, demoMode, canWrite, notify, onClose }: MediaReviewQueueModalProps): React.JSX.Element {
  const [episodeId, setEpisodeId] = useState(initialEpisodeId ?? episodes[0]?.id ?? "");
  const [status, setStatus] = useState<MediaReviewStatus>("needs_review");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const [rejectTarget, setRejectTarget] = useState<MediaReviewQueueItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const queue = useAsyncData<MediaReviewQueuePage>(
    () => demoMode
      ? Promise.resolve(demoMediaReviewQueuePage({ status, episodeId: episodeId || undefined, page, pageSize: PAGE_SIZE }))
      : api.mediaReviewQueue(projectId, { status, episodeId: episodeId || undefined, page, pageSize: PAGE_SIZE }),
    [demoMode, projectId, status, episodeId, page],
  );

  const episodeNo = episodes.find((episode) => episode.id === episodeId)?.episode_no;

  function switchEpisode(nextId: string): void {
    setEpisodeId(nextId);
    setPage(1);
    setExpandedId(null);
  }

  function switchStatus(next: MediaReviewStatus): void {
    setStatus(next);
    setPage(1);
    setExpandedId(null);
  }

  /** 拉全集待审 id(跨页;后端单页上限 50,批量裁决单次上限 200)。 */
  async function collectPendingIds(): Promise<string[]> {
    const ids: string[] = [];
    let pageNo = 1;
    for (;;) {
      const data = demoMode
        ? demoMediaReviewQueuePage({ status: "needs_review", episodeId: episodeId || undefined, page: pageNo, pageSize: 50 })
        : await api.mediaReviewQueue(projectId, { status: "needs_review", episodeId: episodeId || undefined, page: pageNo, pageSize: 50 });
      ids.push(...data.items.map((item) => item.mediaResultId));
      if (ids.length >= data.total || data.items.length === 0) return ids;
      pageNo += 1;
    }
  }

  async function runDecisions(bodies: ReturnType<typeof approveDecisionBodies>): Promise<MediaReviewDecisionOutcome[]> {
    if (demoMode) return applyDemoReviewDecisions(bodies);
    const outcomes: MediaReviewDecisionOutcome[] = [];
    for (let index = 0; index < bodies.length; index += 200) {
      outcomes.push(...(await api.decideMediaReviews(projectId, bodies.slice(index, index + 200))).items);
    }
    return outcomes;
  }

  async function approveWholeEpisode(): Promise<void> {
    if (busy) return;
    setBusy("approve-all");
    try {
      const ids = await collectPendingIds();
      if (!ids.length) {
        notify("这一集没有待审核的产物", "info");
        return;
      }
      const outcomes = await runDecisions(approveDecisionBodies(ids));
      notify(decisionSummaryCopy(summarizeDecisionOutcomes(outcomes)), "success");
      queue.reload();
    } catch (reason) {
      notify(humanErrorMessage(reason, "批量通过失败"), "error");
    } finally {
      setBusy("");
    }
  }

  async function approveSingle(item: MediaReviewQueueItem): Promise<void> {
    if (busy) return;
    setBusy(item.mediaResultId);
    try {
      const outcomes = await runDecisions(approveDecisionBodies([item.mediaResultId]));
      notify(decisionSummaryCopy(summarizeDecisionOutcomes(outcomes)), "success");
      queue.reload();
    } catch (reason) {
      notify(humanErrorMessage(reason, "通过失败"), "error");
    } finally {
      setBusy("");
    }
  }

  function openReject(item: MediaReviewQueueItem): void {
    setRejectTarget(item);
    setRejectReason("");
    setRejectError("");
  }

  async function confirmReject(): Promise<void> {
    if (!rejectTarget || busy) return;
    /* 客户端先拦(与后端 mediaService 422 同口径),空理由不发请求。 */
    const errorText = rejectionReasonError(rejectReason);
    if (errorText) {
      setRejectError(errorText);
      return;
    }
    setBusy(rejectTarget.mediaResultId);
    try {
      const outcomes = await runDecisions([rejectDecisionBody(rejectTarget.mediaResultId, rejectReason)]);
      notify(decisionSummaryCopy(summarizeDecisionOutcomes(outcomes)), "success");
      setRejectTarget(null);
      setRejectReason("");
      setRejectError("");
      queue.reload();
    } catch (reason) {
      setRejectError(humanErrorMessage(reason, "拒绝失败，请重试"));
    } finally {
      setBusy("");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>产物审核队列</DialogTitle>
          <DialogDescription>审的是生成出来的图片与视频；通过后才能设主版本、进交付。资产审核（角色/场景）在资产页，是另一回事。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              剧集
              <select
                className="rounded-md border border-border-1 bg-surface-1 px-3 py-1.5 text-sm text-ink-1"
                value={episodeId}
                onChange={(event) => switchEpisode(event.target.value)}
                aria-label="选择剧集"
              >
                {episodes.map((episode) => (
                  <option key={episode.id} value={episode.id}>第 {episode.episode_no} 集</option>
                ))}
              </select>
            </label>
            <SegmentedTabs
              value={status}
              ariaLabel="审核状态"
              options={[
                { value: "needs_review", label: "待审核" },
                { value: "accepted", label: "已通过" },
                { value: "rejected", label: "已拒绝" },
              ]}
              onChange={switchStatus}
            />
          </div>
          {status === "needs_review" && canWrite && (queue.data?.total ?? 0) > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-2">
              <Button
                variant="primary"
                icon={<CheckCircle />}
                loading={busy === "approve-all"}
                onClick={() => void approveWholeEpisode()}
              >整集批量通过（{queue.data?.total ?? 0}）</Button>
              <span className="text-xs text-ink-2">一次通过本集全部待审核产物；已是终态的不会重复处理。</span>
            </div>
          ) : null}
          {queue.loading ? <LoadingState label="正在读取审核队列" /> : null}
          {!queue.loading && queue.error ? <ErrorState message={queue.error} onRetry={queue.reload} /> : null}
          {!queue.loading && !queue.error && queue.data ? (
            <ReviewQueueList
              items={queue.data.items}
              status={status}
              episodeNo={episodeNo}
              canWrite={canWrite}
              busy={busy}
              expandedId={expandedId}
              projectId={projectId}
              demoMode={demoMode}
              onApprove={(item) => void approveSingle(item)}
              onReject={openReject}
              onToggleTrail={(id) => setExpandedId((current) => (current === id ? null : id))}
            />
          ) : null}
          {queue.data && queue.data.total > PAGE_SIZE ? (
            <ListPager page={page} total={queue.data.total} onPageChange={setPage} itemNoun="条产物" ariaLabel="审核队列分页" pageSize={PAGE_SIZE} />
          ) : null}
        </DialogBody>
      </DialogContent>
      {rejectTarget ? (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) setRejectTarget(null); }}>
          <DialogContent size="small">
            <DialogHeader>
              <DialogTitle>拒绝素材 #{rejectTarget.shotCode} 的{rejectTarget.mediaKind === "video" ? "视频" : "图片"}</DialogTitle>
              <DialogDescription>拒绝后这条产物不能设为主版本，也不会进交付；理由会写进审核轨迹。</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-2">
              <Textarea
                className="min-h-24"
                autoFocus
                placeholder="写清楚哪里不行，例如：马蹄穿帮，这镜要重拍"
                value={rejectReason}
                onChange={(event) => { setRejectReason(event.target.value); if (rejectError) setRejectError(""); }}
              />
              {rejectError ? <p className="text-xs text-danger" role="alert">{rejectError}</p> : null}
            </DialogBody>
            <DialogFooter>
              <Button disabled={Boolean(busy)} onClick={() => setRejectTarget(null)}>取消</Button>
              <Button variant="danger" icon={<XCircle />} loading={busy === rejectTarget.mediaResultId} onClick={() => void confirmReject()}>确认拒绝</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Dialog>
  );
}

/* ---------- 队列列表(纯展示,可独立渲染断言) ---------- */

export function ReviewQueueList({ items, status, episodeNo, canWrite, busy, expandedId, projectId, demoMode, onApprove, onReject, onToggleTrail }: {
  items: MediaReviewQueueItem[];
  status: MediaReviewStatus;
  episodeNo?: number;
  canWrite: boolean;
  busy: string;
  expandedId: string | null;
  projectId: string;
  demoMode: boolean;
  onApprove: (item: MediaReviewQueueItem) => void;
  onReject: (item: MediaReviewQueueItem) => void;
  onToggleTrail: (mediaResultId: string) => void;
}): React.JSX.Element {
  if (!items.length) {
    return (
      <EmptyState
        title={status === "needs_review" ? "这一集没有待审核的产物" : status === "accepted" ? "还没有已通过的产物" : "还没有被拒绝的产物"}
        description={status === "needs_review"
          ? `第 ${episodeNo ?? "—"} 集生成的图片与视频通过后会进交付；没有待审项说明这一集都审完了。`
          : "切换上方状态页签可查看其他状态的产物。"}
        icon={<ClipboardText />}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2" aria-label="产物审核列表">
      {items.map((item) => (
        <article className="flex flex-col gap-2 rounded-md border border-border-1 bg-surface-1 px-3 py-2" key={item.mediaResultId}>
          <div className="flex flex-wrap items-center gap-2">
            <strong className="font-mono text-sm text-ink-1">素材 #{item.shotCode}</strong>
            <Badge tone="neutral">{item.mediaKind === "video" ? "视频" : "图片"}</Badge>
            {item.isPrimary ? <Badge tone="accent">主版本</Badge> : null}
            <ReviewStatusBadge status={item.reviewStatus} />
            <span className="ml-auto text-xs text-ink-4">
              {item.durationSeconds ? `${item.durationSeconds} 秒 · ` : ""}{item.createdAt ? formatDateTime(item.createdAt) : ""}
            </span>
          </div>
          {item.reviewStatus === "rejected" ? (
            <p className="text-xs text-danger">已拒绝的产物不能设为主版本，也不会进交付。</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {item.reviewStatus === "needs_review" && canWrite ? (
              <>
                <Button variant="primary" icon={<Check />} loading={busy === item.mediaResultId} onClick={() => onApprove(item)}>通过</Button>
                <Button variant="danger" icon={<XCircle />} disabled={Boolean(busy)} onClick={() => onReject(item)}>拒绝…</Button>
              </>
            ) : null}
            <button
              type="button"
              className="text-xs text-accent-text underline-offset-2 hover:underline"
              aria-expanded={expandedId === item.mediaResultId}
              onClick={() => onToggleTrail(item.mediaResultId)}
            >{expandedId === item.mediaResultId ? "收起轨迹" : "审核轨迹"}</button>
          </div>
          {expandedId === item.mediaResultId ? (
            <ReviewActionTrail projectId={projectId} mediaResultId={item.mediaResultId} demoMode={demoMode} />
          ) : null}
        </article>
      ))}
    </div>
  );
}

/* ---------- 单条产物的审核轨迹 ---------- */

function ReviewActionTrail({ projectId, mediaResultId, demoMode }: { projectId: string; mediaResultId: string; demoMode: boolean }): React.JSX.Element {
  const trail = useAsyncData<MediaReviewActionRecord[]>(
    async () => {
      if (demoMode) return demoMediaReviewActions(mediaResultId);
      return (await api.mediaReviewActions(projectId, mediaResultId)).items;
    },
    [demoMode, projectId, mediaResultId],
  );
  if (trail.loading) return <p className="text-xs text-ink-4">正在读取审核轨迹…</p>;
  if (trail.error) return <p className="text-xs text-danger">{trail.error}</p>;
  if (!trail.data?.length) return <p className="text-xs text-ink-4">还没有审核记录。</p>;
  return (
    <ul className="flex flex-col gap-1 rounded-md bg-surface-0 px-3 py-2" aria-label="审核轨迹">
      {trail.data.map((action) => (
        <li className="flex flex-wrap items-baseline gap-2 text-xs" key={action.id}>
          <Badge tone={action.toStatus === "rejected" ? "danger" : "success"}>{reviewActionLabel(action.action)}</Badge>
          <span className="text-ink-2">{action.reviewerDisplayName ?? (action.action === "auto_accepted" ? "系统" : "未留名")}</span>
          <span className="text-ink-4">{action.createdAt ? formatDateTime(action.createdAt) : ""}</span>
          {action.rejectionReason ? <span className="basis-full text-ink-1">理由:{action.rejectionReason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/* ============================================================
   弹窗二:交付本集(部分交付 + 交付历史)
   ============================================================ */

export interface EpisodeDeliveryModalProps {
  projectId: string;
  episode: Episode;
  /** 本集素材总数(「N/M 镜可交付」的分母)。 */
  totalShots: number;
  demoMode: boolean;
  canWrite: boolean;
  notify: PageRuntimeProps["notify"];
  onClose: () => void;
  /** 落账成功后回调(页面刷新已交付行 + 通知进度条)。 */
  onDelivered: () => void;
  initialTab?: "deliver" | "history";
}

interface DeliverableSummary {
  readyCount: number;
  gaps: DeliveryGap[];
}

export function EpisodeDeliveryModal({ projectId, episode, totalShots, demoMode, canWrite, notify, onClose, onDelivered, initialTab = "deliver" }: EpisodeDeliveryModalProps): React.JSX.Element {
  const [tab, setTab] = useState<"deliver" | "history">(initialTab);
  const [historyPage, setHistoryPage] = useState(1);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState("");
  const [revision, setRevision] = useState(0);

  const summary = useAsyncData<DeliverableSummary>(
    async () => {
      if (demoMode) {
        return { readyCount: demoReadyVideoIds(episode.id).length, gaps: demoDeliveryGaps(episode.id) };
      }
      /* partial=true:未交齐镜头随清单回来,而不是整体 409。 */
      const manifest = await api.episodeDeliverables(episode.id, true);
      const readyShots = new Set(manifest.items.filter((item) => item.media_kind === "video").map((item) => item.shot_code));
      return { readyCount: readyShots.size, gaps: Array.isArray(manifest.gaps) ? manifest.gaps : [] };
    },
    [demoMode, episode.id, revision],
  );

  const history = useAsyncData<DeliveryRecordPage>(
    () => demoMode
      ? Promise.resolve(demoDeliveriesPage(episode.id, historyPage, PAGE_SIZE))
      : api.episodeDeliveries(episode.id, historyPage, PAGE_SIZE),
    [demoMode, episode.id, historyPage, revision],
  );

  /* 交付人显示名:接口只有 user_id,按项目成员名册解析;已退出成员回落短 id(不编造)。 */
  const memberNames = useAsyncData<Record<string, string>>(
    async () => {
      if (demoMode) return { "demo-user": "Alice" };
      const members = await api.projectMembers(projectId);
      return Object.fromEntries(members.map((member) => [member.userId, member.displayName || member.username]));
    },
    [demoMode, projectId],
  );

  const gaps = summary.data?.gaps ?? [];
  const readyCount = summary.data?.readyCount ?? 0;
  const partial = gaps.length > 0;

  async function confirmDelivery(): Promise<void> {
    if (busy || !summary.data || readyCount === 0) return;
    setBusy("deliver");
    try {
      const record = demoMode
        ? createDemoDelivery(episode.id, { purpose })
        : await api.createEpisodeDelivery(episode.id, { purpose: purpose.trim() || null, partial });
      notify(
        record.partial
          ? `已落账：部分交付 ${record.mediaResultIds.length} 条产物，${record.missingShotCodes.length} 镜未交齐（第 ${record.missingShotCodes.join("、")} 镜）。`
          : `已落账：完整交付 ${record.mediaResultIds.length} 条产物。`,
        "success",
      );
      setPurpose("");
      setRevision((value) => value + 1);
      setTab("history");
      onDelivered();
    } catch (reason) {
      notify(humanErrorMessage(reason, "交付失败，请重试"), "error");
    } finally {
      setBusy("");
    }
  }

  async function download(kind: "csv" | "json"): Promise<void> {
    if (demoMode) {
      notify("离线演示不会下载真实文件", "info");
      return;
    }
    setBusy(kind);
    try {
      if (kind === "csv") await api.downloadEpisodeCsv(episode.id, partial);
      else await api.downloadEpisodeJson(episode.id, partial);
      notify("交付清单已开始下载", "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "下载失败，请重试"), "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>交付第 {episode.episode_no} 集</DialogTitle>
          <DialogDescription>交付会把当前主版本清单落账留痕；没通过的镜头可以后补交，记录都在交付历史里。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <SegmentedTabs
            value={tab}
            ariaLabel="交付视图"
            options={[
              { value: "deliver", label: "发起交付" },
              { value: "history", label: `交付历史${history.data?.total ? `（${history.data.total}）` : ""}` },
            ]}
            onChange={setTab}
          />
          {tab === "deliver" ? (
            <>
              {summary.loading ? <LoadingState label="正在核算本集可交付内容" /> : null}
              {!summary.loading && summary.error ? <ErrorState message={summary.error} onRetry={summary.reload} /> : null}
              {!summary.loading && !summary.error && summary.data ? (
                readyCount === 0 ? (
                  <EmptyState
                    title="本集还没有可交付的产物"
                    description="每镜需要已保存成功、且通过审核的视频主版本。先去生成视频并通过审核，再回来交付。"
                    icon={<PaperPlaneTilt />}
                  />
                ) : (
                  <div className="flex flex-col gap-3">
                    <DeliveryReadiness readyCount={readyCount} totalShots={totalShots} gaps={gaps} />
                    <label className="flex flex-col gap-1 text-sm text-ink-2">
                      交付用途（可选，会写进交付记录）
                      <input
                        className="rounded-md border border-border-1 bg-surface-1 px-3 py-2 text-sm text-ink-1"
                        placeholder="例如：送审样片 / 客户第 2 版"
                        value={purpose}
                        maxLength={1000}
                        onChange={(event) => setPurpose(event.target.value)}
                      />
                    </label>
                    {canWrite ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="primary"
                          icon={<PaperPlaneTilt />}
                          loading={busy === "deliver"}
                          onClick={() => void confirmDelivery()}
                        >{partial ? `先交已就绪的 ${readyCount} 镜（部分交付）` : "确认交付（完整交付）"}</Button>
                        <Button icon={<FileText />} loading={busy === "csv"} onClick={() => void download("csv")}>下载 CSV 清单</Button>
                        <Button icon={<BracketsCurly />} loading={busy === "json"} onClick={() => void download("json")}>下载 JSON 清单</Button>
                      </div>
                    ) : (
                      <p className="text-xs text-ink-2">当前角色只读，交付需要项目成员权限。</p>
                    )}
                  </div>
                )
              ) : null}
            </>
          ) : (
            <>
              {history.loading ? <LoadingState label="正在读取交付历史" /> : null}
              {!history.loading && history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : null}
              {!history.loading && !history.error && history.data ? (
                <DeliveryHistoryTable records={history.data.items} memberNames={memberNames.data ?? {}} />
              ) : null}
              {history.data && history.data.total > PAGE_SIZE ? (
                <ListPager page={historyPage} total={history.data.total} onPageChange={setHistoryPage} itemNoun="次交付" ariaLabel="交付历史分页" pageSize={PAGE_SIZE} />
              ) : null}
            </>
          )}
        </DialogBody>
        {tab === "deliver" ? (
          <DialogFooter>
            <span className="mr-auto text-xs text-ink-4">交付不会重复扣积分；内容不变时两次交付的内容指纹相同。</span>
            <Button icon={<ArrowClockwise />} onClick={summary.reload}>重新核算</Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ---------- 交付前核算(可交付数 + 未交齐清单;纯展示,可独立渲染断言) ---------- */

export function DeliveryReadiness({ readyCount, totalShots, gaps }: DeliverableSummary & { totalShots: number }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-3" aria-label="交付前核算">
      <div className="flex flex-wrap items-center gap-2">
        <CheckCircle className="size-4 text-success" aria-hidden="true" />
        <strong className="text-sm text-ink-1">{readyCount} / {totalShots} 镜可交付</strong>
        {gaps.length ? <Badge tone="warning">部分交付</Badge> : <Badge tone="success">可以完整交付</Badge>}
      </div>
      {gaps.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-ink-2">这几镜还没交齐，本次会先交其余 {readyCount} 镜：</p>
          <DeliveryGapList gaps={gaps} />
        </div>
      ) : (
        <p className="text-xs text-ink-2">本集每镜都有通过审核的视频主版本，可以一次交齐。</p>
      )}
    </section>
  );
}

/** 未交齐镜头清单:哪镜差、差在哪(与后端 gap reason 一一对应)。 */
export function DeliveryGapList({ gaps }: { gaps: DeliveryGap[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1" aria-label="未交齐镜头">
      {gaps.map((gap) => (
        <li className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs" key={gap.shotId}>
          <WarningCircle className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <strong className="font-mono text-ink-1">素材 #{gap.shotCode}</strong>
          <span className="text-ink-2">{gapReasonLabel(gap.reason)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- 交付历史表(纯展示,可独立渲染断言) ---------- */

export function DeliveryHistoryTable({ records, memberNames }: { records: DeliveryRecord[]; memberNames: Record<string, string> }): React.JSX.Element {
  if (!records.length) {
    return <EmptyState title="本集还没有交付记录" description="每次交付都会落账留痕：时间、范围、谁交付、哪些镜未交齐。" icon={<PaperPlaneTilt />} />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-border-1 text-ink-2">
            <th className="py-2 pr-3 font-medium">时间</th>
            <th className="py-2 pr-3 font-medium">范围</th>
            <th className="py-2 pr-3 font-medium">未交齐</th>
            <th className="py-2 pr-3 font-medium">用途</th>
            <th className="py-2 pr-3 font-medium">交付人</th>
            <th className="py-2 font-medium">内容指纹</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr className="border-b border-border-1/60 align-top" key={record.id}>
              <td className="py-2 pr-3 whitespace-nowrap text-ink-1">{record.createdAt ? formatDateTime(record.createdAt) : "—"}</td>
              <td className="py-2 pr-3">
                <Badge tone={record.partial ? "warning" : "success"}>{deliveryScopeLabel(record.partial)}</Badge>
                <span className="ml-1 text-ink-2">{record.mediaResultIds.length} 条产物</span>
              </td>
              <td className="py-2 pr-3 text-ink-2">{record.missingShotCodes.length ? `第 ${record.missingShotCodes.join("、")} 镜` : "无"}</td>
              <td className="py-2 pr-3 text-ink-2">{record.purpose || "—"}</td>
              <td className="py-2 pr-3 text-ink-2" title={record.deliveredByUserId}>{memberNames[record.deliveredByUserId] ?? "已退出的成员"}</td>
              <td className="py-2 font-mono text-ink-4" title={record.manifestHash}>{shortManifestHash(record.manifestHash)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

