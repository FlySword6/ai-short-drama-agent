import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findUngatedDbSuites, readCoverageInput } from "./check-ci-db-coverage.mjs";

/**
 * #284：`package.json` 的 `test` 链里有 6 个 `test:*-db` 在 CI 上一次都没跑过。
 *
 * 只补 6 行 yaml 是治标——下一个人加第 18 个套件时照样会忘，而且照样没人发现。
 * 这里立的守卫断的是：**`test` 链里每出现一个 `test:*-db`，`ci.yml` 里必须有一个
 * 带 `if: github.event_name == 'pull_request'` 的 job 跑它**。
 *
 * 为什么判据是「PR 闸」而不是「在不在 ci.yml 里」：往 `verify-postgres`
 * （`push` 到 dev 才触发的那个 job）里追加一行，看着像加了 CI，实际是合进去
 * 之后才跑——等于没加闸。守卫必须把这种加法也判红。
 */

/**
 * 真 workflow 都有 `on:`,fixture 也得有——没有 `on:` 就没有「在 PR 上跑」这回事,
 * 守卫按「读不出触发器就判不是闸」处理。
 */
const ON_PULL_REQUEST = `on:
  pull_request:
  push:
    branches:
      - dev
`;

const PR_GATED_JOB = `${ON_PULL_REQUEST}
jobs:
  verify-real-postgres:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - name: Test real PostgreSQL path
        run: npm run test:real-db
`;

function packageJsonWith(...dbSuites: readonly string[]) {
  const scripts: Record<string, string> = { "test:node": "node --test" };
  for (const suite of dbSuites) {
    scripts[suite] = `bash scripts/run-${suite.replace(/^test:/, "")}.sh`;
  }
  scripts.test = ["npm run test:node", ...dbSuites.map((s) => `npm run ${s}`)].join(" && ");
  return { scripts };
}

/** `verify-postgres` 的真实形状：只在 push 到 dev 时触发，一个 job 串多个套件。 */
const DEV_PUSH_ONLY_JOB = `
    if: github.event_name == 'push' && github.ref == 'refs/heads/dev'
    runs-on: ubuntu-latest
    steps:
      - name: Test fake PostgreSQL path
        run: npm run test:fake-db
`;

test("套件在 test 链里但 ci.yml 里没有任何 job 跑它——判红", () => {
  const packageJson = packageJsonWith("test:real-db", "test:fake-db");

  assert.deepEqual(findUngatedDbSuites({ packageJson, workflows: [PR_GATED_JOB] }), [
    "test:fake-db",
  ]);
});

test("套件只出现在 push-to-dev 的 job 里——照样判红，那不是闸", () => {
  const packageJson = packageJsonWith("test:real-db", "test:fake-db");
  const workflow = `${PR_GATED_JOB}  verify-postgres:${DEV_PUSH_ONLY_JOB}`;

  assert.deepEqual(findUngatedDbSuites({ packageJson, workflows: [workflow] }), ["test:fake-db"]);
});

/**
 * 上面两条用内存 fixture 锁判据；这条拿真文件跑。
 * 少了它，判据全绿而真实接线断掉（读错路径、`test` 链改了形状）不会有任何信号——
 * 那正是 #284 本身的病：两边都没有信号说「这一批在 CI 上是空的」。
 */
test("真仓：test 链里的每个 test:*-db 都在 PR 闸上", () => {
  // 走 readCoverageInput,不手抄一遍读盘逻辑——手抄的话,这条测试声称能挡住的
  // 「读错路径」恰恰发生在从没被执行过的那份代码里。
  const repoRoot = new URL("../", import.meta.url);
  const input = readCoverageInput(
    fileURLToPath(new URL("package.json", repoRoot)),
    fileURLToPath(new URL(".github/workflows/", repoRoot)),
  );

  assert.ok(input.workflows.length > 0, "没有读到任何 workflow 文件");
  assert.deepEqual(findUngatedDbSuites(input), []);
});

/**
 * 产品负责人 2026-08-11 拍板：`verify-postgres` 里那 7 个 dev-only 套件先不搬成
 * PR 闸（每个 PR 多起 7 个 postgres 容器，要拿开发机的耗时/失败率数据再权衡）。
 *
 * 于是判据分两档：豁免名单上的套件只要还在 ci.yml 里跑就行；不在名单上的必须上 PR 闸。
 * 豁免**不是**「不用管」——名单上的套件从 ci.yml 里整个消失，照样要红。
 */
test("豁免名单上的套件：只在 push-to-dev 的 job 里跑，放行", () => {
  const packageJson = packageJsonWith("test:real-db", "test:legacy-db");
  const workflow = `${PR_GATED_JOB}  verify-postgres:${DEV_PUSH_ONLY_JOB.replace("test:fake-db", "test:legacy-db")}`;

  assert.deepEqual(
    findUngatedDbSuites({ packageJson, workflows: [workflow], devOnlyExemptions: ["test:legacy-db"] }),
    [],
  );
});

test("豁免名单上的套件：ci.yml 里哪儿都不跑，仍然判红", () => {
  const packageJson = packageJsonWith("test:real-db", "test:legacy-db");

  assert.deepEqual(
    findUngatedDbSuites({
      packageJson,
      workflows: [PR_GATED_JOB],
      devOnlyExemptions: ["test:legacy-db"],
    }),
    ["test:legacy-db"],
  );
});

