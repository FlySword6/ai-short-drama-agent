import assert from "node:assert/strict";
import test from "node:test";
import {
  paidE2eRecoveryAction,
  paidE2eResultExitCode,
  paidE2eUnclosedRecoveryResult,
  parsePaidE2eArgs,
} from "./fable007-paid-e2e.mjs";

const RUN_ID = "ark-image-20260804-a";

test("FABLE-007 付费 E2E 预检不接受付费确认", () => {
  assert.deepEqual(
    parsePaidE2eArgs([
      "--preflight",
      "--target", "dev",
      "--incremental-budget-fen", "30",
    ]),
    {
      mode: "preflight",
      target: "dev",
      incrementalBudgetFen: 30,
      confirmPaid: false,
    },
  );
  assert.throws(() => parsePaidE2eArgs([
    "--preflight",
    "--target", "dev",
    "--incremental-budget-fen", "30",
    "--confirm-paid",
  ]), /PREFLIGHT_MUST_NOT_CONFIRM/);
});

test("FABLE-007 付费 E2E 只接受 dev、30 分增量和明确确认", () => {
  assert.deepEqual(
    parsePaidE2eArgs([
      "--run",
      "--target", "dev",
      "--incremental-budget-fen", "30",
      "--confirm-paid",
      "--run-id", RUN_ID,
    ]),
    {
      mode: "run",
      target: "dev",
      incrementalBudgetFen: 30,
      confirmPaid: true,
      runId: RUN_ID,
    },
  );
  assert.throws(() => parsePaidE2eArgs([
    "--run",
    "--target", "prod",
    "--incremental-budget-fen", "30",
    "--confirm-paid",
    "--run-id", RUN_ID,
  ]), /TARGET_MUST_BE_DEV/);
  assert.throws(() => parsePaidE2eArgs([
    "--run",
    "--target", "dev",
    "--incremental-budget-fen", "31",
    "--confirm-paid",
    "--run-id", RUN_ID,
  ]), /BUDGET_MUST_BE_30/);
  assert.throws(() => parsePaidE2eArgs([
    "--run",
    "--target", "dev",
    "--incremental-budget-fen", "30",
    "--run-id", RUN_ID,
  ]), /CONFIRMATION_REQUIRED/);
  assert.throws(() => parsePaidE2eArgs([
    "--run",
    "--target", "dev",
    "--incremental-budget-fen", "30",
    "--confirm-paid",
  ]), /RUN_ID_INVALID/);
});

test("FABLE-007 recovery 只接受稳定 run id，且 submitting/outcome-unknown 永不重提", () => {
  assert.deepEqual(
    parsePaidE2eArgs([
      "--recover",
      "--target", "dev",
      "--incremental-budget-fen", "30",
      "--confirm-paid",
      "--run-id", RUN_ID,
    ]),
    {
      mode: "recover",
      target: "dev",
      incrementalBudgetFen: 30,
      confirmPaid: true,
      runId: RUN_ID,
    },
  );
  assert.equal(paidE2eRecoveryAction({
    status: "running",
    phase: "submitting",
    errorCode: null,
  }), "stop_submission_outcome_unknown");
  assert.equal(paidE2eRecoveryAction({
    status: "failed",
    phase: "submitting",
    errorCode: "SUBMISSION_OUTCOME_UNKNOWN",
  }), "stop_submission_outcome_unknown");
  assert.equal(paidE2eRecoveryAction({
    status: "pending",
    phase: "created",
    errorCode: null,
  }), "claim_and_resume");
  assert.equal(paidE2eRecoveryAction({
    status: "running",
    phase: "provider_queued",
    errorCode: null,
  }), "claim_and_resume");
  assert.equal(paidE2eRecoveryAction({
    status: "succeeded",
    phase: "complete",
    errorCode: null,
  }), "audit_terminal_success");
  assert.equal(paidE2eRecoveryAction({
    status: "failed",
    phase: "complete",
    errorCode: "PROVIDER_REJECTED",
  }), "stop_terminal_failure");
  assert.equal(paidE2eResultExitCode({
    ok: false,
    recoveryClosed: false,
    recoveryAction: "stop_submission_outcome_unknown",
  }), 2);
  assert.equal(paidE2eResultExitCode({
    ok: true,
    recoveryClosed: true,
    recoveryAction: "audit_terminal_success",
  }), 0);
  assert.equal(paidE2eResultExitCode({
    ok: true,
    recoveryClosed: false,
    recoveryAction: "stop_terminal_failure",
  }), 2);
  assert.deepEqual(
    paidE2eUnclosedRecoveryResult("stop_submission_outcome_unknown", {
      providerSubmissionsByThisScript: 0,
      resubmissionRefused: true,
    }),
    {
      ok: false,
      mode: "recover",
      target: "dev",
      recoveryAction: "stop_submission_outcome_unknown",
      recoveryClosed: false,
      generation: {
        providerSubmissionsByThisScript: 0,
        resubmissionRefused: true,
      },
    },
  );
});

test("FABLE-007 付费 E2E 不回显凭据、TOS URL 或原始 API 错误", async () => {
  const file = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("./fable007-paid-e2e.mts", import.meta.url),
    "utf8",
  ));
  assert.match(file, /FABLE007_DEV_TOS_TARGET_SHA256/);
  assert.match(file, /settings\.postgresSchema !== "app"/);
  assert.match(file, /claimExactFreshAttempt/);
  assert.match(file, /claimExactRecoverableAttempt/);
  assert.match(file, /paidE2eIdempotencyKey\(runId\)/);
  assert.match(file, /stop_submission_outcome_unknown/);
  assert.match(file, /process\.exitCode = paidE2eResultExitCode\(result\)/);
  assert.match(file, /upload_receipt_plus_postgres_media_reference/);
  assert.match(file, /remoteObjectReadbackPerformed: false/);
  assert.match(file, /activeAttemptFingerprint/);
  assert.match(file, /costAlertLogger: \{ warn: \(\) => undefined \}/);
  assert.doesNotMatch(file, /process\.stdout\.write\([^;]*storageUrl/);
  assert.doesNotMatch(file, /process\.stderr\.write\([^)]*error\.message/);
  assert.doesNotMatch(file, /JSON\.stringify\([^)]*response\.json/);
});
