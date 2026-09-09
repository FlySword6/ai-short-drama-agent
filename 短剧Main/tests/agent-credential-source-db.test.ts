import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import { AuthRepository } from "../src/modules/auth/repository.js";

const databaseUrl = process.env.AGENT_CREDENTIAL_SOURCE_TEST_DATABASE_URL;
const schema = settings.postgresSchema;
const migration047 = "047_agent_credential_source_and_session_isolation.sql";

test("047 真 PG：历史会话单独回放后变 legacy 并撤销，Agent 凭据与助手审计隔离", async () => {
  assert.ok(databaseUrl, "047 runner must provide a disposable PostgreSQL URL; this test must never skip");
  assertLocalDatabase(databaseUrl);
  assert.match(schema, /^agent_credential_source_[a-z0-9_]+$/);
  const handle = createDatabase(databaseUrl);
  const quoted = quoteIdentifier(schema);

  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    await applyHistoricalMigrations(handle.pool);

    const ids = { user: randomUUID(), activeA: randomUUID(), activeB: randomUUID(), revoked: randomUUID(), legacyAgentSession: randomUUID() };
    const historicalRevokedAt = new Date("2001-01-01T00:00:00.000Z");
    const now = new Date("2026-08-03T00:00:00.000Z");
    await handle.pool.query(
      `INSERT INTO ${quoted}.users (id, username, display_name, password_hash, active, created_at, updated_at)
       VALUES ($1, 'credential-source-user', 'credential-source-user', 'test-only', true, $2, $2)`,
      [ids.user, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.sessions (id, user_id, token_hash, expires_at, revoked_at, created_at) VALUES
       ($1, $2, repeat('a', 64), $5, NULL, $4),
       ($3, $2, repeat('b', 64), $5, NULL, $4),
       ($6, $2, repeat('c', 64), $5, $7, $4)`,
      [ids.activeA, ids.user, ids.activeB, now, new Date("2027-08-03T00:00:00.000Z"), ids.revoked, historicalRevokedAt],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.agent_sessions (id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, 'historical assistant session', $3, $3)`,
      [ids.legacyAgentSession, ids.user, now],
    );

    const before = await handle.pool.query<{ legacy_active_before: number }>(
      `SELECT COUNT(*)::int AS legacy_active_before FROM ${quoted}.sessions WHERE revoked_at IS NULL`,
    );
    const legacyActiveBefore = before.rows[0]?.legacy_active_before ?? 0;
    assert.equal(legacyActiveBefore, 2, "fixture must contain two active pre-047 sessions");

    await apply047(handle.pool);

    const after = await handle.pool.query<{ legacy_active: number; revoked_by_047: number }>(
      `SELECT COUNT(*) FILTER (WHERE credential_source = 'legacy' AND revoked_at IS NULL)::int AS legacy_active,
              COUNT(*) FILTER (WHERE credential_source = 'legacy' AND revoked_at > $1)::int AS revoked_by_047
       FROM ${quoted}.sessions`,
      [historicalRevokedAt],
    );
    const result = after.rows[0]!;
    console.log(`legacy_active_before=${legacyActiveBefore}`);
    console.log(`revoked_by_047=${result.revoked_by_047}`);
    assert.equal(result.legacy_active, 0, "047 must leave no active legacy credential");
    assert.equal(result.revoked_by_047, legacyActiveBefore, "047 must revoke every active historical credential");

    const legacyAssistant = await handle.pool.query<{ agent_type: string; auth_session_id: string | null; user_agent: string | null }>(
      `SELECT agent_type, auth_session_id, user_agent FROM ${quoted}.agent_sessions WHERE id = $1`, [ids.legacyAgentSession],
    );
    assert.deepEqual(legacyAssistant.rows, [{ agent_type: "legacy_assistant", auth_session_id: null, user_agent: null }]);

    const humanSessionId = randomUUID();
    const agentSessionId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.sessions (id, user_id, token_hash, expires_at, credential_source, user_agent)
       VALUES ($1, $2, repeat('d', 64), $3, 'web', 'Mozilla/5.0')`,
      [humanSessionId, ids.user, new Date("2027-08-04T00:00:00.000Z")],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.sessions (id, user_id, token_hash, expires_at, credential_source, agent_type, credential_label, issued_by_session_id)
       VALUES ($1, $2, repeat('e', 64), $3, 'agent', 'shortdrama-agent', 'codex', $4)`,
      [agentSessionId, ids.user, new Date("2027-08-04T00:00:00.000Z"), humanSessionId],
    );
    await assert.rejects(
      handle.pool.query(`DELETE FROM ${quoted}.sessions WHERE id = $1`, [humanSessionId]),
      isForeignKeyViolation,
      "issuer-session deletion must be rejected while an Agent credential references it",
    );
    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.sessions (id, user_id, token_hash, expires_at, credential_source)
         VALUES ($1, $2, repeat('f', 64), $3, 'agent')`,
        [randomUUID(), ids.user, new Date("2027-08-04T00:00:00.000Z")],
      ),
      isCheckViolation,
      "Agent credentials require agent_type, label and issuer session",
    );
    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.sessions (id, user_id, token_hash, expires_at, credential_source, agent_type, credential_label, issued_by_session_id)
         VALUES ($1, $2, repeat('f', 64), $3, 'agent', 'Bad Agent', 'bad', $4)`,
        [randomUUID(), ids.user, new Date("2027-08-04T00:00:00.000Z"), humanSessionId],
      ),
      isCheckViolation,
      "agent_type must use the frozen machine identifier format",
    );

    const assistantSessionId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.agent_sessions (id, user_id, title, auth_session_id, agent_type, user_agent, created_at, updated_at)
       VALUES ($1, $2, 'new assistant session', $3, 'platform_assistant', 'Mozilla/5.0', $4, $4)`,
      [assistantSessionId, ids.user, humanSessionId, now],
    );
    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.agent_sessions (id, user_id, title, agent_type, created_at, updated_at)
         VALUES ($1, $2, 'bad type', 'Agent Type', $3, $3)`,
        [randomUUID(), ids.user, now],
      ),
      isCheckViolation,
      "agent_sessions audit type must be a machine identifier",
    );

    // 下面这段断言的是「只留一处人工登录时，撤销范围只覆盖 web/cli、不碰 Agent
    // 凭据」。撤销本身现在按环境开关，所以这里显式打开，不让环境默认值决定断言。
    const authRepository = new AuthRepository(handle.db, true);
    const cliSessionId = await authRepository.createHumanSession({
      userId: ids.user,
      expectedPasswordHash: "test-only",
      tokenHash: "1".repeat(64),
      source: "cli",
      userAgent: "shortdrama-cli/test",
      expiresAt: new Date("2027-08-05T00:00:00.000Z"),
    });
    assert.ok(cliSessionId);
    const afterCliLogin = await handle.pool.query<{
      id: string;
      credential_source: string;
      revoked_at: Date | null;
    }>(
      `SELECT id, credential_source, revoked_at
       FROM ${quoted}.sessions
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[humanSessionId, agentSessionId, cliSessionId]],
    );
    assert.equal(
      afterCliLogin.rows.find((row) => row.id === humanSessionId)?.revoked_at instanceof Date,
      true,
      "CLI login must revoke the previous human session",
    );
    assert.equal(
      afterCliLogin.rows.find((row) => row.id === agentSessionId)?.revoked_at,
      null,
      "human login must not revoke an Agent credential",
    );

    const repositoryAgentSessionId = await authRepository.createAgentSession({
      userId: ids.user,
      issuedBySessionId: cliSessionId,
      tokenHash: "2".repeat(64),
      agentType: "shortdrama-agent",
      label: "repository-issued",
      userAgent: "codex/test",
      expiresAt: new Date("2027-08-05T00:00:00.000Z"),
    }, now);
    assert.ok(repositoryAgentSessionId);
    const webSessionId = await authRepository.createHumanSession({
      userId: ids.user,
      expectedPasswordHash: "test-only",
      tokenHash: "3".repeat(64),
      source: "web",
      userAgent: "browser/test",
      expiresAt: new Date("2027-08-05T00:00:00.000Z"),
    });
    assert.ok(webSessionId);
    const activeSources = await handle.pool.query<{ id: string; credential_source: string }>(
      `SELECT id, credential_source
       FROM ${quoted}.sessions
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY credential_source, id`,
      [ids.user],
    );
    assert.deepEqual(
      activeSources.rows.map((row) => row.credential_source),
      ["agent", "agent", "web"],
      "web/CLI sessions must replace each other while Agent credentials remain active",
    );
    assert.equal((await authRepository.findActiveSession("2".repeat(64), now))?.credential.source, "agent");
    assert.equal((await authRepository.findActiveSession("3".repeat(64), now))?.credential.source, "web");
    assert.equal(await authRepository.findActiveSession("1".repeat(64), now), undefined);

    const concurrent = await Promise.all([
      authRepository.createHumanSession({
        userId: ids.user,
        expectedPasswordHash: "test-only",
        tokenHash: "4".repeat(64),
        source: "web",
        userAgent: "browser/concurrent-a",
        expiresAt: new Date("2027-08-05T00:00:00.000Z"),
      }),
      authRepository.createHumanSession({
        userId: ids.user,
        expectedPasswordHash: "test-only",
        tokenHash: "5".repeat(64),
        source: "cli",
        userAgent: "cli/concurrent-b",
        expiresAt: new Date("2027-08-05T00:00:00.000Z"),
      }),
    ]);
    assert.equal(concurrent.every(Boolean), true);
    const concurrentActive = await handle.pool.query<{ credential_source: string; active_count: number }>(
      `SELECT credential_source, COUNT(*)::int AS active_count
       FROM ${quoted}.sessions
       WHERE user_id = $1 AND revoked_at IS NULL
       GROUP BY credential_source
       ORDER BY credential_source`,
      [ids.user],
    );
    assert.deepEqual(
      concurrentActive.rows.filter((row) => row.credential_source === "agent"),
      [{ credential_source: "agent", active_count: 2 }],
    );
    assert.deepEqual(
      concurrentActive.rows.filter((row) => row.credential_source === "web" || row.credential_source === "cli")
        .map((row) => row.active_count),
      [1],
      "serialized concurrent human logins must leave exactly one human credential active",
    );

    const beforeReplay = await sessionState(handle.pool, quoted, ids.user);
    await apply047(handle.pool);
    assert.deepEqual(
      await sessionState(handle.pool, quoted, ids.user),
      beforeReplay,
      "047 replay must be idempotent and preserve current credential state",
    );

    const indexes = await handle.pool.query<{ indexname: string; definition: string }>(
      `SELECT indexname, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = 'sessions' ORDER BY indexname`, [schema],
    );
    assert.equal(indexes.rows.some((row) => row.indexname === "sessions_user_active_idx"), false, "broad active-session index must be removed");
    assert.match(indexes.rows.find((row) => row.indexname === "sessions_human_active_idx")?.definition ?? "", /credential_source.*'web'::character varying.*'cli'::character varying/);
    assert.match(indexes.rows.find((row) => row.indexname === "sessions_agent_active_idx")?.definition ?? "", /credential_source.*'agent'/);

    const quoteConstraint = await handle.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = $1::regclass AND conname = 'generation_quotes_source_check'`,
      [`${schema}.generation_quotes`],
    );
    assert.match(quoteConstraint.rows[0]?.definition ?? "", /'agent'::character varying/);
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

