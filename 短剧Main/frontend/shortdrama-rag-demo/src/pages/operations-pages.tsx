/* ============================================================
   operations-pages.tsx — 运营群：数据看板 / 项目消耗 / 回收站 / 本集连播
   视图层已迁 Tailwind v4 + components/ui（Card/Badge/Button/Dialog/状态件），
   旧板09样式表已随迁移删除；聚合与口径逻辑全部在 ../cost-board，
   单位文案只走 ../cost-units token，页面不写死单位字样。
   ============================================================ */
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  BracketsCurly,
  CalendarBlank,
  ChartBar,
  CheckCircle,
  Coins,
  Calculator,
  DownloadSimple,
  FileText,
  FilmStrip,
  FolderSimple,
  ImageSquare,
  Info,
  Play,
  Sparkle,
  Trash,
  Users,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";
import * as React from "react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { pageCount, paginateItems } from "../components/asset-shared";
import { HelpHint } from "../components/asset-widgets";
import { ConsumptionRecordsPanel } from "../components/consumption-records";
import { DemoExportPreviewDialog, type DemoExportKind } from "../components/demo-export-preview";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  LoadingState,
  Tabs,
  TabsList,
  TabsTrigger,
} from "../components/ui/primitives";
import {
  aggregateHasNoConsumption,
  buildAggregateDayBars,
  buildDateBars,
  globalTotalCards,
  mapGlobalDateCosts,
  resolveUserCostRows,
  sumUserCostRows,
  type CostBarRow,
  type CostTotalCards,
  type UserCostResolution,
} from "../cost-board";
import { COST_UNIT_LABEL, formatCredits, formatCreditsWithUnit } from "../cost-units";
import { demoDashboard, demoProjects, demoTrash } from "../demo";
import { demoEpisodePlayback } from "../demo-delivery";
import { modelDisplayLabel, modelRawTitle } from "../display-labels";
import { businessErrorMessage } from "../error-copy";
import {
  canSeeProjectCosts,
  demoProjectCostsPage,
  forbiddenMessage,
  PROJECT_COST_GROUP_BY_LABEL,
  type CostAggregatePage,
  type ProjectCostGroupBy,
} from "../operations";
import { navigate, projectStoryboardPath } from "../routing";
import { CapabilityCheckingPage, CapabilityUnavailablePage } from "../components/capability-notice";
import type { DeliverableItem, TrashItem } from "../types";
import { StatusBadge, formatDateTime, useResource } from "../ui";
import { humanErrorMessage } from "./batch-generate-drawer";
import { ListPager, type PageRuntimeProps } from "./global-pages";

/** 页面外壳：与旧 content-page 同宽同节奏（max 1200 / 纵向 gap-5）。 */
const PAGE_SHELL = "mx-auto flex w-full max-w-[1920px] flex-col gap-5"; /* S9-12 生产型页面放开限宽 */

/* F：ECharts 按需分包——看板首屏不背图表库体积（暗色主题见 cost-charts.tsx） */
const CostTrendChart = lazy(() => import("../components/cost-charts").then((module) => ({ default: module.CostTrendChart })));
const ProjectRankChart = lazy(() => import("../components/cost-charts").then((module) => ({ default: module.ProjectRankChart })));
const CostShareChart = lazy(() => import("../components/cost-charts").then((module) => ({ default: module.CostShareChart })));
const chartFallback = <div className="h-[220px] w-full animate-pulse rounded-md bg-surface-2" aria-hidden="true" />;

