import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { quoteIdentifier } from "../src/db/migrate.js";
import {
  adminOperationActions,
  assetEntities,
  assetReviewActions,
  generationAttempts,
  generationDefaultStrategies,
  generationRequests,
  projectAssetRefs,
  projectReviewPolicies,
  projects,
  users,
} from "../src/db/schema.js";
import { DrizzleAdminGenerationsRepository } from "../src/modules/admin/generations/repository.js";
import type { AdminGenerationStats, GenerationStatus } from "../src/modules/admin/generations/types.js";
import { DrizzleDashboardRepository } from "../src/modules/dashboard/repository.js";
import { DashboardService } from "../src/modules/dashboard/service.js";
import {
  createPgDirectorDb,
  PgDirectorSceneRepository,
} from "../src/modules/director/scene/repository.js";
import { GenerationDefaultStrategyRepository } from "../src/modules/generation/defaults/repository.js";
import { OperationsRepository } from "../src/modules/operations/repository.js";
import { PostgresReviewRepository } from "../src/modules/reviews/repository.js";
import { ConflictError } from "../src/shared/errors.js";

const databaseUrl = process.env.ARCHITECTURE_P0_TEST_DATABASE_URL;

test("reviews: PostgreSQL FOR UPDATE + CAS serializes competing asset decisions", {
  skip: !databaseUrl,
}, async () => withProjectFixture("review-cas", async ({ handle, ids, defer }) => {
  const { db } = handle;
  const assetId = randomUUID();
  const refId = randomUUID();
  const now = new Date();

  await db.insert(assetEntities).values(assetValues(assetId, ids.user, now));
  defer(() => db.delete(assetEntities).where(eq(assetEntities.id, assetId)));
  await db.insert(projectAssetRefs).values({
    id: refId,
    projectId: ids.project,
    assetEntityId: assetId,
    assetVariantId: null,
    assetMediaId: null,
    versionSnapshot: {},
    createdByUserId: ids.user,
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  });
  defer(() => db.delete(projectAssetRefs).where(eq(projectAssetRefs.id, refId)));
  defer(() => db.delete(assetReviewActions).where(and(
    eq(assetReviewActions.projectId, ids.project),
    eq(assetReviewActions.assetEntityId, assetId),
  )));

  const repository = new PostgresReviewRepository(db);
  const settled = await Promise.allSettled([
    repository.decideAsset(ids.user, ids.project, assetId, { action: "approved" }),
    repository.decideAsset(ids.user, ids.project, assetId, {
      action: "rejected",
      rejectionReason: "并发审核测试拒绝原因",
    }),
  ]);

  const fulfilled = settled.filter((item) => item.status === "fulfilled");
  const rejected = settled.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1, "同一待审资产只能有一个决策成功");
  assert.equal(rejected.length, 1, "竞争决策必须在读取锁后的终态被拒绝");
  const rejection = rejected[0];
  assert.ok(rejection?.status === "rejected");
  assert.ok(rejection.reason instanceof ConflictError);
  assert.equal(rejection.reason.code, "asset_review_terminal_state");

  const [asset] = await db.select({ status: assetEntities.status, approved: assetEntities.approved })
    .from(assetEntities).where(eq(assetEntities.id, assetId));
  assert.ok(asset);
  assert.equal(asset.approved, asset.status === "approved");
  const actions = await db.select().from(assetReviewActions).where(and(
    eq(assetReviewActions.projectId, ids.project),
    eq(assetReviewActions.assetEntityId, assetId),
  ));
  assert.equal(actions.length, 1, "状态和动作审计必须在同一事务中只写一次");
  assert.equal(actions[0]?.toStatus, asset.status);
}));

