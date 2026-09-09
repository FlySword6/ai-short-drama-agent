/* consumption-records 纯逻辑单测（E 包：合同形状/筛选/分页/CSV/降级） */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSUMPTION_PAGE_SIZE,
  consumptionRecordsCsv,
  demoConsumptionRecords,
  distinctModels,
  filterConsumptionRecords,
  listAllConsumptionRecords,
  listConsumptionRecords,
  paginateConsumptionRecords,
  taskTypeLabel,
  type ConsumptionRecord,
} from "./consumption-records";

function record(overrides: Partial<ConsumptionRecord>): ConsumptionRecord {
  return {
    created_at: "2026-07-20T10:00:00.000Z",
    task_type: "image",
    model_display_name: "Seedream 4.5",
    episode_no: 1,
    prompt_excerpt: "示例",
    task_id: "task_x",
    points: 100,
    ...overrides,
  };
}

test("合同形状：示例数据 28 条，字段逐合同附录三", () => {
  const records = demoConsumptionRecords(new Date("2026-07-22T00:00:00Z"));
  assert.equal(records.length, 28);
  const first = records[0]!;
  for (const key of ["created_at", "task_type", "model_display_name", "episode_no", "prompt_excerpt", "task_id", "points"]) {
    assert.ok(key in first, `缺合同字段 ${key}`);
  }
});

test("筛选：日期闭区间 + 类型 + 模型", () => {
  const records = [
    record({ created_at: "2026-07-18T10:00:00.000Z", task_type: "image", model_display_name: "A" }),
    record({ created_at: "2026-07-20T10:00:00.000Z", task_type: "video", model_display_name: "B" }),
    record({ created_at: "2026-07-22T10:00:00.000Z", task_type: "video", model_display_name: "B" }),
  ];
  assert.equal(filterConsumptionRecords(records, { from: "2026-07-20", to: "2026-07-20" }).length, 1);
  assert.equal(filterConsumptionRecords(records, { from: "2026-07-19" }).length, 2);
  assert.equal(filterConsumptionRecords(records, { to: "2026-07-19" }).length, 1);
  assert.equal(filterConsumptionRecords(records, { taskType: "video" }).length, 2);
  assert.equal(filterConsumptionRecords(records, { model: "A" }).length, 1);
  assert.equal(filterConsumptionRecords(records, { taskType: "video", from: "2026-07-21" }).length, 1);
});

test("分页：页码越界收敛到末页，空结果给第 1 页", () => {
  const records = Array.from({ length: 45 }, (_, index) => record({ task_id: `t${index}` }));
  const page1 = paginateConsumptionRecords(records, 1);
  assert.equal(page1.records.length, CONSUMPTION_PAGE_SIZE);
  assert.equal(page1.total, 45);
  const page9 = paginateConsumptionRecords(records, 9);
  assert.equal(page9.page, 3, "越界收敛到末页");
  assert.equal(page9.records.length, 5);
  const empty = paginateConsumptionRecords([], 3);
  assert.equal(empty.page, 1);
  assert.equal(empty.records.length, 0);
});

test("CSV：表头中文 + BOM + 引号/公式前缀转义", () => {
  const csv = consumptionRecordsCsv([
    record({ prompt_excerpt: '带"引号"的提示词', task_id: "=cmd" }),
    record({ task_type: "video", episode_no: null, points: 12500 }),
  ]);
  assert.ok(csv.charCodeAt(0) === 0xfeff, "缺 BOM");
  const lines = csv.slice(1).split("\n");
  assert.equal(lines[0], "消耗时间,任务类型,模型,集,任务详情,任务 ID,消耗积分");
  assert.ok(lines[1]!.includes('"带""引号""的提示词"'));
  assert.ok(lines[1]!.includes('"' + "'=cmd" + '"'), "公式前缀按文本转义");
  assert.ok(lines[2]!.includes('"-"'), "无集给占位");
  assert.ok(lines[2]!.includes('"12500"'));
});

test("辅助：类型标签与模型去重", () => {
  assert.equal(taskTypeLabel("image"), "图片生成");
  assert.equal(taskTypeLabel("video"), "视频生成");
  assert.equal(taskTypeLabel("other"), "其他");
  assert.deepEqual(distinctModels([record({ model_display_name: "A" }), record({ model_display_name: "B" }), record({ model_display_name: "A" })]), ["A", "B"]);
});

/* ---------- H 线 P0-3：服务端真分页（筛选透传 / 降级 / 导出全量循环） ---------- */

test("listConsumptionRecords：筛选与分页参数全量透传合同端点，响应归一", async () => {
  await withMockApi(async ({ items, respondWith }) => {
    respondWith({
      records: [
        { created_at: "2026-07-20T10:00:00.000Z", task_type: "video", model_display_name: "Seedance 2.0", episode_no: 3, prompt_excerpt: "夜雨", task_id: "task_1", points: 12500 },
        { created_at: "2026-07-20T11:00:00.000Z", task_type: "sound", model_display_name: "未知", episode_no: null, prompt_excerpt: "", task_id: "task_2", points: 10 },
      ],
      total: 45,
      page: 2,
      page_size: 20,
    });
    const result = await listConsumptionRecords("p1", false, { from: "2026-07-01", to: "2026-07-31", taskType: "video", model: "Seedance 2.0", page: 2 });
    assert.equal(items[0]?.url, "/api/v1/projects/p1/consumption/records?from=2026-07-01&to=2026-07-31&task_type=video&model=Seedance+2.0&page=2&page_size=20");
    assert.equal(result.degraded, false);
    assert.equal(result.total, 45);
    assert.equal(result.page, 2);
    assert.equal(result.page_size, 20);
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0]?.task_type, "video");
    // 未知任务类型防御式并入 other，不抛
    assert.equal(result.records[1]?.task_type, "other");
  });
});

