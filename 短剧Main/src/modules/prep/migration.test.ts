import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("迁移 046 同时落场级备戏真源与批量确认前状态", async () => {
  const source = await readFile(
    path.resolve("migrations/046_cli_v030_prep_and_batch_authorization.sql"),
    "utf8",
  );
  const rendered = source.replaceAll("{{schema}}", '"fixture_schema"');
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.scene_prep_items/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "fixture_schema"\.scene_prep_commits/);
  assert.match(rendered, /status IN \('pending', 'committed'\)/);
  assert.match(rendered, /target_mode IN \('scene', 'shots', 'all_shots'\)/);
  assert.match(rendered, /status IN \('confirmed', 'completed', 'partial', 'failed'\)/);
  assert.match(rendered, /status = 'confirmed'/);
  assert.match(rendered, /generation_request_id IS NULL/);
  assert.match(rendered, /generation_attempt_id IS NULL/);
});
