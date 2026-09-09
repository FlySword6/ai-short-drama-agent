import { LLM_HTTP_DISPATCHER, type LlmFetchInit } from "../../integrations/arkClient.js";
import { ExternalServiceError } from "../../shared/errors.js";
import { isAbortLike } from "../../shared/providerTransportFailure.js";
import { parseToolCallArguments } from "./toolCallArguments.js";
import type {
  AiCompletionProvider,
  AiConversationMessage,
  AiProviderCompletion,
  AiProviderToolTurn,
  AiThinkingMode,
  AiToolCall,
  AiToolTurnRequest,
  AiUnreadableToolCall,
} from "./types.js";

export type ColFetch = (input: string | URL | Request, init?: LlmFetchInit) => Promise<Response>;

const COL_REQUEST_TIMEOUT_MS = 120_000;

/**
 * 适配器的结构性上限,与 Ark 适配器同一口径同一理由(见
 * MAX_ARK_CHAT_MAX_TOKENS 注释)。改造前是 4096,没有供应商文档出处;
 * 公司通道代理的是同一批模型,上限不该比直连更严。
 * 能力判断归网关,这里只防明显荒谬的值。
 */
export const MAX_COL_COMPLETION_MAX_TOKENS = 393_216;

export class ColCompletionTimeoutError extends ExternalServiceError {
  constructor() {
    super("公司 AI 通道", "chat completion timed out");
    this.name = "ColCompletionTimeoutError";
  }
}

/**
 * Company-owned OpenAI-compatible text adapter. Provider-specific transport
 * details stay below the audited gateway; callers only choose a deployment-
 * bound model and never receive the gateway URL or credential.
 */
