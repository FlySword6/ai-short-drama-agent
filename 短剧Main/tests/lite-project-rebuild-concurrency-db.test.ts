import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Database } from "../src/db/client.js";
import { ConflictError } from "../src/shared/errors.js";
import type { ProjectAccessActor } from "../src/modules/project-access/types.js";

const requestedDatabaseUrl = process.env.LITE_PROJECT_CONCURRENCY_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;
const rehearsalSchema = "lite_concurrency_rehearsal";

// Integration exception: PostgreSQL lock acquisition is an external process
// state, so the test polls pg_locks instead of guessing a fixed race window.
const wait = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};

test("Lite project lock:双导入不混集、导入与落资产不写旧集、双落资产不重名", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  process.env.POSTGRES_SCHEMA = rehearsalSchema;

  const { createDatabase } = await import("../src/db/client.js");
  const { DrizzleScriptBreakdownRepository } = await import("../src/modules/script-breakdown/repository.js");
  const { quoteIdentifier, renderMigrationSql } = await import("../src/db/migrate.js");
  const { createLiteAssetService, createLiteScriptService } = await import("../src/modules/lite/routes.js");
  const { createScriptBreakdownService } = await import("../src/modules/script-breakdown/routes.js");

  const quoted = quoteIdentifier(rehearsalSchema);
  const handle = createDatabase(databaseUrl);
  const now = new Date("2026-08-22T00:00:00.000Z");
  const actorId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const actor: ProjectAccessActor = { id: actorId, role: "member" };

  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    const files = (await readdir(path.resolve("migrations")))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const file of files) {
      const source = await readFile(path.resolve("migrations", file), "utf8");
      await handle.pool.query(renderMigrationSql(source, rehearsalSchema));
    }

    await handle.pool.query(
      `INSERT INTO ${quoted}.users
         (id, username, display_name, password_hash, active, created_at, updated_at)
       VALUES ($1, $2, 'Lite Concurrency', 'test-only-hash', true, $3, $3)`,
      [actorId, `lite-concurrency-${actorId.slice(0, 8)}`, now],
    );
    for (const [id, name] of [[projectId, "Lite Concurrency"], [otherProjectId, "Other Project"]] as const) {
      await handle.pool.query(
        `INSERT INTO ${quoted}.projects
           (id, owner_user_id, name, description, status, created_at, updated_at)
         VALUES ($1, $2, $3, NULL, 'active', $4, $4)`,
        [id, actorId, name, now],
      );
    }

    const scripts = createLiteScriptService(handle.db);
    const assets = createLiteAssetService(handle.db);
    const breakdown = createScriptBreakdownService(handle.db, { traceDir: undefined });

    const [importA, importB] = await Promise.all([
      scripts.importBulkScript(
        actor,
        projectId,
        "a.txt",
        Buffer.from("第1集 A-1\nA 第一集。\n第2集 A-2\nA 第二集。"),
      ),
      scripts.importBulkScript(
        actor,
        projectId,
        "b.txt",
        Buffer.from("第1集 B-1\nB 第一集。\n第2集 B-2\nB 第二集。\n第3集 B-3\nB 第三集。"),
      ),
    ]);
    assert.ok(
      JSON.stringify([importA.replaced, importB.replaced].sort((a, b) => a - b)) === JSON.stringify([0, 2])
      || JSON.stringify([importA.replaced, importB.replaced].sort((a, b) => a - b)) === JSON.stringify([0, 3]),
      `第二个事务只应替换第一批完整集,实际=${importA.replaced},${importB.replaced}`,
    );

    const activeEpisodes = await handle.pool.query<{
      id: string;
      episode_no: number;
      script_text: string;
    }>(
      `SELECT e.id, e.episode_no, v.script_text
       FROM ${quoted}.episodes e
       JOIN ${quoted}.episode_script_versions v ON v.episode_id = e.id
       WHERE e.project_id = $1 AND e.deleted_at IS NULL
       ORDER BY e.episode_no`,
      [projectId],
    );
    const markers = new Set(activeEpisodes.rows.map((row) => row.script_text.trim()[0]));
    assert.equal(markers.size, 1, "最终剧集必须全部来自同一份导入,不得 A/B 混集");
    const finalMarker = [...markers][0];
    assert.ok(finalMarker === "A" || finalMarker === "B");
    assert.equal(activeEpisodes.rows.length, finalMarker === "A" ? 2 : 3);

    const episodeId = activeEpisodes.rows[0]!.id;
    const version = await breakdown.createScriptVersion(actor, episodeId, {
      title: "并发落资产",
      scriptText: "林雪进入旧仓库。",
      clientIdempotencyKey: `materialize-version-${randomUUID()}`,
    });
    const run = await breakdown.createRun(actor, episodeId, {
      scriptVersionId: version.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: `materialize-run-${randomUUID()}`,
    });
    await handle.db.transaction(async (transaction) => {
      const scopedRepository = new DrizzleScriptBreakdownRepository(
        transaction as unknown as Database,
      );
      await assert.rejects(
        scopedRepository.createRun({
          episodeId,
          scriptVersionId: version.version.id,
          createdByUserId: actorId,
          clientIdempotencyKey: `active-run-race-${randomUUID()}`,
          requestHash: "a".repeat(64),
          promptVersion: run.run.promptVersion,
          inputSha256: "b".repeat(64),
          targetDurationSec: null,
          now,
        }),
        (error: unknown) => error instanceof ConflictError
          && error.code === "lite_run_in_flight",
      );
      assert.ok(
        await scopedRepository.getRun(run.run.id),
        "unique violation savepoint 回滚后外层事务必须仍可查询",
      );
    });
    const candidateName = `并发角色-${randomUUID()}`;
    const draft = confirmedDraft(candidateName);
    await handle.pool.query(
      `UPDATE ${quoted}.script_breakdown_runs
       SET status = 'confirmed', draft_json = $1, confirmed_by_user_id = $2,
           confirmed_at = $3, updated_at = $3
       WHERE id = $4`,
      [JSON.stringify(draft), actorId, now, run.run.id],
    );

    const materialized = await Promise.all([
      assets.materializeAssets(actor, projectId, episodeId),
      assets.materializeAssets(actor, projectId, episodeId),
    ]);
    assert.deepEqual(
      materialized.map((result) => [result.created, result.existed]).sort(),
      [[0, 1], [1, 0]],
    );
    const entityCount = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${quoted}.asset_entities
       WHERE source_project_id = $1 AND asset_kind = 'character'
         AND name = $2 AND deleted_at IS NULL`,
      [projectId, candidateName],
    );
    const referenceCount = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${quoted}.project_asset_refs r
       JOIN ${quoted}.asset_entities e ON e.id = r.asset_entity_id
       WHERE r.project_id = $1 AND e.name = $2
         AND r.deleted_at IS NULL AND e.deleted_at IS NULL`,
      [projectId, candidateName],
    );
    assert.equal(entityCount.rows[0]?.count, "1");

    // Lock order regression:project advisory lock must be acquired before
    // confirmRun takes the Episode row lock, otherwise import and auto-confirm
    // can form advisory→row / row→advisory deadlock.
    const confirmEpisodeId = activeEpisodes.rows.at(-1)!.id;
    const confirmVersion = await breakdown.createScriptVersion(actor, confirmEpisodeId, {
      title: "确认锁序",
      scriptText: "确认锁序测试。",
      clientIdempotencyKey: `confirm-version-${randomUUID()}`,
    });
    const confirmRun = await breakdown.createRun(actor, confirmEpisodeId, {
      scriptVersionId: confirmVersion.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: `confirm-run-${randomUUID()}`,
    });
    await handle.pool.query(
      `UPDATE ${quoted}.script_breakdown_runs
       SET status = 'draft', updated_at = $1 WHERE id = $2`,
      [now, confirmRun.run.id],
    );
    const breakdownRepository = new DrizzleScriptBreakdownRepository(handle.db);
    const lockOrderClient = await handle.pool.connect();
    try {
      await lockOrderClient.query("BEGIN");
      await lockOrderClient.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`project-assets:${projectId}`],
      );
      const confirmPromise = breakdownRepository.confirmRun({
        runId: confirmRun.run.id,
        actor,
        mapping: {
          scenes: [],
          shots: [],
          assetCandidates: {
            characters: [],
            scenes: [],
            props: [],
            costumes: [],
            audios: [],
          },
          unmatchedAssets: [],
        },
        now,
      });
      await waitForAdvisoryWaiters(handle.pool, projectId, 1);
      await lockOrderClient.query(
        `UPDATE ${quoted}.episodes SET updated_at = $1 WHERE id = $2`,
        [now, confirmEpisodeId],
      );
      await lockOrderClient.query("COMMIT");
      assert.equal((await confirmPromise).outcome, "confirmed");
    } finally {
      await lockOrderClient.query("ROLLBACK").catch(() => undefined);
      lockOrderClient.release();
    }
    assert.equal(referenceCount.rows[0]?.count, "1");

    const oldCandidateName = `旧集角色-${randomUUID()}`;
    const oldVersion = await breakdown.createScriptVersion(actor, episodeId, {
      title: "旧集并发",
      scriptText: "旧集候选。",
      clientIdempotencyKey: `old-version-${randomUUID()}`,
    });
    const oldRun = await breakdown.createRun(actor, episodeId, {
      scriptVersionId: oldVersion.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: `old-run-${randomUUID()}`,
    });
    await handle.pool.query(
      `UPDATE ${quoted}.script_breakdown_runs
       SET status = 'confirmed', draft_json = $1, confirmed_by_user_id = $2,
           confirmed_at = $3, updated_at = $3
       WHERE id = $4`,
      [JSON.stringify(confirmedDraft(oldCandidateName)), actorId, now, oldRun.run.id],
    );

    const blocker = await handle.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`project-assets:${projectId}`],
      );
      const replacePromise = scripts.importBulkScript(
        actor,
        projectId,
        "replacement.txt",
        Buffer.from("第1集 新版\n新版剧集。"),
      );
      await waitForAdvisoryWaiters(handle.pool, projectId, 1);
      const oldMaterializePromise = assets.materializeAssets(actor, projectId, episodeId);
      await waitForAdvisoryWaiters(handle.pool, projectId, 2);
      await blocker.query("COMMIT");
      await replacePromise;
      await assert.rejects(oldMaterializePromise, /找不到这个集/u);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    const staleAssetCount = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${quoted}.asset_entities
       WHERE source_project_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [projectId, oldCandidateName],
    );
    assert.equal(staleAssetCount.rows[0]?.count, "0", "导入先取得项目锁后,等待中的 materialize 不得写旧集资产");

    const blocker2 = await handle.pool.connect();
    try {
      await blocker2.query("BEGIN");
      await blocker2.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`project-assets:${projectId}`],
      );
      const otherProjectImport = scripts.importBulkScript(
        actor,
        otherProjectId,
        "other.txt",
        Buffer.from("第1集 另一项目\n可以并行。"),
      );
      await nextTurn();
      assert.equal(
        await advisoryWaiterCount(handle.pool, otherProjectId),
        0,
        "另一项目不得等待当前项目的 advisory lock",
      );
      await otherProjectImport;
      await blocker2.query("COMMIT");
    } finally {
      await blocker2.query("ROLLBACK").catch(() => undefined);
      blocker2.release();
    }

    console.info(JSON.stringify({
      import_replaced_counts: [importA.replaced, importB.replaced],
      final_episode_count: activeEpisodes.rows.length,
      final_import_marker: finalMarker,
      materialize_created_existed: materialized.map((result) => [result.created, result.existed]),
      duplicate_entity_count: Number(entityCount.rows[0]?.count ?? -1),
      duplicate_reference_count: Number(referenceCount.rows[0]?.count ?? -1),
      stale_episode_asset_count: Number(staleAssetCount.rows[0]?.count ?? -1),
      other_project_parallel: true,
    }));
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

function confirmedDraft(name: string): Record<string, unknown> {
  return {
    assetCandidates: {
      characters: [{
        candidateId: `candidate-${randomUUID()}`,
        name,
        description: "并发测试角色",
        gender: "female",
        ageValue: null,
        ageStage: null,
        appearance: null,
        personalityTags: [],
        prelinkedAsset: null,
      }],
      scenes: [],
      props: [],
      costumes: [],
      audios: [],
    },
    shotCandidates: [],
  };
}

async function advisoryWaiterCount(
  pool: { query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }> },
  projectId: string,
): Promise<number> {
  const waiting = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_locks
     WHERE locktype = 'advisory'
       AND granted = false
       AND objid = hashtext($1)::oid`,
    [`project-assets:${projectId}`],
  );
  return Number(waiting.rows[0]?.count ?? 0);
}

async function waitForAdvisoryWaiters(
  pool: { query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }> },
  projectId: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await advisoryWaiterCount(pool, projectId) >= expected) return;
    await wait(20);
  }
  throw new Error(`expected ${expected} advisory lock waiters for ${projectId}`);
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("LITE_PROJECT_CONCURRENCY_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
