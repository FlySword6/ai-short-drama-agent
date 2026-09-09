import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../src/db/migrate.js";

const migrationPath = path.resolve("migrations/018_topic_radar.sql");
const scopeMigrationPath = path.resolve("migrations/040_sgoal06_topic_radar_scopes.sql");

test("topic-radar migration is schema-scoped and uses a neutral source identity", async () => {
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, "topic_radar_contract_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "topic_radar_contract_test"\.topic_radar_snapshots/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "topic_radar_contract_test"\.topic_radar_items/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "topic_radar_contract_test"\.topic_radar_upstream_calls/);
  assert.match(rendered, /source = '52api_hongguo_ranking'/);
  assert.doesNotMatch(rendered, /52api_hg_new_top/);
  assert.doesNotMatch(rendered, /52api_hg_top/);
});

test("040 将账本和快照升级为 schema scoped resource scope，且旧行归入 legacy_hot", async () => {
  const rendered = renderMigrationSql(await readFile(scopeMigrationPath, "utf8"), "topic_radar_contract_test");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /ADD COLUMN IF NOT EXISTS resource_scope varchar\(128\) NOT NULL DEFAULT 'legacy_hot'/);
  assert.match(rendered, /\(source, cache_date, request_kind, resource_scope\)/);
  assert.match(rendered, /DROP INDEX IF EXISTS "topic_radar_contract_test"\.topic_radar_upstream_calls_daily_unique/);
});

test("topic-radar migration preserves provenance while enforcing daily quota claims", async () => {
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, "topic_radar_contract_test");

  for (const column of [
    "cache_date",
    "rank_date",
    "fetched_at",
    "raw_payload",
    "raw_item",
    "requested_by_user_id",
    "snapshot_id",
    "error_code",
    "error_message",
  ]) {
    assert.match(rendered, new RegExp(`\\b${column}\\b`));
  }

  assert.match(rendered, /topic_radar_upstream_calls_daily_unique/);
  assert.match(rendered, /WHERE request_kind = 'daily'/);
  assert.match(rendered, /topic_radar_upstream_calls_manual_unique/);
  assert.match(rendered, /WHERE request_kind = 'manual'/);
  assert.match(rendered, /request_kind IN \('daily', 'manual'\)/);
  assert.match(rendered, /status IN \('fetching', 'succeeded', 'failed'\)/);
  assert.match(rendered, /topic_radar_upstream_calls_state_shape_check/);
  assert.match(rendered, /topic_radar_upstream_calls_error_message_sanitized_check/);
  assert.match(rendered, /jsonb_typeof\(raw_payload\) IN \('object', 'array'\)/);
  assert.match(rendered, /REFERENCES "topic_radar_contract_test"\.users\(id\) ON DELETE RESTRICT/);
  assert.match(rendered, /REFERENCES "topic_radar_contract_test"\.topic_radar_snapshots\(id\) ON DELETE RESTRICT/);
});