export function DashboardPage({ demoMode }: PageRuntimeProps): React.JSX.Element {
  const state = useResource(() => api.dashboardSummary(), demoDashboard, demoMode, []);
  const dashboard = state.data;
  if (state.loading) return <LoadingState label="正在汇总生产数据" onRetry={state.retry} />;
  if (state.error || !dashboard) return <ErrorState message={humanErrorMessage(state.error, "看板数据不存在")} onRetry={state.retry} />;
  const { data, costs } = dashboard;
  const cards = globalTotalCards(costs);
  const userResolution = resolveUserCostRows(costs);
  const dateBars = buildDateBars(mapGlobalDateCosts(costs.by_date));
  const statusRows: Array<[string, number]> = [
    ["已完成", costs.succeeded_tasks],
    ["进行中", costs.active_tasks],
    ["失败", costs.failed_tasks],
    ["总任务", costs.total_tasks],
  ];
  return (
    <section className={PAGE_SHELL}>
      <PageHeader
        title="数据看板"
        description="汇总当前账号可见的项目、资产、生成任务和预估消耗。"
        actions={<Button icon={<ArrowClockwise />} onClick={state.retry}>刷新数据</Button>}
      />
      <CostNotice notice={costs.notice} demoNote={demoMode ? "当前为离线示例，不会读取或写入服务。" : null} />
      <CostTotalCardsRow cards={cards} tasksNote={`${costs.total_tasks} 次任务`} otherGapNote="「其他」类消耗暂未单独汇总" />
      <section className={METRICS_GRID} aria-label="生产数据摘要">
        <MetricCard label="项目" value={data.projects} note={`${data.episodes} 集`} tone="neutral" />
        <MetricCard label="粗剪素材" value={data.shots} note={`${data.assets} 个可见资产`} tone="info" />
        <MetricCard label="图片结果" value={data.images} note={`任务成功 ${data.succeeded} 次 · 失败 ${data.failed} 次`} tone="blue" />
        <MetricCard label="视频结果" value={data.videos} note={`任务成功 ${data.succeeded} 次 · 失败 ${data.failed} 次`} tone="green" />
      </section>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <OpsPanel title="消耗结构" description={`图片 / 视频 / 其他占比 · 单位：${COST_UNIT_LABEL}`} icon={<ChartBar />}>
            <Suspense fallback={chartFallback}>
              <CostShareChart imageFen={cards.imageFen} videoFen={cards.videoFen} otherFen={cards.otherFen} unitLabel={COST_UNIT_LABEL} />
            </Suspense>
            {cards.imageFen === null && cards.videoFen === null && cards.otherFen === null ? (
              <EmptyState title="还没有消耗记录" description="提交真实生成任务后会在这里汇总。" />
            ) : null}
          </OpsPanel>
          <OpsPanel title="按日期消耗" description={`全部项目的预估消耗按天汇总 · 单位：${COST_UNIT_LABEL}`} icon={<CalendarBlank />}>
            {dateBars && dateBars.length > 0 ? (
              <Suspense fallback={chartFallback}>
                <CostTrendChart rows={dateBars} unitLabel={COST_UNIT_LABEL} />
              </Suspense>
            ) : (
              <EmptyState title="还没有日期数据" description="生成任务产生后会按天汇总。" icon={<CalendarBlank />} />
            )}
          </OpsPanel>
        </div>
        <OpsPanel title="项目消耗排行" description={`按全部生成尝试的预估消耗统计 · 点击条形进项目消耗页 · 单位：${COST_UNIT_LABEL}`} icon={<ChartBar />}>
          {costs.by_project.length === 0 ? <EmptyState title="还没有消耗记录" description="提交真实生成任务后会在这里汇总。" /> : (
            <Suspense fallback={chartFallback}>
              <ProjectRankChart items={costs.by_project} unitLabel={COST_UNIT_LABEL} onOpenProject={(id) => navigate(`/projects/${id}/costs`)} />
            </Suspense>
          )}
        </OpsPanel>
        <OpsPanel title="任务状态" description="所有尝试均计入任务数" icon={<CheckCircle />}>
          <dl className="m-0 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {statusRows.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 rounded-md bg-surface-0 px-3 py-2">
                <dt className="text-xs text-ink-4">{label}</dt>
                <dd className="m-0 font-mono text-lg text-ink-1">{value}</dd>
              </div>
            ))}
          </dl>
        </OpsPanel>
        <OpsPanel title="参与用户" description="当前账号可见项目的全局口径" icon={<Users />}>
          <CostByUserTable resolution={userResolution} globalScopeNote="当前账号可见项目的全局汇总口径；全局未拆分「其他」与实际消耗，对应列显示 —。" />
        </OpsPanel>
      </div>
    </section>
  );
}

/* ---------- S12-4：项目消耗页(viewer 不可见整页人话;取数=GET /projects/:id/costs) ----------
   S75 契约迁移(方案 A):本页整体切到 operations 聚合契约——
   GET /projects/:id/costs?group_by=day|member|model 三视图(按日期/按成员/按模型),
   总计卡取服务端 totals(已计价合计/笔数/未计价笔数),未计价如实标注;
   「按集」视图随旧契约下线;逐笔明细仍走 consumption records 面板(未动)。 */

export interface ProjectCostPages {
  day: CostAggregatePage;
  member: CostAggregatePage;
  model: CostAggregatePage;
  projectName: string;
}

