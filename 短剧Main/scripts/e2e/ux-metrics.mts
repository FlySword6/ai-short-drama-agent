import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type UxMetricStatus = "passed" | "failed" | "not_assessable";
export type UxMetricId =
  | "A1"
  | "A2"
  | "A3"
  | "A4"
  | "A5"
  | "B1"
  | "B2"
  | "B3"
  | "C1"
  | "C2"
  | "C3";

export type UxMetric = {
  id: UxMetricId;
  group: "A" | "B" | "C";
  name: string;
  status: UxMetricStatus;
  target: string;
  source: "KIMI-UX-EVAL" | "sgoal06_smoke_backend" | "sgoal07_experience_gate" | "business_language_guard" | "unassigned";
  numerator?: number;
  denominator?: number;
  rate_pct?: number;
  measured_value?: string;
  details?: unknown;
  note?: string;
};

export type UxMetricsRun = {
  run_id: string;
  started_at: string;
  finished_at: string;
  trigger_reason: string;
  target_environment: string;
  target_base_url: string;
  baseline_commit: string;
  status: UxMetricStatus;
  dashboard_summary: {
    task_completion: string;
    zero_guidance_completion: string;
    jump_ratio_compliance: string;
  };
  metrics: UxMetric[];
  source_artifacts: {
    smoke_summary: string | null;
    experience_summary: string | null;
    business_language_summary: string;
    kimi_ux_eval: string | null;
  };
  warnings: string[];
};

export type UxMetricsDocument = {
  schema_version: "ux-metrics.v1";
  source_of_truth: "docs/design/ux-metrics.md";
  updated_at: string;
  runs: UxMetricsRun[];
};

export type BusinessLanguageSummary = {
  schema_version: "business-language-guard.v1";
  generated_at: string;
  ok: boolean;
  assessed_files: number;
  compliant_files: number | null;
  rate_pct: number | null;
  guard_files: string[];
  error?: string;
};

type StepLike = {
  name?: unknown;
  ok?: unknown;
  observed_ms?: unknown;
  max_ms?: unknown;
  error?: unknown;
};

type FeedbackProbeLike = {
  action?: unknown;
  ok?: unknown;
  observed_ms?: unknown;
  max_ms?: unknown;
  feedback_kind?: unknown;
  error?: unknown;
};

export type UxSuiteSummary = {
  steps?: StepLike[];
  feedback_probes?: FeedbackProbeLike[];
};

type KimiMetricInput = {
  id?: unknown;
  status?: unknown;
  numerator?: unknown;
  denominator?: unknown;
  rate_pct?: unknown;
  measured_value?: unknown;
  details?: unknown;
  note?: unknown;
};

export type KimiUxEvalInput = {
  schema_version?: unknown;
  generated_at?: unknown;
  baseline_commit?: unknown;
  target_environment?: unknown;
  target_base_url?: unknown;
  metrics?: unknown;
};

const metricDefinitions: Record<UxMetricId, {
  group: "A" | "B" | "C";
  name: string;
  target: string;
}> = {
  A1: { group: "A", name: "任务跳数比", target: "≤1.0" },
  A2: { group: "A", name: "任务点击数比", target: "≤1.2" },
  A3: { group: "A", name: "首屏可达率", target: "100%" },
  A4: { group: "A", name: "下一步显性率", target: "100%" },
  A5: { group: "A", name: "被迫回头数", target: "0" },
  B1: { group: "B", name: "任务完成率", target: "100%" },
  B2: { group: "B", name: "零指导完成率", target: "v0.3.0 ≥80%" },
  B3: { group: "B", name: "状态可知率", target: "100%" },
  C1: { group: "C", name: "体验门三阈值", target: "3000/1500/500ms" },
  C2: { group: "C", name: "反馈及时率", target: "500ms 内，100%" },
  C3: { group: "C", name: "业务话率", target: "100%" },
};

const kimiMetricIds = ["A1", "A2", "A3", "A4", "A5", "B2"] as const;

