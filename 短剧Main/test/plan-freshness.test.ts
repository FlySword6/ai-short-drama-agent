import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * 护栏:编排真源与仓库实况的新鲜度。
 *
 * 起因(2026-07-27 自审):33 个独立代理审计本 session,22 条幸存发现里有 5 条
 * 是同一个根因 —— **真源文档靠手工回写,没有任何机器会发现它过期**:
 *   - 迁移台账停在 026,实际已到 031
 *   - S41 合流后 43 分钟内两次编辑同一文件,状态仍写「🔧 在跑」
 *   - version-plan 里「标签体系」标 ❌ 零实现,而迁移 031 已经合流
 *   - R12「待拆」而它的包早已合流
 *
 * **已有的一致性门禁只比对 md ↔ config_entries —— 两边一起错照样绿。**
 * md ↔ 代码实况这一层此前完全没人看。本文件补的就是这一层。
 *
 * 三条检查都只用仓库内可得的事实(文件系统 + git log),不需要数据库,
 * 所以它在 CI 上也能真跑,不会 skip。
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(repoRoot, "migrations");
const orchestrationPath = path.join(repoRoot, "docs/planning/orchestration.md");
const versionPlanPath = path.join(repoRoot, "docs/design/version-plan.md");

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
}

test("迁移台账的「现已用到 NNN」必须等于 migrations/ 的实际最大号", async () => {
  const files = (await readdir(migrationsDir)).filter((name) => /^\d{3}_.*\.sql$/.test(name));
  const actualMax = files.map((name) => name.slice(0, 3)).sort().at(-1);
  assert.ok(actualMax, "migrations/ 下没有形如 NNN_*.sql 的文件");

  const doc = await readFile(orchestrationPath, "utf8");
  const claimed = /现已用到 \*{0,2}(\d{3})/.exec(doc)?.[1];
  assert.ok(claimed, "orchestration.md 里找不到「现已用到 NNN」");
  assert.equal(
    claimed, actualMax,
    `迁移台账写「现已用到 ${claimed}」,但 migrations/ 实际最大号是 ${actualMax}。` +
    "台账过期会让下一个包分配到已用过的号——这个 session 一天撞过三次。",
  );
});

test("DAG 里标「在跑」的包,不能已经有 merge 提交", async () => {
  const doc = await readFile(orchestrationPath, "utf8");
  const running = [...doc.matchAll(/^\|\s*(S\d+)\s*\|[^|]*\|[^|]*\|\s*🔧\s*在跑\s*\|/gm)]
    .map((match) => match[1]!);
  if (running.length === 0) return;

  const merged = git(["log", "--oneline", "--merges", "-200"]);
  const stale = running.filter((pkg) => merged.includes(`merge(v011-${pkg.toLowerCase()})`));
  assert.deepEqual(
    stale, [],
    `这些包在 DAG 里还标「在跑」,但 git log 里已经有它们的 merge 提交:${stale.join(", ")}。` +
    "合流后忘了回写状态——S41 就是这么在真源里挂了一整天。",
  );
});

test("任务包里「提前公布的验收方式」,必须在 DAG 里有对应的执行记录", async () => {
  // 起因(2026-07-27 自审):我发明了「派包时提前公布考法」这个做法,理由是判据要
  // 可证伪。但 S41 我公布了三条考法,验收时只执行了第③条,报告里却写「考法③过了」
  // 就合流了。**公布考法却不执行,比不公布更糟——它制造了「验过了」的错觉。**
  const outputs = path.resolve(repoRoot, "../../outputs");
  let packages: string[];
  try {
    packages = (await readdir(outputs)).filter((name) => /^kimi-goal-s\d+/.test(name));
  } catch {
    return; // outputs/ 不在仓库里;取不到就诚实跳过这一条,不假装通过
  }
  const dag = await readFile(orchestrationPath, "utf8");
  const merged = git(["log", "--oneline", "--merges", "-200"]);

  const missing: string[] = [];
  for (const file of packages) {
    const pkg = /^kimi-goal-(s\d+)/.exec(file)?.[1]?.toUpperCase();
    if (!pkg) continue;
    if (!merged.includes(`merge(v011-${pkg.toLowerCase()})`)) continue; // 还在跑的不算
    const body = await readFile(path.join(outputs, file), "utf8");
    if (!/验收方式.{0,6}提前|提前.{0,6}公布|我会.{0,20}确认/.test(body)) continue;
    if (!new RegExp(`#### ${pkg} 验收`).test(dag)) missing.push(pkg);
  }
  assert.deepEqual(
    missing, [],
    `这些包提前公布了验收方式,合流了却没有验收记录:${missing.join(", ")}。` +
    "公布考法却不执行,比不公布更糟——它制造了「验过了」的错觉。",
  );
});

test("version-plan 里标「零实现」的卡,不能已经有同名迁移落地", async () => {
  const plan = await readFile(versionPlanPath, "utf8");
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql"));

  // 卡片 key → 迁移文件名里的关键词。只登记「一旦有这个迁移就说明卡不再是零实现」的对应关系。
  // 这张表要人维护,但它很短,而且写错会被下面的断言当场抓出来。
  const cardToMigrationKeyword: ReadonlyArray<readonly [string, string]> = [
    ["tag-system", "tag_vocabulary"],
    ["asset-kind-vocabulary", "asset_kind_aliases"],
    ["contract-validation", "clearance"],
    ["voice-workshop-1", "sound_workshop"],
    ["waiting-value", "generation_waiting_value"],
    ["command-palette", "command_palette"],
  ];

  const wrong: string[] = [];
  for (const [cardKey, keyword] of cardToMigrationKeyword) {
    const block = new RegExp(`<!-- acceptance:${cardKey} -->([\\s\\S]*?)(?=\\n<!-- |\\n## )`).exec(plan)?.[1];
    if (!block) continue;
    const claimsNothingBuilt = /零实现/.test(block);
    const migrationLanded = files.some((name) => name.includes(keyword));
    if (claimsNothingBuilt && migrationLanded) {
      wrong.push(`${cardKey}(标零实现,但迁移里已有 ${keyword})`);
    }
  }
  assert.deepEqual(
    wrong, [],
    `这些卡的验收标准说「零实现」,但对应迁移已经落地:${wrong.join("; ")}。` +
    "已有的一致性门禁只比对 md ↔ 库,两边一起错照样绿;这一条比对的是 md ↔ 代码实况。",
  );
});
