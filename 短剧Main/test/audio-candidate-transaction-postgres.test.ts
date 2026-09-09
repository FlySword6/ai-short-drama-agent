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
import { PostgresGenerationRepository } from "../src/modules/generation/repository.js";

// 显式环境变量门控：只允许指向本机一次性测试库，不会触发任何模型或媒体网络调用。
const integrationTestDatabaseUrl = process.env.AUDIO_CANDIDATE_TEST_DATABASE_URL;

test("真 PG: audio candidate 插入失败会回滚 media 落库，重试可完整写入", {
  skip: !integrationTestDatabaseUrl,
  timeout: 120_000,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabaseUrl(integrationTestDatabaseUrl);

  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = settings.postgresSchema;
  assertSafeTestSchema(schemaName);
  const schema = quoteIdentifier(schemaName);
  const userId = randomUUID();
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const shotId = randomUUID();
  const requestId = randomUUID();
  const attemptId = randomUUID();
  const providerResultKey = "audio-candidate-rollback";

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await applyMigrations(pool, schemaName, await migrationFilesThroughCurrent());

    await pool.query(
      `INSERT INTO ${schema}.users (id, username, display_name, password_hash, active, role)
       VALUES ($1, 'audio-transaction-user', 'audio-transaction-user', 'test-only', true, 'member')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO ${schema}.projects (id, owner_user_id, name, status) VALUES ($1, $2, '音频事务测试', 'active')`,
      [projectId, userId],
    );
    await pool.query(
      `INSERT INTO ${schema}.episodes (id, project_id, episode_no, sort_order, status) VALUES ($1, $2, 1, 1, 'active')`,
      [episodeId, projectId],
    );
    await pool.query(
      `INSERT INTO ${schema}.shots (id, episode_id, shot_code, sort_order) VALUES ($1, $2, 'A01', 1)`,
      [shotId, episodeId],
    );
    await pool.query(
      `INSERT INTO ${schema}.generation_requests
         (id, user_id, project_id, shot_id, media_kind, prompt, reference_media_ids,
          reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash, charged_points)
       VALUES ($1, $2, $3, $4, 'audio', '测试声音', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 1, $5, $6, 0)`,
      [requestId, userId, projectId, shotId, "audio-candidate-transaction", "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO ${schema}.generation_attempts
         (id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
          provider_response, estimated_cost_fen, retryable, price_snapshot)
       VALUES ($1, $2, 1, 'ark', 'test-audio-model', '{}'::jsonb, 1, 'running', 'persisting', $3::jsonb, 0, false, '{}'::jsonb)`,
      [attemptId, requestId, JSON.stringify({
        status: "succeeded",
        media: [{
          kind: "audio",
          temporaryUrl: "https://provider.example.test/private.wav",
          providerResultKey,
          actualDurationMs: 12_000,
        }],
      })],
    );

    // 通过触发器模拟 candidate 表写入失败；不依赖网络、provider 或付费调用。
    await pool.query(`
      CREATE FUNCTION ${schema}.fail_audio_candidate_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced audio candidate failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_audio_candidate_insert
      BEFORE INSERT ON ${schema}.audio_versions
      FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_audio_candidate_insert();
    `);

    const repository = new PostgresGenerationRepository(drizzle(pool) as unknown as Database, 60_000);
    const input = {
      providerResultKey,
      mediaKind: "audio" as const,
      storageBucket: "test-bucket",
      storagePath: "audio/candidate.wav",
      storageUrl: "https://tos.example.test/audio/candidate.wav",
      sha256: "b".repeat(64),
      mimeType: "audio/wav",
      subtitle: { segments: [{ start: 0, end: 1, text: "测试" }] },
      complianceMetadata: { aigcMetadataEnabled: true, aigcMetadataEvidence: "provider_response" },
    };
    await repository.recordTosObjectUpload(attemptId, {
      providerResultKey,
      storageBucket: input.storageBucket,
      objectKey: input.storagePath,
      producedAt: new Date(),
    });
    await assert.rejects(
      () => repository.saveMediaResult(attemptId, input),
      (error: unknown) => (
        error instanceof Error
        && error.cause instanceof Error
        && /forced audio candidate failure/.test(error.cause.message)
      ),
    );
    const afterFailure = await pool.query(
      `SELECT count(*)::int AS count FROM ${schema}.media_results WHERE attempt_id = $1`,
      [attemptId],
    );
    assert.equal(afterFailure.rows[0]?.count, 0, "candidate 失败不得留下 persisted media_results 行");

    await pool.query(`DROP TRIGGER fail_audio_candidate_insert ON ${schema}.audio_versions`);
    await repository.saveMediaResult(attemptId, input);
    const afterRetry = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM ${schema}.media_results WHERE attempt_id = $1) AS media_count,
         (SELECT count(*)::int FROM ${schema}.audio_versions WHERE generation_request_id = $2) AS candidate_count`,
      [attemptId, requestId],
    );
    assert.deepEqual(afterRetry.rows[0], { media_count: 1, candidate_count: 1 });
    const tosObject = await pool.query(
      `SELECT cleanup_status FROM ${schema}.generation_tos_orphans
       WHERE attempt_id = $1 AND object_key = $2`,
      [attemptId, input.storagePath],
    );
    assert.deepEqual(tosObject.rows, [{ cleanup_status: "referenced" }]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

function assertLocalTestDatabaseUrl(value: string): void {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  assert.ok(
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1",
    "AUDIO_CANDIDATE_TEST_DATABASE_URL 只能指向本机一次性测试库",
  );
}

function assertSafeTestSchema(value: string): void {
  assert.match(
    value,
    /^s38_audio_candidate_test(?:_[a-z0-9_]+)?$/,
    "音频 candidate 真 PG 测试只允许专用 s38_audio_candidate_test schema，拒绝清理 app/common 等业务 schema",
  );
}

async function migrationFilesThroughCurrent(): Promise<string[]> {
  return (await readdir(path.resolve("migrations")))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName))
    .sort((left, right) => left.localeCompare(right));
}

async function applyMigrations(executor: Pick<Pool, "query">, schemaName: string, fileNames: readonly string[]): Promise<void> {
  for (const fileName of fileNames) {
    const source = await readFile(path.resolve("migrations", fileName), "utf8");
    await executor.query(renderMigrationSql(source, schemaName));
  }
}
