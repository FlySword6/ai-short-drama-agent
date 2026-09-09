import { ExternalServiceError } from "./errors.js";

/**
 * 请求「没能拿到 / 没能读完」HTTP 响应时的归类。三档,不多不少:
 *
 * - `timeout`     我们自己掐的表。**不是供应商拒答。**
 * - `connection`  连不上、被重置、DNS 挂——请求没送达,或响应半路断了。
 * - `unknown`     两者都不像。宁可如实说不认识,也不硬套一个。
 *
 * 供应商**真的**拒答不走这里:那会拿到 HTTP 响应,由调用方的 `!response.ok`
 * 分支报 `... failed with status NNN`。能不能把这两件事分开,是这个模块存在的
 * 唯一理由——#282 里两次失败耗时 218.6s / 220.0s(差 1.4 秒,固定超时的指纹),
 * 而产物里写的是「Ark: chat completion request failed」,排障的人会去查供应商
 * 状态页、去问客服,真因是我们自己掐的表。
 */
export type ProviderTransportFailure = "timeout" | "connection" | "unknown";

/**
 * 归到传输层的错误码,按档分组。
 *
 * **导出是为了能被用例钉住,不是给业务代码读的。** 这张表是本模块唯一的哑数据:
 * 少一个码、拼错一个字母,后果都是那一类失败从此静默归成 `unknown`,而且不会有
 * 任何测试变红——正是 #282 要治的病本身。所以用例里另写一份字面量,与这张表
 * 双向对等:表里多出没用例的码会红,码拼错了也会红(用例那份拼对的码归不出档)。
 */
export const providerTransportErrorCodes = {
  /**
   * 连接层:前一组是 Node 的系统错误码,后一组是 undici 自己的。
   * 共同点是「请求没送达或响应断了」,与「我们等够了主动放弃」是两回事。
   */
  connection: [
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
  ],
  /**
   * 这些也是超时,只是由 undici 的内部预算触发,不是我们传进去的那个 signal。
   * 想分辨是谁掐的,看日志里的 `durationMs` 对 `timeoutMs`:远小于我们的预算,
   * 就是 undici 先动的手。
   */
  timeout: [
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_ABORTED",
  ],
} as const satisfies Record<Exclude<ProviderTransportFailure, "unknown">, readonly string[]>;

const connectionErrorCodes = new Set<string>(providerTransportErrorCodes.connection);
const timeoutErrorCodes = new Set<string>(providerTransportErrorCodes.timeout);

/**
 * fetch 抛出来的东西长什么样,是在本机 Node v25.8.1 上跑真 socket 实测的
 * (`node --test` 之外的一次性探针,六种情况各触发一次):
 *
 * | 情况                          | 抛出                                                        |
 * |-------------------------------|-------------------------------------------------------------|
 * | `AbortSignal.timeout` 在收到头之前触发 | `DOMException`,`name = "TimeoutError"`,`code = 23`(数字) |
 * | 同一个 signal 在读 body 时触发  | 同上——**超时一直管到响应体读完**                              |
 * | `controller.abort()` 未给 reason | `DOMException`,`name = "AbortError"`,`code = 20`(数字)     |
 * | 连接被拒                       | `TypeError("fetch failed")`,`cause.code = "ECONNREFUSED"`     |
 * | 域名解析不到                    | `TypeError("fetch failed")`,`cause.code` 为字符串码            |
 * | 正文真的不是 JSON               | `SyntaxError`,无 `code`,signal 未 abort                      |
 *
 * 两条由此而来的硬约束:
 *
 * 1. **只认字符串 `code`。** `DOMException.code` 是数字(23 / 20),按数字读会
 *    读出一个跟错误码表毫无关系的值。
 * 2. **不读 `message`。** 供应商 URL 和响应片段混在 message 里,读进来就等于把
 *    它引到日志和错误链上。只读 `name` 与字符串 `code` 这两个结构化字段。
 *
 * 判定顺序是「先信异常自己说的,再信我们的 signal」:异常带 `ECONNREFUSED` 却
 * 恰好撞上超时窗口时,连接层才是更具体的那个真因,不该被 `signal.aborted` 盖掉。
 *
 * @param timeoutSignal 必须是本次请求自己的超时 signal。它一旦 aborted,原因
 *   只可能是超时;传别人的 signal 会得到错的归类。
 */