function artifactText(value: string): string {
  return value
    .replaceAll(/\u001B\[[0-9;]*m/gu, "")
    .replace(/\b(authorization|password|passwd|token|secret|api[_ -]?key|access[_ -]?key)\b\s*[:=]\s*\S+/giu, "$1=<redacted>")
    .replace(/([?&](?:key|token|signature|secret|password)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/gu, "<redacted>");
}

function sanitizeArtifactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "<truncated>";
  if (typeof value === "string") return artifactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeArtifactValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      artifactText(key),
      /authorization|password|passwd|token|secret|api[_ -]?key|access[_ -]?key/iu.test(key)
        ? "<redacted>"
        : sanitizeArtifactValue(item, depth + 1),
    ]));
  }
  return value == null ? null : String(value);
}

function roundedRate(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function metric(
  id: UxMetricId,
  input: Omit<UxMetric, "id" | "group" | "name" | "target">,
): UxMetric {
  return { id, ...metricDefinitions[id], ...input };
}

function notAssessableKimiMetric(id: (typeof kimiMetricIds)[number], note: string): UxMetric {
  return metric(id, {
    status: "not_assessable",
    source: "KIMI-UX-EVAL",
    note,
  });
}

function statusFromMetrics(metrics: UxMetric[]): UxMetricStatus {
  if (metrics.some((item) => item.status === "failed")) return "failed";
  if (metrics.some((item) => item.status === "not_assessable")) return "not_assessable";
  return "passed";
}

function fraction(metricValue: UxMetric | undefined): string {
  if (
    metricValue?.status === "not_assessable"
    || typeof metricValue?.numerator !== "number"
    || typeof metricValue.denominator !== "number"
  ) {
    return "not_assessable";
  }
  return `${metricValue.numerator}/${metricValue.denominator}`;
}

export function buildSolUxMetrics(input: {
  smokeSummary: UxSuiteSummary | null;
  smokeAssessable: boolean;
  experienceSummary: UxSuiteSummary | null;
  experienceAssessable: boolean;
  businessLanguage: BusinessLanguageSummary;
}): UxMetric[] {
  const smokeSteps = input.smokeAssessable && Array.isArray(input.smokeSummary?.steps)
    ? input.smokeSummary.steps
    : [];
  const completedTasks = smokeSteps.filter((step) => step.ok === true).length;
  const b1 = smokeSteps.length > 0
    ? metric("B1", {
      status: completedTasks === smokeSteps.length ? "passed" : "failed",
      source: "sgoal06_smoke_backend",
      numerator: completedTasks,
      denominator: smokeSteps.length,
      rate_pct: roundedRate(completedTasks, smokeSteps.length),
      measured_value: `${completedTasks}/${smokeSteps.length}`,
      details: smokeSteps.map((step) => ({
        task: typeof step.name === "string" ? step.name : "unknown",
        completed: step.ok === true,
      })),
      note: "后端视角采用当前冒烟套步骤作为任务集；不冒充六条完整导演旅程。",
    })
    : metric("B1", {
      status: "not_assessable",
      source: "sgoal06_smoke_backend",
      note: "本轮未生成可用的冒烟摘要。",
    });

  const experienceNames = [
    "common_asset_first_screen",
    "asset_media_versions_read",
    "asset_media_switch",
  ];
  const experienceSteps = input.experienceAssessable && Array.isArray(input.experienceSummary?.steps)
    ? input.experienceSummary.steps.filter((step) => (
      typeof step.name === "string" && experienceNames.includes(step.name)
    ))
    : [];
  const passedExperience = experienceSteps.filter((step) => step.ok === true).length;
  const c1 = experienceSteps.length === experienceNames.length
    ? metric("C1", {
      status: passedExperience === experienceNames.length ? "passed" : "failed",
      source: "sgoal07_experience_gate",
      numerator: passedExperience,
      denominator: experienceNames.length,
      rate_pct: roundedRate(passedExperience, experienceNames.length),
      measured_value: experienceSteps.map((step) => (
        `${String(step.name)}=${typeof step.observed_ms === "number" ? `${Math.round(step.observed_ms)}ms` : "—"}`
      )).join(" · "),
      details: sanitizeArtifactValue(experienceSteps),
    })
    : metric("C1", {
      status: "not_assessable",
      source: "sgoal07_experience_gate",
      note: "本轮没有三项完整体验门证据。",
      details: experienceSteps,
    });

  const feedbackProbes = input.smokeAssessable && Array.isArray(input.smokeSummary?.feedback_probes)
    ? input.smokeSummary.feedback_probes
    : [];
  const timelyFeedback = feedbackProbes.filter((probe) => probe.ok === true).length;
  const c2 = feedbackProbes.length > 0
    ? metric("C2", {
      status: timelyFeedback === feedbackProbes.length ? "passed" : "failed",
      source: "sgoal06_smoke_backend",
      numerator: timelyFeedback,
      denominator: feedbackProbes.length,
      rate_pct: roundedRate(timelyFeedback, feedbackProbes.length),
      measured_value: `${timelyFeedback}/${feedbackProbes.length}`,
      details: sanitizeArtifactValue(feedbackProbes),
    })
    : metric("C2", {
      status: "not_assessable",
      source: "sgoal06_smoke_backend",
      note: "本轮没有写动作反馈探针。",
    });

  const c3 = input.businessLanguage.ok
    ? metric("C3", {
      status: "passed",
      source: "business_language_guard",
      numerator: input.businessLanguage.compliant_files ?? input.businessLanguage.assessed_files,
      denominator: input.businessLanguage.assessed_files,
      rate_pct: input.businessLanguage.rate_pct ?? 100,
      measured_value: `${input.businessLanguage.compliant_files ?? input.businessLanguage.assessed_files}/${input.businessLanguage.assessed_files}`,
      details: { guard_files: input.businessLanguage.guard_files },
    })
    : metric("C3", {
      status: "failed",
      source: "business_language_guard",
      denominator: input.businessLanguage.assessed_files,
      note: "业务话守卫未通过，不能把部分扫描结果冒充覆盖率。",
      details: {
        guard_files: input.businessLanguage.guard_files,
        error: input.businessLanguage.error ? artifactText(input.businessLanguage.error) : undefined,
      },
    });

  return [b1, c1, c2, c3];
}

export function parseKimiUxMetrics(
  raw: KimiUxEvalInput,
  expected: { baselineCommit: string; targetEnvironment: string },
): UxMetric[] {
  if (raw.schema_version !== "kimi-ux-eval.v1") {
    throw new Error("KIMI-UX-EVAL 的 schema_version 必须是 kimi-ux-eval.v1");
  }
  if (raw.baseline_commit !== expected.baselineCommit) {
    throw new Error("KIMI-UX-EVAL 的 baseline_commit 与本轮不一致");
  }
  if (raw.target_environment !== expected.targetEnvironment) {
    throw new Error("KIMI-UX-EVAL 的 target_environment 与本轮不一致");
  }
  if (!Array.isArray(raw.metrics)) throw new Error("KIMI-UX-EVAL 缺少 metrics 数组");

  const byId = new Map<string, KimiMetricInput>();
  for (const item of raw.metrics) {
    if (item && typeof item === "object") {
      const candidate = item as KimiMetricInput;
      if (typeof candidate.id === "string") byId.set(candidate.id, candidate);
    }
  }

  return kimiMetricIds.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) return notAssessableKimiMetric(id, `KIMI-UX-EVAL 未提供 ${id}。`);
    if (!["passed", "failed", "not_assessable"].includes(String(candidate.status))) {
      throw new Error(`KIMI-UX-EVAL 的 ${id}.status 非法`);
    }
    return metric(id, {
      status: candidate.status as UxMetricStatus,
      source: "KIMI-UX-EVAL",
      numerator: typeof candidate.numerator === "number" ? candidate.numerator : undefined,
      denominator: typeof candidate.denominator === "number" ? candidate.denominator : undefined,
      rate_pct: typeof candidate.rate_pct === "number" ? candidate.rate_pct : undefined,
      measured_value: typeof candidate.measured_value === "string"
        ? artifactText(candidate.measured_value)
        : undefined,
      details: sanitizeArtifactValue(candidate.details),
      note: typeof candidate.note === "string" ? artifactText(candidate.note) : undefined,
    });
  });
}

