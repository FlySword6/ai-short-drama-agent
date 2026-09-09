/**
 * 项目成本展示只消费 migration 016 的 `cost_entries` 账本视图。
 *
 * 账本视图刻意不带镜头、提示词、媒体类型和供应商实际账单。这里绝不反查
 * generation_attempts / generation_quotes 来“补齐”成本，避免重新制造第二套
 * 记账口径；缺失维度会明确作为兼容性缺口返回给调用方。
 */

export interface ProjectCostRow {
  entryId: string;
  sourceTable: string;
  sourceId: string;
  kind: "generation" | "ai_call";
  userId: string;
  userName: string;
  model: string;
  chargedPoints: number;
  isUnpriced: boolean;
  createdAt: Date;
}

export interface ProjectCostBucket {
  /** 兼容旧接口字段名：现在表示账本条目数，不是 provider attempt 数。 */
  tasks: number;
  /** cost_entries 尚无 media_kind，不能诚实拆出图片/视频。 */
  imageEstimatedCostFen: number | null;
  videoEstimatedCostFen: number | null;
  otherEstimatedCostFen: number | null;
  /** 兼容旧接口字段名：等于 chargedPoints。 */
  totalEstimatedCostFen: number;
  /** provider 实际账单不在账本视图中，不能伪装成已确认。 */
  actualCostFen: null;
  chargedPoints: number;
  unpricedCount: number;
}

export interface ProjectCostSummary {
  totals: ProjectCostBucket;
  byUser: Array<ProjectCostBucket & { userId: string; userName: string }>;
  byDate: Array<ProjectCostBucket & { date: string }>;
  /** 账本视图尚无 episode_id，保留空数组而非猜测分集。 */
  byEpisode: Array<ProjectCostBucket & {
    episodeId: string | null;
    episodeNo: number | null;
    episodeName: string | null;
  }>;
  byModel: Array<ProjectCostBucket & { model: string }>;
  compatibilityGaps: readonly string[];
}

export const COST_ENTRIES_COMPATIBILITY_GAPS = [
  "成本账本尚未提供 media_kind，图片、视频和其他类型的拆分暂不可用。",
  "成本账本尚未提供 episode_id，按集成本暂不可用。",
  "成本账本不包含生成尝试状态、提示词、参数或供应商实际账单；这些字段不会被伪造。",
] as const;

interface MutableBucket {
  tasks: number;
  chargedPoints: number;
  unpricedCount: number;
}

export function buildProjectCostSummary(rows: ProjectCostRow[]): ProjectCostSummary {
  const totals = emptyBucket();
  const users = new Map<string, MutableBucket & { userId: string; userName: string }>();
  const dates = new Map<string, MutableBucket & { date: string }>();
  const models = new Map<string, MutableBucket & { model: string }>();

  for (const row of rows) {
    addRow(totals, row);

    const user = users.get(row.userId) ?? {
      ...emptyBucket(),
      userId: row.userId,
      userName: row.userName,
    };
    addRow(user, row);
    users.set(row.userId, user);

    const dateKey = row.createdAt.toISOString().slice(0, 10);
    const date = dates.get(dateKey) ?? { ...emptyBucket(), date: dateKey };
    addRow(date, row);
    dates.set(dateKey, date);

    const model = models.get(row.model) ?? { ...emptyBucket(), model: row.model };
    addRow(model, row);
    models.set(row.model, model);
  }

  return {
    totals: finalizeBucket(totals),
    byUser: [...users.values()]
      .map(({ userId, userName, ...bucket }) => ({ userId, userName, ...finalizeBucket(bucket) }))
      .sort((a, b) => b.chargedPoints - a.chargedPoints || a.userName.localeCompare(b.userName)),
    byDate: [...dates.values()]
      .map(({ date, ...bucket }) => ({ date, ...finalizeBucket(bucket) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byEpisode: [],
    byModel: [...models.values()]
      .map(({ model, ...bucket }) => ({ model, ...finalizeBucket(bucket) }))
      .sort((a, b) => b.chargedPoints - a.chargedPoints || a.model.localeCompare(b.model)),
    compatibilityGaps: COST_ENTRIES_COMPATIBILITY_GAPS,
  };
}

function emptyBucket(): MutableBucket {
  return { tasks: 0, chargedPoints: 0, unpricedCount: 0 };
}

function addRow(bucket: MutableBucket, row: ProjectCostRow): void {
  bucket.tasks += 1;
  bucket.chargedPoints += nonNegativeInteger(row.chargedPoints);
  if (row.isUnpriced) bucket.unpricedCount += 1;
}

function finalizeBucket(bucket: MutableBucket): ProjectCostBucket {
  return {
    tasks: bucket.tasks,
    imageEstimatedCostFen: null,
    videoEstimatedCostFen: null,
    otherEstimatedCostFen: null,
    totalEstimatedCostFen: bucket.chargedPoints,
    actualCostFen: null,
    chargedPoints: bucket.chargedPoints,
    unpricedCount: bucket.unpricedCount,
  };
}

function nonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
