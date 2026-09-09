#!/usr/bin/env -S npx --no-install tsx
/**
 * PostgreSQL -> ByteHouse S55 domain projection syncer.
 *
 * This is deliberately a bounded, replayable batch sync for dev. PostgreSQL
 * remains truth. It copies only contract-approved fields, never prompt/output
 * bodies, raw provider payloads, signed URLs, credentials, or personal profile
 * fields. The same compiled batch is inserted twice during acceptance so the
 * latest-row consumer views can be compared for replay stability.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { Client as PgClient } from "pg";
import type { ClientConfig as PgClientConfig } from "pg";
import {
  ByteHouseHttpClient,
  loadByteHouseCredentials,
} from "./bytehouse-s55-hw.mts";

const DATABASE = "shortdrama_analytics";
const DEFAULT_SCHEMA = "app";
const DEFAULT_LIMIT = 5_000;
const RETENTION_DAYS = 90;
const CONFIRMATION = "SYNC_BYTEHOUSE_S55_DOMAINS_DEV";
const DOMAINS = ["events", "cost", "radar", "asset_vec"] as const;

type Domain = typeof DOMAINS[number];
type JsonRecord = Record<string, unknown>;

interface Input {
  readonly apply: boolean;
  readonly sourcePreflight: boolean;
  readonly environment?: string;
  readonly confirm?: string;
  readonly pgEnvFile?: string;
  readonly pgLocalDocker: boolean;
  readonly schema: string;
  readonly limit: number;
  readonly domains: readonly Domain[];
  readonly help: boolean;
}

interface PgEvent {
  readonly id: string;
  readonly user_id: string;
  readonly event: string;
  readonly props: JsonRecord;
  readonly occurred_at: Date;
  readonly received_at: Date;
}

interface PgAiCall {
  readonly id: string;
  readonly caller_user_id: string;
  readonly project_id: string | null;
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly duration_ms: number | null;
  readonly cost_fen: number | null;
  readonly created_at: Date;
  readonly completed_at: Date | null;
}

interface PgQuoteCost {
  readonly id: string;
  readonly user_id: string;
  readonly pricing_rule_id: string;
  readonly price_snapshot: JsonRecord;
  readonly estimated_cost_fen: number;
  readonly status: string;
  readonly generation_request_id: string | null;
  readonly generation_attempt_id: string | null;
  readonly created_at: Date;
  readonly confirmed_at: Date | null;
  readonly consumed_at: Date | null;
  readonly updated_at: Date;
  readonly ledger_created_at: Date | null;
  readonly charged_points: number | null;
  readonly project_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly media_kind: string | null;
  readonly actual_cost_fen: number | null;
  readonly cost_cny_micros: string | number | null;
  readonly calculation_status: string | null;
  readonly provider_cost_updated_at: Date | null;
}

interface PgRadarRun {
  readonly id: string;
  readonly source: string;
  readonly resource_scope: string;
  readonly cache_date: string | Date;
  readonly request_kind: string;
  readonly status: string;
  readonly requested_by_user_id: string;
  readonly snapshot_id: string | null;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly error_code: string | null;
  readonly rank_date: string | Date | null;
  readonly fetched_at: Date | null;
  readonly item_count: number | null;
  readonly raw_payload: unknown;
}

interface PgRadarItem {
  readonly id: string;
  readonly snapshot_id: string;
  readonly source: string;
  readonly resource_scope: string;
  readonly cache_date: string | Date;
  readonly rank_date: string | Date;
  readonly fetched_at: Date;
  readonly ordinal: number;
  readonly rank: number | null;
  readonly title: string;
  readonly heat: string | null;
  readonly link: string | null;
}

interface PgAssetEntity {
  readonly id: string;
  readonly source_project_id: string | null;
  readonly asset_kind: string;
  readonly role: string | null;
  readonly usage_mode: string | null;
  readonly name: string;
  readonly display_name: string | null;
  readonly intro: string | null;
  readonly search_text: string;
  readonly style_tags: unknown;
  readonly status: string;
  readonly visibility: string;
  readonly clearance: JsonRecord;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
  readonly authorized_project_ids: string[];
  readonly canonical_tag_ids: string[];
  readonly tag_labels: string[];
}

interface PgAssetVariant {
  readonly id: string;
  readonly asset_entity_id: string;
  readonly source_project_id: string | null;
  readonly asset_kind: string;
  readonly role: string | null;
  readonly usage_mode: string | null;
  readonly entity_name: string;
  readonly entity_display_name: string | null;
  readonly variant_kind: string;
  readonly variant_name: string;
  readonly description: string | null;
  readonly usage_context: string | null;
  readonly search_text: string;
  readonly status: string;
  readonly visibility: string;
  readonly clearance: JsonRecord;
  readonly updated_at: Date | null;
  readonly entity_updated_at: Date;
  readonly deleted_at: Date | null;
  readonly authorized_project_ids: string[];
  readonly canonical_tag_ids: string[];
  readonly tag_labels: string[];
}

interface CompiledDomain {
  readonly domain: Domain;
  readonly tables: readonly {
    readonly table: string;
    readonly rows: readonly JsonRecord[];
  }[];
  readonly viewQueries: readonly {
    readonly name: string;
    readonly sql: string;
  }[];
  readonly sourceVersion: number;
  readonly batchId: string;
  readonly cursor: string;
  readonly rowCount: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function timestamp(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

export function dateOnly(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("PostgreSQL date 无效");
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("PostgreSQL date 不是 YYYY-MM-DD");
  }
  return value;
}

function retentionFrom(value: Date): string {
  return timestamp(new Date(value.getTime() + RETENTION_DAYS * 86_400_000));
}

function nullableString(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function nullableUnsigned(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function subjectKey(id: string): string {
  return `subject:${sha256(`shortdrama-user:${id}`).slice(0, 32)}`;
}

function sourceVersion(id: string, value: Date): number {
  return value.getTime() * 1_000 + Number.parseInt(sha256(id).slice(0, 3), 16) % 1_000;
}

function latestDate(values: readonly (Date | null)[]): Date {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (dates.length === 0) return new Date(0);
  return new Date(Math.max(...dates.map((value) => value.getTime())));
}

function safeEventProps(props: JsonRecord): JsonRecord {
  const aliases: Readonly<Record<string, readonly string[]>> = {
    project_id: ["project_id", "projectId"],
    request_id: ["request_id", "generation_request_id", "requestId"],
    quote_id: ["quote_id", "generation_quote_id", "quoteId"],
    asset_entity_id: ["asset_entity_id", "assetEntityId"],
    media_kind: ["media_kind", "mediaKind"],
    result_status: ["result_status", "status"],
    search_mode: ["search_mode", "searchMode"],
    result_count: ["result_count", "resultCount"],
  };
  const result: JsonRecord = {};
  for (const [target, candidates] of Object.entries(aliases)) {
    const value = candidates.map((key) => props[key]).find((candidate) =>
      typeof candidate === "string" || typeof candidate === "number");
    if (typeof value === "string" && value.trim()) result[target] = value.slice(0, 128);
    if (target === "result_count" && typeof value === "number" && value >= 0) {
      result[target] = Math.floor(value);
    }
  }
  return result;
}

function safePublicUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

export function parseHeat(value: string | null): {
  readonly raw: string | null;
  readonly value: number | null;
  readonly status: "missing" | "parsed" | "unparsed";
} {
  const raw = nullableString(value, 128);
  if (!raw) return { raw: null, value: null, status: "missing" };
  const normalized = raw.replaceAll(",", "").replaceAll("，", "");
  const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*(亿|万)?/u);
  if (!match) return { raw, value: null, status: "unparsed" };
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base < 0) return { raw, value: null, status: "unparsed" };
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  return { raw, value: base * multiplier, status: "parsed" };
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 128)).filter(Boolean))].sort();
}

function projectionVersion(id: string, updatedAt: Date): number {
  return sourceVersion(id, updatedAt);
}

async function readPgEnvironment(file: string | undefined): Promise<Record<string, string>> {
  if (!file) return {};
  const parsed = parseDotenv(await readFile(file, "utf8"));
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"));
}

function requiredPgEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`拒绝执行:${name} 未注入`);
  return value;
}

function postgresConfig(
  fileEnv: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>>,
  localDocker: boolean,
): PgClientConfig {
  const env = { ...processEnv, ...fileEnv };
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) return { connectionString: databaseUrl };
  const rawPort = env.POSTGRES_PORT?.trim() || "5432";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("拒绝执行:POSTGRES_PORT 非法，值不回显");
  }
  const sslMode = localDocker ? "disable" : env.POSTGRES_SSL_MODE?.trim() || "disable";
  if (sslMode !== "disable") {
    throw new Error(
      "拒绝执行:组件式 PG 配置本轮只允许本机 dev 的 POSTGRES_SSL_MODE=disable",
    );
  }
  return {
    host: localDocker ? "127.0.0.1" : requiredPgEnv(env, "POSTGRES_HOST"),
    port,
    database: requiredPgEnv(env, "POSTGRES_DB"),
    user: requiredPgEnv(env, "POSTGRES_USER"),
    password: requiredPgEnv(env, "POSTGRES_PASSWORD"),
    ssl: false,
  };
}

function quoteSchema(schema: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(schema)) throw new Error("拒绝执行:PG schema 非法");
  return `"${schema}"`;
}

async function compileEvents(
  pg: PgClient,
  schema: string,
  limit: number,
  syncedAt: Date,
): Promise<CompiledDomain> {
  const result = await pg.query<PgEvent>(`
SELECT id, user_id, event, props, occurred_at, received_at
FROM ${schema}.events
ORDER BY received_at, id
LIMIT $1
  `, [limit]);
  const rows = result.rows.map((event) => {
    const props = safeEventProps(event.props ?? {});
    return {
      event_id: event.id,
      event_name: event.event,
      event_contract_version: 1,
      source_version: sourceVersion(event.id, event.received_at),
      user_subject_key: subjectKey(event.user_id),
      project_id: nullableString(props.project_id, 128),
      request_id: nullableString(props.request_id, 128),
      quote_id: nullableString(props.quote_id, 128),
      asset_entity_id: nullableString(props.asset_entity_id, 128),
      media_kind: nullableString(props.media_kind, 32),
      result_status: nullableString(props.result_status, 32),
      search_mode: nullableString(props.search_mode, 32),
      result_count: nullableUnsigned(props.result_count),
      safe_props_json: canonicalJson(props),
      props_redacted: 1,
      occurred_at: timestamp(event.occurred_at),
      received_at: timestamp(event.received_at),
      source_updated_at: timestamp(event.received_at),
      synced_at: timestamp(syncedAt),
      retention_until: retentionFrom(syncedAt),
    };
  });
  return makeDomain("events", [{ table: "events_product_fact", rows }], [
    {
      name: "v_events_product_latest",
      sql: `SELECT * FROM \`${DATABASE}\`.\`v_events_product_latest\` ORDER BY event_id FORMAT JSON`,
    },
    {
      name: "v_events_funnel_base",
      sql: `SELECT * FROM \`${DATABASE}\`.\`v_events_funnel_base\` ORDER BY event_id FORMAT JSON`,
    },
  ]);
}

async function compileCost(
  pg: PgClient,
  schema: string,
  limit: number,
  syncedAt: Date,
): Promise<CompiledDomain> {
  const aiResult = await pg.query<PgAiCall>(`
SELECT id, caller_user_id, project_id, purpose, provider, model, status,
       input_tokens, output_tokens, duration_ms, cost_fen, created_at, completed_at
FROM ${schema}.ai_calls
ORDER BY created_at, id
LIMIT $1
    `, [limit]);
  const quoteResult = await pg.query<PgQuoteCost>(`
SELECT q.id, q.user_id, q.pricing_rule_id, q.price_snapshot,
       q.estimated_cost_fen, q.status, q.generation_request_id,
       q.generation_attempt_id, q.created_at, q.confirmed_at, q.consumed_at,
       q.updated_at,
       l.created_at AS ledger_created_at, (-l.points_delta) AS charged_points,
       pc.project_id, pc.provider, pc.model, pc.media_kind,
       pc.cost_fen_rounded AS actual_cost_fen, pc.cost_cny_micros,
       pc.calculation_status, pc.updated_at AS provider_cost_updated_at
FROM ${schema}.generation_quotes q
LEFT JOIN ${schema}.user_credit_ledger_entries l
  ON l.entry_kind = 'generation_debit'
 AND l.source_type = 'generation_quote'
 AND l.source_id = q.id
LEFT JOIN ${schema}.provider_costs pc
  ON pc.generation_attempt_id = q.generation_attempt_id
ORDER BY q.created_at, q.id
LIMIT $1
    `, [limit]);

  const aiRows = aiResult.rows.map((call) => ({
    entry_key: `ai_calls:${call.id}`,
    entry_kind: "ai_call",
    source_table: "ai_calls",
    source_id: call.id,
    source_version: sourceVersion(call.id, latestDate([call.completed_at, call.created_at])),
    user_subject_key: subjectKey(call.caller_user_id),
    project_id: call.project_id,
    generation_request_id: null,
    generation_attempt_id: null,
    pricing_rule_id: null,
    capability_tier_key: null,
    provider: call.provider,
    model: call.model,
    purpose: call.purpose,
    media_kind: null,
    source_status: call.status,
    estimated_cost_fen: null,
    actual_cost_fen: call.cost_fen,
    cost_cny_micros: null,
    cost_calculation_status: null,
    charged_points: null,
    currency: "CNY",
    is_unpriced: call.cost_fen === null ? 1 : 0,
    input_tokens: call.input_tokens,
    output_tokens: call.output_tokens,
    duration_ms: call.duration_ms,
    occurred_at: timestamp(call.created_at),
    completed_at: call.completed_at ? timestamp(call.completed_at) : null,
    source_updated_at: timestamp(latestDate([call.completed_at, call.created_at])),
    synced_at: timestamp(syncedAt),
    retention_until: retentionFrom(syncedAt),
  }));

  const quoteRows = quoteResult.rows.map((quote) => {
    const price = quote.price_snapshot ?? {};
    const changedAt = latestDate([
      quote.updated_at,
      quote.ledger_created_at,
      quote.provider_cost_updated_at,
    ]);
    const provider = quote.provider ?? nullableString(price.provider, 64) ?? "unknown";
    const model = quote.model ?? nullableString(price.model, 128) ?? "unknown";
    const occurredAt = quote.consumed_at ?? quote.confirmed_at ?? quote.created_at;
    return {
      entry_key: `generation_quotes:${quote.id}`,
      entry_kind: "generation_quote",
      source_table: "generation_quotes",
      source_id: quote.id,
      source_version: sourceVersion(quote.id, changedAt),
      user_subject_key: subjectKey(quote.user_id),
      project_id: quote.project_id,
      generation_request_id: quote.generation_request_id,
      generation_attempt_id: quote.generation_attempt_id,
      pricing_rule_id: quote.pricing_rule_id,
      capability_tier_key: nullableString(
        price.capability_tier_key ?? price.capabilityTierKey,
        128,
      ),
      provider,
      model,
      purpose: "generation",
      media_kind: quote.media_kind ?? nullableString(price.media_kind ?? price.mediaKind, 32),
      source_status: quote.status,
      estimated_cost_fen: quote.estimated_cost_fen,
      actual_cost_fen: quote.actual_cost_fen,
      cost_cny_micros: quote.cost_cny_micros === null
        ? null
        : Number(quote.cost_cny_micros),
      cost_calculation_status: quote.calculation_status,
      charged_points: quote.charged_points,
      currency: "CNY",
      is_unpriced: quote.actual_cost_fen === null ? 1 : 0,
      input_tokens: null,
      output_tokens: null,
      duration_ms: null,
      occurred_at: timestamp(occurredAt),
      completed_at: quote.consumed_at ? timestamp(quote.consumed_at) : null,
      source_updated_at: timestamp(changedAt),
      synced_at: timestamp(syncedAt),
      retention_until: retentionFrom(syncedAt),
    };
  });

  return makeDomain("cost", [{
    table: "cost_ledger_fact",
    rows: [...aiRows, ...quoteRows],
  }], [
    {
      name: "v_cost_ledger_latest",
      sql: `SELECT * FROM \`${DATABASE}\`.\`v_cost_ledger_latest\` ORDER BY entry_key FORMAT JSON`,
    },
    {
      name: "v_cost_daily",
      sql: `SELECT * FROM \`${DATABASE}\`.\`v_cost_daily\` ORDER BY cost_date, provider, model, currency FORMAT JSON`,
    },
  ]);
}

async function compileRadar(
  pg: PgClient,
  schema: string,
  limit: number,
  syncedAt: Date,
): Promise<CompiledDomain> {
  const runResult = await pg.query<PgRadarRun>(`
SELECT c.id, c.source, c.resource_scope, c.cache_date, c.request_kind, c.status,
       c.requested_by_user_id, c.snapshot_id, c.started_at, c.completed_at,
       c.error_code, s.rank_date, s.fetched_at, s.item_count, s.raw_payload
FROM ${schema}.topic_radar_upstream_calls c
LEFT JOIN ${schema}.topic_radar_snapshots s ON s.id = c.snapshot_id
ORDER BY c.started_at, c.id
LIMIT $1
    `, [limit]);
  const itemResult = await pg.query<PgRadarItem>(`
SELECT i.id, i.snapshot_id, s.source, s.resource_scope, s.cache_date,
       s.rank_date, s.fetched_at, i.ordinal, i.rank, i.title, i.heat, i.link
FROM ${schema}.topic_radar_items i
JOIN ${schema}.topic_radar_snapshots s ON s.id = i.snapshot_id
ORDER BY s.fetched_at, i.ordinal, i.id
LIMIT $1
    `, [limit]);

  const runs = runResult.rows.map((run) => {
    const endedAt = latestDate([run.completed_at, run.started_at]);
    return {
      run_id: run.id,
      source: run.source,
      resource_scope: run.resource_scope,
      cache_date: dateOnly(run.cache_date),
      request_kind: run.request_kind,
      source_status: run.status,
      requested_by_subject_key: subjectKey(run.requested_by_user_id),
      snapshot_id: run.snapshot_id,
      rank_date: run.rank_date === null ? null : dateOnly(run.rank_date),
      started_at: timestamp(run.started_at),
      completed_at: run.completed_at ? timestamp(run.completed_at) : null,
      fetched_at: run.fetched_at ? timestamp(run.fetched_at) : null,
      duration_ms: run.completed_at
        ? Math.max(0, run.completed_at.getTime() - run.started_at.getTime())
        : null,
      item_count: run.item_count,
      error_code: nullableString(run.error_code, 128),
      source_contract_version: 1,
      source_version: sourceVersion(run.id, endedAt),
      raw_payload_sha256: run.raw_payload === null
        ? null
        : sha256(canonicalJson(run.raw_payload)),
      source_updated_at: timestamp(endedAt),
      synced_at: timestamp(syncedAt),
      retention_until: retentionFrom(syncedAt),
    };
  });
  const items = itemResult.rows.map((item) => {
    const heat = parseHeat(item.heat);
    const normalizedSource = {
      snapshot_id: item.snapshot_id,
      ordinal: item.ordinal,
      rank: item.rank,
      title: item.title,
      heat: heat.raw,
      link: safePublicUrl(item.link),
    };
    return {
      item_id: item.id,
      snapshot_id: item.snapshot_id,
      source: item.source,
      resource_scope: item.resource_scope,
      cache_date: dateOnly(item.cache_date),
      rank_date: dateOnly(item.rank_date),
      fetched_at: timestamp(item.fetched_at),
      ordinal: item.ordinal,
      rank_value: item.rank,
      title: item.title.slice(0, 512),
      heat_raw: heat.raw,
      heat_value: heat.value,
      heat_parse_status: heat.status,
      link_url: safePublicUrl(item.link),
      source_item_sha256: sha256(canonicalJson(normalizedSource)),
      source_version: sourceVersion(item.id, item.fetched_at),
      synced_at: timestamp(syncedAt),
      retention_until: retentionFrom(syncedAt),
    };
  });

  return makeDomain("radar", [
    { table: "radar_fetch_runs", rows: runs },
    { table: "radar_rank_items", rows: items },
  ], [
    {
      name: "v_radar_fetch_runs_latest",
      sql: `SELECT * FROM \`${DATABASE}\`.\`v_radar_fetch_runs_latest\` ORDER BY run_id FORMAT JSON`,
    },
    {
      name: "v_radar_rank_items_latest",
      sql: `SELECT * FROM \`${DATABASE}\`.\`v_radar_rank_items_latest\` ORDER BY item_id FORMAT JSON`,
    },
  ]);
}

function documentRow(
  source: PgAssetEntity | PgAssetVariant,
  syncedAt: Date,
): JsonRecord {
  const isVariant = "asset_entity_id" in source;
  const entityId = isVariant ? source.asset_entity_id : source.id;
  const sourceId = source.id;
  const changedAt = isVariant
    ? latestDate([source.updated_at, source.entity_updated_at])
    : source.updated_at;
  const name = isVariant ? source.entity_name : source.name;
  const displayName = isVariant ? source.entity_display_name : source.display_name;
  const variantLabel = isVariant ? source.variant_name : null;
  const safeSearchParts = isVariant
    ? [source.entity_name, source.entity_display_name, source.variant_name,
      source.description, source.usage_context, source.search_text]
    : [source.name, source.display_name, source.intro, source.search_text];
  const searchText = safeSearchParts.filter((value): value is string =>
    typeof value === "string" && Boolean(value.trim())).join("\n").slice(0, 16_000);
  const summary = (isVariant ? source.description : source.intro) ?? "";
  const styleTags = isVariant ? [] : safeStringArray(source.style_tags);
  const semanticFacets = { style_tags: styleTags };
  const sourceMaterial = {
    source_object_type: isVariant ? "asset_variant" : "asset_entity",
    source_object_id: sourceId,
    asset_entity_id: entityId,
    asset_kind: source.asset_kind,
    role: source.role,
    usage_mode: source.usage_mode,
    name,
    display_name: displayName,
    variant_kind: isVariant ? source.variant_kind : null,
    variant_label: variantLabel,
    summary,
    search_text: searchText,
    tags: source.canonical_tag_ids,
    authorized_projects: source.authorized_project_ids,
    status: source.status,
    visibility: source.visibility,
    clearance_search: source.clearance.search === true,
    updated_at: changedAt.toISOString(),
    deleted_at: source.deleted_at?.toISOString() ?? null,
  };
  return {
    document_id: `${isVariant ? "variant" : "entity"}:${sourceId}`,
    source_object_type: isVariant ? "asset_variant" : "asset_entity",
    source_object_id: sourceId,
    asset_entity_id: entityId,
    asset_variant_id: isVariant ? sourceId : null,
    source_asset_project_id: source.source_project_id,
    authorized_project_ids: source.authorized_project_ids,
    asset_kind: source.asset_kind,
    asset_role: source.role,
    usage_mode: source.usage_mode,
    name,
    display_name: displayName,
    variant_kind: isVariant ? source.variant_kind : null,
    variant_label: variantLabel,
    stage_label: isVariant ? nullableString(source.usage_context, 255) : null,
    summary: summary.slice(0, 4_096),
    search_text: searchText,
    semantic_facets_json: canonicalJson(semanticFacets),
    canonical_tag_ids: source.canonical_tag_ids,
    tag_labels: source.tag_labels,
    quality_notes: null,
    confidence: null,
    needs_human_review: 0,
    source_status: source.status,
    visibility: source.visibility,
    search_clearance: source.clearance.search === true ? 1 : 0,
    source_locator_json: canonicalJson({
      source_schema: DEFAULT_SCHEMA,
      source_table: isVariant ? "asset_variants" : "asset_entities",
      source_id: sourceId,
    }),
    source_checksum: sha256(canonicalJson(sourceMaterial)),
    projection_version: projectionVersion(sourceId, changedAt),
    source_updated_at: timestamp(changedAt),
    source_deleted_at: source.deleted_at ? timestamp(source.deleted_at) : null,
    synced_at: timestamp(syncedAt),
    retention_until: retentionFrom(syncedAt),
  };
}

async function compileAssetVec(
  pg: PgClient,
  schema: string,
  limit: number,
  syncedAt: Date,
): Promise<CompiledDomain> {
  const aggregation = `
LEFT JOIN LATERAL (
  SELECT coalesce(array_agg(DISTINCT r.project_id::text ORDER BY r.project_id::text), '{}') AS ids
  FROM ${schema}.project_asset_refs r
  WHERE r.asset_entity_id = e.id AND r.deleted_at IS NULL
) projects ON true
LEFT JOIN LATERAL (
  SELECT coalesce(array_agg(DISTINCT t.tag_id ORDER BY t.tag_id), '{}') AS ids,
         coalesce(array_agg(DISTINCT v.display_name ORDER BY v.display_name), '{}') AS labels
  FROM ${schema}.asset_tags t
  JOIN ${schema}.tag_vocabulary v ON v.id = t.tag_id
  WHERE t.asset_entity_id = e.id
) tags ON true`;
  const entityResult = await pg.query<PgAssetEntity>(`
SELECT e.id, e.source_project_id, e.asset_kind, e.role, e.usage_mode,
       e.name, e.display_name, e.intro, e.search_text, e.style_tags,
       e.status, e.visibility, e.clearance, e.updated_at, e.deleted_at,
       projects.ids AS authorized_project_ids,
       tags.ids AS canonical_tag_ids, tags.labels AS tag_labels
FROM ${schema}.asset_entities e
${aggregation}
ORDER BY e.updated_at, e.id
LIMIT $1
    `, [limit]);
  const variantResult = await pg.query<PgAssetVariant>(`
SELECT v.id, v.asset_entity_id, e.source_project_id, e.asset_kind, e.role,
       e.usage_mode, e.name AS entity_name, e.display_name AS entity_display_name,
       v.variant_kind, v.name AS variant_name, v.description, v.usage_context,
       v.search_text, v.status, e.visibility, e.clearance,
       v.updated_at, e.updated_at AS entity_updated_at, v.deleted_at,
       projects.ids AS authorized_project_ids,
       tags.ids AS canonical_tag_ids, tags.labels AS tag_labels
FROM ${schema}.asset_variants v
JOIN ${schema}.asset_entities e ON e.id = v.asset_entity_id
${aggregation}
ORDER BY coalesce(v.updated_at, e.updated_at), v.id
LIMIT $1
    `, [limit]);
  const documents = [
    ...entityResult.rows.map((row) => documentRow(row, syncedAt)),
    ...variantResult.rows.map((row) => documentRow(row, syncedAt)),
  ];
  return makeDomain("asset_vec", [
    { table: "asset_vec_documents", rows: documents },
    // No persistent OLTP vector ledger exists. Fabricating or recomputing vectors
    // is outside this syncer's source-backed contract, so this table stays empty.
    { table: "asset_vec_embeddings", rows: [] },
  ], [
    {
      name: "v_asset_vec_documents_latest",
      sql: `SELECT * FROM \`${DATABASE}\`.\`v_asset_vec_documents_latest\` ORDER BY document_id FORMAT JSON`,
    },
    {
      name: "v_asset_vec_embeddings_latest",
      sql: `SELECT * FROM \`${DATABASE}\`.\`v_asset_vec_embeddings_latest\` ORDER BY embedding_id FORMAT JSON`,
    },
  ]);
}

function makeDomain(
  domain: Domain,
  tables: CompiledDomain["tables"],
  viewQueries: CompiledDomain["viewQueries"],
): CompiledDomain {
  const allRows = tables.flatMap(({ table, rows }) =>
    rows.map((row) => ({ table, row })));
  const material = canonicalJson(allRows);
  const versions = allRows.map(({ row }) =>
    Number(row.source_version ?? row.projection_version ?? 0));
  const version = Math.max(0, ...versions);
  return {
    domain,
    tables,
    viewQueries,
    sourceVersion: version,
    batchId: `${domain}:${sha256(material).slice(0, 24)}`,
    cursor: canonicalJson({
      version,
      content_sha256: sha256(material),
      source_rows: allRows.length,
    }),
    rowCount: allRows.length,
  };
}

function insertJsonEachRow(table: string, rows: readonly JsonRecord[]): string | null {
  if (rows.length === 0) return null;
  if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw new Error("拒绝执行:ByteHouse table 非法");
  return `INSERT INTO \`${DATABASE}\`.\`${table}\` FORMAT JSONEachRow\n`
    + rows.map((row) => JSON.stringify(row)).join("\n");
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonRecord)
    .filter(([key]) => key !== "synced_at" && key !== "retention_until")
    .map(([key, item]) => [key, stripVolatile(item)]));
}

async function viewDigest(
  client: ByteHouseHttpClient,
  domain: CompiledDomain,
): Promise<string> {
  const views: JsonRecord = {};
  for (const view of domain.viewQueries) {
    views[view.name] = stripVolatile(await client.queryJson<JsonRecord>(view.sql));
  }
  return sha256(canonicalJson(views));
}

async function writeDomain(
  client: ByteHouseHttpClient,
  domain: CompiledDomain,
  syncedAt: Date,
): Promise<{ readonly firstDigest: string; readonly secondDigest: string }> {
  for (const replay of [1, 2]) {
    for (const table of domain.tables) {
      const statement = insertJsonEachRow(table.table, table.rows);
      if (statement) await client.query(statement);
    }
    const watermark = {
      domain: domain.domain,
      batch_id: domain.batchId,
      source_cursor: domain.cursor,
      source_version: domain.sourceVersion,
      row_count: domain.rowCount,
      synced_at: timestamp(syncedAt),
      retention_until: retentionFrom(syncedAt),
    };
    await client.query(insertJsonEachRow("sync_watermarks", [watermark])!);
    const digest = await viewDigest(client, domain);
    if (replay === 1) {
      (domain as CompiledDomain & { firstDigest?: string }).firstDigest = digest;
    } else {
      const firstDigest = (domain as CompiledDomain & { firstDigest?: string }).firstDigest;
      if (!firstDigest || firstDigest !== digest) {
        throw new Error(`ByteHouse ${domain.domain} 重放后消费视图内容漂移`);
      }
      return { firstDigest, secondDigest: digest };
    }
  }
  throw new Error("同步重放次数异常");
}

function parseInput(args: readonly string[]): Input {
  let apply = false;
  let sourcePreflight = false;
  let environment: string | undefined;
  let confirm: string | undefined;
  let pgEnvFile: string | undefined;
  let pgLocalDocker = false;
  let schema = DEFAULT_SCHEMA;
  let limit = DEFAULT_LIMIT;
  let domains: readonly Domain[] = DOMAINS;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (!next || next.startsWith("--")) throw new Error(`${arg} 需要一个值`);
      return next;
    };
    if (arg === "--apply") apply = true;
    else if (arg === "--source-preflight") sourcePreflight = true;
    else if (arg === "--environment") environment = value();
    else if (arg === "--confirm") confirm = value();
    else if (arg === "--pg-env-file") pgEnvFile = value();
    else if (arg === "--pg-local-docker") pgLocalDocker = true;
    else if (arg === "--schema") schema = value();
    else if (arg === "--limit") limit = Number(value());
    else if (arg === "--domains") {
      const selected = value().split(",").map((item) => item.trim()).filter(Boolean);
      if (
        selected.length === 0
        || selected.some((domain) => !DOMAINS.includes(domain as Domain))
        || new Set(selected).size !== selected.length
      ) {
        throw new Error(`--domains 只能是不重复的 ${DOMAINS.join(",")} 子集`);
      }
      domains = selected as Domain[];
    }
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`未知参数:${arg}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) {
    throw new Error("--limit 必须是 1..50000 的整数");
  }
  if (apply && sourcePreflight) throw new Error("--apply 与 --source-preflight 互斥");
  return {
    apply,
    sourcePreflight,
    environment,
    confirm,
    pgEnvFile,
    pgLocalDocker,
    schema,
    limit,
    domains,
    help,
  };
}

function printHelp(): void {
  process.stdout.write([
    "S55 PostgreSQL -> ByteHouse dev-only batch sync",
    "",
    "  npx tsx scripts/bytehouse-sync.mts --apply --environment dev \\",
    `    --confirm ${CONFIRMATION} --pg-env-file <path>`,
    `    [--domains ${DOMAINS.join(",")}]`,
    "",
    "  npx tsx scripts/bytehouse-sync.mts --source-preflight --environment dev \\",
    "    --pg-env-file <path> [--pg-local-docker] [--domains events,cost,radar,asset_vec]",
    "",
    "每域同批写入两次并比较 latest-row 消费视图摘要；不调用任何生成供应商。",
  ].join("\n") + "\n");
}

async function main(): Promise<void> {
  const input = parseInput(process.argv.slice(2));
  if (input.help) return printHelp();
  if (
    input.environment !== "dev"
    || (
      !input.sourcePreflight
      && (!input.apply || input.confirm !== CONFIRMATION)
    )
  ) {
    throw new Error(
      `拒绝执行:必须显式 --source-preflight --environment dev，或 `
        + `--apply --environment dev --confirm ${CONFIRMATION}`,
    );
  }
  const schema = quoteSchema(input.schema);
  const pgFileEnv = await readPgEnvironment(input.pgEnvFile);
  const pg = new PgClient(postgresConfig(pgFileEnv, process.env, input.pgLocalDocker));
  const syncedAt = new Date();
  try {
    await pg.connect();
    const compilers: Readonly<Record<Domain, () => Promise<CompiledDomain>>> = {
      events: () => compileEvents(pg, schema, input.limit, syncedAt),
      cost: () => compileCost(pg, schema, input.limit, syncedAt),
      radar: () => compileRadar(pg, schema, input.limit, syncedAt),
      asset_vec: () => compileAssetVec(pg, schema, input.limit, syncedAt),
    };
    const domains: CompiledDomain[] = [];
    for (const domain of input.domains) {
      domains.push(await compilers[domain]());
    }
    if (input.sourcePreflight) {
      process.stdout.write(`${JSON.stringify({
        environment: "dev",
        mode: "source-preflight",
        selected_domains: input.domains,
        domains: domains.map((domain) => ({
          domain: domain.domain,
          source_rows: domain.rowCount,
          tables: domain.tables.map((table) => ({
            table: table.table,
            source_rows: table.rows.length,
          })),
        })),
        empty_domains: domains.filter((domain) => domain.rowCount === 0)
          .map((domain) => domain.domain),
        paid_provider_calls: 0,
        bytehouse_writes: 0,
        contains_source_content: false,
      }, null, 2)}\n`);
      return;
    }
    for (const domain of domains) {
      if (domain.rowCount === 0) {
        throw new Error(`PostgreSQL ${domain.domain} 域没有可同步的真实源行`);
      }
    }
    const byteHouseCredentials = loadByteHouseCredentials(process.env);
    const byteHouse = new ByteHouseHttpClient(byteHouseCredentials.app);
    const results: JsonRecord[] = [];
    for (const domain of domains) {
      const replay = await writeDomain(byteHouse, domain, syncedAt);
      results.push({
        domain: domain.domain,
        source_rows: domain.rowCount,
        replay_count: 2,
        view_digest_stable: replay.firstDigest === replay.secondDigest,
      });
    }
    process.stdout.write(`${JSON.stringify({
      environment: "dev",
      database: DATABASE,
      status: "OK",
      paid_provider_calls: 0,
      selected_domains: input.domains,
      omitted_domains: DOMAINS.filter((domain) => !input.domains.includes(domain)),
      domains: results,
      embedding_rows: 0,
      embedding_blocker:
        "no_persistent_pg_vector_ledger_do_not_fabricate_or_recompute",
      contains_credentials: false,
      contains_source_content: false,
    }, null, 2)}\n`);
  } finally {
    await pg.end().catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "bytehouse sync failed");
    process.exitCode = 1;
  });
}
