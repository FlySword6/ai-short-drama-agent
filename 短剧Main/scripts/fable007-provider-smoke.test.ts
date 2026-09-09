import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertApprovedCredential,
  assertFable007DeploymentIdentity,
  assertImageAspectRatio,
  completeTierSmokeLedger,
  parseArgs,
  reserveTierSmokeLedger,
  SmokeBudget,
} from "./fable007-provider-smoke.mjs";

test("FABLE-007 只接受明确 dev 参数和覆盖固定上限的预算", () => {
  assert.deepEqual(
    parseArgs(["--probe", "ark-image", "--target", "dev", "--budget-fen", "60", "--confirm-paid"]),
    { probe: "ark-image", target: "dev", budgetFen: 60, confirmPaid: true },
  );
  assert.throws(
    () => parseArgs(["--probe", "ark-image", "--target", "dev", "--budget-fen", "59", "--confirm-paid"]),
    /必须覆盖该探针/,
  );
});

test("档位解冻探针只接受首批精确 Ark 档位，并按逐档成本设预算", () => {
  assert.deepEqual(
    parseArgs([
      "--probe",
      "ark-image",
      "--tier-id",
      "img-seedream5pro-916-1k-1",
      "--tier-ledger-file",
      "/tmp/tier-smoke-ledger.json",
      "--target",
      "dev",
      "--budget-fen",
      "30",
      "--confirm-paid",
    ]),
    {
      probe: "ark-image",
      tierId: "img-seedream5pro-916-1k-1",
      tierLedgerFile: "/tmp/tier-smoke-ledger.json",
      target: "dev",
      budgetFen: 30,
      confirmPaid: true,
    },
  );
  assert.deepEqual(
    parseArgs([
      "--probe",
      "ark-video",
      "--tier-id",
      "vid-seedance20fast-169-480p",
      "--tier-ledger-file",
      "/tmp/tier-smoke-ledger.json",
      "--target",
      "dev",
      "--budget-fen",
      "160",
      "--confirm-paid",
    ]),
    {
      probe: "ark-video",
      tierId: "vid-seedance20fast-169-480p",
      tierLedgerFile: "/tmp/tier-smoke-ledger.json",
      target: "dev",
      budgetFen: 160,
      confirmPaid: true,
    },
  );
  assert.throws(
    () => parseArgs([
      "--probe",
      "ark-image",
      "--tier-id",
      "img-seedream5pro-916-1k-1",
      "--target",
      "dev",
      "--budget-fen",
      "30",
      "--confirm-paid",
    ]),
    /tier-ledger-file/,
  );
  assert.throws(
    () => parseArgs([
      "--probe",
      "ark-video",
      "--tier-id",
      "vid-seedance20fast-169-480p",
      "--tier-ledger-file",
      "/tmp/tier-smoke-ledger.json",
      "--target",
      "dev",
      "--budget-fen",
      "159",
      "--confirm-paid",
    ]),
    /必须覆盖该探针 160 分的上限/,
  );
  assert.throws(
    () => parseArgs([
      "--probe",
      "ark-image",
      "--tier-id",
      "vid-seedance20fast-169-480p",
      "--tier-ledger-file",
      "/tmp/tier-smoke-ledger.json",
      "--target",
      "dev",
      "--budget-fen",
      "160",
      "--confirm-paid",
    ]),
    /不在该 Ark 探针的已审核解冻批次/,
  );
  assert.throws(
    () => parseArgs([
      "--probe",
      "ark-image",
      "--tier-id",
      "unknown-tier",
      "--tier-ledger-file",
      "/tmp/tier-smoke-ledger.json",
      "--target",
      "dev",
      "--budget-fen",
      "5000",
      "--confirm-paid",
    ]),
    /不在该 Ark 探针的已审核解冻批次/,
  );
});

test("档位付费探针先持久化占额，同一档不能跨进程语义重跑", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tier-smoke-ledger-test-"));
  const file = path.join(directory, "ledger.json");
  try {
    const reservationId = await reserveTierSmokeLedger(
      file,
      "img-seedream5pro-169-1k-1",
      30,
    );
    await assert.rejects(
      reserveTierSmokeLedger(file, "img-seedream5pro-169-1k-1", 30),
      /ALREADY_RESERVED_OR_COMPLETED/,
    );
    await completeTierSmokeLedger(
      file,
      "img-seedream5pro-169-1k-1",
      reservationId,
      {
        ok: true,
        probeKey: "tier-image",
        tierKey: "img-seedream5pro-169-1k-1",
        declaredCostCeilingFen: 30,
        reservedCostFen: 30,
        providerTaskFingerprint: "a".repeat(16),
        artifact: {
          mediaKind: "image",
          contentType: "image/webp",
          extension: "webp",
          bytesBeforeLabel: 10,
          bytesAfterLabel: 20,
          sha256BeforeLabel: "b".repeat(64),
          sha256AfterLabel: "c".repeat(64),
          platformAigcReadback: true,
          providerOriginPreserved: true,
        },
      },
    );
    const ledger = JSON.parse(await readFile(file, "utf8")) as {
      entries: Array<{
        status: string;
        reservedFen: number;
        providerTaskFingerprint?: string;
        artifactSha256?: string;
      }>;
    };
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0]?.status, "completed");
    assert.equal(ledger.entries[0]?.reservedFen, 30);
    assert.equal(ledger.entries[0]?.providerTaskFingerprint, "a".repeat(16));
    assert.equal(ledger.entries[0]?.artifactSha256, "c".repeat(64));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("测试环境竖屏探针必须拿到真实 9:16 图片尺寸", () => {
  assert.doesNotThrow(() => assertImageAspectRatio(576, 1024, "9:16"));
  assert.throws(
    () => assertImageAspectRatio(1024, 576, "9:16"),
    /IMAGE_RATIO_MISMATCH_9:16/,
  );
  assert.throws(
    () => assertImageAspectRatio(600, 1000, "9:16"),
    /IMAGE_RATIO_MISMATCH_9:16/,
  );
});

