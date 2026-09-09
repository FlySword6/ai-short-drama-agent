#!/usr/bin/env -S node --import tsx
/**
 * check-ci-db-coverage —— 数据库测试套件的 PR 闸覆盖门禁（#284）。
 *
 * `package.json` 的 `test` 链里每出现一个 `test:*-db`，`.github/workflows/` 下
 * 必须有一个 PR 触发的 job 跑它。对不上就红。
 *
 * 两个入口，同一份判据：
 * - 门禁：同目录的 `check-ci-db-coverage.test.ts` 进 `npm run test:node`，
 *   而 `test:node` 跑在 `verify` job 里（那个 job 没写 `if:`，PR 上照跑）。
 * - 命令行：`npm run check:ci-db-coverage`，给改 `ci.yml` 的人当场问一句
 *   「我这样加算不算上闸」，不用推上去等 CI 回答。
 *
 * 用法：check-ci-db-coverage.mts [package.json 路径] [workflows 目录]
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 产品负责人 2026-08-11 拍板暂不搬成 PR 闸的 dev-only 套件。
 *
 * 它们只在 `verify-postgres`（push 到 dev 才触发）里跑,也就是**合进去之后才跑**。
 * 搬成 PR 闸等于每个 PR 多起 7 个 postgres 容器,是拿 CI 时长换提前发现,
 * 要先在 Linux 开发机上收集耗时与失败率再权衡。
 *
 * 这份名单是**显式豁免,不是默认放行**:名单外的新套件一律要 PR 闸,
 * 名单上的套件从 ci.yml 里整个消失也照样红。要退役这份名单就整条删掉。
 */
export const DEV_ONLY_EXEMPTIONS: readonly string[] = [
  "test:s67-db",
  "test:s84-db",
  "test:seed-audio-db",
  "test:object-context-db",
  "test:asset-usage-db",
  "test:agent-credential-source-db",
  "test:auth-single-active-session-db",
];

export interface CiDbCoverageInput {
  readonly packageJson: { readonly scripts?: Readonly<Record<string, string>> };
  /** `.github/workflows/` 下每个文件的原文。只盯 `ci.yml` 会对别处的闸误报红。 */
  readonly workflows: readonly string[];
  readonly devOnlyExemptions?: readonly string[];
}

/** `package.json` 的 `test` 链里串起来的 `test:*-db` 套件，按出现顺序。 */
export function dbSuitesInTestChain(packageJson: CiDbCoverageInput["packageJson"]): string[] {
  const chain = packageJson.scripts?.test ?? "";
  return chain
    .split("&&")
    .map((segment) => segment.trim().replace(/^npm run /, ""))
    .filter((script) => /^test:[a-z0-9-]+-db$/.test(script));
}

/**
 * workflow 自己的 `on:` 里有没有 `pull_request`。
 *
 * 这是第一道条件,job 级 `if:` 是第二道。一个不写 `if:` 的 job,在只有 `schedule`
 * 的 workflow 里根本不会因为 PR 而跑——两道都过才算 PR 闸。
 *
 * 没写 `on:` 就判定不触发:门禁要往关的方向失败,不能因为读不出来就放行。
 */
function triggersPullRequest(workflow: string): boolean {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => /^on:/.test(line));
  if (start < 0) return false;

  // `on: pull_request` 或 `on: [push, pull_request]` 写在同一行。
  const inline = lines[start].slice(3).trim();
  if (inline !== "") return /(^|[[,\s])pull_request($|[\],\s])/.test(inline);

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break; // 缩进退回顶层,`on:` 段结束
    if (/^ {2}pull_request:/.test(line)) return true;
    if (/^ {4}- pull_request$/.test(line)) return true; // `on:\n  - push\n  - pull_request`
  }
  return false;
}

interface WorkflowJob {
  readonly name: string;
  /** job 级 `if:` 的原文；没写 `if:` 时为 null（= 该 workflow 的所有触发事件都跑）。 */
  readonly condition: string | null;
  readonly body: string;
}

/**
 * 只认 `jobs:` 下两格缩进的 job 名与四格缩进的 job 级 `if:`——ci.yml 的实际形状。
 * 不引 YAML 依赖：这里要判的结构就这两层，判据本身由本文件的测试锁住。
 */
function parseJobs(ciWorkflow: string): WorkflowJob[] {
  const lines = ciWorkflow.split("\n");
  const jobs: WorkflowJob[] = [];
  let current: { name: string; condition: string | null; lines: string[] } | null = null;

  const flush = () => {
    if (current) {
      jobs.push({ name: current.name, condition: current.condition, body: current.lines.join("\n") });
    }
  };

  for (const line of lines) {
    const jobStart = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobStart) {
      flush();
      current = { name: jobStart[1], condition: null, lines: [] };
      continue;
    }
    if (!current) continue;
    // 缩进退回顶层（如 `on:` / `permissions:`）说明 jobs 段结束。
    if (line.trim() !== "" && !line.startsWith("  ")) {
      flush();
      current = null;
      continue;
    }
    const jobCondition = /^ {4}if:\s*(.+?)\s*$/.exec(line);
    if (jobCondition && current.condition === null) {
      current = { ...current, condition: jobCondition[1] };
    }
    current.lines.push(line);
  }
  flush();

  return jobs;
}

interface WorkflowStep {
  readonly condition: string | null;
  readonly body: string;
}

