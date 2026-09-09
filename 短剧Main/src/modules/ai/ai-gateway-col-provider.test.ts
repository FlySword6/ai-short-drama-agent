import assert from "node:assert/strict";
import test from "node:test";
import { AppError, ExternalServiceError } from "../../shared/errors.js";
import {
  ColCompletionProvider,
  ColCompletionTimeoutError,
  resolveColEndpoint,
  type ColFetch,
} from "./colCompletionProvider.js";
import { AiGatewayService } from "./service.js";
import type { AiCallRepository, FailAiCallInput } from "./types.js";

const baseUrl = "https://company-gateway.example.invalid";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("ai-gateway-col-适配器按公司网关 v1 合同发送并解析可审计用量", async () => {
  let requestedUrl = "";
  let request: RequestInit | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    request = init;
    return response({
      model: "doubao-seed-2-1-pro-260628",
      choices: [{ message: { content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 31, completion_tokens: 17 },
    });
  }) as ColFetch;
  const provider = new ColCompletionProvider(
    "company-test-key",
    "doubao-seed-2-1-pro-260628",
    baseUrl,
    fetchImpl,
  );

  const result = await provider.complete({
    system: "只输出 JSON",
    prompt: "拆解剧本",
    thinking: "disabled",
    maxTokens: 512,
  });

  assert.equal(requestedUrl, `${baseUrl}/v1/chat/completions`);
  assert.equal(new Headers(request?.headers).get("Authorization"), "Bearer company-test-key");
  assert.deepEqual(JSON.parse(String(request?.body)), {
    model: "doubao-seed-2-1-pro-260628",
    temperature: 0,
    thinking: { type: "disabled" },
    max_tokens: 512,
    stream: false,
    messages: [
      { role: "system", content: "只输出 JSON" },
      { role: "user", content: "拆解剧本" },
    ],
  });
  assert.deepEqual(result, {
    content: "{\"ok\":true}",
    model: "doubao-seed-2-1-pro-260628",
    inputTokens: 31,
    outputTokens: 17,
    durationMs: result.durationMs,
  });
  assert.ok(result.durationMs >= 0);
});

test("ai-gateway-col-基础地址统一落到 v1 且拒绝不安全配置", () => {
  assert.equal(
    resolveColEndpoint("https://company-gateway.example.invalid/", "models"),
    "https://company-gateway.example.invalid/v1/models",
  );
  assert.equal(
    resolveColEndpoint("https://company-gateway.example.invalid/v1", "chat/completions"),
    "https://company-gateway.example.invalid/v1/chat/completions",
  );
  for (const unsafe of [
    "http://company-gateway.example.invalid",
    "https://user:password@company-gateway.example.invalid",
    "https://company-gateway.example.invalid?token=unsafe",
  ]) {
    assert.throws(
      () => resolveColEndpoint(unsafe, "models"),
      (error: unknown) => error instanceof ExternalServiceError
        && error.message === "公司 AI 通道: invalid COL_BASE_URL configuration"
        && !error.message.includes(unsafe),
    );
  }
});

test("ai-gateway-col-上游失败和正文不会泄漏到应用错误", async () => {
  const key = "company-secret-must-not-appear";
  const cases: Array<[string, ColFetch, string]> = [
    [
      "http",
      (async () => response({ error: { message: key } }, 401)) as ColFetch,
      "公司 AI 通道: chat completion failed with status 401",
    ],
    [
      "invalid-json",
      (async () => new Response(key, { status: 200 })) as ColFetch,
      "公司 AI 通道: chat completion returned invalid JSON",
    ],
    [
      "network",
      (async () => {
        throw new Error(key);
      }) as ColFetch,
      "公司 AI 通道: chat completion request failed",
    ],
  ];
  for (const [name, fetchImpl, expected] of cases) {
    const provider = new ColCompletionProvider(
      key,
      "deepseek-v4-flash",
      baseUrl,
      fetchImpl,
    );
    await assert.rejects(
      provider.complete({
        system: "system",
        prompt: "prompt",
        maxTokens: 32,
      }),
      (error: unknown) => error instanceof ExternalServiceError
        && error.message === expected
        && !error.message.includes(key),
      name,
    );
  }
});

