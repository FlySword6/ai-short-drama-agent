/* ============================================================
   queue-page.tsx — 生产队列页(批次一卡 1 落地版,卡 4 深化四态样式)

   原型基准:Figma P-10(rail 队列项落点;「任务在后台跑,你可以先去干别的」;
   失败行给下一步)。取数:queue-inflight 换源点(本地生成在途+上传活跃任务);
   demo=原型四行示例。接缝 6 服务端在途端点落地后由 queue-inflight 换源。
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { GenerationQuoteWithTier } from "../api";
import type { AssetUploadTask, FailedGenerationTask, GenerationInFlight } from "../types";
import { countLocalInflight, useInFlightCount, useInFlightGenerations } from "../queue-inflight";
import { EmptyState } from "../components/ui/primitives";
import { quoteIsExpired } from "../generation-quotes";
import { businessErrorMessage } from "../error-copy";
import { navigate, productionViewPath, projectAssetsPath, sceneWorkbenchPath } from "../routing";
import { newId } from "../uuid";
import type { PageRuntimeProps } from "./global-pages";

interface QueueRow {
  id: string;
  title: string;
  statusLabel: string;
  tone: "queued" | "running" | "failed" | "done";
  hint?: string;
  /** 完成态缩略=交付段首帧(SPEC 修正单 2026-08-01):有首帧 url 时渲染 img,
     无则内容井(不放假图);demo 完成行暂无产物数据,井展示+此位待绑定。 */
  frameUrl?: string | null;
  action?: { label: string; onClick: () => void };
}

const DEMO_ROWS: QueueRow[] = [
  { id: "d1", title: "1-5 · 天台对峙", statusLabel: "排队中 · 第 1 位", tone: "queued" },
  { id: "d2", title: "1-4 · 巷口追逐", statusLabel: "生成中 · 预计约 3 分钟", tone: "running" },
  { id: "d3", title: "角色定妆 · 白发师父", statusLabel: "需要处理 · 已失败", tone: "failed", hint: "供应商拒绝:参考图尺寸不合规", action: { label: "改参考图重试", onClick: () => undefined } },
  { id: "d4", title: "1-3 · 雨中追逐", statusLabel: "最近完成 · 整段已交付", tone: "done", frameUrl: null },
];

function uploadRow(task: AssetUploadTask, onGoAssets: () => void): QueueRow {
  if (task.status === "queued") {
    return {
      id: task.id,
      title: `上传入库 · ${task.original_file_name}`,
      statusLabel: task.queue_position != null ? `排队中 · 第 ${task.queue_position} 位` : "排队中",
      tone: "queued",
    };
  }
  return {
    id: task.id,
    title: `上传入库 · ${task.original_file_name}`,
    statusLabel: "处理中",
    tone: "running",
    action: { label: "去资产中心看看", onClick: onGoAssets },
  };
}

function generationMediaKindLabel(kind: string): string {
  if (kind === "video") return "视频";
  if (kind === "image") return "图片";
  if (kind === "audio") return "音频";
  return kind;
}

/** 生成在途行(in-flight 冻结信封):排队位次/预计时长都来自端点,无样本不编造。 */
function generationRow(item: GenerationInFlight): QueueRow {
  const kind = generationMediaKindLabel(item.media_kind);
  const estimated = typeof item.estimated_duration_seconds === "number" && item.estimated_duration_seconds > 0
    ? `预计约 ${Math.max(1, Math.round(item.estimated_duration_seconds / 60))} 分钟`
    : "";
  if (item.status === "queued") {
    return {
      id: item.generation_request_id,
      title: `${kind}生成`,
      statusLabel: item.queue_position != null ? `排队中 · 第 ${item.queue_position} 位` : "排队中",
      tone: "queued",
    };
  }
  return {
    id: item.generation_request_id,
    title: `${kind}生成`,
    statusLabel: estimated ? `生成中 · ${estimated}` : "生成中",
    tone: "running",
  };
}

const toneClass: Record<QueueRow["tone"], string> = {
  queued: "text-ink-2",
  running: "text-accent-text",
  failed: "text-danger",
  done: "text-ink-3",
};

