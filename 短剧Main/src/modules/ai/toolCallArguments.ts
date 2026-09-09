import { isRecord } from "../../shared/json.js";

/**
 * 工具调用入参的解析口径,火山通道与公司通道共用一份。
 *
 * 供应商偶尔会吐出不是合法 JSON 的入参(实测形状:`"gender": female`,裸词
 * 没引号)。这种时候只有两条路能选:整批抛错,或者把坏的那一条单独标出来。
 * 选后者——一次响应里可能有六个工具调用,让另外五个陪葬既浪费一次真实付费
 * 调用,也会把「有一条读不出」伪装成「模型这一轮没干活」。
 *
 * 读不出时留一段原始片段,是为了让第一次跑的人就能看见真因,不用再去抓报文。
 * 片段只进服务端日志:它可能带着剧本原文,不进用户可见文案,也先按密钥形状打码。
 */

export const TOOL_CALL_ARGUMENTS_EXCERPT_MAX_CHARS = 160;

const REDACTED = "[REDACTED]";

/** `key: value` / `key=value`,键看起来像凭据时把值换掉。 */
const SENSITIVE_ASSIGNMENT =
  /("?)\b(api[-_]?key|access[-_]?key|secret[a-z_]*|token|password|passwd|authorization|cookie)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi;

export type ToolCallArguments =
  | { readable: true; arguments: Record<string, unknown> }
  | { readable: false; excerpt: string };

export function parseToolCallArguments(value: unknown): ToolCallArguments {
  if (isRecord(value)) return { readable: true, arguments: value };
  if (typeof value !== "string") return { readable: false, excerpt: excerptOf(String(value)) };
  if (!value.trim()) return { readable: true, arguments: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { readable: false, excerpt: excerptOf(value) };
  }
  return isRecord(parsed)
    ? { readable: true, arguments: parsed }
    : { readable: false, excerpt: excerptOf(value) };
}

function excerptOf(raw: string): string {
  const masked = raw.replace(
    SENSITIVE_ASSIGNMENT,
    (_match, quote: string, key: string, separator: string) => `${quote}${key}${quote}${separator}${REDACTED}`,
  );
  const singleLine = masked.replace(/\s+/gu, " ").trim();
  return singleLine.length > TOOL_CALL_ARGUMENTS_EXCERPT_MAX_CHARS
    ? `${singleLine.slice(0, TOOL_CALL_ARGUMENTS_EXCERPT_MAX_CHARS)}…`
    : singleLine;
}
