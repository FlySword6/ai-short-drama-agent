/* ============================================================
   consumption-records.tsx — 消耗逐笔明细表（E 包，对标 LibTV 积分明细页）

   筛选（日期范围/任务类型/模型）+ 服务端真分页（复用 ListPager）+ 「下载明细」CSV；
   真栈合同端点 404/501 时降级示例数据并在底部明示一次（不逐行标）。
   S9 P0-3：筛选与分页全量透传服务端（原 page_size:500 拉全量被后端 zod max(100) 拒为 400）。
   ============================================================ */

import { ArrowClockwise, Copy, DownloadSimple, Info } from "@phosphor-icons/react";
import * as React from "react";
import { useEffect, useState } from "react";

import {
  CONSUMPTION_PAGE_SIZE,
  consumptionRecordsCsv,
  listAllConsumptionRecords,
  listConsumptionRecords,
  taskTypeLabel,
  type ConsumptionRecordsPageResult,
  type ConsumptionTaskType,
} from "../consumption-records";
import { modelDisplayLabel, modelRawTitle } from "../display-labels";
import { businessErrorMessage } from "../error-copy";
import { ListPager, type PageRuntimeProps } from "../pages/global-pages";
import { Button } from "./ui/button";
import { Input, Skeleton } from "./ui/primitives";
import { cn } from "./ui/cn";

const selectClass = "rounded-sm border border-border-1 bg-surface-1 px-2 py-1 text-xs text-ink-1 outline-none transition-colors hover:border-border-2 focus-visible:ring-2 focus-visible:ring-accent";

interface PanelQuery {
  from: string;
  to: string;
  taskType: ConsumptionTaskType | "";
  model: string;
  page: number;
}

const INITIAL_QUERY: PanelQuery = { from: "", to: "", taskType: "", model: "", page: 1 };

function formatTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 任务 ID 复制按钮：复制成功短暂变勾。 */
function CopyTaskId({ taskId, notify }: { taskId: string; notify: PageRuntimeProps["notify"] }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-sm font-mono text-[11px] text-ink-2 outline-none transition-colors hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent"
      title="复制任务 ID"
      onClick={() => {
        void navigator.clipboard?.writeText(taskId).then(() => {
          setCopied(true);
        }).catch(() => notify("复制失败，请手动选择复制", "info"));
      }}
    >{copied ? "已复制" : taskId}<Copy aria-hidden="true" className="size-3 shrink-0" /></button>
  );
}

