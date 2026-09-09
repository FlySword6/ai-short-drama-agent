import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { remoteAssistantModel } from "./runtime.js";
import { RemotePiProvider, RemotePiTransportError } from "./remotePiProvider.js";

const model = remoteAssistantModel({
  aiGatewayEnabled: true,
  remoteApiUrl: "https://pi.example.invalid",
  remoteApiToken: "test-token",
  remoteModelId: "pi-remote",
});

function initialContext(): Context {
  return {
    systemPrompt: "system instruction",
    messages: [{ role: "user", content: "查找场景", timestamp: 1 }],
    tools: [{ name: "search_assets", description: "检索", parameters: {} as never }],
  };
}

test("remote Pi sync request carries product context and continues only with toolResults", async () => {
  const requests: Record<string, unknown>[] = [];
  const responses = [
    {
      status: "requires_tool",
      text: "我来检索。",
      thinking: null,
      toolCalls: [{ id: "call-1", name: "search_assets", arguments: { query: "古风" } }],
      toolResults: [],
      messages: [],
      conversationId: "conversation-1",
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null, cost: null, costKnown: false },
    },
    {
      status: "completed",
      text: "找到一个结果。",
      thinking: null,
      toolCalls: [],
      toolResults: [],
      messages: [],
      conversationId: "conversation-1",
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null, cost: null, costKnown: false },
    },
  ];
  const provider = new RemotePiProvider({ apiUrl: "https://pi.example.invalid/", token: "test-token", modelId: "pi-remote" }, async (_url, init) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return { ok: true, status: 200, json: async () => responses.shift() };
  });

  const first = await provider.stream(model, initialContext());
  const firstMessage = await first.result();
  assert.equal(firstMessage.stopReason, "toolUse");
  assert.deepEqual(requests[0], {
    system: "system instruction",
    messages: [{ role: "user", content: "查找场景" }],
    tools: [{ name: "search_assets", description: "检索", inputSchema: {} }],
    toolResults: [],
    conversationId: null,
  });

  const second = await provider.stream(model, {
    ...initialContext(),
    messages: [
      ...initialContext().messages,
      firstMessage,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "search_assets",
        content: [{ type: "text", text: "ignored when details exists" }],
        details: { receipt: { kind: "asset_search" }, count: 1 },
        isError: false,
        timestamp: 2,
      },
    ],
  });
  assert.equal((await second.result()).stopReason, "stop");
  assert.deepEqual(requests[1], {
    conversationId: "conversation-1",
    toolResults: [{
      toolCallId: "call-1",
      content: { receipt: { kind: "asset_search" }, count: 1 },
      isError: false,
    }],
  });
});

test("remote Pi marks early network and 503 failures retryable on the same controlled channel", async () => {
  const unavailable = new RemotePiProvider({ apiUrl: "https://pi.example.invalid", token: "test-token", modelId: "pi-remote" }, async () => ({
    ok: false, status: 503, json: async () => ({})
  }));
  await assert.rejects(
    unavailable.stream(model, initialContext()),
    (error: unknown) => error instanceof RemotePiTransportError && error.kind === "retryable",
  );

  const networkFailure = new RemotePiProvider({ apiUrl: "https://pi.example.invalid", token: "test-token", modelId: "pi-remote" }, async () => {
    throw new Error("socket closed");
  });
  await assert.rejects(
    networkFailure.stream(model, initialContext()),
    (error: unknown) => error instanceof RemotePiTransportError && error.kind === "retryable",
  );

  const forbidden = new RemotePiProvider({ apiUrl: "https://pi.example.invalid", token: "test-token", modelId: "pi-remote" }, async () => ({
    ok: false, status: 401, json: async () => ({})
  }));
  await assert.rejects(
    forbidden.stream(model, initialContext()),
    (error: unknown) => error instanceof RemotePiTransportError && error.kind === "fatal",
  );
});

test("remote Pi rejects continuation mismatches instead of replaying a tool call", async () => {
  const provider = new RemotePiProvider({ apiUrl: "https://pi.example.invalid", token: "test-token", modelId: "pi-remote" }, async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: "requires_tool", text: "", thinking: null,
      toolCalls: [{ id: "call-1", name: "search_assets", arguments: { query: "古风" } }],
      conversationId: "conversation-1", usage: { status: "unknown" },
    }),
  }));
  await provider.stream(model, initialContext());
  await assert.rejects(
    provider.stream(model, initialContext()),
    /continuation toolResults do not match/,
  );
});

test("remote Pi locks to remote after a visible tool call", async () => {
  let calls = 0;
  const provider = new RemotePiProvider({ apiUrl: "https://pi.example.invalid", token: "test-token", modelId: "pi-remote" }, async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({
          status: "requires_tool", text: "正在检索", thinking: null,
          toolCalls: [{ id: "call-1", name: "search_assets", arguments: { query: "古风" } }],
          conversationId: "conversation-1", usage: { status: "unknown" },
        }),
      };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  });
  const first = await provider.stream(model, initialContext());
  const firstMessage = await first.result();
  await assert.rejects(
    provider.stream(model, {
      ...initialContext(),
      messages: [
        ...initialContext().messages,
        firstMessage,
        { role: "toolResult", toolCallId: "call-1", toolName: "search_assets", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 2 },
      ],
    }),
    (error: unknown) => error instanceof RemotePiTransportError && error.kind === "fatal",
  );
});
