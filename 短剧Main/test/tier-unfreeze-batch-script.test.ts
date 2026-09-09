import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTierUnfreezeDatabaseTransport,
  assertTierUnfreezeTargetIdentity,
  TIER_UNFREEZE_BATCH,
  TIER_UNFREEZE_BATCH_ID,
  TIER_UNFREEZE_TEST_ENV_BATCH,
  TIER_UNFREEZE_TEST_ENV_BATCH_ID,
  parseTierUnfreezeArgs,
  planTierUnfreeze,
  tierUnfreezeTargetIdentitySha256,
  validateTierUnfreezeEvidence,
  verifyTierUnfreezeDeployment,
  type TierUnfreezeEvidence,
  type TierUnfreezeDeploymentProof,
  type TierUnfreezeRow,
} from "../scripts/tier-unfreeze.mjs";
import {
  parseArgs as parseProviderSmokeArgs,
  SmokeBudget,
} from "../scripts/fable007-provider-smoke.mjs";
import {
  arkTierPriceDefinition,
  assessTierPricingRule,
} from "../src/modules/generation/tierPricingGuard.js";

test("tier-unfreeze:CLI 默认 dry-run，apply 必须精确批次确认和证据文件", () => {
  assert.deepEqual(parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_BATCH_ID,
    "--target", "dev",
    "--schema", "app",
  ]), {
    apply: false,
    batchId: TIER_UNFREEZE_BATCH_ID,
    target: "dev",
    schema: "app",
  });
  assert.deepEqual(parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_BATCH_ID,
    "--target", "dev",
    "--schema", "app",
    "--dry-run",
    "--evidence-file", "/tmp/evidence.json",
  ]), {
    apply: false,
    batchId: TIER_UNFREEZE_BATCH_ID,
    target: "dev",
    schema: "app",
    evidenceFile: "/tmp/evidence.json",
  });
  assert.throws(() => parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_BATCH_ID,
    "--target", "dev",
    "--schema", "app",
    "--apply",
  ]), /confirm-batch/);
  assert.throws(() => parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_BATCH_ID,
    "--target", "prod",
    "--schema", "app",
  ]), /只允许 --target dev/);
  assert.deepEqual(parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_BATCH_ID,
    "--target", "dev",
    "--schema", "app",
    "--apply",
    "--confirm-batch", TIER_UNFREEZE_BATCH_ID,
    "--evidence-file", "/tmp/evidence.json",
    "--deployment-base-url", "https://shortdrama-dev.example.test/dev",
    "--guard-commit", "a".repeat(40),
  ]), {
    apply: true,
    batchId: TIER_UNFREEZE_BATCH_ID,
    target: "dev",
    schema: "app",
    confirmBatch: TIER_UNFREEZE_BATCH_ID,
    evidenceFile: "/tmp/evidence.json",
    deploymentBaseUrl: "https://shortdrama-dev.example.test/dev",
    guardCommit: "a".repeat(40),
  });
});

test("tier-unfreeze:test-env 只接受竖屏图片批次，apply 还要重复确认目标", () => {
  assert.deepEqual(parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    "--target", "test-env",
    "--schema", "app",
  ]), {
    apply: false,
    batchId: TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    target: "test-env",
    schema: "app",
  });
  assert.throws(() => parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    "--target", "test-env",
    "--schema", "app",
    "--apply",
    "--confirm-batch", TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    "--evidence-file", "/tmp/evidence.json",
    "--deployment-base-url", "https://shortdrama-test.example.test",
    "--guard-commit", "a".repeat(40),
  ]), /confirm-target/);
  assert.deepEqual(parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    "--target", "test-env",
    "--schema", "app",
    "--apply",
    "--confirm-batch", TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    "--confirm-target", "test-env",
    "--evidence-file", "/tmp/evidence.json",
    "--deployment-base-url", "https://shortdrama-test.example.test",
    "--guard-commit", "a".repeat(40),
  ]), {
    apply: true,
    batchId: TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    target: "test-env",
    schema: "app",
    confirmBatch: TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    confirmTarget: "test-env",
    evidenceFile: "/tmp/evidence.json",
    deploymentBaseUrl: "https://shortdrama-test.example.test",
    guardCommit: "a".repeat(40),
  });
  assert.throws(() => parseTierUnfreezeArgs([
    "--batch", TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    "--target", "dev",
    "--schema", "app",
  ]), /批次.*目标/);
  for (const target of ["prod", "production"]) {
    assert.throws(() => parseTierUnfreezeArgs([
      "--batch", TIER_UNFREEZE_TEST_ENV_BATCH_ID,
      "--target", target,
      "--schema", "app",
    ]), /只允许 --target dev/);
  }
});

