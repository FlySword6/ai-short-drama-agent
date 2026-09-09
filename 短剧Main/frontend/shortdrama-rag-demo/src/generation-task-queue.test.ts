/* ============================================================
   generation-task-queue.test.ts — K2W「全局生产任务队列」验收断言

   DC 痛点:「我在图片页生成了两张图片,然后没有地方让我可以知道
   我提交的任务是什么状态,只能被动等待。」

   ① 跨项目台账列举:键形解析、损坏键/空值跳过(与 K2J 同一纪律);
   ② 阶段分桶:taskQueuePhase 各态 + splitQueueRows 面板两区(在途/需要处理);
   ③ 在途计数:activeTaskCount(failed/settled 不计,首拍未知乐观计入);
   ④ 文案:阶段(排队中·第N位/生成中/已失败)、预计(秒/分钟/null 不补默认)、失败原因人话;
   ⑤ 跳链:有 episodeId 直达对应镜工作台,没有回落项目生产页(不跳死链);
   ⑥ 入口渲染:图标按钮 + 在途数徽标(demo 2 在途显示 2;真栈无任务不显示数字);
   ⑦ 接线(app.tsx):全局壳 + 项目壳(工作台/普通两分支)三处右组挂载;
   ⑧ demo fixture:2 在途 + 1 失败 + 1 已完成通知,面板三态都看得见。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { demoGenerationQueueNotifications, demoGenerationQueueTasks } from "./demo";
import {
  activeTaskCount,
  listAllGenerationRequests,
  queueEstimateText,
  queueFailureText,
  queueItemPath,
  queueMediaKindText,
  queuePhaseText,
  splitQueueRows,
  taskQueuePhase,
  type TaskQueueRow,
} from "./generation-task-queue";
import { rememberGenerationRequest, type GenerationTaskListStorage } from "./generation-task-recovery";
import { TaskQueueEntry } from "./components/task-queue-entry";
import type { GenerationTask } from "./types";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const appSource = readSource("./app.tsx");
const entrySource = readSource("./components/task-queue-entry.tsx");

const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "99999999-9999-4999-8999-999999999999";

function memoryListStorage(): GenerationTaskListStorage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function task(partial: Partial<GenerationTask> & { status: string }): GenerationTask {
  return { generation_request_id: "req-1", ...partial };
}

/* ---------- ① 跨项目台账列举 ---------- */

test("listAllGenerationRequests:跨项目列举,返回项目/分镜/媒体类型/请求 id", () => {
  const storage = memoryListStorage();
  rememberGenerationRequest(storage, projectId, "shot-1", "image", "req-1");
  rememberGenerationRequest(storage, projectId, "shot-1", "video", "req-2");
  rememberGenerationRequest(storage, otherProjectId, "shot-9", "video", "req-other");
  storage.setItem("unrelated_key", "x");

  const items = listAllGenerationRequests(storage);
  assert.equal(items.length, 3, "两个项目的台账都要列到");
  assert.deepEqual(
    items.find((item) => item.requestId === "req-1"),
    { projectId, shotId: "shot-1", mediaKind: "image", requestId: "req-1" },
  );
  assert.ok(items.some((item) => item.projectId === otherProjectId && item.requestId === "req-other"), "跨项目条目带对 projectId");
});

test("listAllGenerationRequests:键形损坏/值为空的条目跳过,不整列作废", () => {
  const storage = memoryListStorage();
  rememberGenerationRequest(storage, projectId, "shot-1", "video", "req-1");
  storage.setItem(`shortdrama_v01_generation_request:${projectId}:broken`, "req-x");
  storage.setItem(`shortdrama_v01_generation_request:${projectId}:shot-2:image`, "");
  storage.setItem("shortdrama_v01_generation_request:", "req-y");

  assert.deepEqual(
    listAllGenerationRequests(storage),
    [{ projectId, shotId: "shot-1", mediaKind: "video", requestId: "req-1" }],
  );
});

/* ---------- ② 阶段分桶 ---------- */

test("taskQueuePhase:pending→queued,running/未识别非终态→running,failed/succeeded/cancelled 各归其位", () => {
  assert.equal(taskQueuePhase(task({ status: "pending" })), "queued");
  assert.equal(taskQueuePhase(task({ status: "running" })), "running");
  assert.equal(taskQueuePhase(task({ status: "some_future_status" })), "running", "未识别非终态保守按生成中");
  assert.equal(taskQueuePhase(task({ status: "failed" })), "failed");
  assert.equal(taskQueuePhase(task({ status: "succeeded" })), "settled");
  assert.equal(taskQueuePhase(task({ status: "cancelled" })), "settled");
  assert.equal(taskQueuePhase(undefined), "queued", "首拍未查到乐观按排队,与 K2J 徽标首拍口径一致");
});

