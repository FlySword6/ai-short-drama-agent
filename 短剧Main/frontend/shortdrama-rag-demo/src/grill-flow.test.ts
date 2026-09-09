/**
 * 前端 grill 引擎测试：反问澄清完整流程集成。
 *
 * 模拟后端 SSE 流 → mapAgentStreamFrame 归一化 → 前端状态更新逻辑，
 * 覆盖完整反问流程中前端会遇到的所有事件组合：
 *
 * 场景 1：信息不足 → 反问 + 候选卡片（最常见路径）
 * 场景 2：信息不足 → 反问纯文本（无候选，需要用户自由输入）
 * 场景 3：用户回答后 → 吸收成功 → 继续反问下一字段
 * 场景 4：用户回答后 → 信息充足 → 执行工具（tool_start → tool_end）
 * 场景 5：用户回答无效 → 候选兜底
 * 场景 6：执行中 → 工具完成 → 结果返回
 * 场景 7：思考过程展示（thinking_delta）
 * 场景 8：多候选混合 text_delta + card_delta 同帧序列
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mapAgentStreamFrame } from "./agent-stream.js";
import type { AgentStreamEvent, Candidate } from "./types.js";

function at<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item);
  return item;
}

/** 辅助：模拟后端 SSE 行序列 → 归一化事件列表。 */
function simulateBackendStream(frames: Record<string, unknown>[]): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  for (const frame of frames) {
    events.push(...mapAgentStreamFrame(frame));
  }
  return events;
}

/** 辅助：提取所有 text_delta 的文本拼接。 */
function extractText(events: AgentStreamEvent[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e as { delta: string }).delta)
    .join("");
}

/** 辅助：提取第一个 card_delta 的候选列表。 */
function extractCandidates(events: AgentStreamEvent[]): Candidate[] {
  const card = events.find((e) => e.type === "card_delta");
  return card ? (card as { candidates: Candidate[] }).candidates : [];
}

// ─── 场景 1：信息不足 → 反问 + 候选卡片 ───────────────────