test("tier-unfreeze:付费探针一次只收一个审核 tier，并按该档预留预算", () => {
  assert.deepEqual(parseProviderSmokeArgs([
    "--probe", "ark-image",
    "--tier-id", "img-seedream5pro-916-1k-1",
    "--tier-ledger-file", "/tmp/tier-smoke-ledger.json",
    "--target", "dev",
    "--budget-fen", "30",
    "--confirm-paid",
  ]), {
    probe: "ark-image",
    tierId: "img-seedream5pro-916-1k-1",
    tierLedgerFile: "/tmp/tier-smoke-ledger.json",
    target: "dev",
    budgetFen: 30,
    confirmPaid: true,
  });
  assert.throws(() => parseProviderSmokeArgs([
    "--probe", "ark-video",
    "--tier-id", "vid-seedance20fast-169-480p",
    "--tier-ledger-file", "/tmp/tier-smoke-ledger.json",
    "--target", "dev",
    "--budget-fen", "159",
    "--confirm-paid",
  ]), /160 分的上限/);
  assert.throws(() => parseProviderSmokeArgs([
    "--probe", "ark-image",
    "--tier-id", "vid-seedance20fast-169-480p",
    "--tier-ledger-file", "/tmp/tier-smoke-ledger.json",
    "--target", "dev",
    "--budget-fen", "160",
    "--confirm-paid",
  ]), /不在该 Ark 探针/);
  assert.deepEqual(parseProviderSmokeArgs([
    "--probe", "ark-image",
    "--tier-id", "img-seedream5pro-916-1k-1",
    "--target", "test-env",
    "--budget-fen", "30",
    "--confirm-paid",
  ], ["ark"]), {
    probe: "ark-image",
    tierId: "img-seedream5pro-916-1k-1",
    target: "test-env",
    budgetFen: 30,
    confirmPaid: true,
  });
  assert.throws(() => parseProviderSmokeArgs([
    "--probe", "ark-image",
    "--tier-id", "img-seedream5pro-169-1k-1",
    "--target", "test-env",
    "--budget-fen", "30",
    "--confirm-paid",
  ], ["ark"]), /test-env.*9:16/);
  assert.throws(() => parseProviderSmokeArgs([
    "--probe", "ark-image",
    "--tier-id", "img-seedream5pro-916-1k-1",
    "--tier-ledger-file", "/tmp/another-ledger.json",
    "--target", "test-env",
    "--budget-fen", "30",
    "--confirm-paid",
  ], ["ark"]), /只允许使用测试库持久账本/);
  assert.throws(() => parseProviderSmokeArgs([
    "--probe", "ark-image",
    "--tier-id", "img-seedream5pro-916-1k-1",
    "--target", "production",
    "--budget-fen", "30",
    "--confirm-paid",
  ], ["ark"]), /只允许 --target dev 或 test-env/);

  const budget = new SmokeBudget(160);
  budget.reserveFen(160);
  assert.equal(budget.reservedFen, 160);
  assert.throws(() => budget.reserveFen(1), /SMOKE_BUDGET_EXCEEDED/);
});

test("tier-unfreeze:dry-run 只列首批四档，证据和部署证明齐全才形成 activate", () => {
  const rows = batchRows();
  const dryRun = planTierUnfreeze(rows);
  assert.equal(dryRun.length, 4);
  assert.ok(dryRun.every((action) => action.kind === "pending_evidence"));
  assert.deepEqual(
    dryRun.map((action) => action.tierId),
    TIER_UNFREEZE_BATCH.map((item) => item.tierId),
  );

  const pendingDeployment = planTierUnfreeze(rows, evidence());
  assert.ok(pendingDeployment.every((action) => action.kind === "pending_deployment"));

  const applied = planTierUnfreeze(rows, evidence(), deploymentProof());
  assert.ok(applied.every((action) => action.kind === "activate"));
  for (const action of applied) {
    if (action.kind !== "activate") continue;
    const row = rows.find((candidate) => candidate.id === action.rowId)!;
    const assessment = assessTierPricingRule({
      provider: row.provider,
      model: row.model,
      mediaKind: row.mediaKind,
      billingUnit: row.billingUnit,
      unitPriceFen: row.unitPriceFen,
      metadata: action.metadata,
      active: true,
    });
    assert.equal(assessment.quoteable, true, action.tierId);
    assert.equal(assessment.code, "available", action.tierId);
    assert.equal(action.metadata.activation_scope, undefined);
    assert.equal(action.metadata.price_source_kind, "实测");
  }
});

