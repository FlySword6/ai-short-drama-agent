import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = readFileSync(
  path.resolve("migrations/041_personal_assets_bypass_review.sql"),
  "utf8",
);

test("041 只归一个人域实体、变体和媒体，不改时间或删除审核历史", () => {
  assert.match(migration, /UPDATE \{\{schema\}\}\.asset_entities/);
  assert.match(migration, /WHERE visibility = 'personal'/);
  assert.match(migration, /SET status = 'approved', approved = TRUE/);
  assert.match(migration, /UPDATE \{\{schema\}\}\.asset_variants AS variant/);
  assert.match(migration, /entity\.visibility = 'personal'/);
  assert.match(migration, /UPDATE \{\{schema\}\}\.asset_media AS media/);
  assert.match(migration, /media\.asset_variant_id/);
  assert.doesNotMatch(migration, /updated_at|created_at|DELETE FROM|asset_review_actions/);
});

test("041 使用 schema 占位且可重复执行", () => {
  assert.doesNotMatch(migration, /\bcommon\./);
  assert.equal((migration.match(/\{\{schema\}\}/g) ?? []).length >= 7, true);
  assert.match(migration, /IS DISTINCT FROM/);
});
