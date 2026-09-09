import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderTransportError,
  classifyProviderTransportFailure,
  isProviderTransportFailure,
  providerTransportErrorCodes,
} from "./providerTransportFailure.js";
import { errorBody } from "./errors.js";

/**
 * 归类器本身的用例。跟 ark-transport-failure.test.ts 分工:那边钉的是
 * 「适配器整条路上超时与拒答分得开」,这边钉的是**读错误对象时踩过的两个坑**,
 * 它们从形状上就看不出来,只能单独钉住。
 */

/** 真的从 `AbortSignal.timeout` 拿一个 abort 原因,不手搓假的。 */
async function realTimeoutReason(): Promise<{ reason: unknown; signal: AbortSignal }> {
  const signal = AbortSignal.timeout(1);
  await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve()); });
  return { reason: signal.reason, signal };
}

test("真的超时原因归「超时」", async () => {
  const { reason, signal } = await realTimeoutReason();
  assert.equal((reason as Error).name, "TimeoutError");
  assert.equal(classifyProviderTransportFailure(reason, signal), "timeout");
});

test("手动 abort 也归「超时」", () => {
  const controller = new AbortController();
  controller.abort();
  const reason = new DOMException("This operation was aborted", "AbortError");
  assert.equal(classifyProviderTransportFailure(reason, controller.signal), "timeout");
});

/**
 * 坑一:`DOMException.code` 是**数字**(TimeoutError 23、AbortError 20),
 * 跟 `ECONNRESET` 那套字符串错误码表毫无关系。取码时必须 `typeof === "string"`,
 * 否则外层这个数字会被当成错误码「读到」,链就不再往下走了。
 *
 * 用外层数字码 + 内层真错误码这个形状钉,是因为**光传一个 DOMException 钉不住**:
 * 它先被 `isAbortLike` 认出来,根本走不到取码那一步——那样的用例看着在测这件事,
 * 其实把 `typeof` 那道判断删掉也照样绿(实测过)。
 */
test("外层的数字 code 不许挡住 cause 里真正的错误码", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(typeof (timeout as unknown as { code: unknown }).code, "number");

  const wrapped = Object.assign(new TypeError("fetch failed"), {
    code: 23,
    cause: Object.assign(new Error("boom"), { code: "ECONNRESET" }),
  });
  assert.equal(classifyProviderTransportFailure(wrapped), "connection");
});

/** undici 的形状:`TypeError("fetch failed")`,真正的码在 `cause` 上。 */
function fetchFailure(code: string): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("boom"), { code }),
  });
}

/**
 * 下面两份码表是**手抄的,故意不从模块 import**。
 *
 * 从模块读一遍再喂回模块是个自证的空转:码拼错成 `ECONNRSET`,循环会拿着错的
 * 那个去问、模块也答得上来,照样全绿。手抄一份对照着问,拼错才会红。
 *
 * 为什么必须逐个覆盖、不能抽样:漏掉的那个码一旦拼错,后果是这一整类失败**从此
 * 静默归成 `unknown`**——供应商又一次被冤枉,而且没有任何测试会告诉你。
 * 这正是 #282 本身那个病:错的答案长得跟对的一样,不主动钉就永远发现不了。
 */
const connectionCodes = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "EPROTO",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
];

const timeoutCodes = [
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
];

test("码表里每一个连接层错误码都归「连接」", () => {
  for (const code of connectionCodes) {
    assert.equal(classifyProviderTransportFailure(fetchFailure(code)), "connection", code);
  }
});

test("码表里每一个超时错误码都归「超时」,不许混进「连接」", () => {
  for (const code of timeoutCodes) {
    assert.equal(classifyProviderTransportFailure(fetchFailure(code)), "timeout", code);
  }
});

/**
 * 另一半:上面两条只能保证「用例列出来的码都归对了档」,拦不住**模块新增了一个
 * 码而用例没跟上**——那个码同样是零用例。所以这里把两份表正过来反过去对一遍。
 */
test("码表与用例双向对齐:模块里不许有零用例的码", () => {
  const sorted = (codes: readonly string[]) => [...codes].sort();
  assert.deepEqual(sorted(providerTransportErrorCodes.connection), sorted(connectionCodes));
  assert.deepEqual(sorted(providerTransportErrorCodes.timeout), sorted(timeoutCodes));
});

/**
 * 判定顺序:先信异常自己说的,再信我们的 signal。
 * 连接被拒却恰好撞上超时窗口时,连接层才是更具体的真因,不该被 aborted 盖掉。
 */
test("异常自己带了连接层错误码时,不被 signal.aborted 盖成超时", () => {
  const controller = new AbortController();
  controller.abort();
  const error = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
  });
  assert.equal(classifyProviderTransportFailure(error, controller.signal), "connection");
});

test("形状认不出、但我们的 signal 确实掐了,仍然归「超时」", () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(classifyProviderTransportFailure(new Error("说不清"), controller.signal), "timeout");
});

test("认不出来就如实说「未知」,不硬套", () => {
  assert.equal(classifyProviderTransportFailure(new Error("说不清")), "unknown");
  assert.equal(classifyProviderTransportFailure("字符串也不是错误对象"), "unknown");
  assert.equal(classifyProviderTransportFailure(null), "unknown");
  assert.equal(classifyProviderTransportFailure(undefined), "unknown");
});

/** 坑二:`cause` 成环会把归类卡死在死循环里。 */
test("cause 成环不会转不出来", () => {
  const outer: { cause?: unknown } = {};
  const inner: { cause?: unknown } = { cause: outer };
  outer.cause = inner;
  assert.equal(classifyProviderTransportFailure(outer), "unknown");
});

test("正文不是 JSON 的 SyntaxError 不算传输层——不然会抢掉「正文不是 JSON」", () => {
  let syntaxError: unknown;
  try { JSON.parse("not json"); } catch (error) { syntaxError = error; }
  assert.equal(classifyProviderTransportFailure(syntaxError), "unknown");
  assert.equal(isProviderTransportFailure(syntaxError), false);
  assert.equal(isProviderTransportFailure(new DOMException("x", "TimeoutError")), true);
});

test("归类字段挂在错误上,而界面文案只按 service 出中文", () => {
  const error = new ProviderTransportError("Ark", "timeout", 120_000);
  assert.equal(error.transportFailure, "timeout");
  assert.equal(error.timeoutMs, 120_000);
  assert.match(error.message, /our own 120000ms client timeout/);

  const body = errorBody(error);
  assert.equal(body.message, "生成没成：生成服务暂时没响应，请稍后重试。");
  // internalMessage 是英文技术原文,一个字都不许漏进界面文案。
  assert.ok(!body.message.includes("timeout"));
  assert.ok(!/[A-Za-z]/u.test(body.message));
});

test("「未知」这一档沿用改造前的措辞,真认不出来的失败行为不变", () => {
  const error = new ProviderTransportError("Ark", "unknown", 120_000);
  assert.equal(error.message, "Ark: chat completion request failed");
});
