/**
 * `cost_entries` intentionally does not expose `media_kind`.  The public
 * records therefore distinguish the two ledger sources only.  Legacy image /
 * video query values are accepted at the HTTP boundary so callers receive a
 * clear migration error instead of silently getting an incorrect result.
 */
export const CONSUMPTION_TASK_TYPES = ["generation", "ai_assist", "image", "video"] as const;
export type ConsumptionTaskTypeFilter = typeof CONSUMPTION_TASK_TYPES[number];
export type ConsumptionTaskType = "generation" | "ai_assist";

export interface ConsumptionRecordFilter {
  projectId?: string;
  from?: Date;
  to?: Date;
  taskType?: ConsumptionTaskTypeFilter;
  model?: string;
  page: number;
  pageSize: number;
}

export interface ConsumptionRecord {
  createdAt: Date;
  taskType: ConsumptionTaskType;
  modelDisplayName: string;
  /** cost_entries has no episode/prompt dimensions; null means unavailable. */
  episodeNo: null;
  promptExcerpt: null;
  taskId: string;
  /** 1 point equals 1 fen. */
  points: number;
  projectName: string | null;
  sourceTable: string;
  sourceId: string;
  isUnpriced: boolean;
}

export interface ConsumptionRecordPage {
  records: ConsumptionRecord[];
  total: number;
  page: number;
  pageSize: number;
  compatibilityGaps: readonly string[];
}

export const CONSUMPTION_COST_ENTRIES_COMPATIBILITY_GAPS = [
  "成本账本没有 media_kind，不能按图片或视频筛选。",
  "成本账本没有 episode_id 与提示词，明细不会伪造分集或提示词。",
] as const;

// ---------------------------------------------------------------------------
// 段落级累计消耗 (规划文档 §4.2 / §5.3)
// 数据源: cost_entries 视图 JOIN generation_requests → shots 取 scene_id
// ---------------------------------------------------------------------------

export interface SceneConsumptionBreakdownItem {
  kind: string;
  model: string;
  chargedPoints: number;
  requestCount: number;
}

export interface SceneConsumptionSummary {
  totalCostPoints: number;
  requestCount: number;
  breakdownByKind: SceneConsumptionBreakdownItem[];
}