/** 每个 step 自己的 `if:` 要单独拿出来:job 在 PR 上跑不等于那一步在 PR 上跑。 */
function parseSteps(jobBody: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let current: { condition: string | null; lines: string[] } | null = null;

  const flush = () => {
    if (current) steps.push({ condition: current.condition, body: current.lines.join("\n") });
  };

  for (const line of jobBody.split("\n")) {
    if (/^ {6}- /.test(line)) {
      flush();
      current = { condition: null, lines: [] };
    }
    if (!current) continue;
    const stepCondition = /^ {6}(?:- )?if:\s*(.+?)\s*$/.exec(line) ?? /^ {8}if:\s*(.+?)\s*$/.exec(line);
    if (stepCondition && current.condition === null) current.condition = stepCondition[1];
    current.lines.push(line);
  }
  flush();

  return steps;
}

/**
 * 该条件下会不会在 PR 上跑。
 *
 * 没写 `if:`（如 `verify` job）在 PR 上照跑，算闸；
 * 显式要求 `github.event_name == 'pull_request'` 的算闸；
 * 其余（典型是 `push` + `refs/heads/dev`）都不算——那是合进去之后才跑。
 *
 * job 级与 step 级同一把尺子：**挂进 PR job、却给那一步单加 `if: push`**，
 * 与「只往 verify-postgres 加一行」是同一种加法，同样不算闸。
 */
function runsOnPullRequest(condition: string | null): boolean {
  if (condition === null) return true;
  return /github\.event_name\s*==\s*['"]pull_request['"]/.test(condition);
}

function stepInvokesSuite(step: WorkflowStep, suite: string): boolean {
  const escaped = suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`npm run ${escaped}(?![a-z0-9-])`).test(step.body);
}

/** 不问触发条件——豁免名单只要求「还在 CI 里跑」,不要求在 PR 上跑。 */
function jobInvokesSuite(job: WorkflowJob, suite: string): boolean {
  return parseSteps(job.body).some((step) => stepInvokesSuite(step, suite));
}

/** 套件在这个 job 里、且真的会在 PR 上跑：job 与 step 两级条件都得放行。 */
function jobGatesSuiteOnPullRequest(job: WorkflowJob, suite: string): boolean {
  if (!runsOnPullRequest(job.condition)) return false;
  return parseSteps(job.body).some(
    (step) => stepInvokesSuite(step, suite) && runsOnPullRequest(step.condition),
  );
}

/** 没有被 PR 闸覆盖的套件。空数组即通过。 */
export function findUngatedDbSuites({
  packageJson,
  workflows,
  devOnlyExemptions = DEV_ONLY_EXEMPTIONS,
}: CiDbCoverageInput): string[] {
  const allJobs = workflows.flatMap(parseJobs);
  // PR 闸只可能出自「`on:` 里有 pull_request」的 workflow。
  const prWorkflowJobs = workflows.filter(triggersPullRequest).flatMap(parseJobs);

  return dbSuitesInTestChain(packageJson).filter((suite) => {
    // 豁免的只要求「还在 CI 里跑」,名单外的必须真的落在 PR 闸上。
    if (devOnlyExemptions.includes(suite)) {
      return !allJobs.some((job) => jobInvokesSuite(job, suite));
    }
    return !prWorkflowJobs.some((job) => jobGatesSuiteOnPullRequest(job, suite));
  });
}

export function readCoverageInput(packageJsonPath: string, workflowsDir: string): CiDbCoverageInput {
  const workflows = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => readFileSync(join(workflowsDir, name), "utf8"));

  return {
    packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")),
    workflows,
  };
}

/**
 * 是不是被当命令直接跑的（而不是被 import 的）。
 *
 * 必须用 `realpathSync` 解到真身：`resolve()` 不解符号链接，经软链调用时两边对不上，
 * 入口整个不执行——静默 exit 0、零输出。门禁无声失效比判错更糟，所以这里解不出来就
 * 退回原字符串比对，宁可多跑一次也不要不跑。
 */
function invokedAsCommand(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(entry) === real(fileURLToPath(import.meta.url));
}

if (invokedAsCommand()) {
  const packageJsonPath = process.argv[2] ?? "package.json";
  const workflowsDir = process.argv[3] ?? ".github/workflows";
  const input = readCoverageInput(packageJsonPath, workflowsDir);
  const suites = dbSuitesInTestChain(input.packageJson);

  if (suites.length === 0) {
    console.error(`check-ci-db-coverage: ${packageJsonPath} 的 test 链里没有 test:*-db 套件`);
    process.exit(1);
  }

  const ungated = findUngatedDbSuites(input);
  if (ungated.length > 0) {
    console.error(`check-ci-db-coverage: ${ungated.length} 个 test:*-db 套件没有 PR 闸:`);
    for (const suite of ungated) console.error(`  - ${suite}`);
    console.error(
      "每个套件都要有一个带 `if: github.event_name == 'pull_request'` 的 job 跑它。\n" +
        "只加进 verify-postgres(push 到 dev 才触发)不算——那是合进去之后才跑。",
    );
    process.exit(1);
  }

  // 不能笼统说「都在 PR 闸上」——豁免的那几个恰恰不在,那句话在一张
  // 讲「看着绿和真的绿是两回事」的卡里,自己就是一句假话。
  const exempt = suites.filter((suite) => DEV_ONLY_EXEMPTIONS.includes(suite));
  const gated = suites.length - exempt.length;
  console.log(
    `check-ci-db-coverage: ${suites.length} 个 test:*-db 套件合格——` +
      `${gated} 个在 PR 闸上,${exempt.length} 个按豁免名单只在 dev push 后跑`,
  );
}
