import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

/**
 * 迁移真 PG 演练(任务书「真 PG 迁移演练:020 空库全链+幂等」):
 * 在独立的 vocab_rehearsal schema 里从空库逐文件重放全链迁移(001 起,含 070 的
 * costume/audio 词表与最新 media_kind 约束),再重放一次 020 验幂等,然后核对词表播种、
 * lane FK 与 media_kind audio CHECK。与业务库 schema 完全隔离,收尾 DROP SCHEMA,不留痕迹。
 */
const requestedDatabaseUrl = process.env.VOCABULARY_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;
const rehearsalSchema = "vocab_rehearsal";
const quoted = quoteIdentifier(rehearsalSchema);

test("vocabulary migration: 空库全链重放+020 幂等+播种/FK/audio CHECK", {
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
    assert.ok(files.length >= 20, "迁移目录必须至少包含 001→020");
    assert.ok(files.some((name) => name.startsWith("020_")), "迁移目录必须包含 020");
    for (const file of files) {
      const source = await readFile(path.resolve("migrations", file), "utf8");
      await handle.pool.query(renderMigrationSql(source, rehearsalSchema));
    }

    // 幂等:020 整体重放一遍不得报错(词表 ON CONFLICT、CHECK IF NOT EXISTS 路径)
    const source020 = await readFile(path.resolve("migrations", "020_vocabulary_and_media_kind_audio.sql"), "utf8");
    await handle.pool.query(renderMigrationSql(source020, rehearsalSchema));

    // 播种核对:七条 lane / 六条 role / 六条 genre
    const lanes = await handle.pool.query<{ id: string }>(
      `SELECT id FROM ${quoted}.reference_lane_vocabulary ORDER BY id`,
    );
    assert.deepEqual(
      lanes.rows.map((row) => row.id),
      ["audio", "camera_motion", "character", "lighting", "prop", "reference_video", "scene"],
      "lane 词表必须播种七条",
    );
    const roles = await handle.pool.query<{ id: string }>(
      `SELECT id FROM ${quoted}.asset_role_vocabulary ORDER BY id`,
    );
    assert.deepEqual(
      roles.rows.map((row) => row.id),
      ["audio", "camera_storyboard", "character_identity", "costume", "motion", "prop", "scene", "style_env"],
      "role 词表必须播种八条(020 六条 + 070 costume/audio)",
    );
    const genres = await handle.pool.query<{ id: string }>(
      `SELECT id FROM ${quoted}.genre_suggestions ORDER BY sort`,
    );
    assert.deepEqual(
      genres.rows.map((row) => row.id),
      ["甜宠", "虐恋", "重生", "复仇", "穿越", "其他"],
      "genre 建议必须播种六条",
    );

    // lane FK 实证:先搭 users→projects→episodes→shots→control_packages 链,
    // 再补 asset_entities→asset_media 作为真实来源,保证只有 lane 一个约束会失败
    const userId = randomUUID();
    const projectId = randomUUID();
    const episodeId = randomUUID();
    const shotId = randomUUID();
    const packageId = randomUUID();
    const rehearsalAssetId = randomUUID();
    const rehearsalMediaId = randomUUID();
    const now = new Date("2026-07-24T10:00:00.000Z");
    await handle.pool.query(
      `INSERT INTO ${quoted}.users (id, username, display_name, password_hash, active, created_at, updated_at)
       VALUES ($1, $2, 'Vocab Rehearsal', 'test-only-hash', true, $3, $3)`,
      [userId, `vocab-rehearsal-${userId.slice(0, 8)}`, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.projects (id, owner_user_id, name, description, status, created_at, updated_at)
       VALUES ($1, $2, 'Vocab Rehearsal Project', NULL, 'active', $3, $3)`,
      [projectId, userId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.episodes (id, project_id, episode_no, name, sort_order, status, created_at, updated_at)
       VALUES ($1, $2, 1, '第一集', 0, 'active', $3, $3)`,
      [episodeId, projectId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.shots
         (id, episode_id, scene_id, shot_code, title, script_text, director_prompt, image_prompt,
          video_prompt, duration_seconds, sort_order, reference_asset_snapshots,
          selected_image_result_id, selected_video_result_id, created_at, updated_at)
       VALUES ($1, $2, NULL, 'VR-01', '词表演练分镜', NULL, NULL, NULL, NULL, NULL, 0, '[]'::jsonb, NULL, NULL, $3, $3)`,
      [shotId, episodeId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.control_packages (id, shot_id, created_at, updated_at)
       VALUES ($1, $2, $3, $3)`,
      [packageId, shotId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.asset_entities
         (id, owner_user_id, visibility, asset_kind, name, reuse_scope, status,
          style_tags, metadata, use_count, created_at, updated_at)
       VALUES ($1, NULL, 'common', 'keyframe', 'Rehearsal Asset', 'all_projects', 'approved',
               '[]'::jsonb, '{}'::jsonb, 0, $2, $2)`,
      [rehearsalAssetId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.asset_media
         (id, asset_entity_id, media_kind, is_primary, sort_order, metadata, created_at)
       VALUES ($1, $2, 'image', true, 0, '{}'::jsonb, $3)`,
      [rehearsalMediaId, rehearsalAssetId, now],
    );

    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.control_package_refs (id, package_id, lane, asset_media_id, media_result_id, sort_order)
         VALUES ($1, $2, 'not_a_lane', $3, NULL, 0)`,
        [randomUUID(), packageId, rehearsalMediaId],
      ),
      (error: unknown) => isForeignKeyViolation(error),
      "020 后 lane 是 FK:未登记 lane 必须被数据库以 23503 拒绝",
    );

    // lighting 是 013 CHECK 之外新承认的参考栏(开放化播种):FK 必须接受
    const lightingRefId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.control_package_refs (id, package_id, lane, asset_media_id, media_result_id, sort_order)
       VALUES ($1, $2, 'lighting', $3, NULL, 0)`,
      [lightingRefId, packageId, rehearsalMediaId],
    );

    // media_kind audio CHECK 实证:generation_requests 接受 'audio'
    await handle.pool.query(
      `INSERT INTO ${quoted}.generation_requests
         (id, user_id, project_id, episode_id, scene_id, shot_id, target_asset_entity_id,
          media_kind, prompt, reference_media_ids, reference_asset_snapshots, parameters,
          quantity, client_idempotency_key, request_hash, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, NULL, $4, NULL,
               'audio', 'vocabulary rehearsal audio', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
               1, $5, $6, $7, $7)`,
      [randomUUID(), userId, projectId, shotId, `vocab-rehearsal-${randomUUID()}`, "e".repeat(64), now],
    );
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23503";
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("VOCABULARY_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
