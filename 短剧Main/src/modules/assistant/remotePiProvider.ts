import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";

const UNKNOWN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Internal marker consumed by the audit mapper; never sent to a provider. */
export const REMOTE_PI_UNKNOWN_USAGE_RESPONSE_ID = "pi-remote-usage-unknown";

export interface RemotePiConfig {
  apiUrl: string;
  token: string;
  modelId: string;
}

export interface RemotePiFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type RemotePiFetch = (input: string, init: RequestInit) => Promise<RemotePiFetchResponse>;

export class RemotePiTransportError extends Error {
  constructor(
    message: string,
    /** A retry may use this same controlled channel; it is never a provider-fallback signal. */
    readonly kind: "retryable" | "fatal",
  ) {
    super(message);
    this.name = "RemotePiTransportError";
  }
}

interface PendingTurn {
  conversationId: string;
  toolCallIds: Set<string>;
}

/**
 * Stateful only for one product request. The Pi wrapper remains stateless:
 * transcript/audit truth stays in PostgreSQL and is supplied by the caller.
 */
export class RemotePiProvider {
  private pendingTurn: PendingTurn | undefined;
  private hasVisibleRemoteEvent = false;

  constructor(
    private readonly config: RemotePiConfig,
    private readonly fetchFn: RemotePiFetch = fetch,
  ) {}

