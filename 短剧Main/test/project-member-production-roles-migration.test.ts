import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderMigrationSql } from "../src/db/migrate.js";
import { projectProductionRoles } from "../src/db/schema.js";
import { PROJECT_PRODUCTION_ROLES } from "../src/modules/operations/types.js";

test("051 新建独立多选生产职责关系且不改写 owner/editor/viewer 鉴权", async () => {
  const source = await readFile("migrations/051_project_member_production_roles.sql", "utf8");
  const rendered = renderMigrationSql(source, "project_roles_contract_test");

  assert.match(
    rendered,
    /CREATE TABLE IF NOT EXISTS "project_roles_contract_test"\.project_member_production_roles/,
  );
  assert.match(
    rendered,
    /PRIMARY KEY \(project_id, user_id, role\)/,
  );
  assert.match(
    rendered,
    /FOREIGN KEY \(project_id, user_id\)[\s\S]*REFERENCES "project_roles_contract_test"\.project_members\(project_id, user_id\)[\s\S]*ON DELETE CASCADE/,
  );
  assert.match(
    rendered,
    /CHECK \(role IN \('director', 'art', 'screenwriter', 'coordinator', 'reviewer'\)\)/,
  );
  assert.match(rendered, /project_member_production_roles_project_role_idx/);
  assert.match(rendered, /project_member_production_roles_user_project_idx/);
  assert.doesNotMatch(rendered, /ALTER TABLE[\s\S]*project_members[\s\S]*role/u);
});

test("数据库与 operations API 共用同一五角色顺序", () => {
  assert.deepEqual(
    [...PROJECT_PRODUCTION_ROLES],
    ["director", "art", "screenwriter", "coordinator", "reviewer"],
  );
  assert.deepEqual([...projectProductionRoles], [...PROJECT_PRODUCTION_ROLES]);
});