test("tier-unfreeze:视频正式档与已审核无声 smoke 参数完全一致", () => {
  for (const item of TIER_UNFREEZE_BATCH.filter((candidate) => candidate.tierId.startsWith("vid-"))) {
    const definition = arkTierPriceDefinition(item.tierId);
    assert.ok(definition);
    assert.equal(item.finalParams.generate_audio, false);
    assert.equal("return_last_frame" in item.finalParams, false);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(item.finalParams).filter(([key]) => key !== "duration_seconds"),
      ),
      definition.requiredParams,
    );
  }
});

test("tier-unfreeze:一档一烟、平台登记价、供应商账单与 50 元上限均 fail-closed", () => {
  const missing = evidence();
  missing.entries.pop();
  assert.throws(() => validateTierUnfreezeEvidence(missing), /逐档一笔/);

  const wrongPlatform = evidence();
  wrongPlatform.entries[0]!.platformListPriceFen = 1;
  assert.throws(() => validateTierUnfreezeEvidence(wrongPlatform), /平台登记价/);

  const wrongProvider = evidence();
  wrongProvider.entries[2]!.providerBilledFen = 1;
  assert.throws(() => validateTierUnfreezeEvidence(wrongProvider), /供应商实扣/);

  const overBudget = evidence();
  for (const entry of overBudget.entries) entry.providerBilledFen = 1_300;
  assert.throws(
    () => validateTierUnfreezeEvidence(overBudget),
    /供应商实扣|超过 50 元/,
  );
});

test("tier-unfreeze:test-env 证据只解冻白名单内的 9:16 图片档且仍要求真实账单", () => {
  const receipt = testEnvEvidence();
  assert.doesNotThrow(() => validateTierUnfreezeEvidence(receipt));
  const plan = planTierUnfreeze(
    batchRows(TIER_UNFREEZE_TEST_ENV_BATCH.items),
    receipt,
    deploymentProof(),
    TIER_UNFREEZE_TEST_ENV_BATCH,
  );
  assert.deepEqual(plan.map((action) => [action.tierId, action.kind]), [
    ["img-seedream5pro-916-1k-1", "activate"],
  ]);

  delete receipt.entries[0]!.artifactWidthPx;
  assert.throws(() => validateTierUnfreezeEvidence(receipt), /缺少有效产物尺寸/);
  receipt.entries[0]!.artifactWidthPx = 1024;
  receipt.entries[0]!.artifactHeightPx = 576;
  assert.throws(() => validateTierUnfreezeEvidence(receipt), /不是 9:16 竖屏/);
  receipt.entries[0]!.artifactWidthPx = 576;
  receipt.entries[0]!.artifactHeightPx = 1024;
  receipt.entries[0]!.providerBillingReference = "";
  assert.throws(() => validateTierUnfreezeEvidence(receipt), /供应商账单证据/);
});

test("tier-unfreeze:test-env 不把开发冒烟 active 行当作可晋升输入", () => {
  const rows = batchRows(TIER_UNFREEZE_TEST_ENV_BATCH.items);
  rows[0] = {
    ...rows[0]!,
    active: true,
    metadata: {
      ...rows[0]!.metadata,
      activation_scope: "dev_smoke_only",
    },
  };
  const plan = planTierUnfreeze(
    rows,
    testEnvEvidence(),
    deploymentProof(),
    TIER_UNFREEZE_TEST_ENV_BATCH,
  );
  assert.equal(plan[0]?.kind, "conflict");
});

test("tier-unfreeze:重复 tier 行或数据漂移不会静默覆盖", () => {
  const rows = batchRows();
  const duplicate = planTierUnfreeze([...rows, { ...rows[0]!, id: "duplicate" }]);
  assert.equal(duplicate[0]?.kind, "conflict");
  if (duplicate[0]?.kind === "conflict") assert.match(duplicate[0].reasons[0]!, /实际 2 行/);

  const drifted = batchRows();
  drifted[2] = { ...drifted[2]!, unitPriceFen: 1 };
  const plan = planTierUnfreeze(drifted);
  assert.equal(plan[2]?.kind, "conflict");
  if (plan[2]?.kind === "conflict") {
    assert.match(plan[2].reasons.join(","), /unit_price_fen=1/);
  }
});

