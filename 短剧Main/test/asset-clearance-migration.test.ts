import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import { assetClearanceKeys, defaultAssetClearance } from "../src/db/schema.js";

const migrationPath = path.resolve("migrations/030_asset_clearance_shape_check.sql");
const integrationTestDatabaseUrl = process.env.ASSET_CLEARANCE_TEST_DATABASE_URL;

test("clearance 形状迁移是 schema 作用域,且 SQL 约束逐位镜像 assetClearanceKeys", async () => {
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, "clearance_contract_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /ALTER TABLE "clearance_contract_test"\.asset_entities/);
  // 016 的 object-only 底线被本约束包含并替换。
  assert.match(rendered, /DROP CONSTRAINT IF EXISTS asset_entities_clearance_object_check/);
  assert.match(rendered, /ADD CONSTRAINT asset_entities_clearance_shape_check/);
  assert.match(rendered, /jsonb_typeof\(clearance\) = 'object'/);
  // SQL 约束必须与 TS 唯一真源逐位镜像:减位链(拒绝未知位)和类型臂(必须布尔)都要覆盖每个已知位。
  for (const key of assetClearanceKeys) {
    assert.ok(rendered.includes(`- '${key}'`), `减位链必须删掉已知位 ${key}`);
    assert.ok(rendered.includes(`clearance -> '${key}'`), `类型臂必须覆盖已知位 ${key}`);
  }
  // 本迁移只收紧形状,不改任何数据行、不动 fail-safe 默认值。
  assert.doesNotMatch(rendered, /SET DEFAULT/i);
  assert.doesNotMatch(rendered, /^UPDATE /im);
});

/**
 * Fable 验收同款演练:对套用了迁移 030 的表,手工写形状不合法的 clearance
 * 必须被 CHECK 拒绝(23514),缺省位/空对象必须能写。未设
 * ASSET_CLEARANCE_TEST_DATABASE_URL 时如实 skip,不假装通过。
 */
test("clearance 形状 CHECK 在真 PG 拒绝坏行、放行缺省行", {
  skip: !integrationTestDatabaseUrl,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabase(integrationTestDatabaseUrl);
  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = `clearance_shape_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const quoted = quoteIdentifier(schemaName);
  const source = await readFile(migrationPath, "utf8");
  try {
    await pool.query(`CREATE SCHEMA ${quoted}`);
    await pool.query(`CREATE TABLE ${quoted}.asset_entities (id uuid PRIMARY KEY, clearance jsonb NOT NULL)`);
    await pool.query(renderMigrationSql(source, schemaName));

    const insert = (clearance: unknown) => pool.query(
      `INSERT INTO ${quoted}.asset_entities (id, clearance) VALUES ($1, $2::jsonb)`,
      [randomUUID(), JSON.stringify(clearance)],
    );

    // 合法:完整四布尔、只写一位(其余缺省)、空对象(全缺省)都必须能写。
    await insert({ ...defaultAssetClearance });
    await insert({ commercial_publish: true });
    await insert({});

    // 不合法:与共享校验同一批语义,全部必须撞 CHECK(23514)。
    for (const bad of [
      { search: "false" },
      { search: 1 },
      { search: null },
      { search: { enabled: true } },
      { search: true, derivatives: true },
      ["search"],
      "true",
    ]) {
      await assert.rejects(
        insert(bad),
        (error: unknown) => (error as { code?: string }).code === "23514",
        `必须拒绝: ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("ASSET_CLEARANCE_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