export function ConsumptionRecordsPanel({ projectId, demoMode, notify }: { projectId: string; demoMode: boolean; notify: PageRuntimeProps["notify"] }): React.JSX.Element {
  const [pageData, setPageData] = useState<ConsumptionRecordsPageResult | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState<PanelQuery>(INITIAL_QUERY);
  /* 模型下拉候选：从已拉取页累积（无全量模型接口，只展示真实见过的型号，不虚构选项）。 */
  const [models, setModels] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);

  /* 筛选变更与翻页同一状态对象原子更新（筛选变化即回第 1 页），本 effect 唯一拉取入口。 */
  useEffect(() => {
    let cancelled = false;
    setError("");
    listConsumptionRecords(projectId, demoMode, query)
      .then((result) => {
        if (cancelled) return;
        setPageData(result);
        setModels((current) => [...new Set([...current, ...result.records.map((record) => record.model_display_name)])]);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(businessErrorMessage(reason, "明细读取失败，请重试"));
      });
    return () => { cancelled = true; };
  }, [projectId, demoMode, revision, query]);

  function updateFilters(patch: Partial<Omit<PanelQuery, "page">>): void {
    setQuery((current) => ({ ...current, ...patch, page: 1 }));
  }

  /** CSV 导出按当前筛选拉全量（分页循环，每页 100=后端上限），不是只导当前页。 */
  async function downloadCsv(): Promise<void> {
    setExporting(true);
    try {
      const { records } = await listAllConsumptionRecords(projectId, demoMode, query);
      if (records.length === 0) {
        notify("当前筛选没有可导出的明细", "info");
        return;
      }
      const blob = new Blob([consumptionRecordsCsv(records)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `消耗明细-${projectId}-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      notify(businessErrorMessage(reason, "明细导出失败，请重试"), "error");
    } finally {
      setExporting(false);
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-danger/50 bg-danger/10 px-4 py-3 text-xs text-danger" role="alert">
        <span>{error}</span>
        <Button size="sm" variant="outline" icon={<ArrowClockwise />} onClick={() => setRevision((value) => value + 1)}>重试</Button>
      </div>
    );
  }

  const hasActiveFilter = Boolean(query.from || query.to || query.taskType || query.model);

  return (
    <div className="flex flex-col gap-3">
      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <label className="inline-flex items-center gap-1">从
          <Input type="date" aria-label="起始日期" className="h-7 w-[136px] px-2 text-xs" value={query.from} onChange={(event) => updateFilters({ from: event.target.value })} />
        </label>
        <label className="inline-flex items-center gap-1">到
          <Input type="date" aria-label="截止日期" className="h-7 w-[136px] px-2 text-xs" value={query.to} onChange={(event) => updateFilters({ to: event.target.value })} />
        </label>
        <select aria-label="任务类型" className={selectClass} value={query.taskType} onChange={(event) => updateFilters({ taskType: event.target.value as ConsumptionTaskType | "" })}>
          <option value="">全部类型</option>
          <option value="image">图片生成</option>
          <option value="video">视频生成</option>
          <option value="other">其他</option>
        </select>
        <select aria-label="模型" className={selectClass} value={query.model} onChange={(event) => updateFilters({ model: event.target.value })}>
          <option value="">全部模型</option>
          {models.map((model) => <option key={model} value={model} title={modelRawTitle(model)}>{modelDisplayLabel(model)}</option>)}
        </select>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-ink-4">{pageData?.total ?? 0} 笔</span>
          <Button size="sm" variant="outline" icon={<DownloadSimple />} loading={exporting} disabled={!pageData || pageData.total === 0} title="按当前筛选拉全量导出 CSV" onClick={() => void downloadCsv()}>下载明细</Button>
        </span>
      </div>

      {/* 明细表 */}
      <div className="overflow-x-auto rounded-md border border-border-1">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border-1 bg-surface-2 text-ink-4">
              <th className="px-3 py-2 font-medium">消耗时间</th>
              <th className="px-3 py-2 font-medium">任务类型</th>
              <th className="px-3 py-2 font-medium">模型</th>
              <th className="px-3 py-2 font-medium">集</th>
              <th className="px-3 py-2 font-medium">任务详情</th>
              <th className="px-3 py-2 font-medium">任务 ID</th>
              <th className="px-3 py-2 text-right font-medium">消耗积分</th>
            </tr>
          </thead>
          <tbody>
            {pageData === null ? (
              /* S7-14：明细表骨架行（原来是「正在读取明细…」空白等待） */
              Array.from({ length: 6 }, (_, index) => (
                <tr className="border-b border-border-1 last:border-b-0" key={`sk-row-${index}`}>
                  <td className="px-3 py-2.5" colSpan={7}><Skeleton className="h-4 w-full" /></td>
                </tr>
              ))
            ) : pageData.records.length === 0 ? (
              <tr><td className="px-3 py-6 text-center text-ink-4" colSpan={7}>{hasActiveFilter ? "筛选范围内没有明细，放宽条件试试" : "还没有消耗明细"}</td></tr>
            ) : pageData.records.map((record) => (
              <tr key={record.task_id} className="border-b border-border-1 last:border-b-0 hover:bg-surface-2/60">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-ink-2">{formatTime(record.created_at)}</td>
                <td className="px-3 py-2 text-ink-1">{taskTypeLabel(record.task_type)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-ink-2" title={modelRawTitle(record.model_display_name)}>{modelDisplayLabel(record.model_display_name)}</td>
                <td className="px-3 py-2 text-ink-2">{record.episode_no === null ? "—" : `第 ${record.episode_no} 集`}</td>
                <td className="max-w-[280px] truncate px-3 py-2 text-ink-2" title={record.prompt_excerpt}>{record.prompt_excerpt || "—"}</td>
                <td className="px-3 py-2"><CopyTaskId taskId={record.task_id} notify={notify} /></td>
                <td className={cn("px-3 py-2 text-right font-mono", record.task_type === "video" ? "text-ink-1" : "text-ink-2")}>{record.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 服务端真分页（单页时 ListPager 整体隐藏）+ 降级说明（一条，不逐行标） */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
        {pageData ? (
          <ListPager
            page={pageData.page}
            total={pageData.total}
            onPageChange={(page) => setQuery((current) => ({ ...current, page }))}
            itemNoun="笔"
            ariaLabel="消耗明细分页"
            pageSize={CONSUMPTION_PAGE_SIZE}
          />
        ) : null}
        {pageData?.degraded ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-4">
            <Info aria-hidden="true" className="size-3.5" />{demoMode ? "离线演示：明细为示例数据" : "当前为示例数据，明细接入后自动替换"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
