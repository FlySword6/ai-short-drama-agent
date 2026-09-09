import assert from "node:assert/strict";
import test from "node:test";
import { ArkChatClient, ARK_REQUEST_TIMEOUT_MS, type ArkFetch } from "./arkClient.js";
import { ProviderTransportError } from "../shared/providerTransportFailure.js";
import { errorBody } from "../shared/errors.js";
import type { AiToolTurnRequest } from "../modules/ai/types.js";

/**
 * #282 钉的是同一句话:**我们自己掐的表,不许上报成「供应商拒答」。**
 *
 * 20 次连跑里 2 次整跑失败,产物写的是 `Ark: chat completion request failed`,
 * 看着像火山拒答。不是——两次耗时 218.6s / 220.0s,只差 1.4 秒,是固定超时的
 * 指纹(98~100s 的前 8 轮 + 第 9 轮撞满 120s)。真因被 `catch {}` 吞了:
 * 那个 catch 连 `error` 都没接,超时、断链、DNS 挂在产物里长得一模一样。
 *
 * 所以每条用例都成对出现:**一条造真超时、一条造真拒答**,断言两者的归类
 * 必须不同。只断言「超时报了超时」是不够的——改造前那份代码里,两者报的本来
 * 就是同一句话,单看一条永远发现不了。
 */

const endpoint = "https://ark.example.invalid/api/v3";
const TEST_TIMEOUT_MS = 25;

function client(fetchImpl: ArkFetch, timeoutMs = TEST_TIMEOUT_MS): ArkChatClient {
  return new ArkChatClient("test-api-key", "configured-model", endpoint, fetchImpl, timeoutMs);
}

function toolTurnRequest(): AiToolTurnRequest {
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

/**
 * 等这个请求被掐掉,把真的 abort 原因交出去。
 *
 * 这里**不做保活**:保活要和「abort 没来就快失败」绑在一起,不然就是下面
 * `withinAbortBudget` 注释里说的那个坑。两件事同一个定时器管,只放一处。
 */
function untilAborted(signal: AbortSignal, onAbort: (reason: unknown) => void): void {
  signal.addEventListener("abort", () => onAbort(signal.reason));
}

/** abort 没来。这不是被测行为,不能被当成「供应商错误」拿去做归类断言。 */
class AbortNeverArrived extends Error {}

/**
 * 这条用例自己的上限。25ms 的预算配 5 秒的界是 200 倍余量:够挡住 CI 上的调度
 * 抖动,又比 job 超时快两个数量级。
 */
const ABORT_BUDGET_MS = 5_000;

/**
 * 跑一次注定失败的调用:既**吊住事件循环**,又给「等 abort」这件事**划一个界**。
 *
 * 为什么要吊住:`AbortSignal.timeout()` 的定时器是 unref 的(实测:进程里只剩
 * 它时 Node 直接退出,abort 事件永远不会来)。真 fetch 不用操心——它的 socket
 * 吊着循环;我们这些假 fetch 没有 socket,不吊住就会变成「promise 悬着没落地」
 * 的偶发红,而且**只在跟别的测试同进程跑时才现形**(单跑这个文件是绿的,CI 上
 * 全量跑才炸)。
 *
 * 为什么必须**有界**:上一版用的是 `setInterval`,吊是吊住了,但吊得没有尽头。
 * `node --test` 没有默认的单测超时,CI 那个 job 是 `timeout-minutes: 20`——于是
 * 「abort 永远不到」这种回归,改造前会**秒报** `Promise resolution is still
 * pending`,那一版反而要**挂满 20 分钟**才以「job 超时」的形式露头。诊断信号从
 * 一句话退化成一个哑掉的红叉,这是把快失败换成了可能挂死。
 *
 * `setTimeout` 一样 ref 住循环,但到点会把「abort 没来」这件事本身说出来。
 */
async function withinAbortBudget<T>(run: () => Promise<T>): Promise<T> {
  let budget: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    budget = setTimeout(() => reject(new AbortNeverArrived(
      `等了 ${ABORT_BUDGET_MS}ms 这次调用还没落地,而超时预算只有 ${TEST_TIMEOUT_MS}ms:`
      + "说明 abort 根本没到达(事件循环没被吊住?),不是被测行为变了",
    )), ABORT_BUDGET_MS);
  });
  try {
    return await Promise.race([run(), stalled]);
  } finally {
    clearTimeout(budget);
  }
}