test("reviews: repository returns a real PostgreSQL policy version conflict", {
  skip: !databaseUrl,
}, async () => withProjectFixture("review-version", async ({ handle, ids, defer }) => {
  defer(() => handle.db.delete(projectReviewPolicies).where(
    eq(projectReviewPolicies.projectId, ids.project),
  ));
  const repository = new PostgresReviewRepository(handle.db);
  const created = await repository.putPolicy(ids.user, ids.project, {
    mediaKind: "image",
    defaultStrategy: "pending_review",
    expectedVersion: 0,
  });
  assert.equal(created.version, 1);
  const updated = await repository.putPolicy(ids.user, ids.project, {
    mediaKind: "image",
    defaultStrategy: "automatic",
    expectedVersion: 1,
  });
  assert.equal(updated.version, 2);

  await assert.rejects(
    repository.putPolicy(ids.user, ids.project, {
      mediaKind: "image",
      defaultStrategy: "pending_review",
      expectedVersion: 1,
    }),
    (error: unknown) => conflict(error, "project_review_policy_version_conflict", 2),
  );
  const current = await repository.getPolicy(ids.user, ids.project, "image");
  assert.equal(current?.version, 2);
  assert.equal(current?.defaultStrategy, "automatic");
}));

test("operations: same-key review policy reseed increments its version", {
  skip: !databaseUrl,
}, async () => withProjectFixture("operations-policy-upsert", async ({ handle, ids, defer }) => {
  defer(() => handle.db.delete(adminOperationActions).where(
    eq(adminOperationActions.targetId, ids.project),
  ));
  defer(() => handle.db.delete(projectReviewPolicies).where(
    eq(projectReviewPolicies.projectId, ids.project),
  ));
  const operations = new OperationsRepository(handle.db);
  const reviews = new PostgresReviewRepository(handle.db);

  await operations.patchProjectOperations({ userId: ids.user }, ids.project, {
    reviewPolicies: { image: { defaultStrategy: "pending_review" } },
  });
  const created = await reviews.getPolicy(ids.user, ids.project, "image");
  assert.equal(created?.version, 1);

  await operations.patchProjectOperations({ userId: ids.user }, ids.project, {
    reviewPolicies: { image: { defaultStrategy: "automatic" } },
  });
  const updated = await reviews.getPolicy(ids.user, ids.project, "image");
  assert.equal(updated?.version, 2);
  assert.equal(updated?.defaultStrategy, "automatic");
}));

test("director scene: repository returns a real PostgreSQL version conflict", {
  skip: !databaseUrl,
}, async () => withProjectFixture("director-version", async ({ handle, ids, defer }) => {
  const schema = quoteIdentifier(settings.postgresSchema);
  defer(() => handle.pool.query(`DELETE FROM ${schema}.director_scenes WHERE project_id = $1`, [ids.project]));
  const repository = new PgDirectorSceneRepository(createPgDirectorDb(handle.db));
  const first = await repository.saveVersion({
    actorId: ids.user,
    projectId: ids.project,
    expectedVersion: 0,
    snapshot: { schemaVersion: 1, objects: [] },
    sourceAction: "architecture_test_create",
  });
  assert.equal(first.scene.currentVersion, 1);
  const second = await repository.saveVersion({
    actorId: ids.user,
    projectId: ids.project,
    expectedVersion: 1,
    snapshot: { schemaVersion: 1, objects: [{ id: "object-1" }] },
    sourceAction: "architecture_test_update",
  });
  assert.equal(second.scene.currentVersion, 2);

  await assert.rejects(
    repository.saveVersion({
      actorId: ids.user,
      projectId: ids.project,
      expectedVersion: 1,
      snapshot: { schemaVersion: 1, objects: [{ id: "stale" }] },
      sourceAction: "architecture_test_stale",
    }),
    (error: unknown) => conflict(error, "scene_version_conflict", 2),
  );
  const current = await repository.getScene(ids.project);
  assert.equal(current?.currentVersion, 2);
  assert.equal((await repository.listVersions(first.scene.id)).length, 2);
}));

