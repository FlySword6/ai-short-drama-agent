import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { settings } from "../../config/env.js";
import {
  assistantPublicFailureMessage,
  assistantAuditStatus,
  assistantProviderCostUsdMicros,
  assistantUsageData,
  generationQuoteSseEvent,
  toolEndSseEvent,
  usdToMicros,
  registerAssistantRoutes,
} from "./routes.js";
import { ExternalServiceError } from "../../shared/errors.js";
import { REMOTE_PI_UNKNOWN_USAGE_RESPONSE_ID } from "./remotePiProvider.js";
import { historyMessages } from "./routes.js";
import type { AssistantMessageRow } from "./repository.js";
import type { GenerationView } from "../generation/types.js";
import type { VnextProjectService } from "../vnext/service.js";

test("创建 vNext 助手会话校验成员并把上下文绑定到专用服务", async () => {
  const app = Fastify({ logger: false });
  const userId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const vnextProjectId = "33333333-3333-4333-8333-333333333333";
  const repositoryCalls: Array<Record<string, unknown>> = [];
  const serviceCalls: Array<Record<string, unknown>> = [];
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: userId, username: "tester", displayName: "测试用户" };
    request.authContext = {
      user: request.authUser,
      credential: {
        sessionId: "44444444-4444-4444-8444-444444444444",
        source: "web",
        actorKind: "human",
        agentType: null,
        userAgent: "test",
        expiresAt: new Date("2026-08-15T00:00:00.000Z"),
      },
    };
  });
  const vnextService = {
    getProject: async (actor: { id: string }, projectId: string) => {
      serviceCalls.push({ name: "getProject", actor, projectId });
      return { id: projectId, name: "vNext 项目", createdAt: new Date(), updatedAt: new Date() };
    },
    bindAssistantSession: async (actor: { id: string }, currentSessionId: string, projectId: string) => {
      serviceCalls.push({ name: "bindAssistantSession", actor, sessionId: currentSessionId, projectId });
    },
  } as unknown as VnextProjectService;
  await registerAssistantRoutes(app, () => ({} as Database), {
    createRepository: () => ({
      createSession: async (input: Record<string, unknown>) => {
        repositoryCalls.push(input);
        return {
          id: sessionId,
          projectId: null,
          shotId: null,
          title: "小龙虾会话",
          createdAt: new Date("2026-08-14T00:00:00.000Z"),
        };
      },
    } as never),
    createVnextService: () => vnextService,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/sessions",
      payload: { vnext_project_id: vnextProjectId },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().data.vnext_project_id, vnextProjectId);
    assert.equal(repositoryCalls[0]?.projectId, undefined, "vNext id 不得写进旧 projects 外键");
    assert.equal(repositoryCalls[0]?.agentType, "platform_assistant_vnext");
    assert.deepEqual(serviceCalls, [
      { name: "getProject", actor: { id: userId, username: "tester", displayName: "测试用户" }, projectId: vnextProjectId },
      { name: "bindAssistantSession", actor: { id: userId, username: "tester", displayName: "测试用户" }, sessionId, projectId: vnextProjectId },
    ]);
  } finally {
    await app.close();
  }
});

test("生成报价工具结束时只发送允许的报价字段", () => {
  const event = generationQuoteSseEvent("generate_media", false, {
    content: [{ type: "text", text: "不应进入 SSE" }],
    details: {
      generation_quote_id: "24c4daf4-d6d9-4894-8615-e24eb06e64ec",
      estimated_cost_fen: 120,
      currency: "CNY",
      expires_at: "2026-07-15T01:10:00.000Z",
      status: "pending_confirmation",
      media_kind: "video",
      pricing_rule_id: "secret-internal-rule",
      normalized_request: { prompt: "不应发送" },
      storage_url: "https://example.invalid/internal",
    },
  });

  assert.deepEqual(event, {
    type: "generation_quote",
    generation_quote_id: "24c4daf4-d6d9-4894-8615-e24eb06e64ec",
    estimated_cost_fen: 120,
    currency: "CNY",
    expires_at: "2026-07-15T01:10:00.000Z",
    status: "pending_confirmation",
    media_kind: "video",
  });
});

