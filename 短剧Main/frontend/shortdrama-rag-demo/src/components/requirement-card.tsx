/* ============================================================
   requirement-card.tsx — 需求卡（K2 彩排包，设计 §3 呈现契约）

   一张卡=一条生产需求：lane 词表名 · 对象称呼 + match 四态 Badge +
   候选列表（内嵌前 5 +「更多候选」展开）+ 三个轻决定按钮。
   呈现纪律（逐字设计 §3）：
   - match 四态视觉区分：已有绿 / 部分满足黄 / 缺失灰（缺失是生产常态，
     不用红）/ 资产库暂不可查蓝；
   - blocker 两层不混：clearance_blocked 等可见候选照常显示但选择置灰
     （原因一行写明）；完全不可见的候选绝不渲染，只给匿名汇总行；
   - 「候选 ≠ 成员」不说谎：决定草稿一律「待采用 · xxx」，只有 finalize
     成功后（finalized=true）才换「已采用」；
   - 已选候选不在已加载集合：中性占位一行，不伪造名字与缩略图
     （resolveSelectedCandidate 唯一收敛点，决策中立）。
   ============================================================ */

import { ImageSquare, VideoCamera } from "@phosphor-icons/react";
import type * as React from "react";

import {
  MATCH_STATUS_META,
  SELECTED_CANDIDATE_PLACEHOLDER,
  acceptActionLabel,
  anonymousHiddenSummary,
  candidateAcceptBlocker,
  decisionDraftLabel,
  resolveSelectedCandidate,
  type BreakdownCandidate,
  type BreakdownDecisionInput,
  type BreakdownRequirement,
  type BreakdownScopeKind,
} from "../requirement-breakdown";
import { Badge } from "./ui/primitives";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

export interface RequirementCardProps {
  requirement: BreakdownRequirement;
  /** lane 词表展示名（未知 lane_key 给原 key，分组层已兜底）。 */
  laneLabel: string;
  scopeKind: BreakdownScopeKind;
  /** 已加载候选集合（页面切片：内嵌前 5，「更多候选」展开后=全量）。 */
  loadedCandidates: readonly BreakdownCandidate[];
  /** 未加载的剩余候选数（>0 时显示「更多候选（N）→」）。 */
  remainingCount: number;
  onLoadMore: (() => void) | null;
  /** draft 状态才显示决定按钮（confirmed/墓碑态只读）。 */
  showActions: boolean;
  /** viewer=false：按钮可见但 disabled（设计 §5）。 */
  canDecide: boolean;
  /** finalize 成功后=true，「待采用」换「已采用」。 */
  finalized: boolean;
  /** 422 未决定项标红。 */
  highlighted: boolean;
  onDecide: (requirementId: string, input: BreakdownDecisionInput) => void;
  onGenerationBrief: (requirementId: string) => void;
}

