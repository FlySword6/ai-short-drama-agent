/* ============================================================
   k2j-batch-tracking.test.ts — K2J「批量生成本集任务下落修复」

   ① 批量提交成功后逐项登记会话台账（单镜同款 rememberGenerationRequest）；
   ② 台账 reader：按项目列举在途条目，损坏键/空值跳过；
   ③ 素材卡徽标三态判定：排队中·第N位 / 生成中 / 失败·去工作台重试，
      全终态 settled → 清台账徽标消失；
   ④ ShotCard 渲染：台账有条目显示徽标，无条目不显示；
   ⑤ 关抽屉一句人话：toast 指向各镜工作台与右下角提醒。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  forgetGenerationRequest,
  listGenerationRequests,
  recoverGenerationTask,
  rememberGenerationRequest,
  shotGenerationBadge,
  shotGenerationBadgeText,
  type GenerationTaskListStorage,
} from "./generation-task-recovery";
import { registerBatchGenerationRequests } from "./pages/batch-generate-drawer";
import type { BatchSubmitItemResult, GenerationTask, Shot } from "./types";

/* 根门禁（npm run test:node）从仓库根起 tsx，吃不到 frontend 的 react-jsx 配置，
   经典变换下 project-pages.tsx 顶层 JSX 常量展开为 React.createElement——
   先补全局 React 再动态引入；从 frontend 目录单跑（react-jsx）时这是无害空操作。 */
(globalThis as Record<string, unknown>).React ??= React;
type ShotCardComponent = typeof import("./pages/project-pages").ShotCard;
let shotCardPromise: Promise<ShotCardComponent> | null = null;
function loadShotCard(): Promise<ShotCardComponent> {
  shotCardPromise ??= import("./pages/project-pages").then((module) => module.ShotCard);
  return shotCardPromise;
}

const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "99999999-9999-4999-8999-999999999999";
const shotId = "77777777-7777-4777-8777-777777777777";
const episodeId = "33333333-3333-4333-8333-333333333333";

function memoryListStorage(): GenerationTaskListStorage & { keys: () => string[] } {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    keys: () => [...values.keys()],
  };
}

function task(partial: Partial<GenerationTask> & { status: string }): GenerationTask {
  return { generation_request_id: "req-1", ...partial };
}

/* ---------- ① 批量注册：与单镜同一台账机制 ---------- */

test("批量注册：created 行逐项登记台账，recover 可按分镜+媒体类型取回", async () => {
  const storage = memoryListStorage();
  const items: BatchSubmitItemResult[] = [
    { item_id: "shot-a", generation_quote_id: "q1", estimated_cost_fen: 200, status: "created", generation_request_id: "req-a", queue_position: 1 },
    { item_id: "shot-b", generation_quote_id: "q2", estimated_cost_fen: 200, status: "created", generation_request_id: "req-b", queue_position: 2 },
    { item_id: "shot-c", generation_quote_id: "q3", estimated_cost_fen: 0, status: "failed", error: { code: "x", message: "y" } },
  ];
  const registered = registerBatchGenerationRequests(storage, projectId, "video", items);

  assert.equal(registered, 2, "失败行不登记");
  const recovered = await recoverGenerationTask(storage, projectId, "shot-a", "video", async (id) => task({ generation_request_id: id, status: "pending" }));
  assert.equal(recovered?.generation_request_id, "req-a", "进工作台可恢复任务卡");
  assert.equal(await recoverGenerationTask(storage, projectId, "shot-c", "video", async () => task({ status: "pending" })), null, "未创建行没有台账");
});

test("批量注册：缺 generation_request_id 的行跳过，台账不留空值", () => {
  const storage = memoryListStorage();
  const registered = registerBatchGenerationRequests(storage, projectId, "image", [
    { item_id: "shot-a", generation_quote_id: "q1", estimated_cost_fen: 1, status: "created" },
  ]);
  assert.equal(registered, 0);
  assert.deepEqual(listGenerationRequests(storage, projectId), []);
});

/* ---------- ② 台账 reader ---------- */

test("listGenerationRequests：按项目过滤，返回分镜/媒体类型/请求 id", () => {
  const storage = memoryListStorage();
  rememberGenerationRequest(storage, projectId, "shot-1", "video", "req-1");
  rememberGenerationRequest(storage, projectId, "shot-1", "image", "req-2");
  rememberGenerationRequest(storage, projectId, "shot-2", "image", "req-3");
  rememberGenerationRequest(storage, otherProjectId, "shot-9", "video", "req-other");
  storage.setItem("unrelated_key", "x");

  const items = listGenerationRequests(storage, projectId);
  assert.equal(items.length, 3, "只列本项目台账");
  assert.deepEqual(
    items.find((item) => item.shotId === "shot-1" && item.mediaKind === "video"),
    { shotId: "shot-1", mediaKind: "video", requestId: "req-1" },
  );
  assert.ok(!items.some((item) => item.requestId === "req-other"), "不串别的项目");

  forgetGenerationRequest(storage, projectId, "shot-1", "video");
  assert.equal(listGenerationRequests(storage, projectId).length, 2);
});

