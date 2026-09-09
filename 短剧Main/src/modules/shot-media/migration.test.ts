import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

test("shot media asset registration migration keeps one media truth with strict origins", async () => {
  const source = await readFile(path.resolve("migrations/012_shot_media_asset_registration.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /origin_kind IN \('generation', 'asset_media'\)/);
  assert.match(rendered, /media_results_origin_xor_check/);
  assert.match(rendered, /source_asset_media_id IS NOT NULL/);
  assert.match(rendered, /request_id IS NULL/);
  assert.match(rendered, /media_results_active_shot_asset_source_unique/);
  assert.match(rendered, /ADD COLUMN IF NOT EXISTS role varchar\(32\)/);
  assert.match(rendered, /ADD COLUMN IF NOT EXISTS usage_mode varchar\(16\)/);
  assert.match(rendered, /asset_entities_control_role_check/);
  assert.match(rendered, /asset_entities_control_usage_mode_check/);
});
