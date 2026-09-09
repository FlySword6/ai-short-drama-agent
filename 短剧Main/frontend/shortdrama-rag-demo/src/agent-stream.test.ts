/**
 * 前端 grill 引擎测试：SSE 事件归一化（mapAgentStreamFrame）。
 *
 * 覆盖范围：
 * 1. text_delta — 反问问题文本增量
 * 2. thinking_delta — 思考过程增量（3 种 runtime 变体）
 * 3. tool_start / tool_end — 工具事件（旧流 + 新 runtime 变体）
 * 4. card_delta — Grill Engine 候选卡片事件
 * 5. toolCalls 整组帧 — 展开 start/end 序列
 * 6. 未识别帧 — 返回空数组
 * 7. 边界：空 delta / 空数组 / 非数组 candidates / 缺 label 候选
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mapAgentStreamFrame } from "./agent-stream.js";

// ─── text_delta ───────────────────────────────────────────

test("text_delta: 正常文本增量返回单个事件", () => {
  const events = mapAgentStreamFrame({ type: "text_delta", delta: "请问" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "text_delta");
  assert.equal((events[0]! as { delta: string }).delta, "请问");
});

test("text_delta: content 字段作为 delta 的后备", () => {
  const events = mapAgentStreamFrame({ type: "text_delta", content: "后备文本" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "text_delta");
  assert.equal((events[0]! as { delta: string }).delta, "后备文本");
});

test("text_delta: 空 delta 返回空数组", () => {
  assert.equal(mapAgentStreamFrame({ type: "text_delta", delta: "" }).length, 0);
  assert.equal(mapAgentStreamFrame({ type: "text_delta" }).length, 0);
});

// ─── thinking_delta（3 种 runtime 变体）──────────────────

test("thinking_delta: 三种类型名都映射为 thinking_delta", () => {
  for (const type of ["thinking_delta", "reasoning_delta", "thought_delta"]) {
    const events = mapAgentStreamFrame({ type, delta: "思考中..." });
    assert.equal(events.length, 1, `${type} 应返回 1 个事件`);
    assert.equal(events[0]!.type, "thinking_delta");
    assert.equal((events[0]! as { delta: string }).delta, "思考中...");
  }
});

test("thinking_delta: 空 delta 返回空数组", () => {
  assert.equal(mapAgentStreamFrame({ type: "thinking_delta", delta: "" }).length, 0);
});

// ─── tool_start / tool_end（旧流 + 新 runtime 变体）────────

test("tool_start: 旧流 tool_name 字段", () => {
  const events = mapAgentStreamFrame({ type: "tool_start", tool_name: "register_project" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "tool_start");
  assert.equal((events[0]! as { tool_name: string }).tool_name, "register_project");
});

test("tool_start: 新 runtime toolName / name 字段", () => {
  for (const key of ["toolName", "name"]) {
    const events = mapAgentStreamFrame({ type: "tool_call_start", [key]: "create_content" });
    assert.equal(events.length, 1, `tool_call_start with ${key} 应返回 1 个事件`);
    assert.equal(events[0]!.type, "tool_start");
    assert.equal((events[0]! as { tool_name: string }).tool_name, "create_content");
  }
});

test("tool_start: toolCallStart 驼峰变体", () => {
  const events = mapAgentStreamFrame({ type: "toolCallStart", toolName: "t1" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "tool_start");
});

test("tool_start: 缺 name 返回空数组", () => {
  assert.equal(mapAgentStreamFrame({ type: "tool_start" }).length, 0);
});

test("tool_end: 正常结束", () => {
  const events = mapAgentStreamFrame({ type: "tool_end", tool_name: "register_project" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "tool_end");
  assert.equal((events[0]! as { is_error: boolean }).is_error, false);
});

test("tool_end: 错误状态映射 is_error=true", () => {
  for (const frame of [
    { type: "tool_end", tool_name: "t1", is_error: true },
    { type: "tool_end", tool_name: "t2", isError: true },
    { type: "tool_end", tool_name: "t3", status: "failed" },
    { type: "tool_end", tool_name: "t4", status: "error" },
  ]) {
    const events = mapAgentStreamFrame(frame);
    assert.equal(events.length, 1);
    assert.equal((events[0]! as { is_error: boolean }).is_error, true, `frame ${JSON.stringify(frame)} should be error`);
  }
});

test("tool_end: tool_call_end 和 toolCallEnd 变体", () => {
  for (const type of ["tool_call_end", "toolCallEnd"]) {
    const events = mapAgentStreamFrame({ type, toolName: "t1" });
    assert.equal(events.length, 1, `${type} 应返回 1 个事件`);
    assert.equal(events[0]!.type, "tool_end");
  }
});

// ─── card_delta（Grill Engine 候选卡片）──────────────────

test("card_delta: 正常候选卡片 2 个候选", () => {
  const events = mapAgentStreamFrame({
    type: "card_delta",
    candidates: [
      { label: "写实电影感", description: "真实感风格", value: "realistic" },
      { label: "二次元动漫", description: "动漫风格", value: "anime" },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "card_delta");
  const cands = (events[0]! as { candidates: { label: string; description: string; value: string }[] }).candidates;
  assert.equal(cands.length, 2);
  assert.equal(cands[0]!.label, "写实电影感");
  assert.equal(cands[0]!.description, "真实感风格");
  assert.equal(cands[0]!.value, "realistic");
  assert.equal(cands[1]!.label, "二次元动漫");
});

test("card_delta: 候选缺 description 时 description 为空串", () => {
  const events = mapAgentStreamFrame({
    type: "card_delta",
    candidates: [{ label: "选项A", value: "a" }],
  });
  assert.equal(events.length, 1);
  const cands = (events[0]! as { candidates: { description: string }[] }).candidates;
  assert.equal(cands[0]!.description, "");
});

test("card_delta: 候选缺 value 时 value 为空串", () => {
  const events = mapAgentStreamFrame({
    type: "card_delta",
    candidates: [{ label: "选项B", description: "desc" }],
  });
  assert.equal(events.length, 1);
  const cands = (events[0]! as { candidates: { value: string }[] }).candidates;
  assert.equal(cands[0]!.value, "");
});

test("card_delta: 候选缺 label 时被跳过", () => {
  const events = mapAgentStreamFrame({
    type: "card_delta",
    candidates: [
      { label: "有标签", description: "d", value: "v" },
      { description: "无标签", value: "no_label" },
      { label: "也有标签", value: "v2" },
    ],
  });
  assert.equal(events.length, 1);
  const cands = (events[0]! as { candidates: { label: string }[] }).candidates;
  assert.equal(cands.length, 2);
  assert.equal(cands[0]!.label, "有标签");
  assert.equal(cands[1]!.label, "也有标签");
});

test("card_delta: candidates 非数组返回空", () => {
  assert.equal(mapAgentStreamFrame({ type: "card_delta", candidates: "not array" }).length, 0);
  assert.equal(mapAgentStreamFrame({ type: "card_delta" }).length, 0);
});

test("card_delta: 空候选数组返回空", () => {
  const events = mapAgentStreamFrame({ type: "card_delta", candidates: [] });
  assert.equal(events.length, 0);
});

test("card_delta: 候选为 null 或非对象被跳过", () => {
  const events = mapAgentStreamFrame({
    type: "card_delta",
    candidates: [null, "string", 42, { label: "有效" }],
  });
  assert.equal(events.length, 1);
  const cands = (events[0]! as { candidates: { label: string }[] }).candidates;
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.label, "有效");
});

// ─── toolCalls 整组帧 ─────────────────────────────────────

test("toolCalls: 整组帧展开为 start+end 序列", () => {
  const events = mapAgentStreamFrame({
    type: "frame",
    toolCalls: [
      { name: "tool_a", status: "completed" },
      { name: "tool_b", status: "failed" },
    ],
  });
  assert.equal(events.length, 4);
  assert.equal(events[0]!.type, "tool_start");
  assert.equal((events[0]! as { tool_name: string }).tool_name, "tool_a");
  assert.equal(events[1]!.type, "tool_end");
  assert.equal((events[1]! as { is_error: boolean }).is_error, false);
  assert.equal(events[2]!.type, "tool_start");
  assert.equal((events[2]! as { tool_name: string }).tool_name, "tool_b");
  assert.equal(events[3]!.type, "tool_end");
  assert.equal((events[3]! as { is_error: boolean }).is_error, true);
});

test("toolCalls: snake_case tool_calls 字段也支持", () => {
  const events = mapAgentStreamFrame({
    type: "frame",
    tool_calls: [{ tool_name: "tc", status: "succeeded" }],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, "tool_start");
  assert.equal(events[1]!.type, "tool_end");
});

test("toolCalls: 未完成工具只发 start", () => {
  const events = mapAgentStreamFrame({
    type: "frame",
    toolCalls: [{ name: "running_tool", status: "running" }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "tool_start");
});

test("toolCalls: done=true 标记结束", () => {
  const events = mapAgentStreamFrame({
    type: "frame",
    toolCalls: [{ name: "t", done: true }],
  });
  assert.equal(events.length, 2);
  assert.equal(events[1]!.type, "tool_end");
});

test("toolCalls: 缺 name 的条目被跳过", () => {
  const events = mapAgentStreamFrame({
    type: "frame",
    toolCalls: [{ status: "completed" }, { name: "valid", status: "completed" }],
  });
  assert.equal(events.length, 2);
  assert.equal((events[0]! as { tool_name: string }).tool_name, "valid");
});

// ─── 未识别帧 ─────────────────────────────────────────────

test("未识别帧类型返回空数组", () => {
  assert.equal(mapAgentStreamFrame({ type: "unknown_event", data: "x" }).length, 0);
  assert.equal(mapAgentStreamFrame({}).length, 0);
  assert.equal(mapAgentStreamFrame({ type: "" }).length, 0);
});

test("generation_quote 帧返回空数组（由 api.ts 独立处理）", () => {
  assert.equal(
    mapAgentStreamFrame({ type: "generation_quote", quote: { id: "q1" } }).length,
    0,
  );
});
