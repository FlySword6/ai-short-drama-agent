import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

/**
 * 迁移 021 合同:草稿区三表 + scenes/shots 追溯列,全语句幂等,无事务块
 * (运行器统一包事务)。真 PG 演练见 tests/script-breakdown-db.test.ts。
 */
const source = readFileSync(path.resolve("migrations/021_script_breakdown.sql"), "utf8");
const rendered = renderMigrationSql(source, "app");
const source045 = readFileSync(path.resolve("migrations/045_script_breakdown_enrichment.sql"), "utf8");
const rendered045 = renderMigrationSql(source045, "app");
const source048 = readFileSync(path.resolve("migrations/048_script_breakdown_execution_token.sql"), "utf8");
const rendered048 = renderMigrationSql(source048, "app");
const source076 = readFileSync(path.resolve("migrations/076_script_breakdown_active_run_guard.sql"), "utf8");
const rendered076 = renderMigrationSql(source076, "app");

test("021:草稿区三表齐备,状态机与幂等键在库级约束里", () => {
  for (const table of ["episode_script_versions", "script_breakdown_runs", "script_breakdown_run_stages"]) {
    assert.match(rendered, new RegExp(`CREATE TABLE IF NOT EXISTS "app"\\.${table}`), `${table} 必须建表`);
  }
  // 运行状态机七态 + 阶段四态
  assert.match(rendered, /CHECK \(status IN \('queued', 'running', 'draft', 'failed', 'confirmed', 'discarded', 'superseded'\)\)/);
  assert.match(rendered, /CHECK \(status IN \('pending', 'running', 'succeeded', 'failed'\)\)/);
  // 确认/放弃/被替换三对状态-字段形状联合 CHECK
  assert.match(rendered, /script_breakdown_runs_confirmed_shape_check/);
  assert.match(rendered, /script_breakdown_runs_discarded_shape_check/);
  assert.match(rendered, /script_breakdown_runs_superseded_shape_check/);
  // 幂等键唯一约束(版本与运行各一)
  assert.equal(rendered.match(/created_by_user_id, client_idempotency_key/g)?.length, 2);
  // 剧本版本:同一集版本号唯一
  assert.match(rendered, /episode_script_versions_episode_version_unique[\s\S]*?\(episode_id, version_no\)/);
  // 阶段检查点:同一运行内 stage_key 唯一
  assert.match(rendered, /script_breakdown_run_stages_run_key_unique[\s\S]*?\(run_id, stage_key\)/);
});

test("021:正式 scenes/shots 只增追溯列,候选级部分唯一兜底", () => {
  assert.match(rendered, /ALTER TABLE "app"\.scenes ADD COLUMN IF NOT EXISTS source_breakdown_run_id/);
  assert.match(rendered, /ALTER TABLE "app"\.shots ADD COLUMN IF NOT EXISTS source_breakdown_run_id/);
  assert.match(rendered, /ALTER TABLE "app"\.scenes ADD COLUMN IF NOT EXISTS source_candidate_id/);
  assert.match(rendered, /ALTER TABLE "app"\.shots ADD COLUMN IF NOT EXISTS source_candidate_id/);
  for (const index of ["scenes_breakdown_candidate_unique", "shots_breakdown_candidate_unique"]) {
    assert.match(rendered, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${index}[\\s\\S]*?WHERE source_breakdown_run_id IS NOT NULL AND deleted_at IS NULL`));
  }
});

test("021:无事务块、无硬编码 schema、全部语句幂等可重放", () => {
  assert.ok(!/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(source), "迁移文件不得自带事务块");
  assert.ok(!source.includes("{{schema}}") || rendered.includes('"app".'), "{{schema}} 必须被渲染");
  assert.ok(!/CREATE TABLE(?! IF NOT EXISTS)/i.test(rendered), "建表必须 IF NOT EXISTS");
  assert.ok(!/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/i.test(rendered), "建索引必须 IF NOT EXISTS");
  assert.ok(!/ADD COLUMN(?! IF NOT EXISTS)/i.test(rendered), "加列必须 IF NOT EXISTS");
});

test("021:草稿区表不含 provider 原始响应列", () => {
  // 红线:诊断只存受限结构,不存原始响应(体积与敏感信息双重问题)
  const stageTable = rendered.slice(rendered.indexOf("script_breakdown_run_stages ("));
  assert.ok(!/raw_response|provider_response|response_text|prompt_text/i.test(stageTable));
});

test("045:分镜四栏进入正式层并锁定完整 JSON 形状", () => {
  assert.match(rendered045, /ALTER TABLE "app"\.shots\s+ADD COLUMN IF NOT EXISTS breakdown_elements jsonb/);
  assert.match(rendered045, /shots_breakdown_elements_shape_check/);
  assert.match(rendered045, /jsonb_typeof\(breakdown_elements\) = 'object'/);
  assert.match(rendered045, /breakdown_elements - ARRAY\['subject', 'action', 'visual', 'camera_language'\] = '\{\}'::jsonb/);
  assert.match(rendered045, /\?& ARRAY\['subject', 'action', 'visual', 'camera_language'\]/);
  for (const key of ["subject", "action", "visual", "camera_language"]) {
    assert.match(rendered045, new RegExp(`jsonb_typeof\\(breakdown_elements->'${key}'\\) IN \\('string', 'null'\\)`));
  }
});

test("045:允许旧行为空,迁移可重放且不自带事务", () => {
  assert.match(rendered045, /breakdown_elements IS NULL/);
  assert.match(rendered045, /ADD COLUMN IF NOT EXISTS breakdown_elements/);
  assert.match(rendered045, /DROP CONSTRAINT IF EXISTS shots_breakdown_elements_shape_check/);
  assert.ok(!/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(source045), "迁移文件不得自带事务块");
  assert.ok(!source045.includes("app."), "迁移不得硬编码 schema");
});

test("048:执行代次 token 可重放、可兼容既有运行", () => {
  assert.match(
    rendered048,
    /ALTER TABLE "app"\.script_breakdown_runs\s+ADD COLUMN IF NOT EXISTS execution_token uuid/,
  );
  assert.ok(!/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(source048), "迁移文件不得自带事务块");
  assert.ok(!source048.includes("app."), "迁移不得硬编码 schema");
});

test("076:每集只允许一条 queued/running/draft 活跃拆解", () => {
  assert.match(
    rendered076,
    /CREATE UNIQUE INDEX IF NOT EXISTS script_breakdown_runs_episode_active_unique[\s\S]*?\(episode_id\)[\s\S]*?WHERE status IN \('queued', 'running', 'draft'\)/,
  );
  assert.ok(!/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(source076), "迁移文件不得自带事务块");
  assert.ok(!source076.includes("app."), "迁移不得硬编码 schema");
});
