import assert from "node:assert/strict";
import test from "node:test";
import { ArkChatClient, type ArkFetch } from "./arkClient.js";
import type { AiToolTurnRequest } from "../modules/ai/types.js";

/**
 * 火山通道的工具调用轮次。测试环境跑的就是这条,#228 合入时它一条用例都没有。
 *
 * 这里钉的核心一条:一次响应里 6 个工具调用、只有 1 个入参读不出时,另外 5 个
 * 照常带回,只有坏的那一条被单独报上来。整批一起抛错等于让模型把已经做对的
 * 五件事重做一遍,也等于把「读不出」伪装成「模型没干活」。
 */

const endpoint = "https://ark.example.invalid/api/v3";

function request(): AiToolTurnRequest {
  return {
    system: "你是拆解助手",
    messages: [{ role: "user", content: "剧本在这里" }],
    tools: [{
      name: "add_character",
      description: "登记角色",
      parameters: { type: "object", properties: { name: { type: "string" } } },
    }],
    thinking: "disabled",
    maxTokens: 4_096,
  };
}

function toolCall(id: string, name: string, args: string) {
  return { id, type: "function", function: { name, arguments: args } };
}

function clientReturning(toolCalls: unknown[], content: string | null = null) {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: "deepseek-v4-flash-ga-260731",
      choices: [{ message: { content, tool_calls: toolCalls } }],
      usage: { prompt_tokens: 300, completion_tokens: 90 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as ArkFetch;
  return {
    client: new ArkChatClient("test-api-key", "configured-model", endpoint, fetchImpl),
    body: () => body,
  };
}

test("工具表按 OpenAI 兼容格式送上去,返回的入参在这里解析成对象", async () => {
  const recorded = clientReturning([
    toolCall("call_1", "add_character", "{\"name\":\"林晚\"}"),
  ]);

  const turn = await recorded.client.completeToolTurn(request());

  assert.deepEqual(recorded.body().tools, [{
    type: "function",
    function: {
      name: "add_character",
      description: "登记角色",
      parameters: { type: "object", properties: { name: { type: "string" } } },
    },
  }]);
  assert.deepEqual(turn.toolCalls, [{ id: "call_1", name: "add_character", arguments: { name: "林晚" } }]);
  assert.deepEqual(turn.unreadableToolCalls, []);
  assert.equal(turn.inputTokens, 300);
});

test("一批里坏一条:其余五条照常带回,坏的那条单独报上来", async () => {
  // 实测报文形状:age_stage 的值 female 是裸词,不是合法 JSON。
  const recorded = clientReturning([
    toolCall("call_1", "add_character", "{\"name\":\"林晚\"}"),
    toolCall("call_2", "add_character", "{\"name\": \"Grandma\", \"gender\": female}"),
    toolCall("call_3", "add_character", "{\"name\":\"掌柜\"}"),
    toolCall("call_4", "add_character", "{\"name\":\"周行\"}"),
    toolCall("call_5", "add_character", "{\"name\":\"小二\"}"),
    toolCall("call_6", "add_character", "{\"name\":\"老张\"}"),
  ]);

  const turn = await recorded.client.completeToolTurn(request());

  assert.deepEqual(
    turn.toolCalls.map((call) => call.id),
    ["call_1", "call_3", "call_4", "call_5", "call_6"],
    "读得出的五条一条都不能少",
  );
  assert.equal(turn.unreadableToolCalls.length, 1);
  assert.equal(turn.unreadableToolCalls[0]?.id, "call_2");
  assert.equal(turn.unreadableToolCalls[0]?.name, "add_character");
  assert.match(turn.unreadableToolCalls[0]?.argumentsExcerpt ?? "", /Grandma/);
});

test("id 或函数名缺失是协议层坏掉,只能整轮报错", async () => {
  // 没有 id 就没法把结果对回去,这一条无法降级成「只重这一次」。
  const recorded = clientReturning([{ type: "function", function: { name: "add_character", arguments: "{}" } }]);

  await assert.rejects(recorded.client.completeToolTurn(request()), /tool call is missing id or function/);
});
