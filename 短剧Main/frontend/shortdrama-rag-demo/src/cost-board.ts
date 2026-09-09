/**
 * 板09 消耗看板纯逻辑：后端聚合数据 → 页面视图模型的全部映射。
 *
 * 本模块不 import React/CSS，供页面与 node:test 复用；
 * 单位文案一律走 ./cost-units token，页面禁止写死单位与换算。
 *
 * 后端事实：
 * - GET /api/v1/dashboard/summary  → costs.by_user 只有 image/video/total，
 *   没有 other 拆分与实际消耗（降级显示「—」，不推算）。
 * - GET /api/v1/projects/:id/costs?group_by=day|member|model → operations 聚合
 *   契约 CostAggregatePage（key/label/chargedPoints/unpricedCount/entryCount + totals，
 *   形状见 ./operations）；逐笔明细走 consumption records，不经本模块。
 *
 * S75：项目消耗页迁到 operations 聚合契约（方案 A）——旧 totals/by_user/by_date/
 * by_episode 四组聚合与 attempts 推导随契约切换删净，「按集」视图整块下线。
 */

import type { CostAggregatePage, CostAggregateRow } from "./operations";
import type { DashboardCostSummary } from "./types";

/* ---------- 参与用户表（数据看板 · 全局口径） ---------- */

/** 表格视图行：null = 后端未对接该字段，UI 显示「—」并注明，不编数。 */
export interface UserCostRow {
  key: string;
  name: string;
  imageFen: number | null;
  videoFen: number | null;
  otherFen: number | null;
  estimatedFen: number | null;
  actualFen: number | null;
}

/** 全局 summary by_user → 表格行（无「其他」拆分、无实际消耗 → null 降级）。 */
export function mapGlobalUserCosts(users: DashboardCostSummary["by_user"]): UserCostRow[] {
  return users.map((item) => ({
    key: item.user_id,
    name: item.user_name,
    imageFen: item.image_estimated_cost_fen,
    videoFen: item.video_estimated_cost_fen,
    otherFen: null,
    estimatedFen: item.total_estimated_cost_fen,
    actualFen: null,
  }));
}

export interface UserCostTotals {
  imageFen: number | null;
  videoFen: number | null;
  otherFen: number | null;
  estimatedFen: number | null;
  actualFen: number | null;
}

/** 末行「合计」：逐列求和；该列全部缺失（null）时合计也为 null，不造 0。 */
export function sumUserCostRows(rows: UserCostRow[]): UserCostTotals {
  return {
    imageFen: sumNullable(rows.map((row) => row.imageFen)),
    videoFen: sumNullable(rows.map((row) => row.videoFen)),
    otherFen: sumNullable(rows.map((row) => row.otherFen)),
    estimatedFen: sumNullable(rows.map((row) => row.estimatedFen)),
    actualFen: sumNullable(rows.map((row) => row.actualFen)),
  };
}

export type UserCostScope = "global" | "none";

export interface UserCostResolution {
  scope: UserCostScope;
  rows: UserCostRow[];
}

/**
 * 参与用户表口径裁决：全局 summary 有 per-user 聚合就用；
 * 没有 → none（明示降级，不拿别的维度冒充）。
 */
export function resolveUserCostRows(
  globalCosts: Pick<DashboardCostSummary, "by_user"> | null | undefined,
): UserCostResolution {
  if (Array.isArray(globalCosts?.by_user)) {
    return { scope: "global", rows: mapGlobalUserCosts(globalCosts.by_user) };
  }
  return { scope: "none", rows: [] };
}

/* ---------- 总计卡组（数据看板） ---------- */

export interface CostTotalCards {
  /** 总消耗（成功任务估价合计；不可推导时为 null，显示 — 不编造）。 */
  totalFen: number | null;
  imageFen: number | null;
  videoFen: number | null;
  /** 其他（AI 辅助）。 */
  otherFen: number | null;
  /** 预估费用（全部尝试估价合计，单位 fen，格式化走 token）。 */
  estimatedYuanFen: number | null;
}

/** 全局 summary 总计卡：无逐任务状态，成功任务拆分不可得 → 总消耗 null 降级（不拿全部尝试冒充）。 */
export function globalTotalCards(costs: DashboardCostSummary): CostTotalCards {
  return {
    totalFen: null,
    imageFen: costs.image_estimated_cost_fen,
    videoFen: costs.video_estimated_cost_fen,
    otherFen: null,
    estimatedYuanFen: costs.total_estimated_cost_fen,
  };
}

/* ---------- 按日期条形视图（数据看板 · 全局口径） ---------- */

/** 全局 summary by_date 的页面侧桶（1:1 改名，不衍生数值）。 */
export interface DateCostBucket {
  date: string;
  tasks: number;
  total_estimated_cost_fen: number;
}

export interface CostBarRow {
  key: string;
  label: string;
  fen: number;
  tasks: number;
  /** 占本组最大值的比例 0..1，驱动条宽。 */
  share: number;
}

/** 全局 summary by_date 字段名映射（estimated_cost_fen → total_estimated_cost_fen，1:1 改名）。 */
export function mapGlobalDateCosts(rows: DashboardCostSummary["by_date"]): DateCostBucket[] {
  return rows.map((row) => ({ date: row.date, tasks: row.tasks, total_estimated_cost_fen: row.estimated_cost_fen }));
}

/** 按日期桶 → 条形行（label 取 M/D）。字段缺失返回 null → 页面降级明示。 */
export function buildDateBars(rows: DateCostBucket[] | null | undefined): CostBarRow[] | null {
  if (!Array.isArray(rows)) return null;
  const max = Math.max(1, ...rows.map((row) => nonNegative(row.total_estimated_cost_fen)));
  return rows.map((row) => ({
    key: row.date,
    label: shortDate(row.date),
    fen: nonNegative(row.total_estimated_cost_fen),
    tasks: row.tasks,
    share: nonNegative(row.total_estimated_cost_fen) / max,
  }));
}

/* ---------- 项目消耗三视图（operations 聚合契约，S75） ---------- */

/**
 * 空态判定：三视图任一 totals.entryCount > 0 即非空。
 * 只看 totals 不看 rows——分页时 rows 可以为空但 total > 0，按 rows 判空会误报。
 */
export function aggregateHasNoConsumption(pages: ReadonlyArray<Pick<CostAggregatePage, "totals">>): boolean {
  return pages.every((page) => page.totals.entryCount === 0);
}

/** 按日期聚合行 → 条形行：先按 key（YYYY-MM-DD）升序，label 取 M/D，share 按组内最大归一。 */
export function buildAggregateDayBars(rows: CostAggregateRow[]): CostBarRow[] {
  const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  const max = Math.max(1, ...sorted.map((row) => nonNegative(row.chargedPoints)));
  return sorted.map((row) => ({
    key: row.key,
    label: shortDate(row.key),
    fen: nonNegative(row.chargedPoints),
    tasks: row.entryCount,
    share: nonNegative(row.chargedPoints) / max,
  }));
}

/* ---------- 内部小工具 ---------- */

function sumNullable(values: Array<number | null>): number | null {
  let sum: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    sum = (sum ?? 0) + value;
  }
  return sum;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function shortDate(value: string): string {
  const [, month = "", day = ""] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}
