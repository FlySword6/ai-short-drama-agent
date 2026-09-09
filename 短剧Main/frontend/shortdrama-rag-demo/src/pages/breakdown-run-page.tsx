/* ============================================================
   breakdown-run-page.tsx — 统一运行页（K2 彩排包，设计 §2 五幕）

   路由：/projects/:projectId/requirement-breakdowns/:runId（以 run 为中心，
   作用域从 run 读）。整页参照 script-breakdown-page 模式，只换数据形状。

   五幕：输入（各入口创建 run 后跳来）→ 等待（queued/running 阶段条，
   1.5s 步进）→ 清单（draft：摘要条 + 过滤 + lane 分组需求卡 + 底部动作条）
   → 提交（确认弹窗一句人话 → 原子 finalize）→ 完成（结果摘要 + 去向）。
   失败/放弃/恢复骨架同在：failed 给「继续拆解」（resume 产生新 run），
   discarded/superseded 只读墓碑。

   边界（契约 v0.2.0 READY_FOR_FABLE_DECISION，未批准）：
   - 不接真后端：本页不 import api.ts，数据全部来自 requirement-breakdown.ts
     的彩排状态机（rehearsal，全内存零网络）+ demo.ts fixture（离线演示假数据）；
   - 已选候选渲染决策中立：解析收敛在 resolveSelectedCandidate 一个纯函数，
     Fable 两个裁决选项各自一行接入，本页不写死；
   - 一屏 primary ≤1：清单幕只有「确认并采用」；viewer 无 primary。
   ============================================================ */

import { ArrowClockwise, ArrowLeft, ArrowRight, CheckCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useReducer, useState } from "react";

import { CapabilityStatusBar } from "../components/capability-status";
import { RequirementCard } from "../components/requirement-card";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { Badge, Card, CardContent, EmptyState } from "../components/ui/primitives";
import { demoBreakdownRequirements, demoBreakdownRetrievalRequirements } from "../demo";
import { laneVocabularySnapshot } from "../lane-vocabulary";
import { canCreateInProject, type PlatformRoleForCopy } from "../operations";
import { capabilityGate, platformRoleForCopy, type CapabilitiesState } from "../capabilities-state";
import { CapabilityActionSlot } from "../components/capability-notice";
import {
  BREAKDOWN_EMBEDDED_CANDIDATE_COUNT,
  BREAKDOWN_RUN_STATUS_META,
  BREAKDOWN_STAGE_STATUS_META,
  BREAKDOWN_VIEWER_NOTE,
  breakdownErrorCopy,
  breakdownStageStates,
  confirmedResultCopy,
  createRehearsalRun,
  decideRehearsal,
  discardRehearsalRun,
  finalizeConfirmCopy,
  finalizeRehearsalRun,
  filterRequirements,
  getRehearsalRun,
  groupRequirementsByLane,
  newRehearsalIdempotencyKey,
  resumeRehearsalRun,
  summarizeRequirements,
  tickRehearsalRun,
  type BreakdownDecisionInput,
  type RehearsalRunState,
  type RequirementFilter,
} from "../requirement-breakdown";
import { navigate, projectRequirementBreakdownPath, projectStoryboardPath } from "../routing";
import { formatDateTime } from "../ui";
import type { PageRuntimeProps } from "./global-pages";

const FILTER_TABS: readonly { key: RequirementFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "undecided", label: "待决定" },
  { key: "missing", label: "缺失" },
];

/** 彩排步进间隔（设计 §6.1：demoMode 下用定时器按 1.5s 步进）。 */
const REHEARSAL_TICK_MS = 1500;

function isRetrievalVariant(state: RehearsalRunState): boolean {
  return state.requirements.length > 0 && state.requirements.every((requirement) => requirement.match.status === "retrieval_unavailable");
}