test("generation defaults: repository returns a real PostgreSQL version conflict", {
  skip: !databaseUrl,
}, async () => withProjectFixture("generation-default-version", async ({ handle, ids, defer }) => {
  defer(() => handle.db.delete(generationDefaultStrategies).where(
    eq(generationDefaultStrategies.projectId, ids.project),
  ));
  const repository = new GenerationDefaultStrategyRepository(handle.db);
  const created = await repository.putForActor(ids.user, ids.project, {
    mediaKind: "video",
    mode: "direct_reference",
    modelKey: "seedance-architecture-test",
    parameters: { duration_seconds: 4 },
    expectedVersion: 0,
  });
  assert.equal(created.version, 1);
  const updated = await repository.putForActor(ids.user, ids.project, {
    mediaKind: "video",
    mode: "material_to_prompt",
    modelKey: "seedance-architecture-test-v2",
    parameters: { duration_seconds: 5 },
    expectedVersion: 1,
  });
  assert.equal(updated.version, 2);

  await assert.rejects(
    repository.putForActor(ids.user, ids.project, {
      mediaKind: "video",
      mode: "direct_reference",
      modelKey: "stale-model",
      parameters: {},
      expectedVersion: 1,
    }),
    (error: unknown) => conflict(error, "generation_default_version_conflict", 2),
  );
  const current = await repository.getForActor(ids.user, ids.project, "video");
  assert.equal(current?.version, 2);
  assert.equal(current?.modelKey, "seedance-architecture-test-v2");
}));

test("dashboard and admin generations both project only the current retry attempt", {
  skip: !databaseUrl,
}, async () => withProjectFixture("current-attempt", async ({ handle, ids, defer }) => {
  const { db } = handle;
  const requestId = randomUUID();
  const targetAssetId = randomUUID();
  const now = new Date();
  await db.insert(assetEntities).values(assetValues(targetAssetId, ids.user, now));
  defer(() => db.delete(assetEntities).where(eq(assetEntities.id, targetAssetId)));
  await db.insert(generationRequests).values({
    id: requestId,
    userId: ids.user,
    projectId: ids.project,
    episodeId: null,
    sceneId: null,
    shotId: null,
    targetAssetEntityId: targetAssetId,
    mediaKind: "image",
    prompt: "current attempt architecture test",
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    parameters: {},
    quantity: 1,
    clientIdempotencyKey: `architecture-${randomUUID()}`,
    requestHash: "a".repeat(64),
    createdAt: new Date(now.getTime() - 2_000),
    updatedAt: now,
  });
  defer(() => db.delete(generationRequests).where(eq(generationRequests.id, requestId)));
  defer(() => db.delete(generationAttempts).where(eq(generationAttempts.requestId, requestId)));

  const admin = new DrizzleAdminGenerationsRepository(db);
  const before = await admin.stats();
  await db.insert(generationAttempts).values([
    attemptValues(requestId, 1, "failed", 100, new Date(now.getTime() - 1_000)),
    attemptValues(requestId, 2, "succeeded", 200, now),
  ]);

  const list = await admin.list({
    status: undefined,
    mediaKind: undefined,
    createdFrom: new Date(now.getTime() - 60_000),
    createdTo: new Date(now.getTime() + 60_000),
    limit: 100,
    offset: 0,
  });
  const adminItem = list.items.find((item) => item.requestId === requestId);
  assert.ok(adminItem);
  assert.equal(adminItem.attemptNo, 2);
  assert.equal(adminItem.status, "succeeded");
  assert.equal(adminItem.estimatedCostFen, 200);

  const after = await admin.stats();
  assert.equal(statusCount(after, "succeeded") - statusCount(before, "succeeded"), 1);
  assert.equal(statusCount(after, "failed") - statusCount(before, "failed"), 0);
  const day = now.toISOString().slice(0, 10);
  assert.equal(dailyCost(after, day) - dailyCost(before, day), 200);

  const dashboardRepository = new DrizzleDashboardRepository(db);
  const counts = await dashboardRepository.getDataCounts(ids.user);
  assert.equal(counts.succeeded, 1);
  assert.equal(counts.failed, 0);
  const rows = await dashboardRepository.listGenerationRows(ids.user);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "succeeded");
  assert.equal(rows[0]?.estimatedCostFen, 200);
  const summary = await new DashboardService(dashboardRepository).getSummary(ids.user);
  assert.equal(summary.costs.totalTasks, 1);
  assert.equal(summary.costs.succeededTasks, 1);
  assert.equal(summary.costs.failedTasks, 0);
  assert.equal(summary.costs.totalEstimatedCostFen, 200);
}));

