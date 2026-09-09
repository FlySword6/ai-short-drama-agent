import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

// This is intentionally opt-in. Run it only against an isolated PostgreSQL 16
// test database where enabling pg_trgm is permitted; production migration 017
// remains fail-closed and never creates an extension itself.
const integrationTestDatabaseUrl = process.env.HYBRID_SEARCH_TEST_DATABASE_URL;

test("017 在 PostgreSQL 中维护中文词法字段、触发器和索引", {
  skip: !integrationTestDatabaseUrl,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabaseUrl(integrationTestDatabaseUrl);
  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = `hybrid_search_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const ownerId = randomUUID();
  const entityId = randomUUID();
  const variantId = randomUUID();

  try {
    // Only this disposable verification database may install the extension.
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pool.query(`CREATE SCHEMA ${schema}`);
    await applyMigrations(pool, schemaName, await migrationFilesThrough016());
    await applyMigrations(pool, schemaName, ["017_hybrid_asset_search.sql"]);

    await pool.query(`
      INSERT INTO ${schema}.users (id, username, display_name, password_hash, active)
      VALUES ($1, 'hybrid-test-owner', 'Hybrid Test Owner', 'test-only', true)
    `, [ownerId]);
    await pool.query(`
      INSERT INTO ${schema}.asset_entities (
        id, owner_user_id, visibility, asset_kind, name, display_name, intro,
        style_tags, metadata
      ) VALUES (
        $1, $2, 'personal', 'scene', '雨夜巷口', '冷色雨夜巷口', '追逐戏场景',
        '["冷色", "追逐"]'::jsonb, '{"provider_payload":"must-not-index"}'::jsonb
      )
    `, [entityId, ownerId]);
    await pool.query(`
      INSERT INTO ${schema}.asset_variants (
        id, asset_entity_id, variant_kind, name, usage_context, visual_prompt, source_text
      ) VALUES ($1, $2, 'angle', '低机位追逐镜头', '追逐戏', '雨夜巷口低机位跟拍', '镜头参考')
    `, [variantId, entityId]);

    const entity = await pool.query<{ search_text: string }>(`
      SELECT search_text FROM ${schema}.asset_entities WHERE id = $1
    `, [entityId]);
    assert.match(entity.rows[0]?.search_text ?? "", /雨夜巷口/);
    assert.match(entity.rows[0]?.search_text ?? "", /冷色/);
    assert.doesNotMatch(entity.rows[0]?.search_text ?? "", /must-not-index/);

    const variant = await pool.query<{ search_text: string }>(`
      SELECT search_text FROM ${schema}.asset_variants WHERE id = $1
    `, [variantId]);
    assert.match(variant.rows[0]?.search_text ?? "", /低机位追逐镜头/);
    assert.match(variant.rows[0]?.search_text ?? "", /镜头参考/);

    const recalled = await pool.query<{ id: string }>(`
      SELECT id FROM ${schema}.asset_entities
      WHERE search_text ILIKE '%雨夜%' OR search_text % '雨夜巷口'
    `);
    assert.deepEqual(recalled.rows, [{ id: entityId }]);

    await pool.query(`
      UPDATE ${schema}.asset_entities
      SET name = '晨雾街口', display_name = '晨雾街口'
      WHERE id = $1
    `, [entityId]);
    const refreshed = await pool.query<{ search_text: string }>(`
      SELECT search_text FROM ${schema}.asset_entities WHERE id = $1
    `, [entityId]);
    assert.match(refreshed.rows[0]?.search_text ?? "", /晨雾街口/);
    assert.doesNotMatch(refreshed.rows[0]?.search_text ?? "", /雨夜巷口/);

    const indexes = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = $1
        AND indexname IN ('asset_entities_search_text_trgm_active_idx', 'asset_variants_search_text_trgm_active_idx')
      ORDER BY indexname
    `, [schemaName]);
    assert.deepEqual(indexes.rows.map((row) => row.indexname), [
      "asset_entities_search_text_trgm_active_idx",
      "asset_variants_search_text_trgm_active_idx",
    ]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

async function migrationFilesThrough016(): Promise<string[]> {
  return (await readdir(path.resolve("migrations")))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName) && fileName < "017_hybrid_asset_search.sql")
    .sort((left, right) => left.localeCompare(right));
}

async function applyMigrations(
  executor: Pick<Pool, "query">,
  schemaName: string,
  fileNames: readonly string[],
): Promise<void> {
  for (const fileName of fileNames) {
    const source = await readFile(path.resolve("migrations", fileName), "utf8");
    await executor.query(renderMigrationSql(source, schemaName));
  }
}

function assertLocalTestDatabaseUrl(value: string): void {
  const host = new URL(value).hostname;
  assert.ok(
    host === "127.0.0.1" || host === "localhost" || host === "::1",
    "HYBRID_SEARCH_TEST_DATABASE_URL 只允许指向本机一次性测试库",
  );
}