  async stream(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessageEventStream> {
    const message = await this.run(model, context, options?.signal);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    let contentIndex = 0;
    for (const item of message.content) {
      if (item.type === "text" && item.text) {
        stream.push({ type: "text_start", contentIndex, partial: message });
        stream.push({ type: "text_delta", contentIndex, delta: item.text, partial: message });
        stream.push({ type: "text_end", contentIndex, content: item.text, partial: message });
      } else if (item.type === "thinking" && item.thinking) {
        stream.push({ type: "thinking_start", contentIndex, partial: message });
        stream.push({ type: "thinking_delta", contentIndex, delta: item.thinking, partial: message });
        stream.push({ type: "thinking_end", contentIndex, content: item.thinking, partial: message });
      } else if (item.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: item, partial: message });
      }
      contentIndex += 1;
    }
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    return stream;
  }

  private async run(
    model: Model<any>,
    context: Context,
    signal?: AbortSignal,
  ): Promise<AssistantMessage> {
    const continuation = this.pendingTurn;
    const body = continuation
      ? continuationPayload(context, continuation)
      : promptPayload(context);
    const payload = await this.request(body, signal);
    const parsed = parseResponse(payload);
    if (parsed.text || parsed.thinking || parsed.toolCalls.length > 0) this.hasVisibleRemoteEvent = true;

    if (parsed.status === "requires_tool") {
      if (!parsed.conversationId || parsed.toolCalls.length === 0) {
        throw new RemotePiTransportError("Pi remote protocol error: requires_tool must include conversationId and toolCalls", "fatal");
      }
      const ids = new Set(parsed.toolCalls.map((call) => call.id));
      if (ids.size !== parsed.toolCalls.length) {
        throw new RemotePiTransportError("Pi remote protocol error: duplicate toolCall id", "fatal");
      }
      this.pendingTurn = { conversationId: parsed.conversationId, toolCallIds: ids };
    } else {
      if (parsed.toolCalls.length > 0) {
        throw new RemotePiTransportError("Pi remote protocol error: completed response cannot contain toolCalls", "fatal");
      }
      this.pendingTurn = undefined;
    }

    return remoteMessage(model, parsed);
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: RemotePiFetchResponse;
    try {
      response = await this.fetchFn(`${this.config.apiUrl.replace(/\/$/, "")}/pi/prompt/sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new RemotePiTransportError(
        `Pi remote network failure: ${errorMessage(error)}`,
        this.hasVisibleRemoteEvent ? "fatal" : "retryable",
      );
    }
    if (!response.ok) {
      const kind = response.status === 503 && !this.hasVisibleRemoteEvent ? "retryable" : "fatal";
      throw new RemotePiTransportError(`Pi remote request failed with status ${response.status}`, kind);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new RemotePiTransportError(`Pi remote protocol error: invalid JSON (${errorMessage(error)})`, "fatal");
    }
  }
}

function promptPayload(context: Context): Record<string, unknown> {
  return {
    system: context.systemPrompt ?? null,
    messages: context.messages.map(wireMessage),
    tools: (context.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
    toolResults: [],
    conversationId: null,
  };
}

function continuationPayload(context: Context, pending: PendingTurn): Record<string, unknown> {
  const results = context.messages
    .filter((message) => message.role === "toolResult")
    .filter((message) => pending.toolCallIds.has(message.toolCallId));
  if (results.length !== pending.toolCallIds.size || new Set(results.map((result) => result.toolCallId)).size !== results.length) {
    throw new RemotePiTransportError("Pi remote protocol error: continuation toolResults do not match the pending toolCalls", "fatal");
  }
  return {
    conversationId: pending.conversationId,
    toolResults: results.map((result) => ({
      toolCallId: result.toolCallId,
      content: result.details ?? textContent(result.content),
      isError: result.isError,
    })),
  };
}

function wireMessage(message: Context["messages"][number]): { role: string; content: string } {
  if (message.role === "user") return { role: "user", content: textContent(message.content) };
  if (message.role === "assistant") return { role: "assistant", content: textContent(message.content) };
  return { role: "tool", content: textContent(message.content) };
}

function textContent(content: string | readonly { type: string; text?: string; thinking?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((item) => item.type === "text" ? item.text ?? "" : item.type === "thinking" ? item.thinking ?? "" : "").join("");
}

interface RemoteResponse {
  status: "completed" | "requires_tool";
  text: string;
  thinking: string | null;
  toolCalls: ToolCall[];
  conversationId: string | null;
  usage: RemoteUsage;
}

interface RemoteUsage {
  known: boolean;
  input: number;
  output: number;
  totalTokens: number;
  cost: { input: number; output: number; total: number } | null;
}

function parseResponse(value: unknown): RemoteResponse {
  if (!isRecord(value) || (value.status !== "completed" && value.status !== "requires_tool")) {
    throw new RemotePiTransportError("Pi remote protocol error: missing response status", "fatal");
  }
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls.map(parseToolCall) : [];
  return {
    status: value.status,
    text: typeof value.text === "string" ? value.text : "",
    thinking: typeof value.thinking === "string" ? value.thinking : null,
    toolCalls,
    conversationId: typeof value.conversationId === "string" && value.conversationId ? value.conversationId : null,
    usage: parseUsage(value.usage),
  };
}

function parseToolCall(value: unknown): ToolCall {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !value.name || !isRecord(value.arguments)) {
    throw new RemotePiTransportError("Pi remote protocol error: invalid toolCall", "fatal");
  }
  return { type: "toolCall", id: value.id, name: value.name, arguments: value.arguments };
}

function parseUsage(value: unknown): RemoteUsage {
  if (!isRecord(value) || value.status === "unknown") return { known: false, input: 0, output: 0, totalTokens: 0, cost: null };
  return {
    known: true,
    input: numberOrZero(value.inputTokens),
    output: numberOrZero(value.outputTokens),
    totalTokens: numberOrZero(value.totalTokens),
    cost: isRecord(value.cost) ? {
      input: numberOrZero(value.cost.input),
      output: numberOrZero(value.cost.output),
      total: numberOrZero(value.cost.total),
    } : null,
  };
}

function remoteMessage(model: Model<any>, response: RemoteResponse): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (response.thinking) content.push({ type: "thinking", thinking: response.thinking });
  if (response.text) content.push({ type: "text", text: response.text });
  content.push(...response.toolCalls);
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "pi-remote",
    model: model.id,
    responseId: response.usage.known ? undefined : REMOTE_PI_UNKNOWN_USAGE_RESPONSE_ID,
    usage: {
      ...UNKNOWN_USAGE,
      input: response.usage.input,
      output: response.usage.output,
      totalTokens: response.usage.totalTokens,
      cost: response.usage.cost
        ? { ...UNKNOWN_USAGE.cost, ...response.usage.cost }
        : UNKNOWN_USAGE.cost,
    },
    stopReason: response.status === "requires_tool" ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

export function remotePiErrorMessage(model: Model<any>, _error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "pi-remote",
    model: model.id,
    usage: UNKNOWN_USAGE,
    stopReason: "error",
    // Provider/network diagnostics must not enter the Assistant transcript or SSE stream.
    errorMessage: "受控 AI Gateway 当前不可用",
    timestamp: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