export function missingKimiUxMetrics(note = "本轮未找到 KIMI-UX-EVAL 产物。"): UxMetric[] {
  return kimiMetricIds.map((id) => notAssessableKimiMetric(id, note));
}

export function buildUxMetricsRun(input: {
  startedAt: Date;
  finishedAt: Date;
  triggerReason: string;
  targetEnvironment: string;
  targetBaseUrl: string;
  baselineCommit: string;
  solMetrics: UxMetric[];
  kimiMetrics: UxMetric[];
  sourceArtifacts: UxMetricsRun["source_artifacts"];
  warnings?: string[];
}): UxMetricsRun {
  const allMetricsById = new Map<UxMetricId, UxMetric>();
  for (const item of [...input.kimiMetrics, ...input.solMetrics]) allMetricsById.set(item.id, item);
  const metrics = (Object.keys(metricDefinitions) as UxMetricId[]).map((id) => (
    allMetricsById.get(id)
    ?? metric(id, {
      status: "not_assessable",
      source: id === "B3"
        ? "unassigned"
        : id.startsWith("C") || id === "B1"
          ? "sgoal06_smoke_backend"
          : "KIMI-UX-EVAL",
      note: "本轮没有该指标的可复核证据。",
    })
  ));
  const b1 = metrics.find((item) => item.id === "B1");
  const b2 = metrics.find((item) => item.id === "B2");
  const a1 = metrics.find((item) => item.id === "A1");
  return {
    run_id: `${input.finishedAt.toISOString()}-${input.targetEnvironment}-${input.baselineCommit.slice(0, 12)}`,
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    trigger_reason: artifactText(input.triggerReason),
    target_environment: input.targetEnvironment,
    target_base_url: artifactText(input.targetBaseUrl),
    baseline_commit: input.baselineCommit,
    status: statusFromMetrics(metrics),
    dashboard_summary: {
      task_completion: fraction(b1),
      zero_guidance_completion: fraction(b2),
      jump_ratio_compliance: fraction(a1),
    },
    metrics,
    source_artifacts: input.sourceArtifacts,
    warnings: (input.warnings ?? []).map(artifactText),
  };
}

