import { createHash } from "node:crypto";

export const TARGET_WORKFLOW = "v011-required-checks";
export const TARGET_WORKFLOW_FILE = "ci.yml";
export const TARGET_BRANCH = "dev";
export const LIVE_ISSUE_TITLE = `CI RED · ${TARGET_BRANCH} · ${TARGET_WORKFLOW}`;
export const SYNTHETIC_ISSUE_TITLE = `CI HEALTH WATCH SYNTHETIC · ${TARGET_BRANCH} · ${TARGET_WORKFLOW}`;

const STATE_MARKER = "ci-health-watch-state";
const RED_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);
const ERROR_HINT = /\b(?:err(?:or)?|fail(?:ed|ure)?|missing|not in sync|not found|timed? out)\b/i;
const REMINDER_THRESHOLDS = [
  { key: "60m", milliseconds: 60 * 60 * 1_000 },
  { key: "4h", milliseconds: 4 * 60 * 60 * 1_000 },
];

function asString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function durationLabel(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} 小时` : `${hours} 小时 ${remainder} 分钟`;
}

function markdownCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

export function sanitizeErrorLine(value) {
  let line = asString(value, "未取得稳定错误首行");
  line = line
    .replaceAll(/\u001B\[[0-9;]*m/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(authorization|password|passwd|token|secret|api[_ -]?key|access[_ -]?key)\b\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/([?&](?:key|token|signature|secret|password)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\b(postgres(?:ql)?):\/\/[^@\s]+@/gi, "$1://<redacted>@")
    .replace(/\b(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?<redacted>")
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "<redacted>")
    .trim();
  if (!line) line = "未取得稳定错误首行";
  return line.slice(0, 240);
}

export function routeFailure({ job = "", step = "", errorLine = "" }) {
  const text = `${job} ${step} ${errorLine}`.toLowerCase();
  if (/npm ci|npm install|lockfile|package-lock|dependency|dependencies/.test(text)) return "lock/install";
  if (/architecture|架构/.test(text)) return "architecture";
  if (/typecheck|type check|typescript|tsc/.test(text)) return "typecheck";
  if (/postgres|postgre|test:.*-db|pg\d*|\bs67\b|\bs84\b|seed audio|object context|asset usage/.test(text)) return "PostgreSQL";
  if (/node test|test:node|node --test|npm test|\btest\b/.test(text)) return "node test";
  if (/\bbuild\b|vite build/.test(text)) return "build";
  return "unclassified";
}

export function failureSignature({ job, step, errorLine }) {
  return createHash("sha256")
    .update(`${asString(job, "unknown-job")}\n${asString(step, "unknown-step")}\n${sanitizeErrorLine(errorLine)}`)
    .digest("hex")
    .slice(0, 16);
}

function encodeState(state) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeStoredState(body) {
  if (typeof body !== "string") return null;
  const match = body.match(new RegExp(`<!-- ${STATE_MARKER}:([A-Za-z0-9_-]+) -->`));
  if (!match?.[1]) return null;
  try {
    const state = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    if (state?.schema_version !== 1 || !["red", "green"].includes(state.state)) return null;
    return state;
  } catch {
    return null;
  }
}

export function planHealthTransition({
  observation,
  storedState = null,
  issueOpen = false,
  now = observation.observed_at,
}) {
  if (observation.state === "not_assessable") {
    return { operation: "noop", comments: [], nextState: storedState };
  }

  if (observation.state === "green") {
    if (!storedState || storedState.state !== "red" || !issueOpen) {
      return { operation: "noop", comments: [], nextState: storedState };
    }
    return {
      operation: "recover",
      comments: [{
        kind: "recovered",
        duration_ms: new Date(now).getTime() - new Date(storedState.incident_started_at).getTime(),
      }],
      nextState: {
        ...storedState,
        state: "green",
        recovered_at: iso(now),
        last_observed_at: iso(observation.observed_at),
        last_run_id: observation.run_id ?? storedState.last_run_id,
      },
    };
  }

  const previousRed = storedState?.state === "red";
  const signatureChanged = previousRed && storedState.signature !== observation.signature;
  const incidentStartedAt = previousRed ? storedState.incident_started_at : iso(observation.observed_at);
  const previousReminders = previousRed && Array.isArray(storedState.reminders)
    ? storedState.reminders
    : [];
  const elapsed = new Date(now).getTime() - new Date(incidentStartedAt).getTime();
  const dueReminders = REMINDER_THRESHOLDS
    .filter(({ key, milliseconds }) => elapsed >= milliseconds && !previousReminders.includes(key))
    .map(({ key }) => key);
  const reminders = [...new Set([...previousReminders, ...dueReminders])];
  const sameRun = previousRed
    && String(storedState.last_run_id ?? "") === String(observation.run_id ?? "")
    && !signatureChanged;
  const comments = [];
  if (signatureChanged) {
    comments.push({
      kind: "signature_changed",
      previous_signature: storedState.signature,
      current_signature: observation.signature,
    });
  }
  for (const reminder of dueReminders) comments.push({ kind: `sustained_${reminder}`, duration_ms: elapsed });

  const nextState = {
    schema_version: 1,
    state: "red",
    incident_started_at: incidentStartedAt,
    signature_started_at: signatureChanged || !previousRed
      ? iso(observation.observed_at)
      : storedState.signature_started_at,
    signature: observation.signature,
    reminders,
    last_observed_at: iso(observation.observed_at),
    last_run_id: observation.run_id ?? null,
  };

  if (!storedState) return { operation: "create", comments, nextState };
  if (!issueOpen) return { operation: "reopen", comments, nextState };
  if (sameRun && comments.length === 0) return { operation: "noop", comments, nextState: storedState };
  return { operation: "update", comments, nextState };
}

function issueBody({ observation, state, assignees = [] }) {
  const duration = state.state === "red"
    ? durationLabel(new Date(observation.observed_at).getTime() - new Date(state.incident_started_at).getTime())
    : "已恢复";
  const owner = assignees.length > 0 ? assignees.map((name) => `@${name}`).join("、") : "尚未认领";
  const status = state.state === "red" ? "🔴 RED" : "🟢 GREEN";
  const runLink = observation.run_url ? `[${observation.run_id}](${observation.run_url})` : "—";
  return [
    `# ${TARGET_BRANCH} CI 健康状态`,
    "",
    "> 本 issue 由 `ci-health-watch` 自动维护。同一工作流与分支只维护这一条；请勿手工改标题或删除末尾状态标记。",
    "",
    `| 字段 | 当前值 |`,
    `| --- | --- |`,
    `| 状态 | ${status} |`,
    `| 首次失败 | ${markdownCell(state.incident_started_at ?? "—")} |`,
    `| 最近观测 | ${markdownCell(observation.observed_at)} |`,
    `| 持续时间 | ${duration} |`,
    `| 基线 SHA | \`${markdownCell(observation.head_sha ?? "—")}\` |`,
    `| Actions run | ${runLink} |`,
    `| 失败 job | ${markdownCell(observation.failed_job ?? "—")} |`,
    `| 首个失败 step | ${markdownCell(observation.failed_step ?? "—")} |`,
    `| 稳定错误首行 | \`${markdownCell(observation.error_line ?? "—")}\` |`,
    `| 失败签名 | \`${markdownCell(observation.signature ?? "—")}\` |`,
    `| 建议分流 | ${markdownCell(observation.routing ?? "—")} |`,
    `| 当前值守 | ${owner} |`,
    "",
    "响应口径：工作时段 30 分钟内认领；持续红 60 分钟、4 小时只在本 issue 各提醒一次。",
    "",
    `<!-- ${STATE_MARKER}:${encodeState(state)} -->`,
  ].join("\n");
}