/**
 * 「job 在 PR 上跑」不等于「那一步在 PR 上跑」。
 * 步骤级 `if:` 是把套件挂进 PR job 却仍然不上闸的第三种加法——
 * 与「只往 verify-postgres 加一行」同源，守卫必须一并判红，否则它自己就是下一个假绿。
 */
test("套件挂在 PR job 里，但那一步被步骤级 if 排除了 PR——判红", () => {
  const packageJson = packageJsonWith("test:real-db", "test:fake-db");
  const workflow = `${ON_PULL_REQUEST}
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Test real PostgreSQL path
        run: npm run test:real-db
      - name: Test fake PostgreSQL path
        if: github.event_name == 'push'
        run: npm run test:fake-db
`;

  assert.deepEqual(findUngatedDbSuites({ packageJson, workflows: [workflow] }), ["test:fake-db"]);
});

/**
 * 门禁不该只盯 `ci.yml`。套件在别的 workflow 文件里上了 PR 闸,一样算上了闸;
 * 只盯一个文件会误报红,而误报红会让人学会忽略这条门禁——门禁被忽略就等于没有。
 */
test("套件在另一个 workflow 文件里上了 PR 闸——不算漏", () => {
  const packageJson = packageJsonWith("test:real-db", "test:other-db");
  const otherWorkflow = `${ON_PULL_REQUEST}
jobs:
  e2e-postgres:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - name: Test other real PostgreSQL path
        run: npm run test:other-db
`;

  assert.deepEqual(
    findUngatedDbSuites({ packageJson, workflows: [PR_GATED_JOB, otherWorkflow] }),
    [],
  );
});

/**
 * 判据要能在 CI 之外直接跑:改 `ci.yml` 的人应当能当场问一句「我这样加算不算上闸」,
 * 而不是推上去等 CI 告诉他。所以除了测试,还要有一个带退出码和指名报错的命令行入口。
 *
 * 入口收两个位置参数(package.json 路径、workflows 目录),变异验证靠它跑在临时目录上,
 * 不动真文件。
 */
function runGuard(
  packageJson: unknown,
  workflows: Readonly<Record<string, string>>,
  entry = fileURLToPath(new URL("check-ci-db-coverage.mts", import.meta.url)),
) {
  const dir = mkdtempSync(join(tmpdir(), "ci-db-coverage-"));
  const workflowsDir = join(dir, "workflows");
  mkdirSync(workflowsDir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson));
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(workflowsDir, name), body);
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", entry, join(dir, "package.json"), workflowsDir],
    { encoding: "utf8" },
  );
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("命令行入口:全部套件都上了 PR 闸时 exit 0", () => {
  const { status } = runGuard(packageJsonWith("test:real-db"), { "ci.yml": PR_GATED_JOB });

  assert.equal(status, 0);
});

test("命令行入口:有套件没上 PR 闸时 exit 1,并指名是哪个", () => {
  const { status, output } = runGuard(packageJsonWith("test:real-db", "test:fake-db"), {
    "ci.yml": `${PR_GATED_JOB}  verify-postgres:${DEV_PUSH_ONLY_JOB}`,
  });

  assert.equal(status, 1);
  assert.match(output, /test:fake-db/u);
});

/**
 * job 级 `if:` 只是第二道条件,第一道是 workflow 自己的 `on:`。
 * 一个不写 `if:` 的 job,在只有 `schedule` 的 workflow 里根本不会因为 PR 而跑——
 * 判它「在 PR 闸上」就是假绿。
 *
 * 这个洞是「扫全部 workflow 文件」带出来的:只读 `ci.yml` 时它有 `pull_request` 触发器,
 * 前提隐含成立;扫到别的文件,前提就没了。判据必须把这一道也判。
 */
test("套件在只有 schedule 触发的 workflow 里——判红,那不是 PR 闸", () => {
  const packageJson = packageJsonWith("test:real-db", "test:nightly-db");
  const nightly = `
name: nightly
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  nightly-db:
    runs-on: ubuntu-latest
    steps:
      - name: Test nightly PostgreSQL
        run: npm run test:nightly-db
`;

  assert.deepEqual(findUngatedDbSuites({ packageJson, workflows: [PR_GATED_JOB, nightly] }), [
    "test:nightly-db",
  ]);
});

/**
 * 主入口靠比对 `process.argv[1]` 与自身路径来判断「是不是被直接跑的」。
 * `resolve()` 不解符号链接,于是经软链调用时两边对不上,入口整个不执行——
 * **静默 exit 0、零输出**。门禁失效得毫无声响,比判错更糟。
 */
test("命令行入口:经符号链接调用,照样要判红", () => {
  const link = join(mkdtempSync(join(tmpdir(), "ci-db-coverage-link-")), "guard.mts");
  symlinkSync(fileURLToPath(new URL("check-ci-db-coverage.mts", import.meta.url)), link);

  const { status, output } = runGuard(
    packageJsonWith("test:real-db", "test:fake-db"),
    { "ci.yml": `${PR_GATED_JOB}  verify-postgres:${DEV_PUSH_ONLY_JOB}` },
    link,
  );

  assert.equal(status, 1);
  assert.match(output, /test:fake-db/u);
});
