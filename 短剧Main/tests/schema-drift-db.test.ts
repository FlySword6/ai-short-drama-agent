import assert from "node:assert/strict";
import test from "node:test";

/**
 * schema.ts 与 migrations 重放结果的一致性(真 PostgreSQL 14)。S22 护栏 B。
 *
 * 默认跳过:设置 SCHEMA_DRIFT_TEST_DATABASE_URL 指向本机/本地 Compose PG 后运行,
 * 或直接跑 scripts/check-schema-drift-docker.sh(一次性容器,无需自备库)。
 *
 * 已知未决(S22 回执已报 Fable):schema.ts 导出了 deliveryRecords/mediaReviewActions
 * 但未注册进 databaseSchema——当前运行会报这 2 项;在 src/db/schema.ts 补注册后
 * 「零漂移」一条即恢复全绿。
 */
const databaseUrl = process.env.SCHEMA_DRIFT_TEST_DATABASE_URL;

test("schema.ts 与迁移重放结果零漂移", { skip: !databaseUrl }, async () => {
  const { runDriftCheck } = await import("../scripts/check-schema-drift.mts");
  const report = await runDriftCheck({ databaseUrl: databaseUrl! });
  assert.ok(report.stats.tablesCompared > 0);
  assert.deepEqual(report.issues, []);
});

test("漂移检测能发现注入的结构偏差,重放后自愈", { skip: !databaseUrl }, async () => {
  const { prepareDriftSchema, compareDriftSchema } = await import("../scripts/check-schema-drift.mts");
  const schema = "s22_drift_check";
  const { default: pg } = await import("pg");

  await prepareDriftSchema({ databaseUrl: databaseUrl!, schema });
  const baseline = (await compareDriftSchema({ databaseUrl: databaseUrl!, schema })).issues;

  // 注入两类典型漂移:schema.ts 已有表多出未声明列;整张表未声明也未入白名单。
  const admin = new pg.Pool({ connectionString: databaseUrl });
  try {
    await admin.query(`ALTER TABLE "${schema}".users ADD COLUMN s22_injected_drift text`);
    await admin.query(`CREATE TABLE "${schema}".s22_unlisted_table (id uuid PRIMARY KEY)`);
  } finally {
    await admin.end();
  }

  const withDrift = (await compareDriftSchema({ databaseUrl: databaseUrl!, schema })).issues;
  assert.equal(withDrift.length, baseline.length + 2);
  assert.ok(withDrift.some((issue) => issue.includes("users.s22_injected_drift")), withDrift.join("\n"));
  assert.ok(withDrift.some((issue) => issue.includes("s22_unlisted_table")), withDrift.join("\n"));

  // 重放即自愈:DROP 后重跑迁移,注入的偏差消失,回到基线。
  await prepareDriftSchema({ databaseUrl: databaseUrl!, schema });
  const healed = (await compareDriftSchema({ databaseUrl: databaseUrl!, schema })).issues;
  assert.deepEqual(healed, baseline);
});