export class ColCompletionProvider implements AiCompletionProvider {
  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly defaultModel: string | undefined,
    baseUrl: string | undefined,
    private readonly fetchImpl: ColFetch = fetch,
    private readonly requestTimeoutMs = COL_REQUEST_TIMEOUT_MS,
  ) {
    this.endpoint = resolveColEndpoint(baseUrl, "chat/completions");
    if (
      !Number.isSafeInteger(this.requestTimeoutMs)
      || this.requestTimeoutMs < 1
      || this.requestTimeoutMs > 600_000
    ) {
      throw new ExternalServiceError("公司 AI 通道", "invalid request timeout");
    }
  }

  /** 与 Ark 适配器同口径:覆盖只在结构上限内生效,越界拒收(见 arkClient resolveTimeoutMs)。 */
  private resolveTimeoutMs(override: number | undefined): number {
    if (override === undefined) return this.requestTimeoutMs;
    if (!Number.isSafeInteger(override) || override < 1 || override > 600_000) {
      throw new ExternalServiceError("公司 AI 通道", `invalid request timeout override ${override}`);
    }
    return override;
  }

  async complete(input: {
    system: string;
    prompt: string;
    model?: string;
    thinking?: AiThinkingMode;
    maxTokens: number;
    timeoutMs?: number;
  }): Promise<AiProviderCompletion> {
    const { payload, durationMs } = await this.post(input, {
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
    });
    const content = extractContent(payload);
    if (!content) {
      throw new ExternalServiceError("公司 AI 通道", "chat completion returned empty content");
    }
    return { ...auditMetadata(payload, durationMs), content };
  }

  /**
   * 带工具表的一轮对话。与 complete 走同一条传输、同一套超时与错误口径,
   * 区别只在请求里多了 tools、响应里可能带 tool_calls。
   */
  async completeToolTurn(input: AiToolTurnRequest): Promise<AiProviderToolTurn> {
    const { payload, durationMs } = await this.post(input, {
      messages: [
        { role: "system", content: input.system },
        ...input.messages.map(wireMessage),
      ],
      tools: input.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    });
    return {
      ...auditMetadata(payload, durationMs),
      content: extractContent(payload) ?? "",
      ...splitToolCalls(payload),
    };
  }

  private async post(
    input: { model?: string; thinking?: AiThinkingMode; maxTokens: number; timeoutMs?: number },
    body: Record<string, unknown>,
  ): Promise<{ payload: unknown; durationMs: number }> {
    if (!this.apiKey) {
      throw new ExternalServiceError("公司 AI 通道", "missing COL_APIKEY configuration");
    }
    const model = input.model ?? this.defaultModel;
    if (!model) {
      throw new ExternalServiceError("公司 AI 通道", "missing model configuration");
    }
    if (
      !Number.isInteger(input.maxTokens)
      || input.maxTokens < 1
      || input.maxTokens > MAX_COL_COMPLETION_MAX_TOKENS
    ) {
      throw new ExternalServiceError("公司 AI 通道", "invalid completion token limit");
    }

    const startedAt = performance.now();
    const effectiveTimeoutMs = this.resolveTimeoutMs(input.timeoutMs);
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort(new DOMException("request timed out", "TimeoutError"));
    }, effectiveTimeoutMs);
    const timeoutSignal = timeoutController.signal;
    try {
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
            max_tokens: input.maxTokens,
            stream: false,
            ...body,
          }),
          signal: timeoutSignal,
          dispatcher: LLM_HTTP_DISPATCHER,
        });
      } catch (error) {
        if (timeoutSignal.aborted || isAbortLike(error)) {
          throw new ColCompletionTimeoutError();
        }
        throw new ExternalServiceError("公司 AI 通道", "chat completion request failed");
      }

      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (!response.ok) {
        throw new ExternalServiceError(
          "公司 AI 通道",
          `chat completion failed with status ${response.status}`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (timeoutSignal.aborted || isAbortLike(error)) {
          throw new ColCompletionTimeoutError();
        }
        throw new ExternalServiceError("公司 AI 通道", "chat completion returned invalid JSON");
      }
      return { payload, durationMs };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * 可审计元数据必须由响应给出:模型名和 token 用量缺一个都不能记成成功,
 * 否则账上会出现一笔说不清用了多少的调用。
 */
function auditMetadata(payload: unknown, durationMs: number): AiProviderCompletion {
  const model = extractModel(payload);
  const inputTokens = extractUsageToken(payload, "prompt_tokens");
  const outputTokens = extractUsageToken(payload, "completion_tokens");
  if (!model || inputTokens === null || outputTokens === null) {
    throw new ExternalServiceError("公司 AI 通道", "chat completion omitted required audit metadata");
  }
  return { content: "", model, inputTokens, outputTokens, durationMs };
}

function wireMessage(message: AiConversationMessage): Record<string, unknown> {
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

/** 解析口径与火山通道共用一份,见 toolCallArguments.ts。 */
function splitToolCalls(payload: unknown): {
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
      throw new ExternalServiceError("公司 AI 通道", "tool call is missing id or function");
    }
    const name = raw.function.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new ExternalServiceError("公司 AI 通道", "tool call is missing a function name");
    }
    const parsed = parseToolCallArguments(raw.function.arguments);
    if (parsed.readable) toolCalls.push({ id: raw.id, name, arguments: parsed.arguments });
    else unreadableToolCalls.push({ id: raw.id, name, argumentsExcerpt: parsed.excerpt });
  }
  return { toolCalls, unreadableToolCalls };
}

export function resolveColEndpoint(
  baseUrl: string | undefined,
  resource: "models" | "chat/completions",
): string {
  if (!baseUrl) {
    throw new ExternalServiceError("公司 AI 通道", "missing COL_BASE_URL configuration");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ExternalServiceError("公司 AI 通道", "invalid COL_BASE_URL configuration");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new ExternalServiceError("公司 AI 通道", "invalid COL_BASE_URL configuration");
  }
  const basePath = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  url.pathname = `${basePath}/v1/${resource}`.replace(/\/{2,}/gu, "/");
  return url.toString();
}

function extractContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  // 深度思考模型会把思维链和答案放在同一个数组里。只取 type=text 的段:
  // 混进 reasoning 段等于把思考当答案交给下游解析。
  const text = content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isRecord(part) || part.type !== "text") return [];
    return typeof part.text === "string" ? [part.text] : [];
  }).join("");
  return text.trim() ? text : null;
}

function extractModel(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : null;
}

function extractUsageToken(
  payload: unknown,
  key: "prompt_tokens" | "completion_tokens",
): number | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;
  const value = payload.usage[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
