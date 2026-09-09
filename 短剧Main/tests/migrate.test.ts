import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertSafeSchemaName, quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

test("migration schema names are restricted to PostgreSQL identifiers", () => {
  assert.equal(assertSafeSchemaName("common_v01"), "common_v01");
  assert.equal(quoteIdentifier("common_v01"), '"common_v01"');
  assert.throws(() => assertSafeSchemaName("common; drop schema public"));
  assert.throws(() => assertSafeSchemaName("1common"));
});

test("the V0.1 migration renders all schema placeholders", async () => {
  const source = await readFile(path.resolve("migrations/001_v01_core.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /"common_test"\.users/);
  assert.match(rendered, /"common_test"\.generation_attempts/);
  assert.match(rendered, /retry_idempotency_key varchar\(255\)/);
  assert.match(rendered, /generation_attempts_retry_idempotency_unique/);
  assert.match(rendered, /"common_test"\.agent_messages/);
});

test("the generation quote migration freezes one-time confirmation and retry binding", async () => {
  const source = await readFile(path.resolve("migrations/002_generation_quotes.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /"common_test"\.generation_quotes/);
  assert.match(rendered, /status IN \('pending_confirmation', 'confirmed', 'consumed'\)/);
  assert.match(rendered, /base_attempt_id uuid REFERENCES "common_test"\.generation_attempts/);
  assert.match(rendered, /generation_quotes_attempt_idx/);
});

test("the S67 accounting migration binds debit and ledger actors to the generation initiator", async () => {
  const source = await readFile(path.resolve("migrations/037_s67_generation_accounting_actor.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /ADD COLUMN IF NOT EXISTS confirmed_by_user_id uuid/);
  assert.match(rendered, /REFERENCES "common_test"\.users\(id\) ON DELETE RESTRICT/);
  assert.match(rendered, /generation_quotes_accounting_actor_check/);
  assert.match(rendered, /\) NOT VALID;/);
  assert.match(rendered, /SELECT request\.user_id\s+INTO billing_actor_user_id/);
  assert.match(rendered, /NEW\.user_id IS DISTINCT FROM billing_actor_user_id/);
  assert.match(rendered, /NEW\.confirmed_by_user_id IS DISTINCT FROM billing_actor_user_id/);
  assert.match(rendered, /SELECT attempt\.request_id\s+INTO attempt_request_id/);
  assert.match(rendered, /attempt_request_id IS DISTINCT FROM NEW\.generation_request_id/);
  assert.match(rendered, /NEW\.action = 'retry' AND NEW\.original_request_id IS DISTINCT FROM NEW\.generation_request_id/);
  assert.match(rendered, /WHERE user_id = billing_actor_user_id/);
  assert.match(rendered, /NEW\.id, billing_actor_user_id, 'generation_debit'/);
});

test("the vocabulary migration opens lane/role checks to FK vocabularies and admits audio media", async () => {
  const source = await readFile(path.resolve("migrations/020_vocabulary_and_media_kind_audio.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");
  assert.equal(rendered.includes("{{schema}}"), false);
  // Three vocabulary tables with their seeds.
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.reference_lane_vocabulary/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.asset_role_vocabulary/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.genre_suggestions/);
  for (const lane of ["character", "scene", "prop", "lighting", "camera_motion", "reference_video", "audio"]) {
    assert.match(rendered, new RegExp(`'${lane}'`));
  }
  for (const role of ["character_identity", "motion", "camera_storyboard", "style_env"]) {
    assert.match(rendered, new RegExp(`'${role}'`));
  }
  for (const genre of ["甜宠", "虐恋", "重生", "复仇", "穿越", "其他"]) {
    assert.match(rendered, new RegExp(genre));
  }
  // Lane/role CHECKs are dropped and replaced by FK constraints.
  assert.match(rendered, /DROP CONSTRAINT IF EXISTS control_package_refs_lane_check/);
  assert.match(rendered, /ADD CONSTRAINT control_package_refs_lane_fk\s+FOREIGN KEY \(lane\) REFERENCES "common_test"\.reference_lane_vocabulary\(id\)/);
  assert.match(rendered, /DROP CONSTRAINT IF EXISTS asset_entities_control_role_check/);
  assert.match(rendered, /ADD CONSTRAINT asset_entities_role_fk\s+FOREIGN KEY \(role\) REFERENCES "common_test"\.asset_role_vocabulary\(id\)/);
  // All seven media_kind CHECKs now admit 'audio' (media_results included:
  // its column is media_kind; only the constraint name omits the prefix).
  const audioChecks = rendered.match(/CHECK \(media_kind IN \('image', 'video', 'audio'\)\)/g) ?? [];
  assert.equal(audioChecks.length, 7);
});
