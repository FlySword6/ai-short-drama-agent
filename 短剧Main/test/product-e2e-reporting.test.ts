import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runBusinessLanguageGuard } from "../scripts/e2e/business-language-guard.mts";
import {
  buildReportSection,
  inferEnvironment,
  type ProductE2eReportInput,
} from "../scripts/e2e/run-product-e2e-report.mts";
import {
  appendUxMetricsRun,
  buildSolUxMetrics,
  buildUxMetricsRun,
  parseKimiUxMetrics,
} from "../scripts/e2e/ux-metrics.mts";

const report: ProductE2eReportInput = {
  startedAt: new Date("2026-08-01T01:00:00.000Z"),
  finishedAt: new Date("2026-08-01T01:02:00.000Z"),
  triggerReason: "post-release",
  targetEnvironment: "test",
  targetBaseUrl: "http://shortdrama-main-test.col.com",
  baselineCommit: "2aff1467aabbccddeeff00112233445566778899",
  suites: [{
    suite: "experience",
    command: "e2e:raw:sgoal07:asset-experience",
    exitCode: 1,
    summaryPath: fileURLToPath(new URL(
      "../artifacts/sgoal07-asset-experience/experience-summary.json",
      import.meta.url,
    )),
    summaryFresh: true,
    summary: {
      thresholds: {
        common_asset_first_screen_max_ms: 3_000,
        media_versions_read_max_ms: 1_500,
        media_switch_max_ms: 500,
      },
      steps: [{
        name: "common_asset_first_screen",
        ok: false,
        observed_ms: 11_063,
        max_ms: 3_000,
        error: "token=abcdefghijklmnopqrstuvwxyz1234567890",
        details: {
          request_count: 17,
          request_shape_ok: false,
        },
        screenshot: fileURLToPath(new URL(
          "../artifacts/sgoal07-asset-experience/screenshots/common-asset-first-screen-failed.png",
          import.meta.url,
        )),
      }],
      reports: {
        playwright_json: fileURLToPath(new URL(
          "../artifacts/sgoal07-asset-experience/playwright-results.json",
          import.meta.url,
        )),
        midscene_html_directory: fileURLToPath(new URL(
          "../artifacts/sgoal07-asset-experience/midscene/report",
          import.meta.url,
        )),
      },
    },
  }],
};

test("固定报告包含时间、原因、环境、commit、毫秒断言、红项猜想与工件路径", () => {
  const markdown = buildReportSection(report);
  assert.match(markdown, /触发原因：post-release/);
  assert.match(markdown, /目标环境：test/);
  assert.match(markdown, /基线 commit：`2aff1467aabbccddeeff00112233445566778899`/);
  assert.match(markdown, /11063 ms/);
  assert.match(markdown, /3000 ms/);
  assert.match(markdown, /观测 17 次/);
  assert.match(markdown, /根因猜想/);
  assert.match(markdown, /experience-summary\.json/);
  assert.match(markdown, /playwright-results\.json/);
  assert.match(markdown, /midscene[\\/]report/);
  assert.match(markdown, /common-asset-first-screen-failed\.png/);
  assert.doesNotMatch(markdown, /abcdefghijklmnopqrstuvwxyz/);
});

test("测试环境识别稳定，未知地址不冒充 test", () => {
  assert.equal(inferEnvironment("http://shortdrama-main-test.col.com"), "test");
  assert.equal(inferEnvironment("http://127.0.0.1:5173"), "dev");
  assert.equal(inferEnvironment("https://shortdrama.col.com"), "production");
  assert.equal(inferEnvironment("https://example.com"), "custom");
  assert.equal(inferEnvironment("not-a-url"), "unknown");
});

test("公开 E2E 命令全部经过固定报告包装，raw 命令只供包装器内部调用", () => {
  const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  assert.match(packageJson, /"e2e:sgoal06:midscene": "tsx scripts\/e2e\/run-product-e2e-report\.mts --suite smoke"/);
  assert.match(packageJson, /"e2e:sgoal07:asset-experience": "tsx scripts\/e2e\/run-product-e2e-report\.mts --suite experience"/);
  assert.match(packageJson, /"e2e:product:report": "tsx scripts\/e2e\/run-product-e2e-report\.mts --suite all"/);
  assert.match(packageJson, /"e2e:raw:sgoal06:midscene"/);
  assert.match(packageJson, /"e2e:raw:sgoal07:asset-experience"/);
  assert.match(packageJson, /"e2e:raw:cli-product": "tsx scripts\/e2e\/run-cli-product-suite\.mts"/);
  assert.match(packageJson, /"e2e:cli-paid-redlines": "tsx scripts\/e2e\/run-cli-paid-redlines\.mts"/);
});

