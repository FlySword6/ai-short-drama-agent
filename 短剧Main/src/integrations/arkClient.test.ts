import assert from "node:assert/strict";
import test from "node:test";
import {
  ArkChatClient,
  MAX_ARK_CHAT_MAX_TOKENS,
  type ArkFetch,
} from "./arkClient.js";

const endpoint = "https://ark.example.invalid/api/v3";

function chatResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: ArkFetch): ArkChatClient {
  return new ArkChatClient("test-api-key", "configured-model", endpoint, fetchImpl);
}

test("结构化完成返回 Ark 模型、token 用量和耗时，未显式限额的旧文本 API 保持兼容", async () => {
  let request: RequestInit | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return chatResponse({
      model: "doubao-pro-32k",
      choices: [{ message: { content: "生成好的内容" } }],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    });
  }) as ArkFetch;
  const timing: Record<string, number> = {};

  const result = await client(fetchImpl).completeTextWithMetadata("写一个提示词", "系统提示", {
    temperature: 0.2,
    timing,
    timingPrefix: "prompt_draft",
  });

  assert.deepEqual(result, {
    content: "生成好的内容",
    model: "doubao-pro-32k",
    inputTokens: 123,
    outputTokens: 45,
    durationMs: result.durationMs,
  });
  assert.ok(result.durationMs >= 0);
  assert.ok(typeof timing.prompt_draft_http === "number");
  assert.deepEqual(JSON.parse(String(request?.body)), {
    model: "configured-model",
    temperature: 0.2,
    messages: [
      { role: "system", content: "系统提示" },
      { role: "user", content: "写一个提示词" },
    ],
  });

  const legacy = await client((async () => chatResponse({
    model: "doubao-pro-32k",
    choices: [{ message: { content: "旧接口内容" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })) as ArkFetch).completeMessages([{ role: "user", content: "继续" }]);
  assert.equal(legacy, "旧接口内容");
});

test("结构化完成向 Ark 透传受限 max_tokens，调用方可收紧但不能放大超过适配器上限", async () => {
  let request: RequestInit | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return chatResponse({ choices: [{ message: { content: "内容" } }] });
  }) as ArkFetch;

  await client(fetchImpl).completeMessagesWithMetadata([{ role: "user", content: "问题" }], {
    maxTokens: 320,
    thinking: "disabled",
  });
  assert.deepEqual(JSON.parse(String(request?.body)).thinking, { type: "disabled" });
  assert.equal(JSON.parse(String(request?.body)).max_tokens, 320);

  await assert.rejects(
    client(fetchImpl).completeMessagesWithMetadata([{ role: "user", content: "问题" }], {
      maxTokens: MAX_ARK_CHAT_MAX_TOKENS + 1,
    }),
    (error: unknown) => error instanceof Error
      && error.message === `Ark: chat completion max_tokens must be an integer between 1 and ${MAX_ARK_CHAT_MAX_TOKENS}`,
  );
});

test("结构化完成缺少 usage 时保留空值，并回退到请求模型", async () => {
  const result = await client((async () => chatResponse({
    choices: [{ message: { content: "内容" } }],
  })) as ArkFetch).completeMessagesWithMetadata([{ role: "user", content: "问题" }]);

  assert.equal(result.model, "configured-model");
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
});

test("HTTP 失败不泄漏 Ark 原始响应", async () => {
  const clientWithFailure = client((async () => chatResponse({
    error: { message: "provider_secret_should_not_appear" },
  }, 401)) as ArkFetch);

  await assert.rejects(
    clientWithFailure.completeMessagesWithMetadata([{ role: "user", content: "问题" }]),
    (error: unknown) => error instanceof Error
      && error.message === "Ark: chat completion failed with status 401"
      && !error.message.includes("provider_secret_should_not_appear"),
  );
});

test("HTTP 200 但正文不是 JSON 时不泄漏 Ark 原始响应", async () => {
  const clientWithInvalidJson = client((async () => new Response(
    "provider_secret_should_not_appear",
    { status: 200, headers: { "Content-Type": "application/json" } },
  )) as ArkFetch);

  await assert.rejects(
    clientWithInvalidJson.completeMessagesWithMetadata([{ role: "user", content: "问题" }]),
    (error: unknown) => error instanceof Error
      && error.message === "Ark: chat completion returned invalid JSON"
      && !error.message.includes("provider_secret_should_not_appear"),
  );
});

test("网络失败不泄漏 fetch 的底层错误详情", async () => {
  const clientWithNetworkFailure = client((async () => {
    throw new Error("provider_secret_should_not_appear");
  }) as ArkFetch);

  await assert.rejects(
    clientWithNetworkFailure.completeMessagesWithMetadata([{ role: "user", content: "问题" }]),
    (error: unknown) => error instanceof Error
      && error.message === "Ark: chat completion request failed"
      && !error.message.includes("provider_secret_should_not_appear"),
  );
});

test("空内容不泄漏 Ark 原始响应", async () => {
  const clientWithEmptyContent = client((async () => chatResponse({
    choices: [{ message: { content: "" } }],
    debug: "provider_secret_should_not_appear",
  })) as ArkFetch);

  await assert.rejects(
    clientWithEmptyContent.completeMessagesWithMetadata([{ role: "user", content: "问题" }]),
    (error: unknown) => error instanceof Error
      && error.message === "Ark: chat completion returned empty content"
      && !error.message.includes("provider_secret_should_not_appear"),
  );
});

test("旧 completeJson 保留 JSON 修复兼容行为", async () => {
  let calls = 0;
  const legacyJsonClient = client((async () => {
    calls += 1;
    return chatResponse({
      choices: [{ message: { content: calls === 1 ? "{不是合法 JSON" : '{"fixed":true}' } }],
    });
  }) as ArkFetch);

  assert.deepEqual(await legacyJsonClient.completeJson("返回 JSON"), { fixed: true });
  assert.equal(calls, 2);
});
