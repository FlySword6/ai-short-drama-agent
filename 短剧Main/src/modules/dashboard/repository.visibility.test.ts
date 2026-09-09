import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { settings } from "../../config/env.js";
import {
  dashboardReadableProjectCondition,
  dashboardProjectVisibilityScope,
} from "./repository.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const dialect = new PgDialect();

// schema 名从配置来，不写死。写死过一次 "common"，结果是：本机 .env 恰好写着
// common 时门禁全绿，改回规范值 app 就有 5 项红——测试实际在校验开发者本机
// 的 .env，而不是代码行为。断言的是「表被 schema 限定了」，不是「schema 叫什么」。
const schema = settings.postgresSchema;
const qualified = (table: string, column?: string) =>
  new RegExp(`"${schema}"\\."${table}"${column ? `\\."${column}"` : ""}`);

test("普通成员的看板生产统计只读取 project_members 可见项目，viewer/editor 同样可读", () => {
  const query = dialect.sqlToQuery(dashboardReadableProjectCondition({ id: actorId, role: "member" })).sql;

  assert.equal(dashboardProjectVisibilityScope("member"), "project_memberships");
  assert.match(query, qualified("project_members"));
  assert.match(query, new RegExp(`"${schema}"\\."project_members"\\."user_id" = \\$1`));
  assert.doesNotMatch(query, qualified("projects", "owner_user_id"));
  // 不按 project_members.role 收窄，viewer 和 editor 都符合 ProjectAccess 的 read 权限。
  assert.doesNotMatch(query, qualified("project_members", "role"));
});

test("admin/operator 的看板生产统计可以读取全项目，但仍不恢复 owner_user_id 过滤", () => {
  for (const role of ["admin", "operator"] as const) {
    const query = dialect.sqlToQuery(dashboardReadableProjectCondition({ id: actorId, role })).sql;
    assert.equal(dashboardProjectVisibilityScope(role), "all_projects");
    assert.doesNotMatch(query, qualified("project_members"));
    assert.doesNotMatch(query, qualified("projects", "owner_user_id"));
  }
});
