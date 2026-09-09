import assert from "node:assert/strict";
import test from "node:test";
import { ExternalServiceError } from "../../shared/errors.js";
import { MiniMaxCompletionProvider, type MiniMaxFetch } from "./minimaxCompletionProvider.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function provider(fetchImpl: MiniMaxFetch, baseUrl?: string): MiniMaxCompletionProvider {
  return new MiniMaxCompletionProvider("test-api-key", "MiniMax-M3", baseUrl, fetchImpl);
}

test("MiniMax completion uses the official endpoint, bearer header, M3 thinking and non-streaming body", async () => {
  let url: string | URL | Request | undefined;
  let request: RequestInit | undefined;
  const fetchImpl = (async (receivedUrl: string | URL | Request, init?: RequestInit) => {
    url = receivedUrl;
    request = init;
    return response({
      model: "MiniMax-M3",
      choices: [{ message: { content: "完成内容" } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    });
  }) as MiniMaxFetch;

  const completion = await provider(fetchImpl).complete({
    system: "系统提示",
    prompt: "用户提示",
    thinking: "auto",
    maxTokens: 321,
  });

  assert.equal(String(url), "https://api.minimaxi.com/v1/chat/completions");
  assert.deepEqual(request?.headers, {
    Authorization: "Bearer test-api-key",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(request?.body)), {
    model: "MiniMax-M3",
    thinking: { type: "adaptive" },
    max_completion_tokens: 321,
    stream: false,
    messages: [
      { role: "system", content: "系统提示" },
      { role: "user", content: "用户提示" },
    ],
  });
  assert.deepEqual(completion, {
    content: "完成内容",
    model: "MiniMax-M3",
    inputTokens: 12,
    outputTokens: 8,
    durationMs: completion.durationMs,
  });
  assert.ok(completion.durationMs >= 0);
});

test("M3 maps enabled and disabled thinking, while M2.x omits the unsupported field", async () => {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return response({ choices: [{ message: { content: "内容" } }] });
  }) as MiniMaxFetch;
  const client = provider(fetchImpl);

  await client.complete({ system: "s", prompt: "p", thinking: "enabled", maxTokens: 1 });
  await client.complete({ system: "s", prompt: "p", model: "MiniMax-M3", thinking: "disabled", maxTokens: 1 });
  await client.complete({ system: "s", prompt: "p", model: "MiniMax-M2.7", thinking: "disabled", maxTokens: 1 });

  assert.deepEqual((bodies[0] as { thinking?: unknown }).thinking, { type: "enabled" });
  assert.deepEqual((bodies[1] as { thinking?: unknown }).thinking, { type: "disabled" });
  assert.equal("thinking" in (bodies[2] as object), false);
});

test("MiniMax completion accepts content parts and absent usage", async () => {
  const completion = await provider((async () => response({
    choices: [{ message: { content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] } }],
  })) as MiniMaxFetch).complete({ system: "s", prompt: "p", maxTokens: 1 });

  assert.equal(completion.content, "第一段第二段");
  assert.equal(completion.model, "MiniMax-M3");
  assert.equal(completion.inputTokens, null);
  assert.equal(completion.outputTokens, null);
});

test("MiniMax base URL only permits HTTPS official hosts and rejects legacy api.minimax.io", () => {
  for (const baseUrl of [
    "http://api.minimaxi.com",
    "https://api.minimax.io",
    "https://api.minimaxi.com.evil.example",
    "not a URL",
  ]) {
    assert.throws(
      () => provider((async () => response({})) as MiniMaxFetch, baseUrl),
      (error: unknown) => error instanceof ExternalServiceError
        && error.message === "MiniMax model: invalid base URL configuration",
    );
  }
  assert.doesNotThrow(() => provider((async () => response({})) as MiniMaxFetch, "https://api-bj.minimaxi.com/v1"));
});

for (const status of [401, 429, 503]) {
  test(`MiniMax HTTP ${status} is a consumable public error without the provider message`, async () => {
    const secret = "provider_secret_should_not_appear";
    await assert.rejects(
      provider((async () => response({ error: { message: secret } }, status)) as MiniMaxFetch)
        .complete({ system: "s", prompt: "p", maxTokens: 1 }),
      (error: unknown) => error instanceof ExternalServiceError
        && error.statusCode === 502
        && error.code === "external_service_error"
        && error.message === `MiniMax model: chat completion failed with status ${status}`
        && !error.message.includes(secret),
    );
  });
}

test("MiniMax invalid JSON and network failures redact provider details", async () => {
  const secret = "provider_secret_should_not_appear";
  await assert.rejects(
    provider((async () => new Response(secret)) as MiniMaxFetch).complete({ system: "s", prompt: "p", maxTokens: 1 }),
    (error: unknown) => error instanceof Error
      && error.message === "MiniMax model: chat completion returned invalid JSON"
      && !error.message.includes(secret),
  );
  await assert.rejects(
    provider((async () => { throw new Error(secret); }) as MiniMaxFetch).complete({ system: "s", prompt: "p", maxTokens: 1 }),
    (error: unknown) => error instanceof Error
      && error.message === "MiniMax model: chat completion request failed"
      && !error.message.includes(secret),
  );
});
