import { LLM_HTTP_DISPATCHER, type LlmFetchInit } from "../../integrations/arkClient.js";
import { ExternalServiceError } from "../../shared/errors.js";
import type { AiCompletionProvider, AiProviderCompletion, AiThinkingMode } from "./types.js";

export type MiniMaxFetch = (input: string | URL | Request, init?: LlmFetchInit) => Promise<Response>;

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com";
const ALLOWED_MINIMAX_HOSTS = new Set(["api.minimaxi.com", "api-bj.minimaxi.com"]);

/** 请求超时默认值与结构上限,口径同 Ark/Col 适配器(见 arkClient.ts 同名字段注释)。 */
const MINIMAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_MINIMAX_REQUEST_TIMEOUT_MS = 600_000;

/**
 * OpenAI-compatible MiniMax completion adapter. Provider-specific request and
 * response differences stay here so the AI gateway only sees its stable port.
 */
export class MiniMaxCompletionProvider implements AiCompletionProvider {
  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly defaultModel: string | undefined,
    baseUrl = DEFAULT_MINIMAX_BASE_URL,
    private readonly fetchImpl: MiniMaxFetch = fetch,
  ) {
    this.endpoint = resolveEndpoint(baseUrl);
  }

  async complete(input: {
    system: string;
    prompt: string;
    model?: string;
    thinking?: AiThinkingMode;
    maxTokens: number;
    timeoutMs?: number;
  }): Promise<AiProviderCompletion> {
    if (!this.apiKey) throw new ExternalServiceError("MiniMax model", "missing API key configuration");
    const model = input.model ?? this.defaultModel;
    if (!model) throw new ExternalServiceError("MiniMax model", "missing model configuration");
    if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1) {
      throw new ExternalServiceError("MiniMax model", "invalid completion token limit");
    }

    const startedAt = performance.now();
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
          ...(thinkingForModel(model, input.thinking)),
          max_completion_tokens: input.maxTokens,
          stream: false,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.prompt },
          ],
        }),
        signal: AbortSignal.timeout(resolveRequestTimeout(input.timeoutMs)),
        dispatcher: LLM_HTTP_DISPATCHER,
      });
    } catch {
      throw new ExternalServiceError("MiniMax model", "chat completion request failed");
    }

    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      throw new ExternalServiceError("MiniMax model", `chat completion failed with status ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ExternalServiceError("MiniMax model", "chat completion returned invalid JSON");
    }

    const content = extractContent(payload);
    if (!content) throw new ExternalServiceError("MiniMax model", "chat completion returned empty content");
    return {
      content,
      model: extractModel(payload) ?? model,
      inputTokens: extractUsageToken(payload, "prompt_tokens"),
      outputTokens: extractUsageToken(payload, "completion_tokens"),
      durationMs,
    };
  }
}

function resolveEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ExternalServiceError("MiniMax model", "invalid base URL configuration");
  }
  if (url.protocol !== "https:" || !ALLOWED_MINIMAX_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ExternalServiceError("MiniMax model", "invalid base URL configuration");
  }
  return `${url.origin}/v1/chat/completions`;
}

function resolveRequestTimeout(override: number | undefined): number {
  if (override === undefined) return MINIMAX_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(override) || override < 1 || override > MAX_MINIMAX_REQUEST_TIMEOUT_MS) {
    throw new ExternalServiceError("MiniMax model", `invalid request timeout override ${override}`);
  }
  return override;
}

function thinkingForModel(model: string, thinking: AiThinkingMode | undefined): Record<string, unknown> {
  if (!isM3Model(model) || !thinking) return {};
  return { thinking: { type: thinking === "auto" ? "adaptive" : thinking } };
}

function isM3Model(model: string): boolean {
  return /^minimax-m3(?:$|[-_])/iu.test(model.trim());
}

function extractContent(payload: unknown): string | null {
  const message = firstMessage(payload);
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isRecord(part)) return [];
    return typeof part.text === "string" ? [part.text] : [];
  }).join("");
  return text || null;
}

function firstMessage(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) return null;
  const message = payload.choices[0].message;
  return isRecord(message) ? message : null;
}

function extractModel(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.model === "string" && payload.model.trim()
    ? payload.model
    : null;
}

function extractUsageToken(payload: unknown, key: "prompt_tokens" | "completion_tokens"): number | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;
  const value = payload.usage[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