export async function appendUxMetricsRun(file: string, run: UxMetricsRun): Promise<void> {
  let current: UxMetricsDocument = {
    schema_version: "ux-metrics.v1",
    source_of_truth: "docs/design/ux-metrics.md",
    updated_at: run.finished_at,
    runs: [],
  };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<UxMetricsDocument>;
    if (
      parsed.schema_version !== "ux-metrics.v1"
      || parsed.source_of_truth !== "docs/design/ux-metrics.md"
      || !Array.isArray(parsed.runs)
    ) {
      throw new Error("已有 ux-metrics.json 与 ux-metrics.v1 不兼容");
    }
    current = parsed as UxMetricsDocument;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }

  const runs = current.runs.filter((item) => item.run_id !== run.run_id);
  runs.push(run);
  const next: UxMetricsDocument = {
    ...current,
    updated_at: run.finished_at,
    runs,
  };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function markdownText(value: unknown): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return artifactText(text)
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, " ")
    .trim() || "—";
}

function measured(metricValue: UxMetric): string {
  if (metricValue.measured_value) return metricValue.measured_value;
  if (typeof metricValue.numerator === "number" && typeof metricValue.denominator === "number") {
    return `${metricValue.numerator}/${metricValue.denominator}`;
  }
  if (typeof metricValue.rate_pct === "number") return `${metricValue.rate_pct}%`;
  return "—";
}

export function buildUxMetricsMarkdown(run: UxMetricsRun, uxMetricsPath: string): string {
  const statusLabel: Record<UxMetricStatus, string> = {
    passed: "通过",
    failed: "红",
    not_assessable: "未评估",
  };
  return [
    "### UX 指标",
    "",
    `- 总榜 JSON：\`${markdownText(uxMetricsPath)}\``,
    `- 仪表盘摘要：任务完成 ${run.dashboard_summary.task_completion} · 零指导 ${run.dashboard_summary.zero_guidance_completion} · 跳数达标 ${run.dashboard_summary.jump_ratio_compliance}`,
    "",
    "指标 | 结果 | 实测 | 达标线 | 来源",
    "--- | --- | --- | --- | ---",
    ...run.metrics.map((item) => [
      `${item.id} ${item.name}`,
      statusLabel[item.status],
      measured(item),
      item.target,
      item.source,
    ].map(markdownText).join(" | ")),
    "",
    ...(run.warnings.length > 0
      ? ["#### UX 证据提醒", "", ...run.warnings.map((warning) => `- ${markdownText(warning)}`), ""]
      : []),
  ].join("\n");
}
