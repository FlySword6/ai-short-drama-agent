import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

/**
 * 迁移 027 真 PG 演练(S31 真源合一):在独立的 release_card_keys_rehearsal
 * schema 里从空库逐文件重放迁移目录全链(001→027),核对 027 的三条机制:
 *   1) 回填:024 播种的 47 张 release_section 卡片全部补上 card_key,且值=卡片
 *      id(与 docs/design/version-plan.md 的锚点一一对应);卡片顺序不变;
 *   2) 幂等:027 重放命中 0 行(WHERE 守卫),是真 no-op;
 *   3) 守卫:运营/sync 写过的自定义 card_key 重放不覆盖;被摘掉的 card_key
 *      重放按 id 补回。release_history_entry 不在回填范围。
 * 与业务库 schema 完全隔离,收尾 DROP SCHEMA,不留痕迹。
 * 真库不可用就 skip(不设 RELEASE_PLAN_TEST_DATABASE_URL 时),不假装通过。
 */
const requestedDatabaseUrl = process.env.RELEASE_PLAN_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;
const rehearsalSchema = "release_card_keys_rehearsal";
const quoted = quoteIdentifier(rehearsalSchema);

interface SectionRow {
  entry_key: string;
  payload: { cards: Array<Record<string, unknown>> };
}

test("迁移 027:空库全链重放回填 card_key、重放 no-op、自定义 key 不覆盖", {
  skip: !databaseUrl
    ? "未设 RELEASE_PLAN_TEST_DATABASE_URL——027 真 PG 演练需要本地 dev 库(compose),此处如实 skip 不假装通过"
    : false,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);

    const files = (await readdir(path.resolve("migrations")))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    assert.ok(files.some((name) => name.startsWith("027_")), "迁移目录必须包含 027");
    for (const file of files) {
      const source = await readFile(path.resolve("migrations", file), "utf8");
      await handle.pool.query(renderMigrationSql(source, rehearsalSchema));
    }

    // ── 回填:五段 47 卡全部 card_key = id,顺序与播种一致 ──
    const sections = await handle.pool.query<SectionRow>(
      `SELECT entry_key, payload FROM ${quoted}.config_entries
       WHERE kind = 'release_section' ORDER BY sort`,
    );
    assert.deepEqual(
      sections.rows.map((row) => row.entry_key),
      ["v0.1.x", "v0.2.0", "v0.2.x", "v0.3.0", "v0.4+"],
    );
    const expectedIds: Record<string, string[]> = {
      "v0.1.x": ["core-domain", "generation-quotes", "director-console", "review-domain", "reference-tests", "admin-console", "cli-compat", "audit"],
      "v0.2.0": ["control-packages", "ai-gateway", "operations-base", "hybrid-search", "topic-radar", "review-gate", "vocabulary-open", "voice-workshop-1", "media-registration"],
      "v0.2.x": ["script-breakdown", "env-governance", "config-source", "dev-env-one-command", "db-engineering", "config-honesty", "asset-kind-vocabulary", "tag-system", "contract-validation", "merge-wave-1", "cost-metric"],
      "v0.3.0": ["timeline-workbench", "editing-transitions", "subtitles", "final-export", "relation-system", "continuity", "style-reference", "image-inpaint", "canvas-workbench", "motion-replica", "skill-library", "book-breakdown", "rbac-teams"],
      "v0.4+": ["model-catalog", "voice-clone", "ip-plaza", "distribution", "real-person-ip", "phone-camera-motion"],
    };
    let total = 0;
    for (const row of sections.rows) {
      const keys = row.payload.cards.map((card) => card.card_key);
      const ids = row.payload.cards.map((card) => card.id);
      assert.deepEqual(keys, expectedIds[row.entry_key], `${row.entry_key} 的 card_key 清单与播种 id 必须一一对应`);
      assert.deepEqual(keys, ids, `${row.entry_key} 的 card_key 必须回填为各自 id 且顺序不变`);
      total += row.payload.cards.length;
    }
    assert.equal(total, 47, "五段卡片合计 47 张");

    // ── 幂等:027 重放命中 0 行 ──
    const source027 = await readFile(path.resolve("migrations", "027_release_card_keys.sql"), "utf8");
    const second = await handle.pool.query(renderMigrationSql(source027, rehearsalSchema));
    assert.equal(second.rowCount, 0, "守卫生效:重放不许再碰任何行");

    // ── 守卫:自定义 card_key 不覆盖,被摘掉的按 id 补回(只碰该段一行) ──
    await handle.pool.query(
      `UPDATE ${quoted}.config_entries
       SET payload = jsonb_set(payload, '{cards}', (
         SELECT jsonb_agg(
           CASE
             WHEN card.value ->> 'id' = 'env-governance' THEN card.value || '{"card_key":"custom-env"}'::jsonb
             WHEN card.value ->> 'id' = 'tag-system' THEN card.value - 'card_key'
             ELSE card.value
           END
           ORDER BY card.ordinality
         )
         FROM jsonb_array_elements(payload -> 'cards') WITH ORDINALITY AS card(value, ordinality)
       ))
       WHERE kind = 'release_section' AND entry_key = 'v0.2.x'`,
    );
    const third = await handle.pool.query(renderMigrationSql(source027, rehearsalSchema));
    assert.equal(third.rowCount, 1, "只有被动过的那一段需要再回填");
    const v02x = await handle.pool.query<SectionRow>(
      `SELECT entry_key, payload FROM ${quoted}.config_entries
       WHERE kind = 'release_section' AND entry_key = 'v0.2.x'`,
    );
    const byId = new Map(v02x.rows[0]!.payload.cards.map((card) => [card.id, card]));
    assert.equal(byId.get("env-governance")?.card_key, "custom-env", "运营/sync 写过的 card_key 重放不覆盖");
    assert.equal(byId.get("tag-system")?.card_key, "tag-system", "被摘掉的 card_key 按 id 补回");
    const fourth = await handle.pool.query(renderMigrationSql(source027, rehearsalSchema));
    assert.equal(fourth.rowCount, 0, "补回后再次重放恢复 no-op");

    // ── 范围:release_history_entry 不回填(没有 cards,WHERE 守卫天然跳过) ──
    const history = await handle.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ${quoted}.config_entries WHERE kind = 'release_history_entry'`,
    );
    assert.ok(history.rows.length > 0);
    for (const row of history.rows) {
      assert.equal("cards" in row.payload, false, "历史条目没有 cards,不应被回填逻辑触碰");
    }
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("RELEASE_PLAN_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