test("tier-unfreeze:幂等重跑绑定同一证据文件和同一部署 commit", () => {
  const rows = batchRows();
  const proof = deploymentProof();
  const originalEvidence = evidence();
  const first = planTierUnfreeze(rows, originalEvidence, proof);
  const formalRows = rows.map((row) => {
    const action = first.find((candidate) => candidate.tierId === readTierId(row));
    assert.equal(action?.kind, "activate");
    if (action?.kind !== "activate") throw new Error("expected activate");
    return {
      ...row,
      active: true,
      source: action.source,
      metadata: action.metadata,
    };
  });
  assert.ok(
    planTierUnfreeze(formalRows, originalEvidence, proof)
      .every((action) => action.kind === "skip"),
  );

  const changedEvidence = evidence();
  changedEvidence.sha256 = "f".repeat(64);
  assert.ok(
    planTierUnfreeze(formalRows, changedEvidence, proof)
      .every((action) => action.kind === "conflict"),
  );
  assert.ok(
    planTierUnfreeze(formalRows, originalEvidence, {
      ...proof,
      commitSha: "b".repeat(40),
    }).every((action) => action.kind === "conflict"),
  );
});

test("tier-unfreeze:apply 目标身份同时绑定数据库和 schema", () => {
  const databaseUrl = "postgresql://dev_writer:secret@db.example.test:5432/shortdrama_dev";
  const fingerprint = tierUnfreezeTargetIdentitySha256(databaseUrl, "shortdrama_dev");
  assert.doesNotThrow(() => assertTierUnfreezeTargetIdentity({
    target: "dev",
    databaseUrl,
    schema: "shortdrama_dev",
    expectedSha256: fingerprint,
    appEnvironment: "development",
  }));
  assert.throws(() => assertTierUnfreezeTargetIdentity({
    target: "dev",
    databaseUrl,
    schema: "another_dev",
    expectedSha256: fingerprint,
    appEnvironment: "development",
  }), /数据库或 schema/);
  assert.throws(() => assertTierUnfreezeTargetIdentity({
    target: "dev",
    databaseUrl,
    schema: "shortdrama_prod",
    expectedSha256: tierUnfreezeTargetIdentitySha256(databaseUrl, "shortdrama_prod"),
    appEnvironment: "development",
  }), /production\/test schema/);
});

test("tier-unfreeze:test-env 接受测试部署运行时但仍绑定独立数据库和 app schema", () => {
  const databaseUrl = "postgresql://test_writer:secret@test-db.example.test:5432/shortdrama";
  const fingerprint = tierUnfreezeTargetIdentitySha256(databaseUrl, "app");
  assert.doesNotThrow(() => assertTierUnfreezeTargetIdentity({
    target: "test-env",
    databaseUrl,
    schema: "app",
    expectedSha256: fingerprint,
    appEnvironment: "production",
  }));
  assert.throws(() => assertTierUnfreezeTargetIdentity({
    target: "test-env",
    databaseUrl: "postgresql://prod_writer:secret@prod-db.example.test:5432/shortdrama",
    schema: "app",
    expectedSha256: fingerprint,
    appEnvironment: "production",
  }), /数据库或 schema/);
  assert.throws(() => assertTierUnfreezeTargetIdentity({
    target: "test-env",
    databaseUrl,
    schema: "shortdrama_prod",
    expectedSha256: tierUnfreezeTargetIdentitySha256(databaseUrl, "shortdrama_prod"),
    appEnvironment: "production",
  }), /production\/test schema/);
  assert.doesNotThrow(() => assertTierUnfreezeDatabaseTransport({
    target: "test-env",
    sslMode: "verify-full",
    rootCertPath: "/etc/ssl/certs/volcengine-rds/ca.pem",
  }));
  assert.throws(() => assertTierUnfreezeDatabaseTransport({
    target: "test-env",
    sslMode: "disable",
    rootCertPath: undefined,
  }), /verify-full/);
  assert.throws(() => assertTierUnfreezeDatabaseTransport({
    target: "test-env",
    sslMode: "verify-full",
    rootCertPath: undefined,
  }), /CA/);
});