test("生产 E2E 只能由显式 opt-in 打开，CLI 同样受闸且必须给目标", () => {
  const source = (name: string) => readFileSync(new URL(`../scripts/e2e/${name}`, import.meta.url), "utf8");
  for (const name of [
    "sgoal06-midscene.smoke.spec.ts",
    "sgoal07-asset-experience.smoke.spec.ts",
    "fe-full-audit.smoke.spec.ts",
  ]) {
    const smoke = source(name);
    assert.match(smoke, /productionHosts/);
    assert.match(smoke, /assertProductionTargetAllowed/);
  }
  const guard = source("production-target-guard.ts");
  assert.match(guard, /E2E_ALLOW_PRODUCTION_TARGET/);
  assert.match(guard, /!== "1"/);
  const cli = source("run-cli-product-suite.mts");
  assert.match(cli, /productionHosts/);
  assert.match(cli, /resolveEffectiveCliE2eTarget/);
  assert.match(cli, /process\.env\.SHORTDRAMA_API_BASE = cliTarget/);
  assert.match(guard, /必须显式设置 SHORTDRAMA_API_BASE 或 CLI_E2E_BASE_URL/);
});

test("产品报告固定追加 CLI 节，包含 Release 真链、费用与四条付费红线", () => {
  const cliReport: ProductE2eReportInput = {
    ...report,
    suites: [{
      suite: "cli",
      command: "e2e:raw:cli-product",
      exitCode: 0,
      summaryPath: "/tmp/cli-summary.json",
      summaryFresh: true,
      summary: {
        ok: true,
        release_tag: "v0.3.0",
        steps: [
          { name: "release_install", ok: true, exit_code: 0 },
          { name: "delivery_manifest", ok: true, exit_code: 0 },
        ],
        chain: {
          generation_status: "succeeded",
          paid_generation_executed: true,
          estimated_cost_fen: 400,
          delivery_item_count: 1,
          delivery_gap_count: 0,
          delivery_source: "named_fixture",
          delivery_linked_to_generation: false,
        },
        paid_redlines: {
          pending_quote_rejected: true,
          expired_quote_rejected: true,
          mismatched_quote_rejected: true,
          no_yes_path: true,
        },
        artifacts: { summary: "/tmp/cli-summary.json" },
      },
    }],
  };
  const markdown = buildReportSection(cliReport);
  assert.match(markdown, /### CLI/);
  assert.match(markdown, /Release：v0\.3\.0/);
  assert.match(markdown, /pending 通过 \/ expired 通过 \/ mismatched 通过 \/ 无 --yes 通过/);
  assert.match(markdown, /生成模式：发版门小额真生成；状态 succeeded；估价 400 分/);
  assert.match(markdown, /交付清单：1 项；缺口 0 项；来源 named_fixture/);
  assert.match(markdown, /生成→交付同集证据：未覆盖/);
});

test("CLI 付费红线自建一次性 PostgreSQL，并锁定三类服务端错误码", () => {
  const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const source = readFileSync(new URL(
    "../scripts/e2e/run-cli-paid-redlines.mts",
    import.meta.url,
  ), "utf8");
  const runner = readFileSync(new URL(
    "../scripts/run-generation-quotes-db-test.sh",
    import.meta.url,
  ), "utf8");
  const workflow = readFileSync(new URL(
    "../.github/workflows/ci.yml",
    import.meta.url,
  ), "utf8");
  const productWorkflow = readFileSync(new URL(
    "../.github/workflows/product-e2e.yml",
    import.meta.url,
  ), "utf8");

  assert.match(packageJson, /"test:generation-quotes-db": "bash scripts\/run-generation-quotes-db-test\.sh"/);
  assert.match(packageJson, /"test": "[^"]*npm run test:generation-quotes-db/);
  assert.match(source, /\["run", "test:generation-quotes-db"\]/);
  assert.doesNotMatch(source, /GENERATION_QUOTES_TEST_DATABASE_URL/);
  assert.doesNotMatch(source, /--test", "tests\/generation-quotes-db\.test\.ts/);

  assert.match(runner, /postgres:14-alpine/);
  assert.match(runner, /--tmpfs \/var\/lib\/postgresql\/data:rw,size=512m/);
  assert.match(runner, /-p 127\.0\.0\.1::5432/);
  assert.match(runner, /trap cleanup EXIT/);
  assert.match(runner, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  assert.match(runner, /POSTGRES_SCHEMA="\$schema"/);
  assert.match(runner, /node --import tsx src\/db\/migrate\.ts/);
  assert.match(runner, /node --import tsx --test tests\/generation-quotes-db\.test\.ts/);
  assert.match(runner, /if \[\[ "\$\{CI:-\}" == "true" \]\]/);
  assert.match(runner, /exit 1/);
  assert.match(runner, /\[skip\].*docker/u);

  assert.match(workflow, /verify-generation-quotes-postgres:[\s\S]*if: github\.event_name == 'pull_request'[\s\S]*libimage-exiftool-perl[\s\S]*npm run test:generation-quotes-db/);
  assert.doesNotMatch(productWorkflow, /CLI_E2E_POSTGRES_URL|GENERATION_QUOTES_TEST_DATABASE_URL/);

  assert.match(source, /GENERATION_QUOTE_UNCONFIRMED/);
  assert.match(source, /GENERATION_QUOTE_EXPIRED/);
  assert.match(source, /GENERATION_QUOTE_CONFLICT/);
  assert.match(source, /CLI 发行命令面出现 --yes/);
  assert.match(source, /readdir\(cliSourceRoot/);
});

test("每日 CLI 门扫描与安装使用同一个 Release tag，付费真生成只接受手动勾选", () => {
  const workflow = readFileSync(new URL(
    "../.github/workflows/product-e2e.yml",
    import.meta.url,
  ), "utf8");
  assert.match(workflow, /allow_paid_generation:/);
  assert.match(workflow, /CLI_E2E_ALLOW_PAID_GENERATION:.*workflow_dispatch/);
  assert.match(workflow, /id: cli_release/);
  assert.match(workflow, /ref: \$\{\{ steps\.cli_release\.outputs\.tag \}\}/);
});

test("UX 总榜聚合 Kimi A/B2 与 Sol B1/C，报告追加固定 UX 指标节", () => {
  const solMetrics = buildSolUxMetrics({
    smokeAssessable: true,
    smokeSummary: {
      steps: [
        { name: "login", ok: true },
        { name: "image_generation_once", ok: true },
      ],
      feedback_probes: [
        { action: "request_image_generation", ok: true, observed_ms: 120, max_ms: 500 },
        { action: "confirm_image_generation", ok: false, observed_ms: 501, max_ms: 500 },
      ],
    },
    experienceAssessable: true,
    experienceSummary: {
      steps: [
        { name: "common_asset_first_screen", ok: true, observed_ms: 900, max_ms: 3_000 },
        { name: "asset_media_versions_read", ok: true, observed_ms: 300, max_ms: 1_500 },
        { name: "asset_media_switch", ok: true, observed_ms: 80, max_ms: 500 },
      ],
    },
    businessLanguage: {
      schema_version: "business-language-guard.v1",
      generated_at: "2026-08-02T01:02:00.000Z",
      ok: true,
      assessed_files: 42,
      compliant_files: 42,
      rate_pct: 100,
      guard_files: ["s17", "envelopes"],
    },
  });
  const kimiMetrics = parseKimiUxMetrics({
    schema_version: "kimi-ux-eval.v1",
    generated_at: "2026-08-02T01:02:00.000Z",
    baseline_commit: report.baselineCommit,
    target_environment: "test",
    target_base_url: report.targetBaseUrl,
    metrics: [
      {
        id: "A1",
        status: "passed",
        numerator: 6,
        denominator: 6,
        measured_value: "6/6",
        details: { token: "must-not-leak", note: "authorization=must-not-leak" },
      },
      { id: "A2", status: "passed", numerator: 6, denominator: 6 },
      { id: "A3", status: "passed", numerator: 6, denominator: 6 },
      { id: "A4", status: "passed", numerator: 6, denominator: 6 },
      { id: "A5", status: "passed", numerator: 6, denominator: 6, measured_value: "0" },
      { id: "B2", status: "passed", numerator: 5, denominator: 6, rate_pct: 83.33 },
    ],
  }, {
    baselineCommit: report.baselineCommit,
    targetEnvironment: "test",
  });
  const uxMetricsRun = buildUxMetricsRun({
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    triggerReason: report.triggerReason,
    targetEnvironment: "test",
    targetBaseUrl: report.targetBaseUrl,
    baselineCommit: report.baselineCommit,
    solMetrics,
    kimiMetrics,
    sourceArtifacts: {
      smoke_summary: "/tmp/smoke-summary.json",
      experience_summary: "/tmp/experience-summary.json",
      business_language_summary: "/tmp/business-language-summary.json",
      kimi_ux_eval: "/tmp/kimi-ux-eval.json",
    },
  });

  assert.equal(uxMetricsRun.metrics.find((item) => item.id === "B1")?.measured_value, "2/2");
  assert.equal(uxMetricsRun.metrics.find((item) => item.id === "C1")?.status, "passed");
  assert.equal(uxMetricsRun.metrics.find((item) => item.id === "C2")?.status, "failed");
  assert.equal(uxMetricsRun.metrics.find((item) => item.id === "C3")?.rate_pct, 100);
  assert.deepEqual(uxMetricsRun.metrics.find((item) => item.id === "A1")?.details, {
    token: "<redacted>",
    note: "authorization=<redacted>",
  });
  assert.deepEqual(uxMetricsRun.dashboard_summary, {
    task_completion: "2/2",
    zero_guidance_completion: "5/6",
    jump_ratio_compliance: "6/6",
  });

  const markdown = buildReportSection({
    ...report,
    uxMetricsRun,
    uxMetricsPath: "/tmp/ux-metrics.json",
  });
  assert.match(markdown, /### UX 指标/);
  assert.match(markdown, /B1 任务完成率 \| 通过 \| 2\/2/);
  assert.match(markdown, /C2 反馈及时率 \| 红 \| 1\/2/);
  assert.match(markdown, /任务完成 2\/2 · 零指导 5\/6 · 跳数达标 6\/6/);
  assert.match(markdown, /ux-metrics\.json/);
});

test("ux-metrics.json 按 run_id 幂等追加，供仪表盘稳定直读", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ux-metrics-test-"));
  const file = path.join(directory, "ux-metrics.json");
  const run = buildUxMetricsRun({
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    triggerReason: "test",
    targetEnvironment: "test",
    targetBaseUrl: report.targetBaseUrl,
    baselineCommit: report.baselineCommit,
    solMetrics: [],
    kimiMetrics: [],
    sourceArtifacts: {
      smoke_summary: null,
      experience_summary: null,
      business_language_summary: "/tmp/business-language-summary.json",
      kimi_ux_eval: null,
    },
  });
  try {
    await appendUxMetricsRun(file, run);
    await appendUxMetricsRun(file, run);
    const document = JSON.parse(await readFile(file, "utf8")) as {
      schema_version?: unknown;
      source_of_truth?: unknown;
      runs?: unknown[];
    };
    assert.equal(document.schema_version, "ux-metrics.v1");
    assert.equal(document.source_of_truth, "docs/design/ux-metrics.md");
    assert.equal(document.runs?.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("KIMI-UX-EVAL 基线不一致时拒绝聚合旧结果", () => {
  assert.throws(() => parseKimiUxMetrics({
    schema_version: "kimi-ux-eval.v1",
    baseline_commit: "old",
    target_environment: "test",
    metrics: [],
  }, {
    baselineCommit: report.baselineCommit,
    targetEnvironment: "test",
  }), /baseline_commit 与本轮不一致/);
});

test("业务话率取现有守卫真运行产物，不靠手填", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "business-language-test-"));
  const file = path.join(directory, "business-language-summary.json");
  try {
    const summary = await runBusinessLanguageGuard(process.cwd(), file);
    assert.equal(summary.ok, true);
    assert.ok(summary.assessed_files > 0);
    assert.equal(summary.compliant_files, summary.assessed_files);
    assert.equal(summary.rate_pct, 100);
    assert.deepEqual(
      JSON.parse(await readFile(file, "utf8")),
      summary,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
