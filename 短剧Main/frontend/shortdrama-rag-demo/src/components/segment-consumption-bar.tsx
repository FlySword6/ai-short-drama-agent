/* ============================================================
   segment-consumption-bar.tsx — 场景消耗汇总条(Phase 3)

   在段落工作台展示当前场景已消耗的积分汇总,
   按 kind(生图/生视频/生音频)和模型分组,帮助用户在开拍前了解已花多少。

   约束(与规划文档 §6 对齐):
   - 数据源是后端 cost_entries 视图 JOIN generation_requests;
   - 不涉及支付/扣费闸门,只做展示;
   - 不虚构 segment_id,按 project_id + scene_id 聚合。
   ============================================================ */
import { useEffect, useState } from "react";
import { Coins } from "@phosphor-icons/react";

import { api } from "../api";
import type { SceneConsumptionSummary } from "../types";

const KIND_LABEL: Record<string, string> = {
  image: "生图",
  video: "生视频",
  audio: "生音频",
};

export function SegmentConsumptionBar({ projectId, sceneId, demoMode, genTick }: {
  projectId: string;
  sceneId: string;
  demoMode: boolean;
  /** 生成提交后 tick 变化 → 重新拉取。 */
  genTick: number;
}): React.JSX.Element | null {
  const [summary, setSummary] = useState<SceneConsumptionSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (demoMode) return; // 离线演示不调后端
    let cancelled = false;
    setLoading(true);
    setError("");
    void api.getSceneConsumptionSummary(projectId, sceneId).then((res) => {
      if (cancelled) return;
      setSummary(res);
      setLoading(false);
    }).catch((reason) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : "读取消耗记录失败");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, sceneId, demoMode, genTick]);

  if (demoMode) return null;

  if (loading && !summary) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-tk-ink-3" data-testid="consumption-loading">
        <Coins className="h-3 w-3 animate-pulse" />
        <span>正在读取场景消耗…</span>
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-tk-ink-3" data-testid="consumption-error">
        <Coins className="h-3 w-3" />
        <span>{error}</span>
      </div>
    );
  }

  if (!summary || summary.total_cost_points === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-1.5" data-testid="consumption-bar">
      <Coins className="h-3.5 w-3.5 text-tk-ink-3" />
      <span className="text-[11px] text-tk-ink-2">
        本场景已消耗 <strong className="font-tkmono text-tk-ink-1">{summary.total_cost_points}</strong> 积分
      </span>
      <span className="font-tkmono text-[10px] text-tk-ink-3">· {summary.request_count} 次生成</span>
      {/* 按 kind 分项 */}
      <div className="flex items-center gap-1.5">
        {summary.breakdown_by_kind.map((item) => (
          <span
            key={`${item.kind}-${item.model}`}
            className="rounded-full bg-tk-panel px-1.5 py-0.5 text-[10px] text-tk-ink-3"
          >
            {KIND_LABEL[item.kind] ?? item.kind} {item.charged_points}
          </span>
        ))}
      </div>
    </div>
  );
}
