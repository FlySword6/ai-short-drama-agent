import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderMigrationSql } from "../../../db/migrate.js";

test("066 风格库迁移：可多条、每项目每媒介至多一默认、软删语义与 5000 上限", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.resolve(here, "../../../../migrations/067_project_styles.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");

  assert.equal(rendered.includes("{{schema}}"), false, "schema 占位符必须被渲染");
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.project_styles/);
  assert.match(rendered, /is_default boolean NOT NULL DEFAULT false/);
  assert.match(rendered, /deleted_at timestamptz/);
  assert.match(rendered, /deleted_by_user_id uuid REFERENCES/);
  assert.match(rendered, /CHECK \(media_kind IN \('image', 'video'\)\)/);
  assert.match(rendered, /CHECK \(char_length\(btrim\(name\)\) BETWEEN 1 AND 80\)/);
  assert.match(rendered, /CHECK \(char_length\(btrim\(content\)\) BETWEEN 1 AND 5000\)/);
  /* 同名唯一只在未删除行上生效（软删后可复用名字）。 */
  assert.match(rendered, /project_styles_project_kind_name_active_key/);
  assert.match(rendered, /WHERE deleted_at IS NULL/);
  /* 每项目每媒介至多一个默认（锁定语义下默认行不可删/换设，索引恒成立）。 */
  assert.match(rendered, /project_styles_one_default_key/);
  assert.match(rendered, /AND is_default/);
  /* 历史回填：项目 054 遗留 style* 列 → 默认风格行，带长度守卫避免触发 CHECK。 */
  assert.match(rendered, /'项目设置历史风格'/);
  assert.match(rendered, /char_length\(p\.image_style_description\) <= 5000/);
  assert.match(rendered, /char_length\(p\.video_style_description\) <= 5000/);
  /* 显式迁移、应用启动不自动执行。 */
  assert.match(rendered, /应用启动不自动执行迁移/);
});
