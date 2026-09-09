import assert from "node:assert/strict";
import test from "node:test";
import { ColCompletionProvider, type ColFetch } from "./colCompletionProvider.js";

/**
 * 生产实际走的分支:公司通道 + 非 doubao 模型(deepseek-v4-flash)。
 * 改造前这条分支上 thinking 被静默丢弃——没有错误、没有日志,调用方
 * 以为关掉了深度思考,实际每次都在按 high 强度产生计费思维链。
 */

const baseUrl = "https://company-gateway.example.invalid";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingProvider(model: string, payload: unknown) {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse(payload);
  }) as ColFetch;
  return {
    provider: new ColCompletionProvider("company-test-key", model, baseUrl, fetchImpl),
    body: () => body,
  };
}

test("公司通道对非 doubao 模型同样下发 thinking,不静默丢参数", async () => {
  const model = "deepseek-v4-flash-ga-260731";
  const recorded = recordingProvider(model, {
    model,
    choices: [{ message: { content: "{\"ok\":true}" } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });

  await recorded.provider.complete({
    system: "只输出 JSON",
    prompt: "拆解剧本",
    thinking: "disabled",
    maxTokens: 512,
  });

  assert.deepEqual(recorded.body().thinking, { type: "disabled" });
});

test("公司通道返回的推理内容不混进正文", async () => {
  const model = "deepseek-v4-flash-ga-260731";
  const recorded = recordingProvider(model, {
    model,
    choices: [{
      message: {
        reasoning_content: "先分析场次结构……",
        content: [
          { type: "reasoning", text: "这段是思考,不是答案" },
          { type: "text", text: "{\"ok\":true}" },
        ],
      },
    }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });

  const result = await recorded.provider.complete({
    system: "只输出 JSON",
    prompt: "拆解剧本",
    maxTokens: 512,
  });

  assert.equal(result.content, "{\"ok\":true}");
});