test("R195-5 非公司账户探针在读取凭据或联网前统一拒绝并说真话", () => {
  for (const probe of ["minimax-llm", "minimax-image", "minimax-video", "minimax-audio"]) {
    assert.throws(
      () => parseArgs(
        ["--probe", probe, "--target", "dev", "--budget-fen", "5000", "--confirm-paid"],
        ["ark"],
      ),
      /该供应商未开通公司账户/,
    );
  }
});

test("FABLE-007 在提交前累计保留固定成本，不能超出批准预算", () => {
  const budget = new SmokeBudget(3);
  budget.reserve("minimax-image");
  assert.equal(budget.reservedFen, 3);
  assert.throws(() => budget.reserve("minimax-image"), /SMOKE_BUDGET_EXCEEDED/);
});

test("档位解冻探针支持逐档保留成本且不放宽总预算", () => {
  const budget = new SmokeBudget(190);
  budget.reserveFen(30);
  budget.reserveFen(160);
  assert.equal(budget.reservedFen, 190);
  assert.throws(() => budget.reserveFen(1), /SMOKE_BUDGET_EXCEEDED/);
  assert.throws(() => new SmokeBudget(1).reserveFen(0), /SMOKE_BUDGET_INVALID_RESERVATION/);
});

test("FABLE-007 必须绑定 development 和已批准 dev 数据库身份", () => {
  const databaseUrl = "postgresql://dev_smoke_user:secret@dev-db.example.test:5432/shortdrama_dev";
  const fingerprint = createHash("sha256")
    .update("postgresql:|dev_smoke_user|dev-db.example.test|5432|shortdrama_dev")
    .digest("hex");
  assert.doesNotThrow(() => assertFable007DeploymentIdentity({
    databaseUrl,
    expectedSha256: fingerprint,
    appEnvironment: "development",
  }));
  assert.throws(
    () => assertFable007DeploymentIdentity({ databaseUrl, expectedSha256: fingerprint, appEnvironment: "production" }),
    /只允许 development 运行时/,
  );
  assert.throws(
    () => assertFable007DeploymentIdentity({ databaseUrl, expectedSha256: "0".repeat(64), appEnvironment: "development" }),
    /不是已批准的 dev 定价目标/,
  );
});

test("FABLE-007 provider 凭据必须命中独立批准的 dev 指纹", () => {
  const credential = "test-only-provider-credential";
  const approved = createHash("sha256").update(credential).digest("hex");
  assert.equal(assertApprovedCredential(credential, approved, "TEST_API_KEY"), credential);
  assert.throws(
    () => assertApprovedCredential(credential, "0".repeat(64), "TEST_API_KEY"),
    /TEST_API_KEY_NOT_APPROVED_FOR_DEV_SMOKE/,
  );
  assert.throws(
    () => assertApprovedCredential(credential, undefined, "TEST_API_KEY"),
    /TEST_API_KEY_DEV_SMOKE_FINGERPRINT_NOT_CONFIGURED/,
  );
});

test("FABLE-007 真实探针只输出固定阶段码，不透传供应商或下载错误正文", async () => {
  const source = await import("./fable007-provider-smoke.mjs");
  assert.equal(typeof source.parseArgs, "function");
  const file = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("./fable007-provider-smoke.mts", import.meta.url),
    "utf8",
  ));
  assert.match(file, /MEDIA_PROBE_SUBMIT_OUTCOME_UNKNOWN/);
  assert.match(file, /MEDIA_PROBE_ARTIFACT_DOWNLOAD_FAILED/);
  assert.match(file, /AIGC_PLATFORM_LABEL_FAILED/);
  assert.doesNotMatch(file, /process\.stderr\.write\([^)]*error\.message/);
  assert.doesNotMatch(file, /JSON\.stringify\([^)]*error\.message/);
});
