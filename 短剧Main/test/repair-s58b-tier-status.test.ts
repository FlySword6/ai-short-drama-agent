import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  LEGACY_NO_INPUT_VIDEO_TIER_ID,
  parseS58bRepairArgs,
  planS58bTierStatusRepair,
  S58_INFERRED_VIDEO_VALUE_SOURCE_CURRENT_FRAGMENT,
  S58_INFERRED_VIDEO_VALUE_SOURCE_OLD_FRAGMENT,
  S58_LEGACY_VIDEO_VALUE_SOURCE_CURRENT_FRAGMENT,
  S58_LEGACY_VIDEO_VALUE_SOURCE_OLD_FRAGMENT,
  type S58bRepairRow,
} from "../scripts/repair-s58b-tier-status.mjs";
import { INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND } from "../src/shared/pricingRuleProvenance.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDatabaseUrl = process.env.S72_REPAIR_TEST_DATABASE_URL;
const testSchema = "s72_repair_rehearsal";
const s58SeedSource = "815e0b4:scripts/seed-pricing-tiers.mts";
const isolatedEnvDirectory = await mkdtemp(path.join(tmpdir(), "s72b-env-"));
const isolatedEnvFile = path.join(isolatedEnvDirectory, ".env");
await writeFile(isolatedEnvFile, "# S72 test isolation\n", "utf8");
test.after(async () => rm(isolatedEnvDirectory, { recursive: true, force: true }));

function tierMetadata(
  tierId: string,
  priceSourceKind: string,
  supportsInputVideo = false,
  valueSourcesParams = "S72 test fixture",
): Record<string, unknown> {
  return {
    capability_tier: {
      tier_id: tierId,
      status: "active",
      params: { quantity: 1 },
    },
    price_source_kind: priceSourceKind,
    value_sources: {
      model: "S72 test fixture model",
      params: valueSourcesParams,
      tier_id: "S72 test fixture tier",
      unit_price_fen: "S72 test fixture price",
    },
    ...(supportsInputVideo ? { supports_input_video: true } : {}),
  };
}

