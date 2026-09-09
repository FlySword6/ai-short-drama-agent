import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

test("反馈迁移固定个人复制幂等键和轻量事件约束", async () => {
  const source = await readFile(path.resolve("migrations/011_feedback_events_and_asset_copy.sql"), "utf8");
  const rendered = renderMigrationSql(source, "fixture_schema");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /copied_from_asset_entity_id uuid/);
  assert.match(rendered, /asset_entities_active_personal_copy_unique/);
  assert.match(rendered, /owner_user_id, copied_from_asset_entity_id/);
  assert.match(rendered, /WHERE visibility = 'personal'/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.events/);
  assert.match(rendered, /events_name_check/);
  assert.match(rendered, /events_props_object_check/);
  assert.match(rendered, /events_user_occurred_idx/);
});