test("失败、非生成工具或不完整报价不发送报价事件", () => {
  const quote = {
    details: {
      generation_quote_id: "24c4daf4-d6d9-4894-8615-e24eb06e64ec",
      estimated_cost_fen: 120,
      currency: "CNY",
      expires_at: "2026-07-15T01:10:00.000Z",
      status: "pending_confirmation",
      media_kind: "image",
    },
  };
  assert.equal(generationQuoteSseEvent("generate_media", true, quote), undefined);
  assert.equal(generationQuoteSseEvent("search_assets", false, quote), undefined);
  assert.equal(generationQuoteSseEvent("generate_media", false, {
    details: { ...quote.details, estimated_cost_fen: -1 },
  }), undefined);
  assert.equal(generationQuoteSseEvent("generate_media", false, {
    details: { ...quote.details, status: "consumed" },
  }), undefined);
  assert.equal(generationQuoteSseEvent("generate_media", false, {
    details: { ...quote.details, generation_quote_id: "not-a-quote-id" },
  }), undefined);
});

test("助手 SSE 错误快照不发送运行时供应商原文", () => {
  assert.equal(
    assistantPublicFailureMessage(
      new ExternalServiceError("Ark", "chat completion failed with status 503"),
    ),
    "生成没成：生成服务暂时没响应，请稍后重试。",
  );
  assert.equal(
    assistantPublicFailureMessage(new Error("Remote Pi request failed: HTTP 502")),
    "AI 助手这次没回复成：请稍后再试。",
  );
});

test("加入项目资产成功时，tool_end 只发送可用的引用摘要", () => {
  const event = toolEndSseEvent("add_project_asset", false, {
    content: [{ type: "text", text: "不得发送" }],
    details: {
      reference_id: "24c4daf4-d6d9-4894-8615-e24eb06e64ec",
      project_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      asset_entity_id: "secret-asset-id",
      provider_response: { token: "must-not-leak" },
    },
  });

  assert.deepEqual(event, {
    type: "tool_end",
    tool_name: "add_project_asset",
    is_error: false,
    result_summary: {
      kind: "project_asset_added",
      ref_id: "24c4daf4-d6d9-4894-8615-e24eb06e64ec",
    },
  });
});

test("失败工具不伪造结果摘要，未知工具保持旧 tool_end 兼容形状", () => {
  const result = {
    details: { reference_id: "24c4daf4-d6d9-4894-8615-e24eb06e64ec" },
  };
  assert.deepEqual(toolEndSseEvent("add_project_asset", true, result), {
    type: "tool_end",
    tool_name: "add_project_asset",
    is_error: true,
  });
  assert.deepEqual(toolEndSseEvent("future_tool", false, result), {
    type: "tool_end",
    tool_name: "future_tool",
    is_error: false,
  });
});