test("纯逻辑:只按 provenance 收敛推算档,旧固定档只撤视频能力位,规划不修改输入", () => {
  const inferred: S58bRepairRow = {
    id: "00000000-0000-4000-8000-000000000001",
    active: true,
    metadata: tierMetadata(
      "vid-inferred-tier",
      INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND,
      true,
      `prefix;${S58_INFERRED_VIDEO_VALUE_SOURCE_OLD_FRAGMENT}suffix`,
    ),
  };
  const legacy: S58bRepairRow = {
    id: "00000000-0000-4000-8000-000000000002",
    active: true,
    metadata: tierMetadata(
      LEGACY_NO_INPUT_VIDEO_TIER_ID,
      "实测",
      true,
      `prefix;${S58_LEGACY_VIDEO_VALUE_SOURCE_OLD_FRAGMENT}suffix`,
    ),
  };
  const unrelated: S58bRepairRow = {
    id: "00000000-0000-4000-8000-000000000003",
    active: true,
    metadata: {
      ...tierMetadata("approved-video-reference-tier", "实测", true),
      value_sources: { note: INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND },
    },
  };

  const plan = planS58bTierStatusRepair([inferred, legacy, unrelated]);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.legacyTierRows, 1);
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(plan.before, {
    total: 3,
    active: 3,
    inactive: 0,
    experimental: 0,
    inferred: 1,
    inferredActive: 1,
    inferredExperimental: 0,
    supportsInputVideoKeys: 3,
    inferredSupportsInputVideoKeys: 1,
    legacySupportsInputVideoKeys: 1,
    valueSourcesTargetRows: 2,
    staleValueSourcesRows: 2,
    currentValueSourcesRows: 0,
    invalidValueSourcesRows: 0,
  });
  assert.deepEqual(plan.after, {
    total: 3,
    active: 2,
    inactive: 1,
    experimental: 1,
    inferred: 1,
    inferredActive: 0,
    inferredExperimental: 1,
    supportsInputVideoKeys: 1,
    inferredSupportsInputVideoKeys: 0,
    legacySupportsInputVideoKeys: 0,
    valueSourcesTargetRows: 2,
    staleValueSourcesRows: 0,
    currentValueSourcesRows: 2,
    invalidValueSourcesRows: 0,
  });

  const inferredAction = plan.actions.find((action) => action.id === inferred.id);
  assert.ok(inferredAction);
  assert.equal(inferredAction.active, false);
  assert.equal(
    (inferredAction.metadata.capability_tier as Record<string, unknown>).status,
    "experimental",
  );
  assert.equal("supports_input_video" in inferredAction.metadata, false);
  assert.equal(
    (inferredAction.metadata.value_sources as Record<string, unknown>).params,
    `prefix;${S58_INFERRED_VIDEO_VALUE_SOURCE_CURRENT_FRAGMENT}suffix`,
  );

  const legacyAction = plan.actions.find((action) => action.id === legacy.id);
  assert.ok(legacyAction);
  assert.equal(legacyAction.active, true);
  assert.equal(
    (legacyAction.metadata.capability_tier as Record<string, unknown>).status,
    "active",
  );
  assert.equal("supports_input_video" in legacyAction.metadata, false);
  assert.equal(
    (legacyAction.metadata.value_sources as Record<string, unknown>).params,
    `prefix;${S58_LEGACY_VIDEO_VALUE_SOURCE_CURRENT_FRAGMENT}suffix`,
  );
  assert.equal(plan.actions.some((action) => action.id === unrelated.id), false);

  // Planner is immutable: callers can safely print before/projected-after from one snapshot.
  assert.equal(inferred.active, true);
  assert.equal(inferred.metadata.supports_input_video, true);
  assert.equal(legacy.metadata.supports_input_video, true);

  assert.deepEqual(
    parseS58bRepairArgs([
      "--database-url",
      "postgresql://example.invalid/shortdrama",
      "--schema",
      "app",
    ]),
    {
      apply: false,
      databaseUrl: "postgresql://example.invalid/shortdrama",
      schema: "app",
    },
  );
  assert.throws(
    () => parseS58bRepairArgs(["--schema", "app"]),
    /--database-url 必填/,
  );
  assert.throws(
    () => parseS58bRepairArgs([
      "--apply",
      "--database-url",
      "postgresql://user:placeholder@db.example.com/shortdrama",
      "--schema",
      "app",
    ]),
    /--apply 只允许.*回环数据库/,
  );
  assert.throws(
    () => parseS58bRepairArgs([
      "--apply",
      "--database-url",
      "postgresql://user:placeholder@127.0.0.1/shortdrama",
      "--schema",
      "prod",
    ]),
    /不允许 prod schema/,
  );
});

test("纯逻辑:未知 value_sources 文案只报错,不猜测覆盖", () => {
  const row: S58bRepairRow = {
    id: "00000000-0000-4000-8000-000000000004",
    active: true,
    metadata: tierMetadata(
      "vid-inferred-with-drift",
      INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND,
      true,
      "人工改写过的未知文案",
    ),
  };

  const plan = planS58bTierStatusRepair([row]);
  assert.deepEqual(plan.errors, [
    `${row.id}:value_sources.params 不符合 S58/S58b 已知文案,拒绝猜改`,
  ]);
  const action = plan.actions[0];
  assert.ok(action);
  assert.equal(
    (action.metadata.value_sources as Record<string, unknown>).params,
    "人工改写过的未知文案",
  );
  assert.equal(action.reasons.includes("normalize value_sources.params"), false);
});

function isolatedTestEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    SHORTDRAMA_ENV_FILE: isolatedEnvFile,
    ...extra,
  };
}

