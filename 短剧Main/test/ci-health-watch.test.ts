import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  failureSignature,
  firstStableErrorLine,
  planHealthTransition,
  routeFailure,
  sanitizeErrorLine,
} from "../scripts/ci/ci-health-watch.mjs";

const red = (overrides: Record<string, unknown> = {}) => ({
  state: "red",
  observed_at: "2026-08-01T01:00:00.000Z",
  run_id: 100,
  run_url: "https://github.com/acme/repo/actions/runs/100",
  head_sha: "abc",
  failed_job: "verify",
  failed_step: "npm ci",
  error_line: "npm error Missing: ws@8.21.1 from lock file",
  routing: "lock/install",
  signature: "sig-a",
  ...overrides,
});

test("首次 red 创建唯一健康 issue 状态", () => {
  const plan = planHealthTransition({ observation: red() });
  assert.equal(plan.operation, "create");
  assert.equal(plan.nextState?.state, "red");
  assert.equal(plan.nextState?.signature, "sig-a");
  assert.deepEqual(plan.comments, []);
});

test("同签名同 run 的重复巡检不写 issue；新 run 只更新正文不刷评论", () => {
  const first = planHealthTransition({ observation: red() });
  const duplicate = planHealthTransition({
    observation: red(),
    storedState: first.nextState,
    issueOpen: true,
    now: "2026-08-01T01:15:00.000Z",
  });
  assert.equal(duplicate.operation, "noop");

  const nextRun = planHealthTransition({
    observation: red({ run_id: 101, observed_at: "2026-08-01T01:20:00.000Z" }),
    storedState: first.nextState,
    issueOpen: true,
    now: "2026-08-01T01:20:00.000Z",
  });
  assert.equal(nextRun.operation, "update");
  assert.deepEqual(nextRun.comments, []);
});

test("持续 60 分钟和 4 小时各提醒一次", () => {
  const first = planHealthTransition({ observation: red() });
  const oneHour = planHealthTransition({
    observation: red({ run_id: 101, observed_at: "2026-08-01T02:01:00.000Z" }),
    storedState: first.nextState,
    issueOpen: true,
    now: "2026-08-01T02:01:00.000Z",
  });
  assert.deepEqual(oneHour.comments.map((item) => item.kind), ["sustained_60m"]);

  const repeated = planHealthTransition({
    observation: red({ run_id: 102, observed_at: "2026-08-01T02:15:00.000Z" }),
    storedState: oneHour.nextState,
    issueOpen: true,
    now: "2026-08-01T02:15:00.000Z",
  });
  assert.deepEqual(repeated.comments, []);

  const fourHours = planHealthTransition({
    observation: red({ run_id: 103, observed_at: "2026-08-01T05:01:00.000Z" }),
    storedState: repeated.nextState,
    issueOpen: true,
    now: "2026-08-01T05:01:00.000Z",
  });
  assert.deepEqual(fourHours.comments.map((item) => item.kind), ["sustained_4h"]);
});

test("失败签名变化留在同一 issue 并追加一条变化记录", () => {
  const first = planHealthTransition({ observation: red() });
  const changed = planHealthTransition({
    observation: red({ run_id: 101, signature: "sig-b", failed_step: "typecheck" }),
    storedState: first.nextState,
    issueOpen: true,
  });
  assert.equal(changed.operation, "update");
  assert.deepEqual(changed.comments.map((item) => item.kind), ["signature_changed"]);
  assert.equal(changed.nextState?.signature, "sig-b");
});

test("red 转 green 时记录恢复并关闭；not_assessable 不冒充绿色", () => {
  const first = planHealthTransition({ observation: red() });
  const recovered = planHealthTransition({
    observation: {
      state: "green",
      observed_at: "2026-08-01T01:30:00.000Z",
      run_id: 102,
      run_url: "https://github.com/acme/repo/actions/runs/102",
      head_sha: "def",
    },
    storedState: first.nextState,
    issueOpen: true,
    now: "2026-08-01T01:30:00.000Z",
  });
  assert.equal(recovered.operation, "recover");
  assert.equal(recovered.comments[0]?.kind, "recovered");

  const unknown = planHealthTransition({
    observation: {
      state: "not_assessable",
      observed_at: "2026-08-01T01:31:00.000Z",
    },
    storedState: first.nextState,
    issueOpen: true,
  });
  assert.equal(unknown.operation, "noop");
  assert.equal(unknown.nextState?.state, "red");
});

test("失败签名和日志摘要稳定、脱敏并能分流", () => {
  const log = [
    "2026-08-01T00:00:00.000Z ##[group]Run npm ci",
    "2026-08-01T00:00:01.000Z npm error Missing: ws@8.21.1 from lock file token=abcdefghijklmnopqrstuvwxyz1234567890",
    "2026-08-01T00:00:02.000Z Process completed with exit code 1.",
  ].join("\n");
  const line = firstStableErrorLine(log);
  assert.match(line, /Missing: ws@8\.21\.1/);
  assert.doesNotMatch(line, /abcdefghijklmnopqrstuvwxyz/);
  assert.equal(routeFailure({ job: "verify", step: "npm ci", errorLine: line }), "lock/install");
  assert.equal(
    failureSignature({ job: "verify", step: "npm ci", errorLine: line }),
    failureSignature({ job: "verify", step: "npm ci", errorLine: line }),
  );
  assert.equal(sanitizeErrorLine("Authorization: Bearer-secret-value"), "Authorization=<redacted>");
});

// cron 的分钟字段展开成一天里的触发点，用来量「最长多久没人兜底」。
// 只认这个 workflow 会用到的两种写法：*/N 与逗号列表。
const scheduleGapMinutes = (cronExpression: string): number => {
  const [minuteField, hourField] = cronExpression.split(" ");
  assert.equal(hourField, "*", "兜底必须每小时都发生，不能只在某几个钟点");
  const stepped = minuteField.match(/^\*\/(\d+)$/);
  const minutes = stepped
    ? Array.from({ length: Math.ceil(60 / Number(stepped[1])) }, (_, index) => index * Number(stepped[1]))
    : minuteField.split(",").map(Number);
  assert.ok(minutes.length > 0 && minutes.every((minute) => Number.isInteger(minute)), "分钟字段无法解析");
  const sorted = [...minutes].sort((left, right) => left - right);
  const gaps = sorted.map((minute, index) => (index === 0 ? minute + 60 - sorted.at(-1)! : minute - sorted[index - 1]));
  return Math.max(...gaps);
};

test("workflow 合同：事件 + 不粗于认领窗口的兜底 + 最小权限，不 checkout 业务代码", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci-health-watch.yml", import.meta.url), "utf8");
  assert.match(workflow, /^name: ci-health-watch/m);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /v011-required-checks/);
  // 真实信号是 workflow_run；cron 只兜住丢事件的情况，所以不钉死具体数值，
  // 只要求它不粗于 ci-health-watch.mjs 对外承诺的「工作时段 30 分钟内认领」。
  const cron = workflow.match(/cron: "(.+?)"/)?.[1];
  assert.ok(cron, "必须保留 schedule 兜底，不能只靠 workflow_run");
  assert.ok(
    scheduleGapMinutes(cron) <= 30,
    `兜底间隔 ${scheduleGapMinutes(cron)} 分钟，超过了「30 分钟内认领」的响应口径`,
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /actions\/github-script@v9/);
  assert.match(workflow, /scripts\/ci\/ci-health-watch\.mjs/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, /secrets\.(?!GITHUB_TOKEN)/);
});
