import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

test("Seedance 素材登记迁移保留唯一映射、状态机和脱敏审计约束", async () => {
  const source = await readFile(path.resolve("migrations/015_seedance_asset_registrations.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.seedance_asset_registrations/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.seedance_asset_registration_attempts/);
  assert.match(rendered, /'pending', 'submitting', 'processing', 'active', 'failed', 'unknown'/);
  assert.match(rendered, /seedance_asset_registrations_asset_media_unique/);
  assert.match(rendered, /seedance_asset_registrations_source_result_unique/);
  assert.match(rendered, /WHERE source_media_result_id IS NOT NULL/);
  assert.match(rendered, /seedance_asset_registrations_remote_asset_unique/);
  assert.match(rendered, /'create', 'refresh', 'reuse'/);
  assert.match(rendered, /'submitting', 'submitted', 'processing', 'active', 'failed', 'unknown', 'already_active'/);
  assert.match(rendered, /provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599/);
  assert.match(rendered, /seedance_asset_registration_attempts_error_message_sanitized_check/);
  assert.match(rendered, /seedance_asset_registration_attempts_number_unique/);
  assert.match(rendered, /outcome IN \('submitting', 'failed', 'unknown'\)/);
  assert.doesNotMatch(rendered, /storage_url/i);
});

test("053 火山素材登记迁移建立组幂等事实并补齐登记最新状态", async () => {
  const source = await readFile(path.resolve("migrations/053_volc_asset_registration.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.volc_asset_groups/);
  assert.match(rendered, /volc_asset_groups_identity_unique/);
  assert.match(rendered, /project_name, group_type, name/);
  assert.match(rendered, /'pending', 'creating', 'active', 'failed', 'unknown'/);
  assert.match(rendered, /'configured', 'created'/);
  assert.match(rendered, /ALTER COLUMN asset_group_id DROP NOT NULL/);
  assert.match(rendered, /ADD COLUMN IF NOT EXISTS latest_request_id varchar\(128\)/);
  assert.match(rendered, /ADD COLUMN IF NOT EXISTS latest_error_message varchar\(512\)/);
  assert.match(rendered, /ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0/);
  assert.match(rendered, /ADD COLUMN IF NOT EXISTS last_retry_at timestamptz/);
  assert.match(rendered, /action IN \('group', 'create', 'list', 'refresh', 'reuse', 'bind'\)/);
  assert.doesNotMatch(rendered, /(?:^|\n)\s+(storage_url|access_key_id|secret_access_key)\s+/im);
});
