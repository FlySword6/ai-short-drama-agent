/**
 * Pi 面板 SSE 事件归一化（W6-D · 远程 agent runtime 预留）。
 *
 * 后端将把 Pi 会话切到远程 agent runtime：事件流里会出现 thinking 段
 * （思考过程），工具事件的命名也可能是 tool_call_start / toolCallStart /
 * 整组 toolCalls 数组，而不是旧流的 tool_start/tool_end + tool_name。
 * 这里做唯一归一出口：任何 runtime 变体都映射成前端统一的 AgentStreamEvent，
 * 页面渲染层不感知 runtime 差异。未识别帧返回空数组（跳过不报错）。
 */
import type { AgentStreamEvent, Candidate } from "./types";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 工具名候选字段：旧流 tool_name，新 runtime toolName / name。 */
function toolNameOf(record: Record<string, unknown>): string {
  return str(record.tool_name) || str(record.toolName) || str(record.name);
}

function isErr(record: Record<string, unknown>): boolean {
  return record.is_error === true || record.isError === true || record.status === "failed" || record.status === "error";
}

/**
 * 单帧 → 0..N 个统一事件。
 * generation_quote 帧不在此处理（api.ts 有独立的报价解析），这里返回空数组。
 */
export function mapAgentStreamFrame(value: Record<string, unknown>): AgentStreamEvent[] {
  const type = str(value.type);

  if (type === "text_delta") {
    const delta = str(value.delta) || str(value.content);
    return delta ? [{ type: "text_delta", delta }] : [];
  }

  // thinking 段：新 runtime 的思考过程（thinking_delta / reasoning_delta / thought_delta）
  if (type === "thinking_delta" || type === "reasoning_delta" || type === "thought_delta") {
    const delta = str(value.delta) || str(value.content);
    return delta ? [{ type: "thinking_delta", delta }] : [];
  }

  // 工具开始：旧 tool_start / 新 tool_call_start / toolCallStart
  if (type === "tool_start" || type === "tool_call_start" || type === "toolCallStart") {
    const name = toolNameOf(value);
    return name ? [{ type: "tool_start", tool_name: name }] : [];
  }

  // 工具结束：旧 tool_end / 新 tool_call_end / toolCallEnd
  if (type === "tool_end" || type === "tool_call_end" || type === "toolCallEnd") {
    const name = toolNameOf(value);
    return name ? [{ type: "tool_end", tool_name: name, is_error: isErr(value) }] : [];
  }

  // Grill Engine 候选卡片：后端 offer_candidates 路径发来的可选字段值
  if (type === "card_delta") {
    const raw = value.candidates;
    if (!Array.isArray(raw)) return [];
    const candidates: Candidate[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const label = str(record.label);
      const description = str(record.description);
      const candidateValue = str(record.value);
      if (!label) continue;
      candidates.push({ label, description, value: candidateValue });
    }
    return candidates.length > 0 ? [{ type: "card_delta", candidates }] : [];
  }

  // 整组 toolCalls 数组帧：部分 runtime 一次推 [{name,status},...] —— 展开为 start/end 序列
  const toolCalls = value.toolCalls ?? value.tool_calls;
  if (Array.isArray(toolCalls)) {
    const events: AgentStreamEvent[] = [];
    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue;
      const record = call as Record<string, unknown>;
      const name = toolNameOf(record);
      if (!name) continue;
      events.push({ type: "tool_start", tool_name: name });
      const done = record.status === "completed" || record.status === "succeeded" || record.status === "failed"
        || record.status === "error" || record.done === true || record.is_error === true || record.isError === true;
      if (done) events.push({ type: "tool_end", tool_name: name, is_error: isErr(record) });
    }
    return events;
  }

  return [];
}