test("listConsumptionRecords：404/501 降级示例数据，分页语义与真栈一致", async () => {
  await withMockApi(async ({ respondWith }) => {
    respondWith({ ok: false, error: { code: "not_found", message: "未就位" } }, 404);
    const page1 = await listConsumptionRecords("p1", false, { page: 1 });
    assert.equal(page1.degraded, true);
    assert.equal(page1.total, 28);
    assert.equal(page1.records.length, CONSUMPTION_PAGE_SIZE);
    const page2 = await listConsumptionRecords("p1", false, { page: 2 });
    assert.equal(page2.records.length, 28 - CONSUMPTION_PAGE_SIZE);
    assert.equal(page2.page, 2);
    // 降级路径同样先筛选后分页
    const filtered = await listConsumptionRecords("p1", false, { page: 1, taskType: "image" });
    assert.equal(filtered.total, 14);
    assert.ok(filtered.records.every((item) => item.task_type === "image"));
  });
});

test("listConsumptionRecords：400/500 不降级，原样抛给页面错误态", async () => {
  await withMockApi(async ({ respondWith }) => {
    respondWith({ ok: false, error: { code: "invalid_request", message: "page_size 不能超过 100" } }, 400);
    await assert.rejects(() => listConsumptionRecords("p1", false, { page: 1 }), /page_size 不能超过 100/);
  });
});

test("demo 模式：示例数据本地模拟服务端先筛选后分页，越界页码收敛", async () => {
  const result = await listConsumptionRecords("p1", true, { page: 2, taskType: "video" });
  assert.equal(result.degraded, true);
  assert.equal(result.total, 14);
  assert.equal(result.page, 1, "视频共 14 条只 1 页，越界页码收敛到末页");
  assert.equal(result.records.length, 14);
});

test("listAllConsumptionRecords：按筛选分页循环拉全量，每页钉在后端上限 100", async () => {
  await withMockApi(async ({ items, respondQueue }) => {
    const page1Records = Array.from({ length: 100 }, (_, index) => rawRecord(`task_${String(index).padStart(3, "0")}`));
    respondQueue(
      { records: page1Records, total: 101, page: 1, page_size: 100 },
      { records: [rawRecord("task_100")], total: 101, page: 2, page_size: 100 },
    );
    const result = await listAllConsumptionRecords("p1", false, { taskType: "image" });
    assert.equal(result.records.length, 101);
    assert.equal(result.records[0]?.task_id, "task_000");
    assert.equal(result.records[100]?.task_id, "task_100");
    assert.equal(result.degraded, false);
    assert.equal(items.length, 2);
    assert.ok(items[0]!.url.includes("page=1&page_size=100"), `第 1 页请求形状漂移：${items[0]!.url}`);
    assert.ok(items[1]!.url.includes("page=2&page_size=100"), `第 2 页请求形状漂移：${items[1]!.url}`);
    assert.ok(items[0]!.url.includes("task_type=image"), "筛选未透传到导出拉取");
  });
});

test("listAllConsumptionRecords：单页自足不再多发请求；demo 直接给筛选后全量", async () => {
  await withMockApi(async ({ items, respondWith }) => {
    respondWith({ records: [rawRecord("task_a")], total: 1, page: 1, page_size: 100 });
    const result = await listAllConsumptionRecords("p1", false, {});
    assert.equal(result.records.length, 1);
    assert.equal(items.length, 1);
  });
  const demo = await listAllConsumptionRecords("p1", true, { taskType: "image" });
  assert.equal(demo.degraded, true);
  assert.equal(demo.records.length, 14);
});

function rawRecord(taskId: string): Record<string, unknown> {
  return {
    created_at: "2026-07-20T10:00:00.000Z",
    task_type: "image",
    model_display_name: "Seedream 4.5",
    episode_no: 1,
    prompt_excerpt: "示例",
    task_id: taskId,
    points: 100,
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** api.ts 的 window/fetch 替身（与 asset-api.test.ts 同款口径；respondQueue 支持逐请求换响应）。 */
async function withMockApi(
  run: (harness: {
    items: CapturedRequest[];
    respondWith: (body: unknown, status?: number) => void;
    respondQueue: (...bodies: Array<unknown | { body: unknown; status: number }>) => void;
  }) => Promise<void>,
): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  const items: CapturedRequest[] = [];
  let responseBody: unknown = { records: [], total: 0, page: 1, page_size: 20 };
  let responseStatus = 200;
  const queue: Array<{ body: unknown; status: number }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    items.push({ url: String(input), init });
    const queued = queue.length > 0 ? queue.shift()! : { body: responseBody, status: responseStatus };
    return new Response(JSON.stringify(queued.body), {
      status: queued.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run({
      items,
      respondWith: (body, status = 200) => {
        responseBody = body;
        responseStatus = status;
      },
      respondQueue: (...bodies) => {
        for (const entry of bodies) {
          if (entry !== null && typeof entry === "object" && "body" in (entry as Record<string, unknown>)) {
            queue.push(entry as { body: unknown; status: number });
          } else {
            queue.push({ body: entry, status: 200 });
          }
        }
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
