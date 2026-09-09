import assert from "node:assert/strict";
import test from "node:test";
import { assistantSystemPrompt, createAssistantAgent } from "./runtime.js";
import type { VnextProjectService } from "../vnext/service.js";

function runtimeServices() {
  return {
    searchAssets: async () => ({ receipt: { kind: "asset_search" } }),
    addProjectAsset: async () => ({}),
    executeDirectorCommand: async () => ({}),
    prepareGenerationCard: async () => ({}),
    getGenerationTask: async () => ({}),
  };
}

test("系统提示禁止自动付费生成，只允许准备卡", () => {
  const prompt = assistantSystemPrompt({
    sessionId: "session-1",
    userId: "user-1",
    projectId: "project-1",
    shotId: "shot-1",
  });

  assert.match(prompt, /prepare_generation_card 只准备卡片/);
  assert.match(prompt, /用户在页面检查生成卡后亲自点击一次/);
  assert.match(prompt, /不得自动重试、批量生成或夜间生成/);
  assert.doesNotMatch(prompt, /generation_quote_id/);
});

test("真实 runtime 为 vNext 会话开放画布工具并允许执行", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const existingNode = { id: "44444444-4444-4444-8444-444444444444", kind: "scene" as const, label: "既有场景", position: { x: 1, y: 2 } };
  const addedNode = { id: "55555555-5555-4555-8555-555555555555", kind: "note" as const, label: "Agent 增量", position: { x: 3, y: 4 } };
  const vnextProjectService = {
    getDocument: async () => ({ projectId: "11111111-1111-4111-8111-111111111111", revision: 1, document: { schemaVersion: 1, nodes: [existingNode], edges: [] }, updatedAt: new Date("2026-08-14T00:00:00.000Z"), lastWrite: null }),
    replaceDocument: async (input: Record<string, unknown>) => {
      writes.push(input);
      return { projectId: "11111111-1111-4111-8111-111111111111", revision: 1, document: { schemaVersion: 1, nodes: [], edges: [] }, updatedAt: new Date("2026-08-14T00:00:00.000Z"), lastWrite: { kind: "agent", userId: "22222222-2222-4222-8222-222222222222", at: new Date("2026-08-14T00:00:00.000Z") } };
    },
  } as unknown as VnextProjectService;
  let remoteCalls = 0;
  const agent = createAssistantAgent({
    context: { sessionId: "33333333-3333-4333-8333-333333333333", userId: "22222222-2222-4222-8222-222222222222", vnextProjectId: "11111111-1111-4111-8111-111111111111" },
    config: { aiGatewayEnabled: true, remoteApiUrl: "https://pi.example.invalid", remoteApiToken: "test-token", remoteModelId: "pi-remote" },
    services: { ...runtimeServices(), vnextProjectService },
    dependencies: {
      remoteFetch: async () => {
        remoteCalls += 1;
        const response = remoteCalls === 1
          ? { status: "requires_tool", text: "", thinking: null, toolCalls: [{ id: "vnext-read-1", name: "get_vnext_canvas", arguments: {} }], conversationId: "conversation-1", usage: { status: "unknown" } }
          : remoteCalls === 2
            ? { status: "requires_tool", text: "", thinking: null, toolCalls: [{ id: "vnext-write-1", name: "write_vnext_canvas", arguments: { expected_revision: 1, document: { schema_version: 1, nodes: [existingNode, addedNode], edges: [] } } }], conversationId: "conversation-1", usage: { status: "unknown" } }
            : { status: "completed", text: "画布已更新", thinking: null, toolCalls: [], conversationId: "conversation-1", usage: { status: "unknown" } };
        return { ok: true, status: 200, json: async () => response };
      },
    },
  });

  assert.deepEqual(agent.state.tools.filter((tool) => tool.name.includes("vnext_canvas")).map((tool) => tool.name), ["get_vnext_canvas", "write_vnext_canvas"]);
  assert.match(agent.state.systemPrompt, /当前已选择 vNext 项目/);
  await agent.prompt("在既有画布上追加一条备注");
  assert.equal(remoteCalls, 3);
  assert.equal(writes.length, 1, "runtime allowlist 不得拦截已注册的 vNext 工具");
  assert.equal(writes[0]?.projectId, "11111111-1111-4111-8111-111111111111");
  assert.equal(writes[0]?.expectedRevision, 1);
  assert.deepEqual((writes[0]?.document as { nodes: unknown[] }).nodes, [existingNode, addedNode], "Agent 必须先读完整事实，再保留旧节点写入下一版");
});

