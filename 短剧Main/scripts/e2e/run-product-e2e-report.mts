import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBusinessLanguageGuard } from "./business-language-guard.mts";
import { E2E_PRODUCTION_HOSTS } from "./production-target-guard.js";
import {
  appendUxMetricsRun,
  buildSolUxMetrics,
  buildUxMetricsMarkdown,
  buildUxMetricsRun,
  missingKimiUxMetrics,
  parseKimiUxMetrics,
  type KimiUxEvalInput,
  type UxMetricsRun,
} from "./ux-metrics.mts";

type SuiteName = "smoke" | "experience" | "cli";

type Step = {
  name?: unknown;
  ok?: unknown;
  exit_code?: unknown;
  observed_ms?: unknown;
  max_ms?: unknown;
  screenshot?: unknown;
  error?: unknown;
  details?: Record<string, unknown>;
};

type SuiteSummary = {
  goal?: unknown;
  base_url?: unknown;
  ok?: unknown;
  thresholds?: Record<string, unknown>;
  steps?: Step[];
  feedback_probes?: Array<{
    action?: unknown;
    ok?: unknown;
    observed_ms?: unknown;
    max_ms?: unknown;
    feedback_kind?: unknown;
    error?: unknown;
  }>;
  reports?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
  release_tag?: unknown;
  chain?: Record<string, unknown> | null;
  paid_redlines?: Record<string, unknown> | null;
  error?: unknown;
};

export type SuiteReport = {
  suite: SuiteName;
  command: string;
  exitCode: number;
  summaryPath: string;
  summary: SuiteSummary | null;
  summaryFresh: boolean;
};

export type ProductE2eReportInput = {
  startedAt: Date;
  finishedAt: Date;
  triggerReason: string;
  targetEnvironment: string;
  targetBaseUrl: string;
  baselineCommit: string;
  suites: SuiteReport[];
  uxMetricsRun?: UxMetricsRun;
  uxMetricsPath?: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_REPORT_TIME_ZONE = "Asia/Shanghai";

const suiteDefinitions: Record<SuiteName, {
  command: string;
  summaryPath: () => string;
}> = {
  smoke: {
    command: "e2e:raw:sgoal06:midscene",
    summaryPath: () => path.resolve(
      process.env.SGOAL06_ARTIFACT_DIR ?? path.join(repoRoot, "artifacts", "sgoal06-midscene"),
      "smoke-summary.json",
    ),
  },
  experience: {
    command: "e2e:raw:sgoal07:asset-experience",
    summaryPath: () => path.resolve(
      process.env.SGOAL07_ASSET_EXPERIENCE_ARTIFACT_DIR
        ?? path.join(repoRoot, "artifacts", "sgoal07-asset-experience"),
      "experience-summary.json",
    ),
  },
  cli: {
    command: "e2e:raw:cli-product",
    summaryPath: () => path.resolve(
      process.env.E2E_CLI_SUMMARY_PATH
        ?? path.join(repoRoot, "artifacts", "cli-product-e2e", "cli-summary.json"),
    ),
  },
};

function cleanText(value: unknown, fallback = "—"): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const sanitized = text
    .replaceAll(/\u001B\[[0-9;]*m/g, "")
    .replace(/\b(authorization|password|passwd|token|secret|api[_ -]?key|access[_ -]?key)\b\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/([?&](?:key|token|signature|secret|password)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "<redacted>")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, " ")
    .trim();
  return sanitized || fallback;
}

function cleanGitCommit(value: string): string {
  const commit = value.trim();
  return /^[0-9a-f]{7,64}$/i.test(commit) ? commit : cleanText(commit);
}

function cleanArtifactPath(value: string): string {
  const absolute = path.resolve(value);
  const relative = path.relative(repoRoot, absolute);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return absolute
      .replaceAll("|", "\\|")
      .replaceAll(/\r?\n/g, "")
      .trim();
  }
  return cleanText(absolute);
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function environmentSlug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-").replaceAll(/^-|-$/g, "") || "unknown";
}

