import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { renderMigrationSql } from "../src/db/migrate.js";
import { aiCalls, users } from "../src/db/schema.js";
import { AiDailyCallLimitError, DrizzleAiCallRepository } from "../src/modules/ai/repository.js";

/**
 * `from-settings` is only for the local Compose app container: it lets the
 * test reuse that container's already-valid PostgreSQL environment without
 * copying credentials into a command line. Any explicit URL is constrained to
 * loopback/Docker service hosts so this test can never write to cloud RDS.
 */
const requestedDatabaseUrl = process.env.AI_GATEWAY_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? settings.databaseUrl
  : requestedDatabaseUrl;

test("AI gateway: PostgreSQL 原子保留调用额度并保留无内容审计记录", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const now = new Date("2026-07-23T08:00:00.000Z");
  try {
    await applyAiCallsMigration(handle.pool);
    await handle.db.insert(users).values({
      id: actorId,
      username: `ai-gateway-${actorId.slice(0, 8)}`,
      displayName: "AI Gateway Test",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const repository = new DrizzleAiCallRepository(handle.db);
    const first = await repository.reserve(reserveInput(actorId, now, 2));
    await repository.complete({
      id: first.id,
      model: "test-llm",
      inputTokens: 12,
      outputTokens: 34,
      durationMs: 56,
      now: new Date(now.getTime() + 1_000),
    });
    const second = await repository.reserve(reserveInput(actorId, new Date(now.getTime() + 2_000), 2));
    await repository.fail({
      id: second.id,
      errorCode: "external_service_error",
      model: "test-llm-after-response",
      inputTokens: 7,
      outputTokens: 11,
      durationMs: 9,
      now: new Date(now.getTime() + 3_000),
    });
    await assert.rejects(
      repository.reserve(reserveInput(actorId, new Date(now.getTime() + 4_000), 2)),
      (error: unknown) => error instanceof AiDailyCallLimitError,
      "失败尝试也必须计入当日额度，避免重试绕过护栏",
    );

    const rows = await handle.db.select().from(aiCalls).where(eq(aiCalls.callerUserId, actorId));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => ({
      purpose: row.purpose,
      status: row.status,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      durationMs: row.durationMs,
      costFen: row.costFen,
      errorCode: row.errorCode,
    })).sort((left, right) => left.status.localeCompare(right.status)), [
      {
        purpose: "prompt_draft",
        status: "failed",
        model: "test-llm-after-response",
        inputTokens: 7,
        outputTokens: 11,
        durationMs: 9,
        costFen: null,
        errorCode: "external_service_error",
      },
      {
        purpose: "prompt_draft",
        status: "succeeded",
        model: "test-llm",
        inputTokens: 12,
        outputTokens: 34,
        durationMs: 56,
        costFen: null,
        errorCode: null,
      },
    ]);
  } finally {
    await handle.db.delete(aiCalls).where(eq(aiCalls.callerUserId, actorId)).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

test("AI gateway: 同一用户并发预留日限额为 1 时恰好一条成功、一条 429", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const now = new Date("2026-07-23T09:00:00.000Z");
  try {
    await applyAiCallsMigration(handle.pool);
    await handle.db.insert(users).values({
      id: actorId,
      username: `ai-gateway-race-${actorId.slice(0, 8)}`,
      displayName: "AI Gateway Race Test",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const repository = new DrizzleAiCallRepository(handle.db);
    const results = await Promise.allSettled([
      repository.reserve(reserveInput(actorId, now, 1)),
      repository.reserve(reserveInput(actorId, now, 1)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason instanceof AiDailyCallLimitError, true);

    const rows = await handle.db.select().from(aiCalls).where(eq(aiCalls.callerUserId, actorId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "running");
  } finally {
    await handle.db.delete(aiCalls).where(eq(aiCalls.callerUserId, actorId)).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

function reserveInput(actorId: string, now: Date, dailyLimit: number) {
  return {
    actorId,
    purpose: "prompt_draft" as const,
    provider: "ark",
    requestedModel: "test-llm",
    projectId: null,
    relatedObject: null,
    dailyLimit,
    now,
  };
}

async function applyAiCallsMigration(pool: { query(sql: string): Promise<unknown> }): Promise<void> {
  const source = await readFile(path.resolve("migrations/014_ai_calls.sql"), "utf8");
  await pool.query(renderMigrationSql(source, settings.postgresSchema));
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("AI_GATEWAY_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL，拒绝连接云 RDS");
  }
}