test("受控 Gateway 首次 503 时失败关闭，绝不改走 Ark", async () => {
  let remoteFetchCalls = 0;
  const completed: Array<{ provider: string; stopReason: string; errorMessage?: string }> = [];
  const agent = createAssistantAgent({
    context: { sessionId: "session-1", userId: "user-1" },
    config: { aiGatewayEnabled: true, remoteApiUrl: "https://pi.example.invalid", remoteApiToken: "test-token", remoteModelId: "pi-remote" },
    services: runtimeServices(),
    dependencies: { remoteFetch: async () => {
      remoteFetchCalls += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    } },
  });
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") completed.push({ provider: event.message.provider, stopReason: event.message.stopReason, errorMessage: event.message.errorMessage });
  });

  await agent.prompt("检索古风资产");
  assert.equal(remoteFetchCalls, 1);
  assert.deepEqual(completed, [{ provider: "pi-remote", stopReason: "error", errorMessage: "受控 AI Gateway 当前不可用" }]);
});

test("助手必须由服务端开启受控 Gateway 且提供完整配置", () => {
  const base = { remoteApiUrl: "https://pi.example.invalid", remoteApiToken: "test-token", remoteModelId: "pi-remote" };
  assert.throws(() => createAssistantAgent({ context: { sessionId: "session-1", userId: "user-1" }, config: { ...base, aiGatewayEnabled: false }, services: runtimeServices() }), /enabled controlled AI Gateway/);
  assert.throws(() => createAssistantAgent({ context: { sessionId: "session-1", userId: "user-1" }, config: { aiGatewayEnabled: true, remoteApiUrl: base.remoteApiUrl, remoteApiToken: base.remoteApiToken }, services: runtimeServices() }), /enabled controlled AI Gateway/);
});

test("工具审计 listener 完成后才把 toolResults 送入远程续推理", async () => {
  const sequence: string[] = [];
  let remoteCall = 0;
  const agent = createAssistantAgent({
    context: { sessionId: "session-1", userId: "user-1" },
    config: {
      aiGatewayEnabled: true,
      remoteApiUrl: "https://pi.example.invalid",
      remoteApiToken: "test-token",
      remoteModelId: "pi-remote",
    },
    services: {
      ...runtimeServices(),
      searchAssets: async () => {
        sequence.push("tool");
        return { receipt: { kind: "asset_search" } };
      },
    },
    dependencies: {
      remoteFetch: async (_url, init) => {
        remoteCall += 1;
        if (remoteCall === 2) assert.deepEqual(sequence, ["tool", "audit"]);
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (remoteCall === 1) assert.ok(Array.isArray(body.messages));
        else assert.deepEqual(Object.keys(body).sort(), ["conversationId", "toolResults"]);
        return {
          ok: true, status: 200,
          json: async () => remoteCall === 1
            ? { status: "requires_tool", text: "", thinking: null, toolCalls: [{ id: "remote-call-1", name: "search_assets", arguments: { query: "古风" } }], conversationId: "conversation-1", usage: { status: "unknown" } }
            : { status: "completed", text: "完成", thinking: null, toolCalls: [], conversationId: "conversation-1", usage: { status: "unknown" } },
        };
      },
    },
  });
  agent.subscribe(async (event) => {
    if (event.type !== "tool_execution_end") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    sequence.push("audit");
  });

  await agent.prompt("检索古风资产");
  assert.equal(remoteCall, 2);
});
