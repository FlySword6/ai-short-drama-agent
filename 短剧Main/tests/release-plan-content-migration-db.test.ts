import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

/**
 * 迁移 023 真 PG 演练(任务包 S24「配置迁移第二波」):
 * 在独立的 release_plan_rehearsal schema 里从空库逐文件重放迁移目录全链
 * (001→023),核对 023 的两块内容:
 *   1) 版本计划内容替换——022 播种的七个固定 UUID 被删除,新八行
 *      (release_section 五段 47 卡 + release_history_entry 三条)落库,
 *      source 全部 seed-024;
 *   2) reference_lane_vocabulary 扩 recommended 列并回填七条。
 * 再重放一次 023 验幂等;最后实证「运营改过的新行/词表条目,重放不覆盖」
 * 的守卫语义。与业务库 schema 完全隔离,收尾 DROP SCHEMA,不留痕迹。
 */
const requestedDatabaseUrl = process.env.RELEASE_PLAN_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;
const rehearsalSchema = "release_plan_rehearsal";
const quoted = quoteIdentifier(rehearsalSchema);

/** 022 播种、023 必须删掉的七个固定 UUID。 */
const LEGACY_022_IDS = [
  "826696a5-5179-402a-89cf-51d0a630bf70",
  "2e8c9bc0-8e4c-481c-a2e3-0a0e12e01d10",
  "849962d1-bbb0-4767-b0da-2a368846cd73",
  "715ee032-6831-4626-bac0-832de8806a10",
  "41e37609-fc06-4ed3-a6ad-8dc9f02d8c4b",
  "d6f71004-0772-4b7a-b7d8-fba17dc9c306",
  "17d7f449-f776-4e11-914c-19e180abfc5c",
];