export function inferEnvironment(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes("-test.") || host.includes(".test.") || host === "shortdrama-main-test.col.com") return "test";
    if (host === "localhost" || host === "127.0.0.1" || host.includes("-dev.")) return "dev";
    if (E2E_PRODUCTION_HOSTS.has(host) || host.includes("-prod.")) return "production";
    return "custom";
  } catch {
    return "unknown";
  }
}

function assertionLabel(name: string): string {
  const labels: Record<string, string> = {
    login: "登录",
    projects: "项目管理页",
    project_storyboards: "项目生产页",
    shot_workbench: "分镜工作台",
    image_generation_once: "单次生图链路",
    personal_assets: "个人资产页",
    dashboard: "数据看板",
    settings: "设置页",
    admin: "管理员控制台",
    project_director: "3D 导演台",
    common_asset_first_screen: "通用资产首屏",
    common_asset_visual_assertion: "通用资产视觉",
    asset_media_versions_read: "媒体版本读取",
    asset_detail_visual_assertion: "资产详情视觉",
    asset_media_switch: "媒体版本切换",
  };
  return labels[name] ?? name;
}

function thresholdFor(step: Step, summary: SuiteSummary | null): number | null {
  if (typeof step.max_ms === "number") return step.max_ms;
  const name = typeof step.name === "string" ? step.name : "";
  const keyByName: Record<string, string> = {
    common_asset_first_screen: "common_asset_first_screen_max_ms",
    asset_media_versions_read: "media_versions_read_max_ms",
    asset_media_switch: "media_switch_max_ms",
  };
  const threshold = summary?.thresholds?.[keyByName[name] ?? ""];
  return typeof threshold === "number" ? threshold : null;
}

function rootCauseGuess(step: Step): string {
  const name = typeof step.name === "string" ? step.name : "unknown";
  const details = step.details ?? {};
  if (name === "common_asset_first_screen") {
    const requestCount = typeof details.request_count === "number" ? details.request_count : null;
    const requestShapeOk = details.request_shape_ok;
    if (requestCount !== null && requestCount > 1) return `列表仍存在扇出请求（观测 ${requestCount} 次），优先检查客户端换源或旧版本部署`;
    if (requestShapeOk === false) return "列表请求未稳定为一次 page_size=24，优先检查部署版本与调用参数";
    return "首屏超过阈值，优先拆分 API 响应、媒体下载和渲染三段耗时";
  }
  if (name === "asset_media_versions_read") return "媒体版本读取或缩略图可用性未达门槛，优先检查 versions API 与预览资源";
  if (name === "asset_media_switch") return "切换控件、选中态或主预览 DOM 未及时更新，优先检查前端交互链";
  if (name === "login") return "登录或测试站认证链异常，优先检查站点可达性、账号权限和当前部署";
  if (name.includes("visual")) return "确定性前置已到达但视觉断言失败，优先核对页面真实状态与 Midscene 判断工件";
  if (name === "image_generation_once") return "真实生图链未到达明确成功或明确失败，优先查看费用确认、供应商错误和任务状态";
  return `该步骤未通过；先看截图和 Playwright/Midscene 工件。错误摘要：${cleanText(step.error, "无")}`;
}

function suiteTitle(suite: SuiteName): string {
  if (suite === "smoke") return "冒烟";
  if (suite === "experience") return "体验门";
  return "CLI";
}

function suiteSteps(suite: SuiteReport): Step[] {
  if (suite.summaryFresh && Array.isArray(suite.summary?.steps)) return suite.summary.steps;
  return [{
    name: `${suite.suite}_summary`,
    ok: false,
    error: suite.summaryFresh ? "报告摘要格式无 steps" : "本轮没有生成新摘要，拒绝复用历史结果",
  }];
}

function artifactPaths(suite: SuiteReport): string[] {
  const values = [
    suite.summaryPath,
    ...Object.values(suite.summary?.reports ?? {}),
    ...Object.values(suite.summary?.artifacts ?? {}),
    ...suiteSteps(suite).map((step) => step.screenshot),
  ];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => path.resolve(value)))];
}