function commentBody(comment, observation) {
  if (comment.kind === "signature_changed") {
    return [
      "失败签名发生变化，仍在同一健康 issue 继续跟踪。",
      "",
      `- 原签名：\`${comment.previous_signature}\``,
      `- 新签名：\`${comment.current_signature}\``,
      `- 当前失败：${markdownCell(observation.failed_job)} / ${markdownCell(observation.failed_step)}`,
      `- Run：${observation.run_url ? `[${observation.run_id}](${observation.run_url})` : "—"}`,
    ].join("\n");
  }
  if (comment.kind === "recovered") {
    return [
      `CI 已恢复，连续红灯持续 ${durationLabel(comment.duration_ms)}。`,
      "",
      `- 恢复 run：${observation.run_url ? `[${observation.run_id}](${observation.run_url})` : "—"}`,
      `- 恢复 SHA：\`${markdownCell(observation.head_sha ?? "—")}\``,
      `- 恢复时间：${observation.observed_at}`,
    ].join("\n");
  }
  return [
    `CI 已连续红灯 ${durationLabel(comment.duration_ms)}，请确认当前值守人与处理计划。`,
    "",
    `- 当前签名：\`${observation.signature}\``,
    `- 最近 run：${observation.run_url ? `[${observation.run_id}](${observation.run_url})` : "—"}`,
  ].join("\n");
}

