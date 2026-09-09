import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

const migrationPath = path.resolve("migrations/033_voice_vocabulary.sql");
const integrationTestDatabaseUrl = process.env.VOICE_VOCABULARY_TEST_DATABASE_URL;

test("033 是 schema 作用域、幂等,自指 canonical + voice_type + audition_url,不落 CHECK 冻结", async () => {
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, "voice_vocab_contract_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "voice_vocab_contract_test"\.voice_vocabulary\b/);

  // 自指 canonical:别名与规范词同表,规范词指向自己(照 031 口径)。
  assert.match(rendered, /canonical_id varchar\(96\) NOT NULL REFERENCES "voice_vocab_contract_test"\.voice_vocabulary\(id\)/);
  // 裁决 1/3 要求的列:voice_type、audition_url、active、sort。
  assert.match(rendered, /voice_type varchar\(96\)/);
  assert.match(rendered, /audition_url text/);
  assert.match(rendered, /active boolean NOT NULL DEFAULT true/);
  assert.match(rendered, /sort int NOT NULL DEFAULT 0/);

  // 开放词表红线:不落 CHECK、不 ALTER 既有表、不装扩展。
  assert.doesNotMatch(rendered, /CHECK\s*\(/i);
  assert.doesNotMatch(rendered, /ALTER TABLE/i);
  assert.doesNotMatch(rendered, /CREATE EXTENSION/i);

  // 幂等重放:三张种子段全部 ON CONFLICT DO NOTHING。
  const conflicts = rendered.match(/ON CONFLICT \(id\) DO NOTHING/g) ?? [];
  assert.equal(conflicts.length, 3);

  // 种子结构自洽:586 行,每行 id = canonical_id = voice_type,sort 1..586 不重不漏。
  const rowPattern = /^  \('([^']+)', '([^']+)', '([^']+)', '((?:[^']|'')+)', '([^']+)', '([^']+)', '(男|女)', (\d+)\),?$/gm;
  const rows = [...rendered.matchAll(rowPattern)];
  assert.equal(rows.length, 586, "种子行数必须是 586");
  const sorts = new Set<number>();
  const ids = new Set<string>();
  for (const row of rows) {
    const [, id, canonicalId, voiceType, , , , , sortText] = row;
    assert.equal(canonicalId, id, `规范词必须自指: ${id}`);
    assert.equal(voiceType, id, `规范词 voice_type 必须与 id 同值: ${id}`);
    const sort = Number(sortText);
    assert.ok(Number.isSafeInteger(sort) && sort >= 1 && sort <= 586, `sort 越界: ${id}`);
    assert.ok(!sorts.has(sort), `sort 重复: ${sort}`);
    assert.ok(!ids.has(id), `voice_type 重复: ${id}`);
    sorts.add(sort);
    ids.add(id);
  }

  // 出处抽查锚点:三张表的代表条目必须在种子里。
  for (const sample of [
    "('zh_female_vv_uranus_bigtts', 'zh_female_vv_uranus_bigtts', 'zh_female_vv_uranus_bigtts', 'Vivi 2.0'",
    "'ICL_uranus_zh_female_wenwanshanshan_tob'",
    "'ar_female_dina_uranus_bigtts'",
    "'zh_female_tianxinxiaomei_emo_v2_mars_bigtts'",
  ]) {
    assert.ok(rendered.includes(sample), `缺种子 ${sample}`);
  }

  // 「端到端实时语音大模型 S2S」音色不是 TTS voice_type,一律不收录。
  assert.doesNotMatch(rendered, /'saturn_[^']*'/);
  assert.doesNotMatch(rendered, /_jupiter_bigtts'/);

  // 回滚口径注释必须在(模板形态保留 {{schema}} 占位符)。
  assert.match(source, /回滚口径[\s\S]*DROP TABLE IF EXISTS \{\{schema\}\}\.voice_vocabulary/);
  assert.match(rendered, /DROP TABLE IF EXISTS "voice_vocab_contract_test"\.voice_vocabulary/);
});

/**
 * 真 PG 演练:回放 033 两遍(幂等)、自指 FK 拒悬空、别名行 voice_type 为空。
 * 未设 VOICE_VOCABULARY_TEST_DATABASE_URL 时如实 skip,不假装通过。
 */
test("033 在真 PG 可重放,586 条规范词种子 + 自指 FK 生效", {
  skip: !integrationTestDatabaseUrl,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabase(integrationTestDatabaseUrl);
  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = `voice_vocab_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const quoted = quoteIdentifier(schemaName);
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, schemaName);
  try {
    await pool.query(`CREATE SCHEMA ${quoted}`);
    // 最小依赖表:created_by FK 的指向。
    await pool.query(`CREATE TABLE ${quoted}.users (id uuid PRIMARY KEY)`);
    await pool.query(rendered);
    // 重放第二遍:行数不变(幂等)。
    await pool.query(rendered);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${quoted}.voice_vocabulary`);
    assert.equal(Number(count.rows[0]!.count), 586, "种子必须恰好 586 条且重放不翻倍");

    const selfRef = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${quoted}.voice_vocabulary WHERE id = canonical_id AND voice_type = id`);
    assert.equal(Number(selfRef.rows[0]!.count), 586, "全部规范词必须自指且 voice_type 与 id 同值");

    const audition = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${quoted}.voice_vocabulary WHERE audition_url IS NOT NULL`);
    assert.equal(Number(audition.rows[0]!.count), 0, "未预渲染前 audition_url 必须全空");

    // 自指 FK 拒绝悬空 canonical。
    await assert.rejects(
      pool.query(`INSERT INTO ${quoted}.voice_vocabulary (id, canonical_id, display_name) VALUES ('御姐音', '不存在', '御姐音')`),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );

    // 别名行:voice_type 为空、canonical_id 指向已播种规范词,合法落库。
    await pool.query(
      `INSERT INTO ${quoted}.voice_vocabulary (id, canonical_id, display_name)
       VALUES ('御姐音', 'zh_female_cancan_uranus_bigtts', '御姐音')`,
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("VOICE_VOCABULARY_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
