import assert from "node:assert/strict";
import test from "node:test";
import { ColCompletionProvider, type ColFetch } from "./colCompletionProvider.js";
import type { AiToolTurnRequest } from "./types.js";

/**
 * 工具调用轮次的传输合同。结构化输出不再靠提示词祈求 JSON,而是把工具表
 * 按 OpenAI 兼容格式送上去,再把返回的 tool_calls 如实带回来。
 */

const baseUrl = "https://company-gateway.example.invalid";
const model = "deepseek-v4-flash-ga-260731";

function request(): AiToolTurnRequest {
  return {
    system: "你是拆解助手",
    messages: [
      { role: "user", content: "剧本在这里" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "add_scene", arguments: { summary: "开场" } }],
      },
      { role: "tool", content: "已拆出第 1 场", toolCallId: "call_1" },
    ],
    tools: [{
      name: "add_scene",
      description: "拆出一场",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    }],
    thinking: "disabled",
    maxTokens: 4_096,
  };
}

function providerWith(payload: unknown, status = 200) {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as ColFetch;
  return {
    provider: new ColCompletionProvider("company-test-key", model, baseUrl, fetchImpl),
    body: () => body,
  };
}

test("工具表与历史消息按 OpenAI 兼容格式送上去", async () => {
  const recorded = providerWith({
    model,
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call_2",
          type: "function",
          function: { name: "add_scene", arguments: "{\"summary\":\"第二场\"}" },
        }],
      },
    }],
    usage: { prompt_tokens: 200, completion_tokens: 40 },
  });

  await recorded.provider.completeToolTurn(request());

  const body = recorded.body();
  assert.deepEqual(body.tools, [{
    type: "function",
    function: {
      name: "add_scene",
      description: "拆出一场",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    },
  }]);
  assert.deepEqual(body.messages, [
    { role: "system", content: "你是拆解助手" },
    { role: "user", content: "剧本在这里" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "add_scene", arguments: "{\"summary\":\"开场\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call_1", content: "已拆出第 1 场" },
  ]);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 4_096);
});

test("返回的工具调用如实带回,入参字符串在这里解析成对象", async () => {
  const recorded = providerWith({
    model,
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call_2",
          type: "function",
          function: { name: "add_scene", arguments: "{\"summary\":\"第二场\"}" },
        }],
      },
    }],
    usage: { prompt_tokens: 200, completion_tokens: 40 },
  });

  const turn = await recorded.provider.completeToolTurn(request());

  assert.deepEqual(turn.toolCalls, [{ id: "call_2", name: "add_scene", arguments: { summary: "第二场" } }]);
  assert.equal(turn.content, "");
  assert.equal(turn.model, model);
  assert.equal(turn.inputTokens, 200);
  assert.equal(turn.outputTokens, 40);
});

test("没有工具调用只有正文时也是一轮合法结果", async () => {
  const recorded = providerWith({
    model,
    choices: [{ message: { content: "拆完了" } }],
    usage: { prompt_tokens: 200, completion_tokens: 4 },
  });

  const turn = await recorded.provider.completeToolTurn(request());

  assert.deepEqual(turn.toolCalls, []);
  assert.equal(turn.content, "拆完了");
});

test("工具入参不是合法 JSON 时单独报上来,不把半截参数交给下游", async () => {
  const recorded = providerWith({
    model,
    choices: [{
      message: {
        content: null,
        tool_calls: [
          { id: "call_2", type: "function", function: { name: "add_scene", arguments: "{\"summary\":" } },
          { id: "call_3", type: "function", function: { name: "add_scene", arguments: "{\"summary\":\"第三场\"}" } },
        ],
      },
    }],
    usage: { prompt_tokens: 200, completion_tokens: 40 },
  });

  const turn = await recorded.provider.completeToolTurn(request());

  assert.deepEqual(turn.toolCalls, [{ id: "call_3", name: "add_scene", arguments: { summary: "第三场" } }]);
  assert.equal(turn.unreadableToolCalls.length, 1);
  assert.equal(turn.unreadableToolCalls[0]?.id, "call_2");
  assert.match(turn.unreadableToolCalls[0]?.argumentsExcerpt ?? "", /summary/);
});

test("公司通道与火山通道对读不出的入参给同一种交代", async () => {
  const recorded = providerWith({
    model,
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "call_2", type: "function", function: { name: "add_scene", arguments: "not json" } }],
      },
    }],
    usage: { prompt_tokens: 200, completion_tokens: 40 },
  });

  const turn = await recorded.provider.completeToolTurn(request());

  assert.deepEqual(turn.toolCalls, []);
  assert.deepEqual(turn.unreadableToolCalls.map((call) => call.name), ["add_scene"]);
});