function logText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return "";
}

export function firstStableErrorLine(log) {
  const lines = String(log ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "").trim())
    .filter((line) => line && !/^##\[(?:group|endgroup)\]/.test(line));
  const preferred = lines.find((line) => ERROR_HINT.test(line) && !/Process completed with exit code/i.test(line));
  return sanitizeErrorLine(preferred ?? lines.find((line) => ERROR_HINT.test(line)) ?? "未取得稳定错误首行");
}

async function failureDetails({ github, owner, repo, runId }) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: runId,
    filter: "latest",
    per_page: 100,
  });
  const failedJob = jobs.find((job) => RED_CONCLUSIONS.has(job.conclusion));
  const failedStep = failedJob?.steps?.find((step) => RED_CONCLUSIONS.has(step.conclusion));
  let errorLine = "未取得稳定错误首行";
  if (failedJob?.id) {
    try {
      const response = await github.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: failedJob.id,
      });
      errorLine = firstStableErrorLine(logText(response.data));
    } catch {
      // 日志可能过期或被 GitHub 暂时拒绝；job/step 仍足以形成稳定、可跟踪的退化签名。
    }
  }
  const detail = {
    failed_job: asString(failedJob?.name, "unknown-job"),
    failed_step: asString(failedStep?.name, "unknown-step"),
    error_line: errorLine,
  };
  return {
    ...detail,
    routing: routeFailure({
      job: detail.failed_job,
      step: detail.failed_step,
      errorLine: detail.error_line,
    }),
    signature: failureSignature({
      job: detail.failed_job,
      step: detail.failed_step,
      errorLine: detail.error_line,
    }),
  };
}

async function liveObservation({ github, owner, repo, source }) {
  const response = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: TARGET_WORKFLOW_FILE,
    branch: TARGET_BRANCH,
    event: "push",
    per_page: 20,
  });
  const run = response.data.workflow_runs
    .filter((item) => item.head_branch === TARGET_BRANCH && item.event === "push")
    .sort((left, right) => Number(right.run_number ?? right.id) - Number(left.run_number ?? left.id))[0];
  if (!run) {
    return {
      state: "not_assessable",
      source,
      observed_at: new Date().toISOString(),
      reason: "没有找到已完成的 dev push 运行",
    };
  }
  if (run.status !== "completed") {
    return {
      state: "not_assessable",
      source,
      observed_at: new Date().toISOString(),
      run_id: run.id,
      run_url: run.html_url,
      head_sha: run.head_sha,
      conclusion: run.conclusion,
      reason: `最新 dev run ${run.id} 尚未完成（${run.status}）`,
    };
  }
  const base = {
    source,
    observed_at: iso(run.updated_at ?? run.created_at),
    run_id: run.id,
    run_url: run.html_url,
    head_sha: run.head_sha,
    conclusion: run.conclusion,
  };
  if (run.conclusion === "success") return { ...base, state: "green" };
  if (!RED_CONCLUSIONS.has(run.conclusion)) {
    return {
      ...base,
      state: "not_assessable",
      reason: `最新运行结论 ${run.conclusion ?? "unknown"} 不能判定为红或绿`,
    };
  }
  return {
    ...base,
    state: "red",
    ...await failureDetails({ github, owner, repo, runId: run.id }),
  };
}

