/**
 * 全局看板成本摘要。
 *
 * 此处的金额只来自 cost_entries；任务状态、媒体类型和供应商账单不属于
 * 成本账本视图，所以返回 null/兼容性说明，而不是拿旧表补算。
 */

export interface DashboardCostRow {
  projectId: string;
  projectName: string;
  userId: string;
  userName: string;
  kind: "generation" | "ai_call";
  chargedPoints: number;
  isUnpriced: boolean;
  createdAt: Date;
}

export interface DashboardSummary {
  notice: "已记账积分，来源于成本账本";
  /** 兼容旧字段：现在是账本条目数。 */
  totalTasks: number;
  /** 账本不含任务状态，保持 null 而不是伪造 0。 */
  succeededTasks: null;
  activeTasks: null;
  failedTasks: null;
  /** 账本没有 media_kind，不能诚实拆分。 */
  imageEstimatedCostFen: null;
  videoEstimatedCostFen: null;
  /** 兼容旧字段：现在等于 totalChargedPoints。 */
  totalEstimatedCostFen: number;
  totalChargedPoints: number;
  unpricedCount: number;
  byProject: Array<{
    projectId: string;
    projectName: string;
    tasks: number;
    succeeded: null;
    failed: null;
    estimatedCostFen: number;
    chargedPoints: number;
    unpricedCount: number;
  }>;
  byUser: Array<{
    userId: string;
    userName: string;
    imageEstimatedCostFen: null;
    videoEstimatedCostFen: null;
    totalEstimatedCostFen: number;
    chargedPoints: number;
    unpricedCount: number;
  }>;
  byDate: Array<{
    date: string;
    tasks: number;
    estimatedCostFen: number;
    chargedPoints: number;
    unpricedCount: number;
  }>;
  compatibilityGaps: readonly string[];
}

const DASHBOARD_COST_COMPATIBILITY_GAPS = [
  "成本账本没有 media_kind，图片和视频成本拆分暂不可用。",
  "成本账本没有生成状态，成功、进行中和失败任务数暂不可用。",
  "所有金额来自 cost_entries.charged_points；未计价记录单独计数，不换算为金额。",
] as const;

interface MutableBucket {
  tasks: number;
  chargedPoints: number;
  unpricedCount: number;
}

export function buildDashboardSummary(rows: DashboardCostRow[]): DashboardSummary {
  const projectMap = new Map<string, MutableBucket & { projectId: string; projectName: string }>();
  const userMap = new Map<string, MutableBucket & { userId: string; userName: string }>();
  const dateMap = new Map<string, MutableBucket & { date: string }>();
  const totals = emptyBucket();

  for (const row of rows) {
    addRow(totals, row);

    const project = projectMap.get(row.projectId) ?? {
      ...emptyBucket(),
      projectId: row.projectId,
      projectName: row.projectName,
    };
    addRow(project, row);
    projectMap.set(row.projectId, project);

    const user = userMap.get(row.userId) ?? {
      ...emptyBucket(),
      userId: row.userId,
      userName: row.userName,
    };
    addRow(user, row);
    userMap.set(row.userId, user);

    const dateKey = row.createdAt.toISOString().slice(0, 10);
    const day = dateMap.get(dateKey) ?? { ...emptyBucket(), date: dateKey };
    addRow(day, row);
    dateMap.set(dateKey, day);
  }

  return {
    notice: "已记账积分，来源于成本账本",
    totalTasks: totals.tasks,
    succeededTasks: null,
    activeTasks: null,
    failedTasks: null,
    imageEstimatedCostFen: null,
    videoEstimatedCostFen: null,
    totalEstimatedCostFen: totals.chargedPoints,
    totalChargedPoints: totals.chargedPoints,
    unpricedCount: totals.unpricedCount,
    byProject: [...projectMap.values()]
      .map(({ projectId, projectName, ...bucket }) => ({
        projectId,
        projectName,
        ...toProjectBucket(bucket),
      }))
      .sort((a, b) => b.chargedPoints - a.chargedPoints || a.projectName.localeCompare(b.projectName)),
    byUser: [...userMap.values()]
      .map(({ userId, userName, ...bucket }) => ({
        userId,
        userName,
        ...toUserBucket(bucket),
      }))
      .sort((a, b) => b.chargedPoints - a.chargedPoints || a.userName.localeCompare(b.userName)),
    byDate: [...dateMap.values()]
      .map(({ date, ...bucket }) => ({ date, ...toDateBucket(bucket) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    compatibilityGaps: DASHBOARD_COST_COMPATIBILITY_GAPS,
  };
}

function emptyBucket(): MutableBucket {
  return { tasks: 0, chargedPoints: 0, unpricedCount: 0 };
}

function addRow(bucket: MutableBucket, row: DashboardCostRow): void {
  bucket.tasks += 1;
  bucket.chargedPoints += nonNegativeInteger(row.chargedPoints);
  if (row.isUnpriced) bucket.unpricedCount += 1;
}

function toProjectBucket(bucket: MutableBucket) {
  return {
    tasks: bucket.tasks,
    succeeded: null,
    failed: null,
    estimatedCostFen: bucket.chargedPoints,
    chargedPoints: bucket.chargedPoints,
    unpricedCount: bucket.unpricedCount,
  };
}

function toUserBucket(bucket: MutableBucket) {
  return {
    imageEstimatedCostFen: null,
    videoEstimatedCostFen: null,
    totalEstimatedCostFen: bucket.chargedPoints,
    chargedPoints: bucket.chargedPoints,
    unpricedCount: bucket.unpricedCount,
  };
}

function toDateBucket(bucket: MutableBucket) {
  return {
    tasks: bucket.tasks,
    estimatedCostFen: bucket.chargedPoints,
    chargedPoints: bucket.chargedPoints,
    unpricedCount: bucket.unpricedCount,
  };
}

function nonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
