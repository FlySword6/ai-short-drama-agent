/* ============================================================
   s16-lane-tasks.test.ts — S16 条 2 参考栏条目级生成任务卡 + 条 3 outcome-unknown

   锁定：注册表（去重/上限/摘除）、状态徽章、阶段词、失败人话
   （outcome-unknown→「结果未知（可重试，未计费）」+重试入口）、
   卡片模型、就绪联动计数、页面接线（提交注册/轮询节制/归入复用）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  inflightLaneTaskCount,
  LANE_TASK_LIMIT,
  laneTaskCardModel,
  laneTaskCardsForLane,
  laneTaskFailureText,
  laneTaskIsActive,
  laneTaskEstimatedDurationText,
  laneTaskOutcomeUnknown,
  laneTaskQueuePositionText,
  laneTaskStageLabel,
  laneTaskStatusLabel,
  loadLaneTaskRecords,
  registerLaneTask,
  unregisterLaneTask,
  type LaneTaskRecord,
} from "./lane-generation-tracker";
import type { GenerationTask } from "./types";

const workbench = readFileSync(new URL("./pages/workbench-page.tsx", import.meta.url), "utf8");
const lanesView = readFileSync(new URL("./components/reference-lanes.tsx", import.meta.url), "utf8");

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
  } as unknown as Storage;
}

function record(requestId: string, lane: string | null = "prop", kind: "image" | "video" = "image"): LaneTaskRecord {
  return { requestId, lane, kind, submittedAt: "2026-07-24T10:00:00Z" };
}

function task(partial: Partial<GenerationTask> & { generation_request_id: string }): GenerationTask {
  return { status: "pending", ...partial };
}

/* ---------- 注册表 ---------- */

describe("任务注册表（localStorage，按 shot 键控）", () => {
  it("注册/读取/摘除回环；同 requestId 去重；上限淘汰最旧", () => {
    const storage = fakeStorage();
    registerLaneTask(storage, "s1", record("r1"));
    registerLaneTask(storage, "s1", record("r2", "lighting"));
    registerLaneTask(storage, "s1", record("r1")); // 重复注册去重
    let records = loadLaneTaskRecords(storage, "s1");
    assert.deepEqual(records.map((item) => item.requestId), ["r1", "r2"], "最新在前且去重");
    assert.equal(records[0]!.lane, "prop");
    assert.equal(records[1]!.lane, "lighting");
    for (let i = 0; i < LANE_TASK_LIMIT + 3; i += 1) registerLaneTask(storage, "s1", record(`rx${i}`));
    records = loadLaneTaskRecords(storage, "s1");
    assert.ok(records.length <= LANE_TASK_LIMIT, "超上限淘汰最旧");
    records = unregisterLaneTask(storage, "s1", records[0]!.requestId);
    assert.equal(loadLaneTaskRecords(storage, "s1").length, records.length);
    // 按 shot 隔离
    assert.equal(loadLaneTaskRecords(storage, "s2").length, 0);
  });

  it("脏 JSON 回退空表，不炸", () => {
    const storage = fakeStorage();
    storage.setItem("shortdrama_lane_tasks_v1:s1", "{oops");
    assert.deepEqual(loadLaneTaskRecords(storage, "s1"), []);
  });
});

/* ---------- 状态徽章与阶段词 ---------- */

describe("状态徽章+阶段词（没有百分比用阶段词）", () => {
  it("徽章=排队中/生成中/失败/完成/已取消", () => {
    assert.equal(laneTaskStatusLabel(task({ generation_request_id: "r", status: "pending" })), "排队中");
    assert.equal(laneTaskStatusLabel(task({ generation_request_id: "r", status: "running" })), "生成中");
    assert.equal(laneTaskStatusLabel(task({ generation_request_id: "r", status: "failed" })), "失败");
    assert.equal(laneTaskStatusLabel(task({ generation_request_id: "r", status: "succeeded" })), "完成");
    assert.equal(laneTaskStatusLabel(task({ generation_request_id: "r", status: "cancelled" })), "已取消");
    assert.equal(laneTaskStatusLabel(null), "已提交");
  });

  it("阶段词按 phase：已提交→排队中→生成中→落库中→完成；缺 phase 按 status 兜底", () => {
    assert.equal(laneTaskStageLabel(task({ generation_request_id: "r", status: "pending", phase: "submitting" })), "已提交");
    assert.equal(laneTaskStageLabel(task({ generation_request_id: "r", status: "pending", phase: "provider_queued" })), "排队中");
    assert.equal(laneTaskStageLabel(task({ generation_request_id: "r", status: "running", phase: "provider_running" })), "生成中");
    assert.equal(laneTaskStageLabel(task({ generation_request_id: "r", status: "running", phase: "persisting" })), "落库中");
    assert.equal(laneTaskStageLabel(task({ generation_request_id: "r", status: "succeeded", phase: "complete" })), "完成");
    assert.equal(laneTaskStageLabel(task({ generation_request_id: "r", status: "running" })), "生成中");
  });

  it("终态优先于 phase：failed/cancelled 即使 phase=complete 也不显示「完成」（截图实证）", () => {
    assert.equal(laneTaskStageLabel(task({ generation_request_id: "r", status: "failed", phase: "complete" })), "失败");
    assert.equal(laneTaskStageLabel(task({ generation_request_id: "r", status: "cancelled", phase: "complete" })), "已取消");
  });
});

