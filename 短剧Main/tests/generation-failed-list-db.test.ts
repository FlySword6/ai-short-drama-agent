import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const databaseUrl = process.env.GENERATION_FAILED_LIST_TEST_DATABASE_URL;
const schema = process.env.POSTGRES_SCHEMA ?? "";

test("失败任务真 PG：latest attempt、ack 独立、分页排序与本人范围", async () => {
  assert.ok(databaseUrl, "runner must provide a disposable PostgreSQL URL; this test must never skip");
  assertLocalDatabase(databaseUrl);
  assert.match(schema, /^generation_failed_list_[a-z0-9_]+$/);

  const { createDatabase } = await import("../src/db/client.js");
  const { quoteIdentifier, renderMigrationSql } = await import("../src/db/migrate.js");
  const {
    episodes,
    generationAttemptNotifications,
    generationAttempts,
    generationRequests,
    projects,
    shots,
    users,
  } = await import("../src/db/schema.js");
  const { PostgresGenerationRepository } = await import("../src/modules/generation/repository.js");

  const handle = createDatabase(databaseUrl);
  const quoted = quoteIdentifier(schema);
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const ownerProjectId = randomUUID();
  const otherProjectId = randomUUID();
  const ownerEpisodeId = randomUUID();
  const otherEpisodeId = randomUUID();
  const ownerShotId = randomUUID();
  const otherShotId = randomUUID();
  const notificationId = randomUUID();
  const requestIds = {
    failedOlder: randomUUID(),
    failedLatest: randomUUID(),
    failedWithoutFinishedAt: randomUUID(),
    retriedRunning: randomUUID(),
    retriedSucceeded: randomUUID(),
    otherOwner: randomUUID(),
  };
  const attemptIds = {
    failedOlder: randomUUID(),
    failedLatestFirst: randomUUID(),
    failedLatestCurrent: randomUUID(),
    failedWithoutFinishedAt: randomUUID(),
    retriedRunningFirst: randomUUID(),
    retriedRunningCurrent: randomUUID(),
    retriedSucceededFirst: randomUUID(),
    retriedSucceededCurrent: randomUUID(),
    otherOwner: randomUUID(),
  };
  const base = new Date("2026-08-03T00:00:00.000Z");
  const minute = (value: number) => new Date(base.getTime() + value * 60_000);

  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    const migrationFiles = (await readdir(path.resolve("migrations")))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
      .sort();
    for (const file of migrationFiles) {
      await handle.pool.query(renderMigrationSql(
        await readFile(path.resolve("migrations", file), "utf8"),
        schema,
      ));
    }

    await handle.db.insert(users).values([
      user(ownerId, "failed-list-owner", base),
      user(otherId, "failed-list-other", base),
    ]);
    await handle.db.insert(projects).values([
      project(ownerProjectId, ownerId, "本人项目", base),
      project(otherProjectId, otherId, "他人项目", base),
    ]);
    await handle.db.insert(episodes).values([
      episode(ownerEpisodeId, ownerProjectId, 1, base),
      episode(otherEpisodeId, otherProjectId, 1, base),
    ]);
    await handle.db.insert(shots).values([
      shot(ownerShotId, ownerEpisodeId, "OWNER-1", base),
      shot(otherShotId, otherEpisodeId, "OTHER-1", base),
    ]);
    await handle.db.insert(generationRequests).values([
      request(requestIds.failedOlder, ownerId, ownerProjectId, ownerEpisodeId, ownerShotId, "image", minute(1)),
      request(requestIds.failedLatest, ownerId, ownerProjectId, ownerEpisodeId, ownerShotId, "video", minute(2)),
      request(requestIds.failedWithoutFinishedAt, ownerId, ownerProjectId, ownerEpisodeId, ownerShotId, "audio", minute(3)),
      request(requestIds.retriedRunning, ownerId, ownerProjectId, ownerEpisodeId, ownerShotId, "image", minute(4)),
      request(requestIds.retriedSucceeded, ownerId, ownerProjectId, ownerEpisodeId, ownerShotId, "video", minute(5)),
      request(requestIds.otherOwner, otherId, otherProjectId, otherEpisodeId, otherShotId, "image", minute(6)),
    ]);
    await handle.db.insert(generationAttempts).values([
      attempt(attemptIds.failedOlder, requestIds.failedOlder, 1, "failed", "image", minute(11), minute(11)),
      attempt(attemptIds.failedLatestFirst, requestIds.failedLatest, 1, "failed", "video", minute(7), minute(7)),
      attempt(attemptIds.failedLatestCurrent, requestIds.failedLatest, 2, "failed", "video", minute(12), minute(12)),
      attempt(attemptIds.failedWithoutFinishedAt, requestIds.failedWithoutFinishedAt, 1, "failed", "audio", null, minute(20)),
      attempt(attemptIds.retriedRunningFirst, requestIds.retriedRunning, 1, "failed", "image", minute(8), minute(8)),
      attempt(attemptIds.retriedRunningCurrent, requestIds.retriedRunning, 2, "running", "image", null, minute(13)),
      attempt(attemptIds.retriedSucceededFirst, requestIds.retriedSucceeded, 1, "failed", "video", minute(9), minute(9)),
      attempt(attemptIds.retriedSucceededCurrent, requestIds.retriedSucceeded, 2, "succeeded", "video", minute(14), minute(14)),
      attempt(attemptIds.otherOwner, requestIds.otherOwner, 1, "failed", "image", minute(30), minute(30)),
    ]);
    await handle.db.insert(generationAttemptNotifications).values({
      id: notificationId,
      attemptId: attemptIds.failedLatestCurrent,
      generationRequestId: requestIds.failedLatest,
      projectId: ownerProjectId,
      userId: ownerId,
      acknowledgedAt: null,
      createdAt: minute(12),
    });

    const repository = new PostgresGenerationRepository(handle.db);
    const firstPage = await repository.listFailedViewsForActor(ownerId, 1, 2);
    assert.equal(firstPage.total, 3);
    assert.deepEqual(firstPage.items.map((item) => item.requestId), [
      requestIds.failedLatest,
      requestIds.failedOlder,
    ]);
    assert.deepEqual(firstPage.items.map((item) => item.attemptId), [
      attemptIds.failedLatestCurrent,
      attemptIds.failedOlder,
    ]);
    assert.equal(firstPage.items[0]?.errorMessage, "ProviderError: Ark request failed with HTTP 503");

    const secondPage = await repository.listFailedViewsForActor(ownerId, 2, 2);
    assert.deepEqual(secondPage.items.map((item) => item.requestId), [
      requestIds.failedWithoutFinishedAt,
    ], "finished_at 为 null 的历史失败必须排在有终止时间的失败之后");

    const otherOwnerPage = await repository.listFailedViewsForActor(otherId, 1, 50);
    assert.deepEqual(otherOwnerPage.items.map((item) => item.requestId), [requestIds.otherOwner]);

    await repository.acknowledgeAttemptNotification(ownerId, notificationId);
    const acknowledged = await handle.db.select({
      acknowledgedAt: generationAttemptNotifications.acknowledgedAt,
    }).from(generationAttemptNotifications);
    assert.ok(acknowledged[0]?.acknowledgedAt instanceof Date, "fixture notification must really be acknowledged");

    const afterAck = await repository.listFailedViewsForActor(ownerId, 1, 50);
    assert.equal(afterAck.total, 3);
    assert.deepEqual(afterAck.items.map((item) => item.requestId), [
      requestIds.failedLatest,
      requestIds.failedOlder,
      requestIds.failedWithoutFinishedAt,
    ], "通知 ack 不能改变失败任务事实列表");
    assert.equal(afterAck.items.some((item) => item.requestId === requestIds.retriedRunning), false);
    assert.equal(afterAck.items.some((item) => item.requestId === requestIds.retriedSucceeded), false);
    assert.equal(afterAck.items.some((item) => item.requestId === requestIds.otherOwner), false);
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

function user(id: string, username: string, now: Date) {
  return {
    id,
    username,
    displayName: username,
    passwordHash: "test-only",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

function project(id: string, ownerUserId: string, name: string, now: Date) {
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

function request(
  id: string,
  userId: string,
  projectId: string,
  episodeId: string,
  shotId: string,
  mediaKind: "image" | "video" | "audio",
  now: Date,
) {
  return {
    id,
    userId,
    projectId,
    episodeId,
    sceneId: null,
    shotId,
    targetAssetEntityId: null,
    mediaKind,
    prompt: "失败列表真库回放",
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    parameters: {},
    quantity: 1,
    clientIdempotencyKey: `failed-list-${id}`,
    requestHash: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    createdAt: now,
    updatedAt: now,
  };
}

function shot(id: string, episodeId: string, shotCode: string, now: Date) {
  return {
    id,
    episodeId,
    sceneId: null,
    shotCode,
    title: shotCode,
    scriptText: null,
    breakdownElements: null,
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt: null,
    durationSeconds: null,
    sortOrder: 1,
    referenceAssetSnapshots: [],
    sourceBreakdownRunId: null,
    sourceCandidateId: null,
    selectedImageResultId: null,
    selectedVideoResultId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function episode(id: string, projectId: string, episodeNo: number, now: Date) {
  return {
    id,
    projectId,
    episodeNo,
    name: `第 ${episodeNo} 集`,
    sortOrder: episodeNo,
    status: "active",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function attempt(
  id: string,
  requestId: string,
  attemptNo: number,
  status: "failed" | "running" | "succeeded",
  mediaKind: "image" | "video" | "audio",
  finishedAt: Date | null,
  updatedAt: Date,
) {
  return {
    id,
    requestId,
    attemptNo,
    retryIdempotencyKey: attemptNo > 1 ? `retry-${id}` : null,
    provider: "ark",
    providerTaskId: null,
    model: "failed-list-test-model",
    parameters: {},
    quantity: 1,
    status,
    phase: status === "running" ? "provider_running" : "complete",
    providerStatus: null,
    providerResponse: null,
    errorCode: status === "failed" ? "provider_rejected" : null,
    errorMessage: status === "failed" ? "ProviderError: Ark request failed with HTTP 503" : null,
    retryable: status === "failed",
    estimatedCostFen: 100,
    actualCostFen: null,
    actualCostStatus: "unavailable",
    pricingRuleId: null,
    priceSnapshot: failedListPriceSnapshot(mediaKind),
    lastQueryError: null,
    nextPollAt: null,
    lastPolledAt: null,
    leaseOwner: null,
    leaseUntil: null,
    submittedAt: null,
    startedAt: null,
    finishedAt,
    createdAt: updatedAt,
    updatedAt,
  };
}

function failedListPriceSnapshot(mediaKind: "image" | "video" | "audio"): Record<string, unknown> {
  return {
    tierId: `failed-list-${mediaKind}`,
    pricingRuleId: "failed-list-fixture",
    provider: "ark",
    model: "failed-list-test-model",
    mediaKind,
    billingUnit: mediaKind === "image" ? "image" : "second",
    unitPriceFen: 100,
    billableUnits: 1,
    estimatedCostFen: 100,
    fullEstimatedCostFen: 100,
    productionMode: "full",
    priceMultiplierBps: 10_000,
    discountNumerator: 1,
    discountDenominator: 1,
    currency: "CNY",
  };
}

function assertLocalDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("GENERATION_FAILED_LIST_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL，拒绝连接云 RDS");
  }
}
