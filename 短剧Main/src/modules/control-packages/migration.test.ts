import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

test("控制包迁移定义一对一容器、六栏、二选一引用与幂等索引", async () => {
  const source = await readFile(path.resolve("migrations/013_control_packages.sql"), "utf8");
  const rendered = renderMigrationSql(source, "fixture_schema");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.control_packages/);
  assert.match(rendered, /shot_id uuid NOT NULL REFERENCES "fixture_schema"\.shots\(id\) ON DELETE CASCADE/);
  assert.match(rendered, /CONSTRAINT control_packages_shot_unique UNIQUE \(shot_id\)/);
  assert.match(rendered, /CHECK \(\(ready_marked_by IS NULL\) = \(ready_marked_at IS NULL\)\)/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.control_package_refs/);
  assert.match(rendered, /'character', 'scene', 'prop', 'camera_motion', 'reference_video', 'audio'/);
  assert.match(rendered, /CHECK \(\(asset_media_id IS NULL\) <> \(media_result_id IS NULL\)\)/);
  assert.match(rendered, /control_package_refs_asset_lane_unique/);
  assert.match(rendered, /control_package_refs_result_lane_unique/);
});
