import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

test("S42 上传队列迁移保留状态机、外键与排位/未读索引约束", async () => {
  const source = await readFile(path.resolve("migrations/032_asset_upload_tasks.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.asset_upload_tasks/);
  assert.match(rendered, /REFERENCES "common_test"\.users\(id\) ON DELETE CASCADE/);
  assert.match(rendered, /REFERENCES "common_test"\.asset_entities\(id\)/);
  assert.match(rendered, /'queued', 'processing', 'succeeded', 'failed'/);
  // 排位谓词与 worker 认领谓词同一个:status='queued' 按 created_at,id。
  assert.match(rendered, /asset_upload_tasks_queued_created_idx/);
  assert.match(rendered, /WHERE status = 'queued'/);
  assert.match(rendered, /asset_upload_tasks_unread_user_created_idx/);
  assert.match(rendered, /WHERE acknowledged_at IS NULL/);
});

test("S-goal-09 登记迁移把幂等、表单快照与本地/Seedance 两段结果加在原队列", async () => {
  const source = await readFile(path.resolve("migrations/043_asset_registration_upload_tasks.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /ALTER TABLE "common_test"\.asset_upload_tasks/);
  assert.match(rendered, /client_idempotency_key uuid/);
  assert.match(rendered, /registration_form jsonb/);
  assert.match(rendered, /result_asset_media_id uuid REFERENCES "common_test"\.asset_media\(id\)/);
  assert.match(rendered, /result_registration_id uuid REFERENCES "common_test"\.seedance_asset_registrations\(id\)/);
  assert.match(rendered, /asset_upload_tasks_user_idempotency_unique/);
  assert.match(rendered, /WHERE client_idempotency_key IS NOT NULL/);
  assert.match(rendered, /'pending', 'submitting', 'processing', 'active'/);
});
