import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

const migrationPath = path.resolve("migrations/031_tag_vocabulary_and_asset_kind_aliases.sql");
const integrationTestDatabaseUrl = process.env.TAG_VOCABULARY_TEST_DATABASE_URL;

const CANONICAL_KINDS: ReadonlyArray<readonly [string, string]> = [
  ["character", "角色"],
  ["scene", "场景"],
  ["prop", "道具"],
  ["costume", "服装"],
  ["lighting", "光线参考"],
  ["camera", "摄影参考"],
  ["video", "视频参考"],
  ["keyword", "关键帧"],
  ["animal", "动物"],
  ["reference", "参考"],
  ["model_3d", "3D 素模"],
  ["sound", "声音参考"],
  ["music", "配乐参考"],
  ["voice", "配音"],
];

const KIND_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["clothing", "costume"],
  ["keyframe", "keyword"],
  ["other", "reference"],
];

test("031 是 schema 作用域、幂等,三张表共用自指 canonical,不落任何 CHECK 冻结", async () => {
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, "tag_vocab_contract_test");

  assert.equal(rendered.includes("{{schema}}"), false);

  // 三张表全部 CREATE IF NOT EXISTS,挂在渲染后的带引号 schema 下。
  for (const table of ["tag_vocabulary", "asset_tags", "asset_kind_vocabulary"]) {
    assert.match(rendered, new RegExp(`CREATE TABLE IF NOT EXISTS "tag_vocab_contract_test"\\.${table}\\b`));
  }

  // 自指 canonical:canonical_id 指回同表 id,规范词自己指向自己。
  assert.match(rendered, /canonical_id varchar\(64\) NOT NULL REFERENCES "tag_vocab_contract_test"\.tag_vocabulary\(id\)/);
  assert.match(rendered, /canonical_id varchar\(32\) NOT NULL REFERENCES "tag_vocab_contract_test"\.asset_kind_vocabulary\(id\)/);

  // 多标签走真关联表:复合主键 + tag_id 索引 + 资产硬删级联。
  assert.match(rendered, /PRIMARY KEY \(asset_entity_id, tag_id\)/);
  assert.match(rendered, /REFERENCES "tag_vocab_contract_test"\.asset_entities\(id\) ON DELETE CASCADE/);

  // 开放词表红线:词表是建议源与解析真源,不是写入约束——
  // 本迁移不得出现任何 CHECK 约束,也不得 ALTER asset_entities 加 FK。
  assert.doesNotMatch(rendered, /CHECK\s*\(/i);
  assert.doesNotMatch(rendered, /ALTER TABLE/i);

  // 幂等重放:种子双段都 ON CONFLICT DO NOTHING。
  const conflicts = rendered.match(/ON CONFLICT \(id\) DO NOTHING/g) ?? [];
  assert.equal(conflicts.length, 2);

  // 种子:14 个规范词全部自指,3 个别名指向规范词;规范词段必须在别名声之前。
  for (const [id, label] of CANONICAL_KINDS) {
    assert.ok(rendered.includes(`('${id}', '${id}', '${label}'`), `缺规范词种子 ${id}/${label}`);
  }
  for (const [alias, canonical] of KIND_ALIASES) {
    assert.ok(rendered.includes(`('${alias}', '${canonical}'`), `缺别名种子 ${alias}→${canonical}`);
  }
  const canonicalInsertAt = rendered.indexOf("('character', 'character'");
  const aliasInsertAt = rendered.indexOf("('clothing', 'costume'");
  assert.ok(canonicalInsertAt > -1 && aliasInsertAt > canonicalInsertAt, "规范词必须先插、别名后插(自指 FK 顺序)");

  // 标签词表不播种:标签是用户内容,从空词表开始生长。
  assert.doesNotMatch(rendered, /INSERT INTO "tag_vocab_contract_test"\.tag_vocabulary/);
});

/**
 * 真 PG 演练:回放 031,验种子、自指 FK 拒悬空、复合主键去重、级联清理。
 * 未设 TAG_VOCABULARY_TEST_DATABASE_URL 时如实 skip,不假装通过。
 */
test("031 在真 PG 可重放,自指 FK/复合主键/级联全部生效", {
  skip: !integrationTestDatabaseUrl,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabase(integrationTestDatabaseUrl);
  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = `tag_vocab_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const quoted = quoteIdentifier(schemaName);
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, schemaName);
  try {
    await pool.query(`CREATE SCHEMA ${quoted}`);
    // 最小依赖表:created_by / asset_entity_id 两个 FK 的指向。
    await pool.query(`CREATE TABLE ${quoted}.users (id uuid PRIMARY KEY)`);
    await pool.query(`CREATE TABLE ${quoted}.asset_entities (id uuid PRIMARY KEY)`);
    await pool.query(rendered);

    // 种子:14 规范词 + 3 别名;重放第二遍行数不变(幂等)。
    await pool.query(rendered);
    const kinds = await pool.query<{ id: string; canonical_id: string }>(
      `SELECT id, canonical_id FROM ${quoted}.asset_kind_vocabulary`);
    assert.equal(kinds.rows.length, CANONICAL_KINDS.length + KIND_ALIASES.length);
    const byId = new Map(kinds.rows.map((row) => [row.id, row.canonical_id]));
    for (const [id] of CANONICAL_KINDS) assert.equal(byId.get(id), id, `规范词 ${id} 必须自指`);
    for (const [alias, canonical] of KIND_ALIASES) assert.equal(byId.get(alias), canonical, `别名 ${alias} 必须指向 ${canonical}`);

    // 自指 FK 拒绝悬空 canonical。
    await assert.rejects(
      pool.query(`INSERT INTO ${quoted}.tag_vocabulary (id, canonical_id, display_name) VALUES ('悬空', '不存在', '悬空')`),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );

    // 建一个规范词 + 一个资产,验 asset_tags 复合主键去重与硬删级联。
    await pool.query(`INSERT INTO ${quoted}.tag_vocabulary (id, canonical_id, display_name) VALUES ('雨夜', '雨夜', '雨夜')`);
    const assetId = randomUUID();
    await pool.query(`INSERT INTO ${quoted}.asset_entities (id) VALUES ($1)`, [assetId]);
    await pool.query(`INSERT INTO ${quoted}.asset_tags (asset_entity_id, tag_id) VALUES ($1, '雨夜')`, [assetId]);
    await assert.rejects(
      pool.query(`INSERT INTO ${quoted}.asset_tags (asset_entity_id, tag_id) VALUES ($1, '雨夜')`, [assetId]),
      (error: unknown) => (error as { code?: string }).code === "23505",
      "同一资产同一标签重复打必须撞复合主键",
    );
    await pool.query(`DELETE FROM ${quoted}.asset_entities WHERE id = $1`, [assetId]);
    const links = await pool.query(`SELECT 1 FROM ${quoted}.asset_tags WHERE asset_entity_id = $1`, [assetId]);
    assert.equal(links.rows.length, 0, "资产硬删除必须级联清理 asset_tags");
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("TAG_VOCABULARY_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