test("listGenerationRequests：键形损坏/值为空的条目跳过，不整列作废", () => {
  const storage = memoryListStorage();
  rememberGenerationRequest(storage, projectId, "shot-1", "video", "req-1");
  storage.setItem(`shortdrama_v01_generation_request:${projectId}:broken`, "req-x");
  storage.setItem(`shortdrama_v01_generation_request:${projectId}:shot-2:image`, "");

  const items = listGenerationRequests(storage, projectId);
  assert.deepEqual(items, [{ shotId: "shot-1", mediaKind: "video", requestId: "req-1" }]);
});

/* ---------- ③ 徽标三态判定 ---------- */

test("徽标：排队中带最小队列顺位；无顺位如实省略", () => {
  assert.deepEqual(
    shotGenerationBadge([task({ status: "pending", queue_position: 3 }), task({ status: "pending", queue_position: 1 })]),
    { kind: "queued", queuePosition: 1 },
  );
  assert.deepEqual(shotGenerationBadge([task({ status: "pending", queue_position: null })]), { kind: "queued", queuePosition: null });
  assert.equal(shotGenerationBadgeText({ kind: "queued", queuePosition: 2 }), "排队中 · 第 2 位");
  assert.equal(shotGenerationBadgeText({ kind: "queued", queuePosition: null }), "排队中");
});

test("徽标：生成中；未识别非终态保守按生成中", () => {
  assert.deepEqual(shotGenerationBadge([task({ status: "running" })]), { kind: "running" });
  assert.deepEqual(shotGenerationBadge([task({ status: "some_future_status" })]), { kind: "running" });
  assert.equal(shotGenerationBadgeText({ kind: "running" }), "生成中");
});

test("徽标：失败最优先（排队/生成中让位）；文案指向工作台重试", () => {
  assert.deepEqual(
    shotGenerationBadge([task({ status: "pending" }), task({ status: "failed" }), task({ status: "running" })]),
    { kind: "failed" },
  );
  assert.equal(shotGenerationBadgeText({ kind: "failed" }), "失败 · 去工作台重试");
});

test("徽标：全部终态（成功/取消）→ settled 清台账不显示；空列表 none", () => {
  assert.deepEqual(shotGenerationBadge([task({ status: "succeeded" }), task({ status: "cancelled" })]), { kind: "settled" });
  assert.equal(shotGenerationBadgeText({ kind: "settled" }), null);
  assert.deepEqual(shotGenerationBadge([]), { kind: "none" });
  assert.equal(shotGenerationBadgeText({ kind: "none" }), null);
});

/* ---------- ④ ShotCard 徽标渲染（组件） ---------- */

const shotFixture: Shot = { id: shotId, episode_id: episodeId, shot_no: "1", script_text: "夜雨巷口，她回头。" };

async function renderShotCard(tracked?: { shotId: string; mediaKind: "image" | "video"; requestId: string }[]): Promise<string> {
  const ShotCard = await loadShotCard();
  return renderToStaticMarkup(React.createElement(ShotCard, {
    shot: shotFixture,
    episodeNo: 1,
    projectId,
    episodeId,
    demoMode: true,
    // rebase 后签名为并集：canCreate 为 K2H 加的必填项；本组只验徽标，给 false 关掉彩排入口
    canCreate: false,
    notify: () => {},
    onDeleted: () => {},
    trackedGenerations: tracked,
  }));
}

test("ShotCard：台账有条目显示「排队中」徽标（离线演示登记即排队）", async () => {
  const html = await renderShotCard([{ shotId, mediaKind: "video", requestId: "demo-request-1" }]);
  assert.ok(html.includes("排队中"), "徽标缺失");
  assert.ok(html.includes("role=\"status\""), "徽标需要可感知状态语义");
});

test("ShotCard：无台账条目不显示徽标", async () => {
  const html = await renderShotCard(undefined);
  assert.ok(!html.includes("排队中"));
  assert.ok(!html.includes("生成中"));
  assert.ok(!html.includes("去工作台重试"));
});

/* ---------- ⑤ 关抽屉一句人话（源码合同） ---------- */

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("抽屉合同：confirmBatch 登记台账 + toast 指向工作台与右下角提醒", () => {
  const source = readSource("./pages/batch-generate-drawer.tsx");
  assert.ok(
    source.includes("registerBatchGenerationRequests(window.sessionStorage, projectId, mediaKind, result.items)"),
    "批量提交成功后必须逐项登记会话台账",
  );
  assert.ok(source.includes("个任务已入队，进度见各镜工作台与右下角提醒"), "成功 toast 人话缺失");
  assert.ok(source.includes("进度见各镜工作台与右下角提醒"), "demo notice 同款人话缺失");
});
