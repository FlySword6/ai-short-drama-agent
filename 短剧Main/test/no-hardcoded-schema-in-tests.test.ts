import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

/**
 * 护栏:测试断言里不许写死 schema 名。
 *
 * 起因(2026-07-26):`src/modules/director/scene/repository.test.ts` 和
 * `src/modules/dashboard/repository.visibility.test.ts` 把 `common\.` 写死进断言
 * 正则。本机 `.env` 恰好也写着 `POSTGRES_SCHEMA=common`,于是门禁长期全绿——
 * 直到把 `.env` 改回规范值 `app`,5 项当场变红。
 *
 * 也就是说:那 5 项测试实际校验的是**开发者本机 .env 的内容**,不是代码行为。
 * 这比"测试没写"更坏,因为它给了一个假的绿灯。
 *
 * 正确写法是从 `settings.postgresSchema` 取值再构造断言——那样断言的是
 * 「查询被当前配置的 schema 限定了」这个真不变量,换 schema 也该绿。
 *
 * 例外:ETL 的活儿就是读他们的 `common`,那里出现 `common.` 是本分。
 */

const repoRoot = path.resolve(import.meta.dirname, "..");

/** ETL 以 `common` 为输入,它的测试里出现 schema 名是正当的。 */
const exemptPrefixes = [
  "test/legacy-merge-etl/",
  "scripts/legacy-merge-etl/",
];

function listTestFiles(): string[] {
  const out = execFileSync("rg", ["--files", "-g", "*.test.ts", "-g", "!node_modules"], {
    cwd: repoRoot, encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

test("测试断言里不许写死 schema 名(否则校验的是本机 .env 而不是代码)", async () => {
  const files = listTestFiles().filter(
    (file) => !exemptPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  assert.ok(files.length > 100, `测试文件只扫到 ${files.length} 个,rg 过滤大概写错了`);

  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    source.split("\n").forEach((line, index) => {
      // 注释里可以谈论这件事(比如本文件和被修的那两个文件的说明注释)。
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      // `common.` / `common\.` / `"common".` —— 都是把 schema 名钉死在断言里。
      if (/\bcommon\\?\.|"common"\\?\./.test(code)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(offenders, [],
    "这些行把 schema 名写死了,改成从 settings.postgresSchema 取:\n" + offenders.join("\n"));
});
