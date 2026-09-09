/* ============================================================
   prompt-precheck-card.tsx — 提示词预检卡(Phase 3)

   在段落工作台「整段生成确认区」内,开拍/样片展开后调用后端 precheck
   接口,把预检评分维度逐项可视化,帮助用户在提交前了解提示词完备度。

   约束(与规划文档 §6 对齐):
   - 预检不阻止提交(只返回评分和建议);
   - 不调 LLM,纯规则引擎在后端跑;
   - 不涉及支付/扣费。
   ============================================================ */
import { useEffect, useState } from "react";
import { ArrowClockwise, Info, WarningCircle } from "@phosphor-icons/react";

import { api } from "../api";
import type { PrecheckDimensionStatus, PrecheckResult } from "../types";
import { cn } from "./ui/cn";

/* ---------- 维度状态 → 颜色 + 标签 ---------- */

const STATUS_META: Record<PrecheckDimensionStatus, { label: string; color: string; bar: string }> = {
  good: { label: "完备", color: "text-tk-ok", bar: "bg-tk-ok" },
  ok: { label: "基本就绪", color: "text-tk-ink-2", bar: "bg-tk-ink-3" },
  weak: { label: "偏弱", color: "text-amber-600", bar: "bg-amber-400" },
  missing: { label: "缺失", color: "text-danger", bar: "bg-danger" },
};

/* ---------- 主组件 ---------- */

export function PromptPrecheckCard({ projectId, sceneId, shotId, tierId, mediaKind = "video", parameters = {}, referenceMediaIds = [], referenceLaneCount = 0, demoMode }: {
  projectId: string;
  sceneId?: string;
  shotId?: string;
  tierId: string;
  mediaKind?: "image" | "video" | "audio";
  parameters?: Record<string, string | number | boolean>;
  referenceMediaIds?: string[];
  referenceLaneCount?: number;
  demoMode: boolean;
}): React.JSX.Element | null {
  const [result, setResult] = useState<PrecheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (demoMode || !tierId) return; // 离线演示或无档位不调后端
    let cancelled = false;
    setLoading(true);
    setError("");
    void api.precheckGeneration({
      project_id: projectId,
      scene_id: sceneId,
      shot_id: shotId,
      tier_id: tierId,
      media_kind: mediaKind,
      parameters,
      reference_media_ids: referenceMediaIds,
      reference_lane_count: referenceLaneCount,
    }).then((res) => {
      if (cancelled) return;
      setResult(res);
      setLoading(false);
    }).catch((reason) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : "预检失败,请稍后重试");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, sceneId, shotId, tierId, mediaKind, parameters, referenceMediaIds, referenceLaneCount, demoMode, revision]);

  // 离线演示或无档位:不渲染卡片
  if (demoMode || !tierId) return null;

  if (loading && !result) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-tk-border-1 bg-tk-panel px-3 py-2" data-testid="precheck-loading">
        <ArrowClockwise className="h-3.5 w-3.5 animate-spin text-tk-ink-3" />
        <span className="text-[11px] text-tk-ink-3">正在预检提示词完备度…</span>
      </div>
    );
  }

  if (error && !result) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-tk-border-1 bg-tk-panel px-3 py-2" data-testid="precheck-error">
        <WarningCircle className="h-3.5 w-3.5 text-danger" />
        <span className="text-[11px] text-danger">{error}</span>
        <button type="button" className="ml-auto text-[11px] text-tk-ink-3 hover:text-tk-ink-1" onClick={() => setRevision((r) => r + 1)}>重试</button>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-tk-border-1 bg-tk-panel px-3 py-2" data-testid="precheck-card">
      {/* 头部:总分 + 采样效果警示 */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-tk-ink-2">提示词预检</span>
        <span className={cn("font-tkmono text-sm font-bold", overallScoreColor(result.overall_score))}>
          {Math.round(result.overall_score)}
        </span>
        <span className="text-[11px] text-tk-ink-3">/ 100</span>
        {result.estimated_sampling_effect.warning ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-600">
            <WarningCircle className="h-3 w-3" />
            {result.estimated_sampling_effect.message ?? "采样效果可能受影响"}
          </span>
        ) : null}
        <button type="button" className="ml-auto text-[11px] text-tk-ink-3 hover:text-tk-ink-1" onClick={() => setRevision((r) => r + 1)}>刷新</button>
      </div>

      {/* 维度逐项 */}
      <div className="flex flex-col gap-1.5">
        {result.dimensions.map((dim) => {
          const meta = STATUS_META[dim.status] ?? STATUS_META.ok;
          return (
            <div key={dim.key} className="flex items-start gap-2">
              <div className="flex w-20 shrink-0 items-center gap-1">
                <span className={cn("h-1.5 w-1.5 rounded-full", meta.bar)} />
                <span className="text-[11px] text-tk-ink-2">{dim.label}</span>
              </div>
              <div className="flex flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className={cn("text-[11px] font-medium", meta.color)}>{meta.label}</span>
                  <span className="font-tkmono text-[10px] text-tk-ink-3">{Math.round(dim.score)}分 · 权重{dim.weight}</span>
                </div>
                <p className="m-0 text-[10px] leading-3.5 text-tk-ink-3">{dim.detail}</p>
                {dim.suggestion ? (
                  <p className="m-0 text-[10px] leading-3.5 text-amber-600">建议：{dim.suggestion}</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* 编译稿预览 */}
      {result.auto_prompt_preview ? (
        <div className="flex flex-col gap-1 rounded border border-tk-border-2 bg-tk-bg-2 px-2 py-1.5">
          <span className="text-[10px] font-semibold text-tk-ink-3">编译稿预览</span>
          <pre className="m-0 whitespace-pre-wrap break-words font-tkmono text-[10px] leading-3.5 text-tk-ink-2">{result.auto_prompt_preview}</pre>
        </div>
      ) : null}

      {/* 缺失引用 */}
      {result.missing_references.length > 0 ? (
        <div className="flex items-start gap-1 text-[11px] text-tk-ink-3">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>缺参考：{result.missing_references.join("、")}</span>
        </div>
      ) : null}

      {/* 建议 */}
      {result.recommendations.length > 0 ? (
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4">
          {result.recommendations.map((rec, idx) => (
            <li key={idx} className="text-[10px] leading-3.5 text-tk-ink-2">{rec}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ---------- 辅助 ---------- */

function overallScoreColor(score: number): string {
  if (score >= 80) return "text-tk-ok";
  if (score >= 60) return "text-tk-ink-1";
  if (score >= 40) return "text-amber-600";
  return "text-danger";
}