describe("S29 等待期信息", () => {
  it("本地待提交顺位与预计总耗时都明确标注，供应商排队不冒充本地第几位", () => {
    const waiting = task({
      generation_request_id: "r",
      status: "pending",
      phase: "created",
      queue_position: 2,
      estimated_duration_seconds: 125,
    });
    assert.equal(laneTaskQueuePositionText(waiting), "本地待提交第 2 位");
    assert.equal(laneTaskEstimatedDurationText(waiting), "预计总耗时约 2 分 5 秒");
    assert.equal(laneTaskQueuePositionText(task({ generation_request_id: "r", status: "pending", phase: "provider_queued", queue_position: 1 })), null);
  });

  it("历史样本不足时不显示耗时行(S46 B-3:不编默认分钟数,也不摆「暂无估计」状态自述)", () => {
    assert.equal(
      laneTaskEstimatedDurationText(task({ generation_request_id: "r", status: "running", estimated_duration_seconds: null })),
      null,
    );
  });
});

/* ---------- 失败人话（条 3：outcome-unknown 单列） ---------- */

describe("失败文案（多模型接缝:display_reason 直读+error-copy 双保险;outcome-unknown 只认 error_code）", () => {
  it("outcome-unknown(error_code=unknown)→ 映射表业务话术;原文嗅探退役", () => {
    const byCode = task({ generation_request_id: "r", status: "failed", error_code: "unknown", display_reason: "提交结果暂时未知，请稍后到任务列表看状态" });
    assert.equal(laneTaskOutcomeUnknown(byCode), true);
    assert.equal(laneTaskFailureText(byCode), "提交结果暂时未知，请稍后到任务列表看状态");
    // 无 error_code 的失败不再是 outcome-unknown(不嗅探原文)
    assert.equal(laneTaskOutcomeUnknown(task({ generation_request_id: "r", status: "failed", display_reason: "生成服务繁忙，请稍后再试" })), false);
  });

  it("display_reason 中文透传;空原因给兜底;非失败态无文案", () => {
    assert.equal(laneTaskFailureText(task({ generation_request_id: "r", status: "failed", display_reason: "内容生成没成：内容未通过审核，请调整后重试。" })), "内容生成没成：内容未通过审核，请调整后重试。");
    assert.equal(laneTaskFailureText(task({ generation_request_id: "r", status: "failed", display_reason: "生成服务繁忙，请稍后再试" })), "生成服务繁忙，请稍后再试");
    assert.equal(laneTaskFailureText(task({ generation_request_id: "r", status: "failed" })), "生成失败，可重试");
    assert.equal(laneTaskFailureText(task({ generation_request_id: "r", status: "running" })), null);
  });
});

/* ---------- 卡片模型与就绪联动 ---------- */