test("AI 日志把模型用量和供应商美元成本保存为明确单位", () => {
  const usage = assistantUsageData({
    role: "assistant",
    content: [{ type: "text", text: "完成" }],
    api: "openai-completions",
    provider: "ark",
    model: "doubao-test",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 125,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  assert.deepEqual(usage, {
    status: "reported",
    api: "openai-completions",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 5,
    cache_write_tokens: 0,
    reasoning_tokens: null,
    total_tokens: 125,
    provider_cost: {
      currency: "USD",
      input: 0.001,
      output: 0.002,
      cache_read: 0,
      cache_write: 0,
      total: 0.003,
      cost_known: true,
    },
  });
  assert.equal(usdToMicros(0.003), 3_000);
  assert.equal(usdToMicros(Number.NaN), undefined);
});

test("AI 日志状态不把中断或错误伪装成成功", () => {
  assert.equal(assistantAuditStatus("stop"), "completed");
  assert.equal(assistantAuditStatus("toolUse"), "completed");
  assert.equal(assistantAuditStatus("error"), "failed");
  assert.equal(assistantAuditStatus("aborted"), "aborted");
});

test("远程 Pi 未报告用量时审计明确标为 unknown", () => {
  const usage = assistantUsageData({
    role: "assistant",
    content: [{ type: "text", text: "完成" }],
    api: "openai-completions",
    provider: "pi-remote",
    model: "pi-remote",
    responseId: REMOTE_PI_UNKNOWN_USAGE_RESPONSE_ID,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  assert.deepEqual(usage, {
    status: "unknown",
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    provider_cost: {
      currency: "USD", input: null, output: null, cache_read: null,
      cache_write: null, total: null, cost_known: false,
    },
  });
  assert.equal(assistantProviderCostUsdMicros({
    role: "assistant", content: [], api: "openai-completions", provider: "pi-remote", model: "pi-remote",
    responseId: REMOTE_PI_UNKNOWN_USAGE_RESPONSE_ID,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  }), undefined);
});

test("历史助手消息保留已审计的 provider/model，缺失时使用受控远程通道", () => {
  const createdAt = new Date("2026-07-21T00:00:00.000Z");
  const rows = [
    { role: "assistant", content: "远程回复", provider: "pi-remote", model: "pi-live", createdAt },
    { role: "assistant", content: "旧回复", provider: null, model: null, createdAt },
  ] as AssistantMessageRow[];
  const messages = historyMessages(rows, "pi-remote-default");
  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages[1]?.role, "assistant");
  const first = messages[0] as Extract<(typeof messages)[number], { role: "assistant" }>;
  const second = messages[1] as Extract<(typeof messages)[number], { role: "assistant" }>;
  assert.equal(first.provider, "pi-remote");
  assert.equal(first.model, "pi-live");
  assert.equal(second.provider, "pi-remote");
  assert.equal(second.model, "pi-remote-default");
});
test("公开助手提交和会话消息不泄露供应商字段，审计仍保留内部字段", async () => {
  const app = Fastify({ logger: false });
  const now = new Date("2026-08-04T00:00:00.000Z");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const quoteId = "22222222-2222-4222-8222-222222222222";
  const projectId = "33333333-3333-4333-8333-333333333333";
  const message = {
    id: "44444444-4444-4444-8444-444444444444", sessionId, role: "assistant" as const, content: "已生成",
    toolName: null, toolArguments: { provider_task_id: "private-task-handle" }, toolResultSummary: { failure_reason: "provider raw failure" },
    status: "failed" as const, provider: "private-provider", model: "private-model-v1", usage: null,
    providerCostUsdMicros: null, pointsSpent: null, durationMs: 12, errorSummary: "安全的失败说明", createdAt: now,
  };
  app.addHook("preHandler", async (request) => { request.authUser = { id: "user-a", username: "tester", displayName: "测试用户" }; });
  let submittedInput: unknown;
  await registerAssistantRoutes(app, () => ({} as Database), {
    createRepository: () => ({
      getSession: async () => ({ id: sessionId, projectId, shotId: null }),
      listMessages: async () => [message],
      listProjectAuditLogs: async () => ({ items: [{ ...message, userId: "user-a", userName: "测试用户", projectId, shotId: null }], total: 1 }),
    } as never),
    submitGenerationQuote: async (_db, input) => {
      submittedInput = input;
      return {
        requestId: "55555555-5555-4555-8555-555555555555", attemptId: "66666666-6666-8666-666666666666", projectId,
        status: "failed", phase: "complete", attemptNo: 1, mediaKind: "video", tierId: "video-standard", model: "private-model-v1",
        prompt: "测试提示词", parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 }, providerTaskId: "private-task-handle",
        estimatedCostFen: 100, media: [], errorMessage: "provider raw failure", createdAt: now, updatedAt: now,
      } as GenerationView;
    },
    projectAccess: {
      requireCreative: async () => ({
        projectId,
        actorId: "user-a",
        platformRole: "member",
        membershipRole: "editor",
        isPlatformObserver: false,
      }),
    },
  });
  try {
    const submit = await app.inject({ method: "POST", url: `/api/v1/agent/sessions/${sessionId}/generation-quotes/${quoteId}/submit` });
    const audit = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/ai-audit-logs` });
    const messages = await app.inject({ method: "GET", url: `/api/v1/agent/sessions/${sessionId}/messages` });
    assert.equal(submit.statusCode, 202);
    assert.equal(audit.statusCode, 200);
    assert.equal(messages.statusCode, 200);
    for (const body of [submit.body, messages.body]) assert.doesNotMatch(body, /private-provider|private-model-v1|private-task-handle|provider raw failure/);
    assert.deepEqual(submit.json().data.tier_id, "video-standard");
    assert.equal(typeof submit.json().data.display_reason, "string");
    assert.match(audit.body, /private-provider|private-model-v1/);
    assert.deepEqual(submittedInput, {
      actorId: "user-a",
      authorizedProjectId: projectId,
      session: { id: sessionId, projectId, shotId: null },
      quoteId,
    });
  } finally {
    await app.close();
  }
});


test("历史消息刷新后通过 generation_quote 恢复报价卡，raw tool_result_summary 仍不外发", async () => {
  const app = Fastify({ logger: false });
  const now = new Date("2026-08-04T00:00:00.000Z");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const quoteId = "24c4daf4-d6d9-4894-8615-e24eb06e64ec";
  const message = {
    id: "44444444-4444-4444-8444-444444444444", sessionId, role: "tool" as const, content: "工具执行完成",
    toolName: "generate_media", toolArguments: null,
    toolResultSummary: {
      details: {
        generation_quote_id: quoteId,
        estimated_cost_fen: 320,
        currency: "CNY",
        expires_at: "2026-08-04T01:00:00.000Z",
        status: "pending_confirmation",
        media_kind: "video",
        pricing_rule_id: "secret-internal-rule",
        normalized_request: { prompt: "不应外发" },
      },
    },
    status: "completed" as const, provider: null, model: null, usage: null,
    providerCostUsdMicros: null, pointsSpent: null, durationMs: 12, errorSummary: null, createdAt: now,
  };
  app.addHook("preHandler", async (request) => { request.authUser = { id: "user-a", username: "tester", displayName: "测试用户" }; });
  await registerAssistantRoutes(app, () => ({} as Database), {
    createRepository: () => ({
      getSession: async () => ({ id: sessionId, projectId: null, shotId: null }),
      listMessages: async () => [message],
    } as never),
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/agent/sessions/${sessionId}/messages` });
    assert.equal(response.statusCode, 200);
    const item = (response.json().data.items as Array<Record<string, unknown>>)[0];
    // 刷新/重读后前端 generationQuoteFromMessage 首选字段可恢复报价
    assert.deepEqual(item?.generation_quote, {
      generation_quote_id: quoteId,
      source: "assistant",
      action: "submit",
      status: "pending_confirmation",
      estimated_cost_fen: 320,
      currency: "CNY",
      expires_at: "2026-08-04T01:00:00.000Z",
      media_kind: "video",
    });
    // raw summary 与内部字段继续不投影
    assert.equal("tool_result_summary" in (item ?? {}), false);
    assert.doesNotMatch(response.body, /tool_result_summary|pricing_rule_id|normalized_request|secret-internal-rule|不应外发/);
  } finally {
    await app.close();
  }
});