test("场景 1：反问文本 + 候选卡片", () => {
  const events = simulateBackendStream([
    { type: "text_delta", delta: "请问你想注册什么类型的短剧项目？" },
    { type: "card_delta", candidates: [
      { label: "都市情感", description: "现代都市爱情", value: "urban_romance" },
      { label: "古装穿越", description: "古代背景穿越", value: "period_time_travel" },
      { label: "悬疑推理", description: "推理悬疑剧情", value: "mystery" },
    ]},
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, "text_delta");
  assert.equal(events[1]!.type, "card_delta");
  assert.ok(extractText(events).includes("什么类型"), "反问文本应包含类型询问");
  const cands = extractCandidates(events);
  assert.equal(cands.length, 3, "应有 3 个候选");
  assert.equal(cands[0]!.label, "都市情感");
  assert.equal(cands[2]!.label, "悬疑推理");
});

// ─── 场景 2：反问纯文本（无候选）────────────────────────

test("场景 2：反问纯文本，无候选卡片", () => {
  const events = simulateBackendStream([
    { type: "text_delta", delta: "请输入项目名称" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "text_delta");
  assert.equal(extractCandidates(events).length, 0, "无候选卡片");
});

// ─── 场景 3：吸收成功 → 继续反问下一字段 ──────────────────

test("场景 3：用户回答后继续反问下一字段", () => {
  // 第一轮反问 → 用户回答 → 第二轮反问
  const round1 = simulateBackendStream([
    { type: "text_delta", delta: "项目类型？" },
    { type: "card_delta", candidates: [{ label: "都市", value: "urban" }] },
  ]);
  assert.equal(round1.length, 2);
  assert.ok(extractText(round1).includes("类型"));

  // 用户选了"都市"，后端吸收成功，进入下一字段反问
  const round2 = simulateBackendStream([
    { type: "text_delta", delta: "目标集数是多少？" },
  ]);
  assert.equal(round2.length, 1);
  assert.ok(extractText(round2).includes("集数"), "第二轮应问集数");
});

// ─── 场景 4：信息充足 → 执行工具 ─────────────────────────

test("场景 4：信息充足 → 工具执行 start + end", () => {
  const events = simulateBackendStream([
    { type: "text_delta", delta: "好的，正在为您注册项目" },
    { type: "tool_start", tool_name: "register_project" },
    { type: "tool_end", tool_name: "register_project", status: "completed" },
    { type: "text_delta", delta: "项目已创建成功" },
  ]);
  assert.equal(events.length, 4);
  assert.equal(events[0]!.type, "text_delta");
  assert.equal(events[1]!.type, "tool_start");
  assert.equal((events[1]! as { tool_name: string }).tool_name, "register_project");
  assert.equal(events[2]!.type, "tool_end");
  assert.equal((events[2]! as { is_error: boolean }).is_error, false);
  assert.equal(events[3]!.type, "text_delta");
  assert.ok(extractText(events).includes("成功"));
});

// ─── 场景 5：用户回答无效 → 候选兜底 ──────────────────────

test("场景 5：无效输入后候选兜底", () => {
  // 用户输入"asdfgh" → 后端判定无效 → 返回候选兜底
  const events = simulateBackendStream([
    { type: "text_delta", delta: "不太理解你的意思，请从以下选项中选择" },
    { type: "card_delta", candidates: [
      { label: "都市情感", description: "现代都市", value: "urban" },
      { label: "古装穿越", description: "古代穿越", value: "period" },
    ]},
  ]);
  assert.equal(events.length, 2);
  const cands = extractCandidates(events);
  assert.equal(cands.length, 2, "应提供 2 个候选兜底");
  assert.ok(extractText(events).includes("选项"), "应有引导文案");
});

// ─── 场景 6：工具执行完成 ───────────────────────────────

test("场景 6：工具执行 → 错误状态", () => {
  const events = simulateBackendStream([
    { type: "tool_start", tool_name: "register_project" },
    { type: "tool_end", tool_name: "register_project", is_error: true },
  ]);
  assert.equal(events.length, 2);
  assert.equal((at(events, 1) as { is_error: boolean }).is_error, true);
});

// ─── 场景 7：思考过程展示 ───────────────────────────────

test("场景 7：thinking_delta 思考过程与反问文本交替", () => {
  const events = simulateBackendStream([
    { type: "thinking_delta", delta: "分析用户输入..." },
    { type: "text_delta", delta: "请问你的项目名称是什么？" },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, "thinking_delta");
  assert.equal(events[1]!.type, "text_delta");
});

// ─── 场景 8：混合帧序列（多帧合并）──────────────────────

test("场景 8：完整反问流程多帧序列", () => {
  const events = simulateBackendStream([
    { type: "thinking_delta", delta: "检查信息充分性..." },
    { type: "text_delta", delta: "我需要更多信息：你想做什么类型的短剧？" },
    { type: "card_delta", candidates: [
      { label: "都市", description: "d1", value: "v1" },
      { label: "古装", description: "d2", value: "v2" },
      { label: "悬疑", description: "d3", value: "v3" },
      { label: "科幻", description: "d4", value: "v4" },
    ]},
    { type: "tool_start", tool_name: "grill_check" },
    { type: "tool_end", tool_name: "grill_check", status: "completed" },
  ]);
  assert.equal(events.length, 5);
  assert.equal(events[0]!.type, "thinking_delta");
  assert.equal(events[1]!.type, "text_delta");
  assert.equal(events[2]!.type, "card_delta");
  assert.equal(extractCandidates(events).length, 4, "4 个候选");
  assert.equal(events[3]!.type, "tool_start");
  assert.equal(events[4]!.type, "tool_end");
});

// ─── 场景 9：新 runtime 变体帧 ───────────────────────────

test("场景 9：新 runtime 变体帧（reasoning_delta + toolCallStart）", () => {
  const events = simulateBackendStream([
    { type: "reasoning_delta", delta: "新 runtime 思考" },
    { type: "toolCallStart", toolName: "create_content" },
    { type: "toolCallEnd", toolName: "create_content", isError: true },
  ]);
  assert.equal(events.length, 3);
  assert.equal(events[0]!.type, "thinking_delta", "reasoning_delta 应归一为 thinking_delta");
  assert.equal(events[1]!.type, "tool_start", "toolCallStart 应归一为 tool_start");
  assert.equal((events[1]! as { tool_name: string }).tool_name, "create_content");
  assert.equal(events[2]!.type, "tool_end", "toolCallEnd 应归一为 tool_end");
  assert.equal((events[2]! as { is_error: boolean }).is_error, true, "isError 应映射为 is_error");
});

// ─── 场景 10：空/噪声帧安全跳过 ──────────────────────────

test("场景 10：空 delta 和噪声帧安全跳过", () => {
  const events = simulateBackendStream([
    { type: "text_delta", delta: "" },           // 空 delta → 跳过
    { type: "thinking_delta", delta: "" },      // 空 delta → 跳过
    { type: "unknown_type", data: "x" },        // 未知类型 → 跳过
    {},                                         // 空帧 → 跳过
    { type: "text_delta", delta: "有效文本" },   // 有效
  ]);
  assert.equal(events.length, 1, "只有 1 个有效事件");
  assert.equal(events[0]!.type, "text_delta");
  assert.equal((events[0]! as { delta: string }).delta, "有效文本");
});