function buildCliSection(input: ProductE2eReportInput): string {
  const cli = input.suites.find((suite) => suite.suite === "cli");
  if (!cli) return "";
  const summary = cli.summary;
  const chain = summary?.chain ?? null;
  const redlines = summary?.paid_redlines ?? null;
  const bool = (value: unknown) => value === true ? "通过" : "红";
  const steps = suiteSteps(cli);
  return [
    "### CLI",
    "",
    `- Release：${cleanText(summary?.release_tag, "未生成本轮 Release 证据")}`,
    `- Release 安装与已支持命令链：${cli.exitCode === 0 && summary?.ok === true ? "通过" : "红"}`,
    `- 付费红线：pending ${bool(redlines?.pending_quote_rejected)} / expired ${bool(redlines?.expired_quote_rejected)} / mismatched ${bool(redlines?.mismatched_quote_rejected)} / 无 --yes ${bool(redlines?.no_yes_path)}`,
    `- 生成模式：${chain?.paid_generation_executed === true ? "发版门小额真生成" : "常跑仅估价，不自动付费"}；状态 ${cleanText(chain?.generation_status, "未到达终态")}；估价 ${typeof chain?.estimated_cost_fen === "number" ? `${chain.estimated_cost_fen} 分` : "—"}`,
    `- 交付清单：${typeof chain?.delivery_item_count === "number" ? `${chain.delivery_item_count} 项` : "—"}；缺口 ${typeof chain?.delivery_gap_count === "number" ? chain.delivery_gap_count : "—"} 项；来源 ${cleanText(chain?.delivery_source, "未记录")}`,
    `- 生成→交付同集证据：${chain?.delivery_linked_to_generation === true ? "通过" : "未覆盖（交付只读独立验证）"}`,
    `- 命令断言：${steps.filter((step) => step.ok === true).length}/${steps.length} 通过`,
    `- 错误：${cleanText(summary?.error, "无")}`,
    "",
  ].join("\n");
}

export function buildReportSection(input: ProductE2eReportInput, timeZone = DEFAULT_REPORT_TIME_ZONE): string {
  const rows: string[] = [];
  const redItems: string[] = [];
  for (const suite of input.suites) {
    for (const step of suiteSteps(suite)) {
      const ok = step.ok === true;
      const observed = typeof step.observed_ms === "number" ? `${Math.round(step.observed_ms)} ms` : "—";
      const threshold = thresholdFor(step, suite.summary);
      const name = typeof step.name === "string" ? step.name : "unknown";
      rows.push([
        suiteTitle(suite.suite),
        assertionLabel(name),
        ok ? "通过" : "红",
        observed,
        threshold === null ? "—" : `${Math.round(threshold)} ms`,
        cleanText(step.error, ok ? "—" : "见工件"),
      ].map((value) => cleanText(value)).join(" | "));
      if (!ok) redItems.push(`- **${suiteTitle(suite.suite)} / ${assertionLabel(name)}**：${rootCauseGuess(step)}（根因猜想，待 Fable 统筹）`);
    }
  }
  const suitesGreen = input.suites.every((suite) => (
    suite.exitCode === 0
    && suite.summaryFresh
    && suiteSteps(suite).every((step) => step.ok === true)
  ));
  const uxStatus = input.uxMetricsRun?.status;
  for (const uxMetric of input.uxMetricsRun?.metrics ?? []) {
    if (uxMetric.status === "failed") {
      redItems.push(`- **UX / ${uxMetric.id} ${uxMetric.name}**：实测未达到 ${cleanText(uxMetric.target)}；证据见 UX 总榜，由 Fable 统筹。`);
    }
  }
  const reportStatus = !suitesGreen || uxStatus === "failed"
    ? "有红项"
    : uxStatus === "not_assessable"
      ? "有未评估"
      : "全绿";
  const artifacts = [...new Set([
    ...input.suites.flatMap(artifactPaths),
    ...(input.uxMetricsPath ? [input.uxMetricsPath] : []),
    ...(input.uxMetricsRun
      ? [
        input.uxMetricsRun.source_artifacts.business_language_summary,
        input.uxMetricsRun.source_artifacts.kimi_ux_eval,
      ].filter((value): value is string => typeof value === "string")
      : []),
  ])];
  return [
    `## ${localDateTime(input.finishedAt, timeZone)} · ${reportStatus}`,
    "",
    `- 跑的时间：${localDateTime(input.startedAt, timeZone)} — ${localDateTime(input.finishedAt, timeZone)}（${timeZone}）`,
    `- 触发原因：${cleanText(input.triggerReason)}`,
    `- 目标环境：${cleanText(input.targetEnvironment)}（${cleanText(input.targetBaseUrl)}）`,
    `- 基线 commit：\`${cleanGitCommit(input.baselineCommit)}\``,
    `- 总结：${reportStatus === "全绿" ? "全部断言和 UX 指标通过" : reportStatus === "有红项" ? "存在红项；只汇报，不自动扩修" : "自动化断言通过，但仍有 UX 指标缺少本轮证据"}`,
    "",
    "### 断言表",
    "",
    "套件 | 断言 | 结果 | 毫秒实测 | 门槛 | 错误摘要",
    "--- | --- | --- | ---: | ---: | ---",
    ...rows,
    "",
    "### 红项与根因猜想",
    "",
    ...(redItems.length > 0 ? redItems : ["- 无红项。"]),
    "",
    ...(input.uxMetricsRun && input.uxMetricsPath
      ? [buildUxMetricsMarkdown(input.uxMetricsRun, input.uxMetricsPath), ""]
      : []),
    buildCliSection(input),
    "### 工件路径",
    "",
    ...artifacts.map((artifact) => `- \`${cleanArtifactPath(artifact)}\``),
    "",
  ].join("\n");
}

