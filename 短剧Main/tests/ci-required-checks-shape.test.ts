import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const fastStart = workflow.indexOf("\n  verify:\n");
const opsP0Start = workflow.indexOf("\n  verify-ops-p0-postgres:\n");
const reviewGateStart = workflow.indexOf("\n  verify-reference-review-gate-postgres:\n");
const suchuangPricingStart = workflow.indexOf("\n  verify-suchuang-pricing-postgres:\n");
const tierSmokeStart = workflow.indexOf("\n  verify-tier-smoke-ledger-postgres:\n");
// #284 补的 6 个 PR 闸 job 排在 tier-smoke 与 verify-postgres 之间，
// 这里要拿第一个当边界，否则它们会被整段算进 tierSmokeJob。
const scriptBreakdownStart = workflow.indexOf("\n  verify-script-breakdown-postgres:\n");
const postgresStart = workflow.indexOf("\n  verify-postgres:\n");
const fastJob = workflow.slice(fastStart, opsP0Start);
const opsP0Job = workflow.slice(opsP0Start, reviewGateStart);
const reviewGateJob = workflow.slice(reviewGateStart, suchuangPricingStart);
const suchuangPricingJob = workflow.slice(suchuangPricingStart, tierSmokeStart);
const tierSmokeJob = workflow.slice(tierSmokeStart, scriptBreakdownStart);
const postgresJob = workflow.slice(postgresStart);

test("required checks keep the existing verify id as the PR and push fast lane", () => {
  assert.ok(fastStart >= 0, "missing backward-compatible verify job id");
  assert.ok(opsP0Start > fastStart, "missing issue #26 pull-request PostgreSQL job");
  assert.ok(reviewGateStart > opsP0Start, "missing issue #28 pull-request PostgreSQL job");
  assert.ok(suchuangPricingStart > reviewGateStart, "missing issue #157 pull-request PostgreSQL job");
  assert.ok(tierSmokeStart > suchuangPricingStart, "missing issue #150 pull-request PostgreSQL job");
  assert.ok(scriptBreakdownStart > tierSmokeStart, "missing #284 pull-request PostgreSQL jobs");
  assert.ok(postgresStart > scriptBreakdownStart, "missing independent verify-postgres job");
  assert.match(fastJob, /npm run test:node/);
  assert.doesNotMatch(fastJob, /run: npm test(?:\s|$)/);
  assert.match(fastJob, /npm run check:director-mirror/);
});

test("PostgreSQL wrappers run only for dev pushes and stay outside the fast lane", () => {
  assert.match(postgresJob, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev'/);
  for (const script of [
    "test:s67-db",
    "test:s84-db",
    "test:tier-smoke-ledger-db",
    "test:seed-audio-db",
    "test:object-context-db",
    "test:asset-usage-db",
    "test:reference-review-gate-db",
    "test:agent-credential-source-db",
    "test:auth-single-active-session-db",
    // #284 这 6 个上面各有一个 PR 闸 job，dev push 后在这里再跑一遍。
    // 只有 PR 闸不够：PR 各自绿不等于合起来绿。
    "test:script-breakdown-db",
    "test:asset-media-repair-db",
    "test:trash-retention-db",
    "test:generation-failed-list-db",
    "test:volc-asset-registration-db",
    "test:review-cross-tenant-authz-db",
  ]) {
    assert.match(postgresJob, new RegExp(`npm run ${script}`));
    assert.doesNotMatch(fastJob, new RegExp(`npm run ${script}`));
  }
  assert.doesNotMatch(postgresJob, /\n\s+needs:/);
});

test("#150 付费冒烟防重在 PR 独立执行真实 PostgreSQL", () => {
  assert.match(tierSmokeJob, /github\.event_name == 'pull_request'/);
  assert.match(tierSmokeJob, /npm run test:tier-smoke-ledger-db/);
  assert.doesNotMatch(fastJob, /npm run test:tier-smoke-ledger-db/);
  assert.doesNotMatch(tierSmokeJob, /run: npm test(?:\s|$)/);
  const runner = readFileSync("scripts/run-tier-smoke-ledger-db-test.sh", "utf8");
  assert.match(runner, /if \[\[ "\$\{CI:-\}" == "true" \]\]; then[\s\S]*exit 1/u);
});

test("运营底座真 PostgreSQL 验收在 PR 独立执行且不扩成整套慢测", () => {
  assert.match(opsP0Job, /github\.event_name == 'pull_request'/);
  assert.match(opsP0Job, /npm run test:ops-p0-db/);
  assert.doesNotMatch(fastJob, /npm run test:ops-p0-db/);
  for (const script of [
    "test:s67-db",
    "test:s84-db",
    "test:seed-audio-db",
    "test:object-context-db",
    "test:asset-usage-db",
    "test:agent-credential-source-db",
  ]) {
    assert.doesNotMatch(opsP0Job, new RegExp(`npm run ${script}`));
  }
});

test("未过审资产生产门禁在 PR 独立执行真实 PostgreSQL 且保留付费前运行时条件", () => {
  assert.match(reviewGateJob, /github\.event_name == 'pull_request'/);
  assert.match(reviewGateJob, /libimage-exiftool-perl/);
  assert.match(reviewGateJob, /npm run test:reference-review-gate-db/);
  assert.doesNotMatch(fastJob, /npm run test:reference-review-gate-db/);
  assert.doesNotMatch(reviewGateJob, /run: npm test(?:\s|$)/);
  for (const script of [
    "test:s67-db",
    "test:s84-db",
    "test:seed-audio-db",
    "test:object-context-db",
    "test:asset-usage-db",
    "test:agent-credential-source-db",
  ]) {
    assert.doesNotMatch(reviewGateJob, new RegExp(`npm run ${script}`));
  }
});

test("三个新图片模型的迁移在 PR 独立执行真实 PostgreSQL", () => {
  assert.match(suchuangPricingJob, /github\.event_name == 'pull_request'/);
  assert.match(suchuangPricingJob, /npm run test:audio-pricing-seed-db/);
  assert.doesNotMatch(fastJob, /npm run test:audio-pricing-seed-db/);
  assert.doesNotMatch(suchuangPricingJob, /run: npm test(?:\s|$)/);
});

test("required checks use Node 24 actions and prescribe the pinned Node 22 lock repair", () => {
  // 判据是「凡是 checkout/setup-node 一律 v5」，不是「一共有几个」——
  // 写死个数会让**合法新增 job** 撞红（#284 补 6 个 PR 闸时就撞了一次）。
  for (const action of ["checkout", "setup-node"]) {
    const all = (workflow.match(new RegExp(`actions/${action}@v\\d+`, "g")) ?? []).length;
    const pinned = (workflow.match(new RegExp(`actions/${action}@v5`, "g")) ?? []).length;
    assert.ok(all > 0, `ci.yml 里没有 actions/${action}`);
    assert.equal(pinned, all, `actions/${action} 有 ${all - pinned} 处不是 v5`);
  }
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v4/);
  assert.match(
    fastJob,
    /docker run --rm -v "\$PWD:\/w" -w \/w node:22\.19\.0 npm install --package-lock-only --ignore-scripts --no-audit --no-fund/,
  );
});