export function BreakdownRunPage({
  projectId,
  runId,
  demoMode,
  notify,
  user,
  capabilities,
}: PageRuntimeProps & { projectId: string; runId: string }): React.JSX.Element {
  const [, forceRender] = useReducer((value: number) => value + 1, 0);
  const [filter, setFilter] = useState<RequirementFilter>("all");
  const [expandedReqIds, setExpandedReqIds] = useState<ReadonlySet<string>>(new Set());
  const [incompleteIds, setIncompleteIds] = useState<readonly string[] | null>(null);

  const state = getRehearsalRun(runId);
  const runStatus = state?.run.status ?? null;

  /* 只读成员形态（彩排可切）：demo 下 ?as=viewer 模拟契约 §9 viewer 只读；
     真栈口径=canCreateInProject（owner|editor 才能确认，admin 不越权）。 */
  const viewerRehearsal = demoMode && new URLSearchParams(window.location.search).get("as") === "viewer";
  const decideGate = capabilityGate(capabilities, (caps) => canCreateInProject(caps, projectId));
  /* 底部条的三种说法在这里一次定死，互斥。原来是「能不能决定」加一个兜底位两块并列，
     结果权限没落地时占位和「只有负责人和编辑能确认采用」同屏打架：一边说没读到，
     一边替接口把人判成没权限。 */
  const decideBar: DecideBar = viewerRehearsal || decideGate === "denied"
    ? { kind: "note" }
    : decideGate === "allowed"
      ? { kind: "decide" }
      : { kind: "pending", capabilities };

  /* 等待幕：queued/running 每 1.5s 步进彩排状态机，直到出 draft。 */
  useEffect(() => {
    if (runStatus !== "queued" && runStatus !== "running") return;
    const timer = window.setInterval(() => {
      tickRehearsalRun(runId);
      forceRender();
    }, REHEARSAL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [runId, runStatus]);

  function handleDecide(requirementId: string, input: BreakdownDecisionInput): void {
    const outcome = decideRehearsal(runId, requirementId, input);
    if (!outcome.ok) {
      notify(outcome.message ?? "操作失败，请重试", "error");
    } else {
      setIncompleteIds((current) => (current ? current.filter((id) => id !== requirementId) : current));
    }
    forceRender();
  }

  function handleFinalize(): void {
    if (!state) return;
    if (!window.confirm(finalizeConfirmCopy(state.run.scope.kind))) return;
    const outcome = finalizeRehearsalRun(runId);
    if (outcome.ok) {
      setIncompleteIds(null);
      notify("已确认采用", "success");
    } else {
      const copy = breakdownErrorCopy(outcome);
      /* 422 演练：底部红字计数 + 过滤自动切「待决定」+ 滚动到第一项（设计 §4）。 */
      if (copy.behavior === "bottom_incomplete") {
        setIncompleteIds(copy.requirementIds);
        setFilter("undecided");
        window.setTimeout(() => {
          const first = copy.requirementIds[0];
          if (first) {
            document.getElementById(`breakdown-requirement-${first}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }, 60);
      }
      notify(copy.message, "error");
    }
    forceRender();
  }

  function handleDiscard(): void {
    if (!state) return;
    if (!window.confirm("放弃这次拆解？这次运行不会再写入。")) return;
    discardRehearsalRun(runId);
    notify("已放弃这次拆解", "success");
    forceRender();
  }

  function handleResume(): void {
    const resumed = resumeRehearsalRun(runId, { idempotencyKey: newRehearsalIdempotencyKey() });
    if (!resumed) {
      notify("这次运行不能继续拆解", "error");
      return;
    }
    notify("已创建新的拆解运行；之前的决定会保留，候选重新匹配", "success");
    navigate(projectRequirementBreakdownPath(projectId, resumed.next.run.id));
  }

  function handleGenerationBrief(): void {
    /* 付费红线沿用助理面板常量口径：生成永远由人亲手点击；彩排不创建任何任务。 */
    notify("离线演示不会创建生成任务", "info");
  }

  /* 彩排形态切换（demo 专用）：标准 ↔ 资产库暂不可查，各建一条新 run。 */
  function switchRehearsalVariant(): void {
    if (!state) return;
    const retrieval = isRetrievalVariant(state);
    const rehearsal = createRehearsalRun({
      idempotencyKey: newRehearsalIdempotencyKey(),
      projectId,
      scope: state.run.scope,
      scopeLabel: state.scopeLabel,
      sourceText: state.sourceText,
      requirements: retrieval ? demoBreakdownRequirements() : demoBreakdownRetrievalRequirements(),
      primaryDestination: state.primaryDestination,
      returnDestination: state.returnDestination,
    });
    navigate(projectRequirementBreakdownPath(projectId, rehearsal.run.id));
  }

  function toggleViewerRehearsal(): void {
    const base = projectRequirementBreakdownPath(projectId, runId);
    navigate(viewerRehearsal ? base : `${base}?as=viewer`);
  }

  if (!state) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <EmptyState
          title="没有找到这次拆解运行"
          description="这次运行不在当前会话里，请从生产页素材卡片的更多操作里重新发起。"
          action={<Button variant="primary" icon={<ArrowLeft />} onClick={() => navigate(projectStoryboardPath(projectId))}>回生产页</Button>}
        />
      </div>
    );
  }

  const statusMeta = BREAKDOWN_RUN_STATUS_META[state.run.status];
  const retrievalVariant = isRetrievalVariant(state);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft />} onClick={() => navigate(state.returnDestination.path)}>
          {state.returnDestination.label}
        </Button>
        <div className="flex min-w-0 flex-col">
          <h1 className="text-2xl font-semibold text-ink-1">需求拆解</h1>
          <p className="truncate text-sm text-ink-2">
            {state.scopeLabel} · 创建于 {formatDateTime(state.run.createdAt)}
          </p>
        </div>
        <Badge tone={statusMeta.tone} className="ml-auto">
          {statusMeta.label}
        </Badge>
      </header>

      {demoMode ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <span>离线演示彩排：数据为本地示例，不会产生真实改动。</span>
          <Button variant="ghost" size="sm" onClick={switchRehearsalVariant}>
            {retrievalVariant ? "换成标准形态" : "换成资产库暂不可查形态"}
          </Button>
          <Button variant="ghost" size="sm" onClick={toggleViewerRehearsal}>
            {viewerRehearsal ? "以可编辑成员身份查看" : "以仅查看成员身份查看"}
          </Button>
        </div>
      ) : null}

      {state.run.status === "queued" || state.run.status === "running" ? (
        <WaitingAct state={state} demoMode={demoMode} platformRole={platformRoleForCopy(capabilities)} />
      ) : null}

      {state.run.status === "draft" ? (
        <DraftAct
          state={state}
          filter={filter}
          onFilterChange={setFilter}
          expandedReqIds={expandedReqIds}
          onExpand={(requirementId) => setExpandedReqIds((current) => new Set(current).add(requirementId))}
          incompleteIds={incompleteIds}
          decideBar={decideBar}
          onDecide={handleDecide}
          onFinalize={handleFinalize}
          onDiscard={handleDiscard}
          onGenerationBrief={handleGenerationBrief}
        />
      ) : null}

      {state.run.status === "confirmed" ? (
        <ConfirmedAct
          state={state}
          expandedReqIds={expandedReqIds}
          onExpand={(requirementId) => setExpandedReqIds((current) => new Set(current).add(requirementId))}
        />
      ) : null}

      {state.run.status === "failed" ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-danger">
              <WarningCircle className="size-5" aria-hidden="true" />
              <strong className="text-sm">这次拆解没有完成</strong>
            </div>
            {state.failureMessage ? <p className="text-sm text-ink-2">{state.failureMessage}</p> : null}
            <p className="text-xs text-ink-3">继续拆解会创建新的运行：之前的决定会保留，候选重新匹配。</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="accent" icon={<ArrowClockwise />} onClick={handleResume}>
                继续拆解
              </Button>
              <Button variant="danger-outline" icon={<XCircle />} onClick={handleDiscard}>
                放弃这次拆解
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.run.status === "discarded" || state.run.status === "superseded" ? (
        <Card>
          <CardContent className="flex flex-col gap-2">
            <strong className="text-sm text-ink-1">这次运行不会再写入</strong>
            <p className="text-xs text-ink-3">
              {state.run.status === "superseded" ? "它已被更新的拆解运行替换。" : "已放弃的拆解只保留记录。"}
            </p>
            <div>
              <Button variant="ghost" size="sm" icon={<ArrowLeft />} onClick={() => navigate(state.returnDestination.path)}>
                {state.returnDestination.label}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <details className="rounded-lg border border-border-1 bg-surface-1 px-4 py-3">
        <summary className="cursor-pointer text-sm text-ink-2">系统怎么准备的</summary>
        <div className="mt-3 flex flex-col gap-1 text-xs text-ink-3">
          <p>分镜文本：{state.sourceText || "（这条素材还没有文字描述）"}</p>
          <p>+ 已确认生产需求（本页确认采用后生效）</p>
          <p>+ 控制包正式成员</p>
          <p>+ 项目风格与生成档位</p>
          <p>= 版本化生成提示词（提示词版本 {state.run.promptVersion}）</p>
          <p className="mt-2">发起人：{user.display_name || user.username}（离线演示彩排，数据为示例）</p>
        </div>
      </details>
    </div>
  );
}

/* ---------- 幕 2 · 等待（queued/running）：阶段条三段，本幕无 primary ---------- */

function WaitingAct({
  state,
  demoMode,
  platformRole,
}: {
  state: RehearsalRunState;
  demoMode: boolean;
  platformRole: PlatformRoleForCopy;
}): React.JSX.Element {
  const stages = breakdownStageStates(state.run);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        {/* S46-A 惯例：AI 能力状态条前置亮灯，网关未开在点按钮前就讲清。 */}
        <CapabilityStatusBar kind="ai_assist" role={platformRole} demoMode={demoMode} />
        <ul className="flex flex-wrap gap-2" aria-label="拆解阶段">
          {stages.map((stage) => {
            const meta = BREAKDOWN_STAGE_STATUS_META[stage.status];
            return (
              <li key={stage.key} className="flex items-center gap-2 rounded-md border border-border-1 px-2.5 py-1.5 text-xs">
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <span className="text-ink-2">{stage.label}</span>
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-ink-2">系统正在拆需求、配资产、校草稿，完成后自动进入需求清单，不用操作。</p>
      </CardContent>
    </Card>
  );
}

/* ---------- 幕 3 · 清单（draft）：摘要条 + 过滤 + 需求卡 + 底部动作条 ---------- */

/**
 * 底部条只有一种说法，三选一：
 * decide=能决定，出动作条；pending=权限还没落地（读取中/读不到），摆占位或「没读到·重试」；
 * note=查清了确实不能决定（彩排 viewer 或真无权），这时才说那句「只有负责人和编辑能确认采用」。
 * pending 一定有内容——它只在读取中/读不到时构造，CapabilityActionSlot 在这两态都出东西，
 * 不会剩下一个带边框的空浮条。
 */
type DecideBar =
  | { kind: "decide" }
  | { kind: "pending"; capabilities: CapabilitiesState }
  | { kind: "note" };

function DraftAct({
  state,
  filter,
  onFilterChange,
  expandedReqIds,
  onExpand,
  incompleteIds,
  decideBar,
  onDecide,
  onFinalize,
  onDiscard,
  onGenerationBrief,
}: {
  state: RehearsalRunState;
  filter: RequirementFilter;
  onFilterChange: (filter: RequirementFilter) => void;
  expandedReqIds: ReadonlySet<string>;
  onExpand: (requirementId: string) => void;
  incompleteIds: readonly string[] | null;
  decideBar: DecideBar;
  onDecide: (requirementId: string, input: BreakdownDecisionInput) => void;
  onFinalize: () => void;
  onDiscard: () => void;
  onGenerationBrief: (requirementId: string) => void;
}): React.JSX.Element {
  /* 需求卡上的动作与底部条同一个来源：能不能决定只有一处判断。 */
  const canDecide = decideBar.kind === "decide";
  const summary = summarizeRequirements(state.requirements);
  const retrievalCount = state.requirements.length - summary.matchedCount - summary.partiallyMatchedCount - summary.missingCount;
  const filtered = filterRequirements(state.requirements, filter);
  const groups = groupRequirementsByLane(filtered, laneVocabularySnapshot());

  return (
    <>
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm text-ink-1">
            {summary.requirementCount} 项需求 · 已有 {summary.matchedCount} · 部分满足 {summary.partiallyMatchedCount} · 缺失{" "}
            {summary.missingCount}
            {retrievalCount > 0 ? ` · 暂不可查 ${retrievalCount}` : ""} · 待决定 {summary.needsDecisionCount}
          </span>
          <div className="ml-auto flex gap-1" role="group" aria-label="需求过滤">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => onFilterChange(tab.key)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  filter === tab.key ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:bg-surface-2",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {groups.length === 0 ? (
        <EmptyState title="这个过滤下没有需求" description="换个过滤看看。" />
      ) : (
        groups.map((group) => (
          <section key={`${group.domainId}-${group.laneKey}`} className="flex flex-col gap-2" aria-label={`${group.domainLabel} · ${group.laneLabel}`}>
            <h2 className="text-xs font-medium text-ink-3">
              {group.domainLabel} · {group.laneLabel}
            </h2>
            {group.items.map((requirement) => {
              const expanded = expandedReqIds.has(requirement.id);
              const loadedCandidates = expanded
                ? requirement.match.candidates
                : requirement.match.candidates.slice(0, BREAKDOWN_EMBEDDED_CANDIDATE_COUNT);
              return (
                <RequirementCard
                  key={requirement.id}
                  requirement={requirement}
                  laneLabel={group.laneLabel}
                  scopeKind={state.run.scope.kind}
                  loadedCandidates={loadedCandidates}
                  remainingCount={requirement.match.candidates.length - loadedCandidates.length}
                  onLoadMore={expanded ? null : () => onExpand(requirement.id)}
                  showActions
                  canDecide={canDecide}
                  finalized={false}
                  highlighted={Boolean(incompleteIds?.includes(requirement.id))}
                  onDecide={onDecide}
                  onGenerationBrief={onGenerationBrief}
                />
              );
            })}
          </section>
        ))
      )}

      {/* 底部固定条：一屏 primary ≤1——只有「确认并采用」；三种说法互斥，同屏只出一条。
          权限没落地时只说「还没读到」，不许同时再挂一句「只有负责人和编辑能确认采用」。 */}
      {decideBar.kind === "decide" ? (
        <div className="sticky bottom-4 z-30 flex flex-wrap items-center gap-3 rounded-lg border border-border-1 bg-surface-1/95 px-4 py-3 shadow-[0_-8px_24px_-16px_oklch(0_0_0/0.6)] backdrop-blur">
          <span className={cn("text-sm", incompleteIds && incompleteIds.length > 0 ? "text-danger" : "text-ink-2")}>
            {summary.needsDecisionCount > 0 ? `还有 ${summary.needsDecisionCount} 项待决定` : "全部需求已决定"}
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="danger-outline" size="sm" onClick={onDiscard}>
              放弃这次拆解
            </Button>
            <Button variant="primary" size="sm" icon={<CheckCircle />} onClick={onFinalize}>
              确认并采用
            </Button>
          </div>
        </div>
      ) : decideBar.kind === "pending" ? (
        <div className="sticky bottom-4 z-30 flex flex-wrap items-center gap-3 rounded-lg border border-border-1 bg-surface-1/95 px-4 py-3 backdrop-blur">
          <CapabilityActionSlot state={decideBar.capabilities} label="确认并采用" />
        </div>
      ) : (
        <div className="sticky bottom-4 z-30 rounded-lg border border-border-1 bg-surface-1/95 px-4 py-3 backdrop-blur">
          <span className="text-sm text-ink-2">{BREAKDOWN_VIEWER_NOTE}</span>
        </div>
      )}
    </>
  );
}

/* ---------- 幕 5 · 完成（confirmed）：结果摘要 + 去向（primary 只 1 个） ---------- */

function ConfirmedAct({
  state,
  expandedReqIds,
  onExpand,
}: {
  state: RehearsalRunState;
  expandedReqIds: ReadonlySet<string>;
  onExpand: (requirementId: string) => void;
}): React.JSX.Element {
  const result = state.result;
  const groups = groupRequirementsByLane(state.requirements, laneVocabularySnapshot());
  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle className="size-5" aria-hidden="true" />
            <strong className="text-sm">这次拆解已确认采用</strong>
          </div>
          <p className="text-sm text-ink-2">
            {confirmedResultCopy(state.run.scope.kind, {
              requirements: result?.requirementIds.length ?? 0,
              fulfillments: result?.fulfillmentIds.length ?? 0,
              controlRefs: result?.controlPackageRefIds.length ?? 0,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            {state.primaryDestination ? (
              <Button variant="primary" icon={<ArrowRight />} onClick={() => navigate(state.primaryDestination!.path)}>
                {state.primaryDestination.label}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => navigate(state.returnDestination.path)}>
              {state.returnDestination.label}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 「候选 ≠ 成员」：finalize 成功后「待采用」才换「已采用」，清单只读 */}
      {groups.map((group) => (
        <section key={`${group.domainId}-${group.laneKey}`} className="flex flex-col gap-2" aria-label={`${group.domainLabel} · ${group.laneLabel}`}>
          <h2 className="text-xs font-medium text-ink-3">
            {group.domainLabel} · {group.laneLabel}
          </h2>
          {group.items.map((requirement) => {
            const expanded = expandedReqIds.has(requirement.id);
            const loadedCandidates = expanded
              ? requirement.match.candidates
              : requirement.match.candidates.slice(0, BREAKDOWN_EMBEDDED_CANDIDATE_COUNT);
            return (
              <RequirementCard
                key={requirement.id}
                requirement={requirement}
                laneLabel={group.laneLabel}
                scopeKind={state.run.scope.kind}
                loadedCandidates={loadedCandidates}
                remainingCount={requirement.match.candidates.length - loadedCandidates.length}
                onLoadMore={expanded ? null : () => onExpand(requirement.id)}
                showActions={false}
                canDecide={false}
                finalized
                highlighted={false}
                onDecide={() => undefined}
                onGenerationBrief={() => undefined}
              />
            );
          })}
        </section>
      ))}
    </>
  );
}
