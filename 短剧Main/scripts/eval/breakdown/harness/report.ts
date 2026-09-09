/**
 * 把打分结果渲染成人能读的报告。纯字符串拼装,不读磁盘不发请求。
 */
import type { EvalConfig } from "./types.js";
import type { EvalReportData, GoldBundle } from "./metrics.js";

function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function num(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "—" : value.toFixed(digits);
}

function kinds(counts: Record<string, number>): string {
  const label: Record<string, string> = {
    transport: "传输失败",
    stopped_early: "模型停口",
    validation: "硬校验不过",
    harness: "评测脚手架出错",
  };
  const entries = Object.entries(counts);
  return entries.length === 0 ? "—" : entries.map(([kind, count]) => `${label[kind] ?? kind} ${count}`).join(" / ");
}

export function renderReport(input: {
  report: EvalReportData;
  config: EvalConfig;
  gold: GoldBundle;
  generatedAt: Date;
}): string {
  const { perModel, perEpisode } = input.report;
  const episodes = [...new Set(perEpisode.map((row) => row.episodeId))].sort();
  const lines: string[] = [];

  lines.push("<!-- 本文件由 scripts/eval/breakdown/run-eval.mts 生成,手改会被下一次跑覆盖。 -->");
  lines.push("");
  lines.push("## 一、总表(分模型)");
  lines.push("");
  lines.push("| 模型 | 通道 | 运行 | 成功率 | 失败分类 | 准确率 | 召回率 | 场数命中 | 场数偏差 | 镜数/金标 | 角色集合稳定 | 单次耗时 | 入/出 token | 折算钱 |");
  lines.push("|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of perModel) {
    lines.push([
      row.modelId,
      row.channel === "ark" ? "火山方舟" : "公司通道",
      `${row.successes}/${row.attempts}`,
      pct(row.successRate),
      kinds(row.failureKinds),
      pct(row.precision?.overall ?? null),
      pct(row.recall?.overall ?? null),
      pct(row.sceneCountExactRate),
      num(row.sceneCountMae, 2),
      num(row.shotCountRatio, 2),
      row.characterSetStability === null ? "—" : pct(row.characterSetStability),
      row.durationMsMean === null ? "—" : `${Math.round(row.durationMsMean / 1000)}s`,
      `${row.totalInputTokens.toLocaleString("en-US")} / ${row.totalOutputTokens.toLocaleString("en-US")}`,
      row.costYuan === null ? "单价未核实" : `${row.costYuan.toFixed(2)} 元`,
    ].join(" | ").replace(/^/, "| ").concat(" |"));
  }
  lines.push("");
  lines.push("> 准确率与召回率**只统计跑成功的那几次**——失败的运行没有可评的产物。");
  lines.push("> 两个模型失败的集不一样时,总表这两列就不是同一批题的分数,**横向比要以逐集明细为准**。");
  lines.push("");
  lines.push("单价来源:");
  for (const row of perModel) {
    lines.push(`- \`${row.model}\`:${row.costSource ?? "**没查到公开单价,本报告只报 token,不折算钱**"}`);
  }
  lines.push("");

  lines.push("## 二、分维度的准确率与召回率");
  lines.push("");
  lines.push("| 模型 | 角色·准确 | 角色·召回 | 场景·准确 | 场景·召回 | 道具·准确 | 道具·召回 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const row of perModel) {
    lines.push(`| ${row.modelId} | ${pct(row.precision?.character ?? null)} | ${pct(row.recall?.character ?? null)}`
      + ` | ${pct(row.precision?.location ?? null)} | ${pct(row.recall?.location ?? null)}`
      + ` | ${pct(row.precision?.prop ?? null)} | ${pct(row.recall?.prop ?? null)} |`);
  }
  lines.push("");

  lines.push("## 三、逐集明细");
  lines.push("");
  lines.push("| 集 | 模型 | 成功 | 场(均值±标准差) | 金标场 | 镜(均值±标准差) | 金标镜 | 角色数 | 角色集合稳定 | 准确率 | 召回率 | 漏掉的金标 | 误报里被金标点名排除的 |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
  for (const episodeId of episodes) {
    for (const row of perEpisode.filter((entry) => entry.episodeId === episodeId)) {
      lines.push([
        episodeId,
        row.modelId,
        `${row.successes}/${row.attempts}`,
        row.scenes.mean === null ? "—" : `${num(row.scenes.mean)}±${num(row.scenes.stdev)}`,
        String(row.goldScenes),
        row.shots.mean === null ? "—" : `${num(row.shots.mean)}±${num(row.shots.stdev)}`,
        String(row.goldShots),
        num(row.characters.mean),
        row.characterSetStability === null ? "—" : pct(row.characterSetStability),
        pct(row.precision?.overall ?? null),
        pct(row.recall?.overall ?? null),
        row.missedGold.length === 0 ? "—" : row.missedGold.join("、"),
        row.excludedHits.length === 0 ? "—" : row.excludedHits.join("、"),
      ].join(" | ").replace(/^/, "| ").concat(" |"));
    }
  }
  lines.push("");

  const failures = perEpisode.filter((row) => row.successes < row.attempts);
  lines.push("## 四、失败现场");
  lines.push("");
  if (failures.length === 0) {
    lines.push("本轮没有失败。");
  } else {
    for (const row of failures) {
      lines.push(`- **${row.episodeId} / ${row.modelId}** ${row.attempts - row.successes} 次失败(${kinds(row.failureKinds)}):`);
      for (const reason of [...new Set(row.failureReasons)]) lines.push(`  - ${reason}`);
    }
  }
  lines.push("");

  lines.push("## 五、能不能上生产(按配置里的门槛机器判定)");
  lines.push("");
  lines.push(`> ${input.config.productionGate.why}`);
  lines.push("");
  const gate = input.config.productionGate;
  lines.push("| 模型 | 成功率 ≥ " + pct(gate.successRate, 0)
    + " | 角色召回 ≥ " + pct(gate.characterRecall, 0)
    + " | 角色准确 ≥ " + pct(gate.characterPrecision, 0)
    + " | 场数命中 ≥ " + pct(gate.sceneCountExactRate, 0) + " | 判定 |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of perModel) {
    const checks = [
      { actual: row.successRate, need: gate.successRate },
      { actual: row.recall?.character ?? null, need: gate.characterRecall },
      { actual: row.precision?.character ?? null, need: gate.characterPrecision },
      { actual: row.sceneCountExactRate, need: gate.sceneCountExactRate },
    ];
    const cells = checks.map((check) => check.actual === null
      ? "数据不足"
      : `${pct(check.actual, 2)} ${check.actual >= check.need ? "过" : "不过"}`);
    const verdict = checks.some((check) => check.actual === null) ? "**数据不足,不下结论**"
      : checks.every((check) => check.actual! >= check.need) ? "**可以上生产**"
      : "**不能上生产**";
    lines.push(`| ${row.modelId} | ${cells.join(" | ")} | ${verdict} |`);
  }
  lines.push("");

  lines.push("## 六、这一轮怎么跑的");
  lines.push("");
  lines.push(`- 生成时间:${input.generatedAt.toISOString()}`);
  lines.push(`- 集数:${episodes.length}(${episodes.join("、")});每集连跑 ${input.config.repeats} 次`);
  lines.push(`- 参照答案:\`eval/breakdown/gold/\`,资产 ${input.gold.asset.size} 集、场次镜头 ${input.gold.scene.size} 集`);
  lines.push("- 重跑:`BREAKDOWN_EVAL_DATA_ROOT=<正文目录> npx tsx scripts/eval/breakdown/run-eval.mts`");
  lines.push("");
  return `${lines.join("\n")}\n`;
}