test("splitQueueRows:面板两区——在途(queued+running)与需要处理(failed),settled 不进面板", () => {
  const row = (requestId: string, t?: GenerationTask): TaskQueueRow => ({
    entry: { projectId, shotId: "shot-1", mediaKind: "image", requestId },
    task: t,
  });
  const rows = [
    row("req-queued", task({ status: "pending" })),
    row("req-running", task({ status: "running" })),
    row("req-unknown", undefined),
    row("req-failed", task({ status: "failed" })),
    row("req-succeeded", task({ status: "succeeded" })),
  ];
  const { activeRows, failedRows } = splitQueueRows(rows);
  assert.deepEqual(activeRows.map((item) => item.entry.requestId), ["req-queued", "req-running", "req-unknown"]);
  assert.deepEqual(failedRows.map((item) => item.entry.requestId), ["req-failed"], "失败行只进需要处理区");
});

/* ---------- ③ 在途计数 ---------- */

test("activeTaskCount:failed/settled 不计,首拍未知乐观计入", () => {
  assert.equal(
    activeTaskCount([
      task({ status: "pending" }),
      task({ status: "running" }),
      task({ status: "failed" }),
      task({ status: "succeeded" }),
      task({ status: "cancelled" }),
      undefined,
    ]),
    3,
  );
  assert.equal(activeTaskCount([]), 0);
});

/* ---------- ④ 文案 ---------- */

test("queuePhaseText:排队中带顺位/无顺位如实省略、生成中、已失败", () => {
  assert.equal(queuePhaseText(task({ status: "pending", queue_position: 2 })), "排队中 · 第 2 位");
  assert.equal(queuePhaseText(task({ status: "pending", queue_position: null })), "排队中");
  assert.equal(queuePhaseText(undefined), "排队中");
  assert.equal(queuePhaseText(task({ status: "running" })), "生成中");
  assert.equal(queuePhaseText(task({ status: "failed" })), "已失败");
  assert.equal(queuePhaseText(task({ status: "succeeded" })), "", "终态行不进面板不给阶段词");
});

test("queueEstimateText:秒/分钟分档;样本不足(null)如实不显示,不补默认分钟数", () => {
  assert.equal(queueEstimateText(task({ status: "running", estimated_duration_seconds: 45 })), "预计约 45 秒");
  assert.equal(queueEstimateText(task({ status: "running", estimated_duration_seconds: 120 })), "预计约 2 分钟");
  assert.equal(queueEstimateText(task({ status: "running", estimated_duration_seconds: null })), null);
  assert.equal(queueEstimateText(undefined), null);
});

test("queueFailureText:失败原因读脱敏 display_reason;非失败不给", () => {
  assert.equal(queueFailureText(task({ status: "failed", display_reason: "视频生成没成：可用积分不足，请充值后重试。" })), "视频生成没成：可用积分不足，请充值后重试。");
  assert.equal(queueFailureText(task({ status: "failed", display_reason: null })), "任务失败,去工作台看任务卡");
  assert.equal(queueFailureText(task({ status: "running" })), null);
});

test("queueMediaKindText:图/视频/音频三态", () => {
  assert.equal(queueMediaKindText("image"), "图片");
  assert.equal(queueMediaKindText("video"), "视频");
  assert.equal(queueMediaKindText("audio"), "音频");
});

/* ---------- ⑤ 跳链 ---------- */

test("queueItemPath:有 episodeId 直达对应镜工作台;没有回落项目生产页,不跳死链", () => {
  assert.equal(
    queueItemPath(projectId, "shot-1", "episode-1"),
    `/projects/${projectId}/storyboards/episode-1/shots/shot-1`,
  );
  assert.equal(queueItemPath(projectId, "shot-1", null), `/projects/${projectId}/storyboards`);
});

/* ---------- ⑥ 入口渲染:图标 + 在途数徽标 ---------- */

test("入口:demo 2 个在途显示徽标数字 2,aria-label 报在途数", () => {
  const html = renderToStaticMarkup(React.createElement(TaskQueueEntry, { demoMode: true }));
  assert.ok(html.includes("<button"), "入口应为按钮");
  assert.ok(html.includes('aria-label="任务队列,2 个任务在途"'), "可访问名应报在途数");
  assert.ok(html.includes(">2</span>"), "徽标数字缺失");
  assert.ok(html.includes("<svg"), "缺 ListChecks 图标");
});

