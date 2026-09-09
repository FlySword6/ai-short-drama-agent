/* ============================================================
   consumption-records.ts — 消耗逐笔明细（E 包 · 纯逻辑，不引 CSS/DOM）

   合同形状（附录三，Sol 实现后直连；未就位时 404/501 降级示例数据并明示）：
     GET /api/v1/projects/:project_id/consumption/records
       ?from=&to=&task_type=&model=&page=1&page_size=20
     → { records: [{ created_at, task_type, model_display_name, episode_no,
         prompt_excerpt, task_id, points }], total, page, page_size }
     全局版（数据看板用）：GET /api/v1/consumption/records 同形状加 project_name。
   ============================================================ */

import { ApiClientError, api } from "./api";

export type ConsumptionTaskType = "image" | "video" | "audio" | "other";

export interface ConsumptionRecord {
  created_at: string;
  task_type: ConsumptionTaskType;
  model_display_name: string;
  episode_no: number | null;
  prompt_excerpt: string;
  task_id: string;
  points: number;
}

export interface ConsumptionRecordsPage {
  records: ConsumptionRecord[];
  total: number;
  page: number;
  page_size: number;
}

export interface ConsumptionRecordFilters {
  from?: string;
  to?: string;
  taskType?: ConsumptionTaskType | "";
  model?: string;
}

export const CONSUMPTION_PAGE_SIZE = 20;

export function taskTypeLabel(taskType: ConsumptionTaskType): string {
  if (taskType === "image") return "图片生成";
  if (taskType === "video") return "视频生成";
  if (taskType === "audio") return "音频生成";
  return "其他";
}

/** 明细筛选：日期闭区间（按 created_at 日期部分比较）+ 类型 + 模型显示名。 */
export function filterConsumptionRecords(
  records: readonly ConsumptionRecord[],
  filters: ConsumptionRecordFilters,
): ConsumptionRecord[] {
  const from = filters.from?.trim() ?? "";
  const to = filters.to?.trim() ?? "";
  return records.filter((record) => {
    const day = record.created_at.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (filters.taskType && record.task_type !== filters.taskType) return false;
    if (filters.model && record.model_display_name !== filters.model) return false;
    return true;
  });
}

/** 分页：页码越界收敛到末页（筛选变严后不会停在空白页）。 */
export function paginateConsumptionRecords(
  records: readonly ConsumptionRecord[],
  page: number,
  pageSize: number = CONSUMPTION_PAGE_SIZE,
): ConsumptionRecordsPage {
  const total = records.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  return {
    records: records.slice((safePage - 1) * pageSize, safePage * pageSize),
    total,
    page: safePage,
    page_size: pageSize,
  };
}

/** 模型筛选下拉的候选（按出现顺序去重）。 */
export function distinctModels(records: readonly ConsumptionRecord[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const record of records) {
    if (seen.has(record.model_display_name)) continue;
    seen.add(record.model_display_name);
    models.push(record.model_display_name);
  }
  return models;
}

