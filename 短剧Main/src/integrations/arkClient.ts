import { Agent } from "undici";
import { settings } from "../config/env.js";
import { ExternalServiceError } from "../shared/errors.js";
import {
  ProviderTransportError,
  classifyProviderTransportFailure,
  isProviderTransportFailure,
} from "../shared/providerTransportFailure.js";
import { jsonObject, parseJsonValue, isRecord } from "../shared/json.js";
import type { JsonObject } from "../domain/assets/types.js";
import { parseToolCallArguments } from "../modules/ai/toolCallArguments.js";
import type {
  AiConversationMessage,
  AiProviderToolTurn,
  AiThinkingMode,
  AiToolCall,
  AiToolSpec,
  AiUnreadableToolCall,
} from "../modules/ai/types.js";

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  thinking?: AiThinkingMode;
  /**
   * Bounded completion output. The adapter always sends a value so callers
   * cannot accidentally request an unbounded provider response.
   */
  maxTokens?: number;
  /**
   * 本次调用的请求超时覆盖(毫秒)。默认走构造器注入的
   * ARK_REQUEST_TIMEOUT_MS;只有经过评估的用途才许传(见
   * AI_PURPOSE_TIMEOUT_OVERRIDES 注释),越界按结构上限拒收。
   */
  timeoutMs?: number;
  timing?: Record<string, number>;
  timingPrefix?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

export interface ArkChatCompletion {
  content: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

/**
 * LLM 请求的 fetch init 形状。本仓库默认 lib 带 DOM,全局 `RequestInit` 是 DOM
 * 版本,丢了 undici 的 `dispatcher` 字段(运行时支持,见 LLM_HTTP_DISPATCHER
 * 注释);全局声明合并又覆盖不到各门禁 tsconfig 的 include 范围。所以在适配器
 * 自己的类型合同里显式加宽,fetch 实现可安全赋值(参数是 RequestInit 的子集)。
 */
export type LlmFetchInit = RequestInit & { dispatcher?: unknown };
export type ArkFetch = (input: string | URL | Request, init?: LlmFetchInit) => Promise<Response>;

/**
 * 适配器的结构性上限,不是「这个模型能开多大」的判断。
 *
 * 改造前这里是 4096,而 arkcli 实测 deepseek-v4-flash-ga 的
 * max_completion_token_length 是 384k(393216)——4096 会把真实能力挡掉。
 * 翻遍 config-and-secrets.md 与 ai-foundation-gateway.md 都没有 4096 的出处,
 * git 追到引入它的那笔提交也只是「adapter 加个保险」,不是供应商限制。
 *
 * 能力判断已经归网关(它查 model_capabilities 表,按当前模型给上限)。
 * 适配器只留这一道:防住明显荒谬的值进到请求体,不参与能力判断。
 * 取值 = 当前实测到的最大模型输出能力,发现更大的模型时跟着抬。
 */
export const MAX_ARK_CHAT_MAX_TOKENS = 393_216;

/**
 * 客户端自己掐的表。**这不是供应商的限制,是我们的预算。**
 *
 * 值沿用改造前写死在两处 `AbortSignal.timeout(120_000)` 里的 120 秒——本次只是
 * 把它提出来命名,让错误和日志能报出这个数。要不要调是花钱的决定,不归适配器
 * 定,见 #282 的评估。**2026-08-18 用户批准**:`script_breakdown_storyboard`
 * (P6 阶段②单次拆镜,输出随剧本长度线性增长)例外放宽到
 * STORYBOARD_STAGE_TIMEOUT_MS,其余用途不变;放宽值由网关按用途下发
 * (AI_PURPOSE_TIMEOUT_OVERRIDES),适配器不认用途只认毫秒数。
 */
export const ARK_REQUEST_TIMEOUT_MS = 120_000;

/** 请求超时覆盖的结构上限:超过这个数的超时配置直接拒收,不进请求体。 */
export const MAX_ARK_REQUEST_TIMEOUT_MS = 600_000;

/**
 * LLM 请求专用传输配置,三个适配器(Ark/公司通道/MiniMax)共用。
 *
 * Node 内置 fetch(undici)的 `headersTimeout`/`bodyTimeout` 默认各 300s,而且
 * **独立于**我们传入的 AbortSignal 计算。Ark 请求是非流式的:响应头要等模型把
 * 整段生成完才回来。阶段②单次拆镜一旦生成超过 300s,undici 就先于网关放宽的
 * 600s 预算把连接掐了——ai_calls 里两次 `dur=300683ms err=provider_timeout` 的
 * 阶段②失败就是这个指纹(网关预算 600s,死在 300.7s,远小于预算,正是
 * providerTransportFailure.ts 注释里写的「undici 先动的手」判定法)。
 *
 * 关掉这两个内部计时器(undici 语义:0 = 禁用),让网关按用途下发的 AbortSignal
 * 成为唯一超时权威。连接建立超时(默认 10s)保留:连不上该快速失败,与生成慢是两回事。
 */
export const LLM_HTTP_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export class ArkChatClient {
  private readonly endpoint: string;

  constructor(
    private readonly apiKey = settings.arkApiKey,
    private readonly defaultModel = settings.arkLlmModel ?? settings.doubaoLlmModel,
    baseUrl = settings.arkBaseUrl,
    private readonly fetchImpl: ArkFetch = fetch,
    /** 只为让测试能在毫秒级走完真实的超时路径而可注入;生产一律用默认值。 */
    private readonly requestTimeoutMs = ARK_REQUEST_TIMEOUT_MS,
  ) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  }

