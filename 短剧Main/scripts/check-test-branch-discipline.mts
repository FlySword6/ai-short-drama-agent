#!/usr/bin/env node
/**
 * `test` 分支纪律门禁。判据出处:docs/adr/0004-test-branch-downstream-only.md
 *
 * 规矩:`test` 是 `dev` 的纯下游,`dev` 在 patch 层面恒为超集。
 *
 * 判据用 `git cherry origin/dev origin/test`,不用「SHA 在 dev 可达」:
 *
 *   - ADR 允许的 hotfix 路径是「在 dev 上修,再 cherry-pick 到 test」。
 *     cherry-pick 产生新 SHA,按可达性判会误杀;按 patch 等价判正好放行,
 *     同时仍然保证 dev 是超集。
 *   - `git cherry` 自动跳过 merge 提交,所以「正常只允许 Merge dev into test」
 *     那半条不用另写逻辑 —— merge 根本不会进候选。
 *
 * 输出前缀:`+` = dev 上没有等价补丁(违规),`-` = 有(放行)。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 历史豁免。ADR-0004 定的是「规矩管以后,不追认过去」,所以门禁上线那天
 * test 上已有的原生提交要放行 —— 但只放行**有 ADR 依据**的那些。
 *
 * 这里只有一条:`43a8e3cb` 是 `release(test): v0.2.2` 空提交(`git show --stat`
 * 列不出任何文件),当时用来给 v0.2.2 tag 找一个可以指向的提交。ADR 同时定了
 * 「不再造 release(test) 空提交,发版 tag 直接打在对应 merge 提交上」,
 * 所以这条豁免是一次性的,不会再长。
 *
 * 那 9 个 CI/构建提交**不在**豁免里 —— 它们要 cherry-pick 回 dev,
 * 回流之后 `git cherry` 自然判 `-`,门禁自己就绿了。
 *
 * 加豁免必须先有 ADR。名单变长就是这道门在废掉的信号。
 */
export const EXEMPT_COMMITS: readonly string[] = ["43a8e3cb5e9508a5565e7e14d15efa4423084a80"];

export interface DisciplineResult {
  /** dev 上没有等价补丁的提交,按 git cherry 的输出顺序。 */
  readonly violations: readonly string[];
  /** 豁免名单里写了、但这次没出现的 —— 提示该清,不判红。 */
  readonly staleExemptions: readonly string[];
  /** 实际检查了几个提交。为 0 时说明门禁在空转,调用方要自己判。 */
  readonly inspected: number;
}

/** 豁免允许写短 SHA,按前缀匹配 —— 人手写名单时不必贴 40 位。 */
function isExempt(sha: string, exemptions: readonly string[]): boolean {
  return exemptions.some((prefix) => sha.startsWith(prefix));
}

export function findViolations(
  cherryOutput: string,
  exemptions: readonly string[] = EXEMPT_COMMITS,
): DisciplineResult {
  const entries = cherryOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [mark, sha] = line.split(/\s+/, 2);
      return { mark, sha: sha ?? "" };
    })
    .filter((entry) => entry.sha.length > 0);

  const violations = entries
    .filter((entry) => entry.mark === "+" && !isExempt(entry.sha, exemptions))
    .map((entry) => entry.sha);

  const staleExemptions = exemptions.filter(
    (prefix) => !entries.some((entry) => entry.sha.startsWith(prefix)),
  );

  return { violations, staleExemptions, inspected: entries.length };
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { encoding: "utf8" });
}

function describe(sha: string): string {
  try {
    return git(["log", "-1", "--pretty=%h %s", sha]).trim();
  } catch {
    return sha;
  }
}

function main(): void {
  // 写死这一对:ADR-0004 只定了 dev 与 test 的关系,门禁就只管这一对。
  // 做成可配置等于给「改个参数绕过去」留口子。
  const base = "origin/dev";
  const head = "origin/test";

  for (const ref of [base, head]) {
    try {
      git(["rev-parse", "--verify", `${ref}^{commit}`]);
    } catch {
      console.error(`[test-branch-discipline] 取不到 ${ref}。CI 里要先 fetch 到这两个 ref 再跑。`);
      process.exit(2);
    }
  }

  const result = findViolations(git(["cherry", base, head]));

  if (result.staleExemptions.length > 0) {
    console.warn(
      `[test-branch-discipline] 豁免名单有 ${result.staleExemptions.length} 条已经用不上了,` +
        `可以从 EXEMPT_COMMITS 里删掉:\n  ${result.staleExemptions.join("\n  ")}`,
    );
  }

  if (result.violations.length === 0) {
    console.log(
      `[test-branch-discipline] 通过。检查了 ${result.inspected} 个提交,${head} 没有 ${base} 之外的原生改动。`,
    );
    return;
  }

  console.error(
    `[test-branch-discipline] ${head} 上有 ${result.violations.length} 个提交在 ${base} 上没有等价补丁:\n` +
      result.violations.map((sha) => `  ${describe(sha)}`).join("\n") +
      "\n\n" +
      `${head} 是 ${base} 的纯下游,${base} 必须在 patch 层面恒为超集。\n` +
      "怎么办:\n" +
      `  1. 把上面这些提交 cherry-pick 回 ${base},走正常 PR 合进去;\n` +
      `  2. 回流之后 git cherry 会判它们为 \`-\`,这道门自己就绿了;\n` +
      `  3. 如果这是 hotfix,正确做法是先在 ${base} 上修,再 cherry-pick 到 ${head}——反过来不行。\n\n` +
      "判据出处:docs/adr/0004-test-branch-downstream-only.md\n" +
      "自己复跑:git cherry origin/dev origin/test",
  );
  process.exit(1);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