export function classifyProviderTransportFailure(
  error: unknown,
  timeoutSignal?: AbortSignal,
): ProviderTransportFailure {
  if (isAbortLike(error)) return "timeout";
  const code = transportErrorCode(error);
  if (code && timeoutErrorCodes.has(code)) return "timeout";
  if (code && connectionErrorCodes.has(code)) return "connection";
  if (timeoutSignal?.aborted) return "timeout";
  return "unknown";
}

/**
 * 「这条异常是传输层的、还是别的」。
 *
 * 读响应体时两种都可能:超时和断链要按传输层归类,而正文真的不是 JSON 时
 * `SyntaxError` 既没有字符串 `code`、名字也不是 abort 那两个,归 `unknown`,
 * 于是落回调用方原来的「invalid JSON」——所以这里用 `!== "unknown"` 判,
 * 不用白名单:新出现的传输层错误码宁可漏判成 `unknown`,也不会被误说成解析失败。
 */
export function isProviderTransportFailure(
  error: unknown,
  timeoutSignal?: AbortSignal,
): boolean {
  return classifyProviderTransportFailure(error, timeoutSignal) !== "unknown";
}

/**
 * abort 家族:`AbortSignal.timeout` 抛的是 `TimeoutError`,`controller.abort()`
 * 不给 reason 时抛的是 `AbortError`。**只能从 `name` 认**——`DOMException.code`
 * 是数字(见上面那张实测表),按码认一个都认不出来。
 *
 * 导出是因为公司通道那条路要用同一份判断:`colCompletionProvider` 里原本逐字
 * 抄了一遍(`timeoutSignal.aborted || isAbortLike(error)`)。两份一样的判断散在
 * 两处,改一处漏一处时没有任何东西会拦——收敛到这里,只留一份。
 * (minimax 那家还没收:它得连 `catch {}` 一起改,不是一行的事,单开。)
 */
export function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const { name } = error as { name?: unknown };
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * undici 把系统错误挂在 `cause` 上,偶尔再套一层。只跟这条窄链、只取第一个
 * **字符串** `code`,并且防成环。
 */
function transportErrorCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string") return value.code;
    current = value.cause;
  }
  return undefined;
}

/**
 * 请求没拿到(或没读完)HTTP 响应时抛这个。
 *
 * 对用户仍然是业务语言:`errorBody()` 遇到 `ExternalServiceError` 只按 `service`
 * 出中文文案,不看 `internalMessage`;拆解那条路 `runDisplayReason()` 也只看
 * `errorCode`。所以下面这句英文技术原文进不了界面。
 *
 * 对排障的人多了两样:`transportFailure` 这个可判定的归类字段,和一句写明
 * 「是我们自己掐的表」的 `internalMessage`——它会原样落进拆解产物的
 * `failureMessage`,下一个人不用再靠算耗时去猜。
 *
 * `unknown` 档故意沿用改造前那句 `chat completion request failed`:真认不出来的
 * 失败,行为一个字都不改,只多挂一个归类字段。
 */
export class ProviderTransportError extends ExternalServiceError {
  constructor(
    service: string,
    readonly transportFailure: ProviderTransportFailure,
    readonly timeoutMs: number,
  ) {
    super(service, transportFailureInternalMessage(transportFailure, timeoutMs));
    this.name = "ProviderTransportError";
  }
}

function transportFailureInternalMessage(
  failure: ProviderTransportFailure,
  timeoutMs: number,
): string {
  switch (failure) {
    case "timeout":
      return `chat completion aborted by our own ${timeoutMs}ms client timeout, not refused by the provider`;
    case "connection":
      return "chat completion failed at the connection layer, no response was received";
    default:
      return "chat completion request failed";
  }
}
