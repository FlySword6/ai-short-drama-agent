import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import {
  episodes,
  generationAttempts,
  generationRequests,
  projects,
  providerCosts,
  shots,
  users,
} from "../src/db/schema.js";
import { PostgresProviderCostRepository } from "../src/modules/generation/providerCostRepository.js";

const databaseUrl = process.env.S84_PROVIDER_COST_TEST_DATABASE_URL;
const schema = settings.postgresSchema;

test("S84 真 PG：真实 usage、公式兜底、归属聚合与幂等投影", async () => {
  assert.ok(databaseUrl, "S84 runner must provide a disposable PostgreSQL URL; this test must never skip");
  assertLocalDatabase(databaseUrl);
  assert.match(schema, /^s84_provider_cost_[a-z0-9_]+$/);
  const handle = createDatabase(databaseUrl);
  const quoted = quoteIdentifier(schema);
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    await applyMigrations(handle);
    const fixture = await seedFixture(handle);
    const repository = new PostgresProviderCostRepository(handle.db);

    const confirmed = await repository.record({
      attemptId: fixture.fastConfirmedAttempt,
      result: {
        status: "succeeded",
        actualModelId: "doubao-seedance-2-0-fast-260128",
        usage: { completion_tokens: 86_400, total_tokens: 86_400 },
        media: [],
      },
    });
    assert.deepEqual(confirmed, { status: "confirmed", requiresAttention: false });

    const estimated = await repository.record({
      attemptId: fixture.fastEstimatedAttempt,
      result: {
        status: "succeeded",
        actualModelId: "doubao-seedance-2-0-fast-260128",
        media: [],
      },
    });
    assert.deepEqual(estimated, { status: "estimated", requiresAttention: true });

    const mini = await repository.record({
      attemptId: fixture.miniAttempt,
      result: {
        status: "succeeded",
        actualModelId: "doubao-seedance-2-0-mini-260615",
        usage: { completion_tokens: 86_400 },
        media: [],
      },
    });
    assert.deepEqual(mini, { status: "confirmed", requiresAttention: false });

    const unavailable = await repository.record({
      attemptId: fixture.audioAttempt,
      result: {
        status: "succeeded",
        actualModelId: "openspeech-test-model",
        usage: { duration_ms: 1_960 },
        media: [],
      },
    });
    assert.deepEqual(unavailable, {
      status: "unavailable",
      requiresAttention: true,
      failureCode: "cost_basis_missing",
    });

    // A worker/persistence replay must keep the first observed supplier fact.
    await repository.record({
      attemptId: fixture.fastConfirmedAttempt,
      result: {
        status: "succeeded",
        actualModelId: "doubao-seedance-2-0-fast-260128",
        usage: { completion_tokens: 172_800 },
        media: [],
      },
    });

    const rows = await handle.db.select().from(providerCosts);
    assert.equal(rows.length, 4, "one immutable provider-cost row per attempt");
    const confirmedRow = rows.find((row) => row.generationAttemptId === fixture.fastConfirmedAttempt);
    assert.deepEqual({
      actor: confirmedRow?.actorUserId,
      project: confirmedRow?.projectId,
      model: confirmedRow?.actualModelId,
      status: confirmedRow?.calculationStatus,
      source: confirmedRow?.usageSource,
      usage: confirmedRow?.usageQuantity,
      exactMicros: confirmedRow?.costCnyMicros,
      roundedFen: confirmedRow?.costFenRounded,
      attention: confirmedRow?.requiresAttention,
    }, {
      actor: fixture.owner,
      project: fixture.projectA,
      model: "doubao-seedance-2-0-fast-260128",
      status: "confirmed",
      source: "provider_reported",
      usage: 86_400,
      exactMicros: 3_196_800,
      roundedFen: 320,
      attention: false,
    });

    const estimatedRow = rows.find((row) => row.generationAttemptId === fixture.fastEstimatedAttempt);
    assert.deepEqual(
      [estimatedRow?.calculationStatus, estimatedRow?.usageSource, estimatedRow?.usageQuantity, estimatedRow?.costCnyMicros],
      ["estimated", "formula_fallback", 86_400, 3_196_800],
    );
    const unavailableRow = rows.find((row) => row.generationAttemptId === fixture.audioAttempt);
    assert.deepEqual(
      [unavailableRow?.calculationStatus, unavailableRow?.costCnyMicros, unavailableRow?.failureCode],
      ["unavailable", null, "cost_basis_missing"],
    );

    const attempts = await handle.db.select({
      id: generationAttempts.id,
      actualCostFen: generationAttempts.actualCostFen,
      actualCostStatus: generationAttempts.actualCostStatus,
    }).from(generationAttempts);
    assert.deepEqual(
      attempts.map((row) => [row.id, row.actualCostFen, row.actualCostStatus]).sort(),
      [
        [fixture.audioAttempt, null, "unavailable"],
        [fixture.fastConfirmedAttempt, 320, "confirmed"],
        [fixture.fastEstimatedAttempt, 320, "estimated"],
        [fixture.miniAttempt, 199, "confirmed"],
      ].sort(),
    );

    await assertAggregates(handle, quoted, fixture);
    const charging = await handle.pool.query<{ charged_points: string; ledger_count: string }>(
      `SELECT
         COALESCE(SUM(charged_points), 0)::text AS charged_points,
         (SELECT COUNT(*)::text FROM ${quoted}.user_credit_ledger_entries) AS ledger_count
       FROM ${quoted}.generation_requests`,
    );
    assert.deepEqual(charging.rows, [{ charged_points: "0", ledger_count: "0" }], "supplier ledger must not touch points");
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

async function applyMigrations(handle: DatabaseHandle): Promise<void> {
  const files = (await readdir(path.resolve("migrations")))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  assert.ok(files.includes("038_s84_provider_cost_ledger.sql"));
  for (const file of files) {
    const source = await readFile(path.resolve("migrations", file), "utf8");
    await handle.pool.query(renderMigrationSql(source, schema));
  }
}

async function seedFixture(handle: DatabaseHandle) {
  const now = new Date("2026-07-28T00:00:00.000Z");
  const owner = randomUUID();
  const member = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  const episodeA = randomUUID();
  const episodeB = randomUUID();
  const shotA = randomUUID();
  const shotB = randomUUID();
  await handle.db.insert(users).values([
    userValue(owner, "s84-owner", now),
    userValue(member, "s84-member", now),
  ]);
  await handle.db.insert(projects).values([
    projectValue(projectA, owner, "S84 project A", now),
    projectValue(projectB, member, "S84 project B", now),
  ]);
  await handle.db.insert(episodes).values([
    episodeValue(episodeA, projectA, now),
    episodeValue(episodeB, projectB, now),
  ]);
  await handle.db.insert(shots).values([
    shotValue(shotA, episodeA, "S84-A", now),
    shotValue(shotB, episodeB, "S84-B", now),
  ]);

  const fastConfirmedAttempt = await insertAttempt(handle, {
    actorId: owner,
    projectId: projectA,
    episodeId: episodeA,
    shotId: shotA,
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video",
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
    now,
  });
  const fastEstimatedAttempt = await insertAttempt(handle, {
    actorId: owner,
    projectId: projectA,
    episodeId: episodeA,
    shotId: shotA,
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video",
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
    now,
  });
  const miniAttempt = await insertAttempt(handle, {
    actorId: member,
    projectId: projectB,
    episodeId: episodeB,
    shotId: shotB,
    model: "doubao-seedance-2-0-mini-260615",
    mediaKind: "video",
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
    now,
  });
  const audioAttempt = await insertAttempt(handle, {
    actorId: member,
    projectId: projectB,
    episodeId: episodeB,
    shotId: shotB,
    model: "openspeech-test-model",
    mediaKind: "audio",
    parameters: { originalDurationSeconds: 2, format: "mp3" },
    now,
  });
  return {
    owner,
    member,
    projectA,
    projectB,
    fastConfirmedAttempt,
    fastEstimatedAttempt,
    miniAttempt,
    audioAttempt,
  };
}

async function insertAttempt(
  handle: DatabaseHandle,
  input: {
    actorId: string;
    projectId: string;
    episodeId: string;
    shotId: string;
    model: string;
    mediaKind: "image" | "video" | "audio";
    parameters: Record<string, unknown>;
    now: Date;
  },
): Promise<string> {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  await handle.db.insert(generationRequests).values({
    id: requestId,
    userId: input.actorId,
    projectId: input.projectId,
    episodeId: input.episodeId,
    sceneId: null,
    shotId: input.shotId,
    targetAssetEntityId: null,
    mediaKind: input.mediaKind,
    prompt: "S84 provider cost",
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    parameters: input.parameters,
    quantity: 1,
    clientIdempotencyKey: `s84-${requestId}`,
    requestHash: "a".repeat(64),
    chargedPoints: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await handle.db.insert(generationAttempts).values({
    id: attemptId,
    requestId,
    attemptNo: 1,
    retryIdempotencyKey: null,
    provider: input.mediaKind === "audio" ? "openspeech" : "ark",
    providerTaskId: `provider-${attemptId}`,
    model: input.model,
    parameters: input.parameters,
    quantity: 1,
    status: "running",
    phase: "provider_succeeded",
    providerStatus: "succeeded",
    providerResponse: null,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    estimatedCostFen: 320,
    actualCostFen: null,
    actualCostStatus: "unavailable",
    pricingRuleId: null,
    priceSnapshot: {},
    lastQueryError: null,
    nextPollAt: input.now,
    lastPolledAt: input.now,
    leaseOwner: null,
    leaseUntil: null,
    submittedAt: input.now,
    startedAt: input.now,
    finishedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return attemptId;
}

async function assertAggregates(
  handle: DatabaseHandle,
  quoted: string,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
): Promise<void> {
  const byProject = await handle.pool.query<{ key: string; total: string; records: number; unavailable: number }>(
    `SELECT project_id::text AS key,
            COALESCE(SUM(cost_cny_micros), 0)::text AS total,
            COUNT(*)::int AS records,
            COUNT(*) FILTER (WHERE calculation_status = 'unavailable')::int AS unavailable
     FROM ${quoted}.provider_costs GROUP BY project_id ORDER BY project_id`,
  );
  assert.deepEqual(byProject.rows, [
    { key: fixture.projectA, total: "6393600", records: 2, unavailable: 0 },
    { key: fixture.projectB, total: "1987200", records: 2, unavailable: 1 },
  ].sort((left, right) => left.key.localeCompare(right.key)));

  const byActor = await handle.pool.query<{ key: string; total: string; records: number }>(
    `SELECT actor_user_id::text AS key,
            COALESCE(SUM(cost_cny_micros), 0)::text AS total,
            COUNT(*)::int AS records
     FROM ${quoted}.provider_costs GROUP BY actor_user_id ORDER BY actor_user_id`,
  );
  assert.deepEqual(byActor.rows, [
    { key: fixture.owner, total: "6393600", records: 2 },
    { key: fixture.member, total: "1987200", records: 2 },
  ].sort((left, right) => left.key.localeCompare(right.key)));

  const byModel = await handle.pool.query<{ key: string; total: string; records: number }>(
    `SELECT actual_model_id AS key,
            COALESCE(SUM(cost_cny_micros), 0)::text AS total,
            COUNT(*)::int AS records
     FROM ${quoted}.provider_costs GROUP BY actual_model_id ORDER BY actual_model_id`,
  );
  assert.deepEqual(byModel.rows, [
    { key: "doubao-seedance-2-0-fast-260128", total: "6393600", records: 2 },
    { key: "doubao-seedance-2-0-mini-260615", total: "1987200", records: 1 },
    { key: "openspeech-test-model", total: "0", records: 1 },
  ]);
}

function userValue(id: string, username: string, now: Date) {
  return {
    id,
    username: `${username}-${id.slice(0, 6)}`,
    email: null,
    emailVerifiedAt: null,
    displayName: username,
    passwordHash: "test-only",
    active: true,
    role: "member" as const,
    createdAt: now,
    updatedAt: now,
  };
}

function projectValue(id: string, ownerUserId: string, name: string, now: Date) {
  return {
    id,
    ownerUserId,
    teamId: null,
    genre: null,
    name,
    description: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function episodeValue(id: string, projectId: string, now: Date) {
  return {
    id,
    projectId,
    episodeNo: 1,
    name: "第 1 集",
    sortOrder: 1,
    status: "active",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function shotValue(id: string, episodeId: string, shotCode: string, now: Date) {
  return {
    id,
    episodeId,
    sceneId: null,
    shotCode,
    title: "S84 成本",
    scriptText: null,
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt: null,
    durationSeconds: null,
    sortOrder: 1,
    referenceAssetSnapshots: [],
    selectedImageResultId: null,
    selectedVideoResultId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function assertLocalDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("S84_PROVIDER_COST_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL，拒绝连接云 RDS");
  }
}
