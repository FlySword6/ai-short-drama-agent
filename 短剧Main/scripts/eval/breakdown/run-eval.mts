/**
 * 拆解质量评测:一条命令跑完「连跑 → 打分 → 出报告」。
 *
 *   BREAKDOWN_EVAL_DATA_ROOT=<剧本正文目录> \
 *     npx tsx scripts/eval/breakdown/run-eval.mts --out outputs/breakdown-eval-report-<日期>.md
 *
 * 常用开关:
 *   --phase run|score|all   只连跑 / 只用已有产物打分 / 两样都做(默认 all)
 *   --episodes a,b          只跑这几集(默认配置里全部)
 *   --models a,b            只跑这几个模型
 *   --repeats N             覆盖配置里的连跑次数
 *   --runs-dir DIR          原始产物目录(默认 eval/breakdown/runs)
 *
 * 花的是真钱:每一次运行都是一次真实模型调用。跑之前先用 --episodes 单集试算。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createProvider, runOne } from "./harness/run-one.js";
import type { EvalConfig, EvalRunRecord } from "./harness/types.js";

const repoRoot = resolve(import.meta.dirname, "../../..");

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function readEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const matched = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (!matched) continue;
    entries.set(matched[1]!, matched[2]!.replace(/^['"]|['"]$/gu, ""));
  }
  return entries;
}

const dataRoot = process.env.BREAKDOWN_EVAL_DATA_ROOT ?? arg("data-root", "");
if (!dataRoot) {
  throw new Error(
    "剧本正文目录没给。正文是版权件不进仓库,请设 BREAKDOWN_EVAL_DATA_ROOT 指向 breakdown-eval 目录。",
  );
}

const configPath = arg("config", join(repoRoot, "eval/breakdown/eval-config.json"));
const config = JSON.parse(readFileSync(configPath, "utf8")) as EvalConfig & { schema: string };
const runsDir = resolve(repoRoot, arg("runs-dir", "eval/breakdown/runs"));
const phase = arg("phase", "all");
const outPath = resolve(repoRoot, arg("out", "outputs/breakdown-eval-report.md"));

const episodeFilter = arg("episodes", "");
const modelFilter = arg("models", "");
const episodes = episodeFilter ? episodeFilter.split(",") : config.episodes;
const models = modelFilter
  ? config.models.filter((model) => modelFilter.split(",").includes(model.id))
  : config.models;
const repeats = Number(arg("repeats", String(config.repeats)));
const skipExisting = process.argv.includes("--skip-existing");

mkdirSync(runsDir, { recursive: true });

function runFileName(record: EvalRunRecord): string {
  return `${record.episodeId}__${record.modelId}__${String(record.attempt).padStart(2, "0")}.json`;
}

if (phase === "run" || phase === "all") {
  const env = readEnvFile(join(repoRoot, ".env"));
  for (const spec of models) {
    const provider = createProvider(spec, env);
    for (const episodeId of episodes) {
      const scriptText = readFileSync(join(dataRoot, "episodes", `${episodeId}.txt`), "utf8");
      for (let attempt = 1; attempt <= repeats; attempt += 1) {
        const existing = join(runsDir, `${episodeId}__${spec.id}__${String(attempt).padStart(2, "0")}.json`);
        // 断点续跑:真钱调用不重复付,已有产物就跳过。
        if (skipExisting && existsSync(existing)) {
          process.stdout.write(`${episodeId} ${spec.id} #${attempt} 跳过(已有产物)\n`);
          continue;
        }
        const record = await runOne({
          spec, provider, episodeId, scriptText, config, attempt,
        });
        writeFileSync(join(runsDir, runFileName(record)), `${JSON.stringify(record, null, 2)}\n`);
        const money = `入${record.inputTokens}/出${record.outputTokens}`;
        process.stdout.write(
          `${episodeId} ${spec.id} #${attempt} ${record.ok ? "成" : `败(${record.failureReason})`}`
          + ` 场=${record.draft.sceneDivisions?.length ?? 0}`
          + ` 镜=${record.draft.shotCandidates?.length ?? 0}`
          + ` 拒=${record.rejectedToolCalls} ${money} ${Math.round(record.durationMs / 1000)}s\n`,
        );
      }
    }
  }
}

if (phase === "score" || phase === "all") {
  // 打分件按需加载:只连跑的时候不该被它牵连。
  const { loadGold } = await import("./harness/gold.js");
  const { scoreAll } = await import("./harness/metrics.js");
  const { renderReport } = await import("./harness/report.js");
  const records = readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")) as EvalRunRecord)
    .filter((record) => episodes.includes(record.episodeId))
    .filter((record) => models.some((model) => model.id === record.modelId));
  if (records.length === 0) throw new Error(`${runsDir} 里没有可打分的运行产物。`);

  const gold = loadGold(join(repoRoot, "eval/breakdown/gold"));
  const report = scoreAll({ records, gold, models });
  writeFileSync(outPath, renderReport({ report, config, gold, generatedAt: new Date() }));
  process.stdout.write(`报告已写入 ${outPath}\n`);
}