async function createPricingRulesTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE SCHEMA "${testSchema}"`);
  await pool.query(
    `CREATE TABLE "${testSchema}"."pricing_rules" (
       id uuid PRIMARY KEY,
       provider varchar(32) NOT NULL,
       model varchar(128) NOT NULL,
       media_kind varchar(16) NOT NULL,
       billing_unit varchar(32) NOT NULL,
       unit_price_fen integer NOT NULL,
       currency varchar(8) NOT NULL,
       source varchar(512) NOT NULL,
       active boolean NOT NULL,
       effective_from timestamptz NOT NULL,
       effective_to timestamptz,
       metadata jsonb NOT NULL,
       created_at timestamptz NOT NULL,
       updated_at timestamptz NOT NULL
     )`,
  );
}

async function seedS58DirtyState(databaseUrl: string): Promise<string> {
  const source = execFileSync("git", ["show", s58SeedSource], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(source, /export const PRICING_TIER_SEEDS/);
  assert.match(source, new RegExp(S58_INFERRED_VIDEO_VALUE_SOURCE_OLD_FRAGMENT));
  assert.match(source, new RegExp(S58_LEGACY_VIDEO_VALUE_SOURCE_OLD_FRAGMENT.replace(/[().]/g, "\\$&")));

  const tempRoot = await mkdtemp(path.join(tmpdir(), "s72b-s58-seed-"));
  const scriptsDirectory = path.join(tempRoot, "scripts");
  const directoryLinkType: "dir" | "junction" = process.platform === "win32" ? "junction" : "dir";
  try {
    await mkdir(scriptsDirectory);
    await symlink(path.join(repoRoot, "src"), path.join(tempRoot, "src"), directoryLinkType);
    await symlink(
      path.join(repoRoot, "node_modules"),
      path.join(tempRoot, "node_modules"),
      directoryLinkType,
    );
    await writeFile(path.join(scriptsDirectory, "seed-pricing-tiers.mts"), source, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/seed-pricing-tiers.mts",
        "--database-url",
        databaseUrl,
        "--apply",
      ],
      {
        cwd: tempRoot,
        encoding: "utf8",
        env: isolatedTestEnv({ POSTGRES_SCHEMA: testSchema }),
      },
    );
    assert.equal(
      result.status,
      0,
      `S58 seed(${s58SeedSource}) 失败\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /已写入 30 个档位/);
    return result.stdout;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

interface DatabaseCounts {
  total: number;
  active: number;
  inactive: number;
  experimental: number;
  supports: number;
}

async function readDatabaseCounts(pool: Pool): Promise<DatabaseCounts> {
  const result = await pool.query<DatabaseCounts>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE active)::int AS active,
       count(*) FILTER (WHERE NOT active)::int AS inactive,
       count(*) FILTER (
         WHERE metadata #>> '{capability_tier,status}' = 'experimental'
       )::int AS experimental,
       count(*) FILTER (WHERE metadata ? 'supports_input_video')::int AS supports
     FROM "${testSchema}"."pricing_rules"`,
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

interface ImmutablePricingRuleFields {
  id: string;
  provider: string;
  model: string;
  media_kind: string;
  billing_unit: string;
  unit_price_fen: number;
  currency: string;
  source: string;
  tier_id: string;
  tier_params: Record<string, unknown>;
}

async function readImmutablePricingRuleFields(pool: Pool): Promise<ImmutablePricingRuleFields[]> {
  const result = await pool.query<ImmutablePricingRuleFields>(
    `SELECT
       id::text AS id,
       provider,
       model,
       media_kind,
       billing_unit,
       unit_price_fen,
       currency,
       source,
       metadata #>> '{capability_tier,tier_id}' AS tier_id,
       metadata #> '{capability_tier,params}' AS tier_params
     FROM "${testSchema}"."pricing_rules"
     ORDER BY id`,
  );
  return result.rows;
}

async function readAllPricingRuleRows(pool: Pool): Promise<Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT
       id::text AS id,
       provider,
       model,
       media_kind,
       billing_unit,
       unit_price_fen,
       currency,
       source,
       active,
       effective_from::text AS effective_from,
       effective_to::text AS effective_to,
       metadata,
       created_at::text AS created_at,
       updated_at::text AS updated_at
     FROM "${testSchema}"."pricing_rules"
     ORDER BY id`,
  );
  return result.rows;
}