test("历史 tool_result_summary 字段不完整或非 generate_media 时不产出 generation_quote", async () => {
  const app = Fastify({ logger: false });
  const now = new Date("2026-08-04T00:00:00.000Z");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const quoteDetails = {
    generation_quote_id: "24c4daf4-d6d9-4894-8615-e24eb06e64ec",
    estimated_cost_fen: 320,
    currency: "CNY",
    expires_at: "2026-08-04T01:00:00.000Z",
    status: "pending_confirmation",
    media_kind: "video",
  };
  const makeMessage = (id: string, overrides: Record<string, unknown>) => ({
    id, sessionId, role: "tool" as const, content: "工具执行完成",
    toolName: "generate_media", toolArguments: null,
    toolResultSummary: { details: quoteDetails },
    status: "completed" as const, provider: null, model: null, usage: null,
    providerCostUsdMicros: null, pointsSpent: null, durationMs: 1, errorSummary: null, createdAt: now,
    ...overrides,
  });
  const rows = [
    makeMessage("44444444-4444-4444-8444-444444444441", { toolResultSummary: { details: { ...quoteDetails, estimated_cost_fen: -1 } } }),
    makeMessage("44444444-4444-4444-8444-444444444442", { toolResultSummary: { details: { ...quoteDetails, expires_at: "bad-date" } } }),
    makeMessage("44444444-4444-4444-8444-444444444443", { toolResultSummary: null }),
    makeMessage("44444444-4444-4444-8444-444444444445", { toolName: "search_assets" }),
    makeMessage("44444444-4444-4444-8444-444444444446", {}),
  ];
  app.addHook("preHandler", async (request) => { request.authUser = { id: "user-a", username: "tester", displayName: "测试用户" }; });
  await registerAssistantRoutes(app, () => ({} as Database), {
    createRepository: () => ({
      getSession: async () => ({ id: sessionId, projectId: null, shotId: null }),
      listMessages: async () => rows,
    } as never),
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/agent/sessions/${sessionId}/messages` });
    assert.equal(response.statusCode, 200);
    const items = response.json().data.items as Array<Record<string, unknown>>;
    for (const item of items.slice(0, 4)) assert.equal(item?.generation_quote, undefined);
    assert.ok(items[4]?.generation_quote, "完整历史报价必须恢复");
  } finally {
    await app.close();
  }
});

test("项目审计只投影元数据，不返回会话正文、工具原始数据或供应商原始错误", async () => {
  const app = Fastify({ logger: false });
  const now = new Date("2026-08-04T00:00:00.000Z");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const projectId = "33333333-3333-4333-8333-333333333333";
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: "user-a", username: "tester", displayName: "测试用户" };
  });
  await registerAssistantRoutes(app, () => ({} as Database), {
    createRepository: () => ({
      listProjectAuditLogs: async () => ({
        items: [{
          id: "44444444-4444-4444-8444-444444444444",
          sessionId,
          role: "assistant",
          toolName: null,
          status: "failed",
          provider: "private-provider",
          model: "private-model-v1",
          usage: null,
          providerCostUsdMicros: null,
          pointsSpent: null,
          durationMs: 12,
          errorCode: "assistant_model_error" as const,
          createdAt: now,
          userId: "user-a",
          userName: "测试用户",
          projectId,
          shotId: null,
        }],
        total: 1,
      }),
    } as never),
  });
  try {
    const audit = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/ai-audit-logs` });
    assert.equal(audit.statusCode, 200);
    assert.match(audit.body, /private-provider|private-model-v1|assistant_model_error/);
    assert.doesNotMatch(audit.body, /content|tool_arguments|tool_result_summary|error_summary|provider raw failure/);
  } finally {
    await app.close();
  }
});

