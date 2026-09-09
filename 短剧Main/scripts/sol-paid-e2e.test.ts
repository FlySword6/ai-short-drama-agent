import assert from "node:assert/strict";
import test from "node:test";
import {
  paidAttemptAction,
  paidIdempotencyKey,
  parseSolPaidE2eArgs,
} from "./sol-paid-e2e.mjs";

const RUN_ID = "ark-paid-suite-20260804-a";

test("三模态预检固定 test 目标和 139 分上限，且不接受付费确认", () => {
  assert.deepEqual(parseSolPaidE2eArgs([
    "--preflight",
    "--target", "test",
    "--incremental-budget-fen", "139",
  ]), {
    mode: "preflight",
    target: "test",
    incrementalBudgetFen: 139,
    confirmPaid: false,
  });
  assert.throws(() => parseSolPaidE2eArgs([
    "--preflight",
    "--target", "test",
    "--incremental-budget-fen", "139",
    "--confirm-paid",
  ]), /PREFLIGHT_MUST_NOT_CONFIRM/);
});

test("真实运行拒绝 prod/dev、错误预算和缺少人工确认", () => {
  assert.deepEqual(parseSolPaidE2eArgs([
    "--run",
    "--target", "test",
    "--incremental-budget-fen", "139",
    "--confirm-paid",
    "--run-id", RUN_ID,
  ]), {
    mode: "run",
    target: "test",
    incrementalBudgetFen: 139,
    confirmPaid: true,
    runId: RUN_ID,
  });
  assert.throws(() => parseSolPaidE2eArgs([
    "--run",
    "--target", "dev",
    "--incremental-budget-fen", "139",
    "--confirm-paid",
    "--run-id", RUN_ID,
  ]), /TARGET_MUST_BE_TEST/);
  assert.throws(() => parseSolPaidE2eArgs([
    "--run",
    "--target", "test",
    "--incremental-budget-fen", "138",
    "--confirm-paid",
    "--run-id", RUN_ID,
  ]), /BUDGET_MUST_BE_139/);
  assert.throws(() => parseSolPaidE2eArgs([
    "--run",
    "--target", "test",
    "--incremental-budget-fen", "139",
    "--run-id", RUN_ID,
  ]), /CONFIRMATION_REQUIRED/);
});

test("稳定 run id 为三模态产生互不冲突的幂等键", () => {
  assert.equal(
    paidIdempotencyKey(RUN_ID, "image"),
    `sol-paid-e2e-${RUN_ID}-image`,
  );
  assert.equal(
    paidIdempotencyKey(RUN_ID, "video"),
    `sol-paid-e2e-${RUN_ID}-video`,
  );
  assert.equal(
    paidIdempotencyKey(RUN_ID, "audio"),
    `sol-paid-e2e-${RUN_ID}-audio`,
  );
});

test("只有 created/queued/running/provider_succeeded/persisting 可恢复，submitting 永不重提", () => {
  assert.equal(paidAttemptAction({
    status: "pending",
    phase: "created",
  }), "claim_and_resume");
  assert.equal(paidAttemptAction({
    status: "running",
    phase: "provider_queued",
  }), "claim_and_resume");
  assert.equal(paidAttemptAction({
    status: "running",
    phase: "provider_succeeded",
  }), "claim_and_resume");
  assert.equal(paidAttemptAction({
    status: "failed",
    phase: "submitting",
    errorCode: "SUBMISSION_OUTCOME_UNKNOWN",
  }), "submission_outcome_unknown");
  assert.equal(paidAttemptAction({
    status: "succeeded",
    phase: "complete",
  }), "audit_success");
  assert.equal(paidAttemptAction({
    status: "failed",
    phase: "complete",
  }), "terminal_failure");
});

test("执行器不输出凭据、原始 URL、prompt 或 provider 原始响应", async () => {
  const file = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("./sol-paid-e2e.mts", import.meta.url),
    "utf8",
  ));
  assert.match(file, /assertApprovedCredential/);
  assert.match(file, /SOL_PAID_E2E_PROVIDER_ALLOWLIST_MUST_BE_ARK_ONLY/);
  assert.match(file, /SOL_PAID_E2E_NEWAPI_MUST_REMAIN_DISABLED/);
  assert.match(file, /SOL_PAID_E2E_SUBMISSION_OUTCOME_UNKNOWN/);
  assert.match(file, /SOL_PAID_E2E_PERSISTENCE_ROOT_CAUSE_REQUIRED/);
  assert.match(file, /SOL_PAID_E2E_REQUIRED_MIGRATION_MISSING/);
  assert.match(file, /SOL_PAID_E2E_REQUIRED_SCHEMA_COLUMN_MISSING/);
  assert.match(file, /remoteHeadReadback: true/);
  assert.match(file, /remoteGetReadback: true/);
  assert.match(file, /remoteSha256Matched: true/);
  assert.match(file, /remote\.sha256 !== artifact\.sha256/);
  assert.match(file, /providerCostRows\.length !== 1/);
  assert.match(file, /allPlatformChargesPriced: true/);
  assert.ok(
    file.indexOf("await assertRequiredGenerationSchema")
      < file.indexOf("assertRunAuthorization(options"),
  );
  assert.ok(
    file.indexOf("assertRunAuthorization(options")
      < file.indexOf("const fixture = await ensureFixture"),
  );
  assert.doesNotMatch(file, /process\.stdout\.write\([^;]*storageUrl/);
  assert.doesNotMatch(file, /process\.stderr\.write\([^)]*error\.message/);
  assert.doesNotMatch(file, /providerResponse:\s*result/);
});