function syntheticObservation({ state, signature, source }) {
  const observedAt = new Date().toISOString();
  if (state === "not_assessable") {
    return { state, source, observed_at: observedAt, reason: "合成不可判定状态" };
  }
  if (state === "green") {
    return {
      state,
      source,
      observed_at: observedAt,
      run_id: `synthetic-${Date.now()}`,
      run_url: "",
      head_sha: "synthetic",
      conclusion: "success",
    };
  }
  const detail = {
    failed_job: "synthetic-verify",
    failed_step: "state reducer",
    error_line: sanitizeErrorLine(signature || "synthetic failure"),
  };
  return {
    state: "red",
    source,
    observed_at: observedAt,
    run_id: `synthetic-${Date.now()}`,
    run_url: "",
    head_sha: "synthetic",
    conclusion: "failure",
    ...detail,
    routing: "unclassified",
    signature: failureSignature({
      job: detail.failed_job,
      step: detail.failed_step,
      errorLine: detail.error_line,
    }),
  };
}

async function managedIssue({ github, owner, repo, title }) {
  const recent = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  const recentMatch = recent.data
    .filter((issue) => !issue.pull_request && issue.title === title && decodeStoredState(issue.body))
    .sort((left, right) => right.number - left.number)[0];
  if (recentMatch) return recentMatch;

  const searched = await github.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue in:title "${title}"`,
    per_page: 10,
  });
  return searched.data.items
    .filter((issue) => !issue.pull_request && issue.title === title && decodeStoredState(issue.body))
    .sort((left, right) => right.number - left.number)[0] ?? null;
}

async function applyPlan({ github, owner, repo, issue, title, observation, plan }) {
  const assignees = issue?.assignees?.map((assignee) => assignee.login) ?? [];
  const body = plan.nextState
    ? issueBody({ observation, state: plan.nextState, assignees })
    : issue?.body ?? "";
  let current = issue;

  if (plan.operation === "create") {
    const response = await github.rest.issues.create({ owner, repo, title, body });
    current = response.data;
  } else if (plan.operation === "reopen") {
    const response = await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      state: "open",
      state_reason: "reopened",
      body,
    });
    current = response.data;
  } else if (plan.operation === "update") {
    const response = await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      body,
    });
    current = response.data;
  }

  if (current && plan.operation !== "noop") {
    for (const comment of plan.comments) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: current.number,
        body: commentBody(comment, observation),
      });
    }
  }

  if (current && plan.operation === "recover") {
    for (const comment of plan.comments) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: current.number,
        body: commentBody(comment, observation),
      });
    }
    const response = await github.rest.issues.update({
      owner,
      repo,
      issue_number: current.number,
      state: "closed",
      state_reason: "completed",
      body,
    });
    current = response.data;
  }
  return current;
}

async function writeSummary({ core, observation, plan, issue }) {
  const row = [
    { data: "判定", header: true },
    { data: "值", header: true },
  ];
  await core.summary
    .addHeading("dev CI 健康巡检", 2)
    .addTable([
      row,
      ["状态", observation.state],
      ["来源", observation.source],
      ["Run", observation.run_url ? `${observation.run_id} ${observation.run_url}` : "—"],
      ["失败签名", observation.signature ?? "—"],
      ["归并动作", plan.operation],
      ["健康 issue", issue?.html_url ?? "—"],
      ["说明", observation.reason ?? "—"],
    ])
    .write();
}

export async function run({ github, context, core, inputs = {} }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const syntheticState = asString(inputs.synthetic_state, "live");
  const synthetic = syntheticState !== "live";
  const observation = synthetic
    ? syntheticObservation({
      state: syntheticState,
      signature: asString(inputs.synthetic_signature),
      source: "workflow_dispatch:synthetic",
    })
    : await liveObservation({
      github,
      owner,
      repo,
      source: context.eventName,
    });
  const title = synthetic ? SYNTHETIC_ISSUE_TITLE : LIVE_ISSUE_TITLE;
  const issue = await managedIssue({ github, owner, repo, title });
  const storedState = decodeStoredState(issue?.body);
  const plan = planHealthTransition({
    observation,
    storedState,
    issueOpen: issue?.state === "open",
    now: new Date().toISOString(),
  });
  const updatedIssue = await applyPlan({
    github,
    owner,
    repo,
    issue,
    title,
    observation,
    plan,
  });
  await writeSummary({ core, observation, plan, issue: updatedIssue ?? issue });
}