export function RequirementCard({
  requirement,
  laneLabel,
  scopeKind,
  loadedCandidates,
  remainingCount,
  onLoadMore,
  showActions,
  canDecide,
  finalized,
  highlighted,
  onDecide,
  onGenerationBrief,
}: RequirementCardProps): React.JSX.Element {
  const matchMeta = MATCH_STATUS_META[requirement.match.status];
  const acceptedId = requirement.decision.status === "accepted" ? requirement.decision.selectedCandidateId : null;
  /* 决策中立：已选候选解析只走这一个纯函数——在已加载集合内找到才渲染，
     找不到显中性占位；将来批①（必内嵌）零改动，批②（摘要字段）页面多传一个入参。 */
  const selectedView = acceptedId ? resolveSelectedCandidate({ loadedCandidates, selectedCandidateId: acceptedId }) : null;
  const selectedName =
    selectedView?.kind === "resolved"
      ? selectedView.candidate.displayName
      : selectedView?.kind === "summary"
        ? selectedView.summary.displayName
        : null;
  const draftLabel = decisionDraftLabel(requirement.decision, selectedName, finalized);
  const hiddenSummary = anonymousHiddenSummary(requirement.match.missingReasons);
  const acceptLabel = acceptActionLabel(scopeKind);

  return (
    <article
      id={`breakdown-requirement-${requirement.id}`}
      className={cn("rounded-lg border bg-surface-1 transition-colors", highlighted ? "border-danger" : "border-border-1")}
      aria-label={`${laneLabel} · ${requirement.displayName}`}
    >
      <header className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <span className="text-sm font-medium text-ink-1">
          {laneLabel} · {requirement.displayName}
        </span>
        <Badge tone={matchMeta.tone}>{matchMeta.label}</Badge>
        {draftLabel ? <Badge tone={finalized ? "success" : "accent"}>{draftLabel}</Badge> : null}
        {highlighted ? <span className="text-xs text-danger">这条还没有决定</span> : null}
      </header>
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-sm text-ink-2">需要：{requirement.needDescription}</p>
        {requirement.match.status === "retrieval_unavailable" ? (
          <p className="text-xs text-accent-text">{matchMeta.hint}</p>
        ) : null}

        {loadedCandidates.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {loadedCandidates.map((candidate) => {
              const blocker = candidateAcceptBlocker(scopeKind, candidate);
              const selected = acceptedId === candidate.candidateId;
              return (
                <li
                  key={candidate.candidateId}
                  className={cn(
                    "flex items-center gap-3 rounded-md border px-3 py-2",
                    selected ? "border-accent bg-accent-subtle" : "border-border-1",
                    blocker ? "opacity-70" : "",
                  )}
                >
                  <CandidateThumb candidate={candidate} />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-ink-1">{candidate.displayName}</span>
                    <p className="text-xs text-ink-3">
                      符合：{candidate.matchedAttributes.join("、") || "—"}
                      {candidate.unmetAttributes.length > 0 ? `；还差：${candidate.unmetAttributes.join("、")}` : ""}
                    </p>
                    {blocker ? <p className="text-xs text-warning">{blocker}</p> : null}
                  </div>
                  {showActions ? (
                    <Button
                      size="sm"
                      variant={selected ? "accent" : "secondary"}
                      disabled={!canDecide || Boolean(blocker)}
                      onClick={() => onDecide(requirement.id, { action: "accept_candidate", candidateId: candidate.candidateId })}
                    >
                      {acceptLabel}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : requirement.match.status === "missing" ? (
          <p className="text-xs text-ink-3">没有可见候选{hiddenSummary ? `；${hiddenSummary}` : ""}</p>
        ) : null}

        {remainingCount > 0 && onLoadMore ? (
          <div>
            <Button variant="ghost" size="sm" onClick={onLoadMore}>
              更多候选（{remainingCount}）→
            </Button>
          </div>
        ) : null}

        {loadedCandidates.length > 0 && hiddenSummary ? <p className="text-xs text-ink-3">{hiddenSummary}</p> : null}

        {selectedView?.kind === "placeholder" ? <p className="text-xs text-ink-3">{SELECTED_CANDIDATE_PLACEHOLDER}</p> : null}

        {showActions ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border-1 pt-3">
            <Button
              size="sm"
              variant={requirement.decision.status === "kept_missing" ? "accent" : "ghost"}
              disabled={!canDecide}
              onClick={() => onDecide(requirement.id, { action: "keep_missing" })}
            >
              就缺着
            </Button>
            <Button
              size="sm"
              variant={requirement.decision.status === "dismissed" ? "accent" : "ghost"}
              disabled={!canDecide}
              onClick={() => onDecide(requirement.id, { action: "dismiss" })}
            >
              不需要
            </Button>
            {requirement.decision.status === "kept_missing" && requirement.generationBrief ? (
              <Button size="sm" variant="outline" disabled={!canDecide} onClick={() => onGenerationBrief(requirement.id)}>
                生成制作草稿
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** 候选缩略：有 thumbnail_url 才放图，没有给类型图标占位（不伪造图像）。 */
function CandidateThumb({ candidate }: { candidate: BreakdownCandidate }): React.JSX.Element {
  if (candidate.thumbnailUrl) {
    return <img className="size-10 flex-none rounded-md object-cover" src={candidate.thumbnailUrl} alt={candidate.displayName} loading="lazy" />;
  }
  const Icon = candidate.mediaKind === "video" ? VideoCamera : ImageSquare;
  return (
    <div className="flex size-10 flex-none items-center justify-center rounded-md bg-surface-well text-ink-4">
      <Icon className="size-4" aria-hidden="true" />
    </div>
  );
}
