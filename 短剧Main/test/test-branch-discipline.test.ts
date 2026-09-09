import assert from "node:assert/strict";
import test from "node:test";

import { findViolations, EXEMPT_COMMITS } from "../scripts/check-test-branch-discipline.mts";

/**
 * 护栏:`test` 分支不接受原生提交。
 *
 * 判据出处:docs/adr/0004-test-branch-downstream-only.md(2026-08-12 DC 拍板)。
 *
 * 起因:盘点发现 origin/test 相对 origin/dev 多出 9 个 CI/构建提交,直接改在
 * test 上没回流 dev,而同期 dev 反向领先 28 个 —— 两条线互不为超集。这不是
 * 一次手滑:43f378c7 夹在两次 `Merge dev into test` 中间,是常规动作。当事人
 * 并不觉得自己在违规,因为从来没有一条规矩说过不行。
 *
 * 所以这道门禁的作用不是抓坏人,是**让规矩存在**。
 *
 * 为什么判据是 `git cherry` 而不是「SHA 在 dev 可达」:
 * ADR 允许的 hotfix 路径是「在 dev 上修,再 cherry-pick 到 test」——
 * cherry-pick 会产生新 SHA,按可达性判会误杀。patch 等价判则正好放行,
 * 同时仍然保证 dev 是超集。`git cherry` 还会自动跳过 merge 提交,
 * 所以「只允许 Merge dev into test」这半条不用另写逻辑。
 */

/** git cherry 的真实输出长这样,前缀 `+` 是 dev 上没有等价补丁的。 */
const line = (mark: "+" | "-", sha: string) => `${mark} ${sha}`;

const SHA_A = "3405625b8a2371fc6f3ad7bae61ee83310488061";
const SHA_B = "5136f7c389e0a39d7acc15eac70e41cd62954c81";
const SHA_EXEMPT = "43a8e3cb5e9508a5565e7e14d15efa4423084a80";

test("dev 上有等价补丁的提交不算违规", () => {
  const out = [line("-", SHA_A), line("-", SHA_B)].join("\n");
  assert.deepEqual(findViolations(out, []).violations, []);
});

test("dev 上没有等价补丁的提交算违规", () => {
  const out = [line("+", SHA_A), line("-", SHA_B)].join("\n");
  assert.deepEqual(findViolations(out, []).violations, [SHA_A]);
});

test("豁免名单里的提交放行", () => {
  const out = [line("+", SHA_EXEMPT), line("+", SHA_A)].join("\n");
  assert.deepEqual(findViolations(out, [SHA_EXEMPT]).violations, [SHA_A]);
});

test("豁免可以写短 SHA", () => {
  const out = line("+", SHA_EXEMPT);
  assert.deepEqual(findViolations(out, ["43a8e3cb"]).violations, []);
});

test("空输出等于全绿", () => {
  assert.deepEqual(findViolations("", []).violations, []);
  assert.deepEqual(findViolations("\n  \n", []).violations, []);
});

/**
 * 陈旧豁免要报出来。对齐 doc-terminology.test.ts 的 staleMarkers 思路:
 * 豁免留着不清,下一个人就不知道哪些还作数。这里只提示,不判红 ——
 * 门禁一旦开始误报,大家就会条件反射地加豁免,那这道门就废了。
 */
test("豁免了但当前没出现的提交,报成陈旧豁免", () => {
  const result = findViolations(line("+", SHA_A), [SHA_EXEMPT]);
  assert.deepEqual(result.violations, [SHA_A]);
  assert.deepEqual(result.staleExemptions, [SHA_EXEMPT]);
});

test("git cherry 里被跳过的 merge 提交不会进结果", () => {
  // git cherry 本身就不输出 merge 提交,这里固定住这个依赖 ——
  // 哪天换了判据命令,这条会提醒你「只允许 merge」那半条逻辑没人管了。
  const out = [line("-", SHA_A)].join("\n");
  const result = findViolations(out, []);
  assert.deepEqual(result.violations, []);
  assert.equal(result.inspected, 1);
});

test("内置豁免名单只放行 v0.2.2 那个空提交", () => {
  // ADR-0004:历史不追认。但豁免只该有这一条,多一条都要有 ADR 依据。
  assert.deepEqual([...EXEMPT_COMMITS], [SHA_EXEMPT]);
});