async function applyHistoricalMigrations(pool: ReturnType<typeof createDatabase>["pool"]): Promise<void> {
  const files = (await readdir(path.resolve("migrations")))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file) && file < migration047)
    .sort();
  assert.equal(files.at(-1), "046_cli_v030_prep_and_batch_authorization.sql", "fixture must replay exactly 001-046 before 047");
  for (const file of files) {
    await pool.query(renderMigrationSql(await readFile(path.resolve("migrations", file), "utf8"), schema));
  }
}

async function apply047(pool: ReturnType<typeof createDatabase>["pool"]): Promise<void> {
  await pool.query(renderMigrationSql(await readFile(path.resolve("migrations", migration047), "utf8"), schema));
}

async function sessionState(
  pool: ReturnType<typeof createDatabase>["pool"],
  quotedSchema: string,
  userId: string,
): Promise<Array<{
  id: string;
  credential_source: string;
  agent_type: string | null;
  issued_by_session_id: string | null;
  revoked: boolean;
}>> {
  const result = await pool.query<{
    id: string;
    credential_source: string;
    agent_type: string | null;
    issued_by_session_id: string | null;
    revoked: boolean;
  }>(
    `SELECT id, credential_source, agent_type, issued_by_session_id, (revoked_at IS NOT NULL) AS revoked
     FROM ${quotedSchema}.sessions
     WHERE user_id = $1
     ORDER BY id`,
    [userId],
  );
  return result.rows;
}

function assertLocalDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!['127.0.0.1', 'localhost', 'db'].includes(host)) {
    throw new Error("AGENT_CREDENTIAL_SOURCE_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL，拒绝连接云 RDS");
  }
}

function isCheckViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23514";
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503";
}
