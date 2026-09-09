import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { resourceScope } from "./types.js";
import type {
  FetchClaim,
  TopicRadarItem,
  TopicRadarSnapshot,
  TopicRadarSource,
  TopicRadarStore, TopicRadarResource,
  TopicRadarUpstreamCall,
} from "./types.js";

type SqlResult<T> = { rows: T[] };

interface CallRow {
  id: string;
  source: string;
  resource_scope: string;
  cache_date: string | Date;
  request_kind: string;
  status: string;
  snapshot_id: string | null;
  started_at: Date | string;
}

interface SnapshotRow {
  id: string;
  source: string;
  resource_scope: string;
  cache_date: string | Date;
  rank_date: string | Date;
  fetched_at: Date | string;
  raw_payload: unknown;
}

interface ItemRow {
  rank: number | string | null;
  title: string;
  heat: string | null;
  link: string | null;
}

const snapshots = qualifiedTable("topic_radar_snapshots");
const items = qualifiedTable("topic_radar_items");
const calls = qualifiedTable("topic_radar_upstream_calls");

/**
 * The topic radar call ledger is the quota boundary. The advisory lock and
 * unique daily/manual rows are deliberately both present: a retryable HTTP
 * transaction cannot turn an ordinary page refresh into another paid call.
 */
export class TopicRadarRepository implements TopicRadarStore {
  constructor(private readonly db: Database) {}

  async claimFetch(input: { source: TopicRadarSource; resource: TopicRadarResource; cacheDate: string; actorId: string; now: Date; requestKind: "daily" | "manual" }): Promise<FetchClaim> {
    return this.claim(input, input.requestKind);
  }

  async completeCallSuccess(input: {
    call: TopicRadarUpstreamCall;
    rankDate: string;
    fetchedAt: Date;
    rawPayload: unknown;
    items: Array<TopicRadarItem & { rawItem: unknown }>;
  }): Promise<TopicRadarSnapshot> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await db.execute(sql`SELECT id FROM ${calls} WHERE id = ${input.call.id} FOR UPDATE`);
      const current = await findCall(db, input.call.id);
      if (!current || current.status !== "fetching") {
        throw new Error("选题雷达上游调用不存在或已结束");
      }

      const snapshotId = randomUUID();
      await db.execute(sql`
        INSERT INTO ${snapshots}
          (id, source, resource_scope, cache_date, rank_date, fetched_at, raw_payload, item_count)
        VALUES (
          ${snapshotId}, ${input.call.source}, ${input.call.resourceScope}, ${input.call.cacheDate}, ${input.rankDate},
          ${input.fetchedAt}, ${jsonText(input.rawPayload)}::jsonb, ${input.items.length}
        )
      `);
      for (const [ordinal, item] of input.items.entries()) {
        await db.execute(sql`
          INSERT INTO ${items} (id, snapshot_id, ordinal, rank, title, heat, link, raw_item)
          VALUES (
            ${randomUUID()}, ${snapshotId}, ${ordinal}, ${item.rank}, ${item.title},
            ${item.heat}, ${item.link}, ${jsonText(item.rawItem)}::jsonb
          )
        `);
      }
      const completed = await db.execute(sql`
        UPDATE ${calls}
        SET status = 'succeeded', snapshot_id = ${snapshotId}, completed_at = ${input.fetchedAt},
            error_code = NULL, error_message = NULL
        WHERE id = ${input.call.id} AND status = 'fetching'
        RETURNING id
      `) as unknown as SqlResult<{ id: string }>;
      if (!completed.rows[0]) throw new Error("选题雷达调用状态更新失败");

