import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  extractByteHouseCreateTailClause,
  loadByteHouseSchema,
  normalizeByteHouseSettingsClause,
  normalizeByteHouseTtlClause,
} from "../scripts/bytehouse-schema.mts";

interface LedgerEntry {
  readonly file: string;
  readonly sha256: string;
  readonly tables: string[];
  readonly views?: string[];
}

interface Ledger {
  readonly version: number;
  readonly database_placeholder: string;
  readonly migrations: LedgerEntry[];
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const migrationRoot = path.join(repoRoot, "bytehouse", "migrations");
const domainTables = [
  "events_product_fact",
  "cost_ledger_fact",
  "radar_fetch_runs",
  "radar_rank_items",
  "asset_vec_documents",
  "asset_vec_embeddings",
] as const;
const controlTables = ["sync_watermarks"] as const;
const searchTables = ["asset_vector_index"] as const;
const views = [
  "v_events_product_latest",
  "v_events_funnel_base",
  "v_cost_ledger_latest",
  "v_cost_daily",
  "v_radar_fetch_runs_latest",
  "v_radar_rank_items_latest",
  "v_asset_vec_documents_latest",
  "v_asset_vec_embeddings_latest",
  "v_sync_watermarks_latest",
  "v_asset_vector_index_latest",
] as const;

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function tupleTerms(source: string, clause: "ORDER BY" | "PRIMARY KEY"): string[] {
  const match = source.match(new RegExp(`${clause}\\s*\\(([^\\n]+)\\)`));
  assert.ok(match, `${clause} 缺失或不是显式 tuple`);
  return match[1]!.split(",").map((term) => term.trim());
}

test("S55 migration ledger pins existing domains plus the governed asset search projection", async () => {
  const ledger = JSON.parse(
    await readFile(path.join(migrationRoot, "ledger.json"), "utf8"),
  ) as Ledger;
  assert.equal(ledger.version, 1);
  assert.equal(ledger.database_placeholder, "{{database}}");
  assert.deepEqual(ledger.migrations.map(({ file }) => file), [
    "002_events.sql",
    "003_cost.sql",
    "004_radar.sql",
    "005_asset_vec.sql",
    "006_views.sql",
    "007_asset_vector_index.sql",
  ]);
  assert.deepEqual(
    ledger.migrations.flatMap(({ tables }) => tables),
    [...domainTables, ...controlTables, ...searchTables],
  );
  assert.deepEqual(
    ledger.migrations.flatMap(({ views: names = [] }) => names),
    views,
  );
  for (const entry of ledger.migrations) {
    const source = (await readFile(path.join(migrationRoot, entry.file), "utf8")).replace(/\r\n?/g, "\n");
    assert.equal(sha256(source), entry.sha256, `${entry.file} checksum 漂移`);
  }
});

test("schema loader sees eight physical tables and ten consumer views", async () => {
  const bundle = await loadByteHouseSchema();
  assert.deepEqual(bundle.tables.map(({ name }) => name), [
    ...domainTables,
    ...controlTables,
    ...searchTables,
  ]);
  assert.deepEqual(bundle.views.map(({ name }) => name), views);
  assert.equal(bundle.migrations.length, 6);
});

test("TTL verification accepts ByteHouse omitting the default DELETE action", () => {
  assert.equal(
    normalizeByteHouseTtlClause("toDateTime(retention_until) DELETE"),
    normalizeByteHouseTtlClause("toDateTime(retention_until)"),
  );
  assert.notEqual(
    normalizeByteHouseTtlClause("toDateTime(retention_until) DELETE"),
    normalizeByteHouseTtlClause("toDateTime(synced_at)"),
  );
});

test("canonical DDL parser stops SETTINGS at both ByteHouse COMMENT forms", () => {
  for (const comment of ["COMMENT '表注释'", "COMMENT = '表注释'"]) {
    const source = [
      "TTL toDateTime(retention_until)",
      "SETTINGS index_granularity = 8192",
      comment,
    ].join(" ");
    assert.equal(
      extractByteHouseCreateTailClause(source, "SETTINGS"),
      "index_granularity = 8192",
    );
  }
});

test("schema verification ignores only provider-owned ByteHouse settings", () => {
  assert.equal(
    normalizeByteHouseSettingsClause(
      "index_granularity = 8192, cnch_vw_write = 'opaque', storage_policy = 'opaque'",
    ),
    normalizeByteHouseSettingsClause("index_granularity = 8192"),
  );
  assert.notEqual(
    normalizeByteHouseSettingsClause(
      "index_granularity = 4096, cnch_vw_write = 'opaque'",
    ),
    normalizeByteHouseSettingsClause("index_granularity = 8192"),
  );
  assert.notEqual(
    normalizeByteHouseSettingsClause(
      "index_granularity = 8192, unknown_setting = 1",
    ),
    normalizeByteHouseSettingsClause("index_granularity = 8192"),
  );
});

test("每张物理表都有显式键、分区、TTL 和中文注释", async () => {
  const bundle = await loadByteHouseSchema();
  assert.equal(bundle.tables.length, 8);
  for (const table of bundle.tables) {
    assert.equal(table.engine, "CnchMergeTree");
    assert.ok(table.columns.length >= 7, `${table.name} 字段数量异常`);
    assert.match(table.comment, /[\u3400-\u9fff]/u);
    assert.match(table.ttl, /toDateTime\(retention_until\) DELETE/u);
    if (table.name === "asset_vector_index") {
      assert.match(table.settings, /index_granularity\s*=\s*128/u);
      assert.match(table.settings, /index_granularity_bytes\s*=\s*0/u);
    } else {
      assert.match(table.settings, /index_granularity\s*=\s*8192/u);
    }
    const orderBy = tupleTerms(table.source, "ORDER BY");
    const primaryKey = tupleTerms(table.source, "PRIMARY KEY");
    assert.deepEqual(
      orderBy.slice(0, primaryKey.length),
      primaryKey,
      `${table.name} PRIMARY KEY 必须是 ORDER BY 左前缀`,
    );
    for (const column of table.columns) {
      assert.match(column.comment, /[\u3400-\u9fff]/u, `${table.name}.${column.name}`);
    }
  }
});

test("域模型保留真实成本、雷达 scope 和可审计向量空合同", async () => {
  const [cost, radar, asset, all] = await Promise.all([
    readFile(path.join(migrationRoot, "003_cost.sql"), "utf8"),
    readFile(path.join(migrationRoot, "004_radar.sql"), "utf8"),
    readFile(path.join(migrationRoot, "005_asset_vec.sql"), "utf8"),
    Promise.all([
      "002_events.sql",
      "003_cost.sql",
      "004_radar.sql",
      "005_asset_vec.sql",
      "006_views.sql",
      "007_asset_vector_index.sql",
    ].map((file) => readFile(path.join(migrationRoot, file), "utf8"))),
  ]);
  assert.match(cost, /`cost_cny_micros` Nullable\(Int64\)/u);
  assert.match(cost, /`charged_points` Nullable\(Int64\)/u);
  assert.match(cost, /generation_quote 或 ai_call/u);
  assert.match(radar, /`resource_scope` String/u);
  assert.match(radar, /CHECK ordinal >= 0/u);
  assert.match(asset, /`embedding_dimension` UInt16/u);
  assert.match(asset, /length\(embedding\) = embedding_dimension/u);
  assert.doesNotMatch(asset, /DIM=1024|embedding_dimension = 1024/u);
  assert.match(all.join("\n"), /\basset_vector_index\b/u);
  assert.doesNotMatch(
    all.join("\n"),
    /password|api[_ -]?key|access[_ -]?key|secret[_ -]?key/iu,
  );
});

test("资产检索投影固定 1024 维 HNSW、CDW 二元倒排与 #77 安全门禁", async () => {
  const source = await readFile(
    path.join(migrationRoot, "007_asset_vector_index.sql"),
    "utf8",
  );
  for (const field of [
    "owner_subject_key",
    "sensitivity_level",
    "sensitivity_inheritance",
    "classification_state",
    "classification_source",
    "classification_rule_id",
    "classification_confidence",
    "classification_reason",
    "classification_evidence",
    "classification_confirmed_by",
    "classification_confirmed_at",
    "policy_version",
    "review_due_at",
    "rights_state",
    "rights_ref",
    "clearance_state",
    "clearance_ref",
    "review_state",
    "publication_state",
    "publication_ref",
    "transfer_rule",
    "transfer_ref",
    "retention_class",
    "retention_ref",
  ]) {
    assert.match(source, new RegExp(`\\\`${field}\\\``), `缺少 #77 字段 ${field}`);
  }
  assert.match(source, /TYPE inverted\(2\) GRANULARITY 1/u);
  assert.match(source, /TYPE HNSW\('DIM=1024, METRIC=COSINE'\)/u);
  assert.match(source, /CHECK source_sensitivity_level IN \('S0', 'S1', 'S2'\)/u);
  assert.match(source, /sensitivity_level IN \('S0', 'S1', 'S2'\)/u);
  assert.doesNotMatch(source, /sensitivity_level IN \([^)]*'S3'/u);
  assert.match(source, /CHECK classification_state = 'confirmed'/u);
  assert.match(source, /review_state IN \('human_accepted', 'human_corrected'\)/u);
  assert.match(source, /rights_state = 'cleared'/u);
  assert.match(source, /clearance_state = 'cleared'/u);
  assert.match(source, /publication_state = 'approved'/u);
  assert.match(source, /embedding_dimension = 1024 AND length\(embedding\) = 1024/u);
  assert.match(source, /LIMIT 1 BY source_table, source_id/u);
  assert.doesNotMatch(source, /advanced_inverted_v2|inverted\('standard'/u);
});

test("latest-row views provide replay-safe consumer surfaces", async () => {
  const source = (
    await Promise.all([
      "006_views.sql",
      "007_asset_vector_index.sql",
    ].map((file) => readFile(path.join(migrationRoot, file), "utf8")))
  ).join("\n");
  for (const view of views) {
    assert.match(source, new RegExp(`CREATE VIEW IF NOT EXISTS \\{\\{database\\}\\}\\.\\\`${view}\\\``));
  }
  for (const key of ["event_id", "entry_key", "run_id", "item_id", "document_id", "embedding_id", "domain"]) {
    assert.match(source, new RegExp(`LIMIT 1 BY ${key}`));
  }
  assert.match(source, /LIMIT 1 BY source_table, source_id/u);
});