test("入口:真栈无任务(SSR 首渲染空台账)不显示数字,克制", () => {
  const html = renderToStaticMarkup(React.createElement(TaskQueueEntry, { demoMode: false }));
  assert.ok(html.includes('aria-label="任务队列"'), "无在途时可访问名不带数字");
  assert.ok(!html.includes("个任务在途"), "0 时不显示数字");
});

/* ---------- ⑦ 接线:三处右组挂载 + 轮询纪律 ---------- */

test("接线:队列入口收编 rail(chip 徽标)+ /queue 全页,双载体在场", () => {
  // 2026-08-02 Fable 改锚:R2 壳后顶栏退役,TaskQueueEntry 三处挂载语义收编为
  // rail 队列 chip(useInFlightCount 徽标+点入 /queue)+ /queue 全局队列页——入口只换位置不丢功能。
  const railSource = readSource("./components/app-rail.tsx");
  assert.ok(railSource.includes("useInFlightCount"), "rail 缺在途数徽标接线");
  assert.ok(railSource.includes('"/queue"') || railSource.includes("nav.queue"), "rail 缺队列跳转载体");
  assert.ok(appSource.includes('"/queue"'), "app.tsx 缺 /queue 路由");
});

test("轮询纪律:K2J 同款 3s 拍 + 终态/404 忘台账 + 无在途停拍 + 隐藏标签不空转", () => {
  assert.ok(entrySource.includes("Promise.allSettled"), "缺 allSettled 并发拍");
  assert.ok(entrySource.includes("TASK_POLL_MS = 3000"), "轮询拍应与 K2J 徽标同为 3s");
  assert.ok(entrySource.includes("forgetGenerationRequest"), "终态/404 必须忘台账");
  assert.ok(entrySource.includes("document.hidden"), "隐藏标签页不应空转网络");
  assert.ok(entrySource.includes('new Event("production-progress-changed")'), "终态应广播,开着的列表自己刷新");
  assert.ok(entrySource.includes('if (demoMode || !pollingKey) return'), "无在途任务不得启动网络轮询");
});

test("面板结构:三态区(在途/需要处理/最近完成)+ 跳链两出口 + demo 离线标注", () => {
  assert.ok(entrySource.includes("需要处理"), "缺失败区");
  assert.ok(entrySource.includes("最近完成"), "缺终态通知近条目区");
  assert.ok(entrySource.includes("离线演示 · 示例任务"), "demo 离线标注缺失");
  assert.ok(entrySource.includes("queueItemPath("), "任务行跳链未走 queueItemPath");
  assert.ok(entrySource.includes("notificationResultPath("), "通知行跳链未走 notificationResultPath");
  assert.ok(entrySource.includes('api.generationAttemptNotifications(5)'), "终态通知近条目未拉取");
});

/* ---------- ⑧ demo fixture:三态都看得见 ---------- */

test("demo fixture:2 在途(排队中·第 1 位 + 生成中)+ 1 失败 + 1 已完成通知", () => {
  const { activeRows, failedRows } = splitQueueRows(demoGenerationQueueTasks);
  assert.equal(activeRows.length, 2, "2 个在途");
  assert.equal(failedRows.length, 1, "1 个失败");
  assert.equal(activeTaskCount(demoGenerationQueueTasks.map((row) => row.task)), 2, "徽标在途数 = 2");

  const queued = activeRows.find((row) => taskQueuePhase(row.task) === "queued");
  const running = activeRows.find((row) => taskQueuePhase(row.task) === "running");
  assert.ok(queued && running, "排队中与生成中各一");
  assert.equal(queuePhaseText(queued.task), "排队中 · 第 1 位");
  assert.equal(queuePhaseText(running.task), "生成中");
  assert.ok(queueEstimateText(running.task), "生成中行带预计");

  assert.ok(failedRows[0] && queueFailureText(failedRows[0].task)?.includes("参考图尺寸不合规"), "失败行带人话原因");

  assert.equal(demoGenerationQueueNotifications.length, 1);
  assert.equal(demoGenerationQueueNotifications[0]!.status, "succeeded", "终态通知近条目=已完成");

  /* 跳链可彩排:每行都带 episodeId,直达对应镜工作台 */
  for (const row of demoGenerationQueueTasks) {
    assert.ok(row.episodeId, "demo 行跳链缺 episodeId");
    assert.ok(row.projectName && row.shotLabel, "demo 行缺展示名");
  }
});