interface SeedPlannerCounts {
  skip: number;
  conflict: number;
  insert: number;
}

interface SeedPlannerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  counts: SeedPlannerCounts;
}

function matchingLineCount(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function invokeCurrentSeedPlanner(databaseUrl: string): SeedPlannerResult {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/seed-pricing-tiers.mts",
      "--database-url",
      databaseUrl,
      "--schema",
      testSchema,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: isolatedTestEnv({ POSTGRES_SCHEMA: testSchema }),
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    counts: {
      skip: matchingLineCount(result.stdout, /^  跳过 /gmu),
      conflict: matchingLineCount(result.stderr, /^  冲突 /gmu),
      insert: matchingLineCount(result.stdout, /^  将插入 /gmu),
    },
  };
}
function assertNoS58RepairTargetConflicts(result: SeedPlannerResult): void {
  assert.doesNotMatch(
    result.stderr,
    /^  冲突 vid-/mu,
    `S58B 已修复的旧视频档不应再与当前 seed 冲突\nstderr:\n${result.stderr}`,
  );
}

function invokeRepair(databaseUrl: string, apply: boolean) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/repair-s58b-tier-status.mts",
      "--database-url",
      databaseUrl,
      "--schema",
      testSchema,
      ...(apply ? ["--apply"] : []),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: isolatedTestEnv(),
    },
  );
}