interface FixtureContext {
  handle: DatabaseHandle;
  ids: { user: string; project: string };
  defer: (cleanup: () => Promise<unknown>) => void;
}

async function withProjectFixture(
  label: string,
  run: (context: FixtureContext) => Promise<void>,
): Promise<void> {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const ids = { user: randomUUID(), project: randomUUID() };
  const cleanups: Array<() => Promise<unknown>> = [];
  const defer = (cleanup: () => Promise<unknown>) => cleanups.push(cleanup);
  const now = new Date();
  try {
    await handle.db.insert(users).values({
      id: ids.user,
      username: `${label}-${ids.user.slice(0, 8)}`,
      displayName: `Architecture ${label}`,
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    defer(() => handle.db.delete(users).where(eq(users.id, ids.user)));
    await handle.db.insert(projects).values({
      id: ids.project,
      ownerUserId: ids.user,
      name: `Architecture ${label}`,
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    defer(() => handle.db.delete(projects).where(eq(projects.id, ids.project)));
    await run({ handle, ids, defer });
  } finally {
    let cleanupError: unknown;
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    await handle.pool.end();
    if (cleanupError) throw cleanupError;
  }
}

function assetValues(id: string, ownerUserId: string, now: Date) {
  return {
    id,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId,
    visibility: "personal",
    assetKind: "character",
    name: `review-cas-${id.slice(0, 8)}`,
    displayName: null,
    intro: null,
    appearance: null,
    ageValue: null,
    gender: null,
    heightCm: null,
    hairDescription: null,
    outfitDescription: null,
    category: null,
    styleTags: [],
    approved: null,
    reuseScope: "all_projects",
    status: "pending_review",
    sourceFileUrl: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function attemptValues(
  requestId: string,
  attemptNo: number,
  status: "failed" | "succeeded",
  estimatedCostFen: number,
  now: Date,
) {
  return {
    id: randomUUID(),
    requestId,
    attemptNo,
    retryIdempotencyKey: attemptNo > 1 ? `retry-${randomUUID()}` : null,
    provider: "ark",
    providerTaskId: `architecture-provider-${randomUUID()}`,
    model: "architecture-current-attempt",
    parameters: {},
    quantity: 1,
    status,
    phase: "complete",
    providerStatus: status,
    providerResponse: {},
    errorCode: status === "failed" ? "TEST_FAILURE" : null,
    errorMessage: status === "failed" ? "first attempt failed" : null,
    retryable: status === "failed",
    estimatedCostFen,
    actualCostFen: null,
    actualCostStatus: "unavailable",
    pricingRuleId: null,
    priceSnapshot: {},
    lastQueryError: null,
    nextPollAt: null,
    lastPolledAt: now,
    leaseOwner: null,
    leaseUntil: null,
    submittedAt: now,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function conflict(error: unknown, code: string, currentVersion: number): boolean {
  return error instanceof ConflictError
    && error.code === code
    && error.statusCode === 409
    && (error.details as { currentVersion?: unknown } | null)?.currentVersion === currentVersion;
}

function statusCount(stats: AdminGenerationStats, status: GenerationStatus): number {
  return stats.byStatus.find((item) => item.status === status)?.count ?? 0;
}

function dailyCost(stats: AdminGenerationStats, date: string): number {
  return stats.dailyCostFen.find((item) => item.date === date)?.estimatedCostFen ?? 0;
}
