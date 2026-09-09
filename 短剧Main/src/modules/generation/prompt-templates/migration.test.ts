import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderMigrationSql } from "../../../db/migrate.js";

test("063 模板库迁移：只存用户自建模板、软删语义、部分唯一索引与 5000 上限", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.resolve(here, "../../../../migrations/063_prompt_templates.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");

  assert.equal(rendered.includes("{{schema}}"), false, "schema 占位符必须被渲染");
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.prompt_templates/);
  assert.match(rendered, /deleted_at timestamptz/);
  assert.match(rendered, /deleted_by_user_id uuid REFERENCES/);
  assert.match(rendered, /CHECK \(media_kind IN \('image', 'video'\)\)/);
  assert.match(rendered, /CHECK \(char_length\(btrim\(name\)\) BETWEEN 1 AND 80\)/);
  assert.match(rendered, /CHECK \(char_length\(btrim\(content\)\) BETWEEN 1 AND 5000\)/);
  /* 同名唯一只在未删除行上生效（软删后可复用名字）。 */
  assert.match(rendered, /prompt_templates_project_kind_name_active_key/);
  assert.match(rendered, /WHERE deleted_at IS NULL/);
  /* 历史回填：策略文本键 + 项目 054 列，均带长度守卫避免触发 CHECK。 */
  assert.match(rendered, /'历史模板'/);
  assert.match(rendered, /'项目设置历史模板'/);
  assert.match(rendered, /char_length\(s\.parameters->>'prompt_template'\) <= 5000/);
  assert.match(rendered, /char_length\(p\.image_prompt_template\) <= 5000/);
  assert.match(rendered, /char_length\(p\.video_prompt_template\) <= 5000/);
  /* 策略只改 JSONB 键形状（prompt_template → prompt_template_id），不要求策略表 DDL。 */
  assert.match(rendered, /'prompt_template_id'/);
  /* 显式迁移、应用启动不自动执行。 */
  assert.match(rendered, /应用启动不自动执行迁移/);
});