async function readKimiUxEval(input: {
  file: string;
  explicitlyConfigured: boolean;
  baselineCommit: string;
  targetEnvironment: string;
}): Promise<{
  metrics: ReturnType<typeof missingKimiUxMetrics>;
  artifactPath: string | null;
  warnings: string[];
}> {
  try {
    const raw = JSON.parse(await readFile(input.file, "utf8")) as KimiUxEvalInput;
    return {
      metrics: parseKimiUxMetrics(raw, {
        baselineCommit: input.baselineCommit,
        targetEnvironment: input.targetEnvironment,
      }),
      artifactPath: input.file,
      warnings: [],
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" && !input.explicitlyConfigured) {
      return {
        metrics: missingKimiUxMetrics(),
        artifactPath: null,
        warnings: ["本轮没有 KIMI-UX-EVAL 产物；A1–A5、B2 保持未评估，不以旧结果冒充。"],
      };
    }
    throw error;
  }
}

async function fileMtime(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

async function readFreshSummary(file: string, startedAtMs: number): Promise<{ summary: SuiteSummary | null; fresh: boolean }> {
  const mtime = await fileMtime(file);
  if (mtime === null || mtime < startedAtMs - 1_000) return { summary: null, fresh: false };
  try {
    return { summary: JSON.parse(await readFile(file, "utf8")) as SuiteSummary, fresh: true };
  } catch {
    return { summary: null, fresh: false };
  }
}

async function runNpmScript(command: string): Promise<number> {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["run", command], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

function parseSuites(args: string[]): SuiteName[] {
  const index = args.indexOf("--suite");
  const value = index >= 0 ? args[index + 1] : "all";
  if (value === "smoke") return ["smoke", "cli"];
  if (value === "experience") return ["experience", "cli"];
  if (value === "cli") return ["cli"];
  if (value === "all") return ["smoke", "experience", "cli"];
  throw new Error("--suite 只接受 smoke、experience、cli 或 all");
}

async function gitBaseline(): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot }, (error, stdout) => {
      resolve(error ? "not_assessable" : stdout.trim());
    });
  });
}

