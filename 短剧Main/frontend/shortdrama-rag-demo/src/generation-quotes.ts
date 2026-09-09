import type { AgentMessage, GenerationMediaKind, GenerationQuote } from "./types";
import { formatCreditsWithUnit } from "./cost-units";

export function generationQuoteFromUnknown(
  value: unknown,
  fallback: { source?: GenerationQuote["source"]; action?: GenerationQuote["action"] } = {},
): GenerationQuote | null {
  if (!isRecord(value)) return null;
  const quoteId = value.generation_quote_id;
  const estimatedCostFen = value.estimated_cost_fen;
  const expiresAt = value.expires_at;
  const status = value.status;
  const currency = value.currency;
  const source = value.source ?? fallback.source;
  const action = value.action ?? fallback.action;
  const mediaKind = value.media_kind;
  if (
    typeof quoteId !== "string"
    || !Number.isSafeInteger(estimatedCostFen)
    || (estimatedCostFen as number) < 0
    || typeof expiresAt !== "string"
    || !Number.isFinite(Date.parse(expiresAt))
    || !["pending_confirmation", "confirmed", "consumed"].includes(String(status))
    || currency !== "CNY"
    || !["web", "assistant", "cli"].includes(String(source))
    || !["submit", "retry"].includes(String(action))
  ) return null;

  return {
    generation_quote_id: quoteId,
    source: source as GenerationQuote["source"],
    action: action as GenerationQuote["action"],
    status: status as GenerationQuote["status"],
    estimated_cost_fen: estimatedCostFen as number,
    currency: "CNY",
    expires_at: expiresAt,
    ...(mediaKind === "image" || mediaKind === "video" ? { media_kind: mediaKind } : {}),
    ...(typeof value.original_request_id === "string" || value.original_request_id === null
      ? { original_request_id: value.original_request_id }
      : {}),
    ...(typeof value.confirmed_at === "string" || value.confirmed_at === null
      ? { confirmed_at: value.confirmed_at }
      : {}),
    ...(typeof value.consumed_at === "string" || value.consumed_at === null
      ? { consumed_at: value.consumed_at }
      : {}),
    ...(typeof value.generation_request_id === "string" || value.generation_request_id === null
      ? { generation_request_id: value.generation_request_id }
      : {}),
    ...(typeof value.generation_attempt_id === "string" || value.generation_attempt_id === null
      ? { generation_attempt_id: value.generation_attempt_id }
      : {}),
    ...(typeof value.notice === "string" ? { notice: value.notice } : {}),
  };
}

export function generationQuoteFromMessage(message: AgentMessage): GenerationQuote | null {
  if (message.generation_quote) return message.generation_quote;
  if (message.tool_name !== "generate_media" || !isRecord(message.tool_result_summary)) return null;
  return generationQuoteFromUnknown(message.tool_result_summary.details, {
    source: "assistant",
    action: "submit",
  });
}

export function generationMediaKind(quote: GenerationQuote, fallback: GenerationMediaKind = "image"): GenerationMediaKind {
  if (quote.media_kind === "image" || quote.media_kind === "video") return quote.media_kind;
  return fallback;
}

export function quoteIsExpired(quote: GenerationQuote, now = Date.now()): boolean {
  return Date.parse(quote.expires_at) <= now;
}

/** 估价确认卡/复核弹窗的费用展示：统一走 cost-units token，显示积分（1 积分 = 1 分钱）。 */
export function formatCost(fen: number): string {
  return formatCreditsWithUnit(fen);
}

export function formatQuoteExpiry(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
