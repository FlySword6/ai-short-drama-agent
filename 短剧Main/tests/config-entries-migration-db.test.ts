import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

/**
 * 迁移 022 真 PG 演练(任务包 S23「配置真源」;合流时迁移改号 023→022,
 * 种子 source 标签保留 seed-023 未改):
 * 在独立的 config_rehearsal schema 里从空库逐文件重放 001→022,
 * 再重放一次 022 验幂等;核对七行播种、CHECK/UNIQUE 约束,
 * 以及「改一行再重放 022 不覆盖」的 seed 不覆盖语义。
 * 与业务库 schema 完全隔离,收尾 DROP SCHEMA,不留痕迹。
 *
 * 注意:本测试断言行集=022 播种态,故重放只到 022 为止;023(S24)
 * 会删除这七行并写入新内容,全链重放必炸。023 的全链演练见
 * tests/release-plan-content-migration-db.test.ts。
 */
const requestedDatabaseUrl = process.env.CONFIG_ENTRIES_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;
const rehearsalSchema = "config_rehearsal";
const quoted = quoteIdentifier(rehearsalSchema);

test("config entries migration: 空库 001→022 重放+022 幂等+播种+seed 不覆盖", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);

    const files = (await readdir(path.resolve("migrations")))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .filter((name) => Number(name.slice(0, 3)) <= 22)
      .sort((left, right) => left.localeCompare(right));
    assert.ok(files.length >= 22, "迁移目录必须至少包含 001→022");
    assert.ok(files.some((name) => name.startsWith("022_")), "迁移目录必须包含 022");
    for (const file of files) {
      const source = await readFile(path.resolve("migrations", file), "utf8");
      await handle.pool.query(renderMigrationSql(source, rehearsalSchema));
    }

    // 播种核对:五段 release_section(顺序=sort)+ 两条 release_history_entry
    const sections = await handle.pool.query<{ entry_key: string; payload: { cards: unknown[] } }>(
      `SELECT entry_key, payload FROM ${quoted}.config_entries
       WHERE kind = 'release_section' AND status = 'published' ORDER BY sort`,
    );
    assert.deepEqual(
      sections.rows.map((row) => row.entry_key),
      ["v0.1.2", "v0.1.3", "v0.2", "v0.3", "vision"],
      "release_section 必须播种五段且顺序正确",
    );
    assert.equal(
      sections.rows.reduce((total, row) => total + row.payload.cards.length, 0),
      26,
      "五段卡片合计必须是 26 张",
    );
    const history = await handle.pool.query<{ entry_key: string }>(
      `SELECT entry_key FROM ${quoted}.config_entries
       WHERE kind = 'release_history_entry' AND status = 'published' ORDER BY sort`,
    );
    assert.deepEqual(
      history.rows.map((row) => row.entry_key),
      ["v0.1.2", "v0.1.1"],
      "release_history_entry 必须播种两条",
    );
    const sources = await handle.pool.query<{ source: string }>(
      `SELECT DISTINCT source FROM ${quoted}.config_entries`,
    );
    assert.deepEqual(sources.rows.map((row) => row.source), ["seed-023"], "种子来源必须标记 seed-023");

    // 约束实证:status / kind CHECK 与 (kind, entry_key) UNIQUE
    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.config_entries (id, kind, entry_key, status)
         VALUES ($1, 'release_section', 'bad-status', 'live')`,
        [randomUUID()],
      ),
      (error: unknown) => isCheckViolation(error),
      "status 只接受 draft/published/archived,越界必须 23514",
    );
    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.config_entries (id, kind, entry_key)
         VALUES ($1, 'ReleaseSection', 'bad-kind')`,
        [randomUUID()],
      ),
      (error: unknown) => isCheckViolation(error),
      "kind 必须小写蛇形,越界必须 23514",
    );
    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.config_entries (id, kind, entry_key)
         VALUES ($1, 'release_section', 'v0.1.2')`,
        [randomUUID()],
      ),
      (error: unknown) => isUniqueViolation(error),
      "(kind, entry_key) 冲突必须 23505",
    );

    // seed 不覆盖语义:库内改动一行,重放 022 后改动必须原样保留
    await handle.pool.query(
      `UPDATE ${quoted}.config_entries
       SET payload = payload || '{"note":"运营改过的文案"}'::jsonb, updated_at = now()
       WHERE kind = 'release_section' AND entry_key = 'vision'`,
    );
    const source022 = await readFile(
      path.resolve("migrations", "022_config_entries_release_plan.sql"), "utf8");
    await handle.pool.query(renderMigrationSql(source022, rehearsalSchema));
    const edited = await handle.pool.query<{ payload: { note: string } }>(
      `SELECT payload FROM ${quoted}.config_entries
       WHERE kind = 'release_section' AND entry_key = 'vision'`,
    );
    assert.equal(
      edited.rows[0]?.payload.note,
      "运营改过的文案",
      "重放 022 不得覆盖库内运营改动(ON CONFLICT DO NOTHING)",
    );

    // 幂等:022 整体已重放过一遍(上面),行数必须仍是 7
    const count = await handle.pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM ${quoted}.config_entries`,
    );
    assert.equal(Number(count.rows[0]?.total), 7, "重放 022 后行数必须仍是七行");
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

function isCheckViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23514";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("CONFIG_ENTRIES_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