  /**
   * 没拿到(或没读完)HTTP 响应时的唯一出口。
   *
   * 归类落在 `ProviderTransportError.transportFailure` 上,同时在这里留一条内部
   * 日志——**只写归类和数字,不写 `error` 原文**:fetch 的报错里带着请求 URL 和
   * 供应商响应片段,写进日志就等于把它们泄出去。
   * `durationMs` 是这条日志里最值钱的一格:它对着 `timeoutMs` 一看就知道是不是
   * 我们自己掐的——#282 就是靠 218.6s / 220.0s 这两个数硬算出来的,而这本该是
   * 读日志就能看见的事。
   */
  private failTransport(
    stage: "request" | "response_body",
    error: unknown,
    timeoutSignal: AbortSignal,
    timeoutMs: number,
    startedAt: number,
  ): never {
    const transportFailure = classifyProviderTransportFailure(error, timeoutSignal);
    console.error("[ark] 供应商请求失败", {
      stage,
      transportFailure,
      timeoutMs,
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw new ProviderTransportError("Ark", transportFailure, timeoutMs);
  }

  /**
   * 本次调用的有效超时:给了覆盖就验完用覆盖,没给走构造器默认。
   * 覆盖越界直接拒收——放宽超时的决定要能追溯到传值的人,
   * 一个荒谬的大数不该静默混进生产请求。
   */
  private resolveTimeoutMs(override: number | undefined): number {
    if (override === undefined) return this.requestTimeoutMs;
    if (!Number.isSafeInteger(override) || override < 1 || override > MAX_ARK_REQUEST_TIMEOUT_MS) {
      throw new ExternalServiceError("Ark", `invalid request timeout override ${override}`);
    }
    return override;
  }

  async completeText(
    prompt: string,
    system = "你只输出严格 JSON，不输出 Markdown，不输出解释。",
    options: ChatCompletionOptions = {},
  ): Promise<string> {
    return (await this.completeTextWithMetadata(prompt, system, options)).content;
  }

  async completeTextWithMetadata(
    prompt: string,
    system = "你只输出严格 JSON，不输出 Markdown，不输出解释。",
    options: ChatCompletionOptions = {},
  ): Promise<ArkChatCompletion> {
    return this.completeMessagesWithMetadata([
      { role: "system", content: system },
      { role: "user", content: prompt },
    ], options);
  }

  async completeMessages(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
  ): Promise<string> {
    return (await this.completeMessagesWithMetadata(messages, options)).content;
  }

  async completeMessagesWithMetadata(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
  ): Promise<ArkChatCompletion> {
    if (!this.apiKey) throw new ExternalServiceError("Ark", "Missing ARK_API_KEY");
    const model = options.model ?? this.defaultModel;
    if (!model) throw new ExternalServiceError("Ark", "Missing LLM model configuration");
    // Existing callers intentionally retain Ark's provider default when they
    // do not opt into a bound. The new AI gateway always passes an explicit
    // bound, so introducing it there cannot silently change Excel, vision or
    // legacy search behavior.
    const maxTokens = resolveMaxTokens(options.maxTokens);

    const started = performance.now();
    const timeoutMs = this.resolveTimeoutMs(options.timeoutMs);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: options.temperature ?? 0,
          ...(options.thinking ? { thinking: { type: options.thinking } } : {}),
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          messages,
        }),
        signal: timeoutSignal,
        dispatcher: LLM_HTTP_DISPATCHER,
      });
    } catch (error) {
      if (options.timing) {
        options.timing[`${options.timingPrefix ?? "llm"}_http`] = Math.round(performance.now() - started);
      }
      // Fetch implementations may include URL, provider body or other
      // transport details in their errors. Those details still never reach the
      // application error/log path — only the classification does.
      this.failTransport("request", error, timeoutSignal, timeoutMs, started);
    }
    const durationMs = Math.round(performance.now() - started);
    if (options.timing) {
      options.timing[`${options.timingPrefix ?? "llm"}_http`] = durationMs;
    }
    if (!response.ok) {
      throw new ExternalServiceError("Ark", `chat completion failed with status ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // 同一个 signal 一直管到响应体读完(实测:头已经回来了、body 没读完就被
      // 掐,抛的还是 TimeoutError)。所以这里也可能是超时——报「invalid JSON」
      // 就是又一次冤枉供应商。
      if (isProviderTransportFailure(error, timeoutSignal)) {
        this.failTransport("response_body", error, timeoutSignal, timeoutMs, started);
      }
      // Some fetch implementations include a response-body fragment in a JSON
      // parse error. Do not let an Ark body enter the application error/log path.
      throw new ExternalServiceError("Ark", "chat completion returned invalid JSON");
    }
    const content = extractMessageContent(payload);
    if (!content) throw new ExternalServiceError("Ark", "chat completion returned empty content");
    return {
      content,
      model: extractResponseModel(payload) ?? model,
      inputTokens: extractUsageToken(payload, "prompt_tokens"),
      outputTokens: extractUsageToken(payload, "completion_tokens"),
      durationMs,
    };
  }

  /**
   * 带工具表的一轮对话。Ark 的 chat/completions 与 OpenAI 的工具调用格式一致,
   * 这里只做请求组装与响应解析,不做任何「让模型吐 JSON」的兜底。
   */
  async completeToolTurn(input: {
    system: string;
    messages: AiConversationMessage[];
    tools: AiToolSpec[];
    model?: string;
    thinking?: AiThinkingMode;
    maxTokens: number;
  }): Promise<AiProviderToolTurn> {
    if (!this.apiKey) throw new ExternalServiceError("Ark", "Missing ARK_API_KEY");
    const model = input.model ?? this.defaultModel;
    if (!model) throw new ExternalServiceError("Ark", "Missing LLM model configuration");
    const maxTokens = resolveMaxTokens(input.maxTokens);

    const started = performance.now();
    const toolTurnTimeoutMs = this.requestTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(toolTurnTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          ...(input.thinking ? { thinking: { type: input.thinking } } : {}),
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          messages: [
            { role: "system", content: input.system },
            ...input.messages.map(arkWireMessage),
          ],
          tools: input.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
        signal: timeoutSignal,
        dispatcher: LLM_HTTP_DISPATCHER,
      });
    } catch (error) {
      this.failTransport("request", error, timeoutSignal, toolTurnTimeoutMs, started);
    }
    const durationMs = Math.round(performance.now() - started);
    if (!response.ok) {
      throw new ExternalServiceError("Ark", `chat completion failed with status ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isProviderTransportFailure(error, timeoutSignal)) {
        this.failTransport("response_body", error, timeoutSignal, toolTurnTimeoutMs, started);
      }
      throw new ExternalServiceError("Ark", "chat completion returned invalid JSON");
    }
    return {
      content: extractMessageContent(payload) ?? "",
      ...splitArkToolCalls(payload),
      model: extractResponseModel(payload) ?? model,
      inputTokens: extractUsageToken(payload, "prompt_tokens"),
      outputTokens: extractUsageToken(payload, "completion_tokens"),
      durationMs,
    };
  }

  async completeJson(
    prompt: string,
    options: ChatCompletionOptions = {},
  ): Promise<JsonObject> {
    const content = await this.completeText(prompt, undefined, options);
    try {
      return jsonObject(parseJsonValue(content));
    } catch {
      // Keep the legacy helper's repair behavior for existing offline/import
      // flows. New AI-gateway routes deliberately never call this helper: they
      // parse once and surface a controlled error so every gateway call maps to
      // exactly one auditable provider request.
      const repairPrompt = [
        "下面内容本应是严格 JSON 对象，请只修复 JSON 语法，不新增字段、不解释：",
        content,
      ].join("\n");
      const repaired = await this.completeText(repairPrompt, undefined, {
        ...options,
        timingPrefix: "repair_llm",
      });
      return jsonObject(parseJsonValue(repaired));
    }
  }
}

function resolveMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const maxTokens = value;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_ARK_CHAT_MAX_TOKENS) {
    throw new ExternalServiceError(
      "Ark",
      `chat completion max_tokens must be an integer between 1 and ${MAX_ARK_CHAT_MAX_TOKENS}`,
    );
  }
  return maxTokens;
}

function extractMessageContent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  return typeof content === "string" ? content : null;
}

function extractResponseModel(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload.model === "string" && payload.model.trim() ? payload.model : null;
}

function extractUsageToken(payload: unknown, key: "prompt_tokens" | "completion_tokens"): number | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;
  const value = payload.usage[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function arkWireMessage(message: AiConversationMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/**
 * 缺 id 或函数名是协议层坏掉:没有 id 就没法把结果对回这一次调用,只能整轮报错。
 * 入参读不出则单独列出——同一批里其他调用是好的,不该被连坐。
 */
function splitArkToolCalls(payload: unknown): {
  toolCalls: AiToolCall[];
  unreadableToolCalls: AiUnreadableToolCall[];
} {
  const toolCalls: AiToolCall[] = [];
  const unreadableToolCalls: AiUnreadableToolCall[] = [];
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return { toolCalls, unreadableToolCalls };
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return { toolCalls, unreadableToolCalls };
  const rawCalls = first.message.tool_calls;
  if (!Array.isArray(rawCalls)) return { toolCalls, unreadableToolCalls };
  for (const raw of rawCalls) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.function)) {
      throw new ExternalServiceError("Ark", "tool call is missing id or function");
    }
    const name = raw.function.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new ExternalServiceError("Ark", "tool call is missing a function name");
    }
    const parsed = parseToolCallArguments(raw.function.arguments);
    if (parsed.readable) toolCalls.push({ id: raw.id, name, arguments: parsed.arguments });
    else unreadableToolCalls.push({ id: raw.id, name, argumentsExcerpt: parsed.excerpt });
  }
  return { toolCalls, unreadableToolCalls };
}
