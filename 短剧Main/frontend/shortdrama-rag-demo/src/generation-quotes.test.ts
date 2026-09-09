import assert from "node:assert/strict";
import test from "node:test";
import {
  generationQuoteFromMessage,
  generationQuoteFromUnknown,
  quoteIsExpired,
} from "./generation-quotes";
import type { AgentMessage } from "./types";

const quoteDetails = {
  generation_quote_id: "24c4daf4-d6d9-4894-8615-e24eb06e64ec",
  estimated_cost_fen: 320,
  currency: "CNY",
  expires_at: "2099-07-15T01:10:00.000Z",
  status: "pending_confirmation",
  media_kind: "video",
};

test("助手报价事件只在字段完整时恢复", () => {
  assert.deepEqual(generationQuoteFromUnknown(quoteDetails, { source: "assistant", action: "submit" }), {
    generation_quote_id: quoteDetails.generation_quote_id,
    estimated_cost_fen: 320,
    currency: "CNY",
    expires_at: quoteDetails.expires_at,
    status: "pending_confirmation",
    source: "assistant",
    action: "submit",
    media_kind: "video",
  });
  assert.equal(generationQuoteFromUnknown({ ...quoteDetails, estimated_cost_fen: -1 }, { source: "assistant", action: "submit" }), null);
  assert.equal(generationQuoteFromUnknown({ ...quoteDetails, expires_at: "bad-date" }, { source: "assistant", action: "submit" }), null);
});

test("历史工具摘要可恢复待确认报价", () => {
  const message: AgentMessage = {
    id: "tool-1",
    role: "tool",
    content: "工具执行完成",
    tool_name: "generate_media",
    tool_result_summary: { details: quoteDetails },
  };
  assert.equal(generationQuoteFromMessage(message)?.generation_quote_id, quoteDetails.generation_quote_id);
  assert.equal(quoteIsExpired(generationQuoteFromMessage(message)!), false);
});