async function main(): Promise<void> {
  const suites = parseSuites(process.argv.slice(2));
  const startedAt = new Date();
  const startedAtMs = startedAt.getTime();
  const reports: SuiteReport[] = [];
  for (const suite of suites) {
    const definition = suiteDefinitions[suite];
    const exitCode = await runNpmScript(definition.command);
    const summaryPath = definition.summaryPath();
    const { summary, fresh } = await readFreshSummary(summaryPath, startedAtMs);
    reports.push({
      suite,
      command: definition.command,
      exitCode,
      summaryPath,
      summary,
      summaryFresh: fresh,
    });
  }
  const targetBaseUrl = reports
    .map((report) => report.summary?.base_url)
    .find((value): value is string => typeof value === "string")
    ?? process.env.SGOAL07_ASSET_EXPERIENCE_BASE_URL
    ?? process.env.SGOAL06_BASE_URL
    ?? "https://shortdrama-main-test.col.com";
  const targetEnvironment = process.env.E2E_TARGET_ENVIRONMENT?.trim() || inferEnvironment(targetBaseUrl);
  const timeZone = process.env.E2E_REPORT_TIME_ZONE?.trim() || DEFAULT_REPORT_TIME_ZONE;
  const reportDir = path.resolve(process.env.E2E_REPORT_DIR ?? path.join(repoRoot, "outputs", "e2e-reports"));
  const baselineCommit = await gitBaseline();
  const businessLanguagePath = path.resolve(
    process.env.E2E_BUSINESS_LANGUAGE_SUMMARY_PATH
      ?? path.join(repoRoot, "artifacts", "ux-metrics", "business-language-summary.json"),
  );
  const businessLanguage = await runBusinessLanguageGuard(repoRoot, businessLanguagePath);
  const configuredKimiPath = process.env.E2E_KIMI_UX_METRICS_PATH?.trim();
  const kimiPath = path.resolve(
    configuredKimiPath ?? path.join(repoRoot, "artifacts", "kimi-ux-eval", "ux-metrics.json"),
  );
  const kimi = await readKimiUxEval({
    file: kimiPath,
    explicitlyConfigured: Boolean(configuredKimiPath),
    baselineCommit,
    targetEnvironment,
  });
  const smokeReport = reports.find((report) => report.suite === "smoke");
  const experienceReport = reports.find((report) => report.suite === "experience");
  const solMetrics = buildSolUxMetrics({
    smokeSummary: smokeReport?.summary ?? null,
    smokeAssessable: smokeReport?.summaryFresh === true,
    experienceSummary: experienceReport?.summary ?? null,
    experienceAssessable: experienceReport?.summaryFresh === true,
    businessLanguage,
  });
  const finishedAt = new Date();
  const triggerReason = process.env.E2E_TRIGGER_REASON?.trim() || "manual";
  const uxMetricsPath = path.resolve(
    process.env.E2E_UX_METRICS_PATH ?? path.join(reportDir, "ux-metrics.json"),
  );
  const uxMetricsRun = buildUxMetricsRun({
    startedAt,
    finishedAt,
    triggerReason,
    targetEnvironment,
    targetBaseUrl,
    baselineCommit,
    solMetrics,
    kimiMetrics: kimi.metrics,
    sourceArtifacts: {
      smoke_summary: smokeReport?.summaryFresh ? smokeReport.summaryPath : null,
      experience_summary: experienceReport?.summaryFresh ? experienceReport.summaryPath : null,
      business_language_summary: businessLanguagePath,
      kimi_ux_eval: kimi.artifactPath,
    },
    warnings: kimi.warnings,
  });
  await appendUxMetricsRun(uxMetricsPath, uxMetricsRun);
  const reportPath = path.join(
    reportDir,
    `e2e-${localDate(finishedAt, timeZone)}-${environmentSlug(targetEnvironment)}.md`,
  );
  const exists = await fileMtime(reportPath) !== null;
  const header = exists
    ? ""
    : [
      `# 产品自动化测试报告 · ${localDate(finishedAt, timeZone)} · ${targetEnvironment}`,
      "",
      "> 同一天同环境的每次运行追加为独立小节；红项由 Fable 统筹派活，本脚本不自动扩修。",
      "",
    ].join("\n");
  const section = buildReportSection({
    startedAt,
    finishedAt,
    triggerReason,
    targetEnvironment,
    targetBaseUrl,
    baselineCommit,
    suites: reports,
    uxMetricsRun,
    uxMetricsPath,
  }, timeZone);
  await mkdir(reportDir, { recursive: true });
  await appendFile(reportPath, `${header}${section}\n`, "utf8");
  process.stdout.write(`\n产品自动化报告已生成：${reportPath}\n请把该路径和红绿结论直连发给 Fable。\n`);
  if (
    reports.some((report) => report.exitCode !== 0 || !report.summaryFresh)
    || uxMetricsRun.status === "failed"
  ) {
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`产品自动化报告生成失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
