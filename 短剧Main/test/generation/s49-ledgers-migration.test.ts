import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const migrationPath = path.resolve("migrations/036_s49_trust_evidence_null_guard.sql");

test("S49 migration freezes quote-linked pending compensation facts", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.generation_billing_failure_facts/);
  assert.match(sql, /user_id uuid NOT NULL REFERENCES \{\{schema\}\}\.users\(id\)/);
  assert.match(sql, /project_id uuid NOT NULL REFERENCES \{\{schema\}\}\.projects\(id\)/);
  assert.match(sql, /quote_id uuid NOT NULL REFERENCES \{\{schema\}\}\.generation_quotes\(id\)/);
  assert.match(sql, /reserved_amount_fen integer NOT NULL/);
  assert.match(sql, /CHECK \(provider_cost_status = 'incurred'\)/);
  assert.match(sql, /CHECK \(resolution_status = 'pending_compensation'\)/);
  assert.match(sql, /UNIQUE \(attempt_id, quote_id\)/);
});

test("S49 migration records object-level TOS orphan facts and never deletes them", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.generation_tos_orphans/);
  assert.match(sql, /attempt_id uuid NOT NULL REFERENCES \{\{schema\}\}\.generation_attempts\(id\)/);
  assert.match(sql, /provider_result_key varchar\(512\) NOT NULL/);
  assert.match(sql, /storage_bucket varchar\(128\) NOT NULL/);
  assert.match(sql, /object_key varchar\(1024\) NOT NULL/);
  assert.match(sql, /produced_at timestamptz NOT NULL/);
  assert.match(sql, /CHECK \(cleanup_status IN \('pending_cleanup', 'referenced'\)\)/);
  assert.match(sql, /UNIQUE \(storage_bucket, object_key\)/);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+\{\{schema\}\}\.generation_tos_orphans\b/i);
});
