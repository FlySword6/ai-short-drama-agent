import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import { Agent } from "undici";
import { ArkChatClient, LLM_HTTP_DISPATCHER } from "./arkClient.js";

/**
 * 阶段②两次 `dur=300683ms err=provider_timeout` 的病根与钉法。
 *
 * Node 内置 fetch(undici)的 `headersTimeout` 默认 300s,独立于 AbortSignal 计算;
 * Ark 请求非流式,响应头等模型生成完才回来。阶段②生成一旦超过 300s,undici 先于
 * 网关放宽的 600s 预算把连接掐了。修法:LLM 请求挂专用 dispatcher(内部计时器归零),
 * 让网关按用途下发的 AbortSignal 成为唯一超时权威。
 *
 * 三条用例各钉一环:
 * 1. Ark 每次真实 fetch 都必须挂 LLM_HTTP_DISPATCHER(谁删掉那行立刻红);
 * 2. Node 内置 fetch 确实认 undici Agent 的 headersTimeout(环境能力钉:哪天
 *    Node 升级不再认,修复静默失效,这里先红);
 * 3. LLM_HTTP_DISPATCHER 必须放得下数百毫秒级的慢响应头(谁把归零的计时器
 *    「优化」回一个小值,慢但正常的请求会被误杀,这里红)。
 */

/** 测试用端口的关闭必须立刻完成:先把已接受的连接全部销毁,再关监听。
    「永不回应」的连接不销毁,server.close() 会一直等它们结束而挂死。 */
function makeServer(handler: (socket: Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

/** 永不回 HTTP 响应的本地端口:模拟「模型还在生成,头没回来」。 */
function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return makeServer(() => { /* accept, never respond */ });
}

/** 延迟 delayMs 后才发 200 响应头的端口:模拟「生成慢,但终于回来了」。 */
function slowHeaderServer(delayMs: number, body: string): Promise<{ port: number; close: () => Promise<void> }> {
  return makeServer((socket) => {
    setTimeout(() => {
      if (socket.destroyed) return;
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      socket.end();
    }, delayMs);
  });
}

function arkJson(): string {
  return JSON.stringify({ model: "configured-model", choices: [{ message: { content: "ok" } }] });
}

/**
 * 吊住事件循环的保险丝。`AbortSignal.timeout` 与 undici 内部计时器都是 unref 的,
 * 测试环境里一旦只剩它们,事件循环会提前散场,await 变成「悬着没落地」
 * (同 ark-transport-failure.test.ts 顶部注释里钉过的同一个坑)。
 */
async function withKeepAlive<T>(fn: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

test("Ark 每次 fetch 必须挂 LLM_HTTP_DISPATCHER:超时权威只认网关的 AbortSignal", async () => {
  const seen: Array<{ dispatcher: unknown; hasSignal: boolean }> = [];
  const spyFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push({ dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher, hasSignal: init?.signal instanceof AbortSignal });
    return new Response(arkJson());
  }) as typeof fetch;
  const client = new ArkChatClient("test-key", "configured-model", "https://ark.example.invalid/api/v3", spyFetch, 25);

  await client.completeTextWithMetadata("问题", "系统", { timeoutMs: 600_000 });
  await client.completeToolTurn({
    system: "你是拆解助手",
    messages: [{ role: "user", content: "剧本在这里" }],
    tools: [],
    thinking: "disabled",
    maxTokens: 4_096,
  });

  assert.equal(seen.length, 2, "complete 与工具轮各发一次真实请求");
  for (const call of seen) {
    assert.equal(call.dispatcher, LLM_HTTP_DISPATCHER, "两条路径都必须挂 LLM 专用 dispatcher");
    assert.equal(call.hasSignal, true, "AbortSignal 仍然是超时载体,dispatcher 只关掉 undici 内部计时器");
  }
});

test("Node 内置 fetch 认 undici Agent 的 headersTimeout(修复依赖的环境能力)", async () => {
  const { port, close } = await silentServer();
  try {
    const started = performance.now();
    await withKeepAlive(() => assert.rejects(
      // 全局 fetch 的 init 类型是 DOM 版,不认识 dispatcher(与 LlmFetchInit 注释
      // 同一个病);这里只断言运行时能力,按运行时真实形状收口类型。
      fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(5_000),
        dispatcher: new Agent({ headersTimeout: 120, bodyTimeout: 120 }),
      } as RequestInit),
      (error: unknown) => {
        const cause = (error as { cause?: { code?: unknown } }).cause;
        return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "UND_ERR_HEADERS_TIMEOUT";
      },
      "120ms 的内部计时器必须先于 5s 的 AbortSignal 掐掉请求,证明 dispatcher 生效",
    ));
    assert.ok(performance.now() - started < 3_000, "应在百毫秒级被掐,不该等到秒级");
  } finally {
    await close();
  }
});

test("LLM_HTTP_DISPATCHER 放得下数百毫秒的慢响应头:归零的计时器不许被调回小值", async () => {
  const { port, close } = await slowHeaderServer(800, arkJson());
  try {
    const client = new ArkChatClient("test-key", "configured-model", `http://127.0.0.1:${port}/api/v3`, fetch, 10_000);
    const result = await withKeepAlive(() => client.completeTextWithMetadata("问题", "系统"));
    assert.equal(result.content, "ok");
    assert.equal(result.model, "configured-model");
  } finally {
    await close();
  }
});