export function ProjectCostsPage({ projectId, demoMode, notify, capabilities }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  /* S12-4/件 6：viewer 默认看不到成本（合同矩阵 viewer ✗）——整页人话，不抛错误码。
     前置两态各自出页：还在读不下结论，读不到就说读不到（都不是「你不可见」）。 */
  if (capabilities.status === "loading") return <section className={PAGE_SHELL}><CapabilityCheckingPage /></section>;
  if (capabilities.status === "unavailable") return <section className={PAGE_SHELL}><CapabilityUnavailablePage onRetry={capabilities.reload} /></section>;
  if (!canSeeProjectCosts(capabilities.capabilities, projectId)) {
    return (
      <section className={PAGE_SHELL}>
        <EmptyState title="成本视图仅查看不可见" description={forbiddenMessage("cost")} />
      </section>
    );
  }
  /* S75：三视图并行拉聚合契约；项目名单独拉，失败不拖垮整页（页头降级为通用名）。 */
  const demoPages = useMemo<ProjectCostPages>(() => ({
    day: demoProjectCostsPage(projectId, "day"),
    member: demoProjectCostsPage(projectId, "member"),
    model: demoProjectCostsPage(projectId, "model"),
    projectName: demoProjects.find((item) => item.id === projectId)?.name ?? "",
  }), [projectId]);
  const state = useResource<ProjectCostPages>(
    async () => {
      const [day, member, model, project] = await Promise.all([
        api.projectCosts(projectId, "day"),
        api.projectCosts(projectId, "member"),
        api.projectCosts(projectId, "model"),
        api.project(projectId).catch(() => null),
      ]);
      return { day, member, model, projectName: project?.name ?? "" };
    },
    demoPages,
    demoMode,
    [projectId],
  );
  const [view, setView] = useState<ProjectCostGroupBy>("day");

  if (state.loading) return <LoadingState label="正在读取项目消耗" onRetry={state.retry} />;
  if (state.error || !state.data) return <ErrorState message={humanErrorMessage(state.error, "项目消耗数据不存在")} onRetry={state.retry} />;
  const pages = state.data;
  const title = `${pages.projectName || "项目消耗"} · 消耗看板`;
  if (aggregateHasNoConsumption([pages.day, pages.member, pages.model])) {
    return (
      <section className={PAGE_SHELL}>
        <PageHeader title={title} description="当前项目的消耗总计、维度汇总与逐笔明细。" />
        <Card>
          <EmptyState
            title="还没有消耗"
            description="生图生视频后在这里看账"
            icon={<Coins />}
            action={<Button variant="primary" icon={<FilmStrip />} onClick={() => navigate(projectStoryboardPath(projectId))}>去生产</Button>}
          />
        </Card>
      </section>
    );
  }
  /* 三视图 totals 同源同账（同一批记录按不同维度分组），总计卡取按日期视图的总账。 */
  const totals = pages.day.totals;
  return (
    <section className={PAGE_SHELL}>
      <PageHeader
        title={title}
        description="当前项目的消耗总计、维度汇总与逐笔明细。"
        actions={(
          <span className="inline-flex items-center gap-2">
            <HelpHint label="记账与复核口径">
              <span className="flex flex-col gap-2">
                <span><strong className="text-ink-1">预估复核：</strong>单次任务预估消耗超出平台设定的复核阈值时，确认后追加一次复核（阈值由管理员在服务端配置）。预算不足由服务端拒绝并给出可操作提示。</span>
                <span><strong className="text-ink-1">记账口径：</strong>{COST_UNIT_LABEL}即结算单位，按账本已计价记录汇总；未计价条目按 0 计入合计并单独标明笔数。</span>
              </span>
            </HelpHint>
            <Button icon={<ArrowClockwise />} onClick={state.retry}>刷新数据</Button>
          </span>
        )}
      />
      <CostNotice notice={`按服务端账本已计价${COST_UNIT_LABEL}汇总，未计价笔数单独标明；为预估口径，非云平台实际账单。`} demoNote={demoMode ? "当前为离线示例。" : null} />
      {/* SPEC P-08 大数字 hero:本集已花(mono 大数字)。「≈元」换算与「本集预算/已用%」
          依赖汇率常量与项目预算字段——两者皆无数据源(钱的不变量不发明),待 sol 合同后接入。 */}
      <section aria-label="本集已花" className="flex flex-col gap-1">
        <span className="text-sm text-ink-2">本集已花</span>
        <span className="font-mono text-4xl font-semibold text-ink-1">{formatCredits(totals.chargedPoints)}<span className="ml-2 text-base font-normal text-ink-2">{COST_UNIT_LABEL}</span></span>
        <span className="text-xs text-ink-3">已计价合计 · {totals.entryCount} 笔</span>
      </section>
      <section className={METRICS_GRID} aria-label="消耗总计">
        <MetricCard label={`总消耗 · ${COST_UNIT_LABEL}`} value={formatCredits(totals.chargedPoints)} note={`已计价合计 · ${totals.entryCount} 笔`} tone="orange" icon={<Coins />} />
        <MetricCard label="消耗笔数" value={totals.entryCount} note="账本记录总条数" tone="neutral" icon={<Calculator />} />
        <MetricCard label="未计价笔数" value={totals.unpricedCount} note={totals.unpricedCount > 0 ? "无单价记录，按 0 计入合计" : "全部条目均有单价"} tone={totals.unpricedCount > 0 ? "orange" : "neutral"} icon={<WarningCircle />} />
      </section>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>{PROJECT_COST_GROUP_BY_LABEL[view]}消耗</CardTitle>
            <CardDescription>按服务端账本已计价汇总 · 单位：{COST_UNIT_LABEL}</CardDescription>
          </div>
          <Tabs value={view} onValueChange={(value) => setView(value as ProjectCostGroupBy)}>
            <TabsList>
              <TabsTrigger value="day"><CalendarBlank aria-hidden="true" />按日期</TabsTrigger>
              <TabsTrigger value="member"><Users aria-hidden="true" />按成员</TabsTrigger>
              <TabsTrigger value="model"><BracketsCurly aria-hidden="true" />按模型</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          <ProjectCostAggregateView view={view} pages={pages} />
        </CardContent>
      </Card>
      {/* E：逐笔明细（对标 LibTV 消耗明细页；consumption records 契约，本包未动） */}
      <OpsPanel title="消耗明细" description="逐笔任务消耗 · 可按日期/类型/模型筛选;档位是计价单位,不是能力天花板,能力值域以官方文档为准" icon={<Coins />}>
        <ConsumptionRecordsPanel projectId={projectId} demoMode={demoMode} notify={notify} />
      </OpsPanel>
    </section>
  );
}