test("tier-unfreeze:部署服务必须同时报告指定 guard commit 和 ready", async () => {
  const commitSha = "a".repeat(40);
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    const value = String(url);
    calls.push(value);
    const data = value.endsWith("/health")
      ? { status: "ok", sha: commitSha }
      : { status: "ready", db: "ok" };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  }) as typeof fetch;
  const result = await verifyTierUnfreezeDeployment({
    baseUrl: "https://shortdrama-dev.example.test/dev",
    expectedCommitSha: commitSha,
  }, fakeFetch);
  assert.deepEqual(result, {
    baseUrl: "https://shortdrama-dev.example.test/dev/",
    commitSha,
  });
  assert.deepEqual(calls, [
    "https://shortdrama-dev.example.test/dev/api/v1/health",
    "https://shortdrama-dev.example.test/dev/api/v1/ready",
  ]);
  await assert.rejects(
    verifyTierUnfreezeDeployment({
      baseUrl: "https://shortdrama-dev.example.test/dev",
      expectedCommitSha: "b".repeat(40),
    }, fakeFetch),
    /尚未部署指定价格守卫 commit/,
  );
});

function batchRows(
  items: readonly typeof TIER_UNFREEZE_BATCH[number][] = TIER_UNFREEZE_BATCH,
): TierUnfreezeRow[] {
  return items.map((item, index) => {
    const definition = arkTierPriceDefinition(item.tierId)!;
    return {
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      provider: definition.provider,
      model: definition.model,
      mediaKind: definition.mediaKind,
      billingUnit: definition.billingUnit,
      unitPriceFen: definition.platformUnitPriceFen!,
      active: false,
      source: "seed:s58:scripts/seed-pricing-tiers.mts",
      metadata: {
        price_source_kind: "官方牌价×加成率(推算)",
        capability_tier: {
          tier_id: item.tierId,
          params: Object.fromEntries(
            Object.entries(item.finalParams).filter(([key]) => key !== "duration_seconds"),
          ),
          status: "experimental",
        },
      },
    };
  });
}

function testEnvEvidence(): TierUnfreezeEvidence {
  const item = TIER_UNFREEZE_TEST_ENV_BATCH.items[0]!;
  const definition = arkTierPriceDefinition(item.tierId)!;
  return {
    batchId: TIER_UNFREEZE_TEST_ENV_BATCH_ID,
    target: "test-env",
    sha256: "d".repeat(64),
    entries: [{
      tierId: item.tierId,
      providerTaskFingerprint: "9".repeat(16),
      artifactSha256: "9".repeat(64),
      artifactWidthPx: 576,
      artifactHeightPx: 1024,
      smokeCompletedAt: "2026-08-06T03:00:00.000Z",
      accountCheckedAt: "2026-08-06T03:10:00.000Z",
      platformListPriceFen: definition.platformUnitPriceFen! * item.smokeBillableUnits,
      providerBilledFen: definition.officialCostFenPerUnit! * item.smokeBillableUnits,
      providerBillingReference: "ark-billing:test-env-portrait-smoke",
    }],
  };
}

function evidence(): TierUnfreezeEvidence {
  return {
    batchId: TIER_UNFREEZE_BATCH_ID,
    target: "dev",
    sha256: "e".repeat(64),
    entries: TIER_UNFREEZE_BATCH.map((item, index) => {
      const definition = arkTierPriceDefinition(item.tierId)!;
      return {
        tierId: item.tierId,
        providerTaskFingerprint: String(index + 1).repeat(16),
        artifactSha256: String(index + 1).repeat(64),
        smokeCompletedAt: `2026-08-06T02:0${index}:00.000Z`,
        accountCheckedAt: `2026-08-06T02:1${index}:00.000Z`,
        platformListPriceFen: definition.platformUnitPriceFen! * item.smokeBillableUnits,
        providerBilledFen: definition.officialCostFenPerUnit! * item.smokeBillableUnits,
        providerBillingReference: `ark-billing:batch-${index + 1}`,
      };
    }),
  };
}

function deploymentProof(): TierUnfreezeDeploymentProof {
  return {
    baseUrl: "https://shortdrama-dev.example.test/dev/",
    commitSha: "a".repeat(40),
  };
}

function readTierId(row: TierUnfreezeRow): string {
  return (row.metadata.capability_tier as { tier_id: string }).tier_id;
}
