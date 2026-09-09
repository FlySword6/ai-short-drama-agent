import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../../migrations/006_agent_message_audit.sql", import.meta.url), "utf8");

test("AI 日志迁移保存状态、用量、成本与耗时", () => {
  for (const column of [
    "status",
    "provider",
    "model",
    "usage",
    "provider_cost_usd_micros",
    "points_spent",
    "duration_ms",
    "error_summary",
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(migration, /agent_messages_status_check/);
  assert.match(migration, /agent_messages_session_created_desc_idx/);
  assert.match(migration, /agent_sessions_project_updated_idx/);
});