test("release plan content migration: 空库全链重放+023 幂等+内容替换+守卫语义", {
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
      .sort((left, right) => left.localeCompare(right));
    assert.ok(files.some((name) => name.startsWith("022_")), "迁移目录必须包含 022");
    assert.ok(files.some((name) => name.startsWith("023_")), "迁移目录必须包含 023");
    for (const file of files) {
      const source = await readFile(path.resolve("migrations", file), "utf8");
      await handle.pool.query(renderMigrationSql(source, rehearsalSchema));
    }

    // ── 内容替换:八行新内容,五段 47 卡,三条历史,source 全 seed-024 ──
    const sections = await handle.pool.query<{ entry_key: string; payload: { cards: unknown[] } }>(
      `SELECT entry_key, payload FROM ${quoted}.config_entries
       WHERE kind = 'release_section' AND status = 'published' ORDER BY sort`,
    );
    assert.deepEqual(
      sections.rows.map((row) => row.entry_key),
      ["v0.1.x", "v0.2.0", "v0.2.x", "v0.3.0", "v0.4+"],
      "release_section 必须是新五段且顺序正确",
    );
    assert.equal(
      sections.rows.reduce((total, row) => total + row.payload.cards.length, 0),
      47,
      "五段卡片合计必须是 47 张",
    );
    const history = await handle.pool.query<{ entry_key: string }>(
      `SELECT entry_key FROM ${quoted}.config_entries
       WHERE kind = 'release_history_entry' AND status = 'published' ORDER BY sort`,
    );
    assert.deepEqual(
      history.rows.map((row) => row.entry_key),
      ["v0.2.0", "v0.1.2", "v0.1.1"],
      "release_history_entry 必须播种三条且新发布在前",
    );
    const sources = await handle.pool.query<{ source: string }>(
      `SELECT DISTINCT source FROM ${quoted}.config_entries`,
    );
    assert.deepEqual(sources.rows.map((row) => row.source), ["seed-024"], "种子来源必须全部标记 seed-024");

    // 022 播种的七行必须已被删除
    const legacy = await handle.pool.query<{ id: string }>(
      `SELECT id FROM ${quoted}.config_entries WHERE id = ANY($1::uuid[])`,
      [LEGACY_022_IDS],
    );
    assert.deepEqual(legacy.rows, [], "022 播种的七个固定 UUID 必须全部被 023 删除");

    // ── recommended 扩列:七条 lane 全部回填非空 ──
    const lanes = await handle.pool.query<{
      id: string;
      recommended: Array<{ key?: string; label?: string; required?: boolean }>;
    }>(
      `SELECT id, recommended FROM ${quoted}.reference_lane_vocabulary ORDER BY id`,
    );
    assert.deepEqual(
      lanes.rows.map((row) => row.id),
      ["audio", "camera_motion", "character", "lighting", "prop", "reference_video", "scene"],
      "lane 词表必须仍是 020 播种的七条(sort 按 domain 各自编号,不按全局排序)",
    );
    for (const lane of lanes.rows) {
      assert.ok(lane.recommended.length > 0, `${lane.id} 的 recommended 必须回填非空`);
      for (const item of lane.recommended) {
        assert.equal(typeof item.key, "string", `${lane.id} recommended 元素必须有 key`);
        assert.equal(typeof item.label, "string", `${lane.id} recommended 元素必须有 label`);
        assert.equal(typeof item.required, "boolean", `${lane.id} recommended 元素必须有 required`);
      }
    }

    // ── 守卫语义:运营改过的新行与词表条目,重放 023 不得覆盖 ──
    await handle.pool.query(
      `UPDATE ${quoted}.config_entries
       SET payload = payload || '{"note":"运营改过的文案"}'::jsonb, updated_at = now()
       WHERE kind = 'release_section' AND entry_key = 'v0.4+'`,
    );
    await handle.pool.query(
      `UPDATE ${quoted}.reference_lane_vocabulary
       SET recommended = '[{"key":"custom","label":"运营自建的推荐项","required":false}]'::jsonb
       WHERE id = 'prop'`,
    );
    const source023 = await readFile(
      path.resolve("migrations", "024_release_plan_content.sql"), "utf8");
    await handle.pool.query(renderMigrationSql(source023, rehearsalSchema));

    const edited = await handle.pool.query<{ payload: { note?: string } }>(
      `SELECT payload FROM ${quoted}.config_entries
       WHERE kind = 'release_section' AND entry_key = 'v0.4+'`,
    );
    assert.equal(
      edited.rows[0]?.payload.note,
      "运营改过的文案",
      "重放 023 不得覆盖库内运营改动(ON CONFLICT DO NOTHING)",
    );
    const editedLane = await handle.pool.query<{ recommended: Array<{ key: string }> }>(
      `SELECT recommended FROM ${quoted}.reference_lane_vocabulary WHERE id = 'prop'`,
    );
    assert.equal(
      editedLane.rows[0]?.recommended[0]?.key,
      "custom",
      "运营改过的 recommended 重放不得被守卫 UPDATE 回填",
    );

    // ── 幂等:023 整体已重放过一遍(上面),行数与内容必须稳定 ──
    const count = await handle.pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM ${quoted}.config_entries`,
    );
    assert.equal(Number(count.rows[0]?.total), 8, "重放 023 后行数必须仍是八行");
    const legacyAfter = await handle.pool.query<{ id: string }>(
      `SELECT id FROM ${quoted}.config_entries WHERE id = ANY($1::uuid[])`,
      [LEGACY_022_IDS],
    );
    assert.deepEqual(legacyAfter.rows, [], "重放 023 后 022 旧行不得复活");
    // 未被运营改过的 lane(如 scene)重放后仍是种子内容
    const sceneLane = await handle.pool.query<{ recommended: Array<{ key: string }> }>(
      `SELECT recommended FROM ${quoted}.reference_lane_vocabulary WHERE id = 'scene'`,
    );
    assert.deepEqual(
      sceneLane.rows[0]?.recommended.map((item) => item.key),
      ["master", "variants"],
      "未改过的 lane 重放后必须仍是种子 recommended",
    );
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
