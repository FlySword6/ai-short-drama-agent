import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

test("S49 PostgreSQL lineage is immutable, historical-unknown, and recursively authoritative", async () => {
  const source = await readFile(path.resolve("migrations/035_s49_aigc_and_seedance_expiry.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.media_provenance_subjects/);
  assert.match(rendered, /media_provenance_subject_xor_check/);
  assert.match(rendered, /source_channel IN \('first_party_generation', 'external_upload', 'provider_library', 'unknown'\)/);
  assert.match(rendered, /INSERT INTO "common_test"\.media_provenance_subjects \(asset_media_id, source_channel\)\s+SELECT id, 'unknown'/);
  assert.match(rendered, /INSERT INTO "common_test"\.media_provenance_subjects \(media_result_id, source_channel\)\s+SELECT id, 'unknown'/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.media_provenance_parent_edges/);
  assert.match(rendered, /media provenance parent edges are immutable/);
  assert.match(rendered, /WITH RECURSIVE ancestors/);
  assert.match(rendered, /media_provenance_has_external_image_ancestor/);
  assert.match(rendered, /source_channel IS DISTINCT FROM 'first_party_generation'/);
  assert.match(rendered, /coalesce\(result_row\.contains_external_image_ancestor, true\)/);
  assert.match(rendered, /NEW\.trusted_at := result_row\.created_at/);
  assert.match(rendered, /trusted media provenance parent set is frozen/);
});
