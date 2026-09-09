import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * 护栏:统筹台账的 R 编号不能重复。
 *
 * 起因(三次撞号,一次比一次贵):
 * 1. 2026-07-30:设计专线与 Fable 并行写 orchestration,R95–R99 **五个编号**同时撞,
 *    Fable 侧被迫改编为 R104–R108。当时立的规矩写进交接书:「R 编号由 Fable 单写,
 *    其他专线不直接写 orchestration」。
 * 2. 2026-08-05 上午:又一条线在旧水位上取号,写了第二个 R209。
 * 3. 2026-08-05 下午:改号避让后又撞第二个 R210,最终定为 R210a。
 *
 * **纪律立了三次没守住,说明它不该只是纪律。** 根因是并发写同一个文件、编号靠人取——
 * 写的人各自都没错,是机制缺判据。这个文件把「编号唯一」变成机器判据,写重了当场红,
 * 点名到行号。同 doc-terminology.test.ts 的做法。
 *
 * 只读文件系统,不连数据库,CI 上能真跑,不会 skip。
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const ledgerPath = path.join(repoRoot, "docs/planning/orchestration.md");

/**
 * 台账里 R 编号有两种写法,是同一套连号,必须一起查重:
 * - 小节标题:`## R210a(2026-08-05 …)`
 * - 收件箱表格行:`| R29 | 遐想:… |`
 *
 * 后缀字母(R207a/R210a)是**同号补记**的合法写法,与正号是不同条目,各自参与查重。
 * 归档件(orchestration-archive-*.md)不纳入:它记的是当时怎么编的,回头改反而失真。
 */
const HEADING_ID = /^## (R\d+[a-z]?)\(/;
const TABLE_ROW_ID = /^\| (R\d+[a-z]?) \|/;

test("统筹台账:R 编号不能重复", async () => {
  const raw = await readFile(ledgerPath, "utf8");
  const seen = new Map<string, number[]>();

  raw.split("\n").forEach((line, index) => {
    const id = line.match(HEADING_ID)?.[1] ?? line.match(TABLE_ROW_ID)?.[1];
    if (!id) return;
    const lines = seen.get(id) ?? [];
    lines.push(index + 1);
    seen.set(id, lines);
  });

  assert.ok(seen.size > 0, `${ledgerPath} 里一个 R 编号都没扫到,正则可能与台账格式脱节了`);

  const duplicates = [...seen.entries()].filter(([, lines]) => lines.length > 1);
  assert.deepEqual(
    duplicates,
    [],
    duplicates
      .map(([id, lines]) => `${id} 出现 ${lines.length} 次(行 ${lines.join("、")})`)
      .join(";") +
      "\n取号前先 `git fetch` 看远端最大号;确实要补记同一条,用字母后缀(如 R210a)。",
  );
});