      const snapshot = await this.getSnapshotFrom(db, snapshotId);
      if (!snapshot) throw new Error("选题雷达快照写入后未能读取");
      return snapshot;
    });
  }

  async completeCallFailure(input: {
    call: TopicRadarUpstreamCall;
    completedAt: Date;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE ${calls}
      SET status = 'failed', completed_at = ${input.completedAt},
          error_code = ${input.errorCode.slice(0, 128)}, error_message = ${input.errorMessage.slice(0, 512)}
      WHERE id = ${input.call.id} AND status = 'fetching'
    `);
  }

  async getSnapshot(id: string): Promise<TopicRadarSnapshot | null> {
    return this.getSnapshotFrom(this.db, id);
  }

  async getLatestSnapshot(source: TopicRadarSource, resource: TopicRadarResource): Promise<TopicRadarSnapshot | null> {
    const row = (await query<SnapshotRow>(this.db, sql`
      SELECT id, source, resource_scope, cache_date, rank_date, fetched_at
      FROM ${snapshots}
      WHERE source = ${source} AND resource_scope = ${resourceScope(resource)}
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1
    `))[0];
    return row ? this.getSnapshotFrom(this.db, row.id) : null;
  }

  private async claim(
    input: { source: TopicRadarSource; resource: TopicRadarResource; cacheDate: string; actorId: string; now: Date },
    requestKind: "daily" | "manual",
  ): Promise<FetchClaim> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      // Separate manual and ordinary locks make their explicit daily budgets
      // independent while each remains exactly-once for the China day.
      const scope = resourceScope(input.resource);
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`topic-radar:${requestKind}:${input.source}:${scope}:${input.cacheDate}`}))`);
      const existing = (await query<CallRow>(db, sql`
        SELECT id, source, resource_scope, cache_date, request_kind, status, snapshot_id, started_at
        FROM ${calls}
        WHERE source = ${input.source} AND resource_scope = ${scope} AND cache_date = ${input.cacheDate}
          AND request_kind = ${requestKind}
        LIMIT 1
      `))[0];
      if (existing) return { kind: "existing", call: toCall(existing) };

      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO ${calls}
          (id, source, resource_scope, cache_date, request_kind, status, requested_by_user_id, started_at)
        VALUES (
          ${id}, ${input.source}, ${scope}, ${input.cacheDate}, ${requestKind}, 'fetching',
          ${input.actorId}, ${input.now}
        )
      `);
      const claimed = await findCall(db, id);
      if (!claimed) throw new Error("选题雷达调用登记后未能读取");
      return { kind: "claimed", call: claimed };
    });
  }

  private async getSnapshotFrom(db: Database, id: string): Promise<TopicRadarSnapshot | null> {
    const row = (await query<SnapshotRow>(db, sql`
      SELECT id, source, resource_scope, cache_date, rank_date, fetched_at, raw_payload
      FROM ${snapshots}
      WHERE id = ${id}
      LIMIT 1
    `))[0];
    if (!row) return null;
    const snapshotItems = await query<ItemRow>(db, sql`
      SELECT rank, title, heat, link
      FROM ${items}
      WHERE snapshot_id = ${id}
      ORDER BY ordinal ASC
    `);
    return {
      id: row.id,
      source: sourceValue(row.source),
      resourceScope: row.resource_scope,
      cacheDate: dateText(row.cache_date),
      rankDate: dateText(row.rank_date),
      fetchedAt: timestamp(row.fetched_at),
      items: snapshotItems.map((item) => ({
        rank: numberOrNull(item.rank),
        title: item.title,
        heat: item.heat,
        link: item.link,
      })),
      rawPayload: (row as SnapshotRow & { raw_payload: unknown }).raw_payload,
    };
  }
}

async function findCall(db: Database, id: string): Promise<TopicRadarUpstreamCall | null> {
  const row = (await query<CallRow>(db, sql`
    SELECT id, source, resource_scope, cache_date, request_kind, status, snapshot_id, started_at
    FROM ${calls}
    WHERE id = ${id}
    LIMIT 1
  `))[0];
  return row ? toCall(row) : null;
}

function toCall(row: CallRow): TopicRadarUpstreamCall {
  if (row.request_kind !== "daily" && row.request_kind !== "manual") {
    throw new Error("选题雷达调用类型无效");
  }
  if (row.status !== "fetching" && row.status !== "succeeded" && row.status !== "failed") {
    throw new Error("选题雷达调用状态无效");
  }
  return {
    id: row.id,
    source: sourceValue(row.source),
    resourceScope: row.resource_scope,
    cacheDate: dateText(row.cache_date),
    requestKind: row.request_kind,
    status: row.status,
    snapshotId: row.snapshot_id,
    startedAt: timestamp(row.started_at),
  };
}

function sourceValue(value: string): TopicRadarSource {
  if (value !== "52api_hongguo_ranking") throw new Error("选题雷达来源无效");
  return value;
}

function dateText(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function timestamp(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonText(value: unknown): string {
  // Provider output is audit-only but must remain valid JSON even if an
  // adapter chose to omit an optional raw field.
  return JSON.stringify(value ?? null);
}

async function query<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(statement) as unknown as SqlResult<T>).rows;
}

function qualifiedTable(name: string) {
  return sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier(name)}`;
}