test("一次性 PostgreSQL runner 使用 tmpfs，不再占满 Docker 数据盘", () => {
  const shellRunners = readdirSync("scripts")
    .filter((name) => /^run-.*-db-test\.sh$/u.test(name))
    .map((name) => `scripts/${name}`)
    .filter((path) => readFileSync(path, "utf8").includes("docker run -d --rm --name"));

  assert.ok(shellRunners.length > 0, "没有找到一次性 PostgreSQL shell runner");
  for (const path of shellRunners) {
    assert.match(
      readFileSync(path, "utf8"),
      /--tmpfs \/var\/lib\/postgresql\/data:rw,size=512m/u,
      `${path} 必须把一次性数据库放在受限 tmpfs`,
    );
  }

  for (const path of [
    "tests/s69-storage-deletion-integrity-db.test.ts",
    "tests/trash-retention-db.test.ts",
  ]) {
    assert.match(
      readFileSync(path, "utf8"),
      /\/var\/lib\/postgresql\/data:rw,size=\d+m/u,
      `${path} 必须把一次性数据库放在受限 tmpfs`,
    );
  }
});

/**
 * #284：`npm test` 链中的一次性 PostgreSQL 套件不能在 Docker 抖动时静默 `exit 0`。
 * 不能只盯 PR 闸：verify-postgres 的 dev-push 套件同样是验收，跳过不等于通过。
 */
test("test 链上的每个数据库套件,docker 缺失时在 CI 里必须红而不是跳过", () => {
  const packageScripts = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const testChainSuites = [
    ...new Set(
      [...(packageScripts.scripts?.test ?? "").matchAll(/npm run (test:[a-z0-9-]+-db)/gu)].map((match) => match[1]),
    ),
  ];

  assert.ok(testChainSuites.length >= 19, `test 链上的数据库套件只找到 ${testChainSuites.length} 个,正则没匹配对`);

  for (const suite of testChainSuites) {
    const command = packageScripts.scripts?.[suite];
    assert.equal(typeof command, "string", `${suite} 必须有 npm 命令`);
    const runner = /\bbash (scripts\/[a-z0-9_./-]+\.sh)\b/u.exec(command)?.[1];
    assert.ok(runner, `${suite} 必须显式调用其 Bash runner`);
    const source = readFileSync(runner, "utf8");
    if (!source.includes("docker info")) continue; // 没有预检的缺 docker 本来就会红

    const preflight = /if ! timeout \d+ docker info[\s\S]*?\nfi\n/u.exec(source);
    assert.ok(preflight, `${runner} 的 docker 预检段没解析出来`);
    assert.match(preflight[0], /\$\{CI:-\}/u, `${runner} 的 docker 预检没有区分 CI`);
    assert.match(
      preflight[0],
      /exit 1/u,
      `${runner} 的 docker 预检在 CI 缺 Docker 时会静默跳过,那不是闸`,
    );
  }
});