/** 真超时:请求挂着不回,直到我们自己的 signal 掐掉它,拿到的是真的 abort 原因。 */
const hangingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const signal = init?.signal as AbortSignal;
  return new Promise<Response>((_resolve, reject) => {
    untilAborted(signal, reject);
  });
}) as ArkFetch;

/**
 * 头回来了、正文没读完就被掐。实测(Node v25.8.1)真 undici 就是这个行为:
 * 同一个 signal 一直管到响应体读完,抛的还是 DOMException TimeoutError。
 */
const bodyTimeoutFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const signal = init?.signal as AbortSignal;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choi'));
      untilAborted(signal, (reason) => controller.error(reason));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}) as ArkFetch;

/** 真拒答:拿到了 HTTP 响应,只是状态码不是 2xx。**这条才是供应商说的「不」。** */
function refusingFetch(status: number): ArkFetch {
  return (async () => new Response(
    JSON.stringify({ error: { message: "provider_secret_should_not_appear" } }),
    { status, headers: { "Content-Type": "application/json" } },
  )) as ArkFetch;
}

/** 连接层:undici 的形状是 TypeError("fetch failed") + cause.code。 */
function connectionFetch(code: string): ArkFetch {
  return (async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect failed to provider_secret_should_not_appear"), { code }),
    });
  }) as ArkFetch;
}

function captureErrorLogs(): { entries: unknown[][]; restore: () => void } {
  const entries: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { entries.push(args); };
  return { entries, restore: () => { console.error = original; } };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  const log = captureErrorLogs();
  try {
    await withinAbortBudget(run);
  } catch (error) {
    // 界到了要原样抛出去,不能当成被测的那个错误——否则用例会拿着「abort 没来」
    // 去断言归类,报出来的是「expected timeout, got null」,真因反而看不见了。
    if (error instanceof AbortNeverArrived) throw error;
    return error;
  } finally {
    log.restore();
  }
  throw new Error("这次调用本该失败,却成功返回了");
}

async function rejectionWithLogs(
  run: () => Promise<unknown>,
): Promise<{ error: unknown; entries: unknown[][] }> {
  const log = captureErrorLogs();
  let error: unknown;
  let threw = false;
  try {
    await withinAbortBudget(run);
  } catch (caught) {
    if (caught instanceof AbortNeverArrived) throw caught;
    error = caught;
    threw = true;
  } finally {
    log.restore();
  }
  if (!threw) throw new Error("这次调用本该失败,却成功返回了");
  return { error, entries: log.entries };
}

function transportFailureOf(error: unknown): string | null {
  return error instanceof ProviderTransportError ? error.transportFailure : null;
}

test("我们自己掐的表归「超时」,供应商真拒答归另一类——两者不能长成同一句话", async () => {
  const timedOut = await rejection(() => client(hangingFetch)
    .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));
  const refused = await rejection(() => client(refusingFetch(503))
    .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));

  // 超时:可判定的归类字段说了实话。
  assert.equal(transportFailureOf(timedOut), "timeout");
  assert.ok(timedOut instanceof ProviderTransportError);
  assert.equal((timedOut as ProviderTransportError).timeoutMs, TEST_TIMEOUT_MS);

  // 拒答:根本不该是传输层错误——它拿到了 HTTP 响应。
  assert.equal(transportFailureOf(refused), null);
  assert.ok(!(refused instanceof ProviderTransportError));
  assert.equal((refused as Error).message, "Ark: chat completion failed with status 503");

  // 改造前这两条 message 相同才是病根,所以这一行单独钉住。
  assert.notEqual((timedOut as Error).message, (refused as Error).message);
});

test("agent 那条路(带工具表的一轮)同样分得开——#282 真正撞上的就是它", async () => {
  const timedOut = await rejection(() => client(hangingFetch).completeToolTurn(toolTurnRequest()));
  const refused = await rejection(() => client(refusingFetch(503)).completeToolTurn(toolTurnRequest()));

  assert.equal(transportFailureOf(timedOut), "timeout");
  assert.equal(transportFailureOf(refused), null);
  assert.equal((refused as Error).message, "Ark: chat completion failed with status 503");
  assert.notEqual((timedOut as Error).message, (refused as Error).message);
});

test("超时的 message 自己说清是我们掐的,并报出那个预算数", async () => {
  const timedOut = await rejection(() => client(hangingFetch)
    .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));

  const message = (timedOut as Error).message;
  // 这句会原样落进拆解产物的 failureMessage:下一个人不该再靠算耗时去猜。
  assert.match(message, /aborted by our own 25ms client timeout/);
  assert.match(message, /not refused by the provider/);
  // 改造前那句必须彻底消失在超时这条路上。
  assert.notEqual(message, "Ark: chat completion request failed");
});