describe("卡片模型+就绪联动计数", () => {
  it("成功卡带预览媒体（kind 匹配优先，缩略图回落 storage_url）；失败卡可重试", () => {
    const succeeded = task({
      generation_request_id: "r1", status: "succeeded",
      media_results: [
        { id: "m-video", media_kind: "video", storage_url: "https://x/v.mp4" },
        { id: "m-img", media_kind: "image", storage_url: "https://x/i.png", thumbnail_url: "https://x/t.png" },
      ] as GenerationTask["media_results"],
    });
    const card = laneTaskCardModel(record("r1"), succeeded);
    assert.equal(card.succeeded, true);
    assert.equal(card.media?.id, "m-img");
    assert.equal(card.media?.url, "https://x/t.png");
    assert.equal(card.active, false);
    const failed = laneTaskCardModel(record("r2"), task({ generation_request_id: "r2", status: "failed", display_reason: "x" }));
    assert.equal(failed.failed, true);
    assert.equal(failed.retryable, true);
    assert.equal(failed.media, null);
  });

  it("inflight 只数归组任务的进行中态；lane=null（快速通道）与终态不计", () => {
    const records = [record("r1", "prop"), record("r2", "lighting"), record("r3", null), record("r4", "prop")];
    const states = {
      r1: task({ generation_request_id: "r1", status: "running" }),
      r2: task({ generation_request_id: "r2", status: "succeeded" }),
      r3: task({ generation_request_id: "r3", status: "running" }),
      r4: task({ generation_request_id: "r4", status: "failed" }),
    };
    assert.equal(inflightLaneTaskCount(records, states), 1);
    assert.equal(laneTaskIsActive("pending"), true);
    assert.equal(laneTaskIsActive("failed"), false);
  });

  it("按栏取卡：只取本栏记录，未加载状态给「已提交」占位", () => {
    const records = [record("r1", "prop"), record("r2", "lighting")];
    const cards = laneTaskCardsForLane("prop", records, {});
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.requestId, "r1");
    assert.equal(cards[0]!.statusLabel, "已提交");
  });
});

/* ---------- 页面接线（源码级） ---------- */

describe("工作台接线（源码断言）", () => {
  it("提交时注册任务（lane=归组上下文）；重试继承原组并替换原记录", () => {
    assert.ok(workbench.includes("registerLaneTask(window.localStorage, shotId"), "提交未注册任务台账");
    assert.ok(workbench.includes("lane: laneForTask"), "注册未带来源组");
    assert.ok(workbench.includes("attachTarget"), "submit 未取归组上下文");
    assert.ok(workbench.includes('pending.operation === "retry" && pending.requestId'), "重试未继承原组");
  });

  it("轮询节制：6s 一拍、标签页隐藏暂停、visibilitychange 恢复即查、终态不再轮询", () => {
    assert.ok(workbench.includes("window.setInterval(() => void tick(), 6000)"), "轮询间隔非 6s");
    assert.ok(workbench.includes("document.hidden) return"), "隐藏未暂停");
    assert.ok(workbench.includes('document.addEventListener("visibilitychange"'), "缺可见性恢复");
    assert.ok(workbench.includes("laneTaskIsActive(known.status)"), "终态任务未跳过轮询");
  });

  it("就绪联动：非阻断提示「还有 N 个参考生成中」（只提示不拦）", () => {
    assert.ok(workbench.includes("laneInflightCount"), "缺就绪联动计数");
    assert.ok(workbench.includes("个参考生成中（不阻塞，可等完成再标记）"), "缺非阻断提示文案");
    assert.ok(!workbench.includes("laneInflightCount > 0 && !readyMark"), "提示不得阻塞就绪按钮");
  });

  it("参考栏卡片：完成=预览+归入本栏（复用归入机制）；失败=人话+重试", () => {
    assert.ok(workbench.includes("onLaneTaskAttach={attachLaneTaskResult}"), "归入未接既有机制");
    assert.ok(workbench.includes("attachItemToLane(lane"), "归入未复用 attachItemToLane");
    assert.ok(workbench.includes("unregisterLaneTask(window.localStorage, shotId, requestId)"), "归入后未摘除任务记录");
    assert.ok(lanesView.includes("归入本栏"), "卡片缺归入按钮");
    assert.ok(lanesView.includes("重试"), "卡片缺重试按钮");
    assert.ok(lanesView.includes("生成任务"), "卡片区缺无障碍标注");
  });

  it("S29 进度只展示本地顺位与历史估计，不把供应商排队包装成数字", () => {
    assert.ok(lanesView.includes("queuePositionText"), "参考栏未展示本地队列顺位");
    assert.ok(lanesView.includes("estimatedDurationText"), "参考栏未展示预计时长");
    assert.ok(workbench.includes("laneTaskQueuePositionText(task)"), "主任务卡未接队列顺位");
    assert.ok(workbench.includes("laneTaskEstimatedDurationText(task)"), "主任务卡未接预计时长");
  });
});
