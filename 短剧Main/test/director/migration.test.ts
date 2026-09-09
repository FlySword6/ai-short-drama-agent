import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../src/db/migrate.js";

test("director scene migration is repeatable and schema-scoped", async () => {
  const source = await readFile(path.resolve("migrations/004_director_scenes.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_director_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_director_test"\.director_scenes/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_director_test"\.director_scene_versions/);
  assert.match(rendered, /director_scenes_project_active_unique/);
  assert.match(rendered, /director_scene_versions_scene_version_unique/);
  assert.match(rendered, /jsonb_typeof\(snapshot\) = 'object'/);
});