test("连接层失败归「连接」,不冒充超时也不冒充拒答", async () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND"]) {
    const error = await rejection(() => client(connectionFetch(code))
      .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));
    assert.equal(transportFailureOf(error), "connection", code);
    assert.match((error as Error).message, /connection layer/u);
    assert.ok(!(error as Error).message.includes("provider_secret_should_not_appear"), code);
  }
});

test("undici 自己的超时码归「超时」而不是「连接」", async () => {
  for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]) {
    const error = await rejection(() => client(connectionFetch(code))
      .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));
    assert.equal(transportFailureOf(error), "timeout", code);
  }
});

test("认不出来的失败如实归「未知」,行为与改造前一字不差", async () => {
  const error = await rejection(() => client((async () => {
    throw new Error("provider_secret_should_not_appear");
  }) as ArkFetch).completeMessagesWithMetadata([{ role: "user", content: "问题" }]));

  assert.equal(transportFailureOf(error), "unknown");
  // 真认不出来的,不硬套一个归类,措辞也保持原样——只多挂一个字段。
  assert.equal((error as Error).message, "Ark: chat completion request failed");
  assert.ok(!(error as Error).message.includes("provider_secret_should_not_appear"));
});

test("头回来了、正文读一半被掐,算超时不算「正文不是 JSON」", async () => {
  const error = await rejection(() => client(bodyTimeoutFetch)
    .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));

  assert.equal(transportFailureOf(error), "timeout");
  assert.notEqual((error as Error).message, "Ark: chat completion returned invalid JSON");
});

test("正文真的不是 JSON 时仍然报「正文不是 JSON」——归类不许越界去抢这条", async () => {
  const error = await rejection(() => client((async () => new Response(
    "provider_secret_should_not_appear",
    { status: 200, headers: { "Content-Type": "application/json" } },
  )) as ArkFetch).completeMessagesWithMetadata([{ role: "user", content: "问题" }]));

  assert.equal(transportFailureOf(error), null);
  assert.equal((error as Error).message, "Ark: chat completion returned invalid JSON");
});

test("内部日志分得出是哪一种,而且不带 error 原文", async () => {
  const timedOut = await rejectionWithLogs(() => client(hangingFetch)
    .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));
  const connection = await rejectionWithLogs(() => client(connectionFetch("ECONNRESET"))
    .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));

  const fields = (entries: unknown[][]) => {
    const entry = entries.find((args) => args[0] === "[ark] 供应商请求失败");
    assert.ok(entry, "没有留下内部日志");
    return entry[1] as Record<string, unknown>;
  };

  const timeoutLog = fields(timedOut.entries);
  assert.equal(timeoutLog.transportFailure, "timeout");
  assert.equal(timeoutLog.timeoutMs, TEST_TIMEOUT_MS);
  assert.equal(typeof timeoutLog.durationMs, "number");

  const connectionLog = fields(connection.entries);
  assert.equal(connectionLog.transportFailure, "connection");

  // 日志里两者不同,才叫「分得出」。
  assert.notEqual(timeoutLog.transportFailure, connectionLog.transportFailure);
  // fetch 的报错带着请求 URL 和供应商正文,一个字都不许进日志。
  const dumped = JSON.stringify([timeoutLog, connectionLog]);
  assert.ok(!dumped.includes("provider_secret_should_not_appear"));
  assert.ok(!dumped.includes("ark.example.invalid"));
});

test("用户看到的仍然是中文业务语言:没有厂商名、没有状态码、没有英文报错", async () => {
  const cases: ArkFetch[] = [hangingFetch, refusingFetch(503), connectionFetch("ECONNRESET")];

  for (const fetchImpl of cases) {
    const error = await rejection(() => client(fetchImpl)
      .completeMessagesWithMetadata([{ role: "user", content: "问题" }]));
    const body = errorBody(error);
    assert.equal(body.message, "生成没成：生成服务暂时没响应，请稍后重试。");
    assert.ok(!/[A-Za-z]/u.test(body.message), `界面文案混进了英文: ${body.message}`);
    assert.ok(!/\b\d{3}\b/u.test(body.message), `界面文案混进了状态码: ${body.message}`);
    assert.ok(!body.message.includes("Ark"));
  }
});

test("生产默认预算仍是 120 秒——本卡只把它命名,没有调它", () => {
  assert.equal(ARK_REQUEST_TIMEOUT_MS, 120_000);
});
