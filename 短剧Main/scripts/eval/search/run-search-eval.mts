/**
 * 检索评测脚本（交接补充 · 2026-08-27）
 *
 * 用途：对资产检索链路跑 TOP@K / MRR 评测，复现交接时的基线 TOP 85% / MRR 0.83。
 * 用法：
 *   npx tsx scripts/eval/search/run-search-eval.mts --testset <测试集.json> [--k 10] [--user-id <uuid>] [--skip-understanding]
 *
 * 测试集格式（JSON 数组，交接时测试集由原负责人另行提供）：
 * [
 *   { "query": "白发老年男性角色", "expected_ids": ["<asset_entities 的 id>", ...] },
 *   ...
 * ]
 * expected_ids 可以是 entity id，也可以是 asset_media id（脚本会按包含关系匹配）。
 *
 * 指标口径：
 *   TOP@K：expected_ids 中至少一个出现在返回前 K 条的 query 占比。
 *   MRR：第一个命中的排名倒数（1/rank），未命中记 0，取平均。
 *
 * --skip-understanding：关掉 LLM 问题切分跑一组对照，用来量化"切分"对指标的贡献、
 * 以及换轻量化模型后是否伤指标。对应 AssetSearchService 的 skipQueryUnderstanding。
 */
import fs from "node:fs";
import { createDatabase } from "../../../src/db/client.js";
import { AssetSearchService } from "../../../src/services/searchService.js";

interface Case {
  query: string;
  expected_ids: string[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const testsetPath = arg("testset");
const K = Number(arg("k", "10"));
const userId = arg("user-id");
const skipUnderstanding = process.argv.includes("--skip-understanding");

if (!testsetPath || !fs.existsSync(testsetPath)) {
  console.error("用法: npx tsx scripts/eval/search/run-search-eval.mts --testset <json> [--k 10] [--user-id <uuid>] [--skip-understanding]");
  process.exit(1);
}

const cases = JSON.parse(fs.readFileSync(testsetPath, "utf8")) as Case[];
const handle = createDatabase();

const service = new AssetSearchService(handle.db, {
  skipQueryUnderstanding: skipUnderstanding,
});

const rows: Array<{ query: string; hit: boolean; rank: number }> = [];
let done = 0;

for (const c of cases) {
  try {
    const items = await service.search(c.query, K, userId);
    const expected = new Set(c.expected_ids);
    let rank = 0;
    for (let i = 0; i < items.length; i++) {
      const id = String(items[i].sourceId ?? "");
      if (expected.has(id)) {
        rank = i + 1;
        break;
      }
    }
    rows.push({ query: c.query, hit: rank > 0, rank });
  } catch (error) {
    console.error(`[case 失败] ${c.query}:`, error instanceof Error ? error.message : error);
    rows.push({ query: c.query, hit: false, rank: 0 });
  }
  done++;
  if (done % 10 === 0) console.error(`进度 ${done}/${cases.length}`);
}

const top = rows.filter((r) => r.hit).length / Math.max(rows.length, 1);
const mrr = rows.reduce((acc, r) => acc + (r.rank > 0 ? 1 / r.rank : 0), 0) / Math.max(rows.length, 1);

console.log("\n========== 检索评测结果 ==========");
console.log(`模式      : ${skipUnderstanding ? "跳过问题切分" : "含问题切分"}`);
console.log(`用例数    : ${rows.length}`);
console.log(`TOP@${K}   : ${(top * 100).toFixed(1)}%`);
console.log(`MRR       : ${mrr.toFixed(3)}`);
console.log("----------------------------------");
for (const r of rows) {
  console.log(`${r.hit ? "HIT " : "MISS"}  rank=${r.rank || "-"}  ${r.query}`);
}
console.log("==================================");

await handle.pool.end();
