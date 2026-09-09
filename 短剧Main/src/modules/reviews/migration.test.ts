import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

test("审核域迁移保存项目级策略、四态动作与拒绝理由约束", async () => {
  const source = await readFile(path.resolve("migrations/007_review_domain.sql"), "utf8");
  const rendered = renderMigrationSql(source, "fixture_schema");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.project_review_policies/);
  assert.match(rendered, /CHECK \(media_kind IN \('image', 'video'\)\)/);
  assert.match(rendered, /CHECK \(default_strategy IN \('automatic', 'pending_review'\)\)/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.asset_review_actions/);
  assert.match(rendered, /project_id uuid NOT NULL REFERENCES "fixture_schema"\.projects\(id\)/);
  assert.match(rendered, /'automatic_review', 'pending_review', 'approved', 'rejected'/);
  assert.match(rendered, /action = 'rejected' AND char_length\(btrim\(COALESCE\(rejection_reason, ''\)\)\) > 0/);
});

test("通用采购资产迁移只放宽 project_id，不另建审核事实表", async () => {
  const source = await readFile(path.resolve("migrations/009_global_asset_review_actions.sql"), "utf8");
  const rendered = renderMigrationSql(source, "fixture_schema");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /ALTER TABLE IF EXISTS "fixture_schema"\.asset_review_actions/);
  assert.match(rendered, /ALTER COLUMN project_id DROP NOT NULL/);
  assert.equal(rendered.includes("CREATE TABLE"), false);
});

test("019 产物审核与交付门禁迁移:动作留痕、状态机约束与交付记录", async () => {
  const source = await readFile(path.resolve("migrations/019_media_review_and_delivery.sql"), "utf8");
  const rendered = renderMigrationSql(source, "fixture_schema");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.media_review_actions/);
  assert.match(rendered, /media_result_id uuid NOT NULL REFERENCES "fixture_schema"\.media_results\(id\)/);
  assert.match(rendered, /CHECK \(action IN \('accepted', 'rejected', 'auto_accepted'\)\)/);
  assert.match(rendered, /from_status = 'needs_review' AND to_status IN \('accepted', 'rejected'\)/);
  assert.match(rendered, /action = 'auto_accepted' AND reviewer_user_id IS NULL/);
  assert.match(rendered, /action = 'rejected' AND char_length\(btrim\(COALESCE\(rejection_reason, ''\)\)\) > 0/);
  assert.match(rendered, /CREATE UNIQUE INDEX IF NOT EXISTS media_review_actions_auto_once_idx/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.delivery_records/);
  assert.match(rendered, /manifest_hash varchar\(64\) NOT NULL/);
  assert.match(rendered, /delivered_by_user_id uuid NOT NULL REFERENCES "fixture_schema"\.users\(id\)/);
  // 不修改既有表,只前向追加
  assert.equal(rendered.includes("ALTER TABLE"), false);
});