/** CSV 导出（带 BOM，Excel 打开不乱码；字段含公式前缀的按文本转义）。 */
export function consumptionRecordsCsv(records: readonly ConsumptionRecord[]): string {
  const escapeCell = (value: string): string => {
    // 公式前缀转义只对多字符值生效（单独的 "-" 占位符不动）
    const safe = value.length > 1 && /^[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const header = "消耗时间,任务类型,模型,集,任务详情,任务 ID,消耗积分";
  const rows = records.map((record) => [
    record.created_at,
    taskTypeLabel(record.task_type),
    record.model_display_name,
    record.episode_no === null ? "-" : `第 ${record.episode_no} 集`,
    record.prompt_excerpt,
    record.task_id,
    String(record.points),
  ].map(escapeCell).join(","));
  return `﻿${[header, ...rows].join("\n")}`;
}

/* ---------- 示例数据（demo / 接口未就位降级；形状与合同逐字段一致） ---------- */

const DEMO_MODELS: ReadonlyArray<readonly [ConsumptionTaskType, string, number]> = [
  ["video", "Seedance 2.0", 12500],
  ["image", "Seedream 4.5", 520],
  ["video", "Seedance 2.0 Fast", 4800],
  ["image", "Seedream 4.0", 380],
];

const DEMO_EXCERPTS: readonly string[] = [
  "任天野骑在照夜玉狮子上，银甲染血，从边军后方走出",
  "夜雨巷口，灯笼摇晃，李承瑶撑伞回头",
  "北疆战场黄昏，大军压境，旗帜猎猎",
  "军营帐内，烛火摇曳，密信摊在案上",
  "府衙正堂，惊堂木落下，众人跪伏",
  "雪夜独行，斗篷猎猎，远处灯火一点",
];

/** 示例明细：28 条跨 14 天（演示分页/筛选；日期以今天为锚向前推）。 */
export function demoConsumptionRecords(now: Date = new Date()): ConsumptionRecord[] {
  const records: ConsumptionRecord[] = [];
  for (let index = 0; index < 28; index += 1) {
    const [taskType, model, points] = DEMO_MODELS[index % DEMO_MODELS.length]!;
    const day = new Date(now.getTime() - Math.floor(index / 2) * 86_400_000);
    const hour = 9 + (index % 8);
    const created = new Date(day.getTime());
    created.setHours(hour, (index * 17) % 60, 0, 0);
    records.push({
      created_at: created.toISOString(),
      task_type: taskType,
      model_display_name: model,
      episode_no: (index % 3) + 1,
      prompt_excerpt: DEMO_EXCERPTS[index % DEMO_EXCERPTS.length]!,
      task_id: `task_${(8_421_000 + index * 137).toString(16)}`,
      points: points + (index % 3) * 40,
    });
  }
  return records;
}

export interface ConsumptionRecordsQuery extends ConsumptionRecordFilters {
  page: number;
  pageSize?: number;
}

export interface ConsumptionRecordsPageResult extends ConsumptionRecordsPage {
  /** true=示例数据（demo 或接口 404/501 降级），界面底部明示一次。 */
  degraded: boolean;
}

/** 导出全量拉取的每页条数：后端 page_size 上限 100（modules/consumption-records/routes.ts zod max(100)），超了直接 400。 */
export const CONSUMPTION_EXPORT_PAGE_SIZE = 100;

/** 服务端原始行 → 合同形状（防御式取值；字段缺失给可读兜底，不抛）。 */
function consumptionRecordFromRaw(value: Record<string, unknown>, index: number): ConsumptionRecord {
  const taskType = value.task_type === "image" || value.task_type === "video" || value.task_type === "audio" ? value.task_type : "other";
  return {
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    task_type: taskType,
    model_display_name: typeof value.model_display_name === "string" ? value.model_display_name : "未知模型",
    episode_no: typeof value.episode_no === "number" ? value.episode_no : null,
    prompt_excerpt: typeof value.prompt_excerpt === "string" ? value.prompt_excerpt : "",
    task_id: typeof value.task_id === "string" ? value.task_id : `unknown-${index}`,
    points: typeof value.points === "number" && Number.isFinite(value.points) ? value.points : 0,
  };
}

/** demo/降级路径：在示例数据上模拟服务端语义（先筛选后分页），与真栈同形状。 */
function demoPage(query: ConsumptionRecordsQuery): ConsumptionRecordsPageResult {
  const filtered = filterConsumptionRecords(demoConsumptionRecords(), query);
  return { ...paginateConsumptionRecords(filtered, query.page, query.pageSize ?? CONSUMPTION_PAGE_SIZE), degraded: true };
}

/**
 * 明细拉取（服务端真分页）：筛选与页码全量透传合同端点；
 * 404/501（Sol 未就位）降级示例数据（本地模拟同语义）；其余错误（网络/5xx/400）原样抛出交页面错误态。
 */
export async function listConsumptionRecords(projectId: string, demoMode: boolean, query: ConsumptionRecordsQuery): Promise<ConsumptionRecordsPageResult> {
  const pageSize = query.pageSize ?? CONSUMPTION_PAGE_SIZE;
  if (demoMode) return demoPage(query);
  try {
    const page = await api.consumptionRecords(projectId, {
      from: query.from || undefined,
      to: query.to || undefined,
      task_type: query.taskType || undefined,
      model: query.model || undefined,
      page: query.page,
      page_size: pageSize,
    });
    return {
      records: page.records.map(consumptionRecordFromRaw),
      total: page.total,
      page: page.page,
      page_size: page.page_size,
      degraded: false,
    };
  } catch (reason) {
    if (reason instanceof ApiClientError && (reason.status === 404 || reason.status === 501)) {
      return demoPage(query);
    }
    throw reason;
  }
}

/** CSV 导出：按当前筛选逐页拉全量（每页 100=后端上限；demo/降级同样形状直连）。 */
export async function listAllConsumptionRecords(projectId: string, demoMode: boolean, filters: ConsumptionRecordFilters): Promise<{ records: ConsumptionRecord[]; degraded: boolean }> {
  const first = await listConsumptionRecords(projectId, demoMode, { ...filters, page: 1, pageSize: CONSUMPTION_EXPORT_PAGE_SIZE });
  if (first.total <= first.records.length) return { records: first.records, degraded: first.degraded };
  const pageCount = Math.ceil(first.total / CONSUMPTION_EXPORT_PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      listConsumptionRecords(projectId, demoMode, { ...filters, page: index + 2, pageSize: CONSUMPTION_EXPORT_PAGE_SIZE })),
  );
  return {
    records: [...first.records, ...rest.flatMap((page) => page.records)],
    degraded: first.degraded || rest.some((page) => page.degraded),
  };
}
