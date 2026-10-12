import type { AppConfig } from "../config";
import { ModelClient } from "../models/client";
import { BreakdownError } from "./errors";
import type { StageModelAdapter } from "./execution";

export class LocalProxyStageModelAdapter implements StageModelAdapter {
  private readonly client: ModelClient;

  constructor(config: AppConfig, transport: typeof fetch = fetch) {
    this.client = new ModelClient(config, transport);
  }

  async call(input: Parameters<StageModelAdapter["call"]>[0]) {
    const payload = input.payload as Record<string, unknown>;
    if (payload.operation !== "extractFacts" || typeof payload.systemPrompt !== "string") {
      throw new BreakdownError(400, "STAGE_PAYLOAD_INVALID", "事实拆解请求无效。");
    }
    const messages = payload.messages;
    if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== "user"
      || typeof messages[0]?.content !== "string") {
      throw new BreakdownError(400, "STAGE_PAYLOAD_INVALID", "事实拆解上下文无效。");
    }
    const result = await this.client.call({
      model: input.model,
      messages: [{ role: "system", content: payload.systemPrompt }, messages[0]],
      reasoningEffort: input.reasoningEffort,
      maxOutputTokens: input.maxOutputTokens,
      allowPaid: true,
    });
    if (result.status !== "completed") {
      throw new BreakdownError(422, "MODEL_OUTPUT_INCOMPLETE", "模型输出达到额度上限，请调整剧本长度或输出额度后重试。");
    }
    let output: unknown;
    try { output = JSON.parse(result.text.trim()); }
    catch { throw new BreakdownError(422, "MODEL_OUTPUT_NOT_JSON", "模型没有返回 JSON 事实拆解结果。"); }
    return {
      output,
      providerRequestId: result.providerRequestId,
      usage: {
        ...(result.usage.inputTokens !== null ? { inputTokens: result.usage.inputTokens } : {}),
        ...(result.usage.outputTokens !== null ? { outputTokens: result.usage.outputTokens } : {}),
        ...(result.usage.totalTokens !== null ? { totalTokens: result.usage.totalTokens } : {}),
      },
    };
  }
}
