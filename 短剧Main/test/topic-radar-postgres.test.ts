import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { settings } from "../src/config/env.js";
import type { Database } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import { TOPIC_RADAR_SOURCE, type TopicRadarUpstreamCall } from "../src/modules/topic-radar/types.js";

// This is deliberately opt-in.  It must point to a disposable local database;
// the test creates pg_trgm only there because migration 017 correctly treats it
// as a DBA-managed, database-wide prerequisite.
const integrationTestDatabaseUrl = process.env.TOPIC_RADAR_TEST_DATABASE_URL;

test("040 在本机 PostgreSQL 中按 resource scope 隔离选题雷达日额度", {
  skip: !integrationTestDatabaseUrl,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabaseUrl(integrationTestDatabaseUrl);

  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = `topic_radar_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const actorId = randomUUID();
  const cacheDate = "2026-07-24";
  const originalSchema = settings.postgresSchema;

  try {
    // The test database is explicitly local-only.  Migration 017 must still
    // see its genuine DBA prerequisite rather than being weakened in SQL.
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pool.query(`CREATE SCHEMA ${schema}`);
    await applyMigrations(pool, schemaName, await migrationFilesThrough040());
    await pool.query(`
      INSERT INTO ${schema}.users (id, username, display_name, password_hash, active, role)
      VALUES ($1, 'topic-radar-owner', 'Topic Radar Test Owner', 'test-only', true, 'member')
    `, [actorId]);

    // TopicRadarRepository deliberately schema-qualifies SQL using the
    // deployment setting.  Point only this isolated test process at the
    // disposable schema before loading the repository module.
    setPostgresSchemaForTest(schemaName);
    const { TopicRadarRepository } = await import("../src/modules/topic-radar/repository.js");
    const database = drizzle(pool) as unknown as Database;
    const repository = new TopicRadarRepository(database);
    const now = new Date("2026-07-24T01:02:03.000Z");

    const rankings = { kind: "rankings" as const };
    const page = { kind: "ranking_page" as const, rankingId: "ranking-a", page: 1 };
    const [firstDaily, secondDaily] = await Promise.all([
      repository.claimFetch({ source: TOPIC_RADAR_SOURCE, resource: rankings, cacheDate, actorId, now, requestKind: "daily" }),
      repository.claimFetch({ source: TOPIC_RADAR_SOURCE, resource: rankings, cacheDate, actorId, now, requestKind: "daily" }),
    ]);
    assert.deepEqual([firstDaily.kind, secondDaily.kind].sort(), ["claimed", "existing"]);
    const dailyCall = claimedCall(firstDaily, secondDaily);

    const snapshot = await repository.completeCallSuccess({
      call: dailyCall,
      rankDate: cacheDate,
      fetchedAt: now,
      rawPayload: { source: "fixture", entries: 2 },
      items: [
        { rank: 1, title: "雨夜追逐", heat: "9800", link: "https://example.test/one", rawItem: { rank: 1 } },
        { rank: 2, title: "晨雾重逢", heat: null, link: null, rawItem: { rank: 2 } },
      ],
    });
    assert.equal(snapshot.items.length, 2);
    assert.deepEqual((await repository.getSnapshot(snapshot.id))?.items, snapshot.items);

    const [firstManual, secondManual] = await Promise.all([
      repository.claimFetch({ source: TOPIC_RADAR_SOURCE, resource: rankings, cacheDate, actorId, now, requestKind: "manual" }),
      repository.claimFetch({ source: TOPIC_RADAR_SOURCE, resource: rankings, cacheDate, actorId, now, requestKind: "manual" }),
    ]);
    assert.deepEqual([firstManual.kind, secondManual.kind].sort(), ["claimed", "existing"]);
    const pageClaim = await repository.claimFetch({ source: TOPIC_RADAR_SOURCE, resource: page, cacheDate, actorId, now, requestKind: "daily" });
    assert.equal(pageClaim.kind, "claimed", "a different page scope receives an independent daily claim");

    const callCounts = await pool.query<{ request_kind: string; total: string }>(`
      SELECT request_kind, count(*)::text AS total
      FROM ${schema}.topic_radar_upstream_calls
      GROUP BY request_kind
      ORDER BY request_kind
    `);
    assert.deepEqual(callCounts.rows, [
      { request_kind: "daily", total: "2" },
      { request_kind: "manual", total: "1" },
    ]);

    await assert.rejects(
      pool.query(`
        INSERT INTO ${schema}.topic_radar_upstream_calls
          (id, source, resource_scope, cache_date, request_kind, status, requested_by_user_id, started_at)
        VALUES ($1, $2, 'rankings', $3, 'daily', 'fetching', $4, $5)
      `, [randomUUID(), TOPIC_RADAR_SOURCE, cacheDate, actorId, now]),
      postgresConstraint("23505"),
      "daily partial unique index must reject a second ordinary upstream claim",
    );

    await assert.rejects(
      pool.query(`
        INSERT INTO ${schema}.topic_radar_upstream_calls
          (id, source, cache_date, request_kind, status, requested_by_user_id, started_at, completed_at)
        VALUES ($1, $2, '2026-07-25', 'daily', 'succeeded', $3, $4, $4)
      `, [randomUUID(), TOPIC_RADAR_SOURCE, actorId, now]),
      postgresConstraint("23514"),
      "succeeded calls require a persisted snapshot and must satisfy the state shape",
    );

    await assert.rejects(
      pool.query(`
        INSERT INTO ${schema}.topic_radar_upstream_calls
          (id, source, cache_date, request_kind, status, requested_by_user_id, started_at, completed_at, error_code, error_message)
        VALUES ($1, $2, '2026-07-26', 'daily', 'failed', $3, $4, $4, 'provider_failure', 'https://secret.example.test')
      `, [randomUUID(), TOPIC_RADAR_SOURCE, actorId, now]),
      postgresConstraint("23514"),
      "audit failures reject credential-bearing URL-like text",
    );
  } finally {
    setPostgresSchemaForTest(originalSchema);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

test("040 升级把 018 热榜归入 legacy_hot，不妨碍新 rankings scope", {
  skip: !integrationTestDatabaseUrl,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabaseUrl(integrationTestDatabaseUrl);
  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = `topic_radar_upgrade_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const actorId = randomUUID();
  const now = new Date("2026-07-24T01:02:03.000Z");
  const oldSnapshotId = randomUUID();
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pool.query(`CREATE SCHEMA ${schema}`);
    await applyMigrations(pool, schemaName, await migrationFilesThrough039());
    await pool.query(`INSERT INTO ${schema}.users (id, username, display_name, password_hash, active, role) VALUES ($1, 'upgrade-owner', 'Upgrade Owner', 'test-only', true, 'member')`, [actorId]);
    await pool.query(`
      INSERT INTO ${schema}.topic_radar_snapshots (id, source, cache_date, rank_date, fetched_at, raw_payload, item_count)
      VALUES ($1, $2, '2026-07-23', '2026-07-23', $3, '{}'::jsonb, 0)
    `, [oldSnapshotId, TOPIC_RADAR_SOURCE, now]);
    await pool.query(`
      INSERT INTO ${schema}.topic_radar_upstream_calls (id, source, cache_date, request_kind, status, requested_by_user_id, snapshot_id, started_at, completed_at)
      VALUES ($1, $2, '2026-07-23', 'daily', 'succeeded', $3, $4, $5, $5)
    `, [randomUUID(), TOPIC_RADAR_SOURCE, actorId, oldSnapshotId, now]);
    await applyMigrations(pool, schemaName, ["040_sgoal06_topic_radar_scopes.sql"]);
    const oldScopes = await pool.query<{ resource_scope: string }>(`SELECT resource_scope FROM ${schema}.topic_radar_snapshots WHERE id = $1`, [oldSnapshotId]);
    assert.equal(oldScopes.rows[0]?.resource_scope, "legacy_hot");

    await pool.query(`
      INSERT INTO ${schema}.topic_radar_upstream_calls
        (id, source, resource_scope, cache_date, request_kind, status, requested_by_user_id, started_at)
      VALUES ($1, $2, 'rankings', '2026-07-23', 'daily', 'fetching', $3, $4)
    `, [randomUUID(), TOPIC_RADAR_SOURCE, actorId, now]);
    const callsByScope = await pool.query<{ resource_scope: string }>(`
      SELECT resource_scope
      FROM ${schema}.topic_radar_upstream_calls
      WHERE source = $1 AND cache_date = '2026-07-23' AND request_kind = 'daily'
      ORDER BY resource_scope
    `, [TOPIC_RADAR_SOURCE]);
    assert.deepEqual(
      callsByScope.rows.map((row) => row.resource_scope),
      ["legacy_hot", "rankings"],
      "the new catalog claim must remain independent from the legacy hot-list claim",
    );
    const rankingFallback = await pool.query(`
      SELECT id
      FROM ${schema}.topic_radar_snapshots
      WHERE source = $1 AND resource_scope = 'rankings'
      LIMIT 1
    `, [TOPIC_RADAR_SOURCE]);
    assert.equal(rankingFallback.rowCount, 0, "rankings fallback cannot cross into legacy_hot");
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

function claimedCall(
  left: { kind: "claimed" | "existing"; call: TopicRadarUpstreamCall },
  right: { kind: "claimed" | "existing"; call: TopicRadarUpstreamCall },
): TopicRadarUpstreamCall {
  return left.kind === "claimed" ? left.call : right.kind === "claimed" ? right.call : (() => {
    throw new Error("expected exactly one claimed topic-radar call");
  })();
}

function postgresConstraint(code: string): (error: unknown) => boolean {
  return (error: unknown) => (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

async function migrationFilesThrough040(): Promise<string[]> {
  return (await readdir(path.resolve("migrations")))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName) && fileName <= "040_sgoal06_topic_radar_scopes.sql")
    .sort((left, right) => left.localeCompare(right));
}

async function migrationFilesThrough039(): Promise<string[]> {
  return (await readdir(path.resolve("migrations")))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName) && fileName <= "039_seed_audio_provider_cost_basis.sql")
    .sort((left, right) => left.localeCompare(right));
}

async function applyMigrations(
  executor: Pick<Pool, "query">,
  schemaName: string,
  fileNames: readonly string[],
): Promise<void> {
  for (const fileName of fileNames) {
    const source = await readFile(path.resolve("migrations", fileName), "utf8");
    await executor.query(renderMigrationSql(source, schemaName));
  }
}

function assertLocalTestDatabaseUrl(value: string): void {
  const host = new URL(value).hostname;
  assert.ok(
    host === "127.0.0.1" || host === "localhost" || host === "::1",
    "TOPIC_RADAR_TEST_DATABASE_URL 只允许指向本机一次性测试库",
  );
}

function setPostgresSchemaForTest(value: string): void {
  // `as const` protects application code at compile time.  The runtime value
  // is intentionally mutable only inside this test so repository raw SQL can
  // target the disposable schema rather than a configured environment schema.
  (settings as unknown as { postgresSchema: string }).postgresSchema = value;
}
