import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getTableColumns } from "drizzle-orm";
import { renderMigrationSql } from "../src/db/migrate.js";
import { assetEntities, assetVariants } from "../src/db/schema.js";

const migrationPath = path.resolve("migrations/017_hybrid_asset_search.sql");

test("hybrid asset search migration is schema-scoped and requires DBA-managed pg_trgm", async () => {
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, "hybrid_search_contract_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /pg_extension WHERE extname = 'pg_trgm'/);
  assert.match(rendered, /请由数据库管理员先启用后再执行迁移/);
  assert.doesNotMatch(rendered, /CREATE\s+EXTENSION/i);

  for (const table of ["asset_entities", "asset_variants"]) {
    assert.match(rendered, new RegExp(`ALTER TABLE IF EXISTS "hybrid_search_contract_test"\\.${table}[\\s\\S]*?search_text text NOT NULL DEFAULT ''`));
  }
});

test("hybrid asset search migration maintains approved text and active permission indexes", async () => {
  const source = (await readFile(migrationPath, "utf8")).replace(/\r\n?/g, "\n");
  const rendered = renderMigrationSql(source, "hybrid_search_contract_test");

  assert.match(rendered, /refresh_asset_entity_search_text/);
  assert.match(rendered, /refresh_asset_variant_search_text/);
  assert.match(rendered, /asset_entities_refresh_search_text/);
  assert.match(rendered, /asset_variants_refresh_search_text/);
  assert.match(rendered, /style_tags_text/);
  assert.match(rendered, /metadata, object-storage locations, URLs, IDs,\n-- review history, or provider payloads/);
  assert.match(rendered, /asset_entities_search_text_trgm_active_idx/);
  assert.match(rendered, /asset_variants_search_text_trgm_active_idx/);
  assert.match(rendered, /gin \(search_text gin_trgm_ops\)/);
  assert.match(rendered, /asset_entities_search_visibility_owner_idx/);
  assert.match(rendered, /project_asset_refs_entity_project_active_idx/);
  assert.match(rendered, /COALESCE\(clearance ->> 'search', 'true'\) = 'true'/);
});

test("Drizzle schema exposes the migration 017 lexical facts", () => {
  assert.ok("searchText" in getTableColumns(assetEntities));
  assert.ok("searchText" in getTableColumns(assetVariants));
});
