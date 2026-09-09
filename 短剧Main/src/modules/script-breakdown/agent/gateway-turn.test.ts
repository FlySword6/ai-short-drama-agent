import assert from "node:assert/strict";
import test from "node:test";
import { AiGatewayService } from "../../ai/service.js";
import type {
  AiCallRepository,
  AiCompletionProvider,
  AiProviderToolTurn,
  AiToolTurnRequest,
} from "../../ai/types.js";
import { chunkScriptLines } from "../lines.js";
import { runBreakdownAgent, type BreakdownTurnResult } from "./runner.js";

/**
 * 端到端接线:agent 循环 → 统一 AI 网关(审计与限额)→ 供应商适配器。
 * 工具调用轮次是真实的付费调用,必须和普通调用一样进审计账。
 */

const SCRIPT = ["场景一 客栈门口", "林晚提着行李站在门口。"].join("\n");

const TURNS: Array<Array<{ name: string; arguments: Record<string, unknown> }>> = [
  [{ name: "write_story_outline", arguments: { summary: "林晚投宿客栈" } }],
  [{
    name: "add_scene",
    arguments: { name: "客栈门口", summary: "林晚抵达", start_line_index: 0, end_line_index: 1 },
  }],
  [{ name: "add_character", arguments: { name: "林晚", description: "女主角" } }],
  [{ name: "finish_breakdown", arguments: {} }],
  [],
];

function toolCallingProvider() {
  const requests: AiToolTurnRequest[] = [];
  let index = 0;
  const provider: AiCompletionProvider = {
    complete: async () => {
      throw new Error("这条链路只走工具调用");
    },
    completeToolTurn: async (input): Promise<AiProviderToolTurn> => {
      requests.push(input);
      const calls = TURNS[index] ?? [];
      index += 1;
      return {
        content: calls.length > 0 ? "" : "拆完了",
        toolCalls: calls.map((call, position) => ({
          id: `call-${index}-${position}`,
          name: call.name,
          arguments: call.arguments,
        })),
        unreadableToolCalls: [],
        model: "deepseek-v4-flash-ga-260731",
        inputTokens: 300,
        outputTokens: 60,
        durationMs: 9,
      };
    },
  };
  return { provider, requests };
}

function auditRepository() {
  const reserved: string[] = [];
  const completed: Array<{ model: string; inputTokens: number | null }> = [];
  const repository: AiCallRepository = {
    reserve: async (input) => {
      reserved.push(input.requestedModel);
      return { id: `call-${reserved.length}` };
    },
    complete: async (input) => { completed.push({ model: input.model, inputTokens: input.inputTokens }); },
    fail: async () => { throw new Error("本用例不该有失败调用"); },
  };
  return { repository, reserved, completed };
}

test("拆解走网关的工具调用轮次:内容进草稿,每一轮都进审计账", async () => {
  const audit = auditRepository();
  const upstream = toolCallingProvider();
  const gateway = new AiGatewayService(
    audit.repository,
    upstream.provider,
    {
      enabled: true,
      apiKeyConfigured: true,
      dailyCallLimit: 100,
      defaultModel: "deepseek-v4-flash-ga-260731",
      embeddingModel: null,
    },
  );
  const maxTokens = await gateway.stageOutputBudgetFor("script_breakdown_enrich");

  const result = await runBreakdownAgent({
    context: { scriptLines: chunkScriptLines(SCRIPT), approvedAssets: [], targetDurationSec: null },
    maxToolCalls: 50,
    maxTurns: 20,
    onEvent: () => {},
    turn: async (input): Promise<BreakdownTurnResult> => {
      const turn = await gateway.runToolTurn({
        actorId: "actor-1",
        purpose: "script_breakdown_enrich",
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        prompt: "",
        thinking: "disabled",
        maxTokens,
      });
      return {
        text: turn.content,
        toolCalls: turn.toolCalls,
        unreadableToolCalls: turn.unreadableToolCalls,
        model: turn.model,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        durationMs: turn.durationMs,
      };
    },
  });

  assert.equal(result.completed, true);
  assert.equal(result.draft.sceneDivisions?.length, 1);
  assert.equal(result.draft.shotCandidates, undefined, "P6 起阶段①不产镜头");
  assert.equal(audit.reserved.length, result.turns, "每一轮模型往返都要有一条审计行");
  assert.equal(audit.completed.length, result.turns);
  assert.deepEqual([...new Set(audit.reserved)], ["deepseek-v4-flash-ga-260731"]);

  const firstRequest = upstream.requests[0]!;
  assert.equal(firstRequest.maxTokens, maxTokens, "预算由网关按用途算出,拆解侧照用");
  assert.equal(firstRequest.thinking, "disabled");
  assert.deepEqual(
    firstRequest.tools.map((tool) => tool.name).sort(),
    ["add_audio", "add_character", "add_costume", "add_location", "add_prop", "add_scene", "finish_breakdown", "write_story_outline"],
  );
  assert.ok(firstRequest.tools.every((tool) => tool.parameters), "工具的入参 schema 必须送到供应商");
});