/** S75 三视图渲染出口（导出供测试真渲染）：按日期走条形，成员/模型走聚合表。 */
export function ProjectCostAggregateView({ view, pages }: { view: ProjectCostGroupBy; pages: ProjectCostPages }): React.JSX.Element {
  if (view === "day") {
    return <CostBars rows={buildAggregateDayBars(pages.day.rows)} emptyTitle="还没有按日期的消耗" emptyDescription="生成图片或视频后按天汇总在这里。" emptyIcon={<CalendarBlank />} />;
  }
  return <AggregateRowTable page={pages[view]} nameLabel={view === "member" ? "成员" : "模型"} />;
}

/** 成员/模型聚合表：名称/消耗/笔数/未计价四列右对齐，末行服务端 totals 合计，截断如实注明。 */
function AggregateRowTable({ page, nameLabel }: { page: CostAggregatePage; nameLabel: string }): React.JSX.Element {
  if (page.rows.length === 0) {
    return (
      <EmptyState
        title={`还没有按${nameLabel}的消耗`}
        description={`生成图片或视频后按${nameLabel}汇总在这里。`}
        icon={nameLabel === "成员" ? <Users /> : <BracketsCurly />}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border-1 text-left">
              <th className="px-3 py-2 font-medium text-ink-4">{nameLabel}</th>
              <th className="px-3 py-2 text-right font-medium text-ink-4">消耗（{COST_UNIT_LABEL}）</th>
              <th className="px-3 py-2 text-right font-medium text-ink-4">笔数</th>
              <th className="px-3 py-2 text-right font-medium text-ink-4">未计价</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.key} className="border-b border-border-1">
                {/* 业务语言化（#18）：按模型视图 label=后端原始型号串，上屏走能力中文名，原值进 title */}
                <td className="px-3 py-2 text-ink-1" title={nameLabel === "模型" ? modelRawTitle(row.label) : undefined}>{nameLabel === "模型" ? modelDisplayLabel(row.label) : row.label}</td>
                <td className="px-3 py-2 text-right font-mono"><strong className="font-semibold text-ink-1">{formatCredits(row.chargedPoints)}</strong></td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{row.entryCount}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{row.unpricedCount > 0 ? <span className="text-warning">{row.unpricedCount} 笔</span> : "—"}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-border-2">
              <td className="px-3 py-2 font-semibold text-ink-1">合计</td>
              <td className="px-3 py-2 text-right font-mono font-semibold text-ink-1">{formatCredits(page.totals.chargedPoints)}</td>
              <td className="px-3 py-2 text-right font-mono font-semibold text-ink-1">{page.totals.entryCount}</td>
              <td className="px-3 py-2 text-right font-mono font-semibold text-ink-1">{page.totals.unpricedCount > 0 ? `${page.totals.unpricedCount} 笔` : "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {page.total > page.rows.length ? (
        <p className="flex items-start gap-1 text-xs text-ink-2">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>仅展示前 {page.rows.length} 条（共 {page.total} 条，按消耗降序）。</span>
        </p>
      ) : null}
    </div>
  );
}

/** 回收站每页条数：单行紧凑卡约一屏十余行。S9-19 前端切片兜底——后端 /trash 暂无分页参数，接入后可退役。 */
const TRASH_PAGE_SIZE = 12;