function runRepair(databaseUrl: string, apply: boolean): string {
  const result = invokeRepair(databaseUrl, apply);
  assert.equal(
    result.status,
    0,
    `repair CLI 失败\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

function runRepairExpectFailure(databaseUrl: string): string {
  const result = invokeRepair(databaseUrl, true);
  assert.notEqual(
    result.status,
    0,
    `repair CLI 本应失败\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stderr;
}

function assertTemporaryDockerTarget(databaseUrl: string): void {
  assert.equal(
    process.env.S72_REPAIR_TEST_ALLOW_WRITE,
    "temporary-docker-only",
    "真 PG 测试只允许由临时 Docker runner 显式解锁",
  );
  const parsed = new URL(databaseUrl);
  assert.ok(
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost",
    "真 PG 测试只允许回环地址",
  );
  assert.equal(parsed.pathname, "/s72_repair");
}

test(
  "真 PG:S58 seed 脏态经修复后旧视频档不再与当前 seed 冲突,复跑 repair 零变更",
  { skip: testDatabaseUrl ? false : "需要 scripts/run-s72-repair-db-test.sh 的临时 PostgreSQL" },
  async (context) => {
    assert.ok(testDatabaseUrl);
    assertTemporaryDockerTarget(testDatabaseUrl);
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    try {
      await createPricingRulesTable(pool);
      await seedS58DirtyState(testDatabaseUrl);

      assert.deepEqual(await readDatabaseCounts(pool), {
        total: 30,
        active: 30,
        inactive: 0,
        experimental: 0,
        supports: 24,
      });
      const initialRows = await readAllPricingRuleRows(pool);
      const immutableFields = await readImmutablePricingRuleFields(pool);
      const dirtyPlannerResult = invokeCurrentSeedPlanner(testDatabaseUrl);
      assert.notEqual(
        dirtyPlannerResult.status,
        0,
        `seed 规划器应报告 S58 脏态冲突\nstdout:\n${dirtyPlannerResult.stdout}\nstderr:\n${dirtyPlannerResult.stderr}`,
      );
      assert.match(dirtyPlannerResult.stderr, /^  冲突 vid-/mu);
      const dirtyPlannerInsertCount = dirtyPlannerResult.counts.insert;

      const dryRunOutput = runRepair(testDatabaseUrl, false);
      assert.match(dryRunOutput, /\[DRY-RUN\]/);
      assert.match(dryRunOutput, /value_sources_rows_changed=24/);
      assert.match(dryRunOutput, /\[result\] changed_rows=29; dry-run 未写库/);
      assert.deepEqual(await readAllPricingRuleRows(pool), initialRows);
      assert.deepEqual(await readDatabaseCounts(pool), {
        total: 30,
        active: 30,
        inactive: 0,
        experimental: 0,
        supports: 24,
      });

      // 让排序最后的第 28 个推算档拒绝 inactive；此前 28 个动作已执行，
      // 但任一失败必须令旧视频能力位和前 27 个推算档一起回滚。
      await pool.query(
        `ALTER TABLE "${testSchema}"."pricing_rules"
         ADD CONSTRAINT s72_force_rollback
         CHECK (
           id <> '00000000-5580-4000-8000-000000000028'::uuid
           OR active
         )`,
      );
      const rollbackOutput = runRepairExpectFailure(testDatabaseUrl);
      assert.match(rollbackOutput, /s72_force_rollback/);
      assert.deepEqual(await readAllPricingRuleRows(pool), initialRows);
      assert.deepEqual(await readDatabaseCounts(pool), {
        total: 30,
        active: 30,
        inactive: 0,
        experimental: 0,
        supports: 24,
      });
      await pool.query(
        `ALTER TABLE "${testSchema}"."pricing_rules"
         DROP CONSTRAINT s72_force_rollback`,
      );

      const firstApplyOutput = runRepair(testDatabaseUrl, true);
      assert.match(firstApplyOutput, /value_sources_rows_changed=24/);
      assert.match(firstApplyOutput, /\[result\] changed_rows=29; apply 已提交/);
      assert.deepEqual(await readDatabaseCounts(pool), {
        total: 30,
        active: 2,
        inactive: 28,
        experimental: 28,
        supports: 0,
      });
      assert.deepEqual(await readImmutablePricingRuleFields(pool), immutableFields);
      const repairedPlannerResult = invokeCurrentSeedPlanner(testDatabaseUrl);
      assertNoS58RepairTargetConflicts(repairedPlannerResult);
      assert.equal(repairedPlannerResult.counts.insert, dirtyPlannerInsertCount);
      const repairedRows = await readAllPricingRuleRows(pool);

      const secondApplyOutput = runRepair(testDatabaseUrl, true);
      assert.match(secondApplyOutput, /value_sources_rows_changed=0/);
      assert.match(secondApplyOutput, /\[result\] changed_rows=0; apply 已提交/);
      assert.deepEqual(await readAllPricingRuleRows(pool), repairedRows);
      assert.deepEqual(await readDatabaseCounts(pool), {
        total: 30,
        active: 2,
        inactive: 28,
        experimental: 28,
        supports: 0,
      });
      const secondPlannerResult = invokeCurrentSeedPlanner(testDatabaseUrl);
      assertNoS58RepairTargetConflicts(secondPlannerResult);
      assert.deepEqual(secondPlannerResult.counts, repairedPlannerResult.counts);
      assert.equal(secondPlannerResult.status, repairedPlannerResult.status);
      context.diagnostic(
        `S58 脏态 seed 规划器:insert=${dirtyPlannerInsertCount} exit!=0`,
      );
      context.diagnostic(
        `S72B 修复后旧视频档不再冲突;当前目录插入计划保持 ${dirtyPlannerInsertCount} 档`,
      );
      context.diagnostic(
        "S72B 行状态:active=2 experimental=28 supports_input_video=0;二次 apply changed_rows=0",
      );
    } finally {
      await pool.end();
    }
  },
);
