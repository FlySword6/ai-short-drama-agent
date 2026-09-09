import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../src/db/migrate.js";

test("047 静态合同：凭据来源、legacy 撤销与 Agent 审计字段必须一起迁移", async () => {
  const source = await readFile(path.resolve("migrations/047_agent_credential_source_and_session_isolation.sql"), "utf8");
  const rendered = renderMigrationSql(source, "agent_credential_static");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /credential_source varchar\(16\)/);
  assert.match(rendered, /SET credential_source = 'legacy'/);
  assert.match(rendered, /WHERE credential_source = 'legacy'\s+AND revoked_at IS NULL/);
  assert.match(rendered, /ALTER COLUMN credential_source SET NOT NULL/);
  assert.match(rendered, /credential_source IN \('legacy', 'web', 'cli', 'agent'\)/);
  assert.match(rendered, /issued_by_session_id\) REFERENCES "agent_credential_static"\.sessions\(id\) ON DELETE RESTRICT/);
  assert.match(rendered, /sessions_human_active_idx[\s\S]*credential_source IN \('web', 'cli'\)/);
  assert.match(rendered, /sessions_agent_active_idx[\s\S]*credential_source = 'agent'/);
  assert.match(rendered, /auth_session_id\) REFERENCES "agent_credential_static"\.sessions\(id\) ON DELETE SET NULL/);
  assert.match(rendered, /SET agent_type = 'legacy_assistant'/);
  assert.match(rendered, /source IN \('web', 'assistant', 'cli', 'agent'\)/);
});