export function TrashPage({ kind, demoMode, notify, onBack, onKindChange }: PageRuntimeProps & {
  kind?: "project" | "asset";
  onBack?: () => void;
  onKindChange?: (kind: "" | "project" | "asset") => void;
}): React.JSX.Element {
  const fallbackItems = kind ? demoTrash.filter((item) => item.kind === kind) : demoTrash;
  const state = useResource(() => api.trash(kind), { items: fallbackItems, count: fallbackItems.length }, demoMode, [kind]);
  const [busyId, setBusyId] = useState("");
  const [deleting, setDeleting] = useState<TrashItem | null>(null);
  /* 类型切换回第一页；恢复/删除缩水上限由 safePage 夹取 */
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [kind]);
  const items = state.data?.items ?? [];
  const totalPages = pageCount(items.length, TRASH_PAGE_SIZE);
  const safePage = Math.min(page, totalPages);
  const pageItems = paginateItems(items, safePage, TRASH_PAGE_SIZE);
  /* S10-D1（丽芬批）：回收站三分组信息架构——「被删项目」「个人资产」按组陈列、还原回原位；
     第三组「项目内单删」（集/场景/分镜）后端回收站 V0.1 不回收也不列出
     （src/modules/trash repository.assertSupportedKind 仅 project+asset，软删的分镜不在 /trash 响应里），
     如实给说明行，不摆假条目、不给假恢复按钮。 */
  const projectPageItems = pageItems.filter((item) => item.kind === "project");
  const assetPageItems = pageItems.filter((item) => item.kind === "asset");
  const projectTotal = items.filter((item) => item.kind === "project").length;
  const assetTotal = items.length - projectTotal;

  async function restore(item: TrashItem): Promise<void> {
    if (demoMode) return notify("离线演示不会还原项目或资产，也不会写入服务。", "info");
    setBusyId(item.id);
    try {
      await api.restoreTrash(item.kind, item.id);
      state.setData((current) => current ? { items: current.items.filter((candidate) => candidate.id !== item.id), count: Math.max(0, current.count - 1) } : current);
      notify(`${kindLabel(item.kind)}已还原回原位`, "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "还原失败，请重试"), "error");
    } finally {
      setBusyId("");
    }
  }

  async function permanentlyDelete(): Promise<void> {
    if (!deleting) return;
    if (demoMode) {
      notify("离线演示不会永久删除任何数据。", "info");
      setDeleting(null);
      return;
    }
    setBusyId(deleting.id);
    try {
      await api.permanentlyDeleteTrash(deleting.kind, deleting.id);
      state.setData((current) => current ? { items: current.items.filter((candidate) => candidate.id !== deleting.id), count: Math.max(0, current.count - 1) } : current);
      notify(`${kindLabel(deleting.kind)}已永久删除`, "success");
      setDeleting(null);
    } catch (reason) {
      notify(businessErrorMessage(reason, "永久删除失败，请重试"), "error");
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className={PAGE_SHELL}>
      <PageHeader
        title="回收站"
        description="当前账号删除的项目与个人资产分组陈列；还原后回到原来的位置（项目回项目列表，资产回个人资产库）。"
        actions={(
          <span className="flex items-center gap-2">
            {onBack ? <Button variant="outline" onClick={onBack}>返回项目</Button> : null}
            <Button icon={<ArrowClockwise />} onClick={state.retry}>刷新</Button>
          </span>
        )}
      />
      {/* S10-D1：保留期 180 天真话口径（TTL 已由 S 主线交付：feature/v011-s-main-trash-ttl@4aacf0d，
          READY_FOR_FABLE_INTEGRATION；DC 2026-08-02 r150 卡恢复写天数,K2-B 止血期「不写天数」决策退役） */}
      <p className="flex flex-wrap items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" role="note">
        <WarningCircle className="size-4 shrink-0" aria-hidden="true" />
        <span>移入回收站的内容保留 180 天，之后自动彻底删除。</span>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          ariaLabel="回收站类型过滤"
          value={kind ?? ""}
          options={[
            { value: "", label: "全部" },
            { value: "project", label: "被删项目" },
            { value: "asset", label: "个人资产" },
          ]}
          onChange={(value) => onKindChange ? onKindChange(value) : navigate(value ? `/trash?kind=${value}` : "/trash")}
        />
        <span className="text-xs text-ink-4">{state.data?.count ?? 0} 项</span>
      </div>
      {demoMode ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
          <WarningCircle className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>当前是离线示例。还原和永久删除只会说明限制，不会改动任何真实数据。</span>
        </p>
      ) : null}
      {state.loading ? <LoadingState label="正在读取回收站" /> : state.error ? <ErrorState message={state.error} onRetry={state.retry} /> : !state.data?.items.length ? (
        <Card>
          <EmptyState title="回收站是空的" description="删除的项目和个人资产会出现在这里，保留 180 天后自动彻底删除。" icon={<Trash />} />
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-4">
            {projectPageItems.length > 0 ? (
              <TrashGroup title="被删项目" count={projectTotal} icon={<FolderSimple />} items={projectPageItems} busyId={busyId} restoreHint="还原后回到项目列表" onRestore={restore} onDelete={setDeleting} />
            ) : null}
            {assetPageItems.length > 0 ? (
              <TrashGroup title="个人资产" count={assetTotal} icon={<ImageSquare />} items={assetPageItems} busyId={busyId} restoreHint="还原后回到个人资产库" onRestore={restore} onDelete={setDeleting} />
            ) : null}
            {!kind ? (
              <section className="flex flex-col gap-1 rounded-md border border-dashed border-border-1 px-4 py-3" aria-label="项目内单删说明">
                <h2 className="text-sm font-medium text-ink-2">项目内单删（集 / 场景 / 分镜）</h2>
                <p className="text-xs text-ink-4">项目内单独删除的集、场景、分镜暂不进入回收站，删除后暂不可恢复；这几类的恢复能力会在后续版本补齐。</p>
              </section>
            ) : null}
          </div>
          <ListPager page={safePage} total={items.length} onPageChange={setPage} itemNoun="项" ariaLabel="回收站分页" pageSize={TRASH_PAGE_SIZE} />
        </>
      )}
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !busyId) setDeleting(null); }}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>确认永久删除</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {deleting ? (
              <div className="flex items-start gap-3">
                <WarningCircle className="size-6 shrink-0 text-danger" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <strong className="text-sm text-ink-1">将永久删除“{deleting.name}”</strong>
                  <p className="text-xs text-ink-2">系统会先检查它是否仍被使用；仍在使用会拦下这次删除并说明原因。删除成功后无法恢复。</p>
                </div>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button disabled={Boolean(busyId)} onClick={() => setDeleting(null)}>取消</Button>
            <Button variant="danger" icon={<Trash />} loading={deleting ? busyId === deleting.id : false} onClick={() => void permanentlyDelete()}>确认永久删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function EpisodePlaybackModal({ episodeId, demoMode, notify, onClose }: Pick<PageRuntimeProps, "demoMode" | "notify"> & { episodeId: string; onClose: () => void }): React.JSX.Element {
  /* K2U D-14/D-18：demo 连播数据 = demo-delivery 从 K2A 真源表派生(5 镜可播+页脚清单,
     口径与审核队列同一闸门);无产物的集仍如实空态。 */
  const state = useResource(() => api.episodePlayback(episodeId), demoEpisodePlayback(episodeId), demoMode, [episodeId]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [downloading, setDownloading] = useState("");
  const [exportPreview, setExportPreview] = useState<DemoExportKind | null>(null);
  const clips = state.data?.playback ?? [];
  const active = clips[activeIndex];
  useEffect(() => {
    if (activeIndex >= clips.length) setActiveIndex(0);
  }, [activeIndex, clips.length]);

  async function downloadMedia(item: DeliverableItem): Promise<void> {
    if (demoMode) return notify("离线演示没有可下载的真实媒体。", "info");
    setDownloading(item.media_id);
    try {
      await api.downloadMedia(item.media_id);
      notify(`素材 #${item.shot_code} 已开始下载`, "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "下载失败，请重试"), "error");
    } finally {
      setDownloading("");
    }
  }

  /* K2U D-19：demo 下导出 = 内存生成内容 + 预览/复制(不落盘),与生产页/工作台顶栏同一弹窗。 */
  async function exportManifest(kind: "json" | "csv"): Promise<void> {
    if (demoMode) {
      setExportPreview(kind);
      return;
    }
    setDownloading(kind);
    try {
      if (kind === "json") await api.downloadEpisodeJson(episodeId);
      else await api.downloadEpisodeCsv(episodeId);
      notify(`${kind.toUpperCase()} 交付清单已开始下载`, "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "导出失败，请重试"), "error");
    } finally {
      setDownloading("");
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{`本集连播${clips.length ? `（${clips.length} 镜）` : ""}`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {state.loading ? <LoadingState label="正在准备本集主版本" /> : state.error ? <ErrorState message={state.error} onRetry={state.retry} /> : !active ? (
            <EmptyState title={demoMode ? "离线演示没有真实视频" : "还不能连播"} description={demoMode ? "登录服务并为分镜选择视频主版本后，可在这里连续播放和下载。" : "请先为本集每个分镜选择已保存成功的视频主版本。"} icon={<FilmStrip />} />
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(260px,1fr)]">
              <section className="flex flex-col gap-2">
                <video key={active.media_id} controls autoPlay preload="metadata" src={active.storage_url} className="max-h-[62vh] w-full rounded-md bg-surface-well" onEnded={() => setActiveIndex((value) => value + 1 < clips.length ? value + 1 : 0)} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status="succeeded">主版本</StatusBadge>
                    <strong className="text-sm text-ink-1">分镜 {active.shot_code}</strong>
                    <span className="text-xs text-ink-4">{active.duration_seconds ? `${active.duration_seconds} 秒` : "时长由媒体文件提供"}</span>
                  </div>
                  <Button icon={<DownloadSimple />} loading={downloading === active.media_id} onClick={() => void downloadMedia(active)}>下载当前视频</Button>
                </div>
              </section>
              <aside className="flex flex-col gap-2">
                <header className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-sm font-semibold text-ink-1">播放顺序</h3>
                    <p className="text-xs text-ink-2">播完当前镜头后自动继续下一镜</p>
                  </div>
                  <Play className="size-4 text-ink-4" aria-hidden="true" />
                </header>
                <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                  {clips.map((item, index) => (
                    <button
                      type="button"
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                        index === activeIndex ? "border-accent/50 bg-accent-subtle" : "border-transparent hover:bg-surface-2",
                      )}
                      key={item.media_id}
                      onClick={() => setActiveIndex(index)}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-[11px] text-ink-2">{index + 1}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <strong className="text-xs text-ink-1">分镜 {item.shot_code}</strong>
                        <small className="text-[11px] text-ink-4" title={modelRawTitle(item.model)}>{modelDisplayLabel(item.model)} · {formatFen(item.estimated_cost_fen)}</small>
                      </span>
                      {index === activeIndex ? <Play className="size-3.5 text-accent-text" aria-hidden="true" /> : null}
                    </button>
                  ))}
                </div>
              </aside>
              <footer className="col-span-full flex flex-wrap items-center gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <strong className="text-xs text-ink-1">交付清单</strong>
                  <span className="text-xs text-ink-4">{state.data?.estimated_cost_notice} · 合计 {formatFen(state.data?.estimated_cost_fen ?? 0)}</span>
                </div>
                <Button icon={<BracketsCurly />} loading={downloading === "json"} onClick={() => void exportManifest("json")}>下载 JSON</Button>
                <Button icon={<FileText />} loading={downloading === "csv"} onClick={() => void exportManifest("csv")}>下载 CSV</Button>
              </footer>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
      {exportPreview ? <DemoExportPreviewDialog episodeId={episodeId} kind={exportPreview} notify={notify} onClose={() => setExportPreview(null)} /> : null}
    </>
  );
}

/* ---------- 板09 复用组件：页头 / 面板 / 总计卡组 / 参与用户表 / 消耗条形 ---------- */

const METRICS_GRID = "grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]";

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        {/* 顶部导航已承担页名，标题只留可访问名，不重复占位（libTV/TapNow 式内容优先） */}
        <h1 className="sr-only">{title}</h1>
        <p className="text-sm text-ink-2">{description}</p>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** 面板卡：Card 层级统一，标题/副文案左置，右上角面板图标或操作位。 */
function OpsPanel({ title, description, icon, children }: { title: string; description?: string; icon?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {icon ? <span className="text-ink-4 [&_svg]:size-5" aria-hidden="true">{icon}</span> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** 口径提示行：预估消耗说明 + 演示模式补充，不造假。 */
function CostNotice({ notice, demoNote }: { notice: string; demoNote: string | null }): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
      <WarningCircle className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <span>{notice}</span>
      {demoNote ? <strong className="font-medium text-ink-1">{demoNote}</strong> : null}
    </p>
  );
}

/** 简化分段开关（视觉同 TabsList/TabsTrigger）；本文件用于回收站导航过滤。 */
function SegmentedControl<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
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

type MetricTone = "neutral" | "info" | "blue" | "green" | "orange";

/** 图标着色（对齐旧 metric-tone 语义：blue=进行中青 / green=成功 / orange=警示 / info、neutral=墨色）。 */
const METRIC_TONE_ICON: Record<MetricTone, string> = {
  neutral: "text-ink-4",
  info: "text-ink-2",
  blue: "text-accent-text",
  green: "text-success",
  orange: "text-warning",
};

function MetricCard({ label, value, note, tone, icon }: { label: string; value: string | number; note: string; tone: MetricTone; icon?: React.ReactNode }): React.JSX.Element {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <strong className="font-mono text-2xl font-semibold leading-8 text-ink-1">{value}</strong>
      <span className="flex items-center gap-1 text-xs text-ink-2">
        {icon ? <span className={cn("[&_svg]:size-3.5", METRIC_TONE_ICON[tone])} aria-hidden="true">{icon}</span> : null}
        {label}
      </span>
      <small className="text-xs text-ink-4">{note}</small>
    </Card>
  );
}

/** 总计卡组：总消耗 / 图片消耗 / 视频消耗 / 其他（AI 辅助）/ 预估消耗（单位文案走 token）。 */
function CostTotalCardsRow({ cards, tasksNote, otherGapNote }: { cards: CostTotalCards; tasksNote: string; otherGapNote: string }): React.JSX.Element {
  return (
    <section className={METRICS_GRID} aria-label="消耗总计">
      <MetricCard label={`总消耗 · ${COST_UNIT_LABEL}`} value={creditsText(cards.totalFen)} note={cards.totalFen === null ? "有已计价的成功任务后显示" : `成功任务估价合计 · ${tasksNote}`} tone="orange" icon={<Coins />} />
      <MetricCard label="图片消耗" value={creditsText(cards.imageFen)} note="图片生成估价合计" tone="blue" icon={<ImageSquare />} />
      <MetricCard label="视频消耗" value={creditsText(cards.videoFen)} note="视频生成估价合计" tone="green" icon={<VideoCamera />} />
      <MetricCard label="其他（AI 辅助）" value={creditsText(cards.otherFen)} note={cards.otherFen === null ? otherGapNote : "AI 提示词 / 检索等辅助估价"} tone="info" icon={<Sparkle />} />
      <MetricCard label={`预估消耗 · ${COST_UNIT_LABEL}`} value={creditsText(cards.estimatedYuanFen)} note="逐项估价合计，非云平台实际账单" tone="neutral" icon={<Calculator />} />
    </section>
  );
}

/** 参与用户表：用户名 / 图片消耗 / 视频消耗 / 其他 / 预估消耗 / 实际消耗，末行合计。 */
function CostByUserTable({ resolution, globalScopeNote = "项目内按用户汇总即将上线，当前显示账号全局口径；未拆分的列显示 —。" }: { resolution: UserCostResolution; globalScopeNote?: string }): React.JSX.Element {
  if (resolution.scope === "none") {
    return (
      <p className="flex items-start gap-1 text-xs text-ink-2">
        <WarningCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>暂无参与用户数据，本页不做推算。</span>
      </p>
    );
  }
  if (resolution.rows.length === 0) {
    return <EmptyState title="还没有参与用户" description="生成图片或视频后，这里会按用户汇总消耗。" icon={<Users />} />;
  }
  const totals = sumUserCostRows(resolution.rows);
  const hasActualGap = resolution.rows.some((row) => row.actualFen === null);
  return (
    <div className="flex flex-col gap-2">
      {resolution.scope === "global" ? (
        <p className="flex items-start gap-1 text-xs text-ink-2">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>{globalScopeNote}</span>
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border-1 text-left">
              <th className="px-3 py-2 font-medium text-ink-4">用户名</th>
              <th className="px-3 py-2 text-right font-medium text-ink-4">图片消耗（{COST_UNIT_LABEL}）</th>
              <th className="px-3 py-2 text-right font-medium text-ink-4">视频消耗（{COST_UNIT_LABEL}）</th>
              <th className="px-3 py-2 text-right font-medium text-ink-4">其他（{COST_UNIT_LABEL}）</th>
              <th className="px-3 py-2 text-right font-medium text-ink-4">预估消耗（{COST_UNIT_LABEL}）</th>
              <th className="px-3 py-2 text-right font-medium text-ink-4">实际消耗（{COST_UNIT_LABEL}）</th>
            </tr>
          </thead>
          <tbody>
            {resolution.rows.map((row) => (
              <tr key={row.key} className="border-b border-border-1">
                <td className="px-3 py-2 text-ink-1">{row.name}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{creditsText(row.imageFen)}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{creditsText(row.videoFen)}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{creditsText(row.otherFen)}</td>
                <td className="px-3 py-2 text-right font-mono"><strong className="font-semibold text-ink-1">{creditsText(row.estimatedFen)}</strong></td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{creditsText(row.actualFen)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-border-2">
              <td className="px-3 py-2 font-semibold text-ink-1">合计</td>
              <td className="px-3 py-2 text-right font-mono font-semibold text-ink-1">{creditsText(totals.imageFen)}</td>
              <td className="px-3 py-2 text-right font-mono font-semibold text-ink-1">{creditsText(totals.videoFen)}</td>
              <td className="px-3 py-2 text-right font-mono font-semibold text-ink-1">{creditsText(totals.otherFen)}</td>
              <td className="px-3 py-2 text-right font-mono font-semibold text-ink-1">{creditsText(totals.estimatedFen)}</td>
              <td className="px-3 py-2 text-right font-mono font-semibold text-ink-1">{creditsText(totals.actualFen)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {hasActualGap ? (
        <p className="flex items-start gap-1 text-xs text-ink-2">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>实际消耗以后端回传为准，未回传的显示 —，不做推算。</span>
        </p>
      ) : null}
    </div>
  );
}

/** 消耗条形（按日期维度）：数据缺失（null）降级明示，空数组走空态，均不编数。 */
function CostBars({ rows, emptyTitle, emptyDescription, emptyIcon }: { rows: CostBarRow[] | null; emptyTitle: string; emptyDescription: string; emptyIcon?: React.ReactNode }): React.JSX.Element {
  if (rows === null) {
    return (
      <p className="flex items-start gap-1 text-xs text-ink-2">
        <WarningCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>该维度暂无数据，本页不做推算。</span>
      </p>
    );
  }
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} icon={emptyIcon} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div className="grid grid-cols-[minmax(96px,180px)_1fr_minmax(72px,auto)_minmax(44px,auto)] items-center gap-3 text-xs text-ink-2" key={row.key}>
          <span className="truncate text-ink-1">{row.label}</span>
          <span className="block h-2 overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full w-full origin-left rounded-full bg-accent transition-transform duration-200 ease-out-quart" style={{ transform: `scaleX(${row.fen > 0 ? Math.max(row.share, 0.02) : 0})` }} />
          </span>
          <span className="text-right font-mono text-ink-1">{formatCredits(row.fen)}</span>
          <span className="whitespace-nowrap text-ink-4">{row.tasks} 次</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- 金额文案：全部走 cost-units token，null = 未对接显示「—」 ---------- */

function creditsText(fen: number | null): string {
  return fen === null ? "—" : formatCredits(fen);
}

/* ---------- 以下助手仅服务 TrashPage / EpisodePlaybackModal ---------- */

/** S10-D1：回收站分组（被删项目 / 个人资产）——组头带全量计数，行内「还原」回原位 + 永久删除。 */
function TrashGroup({ title, count, icon, items, busyId, restoreHint, onRestore, onDelete }: {
  title: string;
  count: number;
  icon: React.ReactNode;
  items: TrashItem[];
  busyId: string;
  restoreHint: string;
  onRestore: (item: TrashItem) => Promise<void>;
  onDelete: (item: TrashItem) => void;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink-2">
        {title}
        <span className="font-mono text-xs text-ink-4">{count} 项</span>
      </h2>
      {items.map((item) => (
        <article key={`${item.kind}-${item.id}`} className="flex flex-wrap items-center gap-3 rounded-md border border-border-1 bg-surface-1 px-4 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-2 [&_svg]:size-[18px]" aria-hidden="true">
            {icon}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={item.kind === "project" ? "archived" : "draft"}>{kindLabel(item.kind)}</StatusBadge>
              <h3 className="truncate text-ink-1 text-section-title">{item.name}</h3>
            </div>
            <p className="text-xs text-ink-4">删除时间：{formatDateTime(item.deleted_at)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button icon={<ArrowCounterClockwise />} title={restoreHint} loading={busyId === item.id} disabled={Boolean(busyId)} onClick={() => void onRestore(item)}>还原</Button>
            <Button variant="ghost" icon={<Trash />} disabled={Boolean(busyId)} onClick={() => onDelete(item)}><span className="text-danger">永久删除</span></Button>
          </div>
        </article>
      ))}
    </section>
  );
}

function formatFen(fen: number): string {
  return formatCreditsWithUnit(Math.max(0, fen));
}

function kindLabel(kind: TrashItem["kind"]): string {
  return kind === "project" ? "项目" : "个人资产";
}
