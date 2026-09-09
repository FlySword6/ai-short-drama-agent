import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../db/migrate.js";

test("029 锁定音频版本必须保留完整资产引用，硬删除不能把正式事实置空", async () => {
  const source = await readFile(path.resolve("migrations/029_sound_workshop.sql"), "utf8");
  const rendered = renderMigrationSql(source, "fixture_schema");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /status = 'locked'[\s\S]*locked_asset_entity_id IS NOT NULL[\s\S]*locked_asset_media_id IS NOT NULL[\s\S]*project_asset_ref_id IS NOT NULL/);
  assert.match(rendered, /locked_asset_entity_id uuid REFERENCES [\s\S]*ON DELETE RESTRICT/);
  assert.match(rendered, /locked_asset_media_id uuid REFERENCES [\s\S]*ON DELETE RESTRICT/);
  assert.match(rendered, /project_asset_ref_id uuid REFERENCES [\s\S]*ON DELETE RESTRICT/);
});