function QueueRowView({ row }: { row: QueueRow }): React.JSX.Element {
  return (
    <li className="flex items-center gap-3 rounded-xl bg-surface-1 px-4 py-3">
      {/* thumb 内容井(L3 媒体井):完成态有首帧渲染 img,其余井态(明度分层,无框)。 */}
      <span className="flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-well" aria-hidden="true">
        {row.frameUrl ? <img className="h-full w-full object-cover" src={row.frameUrl} alt="" loading="lazy" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="truncate text-sm text-ink-1">{row.title}</strong>
        <span className={`text-xs ${toneClass[row.tone]}`}>{row.statusLabel}</span>
        {row.hint ? <span className="text-xs text-ink-3">{row.hint}</span> : null}
      </span>
      {row.action ? (
        <button
          type="button"
          onClick={row.action.onClick}
          className="rounded-md bg-surface-2 px-3 py-1.5 text-xs text-ink-1 transition-colors hover:bg-surface-2/70"
        >
          {row.action.label}
        </button>
      ) : null}
    </li>
  );
}

/* ---------- P-10 失败区(合同 sol-failed-tasks-shape-20260803)----------
   失败行常驻可回访(ack 独立,通知已读不丢行);PRD 冻结句「失败行必给下一步动作」:
   双动作=「重新报价重试」(报价→人工确认→提交,两次点击合付费红线,幂等键防重)
   +「回工作台处理」(场级工作台/项目资产页/生产页按归属字段降级)。 */

/** 失败行归属跳转:场镜失败回 P-04 场级工作台;资产定妆类回项目资产页;其余落生产页。 */
function failedTaskWorkbenchPath(task: FailedGenerationTask): string {
  if (task.scene_id && task.episode_id) return sceneWorkbenchPath(task.project_id, task.episode_id, task.scene_id);
  if (task.target_asset_entity_id) return projectAssetsPath(task.project_id);
  return productionViewPath(task.project_id);
}

function FailedTaskRow({ task, notify, onRetried }: { task: FailedGenerationTask; notify: PageRuntimeProps["notify"]; onRetried: () => void }): React.JSX.Element {
  const [quote, setQuote] = useState<GenerationQuoteWithTier | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const kind = generationMediaKindLabel(task.media_kind);

  /** 第一步「重新报价」:只取报价不提交,金额上屏后由人再点一次确认(付费红线)。 */
  async function startQuote(): Promise<void> {
    if (quoting || submitting) return;
    setQuoting(true);
    try {
      const next = await api.quoteGenerationRetry(task.generation_request_id);
      if (quoteIsExpired(next)) {
        notify("报价已过期，请重新获取", "info");
        return;
      }
      setQuote(next);
    } catch (reason) {
      notify(businessErrorMessage(reason, "重新报价失败，请稍后再试"), "error");
    } finally {
      setQuoting(false);
    }
  }

  /** 第二步「确认重试」:confirm(幂等防重)+retry 提交;成功后失败区与在途区双刷新。 */
  async function confirmRetry(): Promise<void> {
    if (!quote || submitting) return;
    setSubmitting(true);
    try {
      const confirmed = await api.confirmGenerationQuote(quote.generation_quote_id);
      if (confirmed.status === "consumed") {
        notify("这次确认已经提交过，不会重复扣费", "info");
        setQuote(null);
        onRetried();
        return;
      }
      await api.retryGeneration(task.generation_request_id, quote.generation_quote_id, `retry-${task.generation_request_id}-${newId()}`);
      notify("已重新提交，回到队列排队", "success");
      setQuote(null);
      onRetried();
    } catch (reason) {
      notify(businessErrorMessage(reason, "重试提交失败，请稍后再试"), "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-xl bg-surface-1 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-well" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="truncate text-sm text-ink-1">{kind}生成{task.attempt_no != null && task.attempt_no > 1 ? ` · 第 ${task.attempt_no} 次尝试` : ""}</strong>
          <span className="text-xs text-danger">需要处理 · 已失败</span>
          {task.display_reason ? <span className="text-xs text-ink-3">{task.display_reason}</span> : null}
        </span>
      </div>
      {quote ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-well px-3 py-2">
          <span className="text-xs text-ink-1">本次重试约 ¥{(quote.estimated_cost_fen / 100).toFixed(2)}</span>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void confirmRetry()}
            className="rounded-md bg-accent px-3 py-1.5 text-xs text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {submitting ? "提交中…" : "确认重试"}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setQuote(null)}
            className="rounded-md px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-2"
          >
            取消
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {task.retryable !== false ? (
            <button
              type="button"
              disabled={quoting}
              onClick={() => void startQuote()}
              className="rounded-md bg-surface-2 px-3 py-1.5 text-xs text-ink-1 transition-colors hover:bg-surface-2/70 disabled:opacity-60"
            >
              {quoting ? "报价中…" : "重新报价重试"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => navigate(failedTaskWorkbenchPath(task))}
            className="rounded-md px-3 py-1.5 text-xs text-accent-text transition-colors hover:bg-surface-2"
          >
            回工作台处理
          </button>
        </div>
      )}
    </li>
  );
}

export function QueuePage({ demoMode, notify }: PageRuntimeProps): React.JSX.Element {
  const inflight = useInFlightCount(demoMode);
  const generations = useInFlightGenerations(demoMode);
  const [uploadRows, setUploadRows] = useState<QueueRow[]>([]);
  const [localInflight, setLocalInflight] = useState(0);
  /* P-10 失败区:独立取数(ack 独立,重试后自动移出);读取失败不挡在途区,静默留旧行。 */
  const [failedTasks, setFailedTasks] = useState<FailedGenerationTask[]>([]);

  const loadFailed = useCallback(async () => {
    try {
      const result = await api.generationsFailed({ pageSize: 24 });
      setFailedTasks(result.items);
    } catch { /* 失败区读不到不冒充清空,也不在每次挂载弹错误 */ }
  }, []);

  const load = useCallback(async () => {
    setLocalInflight(countLocalInflight(window.localStorage));
    try {
      const list = await api.assetUploadTasks();
      setUploadRows(list.items
        .filter((task) => task.status === "queued" || task.status === "processing")
        .map((task) => uploadRow(task, () => { window.location.assign("/assets?tab=ingest"); })));
    } catch {
      notify("队列信息暂时读不到,稍后再试", "error");
    }
  }, [notify]);

  useEffect(() => {
    if (demoMode) return;
    void load();
    void loadFailed();
  }, [demoMode, load, loadFailed]);

  /** 重试提交成功:失败区重拉(该行最新 attempt 已转在途自动移出)+在途区同步刷新。 */
  const handleRetried = () => {
    void loadFailed();
    generations.retry();
  };

  /* 生成在途(服务端序=等待最久优先)在前,上传活跃在后;demo=原型四行示例。 */
  const rows = demoMode ? DEMO_ROWS : [...generations.items.map(generationRow), ...uploadRows];

  return (
    /* SPEC P-10:页面=左说明区+右 360 队列面板(浮右)。 */
    <div className="flex w-full items-start justify-end gap-8">
      <div className="flex max-w-md flex-1 flex-col gap-2 pt-2">
        <h1 className="text-xl font-semibold text-ink-1">生产队列</h1>
        <p className="text-sm text-ink-2">
          {inflight.count != null && inflight.count > 0 ? `${inflight.count} 个任务在途。` : ""}任务在后台跑,你可以先去干别的。
        </p>
        {!demoMode && localInflight > 0 ? (
          <p className="text-xs text-ink-3">本机还有 {localInflight} 个生成任务在途,回到对应工作台会自动续上。</p>
        ) : null}
        {demoMode ? <p className="text-xs text-ink-3">示例队列,仅演示四态展示。</p> : null}
      </div>
      <aside aria-label="全局生产队列" className="flex w-[360px] shrink-0 flex-col gap-2">
        {!demoMode && failedTasks.length > 0 ? (
          <section aria-label="需要处理的失败任务" className="flex flex-col gap-2">
            <span className="text-xs font-medium text-danger">需要处理 · {failedTasks.length} 个失败任务</span>
            <ul className="flex flex-col gap-2">
              {failedTasks.map((task) => <FailedTaskRow key={task.generation_request_id} task={task} notify={notify} onRetried={handleRetried} />)}
            </ul>
          </section>
        ) : null}
        {rows.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => <QueueRowView key={row.id} row={row} />)}
          </ul>
        ) : failedTasks.length === 0 || demoMode ? (
          <EmptyState
            title="队列空了"
            description="没有在途任务。去项目管理继续你的戏,新的生成会出现在这里。"
          />
        ) : null}
      </aside>
    </div>
  );
}