test("受控 Gateway 启用但远程配置不完整时拒绝创建助手请求", async () => {
  const original = {
    enabled: settings.aiGatewayEnabled,
    url: settings.piRemoteApiUrl,
    token: settings.piRemoteApiToken,
    model: settings.piRemoteModel,
  };
  const mutableSettings = settings as { aiGatewayEnabled: boolean; piRemoteApiUrl?: string; piRemoteApiToken?: string; piRemoteModel?: string };
  const sessionId = "11111111-1111-4111-8111-111111111111";
  try {
    for (const missing of ["url", "token", "model"] as const) {
      mutableSettings.aiGatewayEnabled = true;
      mutableSettings.piRemoteApiUrl = missing === "url" ? undefined : "https://pi.example.invalid";
      mutableSettings.piRemoteApiToken = missing === "token" ? undefined : "test-token";
      mutableSettings.piRemoteModel = missing === "model" ? undefined : "pi-remote";
      const app = Fastify({ logger: false });
      let historyReads = 0;
      app.addHook("preHandler", async (request) => {
        request.authUser = { id: "user-a", username: "tester", displayName: "测试用户" };
      });
      await registerAssistantRoutes(app, () => ({} as Database), {
        createRepository: () => ({
          getSession: async () => ({ id: sessionId, projectId: null, shotId: null, agentType: "platform_assistant" }),
          listMessages: async () => { historyReads += 1; return []; },
        } as never),
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/agent/sessions/${sessionId}/messages`,
        payload: { content: "检索古风资产" },
      });
      assert.equal(response.statusCode, 503, `${missing} 缺失必须拒绝`);
      assert.equal(historyReads, 0, `${missing} 缺失不得读取或写入会话`);
      await app.close();
    }
  } finally {
    mutableSettings.aiGatewayEnabled = original.enabled;
    mutableSettings.piRemoteApiUrl = original.url;
    mutableSettings.piRemoteApiToken = original.token;
    mutableSettings.piRemoteModel = original.model;
  }
});
