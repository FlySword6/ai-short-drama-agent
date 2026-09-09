/**
 * 拆解 agent 的真实模型冒烟。
 *
 * 用途:回答一个不能靠单测回答的问题——真实模型愿不愿意、能不能连续调对
 * 这套拆解工具。跑 N 轮同一段剧本,报成功率与每轮的工具调用事件。
 *
 * 这是开发期探针,直连供应商适配器,不经过数据库与审计账;生产路径永远
 * 走网关的 runToolTurn。别把它当成生产链路的证据。
 *
 * 用法:
 *   npx tsx scripts/breakdown-agent-smoke.mts --runs 20 --model deepseek-v4-flash
 */
import { readFileSync } from "node:fs";
import { chunkScriptLines } from "../src/modules/script-breakdown/lines.js";
import { runBreakdownAgent } from "../src/modules/script-breakdown/agent/runner.js";
import type { BreakdownFillEvent } from "../src/modules/script-breakdown/agent/tools.js";
import { ColCompletionProvider } from "../src/modules/ai/colCompletionProvider.js";

function envFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const matched = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (!matched) continue;
    entries.set(matched[1]!, matched[2]!.replace(/^['"]|['"]$/gu, ""));
  }
  return entries;
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const env = envFile(argValue("env", ".env"));
const runs = Number(argValue("runs", "5"));
const model = argValue("model", env.get("COL_SCRIPT_BREAKDOWN_MODEL") ?? "");
const scriptPath = argValue("script", "");
const maxTokens = Number(argValue("max-tokens", "8192"));

const SAMPLE_SCRIPT = [
  "第一场 客栈门口 黄昏",
  "林晚提着行李,站在斑驳的木门前。她抬头看了看褪色的招牌。",
  "掌柜从门内迎出来:客官,打尖还是住店?",
  "林晚:住店。要一间靠里的。",
  "掌柜打量她一眼,压低声音:姑娘一个人赶路,当心些。",
  "第二场 客房 夜",
  "林晚推开木窗,远处山影连绵。",
  "她从行李里取出一枚玉佩,借月光细看。玉佩背面刻着一个「沈」字。",
  "窗外忽然传来一声马嘶。林晚立刻吹熄了油灯。",
].join("\n");

const scriptText = scriptPath ? readFileSync(scriptPath, "utf8") : SAMPLE_SCRIPT;
const provider = new ColCompletionProvider(
  env.get("COL_APIKEY"),
  model,
  env.get("COL_BASE_URL"),
);

interface RunReport {
  index: number;
  ok: boolean;
  reason?: string;
  turns: number;
  toolCalls: number;
  rejected: number;
  unreadable: number;
  scenes: number;
  shots: number;
  characters: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

const reports: RunReport[] = [];
const firstRunEvents: BreakdownFillEvent[] = [];

for (let index = 1; index <= runs; index += 1) {
  const startedAt = Date.now();
  const events: BreakdownFillEvent[] = [];
  try {
    const result = await runBreakdownAgent({
      context: {
        scriptLines: chunkScriptLines(scriptText),
        approvedAssets: [],
        targetDurationSec: null,
      },
      maxToolCalls: 200,
      maxTurns: 80,
      onEvent: (event) => {
        events.push(event);
        if (index === 1) firstRunEvents.push(event);
      },
      turn: async (input) => {
        const turn = await provider.completeToolTurn({
          system: input.system,
          messages: input.messages,
          tools: input.tools,
          model,
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
    reports.push({
      index,
      ok: result.completed && result.validation.hardIssues.length === 0,
      ...(result.completed ? {} : { reason: result.unfinishedReason ?? "未收尾" }),
      turns: result.turns,
      toolCalls: result.toolCalls,
      rejected: events.filter((event) => event.status === "rejected").length,
      unreadable: result.unreadableToolCalls,
      scenes: result.draft.sceneDivisions?.length ?? 0,
      shots: result.draft.shotCandidates?.length ?? 0,
      characters: result.draft.assetCandidates?.characters.length ?? 0,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    reports.push({
      index,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      turns: 0,
      toolCalls: 0,
      rejected: events.filter((event) => event.status === "rejected").length,
      unreadable: events.filter((event) => event.status === "unreadable").length,
      scenes: 0,
      shots: 0,
      characters: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: Date.now() - startedAt,
    });
  }
  const last = reports.at(-1)!;
  console.log(
    `#${last.index} ${last.ok ? "成" : "败"} 轮次=${last.turns} 工具=${last.toolCalls} `
    + `被拒=${last.rejected} 没读全=${last.unreadable} 场=${last.scenes} 镜=${last.shots} `
    + `token=${last.inputTokens}/${last.outputTokens} 耗时=${last.ms}ms`
    + (last.reason ? ` 原因=${last.reason}` : ""),
  );
}

const succeeded = reports.filter((report) => report.ok).length;
console.log("");
console.log(`模型 ${model}:${succeeded}/${runs} 成功`);
console.log(`被拒工具调用合计 ${reports.reduce((sum, report) => sum + report.rejected, 0)} 次`);
console.log(`入参没读全合计 ${reports.reduce((sum, report) => sum + report.unreadable, 0)} 次`);
console.log(`输入 token 合计 ${reports.reduce((sum, report) => sum + report.inputTokens, 0)}`);
console.log(`输出 token 合计 ${reports.reduce((sum, report) => sum + report.outputTokens, 0)}`);
console.log("");
console.log("第一次运行的工具调用事件:");
const eventLabels = { accepted: "已填", rejected: "退回", unreadable: "没读全" } as const;
for (const event of firstRunEvents) {
  console.log(
    `  ${String(event.sequence).padStart(3, "0")} [${eventLabels[event.status]}] `
    + `${event.description}${event.reason ? ` — ${event.reason}` : ""}`,
  );
}
