import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getTableColumns } from "drizzle-orm";
import { renderMigrationSql } from "../src/db/migrate.js";
import {
  assetMediaRepairActions,
  assetMediaRepairBlockers,
  assetMediaRepairTasks,
  assetMediaRenditions,
  databaseSchema,
} from "../src/db/schema.js";

test("052 资产媒体修理迁移：展示变体、幂等任务与不可变动作审计合同", async () => {
  const migrationPath = path.resolve("migrations/052_asset_media_repair.sql");
  const [source, ledgerSource] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(path.resolve("migrations/ledger.json"), "utf8"),
  ]);
  const rendered = renderMigrationSql(source, "asset_media_repair_static");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "asset_media_repair_static"\.asset_media_renditions/);
  assert.match(rendered, /asset_media_id uuid NOT NULL REFERENCES "asset_media_repair_static"\.asset_media\(id\) ON DELETE RESTRICT/);
  assert.match(rendered, /rendition_kind IN \('thumbnail', 'detail'\)/);
  assert.match(rendered, /strategy IN \('tos_process', 'stored_object'\)/);
  assert.match(rendered, /asset_media_renditions_healthy_facts_check/);
  assert.match(rendered, /storage_path ~ '\^asset-renditions\/v1\/\[0-9a-f\]\{2\}\/\[0-9a-f\]\{64\}\[\.\]webp\$'/);
  assert.match(rendered, /asset_media_renditions_media_kind_unique/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "asset_media_repair_static"\.asset_media_repair_tasks/);
  assert.match(rendered, /requested_by_user_id uuid REFERENCES "asset_media_repair_static"\.users\(id\) ON DELETE RESTRICT/);
  assert.match(rendered, /asset_media_repair_tasks_actor_idempotency_unique[\s\S]*WHERE requested_by_user_id IS NOT NULL AND client_idempotency_key IS NOT NULL/);
  assert.match(rendered, /mode = 'safe'/);
  assert.match(rendered, /trigger IN \('manual', 'self_heal', 'batch'\)/);
  assert.match(rendered, /trigger <> 'manual' OR requested_by_user_id IS NOT NULL/);
  assert.match(rendered, /status IN \('queued', 'processing', 'succeeded', 'partial', 'failed'\)/);
  assert.match(rendered, /claim_token uuid/);
  assert.match(rendered, /lease_expires_at timestamptz/);
  assert.match(rendered, /asset_media_repair_tasks_processing_lease_check/);
  assert.match(rendered, /asset_media_repair_tasks_expired_lease_idx[\s\S]*WHERE status = 'processing'/);
  assert.match(rendered, /asset_media_repair_tasks_queued_created_idx[\s\S]*WHERE status = 'queued'/);
  assert.match(rendered, /asset_media_repair_tasks_active_asset_unique[\s\S]*WHERE status IN \('queued', 'processing'\)/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "asset_media_repair_static"\.asset_media_repair_blockers/);
  assert.match(rendered, /state_fingerprint varchar\(32\) NOT NULL/);
  assert.match(rendered, /retry_after timestamptz NOT NULL DEFAULT \(now\(\) \+ interval '24 hours'\)/);
  assert.match(rendered, /asset_media_repair_blockers_retry_idx/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "asset_media_repair_static"\.asset_media_repair_actions/);
  assert.match(rendered, /asset_media_repair_actions_append_only/);
  assert.match(rendered, /BEFORE UPDATE OR DELETE ON "asset_media_repair_static"\.asset_media_repair_actions/);
  assert.doesNotMatch(rendered, /ALTER TABLE "asset_media_repair_static"\.asset_media/);

  const ledger = JSON.parse(ledgerSource) as { checksums: Record<string, string> };
  assert.equal(ledger.checksums["052_asset_media_repair.sql"], createHash("sha256").update(source).digest("hex"));
  assert.equal(databaseSchema.assetMediaRenditions, assetMediaRenditions);
  assert.equal(databaseSchema.assetMediaRepairTasks, assetMediaRepairTasks);
  assert.equal(databaseSchema.assetMediaRepairBlockers, assetMediaRepairBlockers);
  assert.equal(databaseSchema.assetMediaRepairActions, assetMediaRepairActions);
  assert.deepEqual(Object.keys(getTableColumns(assetMediaRenditions)).sort(), [
    "assetMediaId", "checkedAt", "createdAt", "errorCode", "errorMessage", "format", "heightPx", "id",
    "processSpec", "renditionKind", "sha256", "sourceSha256", "status", "storageBucket", "storagePath",
    "storageUrl", "strategy", "updatedAt", "widthPx",
  ]);
  assert.deepEqual(Object.keys(getTableColumns(assetMediaRepairTasks)).sort(), [
    "assetEntityId", "claimToken", "clientIdempotencyKey", "createdAt", "diagnosis", "errorCode", "errorMessage", "finishedAt",
    "id", "leaseExpiresAt", "mediaIds", "mode", "requestHash", "requestedByUserId", "result", "startedAt", "status", "trigger", "updatedAt",
  ]);
  assert.deepEqual(Object.keys(getTableColumns(assetMediaRepairActions)).sort(), [
    "action", "after", "assetMediaId", "before", "createdAt", "errorCode", "errorMessage", "id", "status", "taskId",
  ]);
});