test("ai-gateway-col-响应缺少实际模型或 token 时拒绝记成成功", async () => {
  for (const [name, payload] of [
    [
      "model",
      {
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ],
    [
      "usage",
      {
        model: "deepseek-v4-flash",
        choices: [{ message: { content: "{\"ok\":true}" } }],
      },
    ],
  ] as const) {
    const provider = new ColCompletionProvider(
      "key",
      "deepseek-v4-flash",
      baseUrl,
      (async () => response(payload)) as ColFetch,
    );
    await assert.rejects(
      provider.complete({
        system: "system",
        prompt: "prompt",
        maxTokens: 32,
      }),
      (error: unknown) => error instanceof ExternalServiceError
        && error.internalMessage === "chat completion omitted required audit metadata",
      name,
    );
  }
});

test("ai-gateway-col-请求超时会终止外呼并返回可重试中文错误", async () => {
  for (const phase of ["headers", "body"] as const) {
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
      const rejectForAbort = (reject: (reason?: unknown) => void) => {
        const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      };
      if (phase === "headers") {
        return new Promise<Response>((_resolve, reject) => rejectForAbort(reject));
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          rejectForAbort((reason) => controller.error(reason));
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as ColFetch;
    const provider = new ColCompletionProvider(
      "key",
      "deepseek-v4-flash",
      baseUrl,
      fetchImpl,
      1,
    );
    const failed: FailAiCallInput[] = [];
    const repository: AiCallRepository = {
      async reserve() {
        return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      },
      async complete() {
        assert.fail("超时调用不能记成成功");
      },
      async fail(input) {
        failed.push(input);
      },
    };
    const gateway = new AiGatewayService(repository, provider, {
      enabled: true,
      apiKeyConfigured: true,
      dailyCallLimit: 10,
      defaultModel: "deepseek-v4-flash",
      embeddingModel: null,
    });

    await assert.rejects(
      gateway.complete({
        actorId: "11111111-1111-4111-8111-111111111111",
        purpose: "prompt_translate",
        system: "system",
        prompt: "prompt",
        maxTokens: 32,
      }),
      (error: unknown) => error instanceof AppError
        && error.statusCode === 504
        && error.code === "ai_request_timeout"
        && error.retryable
        && error.message === "AI 处理超时了，这次没有完成，请稍后重试。",
      phase,
    );
    assert.equal(failed.length, 1, phase);
    assert.equal(failed[0]?.errorCode, "provider_timeout", phase);
  }
});

/**
 * 判断的后半截:`timeoutSignal.aborted || isAbortLike(error)` 里的 `isAbortLike`。
 *
 * 上面那条用例两个阶段都是「signal 确实掐了」,`aborted` 先短路,`isAbortLike`
 * **一次都没被执行过**——把它整个改成恒 false,上面那条照样绿(实测)。也就是说
 * 这半截判断此前是零守卫的,而本次它刚从本文件的私有拷贝换成
 * `shared/providerTransportFailure` 里的那一份:换了个没人看着的东西,等于没换。
 *
 * 所以这条专挑相反的形状:超时预算给足到不可能触发,让 `aborted` 恒为 false,
 * 只剩异常自己是 abort 家族这一个线索。它管的事是——abort 家族不许落进
 * 「chat completion request failed」那个筐,那句话读起来就是供应商拒答,
 * 而 #282 治的正是这种冤枉。
 */
test("ai-gateway-col-signal 没掐但异常是 abort 家族时,仍算超时而不是「请求失败」", async () => {
  const abortLike = () => new DOMException("The operation was aborted", "AbortError");

  for (const phase of ["headers", "body"] as const) {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
      // 前提钉住:这条路一旦靠上了 aborted,就不再是在测 isAbortLike 了。
      assert.equal(signal.aborted, false, phase);
      if (phase === "headers") throw abortLike();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(abortLike());
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as ColFetch;

    await assert.rejects(
      new ColCompletionProvider("key", "deepseek-v4-flash", baseUrl, fetchImpl, 600_000).complete({
        system: "system",
        prompt: "prompt",
        maxTokens: 32,
      }),
      (error: unknown) => error instanceof ColCompletionTimeoutError
        && error.internalMessage === "chat completion timed out",
      phase,
    );
  }
});

test("ai-gateway-col-缺凭据或模型时在外呼前失败并指出配置项", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return response({});
  }) as ColFetch;
  await assert.rejects(
    new ColCompletionProvider(undefined, "model", baseUrl, fetchImpl).complete({
      system: "s",
      prompt: "p",
      maxTokens: 1,
    }),
    /COL_APIKEY/,
  );
  await assert.rejects(
    new ColCompletionProvider("key", undefined, baseUrl, fetchImpl).complete({
      system: "s",
      prompt: "p",
      maxTokens: 1,
    }),
    /model configuration/,
  );
  assert.equal(calls, 0);
});

test("ai-gateway-col-每次调用可带超时覆盖;覆盖超时生效且越界拒收(阶段②放宽同一口径)", async () => {
  // 挂起等 abort:默认超时给足(10s)不可能触发,只有覆盖的 5ms 能掐到。
  const hangUntilAbort = (async (_url: string | URL | Request, init?: RequestInit): Promise<never> => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "TimeoutError"));
      });
    });
    throw new Error("unreachable");
  }) as unknown as ColFetch;
  const provider = new ColCompletionProvider("key", "doubao-seed-2-1-pro-260628", baseUrl, hangUntilAbort, 10_000);

  await assert.rejects(
    provider.complete({ system: "s", prompt: "p", maxTokens: 16, timeoutMs: 5 }),
    (error: unknown) => error instanceof ColCompletionTimeoutError,
    "5ms 覆盖生效:默认 10s 不可能在这个时间窗内掐到",
  );

  for (const bad of [0, -1, 600_001, 1.5]) {
    await assert.rejects(
      provider.complete({ system: "s", prompt: "p", maxTokens: 16, timeoutMs: bad }),
      /invalid request timeout override/,
      String(bad),
    );
  }
});
