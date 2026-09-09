/**
 * 跑一次拆解:一个模型 × 一集剧本。
 *
 * 走的是 agent 调工具那条路(与生产同一份 runner 与工具集),但直连供应商适配器、
 * 不经数据库与审计账——评测要的是模型行为,不是链路。这一条在报告里写清楚。
 */
import { chunkScriptLines } from "../../../../src/modules/script-breakdown/lines.js";
import { runBreakdownAgent } from "../../../../src/modules/script-breakdown/agent/runner.js";
import type { BreakdownFillEvent } from "../../../../src/modules/script-breakdown/agent/tools.js";
import { ColCompletionProvider } from "../../../../src/modules/ai/colCompletionProvider.js";
import { ArkChatClient } from "../../../../src/integrations/arkClient.js";
import type { EvalConfig, EvalModelSpec, EvalRunRecord } from "./types.js";

export interface ToolTurnProvider {
  completeToolTurn(input: {
    system: string;
    messages: Array<{ role: "user" | "assistant" | "tool"; content: string; toolCallId?: string;
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>;
    tools: Array<{ name: string; description: string; parameters: unknown }>;
    model?: string;
    thinking?: "disabled";
    maxTokens: number;
  }): Promise<{
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    unreadableToolCalls: Array<{ id: string; name: string; argumentsExcerpt: string }>;
    model?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    durationMs?: number;
  }>;
}

export function createProvider(spec: EvalModelSpec, env: Map<string, string>): ToolTurnProvider {
  if (spec.channel === "col") {
    return new ColCompletionProvider(
      env.get("COL_APIKEY"),
      spec.model,
      env.get("COL_BASE_URL"),
    ) as unknown as ToolTurnProvider;
  }
  return new ArkChatClient(
    env.get("ARK_API_KEY"),
    spec.model,
    env.get("ARK_BASE_URL"),
  ) as unknown as ToolTurnProvider;
}

export async function runOne(input: {
  spec: EvalModelSpec;
  provider: ToolTurnProvider;
  episodeId: string;
  scriptText: string;
  config: EvalConfig;
  attempt: number;
  onEvent?: (event: BreakdownFillEvent) => void;
}): Promise<EvalRunRecord> {
  const startedAt = new Date();
  const started = Date.now();
  let rejected = 0;
  // agent 循环会把一次模型往返的异常吞掉,只表现成「模型没干活」。
  // 评测要分清「传输失败」和「模型停口」,所以在这一层自己记一份。
  const turnErrors: string[] = [];

  const base = {
    episodeId: input.episodeId,
    modelId: input.spec.id,
    model: input.spec.model,
    channel: input.spec.channel,
    attempt: input.attempt,
    startedAt: startedAt.toISOString(),
  };

  try {
    const result = await runBreakdownAgent({
      context: {
        scriptLines: chunkScriptLines(input.scriptText),
        approvedAssets: [],
        targetDurationSec: null,
      },
      maxToolCalls: input.config.maxToolCalls,
      maxTurns: input.config.maxTurns,
      onEvent: (event) => {
        if (event.status === "rejected") rejected += 1;
        input.onEvent?.(event);
      },
      turn: async (turnInput) => {
        let turn;
        try {
          turn = await input.provider.completeToolTurn({
            system: turnInput.system,
            messages: turnInput.messages,
            tools: turnInput.tools,
            model: input.spec.model,
            thinking: "disabled",
            maxTokens: input.config.maxTokens,
          });
        } catch (error) {
          turnErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
          throw error;
        }
        return {
          text: turn.content,
          toolCalls: turn.toolCalls,
          // 入参没读出来的那些要原样交回:runner 靠它把「报文没读全」与
          // 「模型主动不调工具」分开处理(重发 vs 收尾)。评测这一层不改
          // 判据,只是不能把这个信号在半路吞掉——生产路 service.ts 同处一样。
          unreadableToolCalls: turn.unreadableToolCalls,
          model: turn.model ?? input.spec.model,
          inputTokens: turn.inputTokens ?? 0,
          outputTokens: turn.outputTokens ?? 0,
          durationMs: turn.durationMs ?? 0,
        };
      },
    });
    const hardIssues = result.validation.hardIssues.length;
    const ok = result.completed && hardIssues === 0;
    return {
      ...base,
      ok,
      failureKind: ok ? null
        : turnErrors.length > 0 ? "transport"
        : hardIssues > 0 ? "validation"
        : "stopped_early",
      failureReason: result.completed
        ? (hardIssues > 0 ? `硬校验未过:${result.validation.hardIssues[0]?.message ?? ""}` : null)
        : (turnErrors[0] ?? result.unfinishedReason ?? "未收尾"),
      turnErrors,
      rejectedToolCalls: rejected,
      turns: result.turns,
      toolCalls: result.toolCalls,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: Date.now() - started,
      draft: result.draft,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      failureKind: turnErrors.length > 0 ? "transport" : "harness",
      failureReason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      turnErrors,
      rejectedToolCalls: rejected,
      turns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - started,
      draft: {},
    };
  }
}
