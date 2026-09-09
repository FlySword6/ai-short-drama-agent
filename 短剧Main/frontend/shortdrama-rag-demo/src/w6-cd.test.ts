import assert from "node:assert/strict";
import test from "node:test";
import { mapAgentStreamFrame } from "./agent-stream";
import { buildTelemetryPayload, sendTelemetry, shouldReportResult } from "./telemetry";

/* ---------- W6-D：SSE 事件归一（新 runtime 兼容） ---------- */

test("text_delta：delta 或 content 皆可，空文本忽略", () => {
  assert.deepEqual(mapAgentStreamFrame({ type: "text_delta", delta: "你好" }), [{ type: "text_delta", delta: "你好" }]);
  assert.deepEqual(mapAgentStreamFrame({ type: "text_delta", content: "旧流" }), [{ type: "text_delta", delta: "旧流" }]);
  assert.deepEqual(mapAgentStreamFrame({ type: "text_delta", delta: "" }), []);
});

test("thinking 段：thinking/reasoning/thought 三种命名统一为 thinking_delta", () => {
  assert.deepEqual(mapAgentStreamFrame({ type: "thinking_delta", delta: "先想" }), [{ type: "thinking_delta", delta: "先想" }]);
  assert.deepEqual(mapAgentStreamFrame({ type: "reasoning_delta", delta: "推理" }), [{ type: "thinking_delta", delta: "推理" }]);
  assert.deepEqual(mapAgentStreamFrame({ type: "thought_delta", content: "嗯" }), [{ type: "thinking_delta", delta: "嗯" }]);
});

test("工具事件：tool_call_start/toolCallStart 与 tool_name/toolName/name 全兼容", () => {
  assert.deepEqual(mapAgentStreamFrame({ type: "tool_start", tool_name: "search_assets" }), [{ type: "tool_start", tool_name: "search_assets" }]);
  assert.deepEqual(mapAgentStreamFrame({ type: "tool_call_start", toolName: "search_assets" }), [{ type: "tool_start", tool_name: "search_assets" }]);
  assert.deepEqual(mapAgentStreamFrame({ type: "toolCallStart", name: "generate_media" }), [{ type: "tool_start", tool_name: "generate_media" }]);
  assert.deepEqual(mapAgentStreamFrame({ type: "tool_call_end", toolName: "x", isError: true }), [{ type: "tool_end", tool_name: "x", is_error: true }]);
  assert.deepEqual(mapAgentStreamFrame({ type: "tool_end", tool_name: "y", is_error: false }), [{ type: "tool_end", tool_name: "y", is_error: false }]);
});

test("toolCalls 整组数组：展开为 start/end 序列，失败态正确标 is_error", () => {
  const events = mapAgentStreamFrame({
    toolCalls: [
      { name: "search_assets", status: "completed" },
      { toolName: "generate_media", status: "failed" },
      { name: "still_running", status: "running" },
      { broken: true },
    ],
  });
  assert.deepEqual(events, [
    { type: "tool_start", tool_name: "search_assets" },
    { type: "tool_end", tool_name: "search_assets", is_error: false },
    { type: "tool_start", tool_name: "generate_media" },
    { type: "tool_end", tool_name: "generate_media", is_error: true },
    { type: "tool_start", tool_name: "still_running" },
  ]);
});

test("未识别帧返回空数组不报错", () => {
  assert.deepEqual(mapAgentStreamFrame({ type: "mystery", data: 1 }), []);
  assert.deepEqual(mapAgentStreamFrame({}), []);
});

/* ---------- W6-C：轻量埋点 ---------- */

test("buildTelemetryPayload：合同 { event, props, ts }", () => {
  const payload = buildTelemetryPayload("login", { a: 1 }, 123);
  assert.deepEqual(payload, { event: "login", props: { a: 1 }, ts: 123 });
  // 默认参数:props 兜空对象、ts 取当前时间。原写法在同一断言里调两次取两个 Date.now(),
  // 跨毫秒边界必炸(2026-07-30 两次挡 push 实证)——改为单次调用+ts 单独校验,合同语义不变。
  const defaulted = buildTelemetryPayload("asset_search");
  assert.equal(defaulted.event, "asset_search");
  assert.deepEqual(defaulted.props, {});
  assert.equal(typeof defaulted.ts, "number");
  assert.ok(Math.abs(Date.now() - defaulted.ts) < 5_000, "默认 ts 应是当前时间戳");
});

test("shouldReportResult：仅终态且按 request_id 去重", () => {
  const reported = new Set(["r1"]);
  assert.equal(shouldReportResult("r1", "succeeded", reported), false);
  assert.equal(shouldReportResult("r2", "succeeded", reported), true);
  assert.equal(shouldReportResult("r2", "failed", reported), true);
  assert.equal(shouldReportResult("r2", "running", reported), false);
  assert.equal(shouldReportResult("", "succeeded", reported), false);
});

test("sendTelemetry：发送方抛错也静默 resolve（埋点永不挡主流程）", async () => {
  await sendTelemetry(buildTelemetryPayload("login"), async () => { throw new Error("404"); });
  let called = 0;
  await sendTelemetry(buildTelemetryPayload("asset_search"), async () => { called += 1; });
  assert.equal(called, 1);
});
