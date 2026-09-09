import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../src/db/migrate.js";

test("AI gateway audit migration is schema-scoped and retains only metering metadata", async () => {
  const source = await readFile(path.resolve("migrations/014_ai_calls.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_ai_gateway_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_ai_gateway_test"\.ai_calls/);
  for (const column of [
    "caller_user_id",
    "project_id",
    "related_object_type",
    "related_object_id",
    "purpose",
    "provider",
    "model",
    "input_tokens",
    "output_tokens",
    "duration_ms",
    "cost_fen",
    "error_code",
    "completed_at",
  ]) {
    assert.match(rendered, new RegExp(`\\b${column}\\b`));
  }
  assert.match(rendered, /ai_calls_status_check/);
  assert.match(rendered, /ai_calls_related_object_pair_check/);
  assert.match(rendered, /ai_calls_nonnegative_metrics_check/);
  assert.match(rendered, /ai_calls_completion_state_check/);
  assert.match(rendered, /ai_calls_caller_created_desc_idx/);
  assert.match(rendered, /ai_calls_project_created_desc_idx/);
  assert.doesNotMatch(rendered, /\b(prompt|response|payload)\s+(text|jsonb)/i);
});
