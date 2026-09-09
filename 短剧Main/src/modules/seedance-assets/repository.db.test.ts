import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { settings } from "../../config/env.js";
import { createDatabase, type DatabaseHandle } from "../../db/client.js";
import { quoteIdentifier, renderMigrationSql, runMigrations } from "../../db/migrate.js";
import { AppError } from "../../shared/errors.js";
import { AssetMediaRepository } from "../../repositories/assetMediaRepository.js";
import { DrizzleAssetMediaUploadRepository } from "../assets/mediaUpload.js";
import {
  assetEntities,
  assetMedia,
  episodes,
  generationAttempts,
  generationQuotes,
  generationRequests,
  mediaProvenanceAuthority,
  mediaProvenanceParentEdges,
  mediaProvenanceSubjects,
  mediaResults,
  projects,
  projectMembers,
  pricingRules,
  seedanceAssetRegistrationAttempts,
  seedanceAssetRegistrations,
  shots,
  users,
  volcAssetGroups,
} from "../../db/schema.js";
import { SeedanceAssetRegistrationRepository } from "./repository.js";
import { SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS } from "./policy.js";
import { GenerationError } from "../generation/errors.js";
import { PostgresGenerationRepository } from "../generation/repository.js";
import { VolcAssetGroupResolver } from "../assets/volcAssetGroups.js";
import { VolcAssetGroupRepository } from "../assets/volcAssetGroupRepository.js";
import { VolcAssetRegistryOperationError } from "../assets/volcAssetRegistry.js";
import {
  hashGenerationBatch,
  hashGenerationRequest,
  normalizeGenerationInput,
} from "../generation/service.js";

const databaseUrl = process.env.SEEDANCE_ASSET_REGISTRATION_TEST_DATABASE_URL;
const disposableSchemaPrefix = "s49_test_";
const safeSchemaName = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const localPostgresHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const disposableSchemaLockNamespace = 49_049;

test("火山素材组在 PostgreSQL 中并发幂等创建并复用唯一远端组", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  let createCalls = 0;
  let releaseCreate!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const resolver = new VolcAssetGroupResolver(new VolcAssetGroupRepository(fixture.handle.db), {
    createAssetGroup: async () => {
      createCalls += 1;
      markStarted();
      await release;
      return {
        groupId: "group-db-concurrent",
        requestId: "req-group-db-concurrent",
        httpStatus: 200,
      };
    },
  });
  const configuration = {
    name: "并发素材组",
    description: "并发幂等创建测试",
    projectName: "shortdrama-dev",
  };

  const first = resolver.resolve(fixture.actorId, configuration);
  await started;
  const second = await resolver.resolve(fixture.actorId, configuration);
  assert.deepEqual(second, { kind: "settling" });
  releaseCreate();
  assert.deepEqual(await first, {
    kind: "resolved",
    groupId: "group-db-concurrent",
    requestId: "req-group-db-concurrent",
  });

  const reused = await resolver.resolve(fixture.actorId, configuration);
  assert.deepEqual(reused, {
    kind: "resolved",
    groupId: "group-db-concurrent",
    requestId: "req-group-db-concurrent",
  });
  assert.equal(createCalls, 1);
  const rows = await fixture.handle.db.select().from(volcAssetGroups);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "active");
  assert.equal(rows[0]?.retryCount, 0);

  await fixture.handle.pool.query(renderMigrationSql(
    await readFile(path.resolve("migrations/053_volc_asset_registration.sql"), "utf8"),
    settings.postgresSchema,
  ));
  const replayed = await fixture.handle.db.select().from(volcAssetGroups);
  assert.equal(replayed.length, 1, "053 原 SQL 重放必须保持同一素材组映射");
  assert.equal(replayed[0]?.volcAssetGroupId, "group-db-concurrent");
}));

test("素材组明确失败只由下一次人工动作重试，并保存中文失败与重试时间", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  let createCalls = 0;
  const resolver = new VolcAssetGroupResolver(new VolcAssetGroupRepository(fixture.handle.db), {
    createAssetGroup: async () => {
      createCalls += 1;
      if (createCalls === 1) {
        throw new VolcAssetRegistryOperationError(
          {
            errorCode: "ASSET_REGISTRY_ACCESS_DENIED",
            errorMessage: "denied",
            requestId: "req-group-denied",
            httpStatus: 403,
          },
          false,
        );
      }
      return {
        groupId: "group-db-retry",
        requestId: "req-group-retry",
        httpStatus: 200,
      };
    },
  });
  const configuration = {
    name: "失败重试素材组",
    description: "明确失败后人工重试测试",
    projectName: "shortdrama-dev",
  };

  const failed = await resolver.resolve(fixture.actorId, configuration);
  assert.equal(failed.kind, "failure");
  assert.equal(failed.kind === "failure" && failed.status, "failed");
  let row = (await fixture.handle.db.select().from(volcAssetGroups))[0]!;
  assert.equal(row.status, "failed");
  assert.equal(row.latestErrorCode, "ASSET_GROUP_ACCESS_DENIED");
  assert.match(row.latestErrorMessage ?? "", /^火山素材组创建失败/);
  assert.equal(row.retryCount, 0);

  const retried = await resolver.resolve(fixture.actorId, configuration);
  assert.deepEqual(retried, {
    kind: "resolved",
    groupId: "group-db-retry",
    requestId: "req-group-retry",
  });
  row = (await fixture.handle.db.select().from(volcAssetGroups))[0]!;
  assert.equal(row.status, "active");
  assert.equal(row.retryCount, 1);
  assert.ok(row.lastRetryAt);
  assert.equal(createCalls, 2);
}));

test("素材组不确定写结果锁为 unknown，后续人工点击也不会重复 CreateAssetGroup", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  let createCalls = 0;
  const resolver = new VolcAssetGroupResolver(new VolcAssetGroupRepository(fixture.handle.db), {
    createAssetGroup: async () => {
      createCalls += 1;
      throw new VolcAssetRegistryOperationError(
        {
          errorCode: "ASSET_REGISTRY_UNAVAILABLE",
          errorMessage: "network",
          requestId: null,
          httpStatus: null,
        },
        true,
      );
    },
  });
  const configuration = {
    name: "未知结果素材组",
    description: "不确定结果禁止自动重发测试",
    projectName: "shortdrama-dev",
  };
  const first = await resolver.resolve(fixture.actorId, configuration);
  const second = await resolver.resolve(fixture.actorId, configuration);
  assert.equal(first.kind, "failure");
  assert.equal(first.kind === "failure" && first.status, "unknown");
  assert.equal(second.kind, "failure");
  assert.equal(second.kind === "failure" && second.status, "unknown");
  assert.equal(createCalls, 1);
  const row = (await fixture.handle.db.select().from(volcAssetGroups))[0]!;
  assert.equal(row.status, "unknown");
  assert.equal(row.retryCount, 0);
  assert.match(row.latestErrorMessage ?? "", /不会自动重复创建/);
}));

test("同一固定火山组 ID 不能漂移到另一套本地名称或项目配置", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  let providerCalls = 0;
  const resolver = new VolcAssetGroupResolver(
    new VolcAssetGroupRepository(fixture.handle.db),
    {
      createAssetGroup: async () => {
        providerCalls += 1;
        throw new Error("configured group import must not call provider");
      },
    },
  );
  const configuredGroupId = "group-db-configured-conflict";
  assert.deepEqual(await resolver.resolve(fixture.actorId, {
    configuredGroupId,
    name: "固定素材组 A",
    description: "固定组映射冲突测试 A",
    projectName: "shortdrama-dev",
  }), {
    kind: "resolved",
    groupId: configuredGroupId,
    requestId: null,
  });

  await assert.rejects(
    () => resolver.resolve(fixture.actorId, {
      configuredGroupId,
      name: "固定素材组 B",
      description: "固定组映射冲突测试 B",
      projectName: "shortdrama-dev",
    }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 409
      && error.code === "volc_asset_group_configuration_conflict",
  );
  assert.equal(providerCalls, 0);
  assert.equal((await fixture.handle.db.select().from(volcAssetGroups)).length, 1);
}));

test("Seedance 素材登记在 PostgreSQL 中串行 claim，避免并发重复 CreateAsset", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const repository = new SeedanceAssetRegistrationRepository(fixture.handle.db);
  const prepared = await repository.prepareForMediaResult(fixture.actorId, fixture.mediaResultId, {
    assetGroupId: "asset-group-test",
    projectName: "shortdrama-dev",
  });
  const promotedMedia = (await fixture.handle.db.select().from(assetMedia).where(
    eq(assetMedia.id, prepared.source.assetMediaId),
  ))[0];
  assert.ok(promotedMedia?.assetEntityId);
  const promotedEntity = (await fixture.handle.db.select().from(assetEntities).where(
    eq(assetEntities.id, promotedMedia.assetEntityId),
  ))[0];
  assert.equal(promotedEntity?.status, "approved");
  assert.equal(promotedEntity?.approved, true);
  assert.equal(promotedMedia.approved, true);

  const currentStorageUrl = "https://assets.example.test/results/current-at-claim.png";
  await fixture.handle.db.update(assetMedia).set({
    storageUrl: currentStorageUrl,
    title: "事务内重读素材",
  }).where(eq(assetMedia.id, prepared.source.assetMediaId));
  const [left, right] = await Promise.all([
    repository.claimCreate(prepared.registration.id, fixture.actorId),
    repository.claimCreate(prepared.registration.id, fixture.actorId),
  ]);
  assert.deepEqual([left.kind, right.kind].sort(), ["create", "settling"]);
  const registration = await fixture.handle.db.select().from(seedanceAssetRegistrations).where(
    eq(seedanceAssetRegistrations.id, prepared.registration.id),
  );
  assert.equal(registration[0]?.status, "submitting");

  const submittedClaim = left.kind === "create" ? left : right;
  assert.equal(submittedClaim.kind, "create");
  if (submittedClaim.kind !== "create") throw new Error("Expected one CreateAsset claim");
  assert.equal(submittedClaim.source.storageUrl, currentStorageUrl);
  assert.equal(submittedClaim.source.name, "事务内重读素材");
  await repository.recordCreateSubmitted(prepared.registration.id, fixture.actorId, {
    assetId: "Asset-seedance-test",
    assetName: "登记测试素材",
    requestId: "req-create-test",
    httpStatus: 200,
  });
  await Promise.all([
    repository.recordAssetStatus(prepared.registration.id, fixture.actorId, {
      status: "Processing", requestId: "req-refresh-1", httpStatus: 200, errorCode: null, errorMessage: null,
    }),
    repository.recordAssetStatus(prepared.registration.id, fixture.actorId, {
      status: "Processing", requestId: "req-refresh-2", httpStatus: 200, errorCode: null, errorMessage: null,
    }),
  ]);
  assert.equal(submittedClaim.registration.status, "submitting");

  const attempts = await fixture.handle.db.select().from(seedanceAssetRegistrationAttempts)
    .where(eq(seedanceAssetRegistrationAttempts.registrationId, prepared.registration.id))
    .orderBy(seedanceAssetRegistrationAttempts.attemptNo);
  assert.deepEqual(attempts.map((attempt) => attempt.attemptNo), [1, 2, 3, 4]);
  assert.deepEqual(attempts.map((attempt) => attempt.outcome), ["submitting", "submitted", "processing", "processing"]);
  assert.equal(attempts.filter((attempt) => attempt.outcome === "submitting").length, 1);
  assert.equal((await fixture.handle.db.select().from(seedanceAssetRegistrations).where(
    eq(seedanceAssetRegistrations.sourceMediaResultId, fixture.mediaResultId),
  )).length, 1, "同一生成产物只能有一条本地登记映射");
  const mapping = (await fixture.handle.db.select().from(seedanceAssetRegistrations).where(
    eq(seedanceAssetRegistrations.id, prepared.registration.id),
  ))[0]!;
  assert.equal(mapping.assetGroupId, "asset-group-test");
  assert.equal(mapping.remoteAssetId, "Asset-seedance-test");
  assert.equal(mapping.remoteAssetName, "登记测试素材");
  assert.ok(
    mapping.latestRequestId === "req-refresh-1" || mapping.latestRequestId === "req-refresh-2",
    "并发回读的最后提交者可以是任一请求",
  );
  assert.equal(
    mapping.latestRequestId,
    attempts.at(-1)?.providerRequestId,
    "登记主行必须与审计序列中最后提交的回读一致",
  );
  assert.equal(mapping.latestErrorCode, null);
  assert.equal(mapping.retryCount, 0);

  await repository.recordAssetStatus(prepared.registration.id, fixture.actorId, {
    status: "Active", requestId: "req-refresh-active", httpStatus: 200, errorCode: null, errorMessage: null,
  });
  const reused = await repository.recordReuseActive(prepared.registration.id, fixture.actorId);
  assert.equal(reused.status, "active");
  assert.equal(
    reused.latestRequestId,
    "req-refresh-active",
    "本地幂等复用不能抹掉最近一次供应商回读 Request ID",
  );
}));

test("登记和素材组明确失败保存中文原因，下一次人工动作才增加重试并清错", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const repository = new SeedanceAssetRegistrationRepository(fixture.handle.db);
  const prepared = await repository.prepareForMediaResult(fixture.actorId, fixture.mediaResultId, {
    assetGroupId: null,
    projectName: "shortdrama-dev",
  });
  const failed = await repository.recordGroupFailure(
    prepared.registration.id,
    fixture.actorId,
    {
      errorCode: "ASSET_GROUP_ACCESS_DENIED",
      errorMessage: "provider text is never persisted",
      requestId: "req-group-failed",
      httpStatus: 403,
    },
    "failed",
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.assetGroupId, null);
  assert.equal(failed.latestRequestId, "req-group-failed");
  assert.equal(failed.latestErrorCode, "ASSET_GROUP_ACCESS_DENIED");
  assert.equal(
    failed.latestErrorMessage,
    "火山素材库拒绝素材组操作，请核对账号权限",
  );
  assert.equal(failed.retryCount, 0);

  const rebound = await repository.bindAssetGroup(
    prepared.registration.id,
    fixture.actorId,
    "group-after-explicit-failure",
    "shortdrama-dev",
  );
  assert.equal(rebound.status, "pending");
  assert.equal(rebound.retryCount, 1);
  assert.ok(rebound.lastRetryAt);
  assert.equal(rebound.latestErrorCode, null);
  assert.equal((await repository.claimCreate(prepared.registration.id, fixture.actorId)).kind, "create");

  const createFailed = await repository.recordCreateFailure(
    prepared.registration.id,
    fixture.actorId,
    {
      errorCode: "ASSET_REGISTRY_INVALID_REQUEST",
      errorMessage: "provider text is never persisted",
      requestId: "req-create-failed",
      httpStatus: 400,
    },
  );
  assert.equal(createFailed.status, "failed");
  assert.equal(createFailed.latestRequestId, "req-create-failed");
  assert.equal(createFailed.latestErrorCode, "ASSET_REGISTRY_INVALID_REQUEST");
  assert.equal(
    createFailed.latestErrorMessage,
    "素材注册请求不符合火山素材库合同",
  );
  assert.equal(createFailed.retryCount, 1);

  const retry = await repository.claimCreate(prepared.registration.id, fixture.actorId);
  assert.equal(retry.kind, "create");
  assert.equal(retry.registration.retryCount, 2);
  assert.ok(retry.registration.lastRetryAt);
  assert.equal(retry.registration.latestErrorCode, null);
}));

test("历史登记供应商错误码在 repository view 单一出口归一", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const repository = new SeedanceAssetRegistrationRepository(fixture.handle.db);
  const prepared = await repository.prepareForMediaResult(fixture.actorId, fixture.mediaResultId, {
    assetGroupId: "asset-group-test",
    projectName: "shortdrama-dev",
  });
  await fixture.handle.db.update(seedanceAssetRegistrations).set({
    status: "failed",
    latestErrorCode: "AccessDenied",
    latestErrorMessage: "provider internal detail 403",
  }).where(eq(seedanceAssetRegistrations.id, prepared.registration.id));

  const projected = await repository.viewForRegistration(
    prepared.registration.id,
    fixture.actorId,
  );
  assert.equal(projected.latestErrorCode, "ASSET_REGISTRY_ACCESS_DENIED");
  assert.equal(projected.latestErrorMessage, "火山素材库拒绝访问，请核对账号权限");
  assert.doesNotMatch(
    JSON.stringify(projected),
    /AccessDenied|provider internal detail/,
  );
}));

test("远端 Asset ID 以登记表为真，并事务投影到 asset_media metadata 且可修复漂移", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const repository = new SeedanceAssetRegistrationRepository(fixture.handle.db);
  const prepared = await repository.prepareForMediaResult(fixture.actorId, fixture.mediaResultId, {
    assetGroupId: "asset-group-test",
    projectName: "shortdrama-dev",
  });
  await repository.claimCreate(prepared.registration.id, fixture.actorId);
  await repository.recordCreateSubmitted(prepared.registration.id, fixture.actorId, {
    assetId: "Asset-formal-truth",
    assetName: "正式映射测试素材",
    requestId: "req-projection-create",
    httpStatus: 200,
  });
  let media = (await fixture.handle.db.select().from(assetMedia).where(eq(assetMedia.id, prepared.source.assetMediaId)))[0];
  assert.equal(media?.metadata.seedance_asset_id, "Asset-formal-truth");

  // Simulate a legacy/manual JSON projection write. The next authoritative
  // refresh must repair it without changing the registration mapping.
  await fixture.handle.db.update(assetMedia).set({ metadata: { seedance_asset_id: "Asset-drift" } })
    .where(eq(assetMedia.id, prepared.source.assetMediaId));
  await repository.recordAssetStatus(prepared.registration.id, fixture.actorId, {
    status: "Active", requestId: "req-projection-repair", httpStatus: 200, errorCode: null, errorMessage: null,
  });
  media = (await fixture.handle.db.select().from(assetMedia).where(eq(assetMedia.id, prepared.source.assetMediaId)))[0];
  const registration = (await fixture.handle.db.select().from(seedanceAssetRegistrations)
    .where(eq(seedanceAssetRegistrations.id, prepared.registration.id)))[0];
  assert.equal(registration?.remoteAssetId, "Asset-formal-truth");
  assert.ok(registration?.lastVerifiedAt, "Active 必须记录最近一次远端核验时间");
  assert.equal(media?.metadata.seedance_asset_id, "Asset-formal-truth");
}));

test("CreateAsset 授权到期或远端核验过旧立即转 unavailable，保留远端真源且不会重复 CreateAsset", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const repository = new SeedanceAssetRegistrationRepository(fixture.handle.db);
  const prepared = await repository.prepareForMediaResult(fixture.actorId, fixture.mediaResultId, {
    assetGroupId: "asset-group-test",
    projectName: "shortdrama-dev",
  });
  assert.equal((await repository.claimCreate(prepared.registration.id, fixture.actorId)).kind, "create");
  await repository.recordCreateSubmitted(prepared.registration.id, fixture.actorId, {
    assetId: "Asset-expiring-authorization",
    assetName: "授权到期测试素材",
    requestId: "req-expiring-create",
    httpStatus: 200,
  });
  await repository.recordAssetStatus(prepared.registration.id, fixture.actorId, {
    status: "Active",
    requestId: "req-expiring-active",
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
  });
  await fixture.handle.db.update(seedanceAssetRegistrations).set({
    authorizationExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(seedanceAssetRegistrations.id, prepared.registration.id));

  const claim = await repository.claimCreate(prepared.registration.id, fixture.actorId);
  assert.equal(claim.kind, "settling");
  assert.equal(claim.registration.status, "unavailable");
  assert.equal(claim.registration.remoteAssetId, "Asset-expiring-authorization");
  const attempts = await fixture.handle.db.select().from(seedanceAssetRegistrationAttempts)
    .where(eq(seedanceAssetRegistrationAttempts.registrationId, prepared.registration.id))
    .orderBy(seedanceAssetRegistrationAttempts.attemptNo);
  assert.deepEqual(
    attempts.map((attempt) => attempt.outcome),
    ["submitting", "submitted", "active", "unavailable"],
  );
  assert.equal(attempts.filter((attempt) => attempt.action === "create").length, 2);
  assert.equal(attempts.at(-1)?.errorCode, "ASSET_REGISTRY_AUTHORIZATION_EXPIRED");

  const staleVerifiedAt = new Date(Date.now() - SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS - 1_000);
  await fixture.handle.db.update(seedanceAssetRegistrations).set({
    status: "active",
    activatedAt: staleVerifiedAt,
    authorizationExpiresAt: null,
    lastVerifiedAt: staleVerifiedAt,
    latestRequestId: null,
    latestErrorCode: null,
    latestErrorMessage: null,
    updatedAt: new Date(),
    lastActionAt: new Date(),
  }).where(eq(seedanceAssetRegistrations.id, prepared.registration.id));
  const staleClaim = await repository.claimCreate(prepared.registration.id, fixture.actorId);
  assert.equal(staleClaim.kind, "settling");
  assert.equal(staleClaim.registration.status, "unavailable");
  const staleAttempt = (await fixture.handle.db.select().from(seedanceAssetRegistrationAttempts)
    .where(eq(seedanceAssetRegistrationAttempts.registrationId, prepared.registration.id))
    .orderBy(seedanceAssetRegistrationAttempts.attemptNo))[4];
  assert.equal(staleAttempt?.errorCode, "ASSET_REGISTRY_VERIFICATION_STALE");
}));

test("媒体产物登记按项目成员鉴权，写入领取在事务内再次核对", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const repository = new SeedanceAssetRegistrationRepository(fixture.handle.db);
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const outsiderId = randomUUID();
  const adminId = randomUUID();
  const now = new Date("2026-07-24T00:00:00.000Z");
  const extraIds = [editorId, viewerId, outsiderId, adminId];
  fixture.extraUserIds.push(...extraIds);
  await fixture.handle.db.insert(users).values([
    userFixture(editorId, "editor", now, "member"),
    userFixture(viewerId, "viewer", now, "member"),
    userFixture(outsiderId, "outsider", now, "member"),
    userFixture(adminId, "admin", now, "admin"),
  ]);
  await fixture.handle.db.insert(projectMembers).values([
    { projectId: fixture.projectId, userId: editorId, role: "editor", addedByUserId: fixture.actorId, createdAt: now },
    { projectId: fixture.projectId, userId: viewerId, role: "viewer", addedByUserId: fixture.actorId, createdAt: now },
  ]);

  const prepared = await repository.prepareForMediaResult(
    { id: fixture.actorId, role: "member" },
    fixture.mediaResultId,
    { assetGroupId: "asset-group-test", projectName: "shortdrama-dev" },
  );

  await repository.getForMediaResult({ id: viewerId, role: "member" }, fixture.mediaResultId);
  await repository.getForMediaResult({ id: adminId, role: "admin" }, fixture.mediaResultId);
  await assert.rejects(
    () => repository.getForMediaResult({ id: outsiderId, role: "member" }, fixture.mediaResultId),
    isStatus(404),
  );
  await assert.rejects(
    () => repository.prepareForMediaResult(
      { id: viewerId, role: "member" },
      fixture.mediaResultId,
      { assetGroupId: "asset-group-test", projectName: "shortdrama-dev" },
    ),
    isStatus(403),
  );
  await assert.rejects(
    () => repository.claimCreate(prepared.registration.id, { id: viewerId, role: "member" }),
    isStatus(403),
  );
  const editorClaim = await repository.claimCreate(prepared.registration.id, { id: editorId, role: "member" });
  assert.equal(editorClaim.kind, "create");
}));

test("PostgreSQL 血缘闭包保留直接、跨代和 unknown 外来祖先，客户端 metadata 不能洗白", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const now = new Date();
  const externalMediaId = await insertTestImageAssetMedia(fixture, now, {
    source_channel: "first_party_generation",
    client_claim: "forged",
  });
  const externalSubject = (await fixture.handle.db.insert(mediaProvenanceSubjects).values({
    assetMediaId: externalMediaId,
    mediaResultId: null,
    sourceChannel: "external_upload",
    sourceGenerationAttemptId: null,
    providerAssetId: null,
    observedAt: now,
  }).returning({ id: mediaProvenanceSubjects.id }))[0]!;

  const firstGenerationId = await insertTestImageResult(fixture, now, 10);
  const firstGenerationSubject = (await fixture.handle.db.insert(mediaProvenanceSubjects).values({
    assetMediaId: null,
    mediaResultId: firstGenerationId,
    sourceChannel: "first_party_generation",
    sourceGenerationAttemptId: fixture.generationAttemptId,
    providerAssetId: null,
    observedAt: now,
  }).returning({ id: mediaProvenanceSubjects.id }))[0]!;
  await fixture.handle.db.insert(mediaProvenanceParentEdges).values({
    childSubjectId: firstGenerationSubject.id,
    parentSubjectId: externalSubject.id,
    createdAt: now,
  });
  assert.equal(await containsExternalImageAncestor(fixture, firstGenerationSubject.id), true);

  const promotedMediaId = await insertTestImageAssetMedia(fixture, now, { source: "promotion" });
  const promotedSubjectId = await fixture.handle.db.transaction(async (transaction) => {
    const promotedSubject = (await transaction.insert(mediaProvenanceSubjects).values({
      assetMediaId: promotedMediaId,
      mediaResultId: null,
      sourceChannel: "first_party_generation",
      sourceGenerationAttemptId: fixture.generationAttemptId,
      providerAssetId: null,
      observedAt: now,
    }).returning({ id: mediaProvenanceSubjects.id }))[0]!;
    await transaction.insert(mediaProvenanceParentEdges).values({
      childSubjectId: promotedSubject.id,
      parentSubjectId: firstGenerationSubject.id,
      createdAt: now,
    });
    return promotedSubject.id;
  });
  const multiGenerationId = await insertTestImageResult(fixture, now, 11);
  const multiGenerationSubject = (await fixture.handle.db.insert(mediaProvenanceSubjects).values({
    assetMediaId: null,
    mediaResultId: multiGenerationId,
    sourceChannel: "first_party_generation",
    sourceGenerationAttemptId: fixture.generationAttemptId,
    providerAssetId: null,
    observedAt: now,
  }).returning({ id: mediaProvenanceSubjects.id }))[0]!;
  await fixture.handle.db.insert(mediaProvenanceParentEdges).values({
    childSubjectId: multiGenerationSubject.id,
    parentSubjectId: promotedSubjectId,
    createdAt: now,
  });
  assert.equal(await containsExternalImageAncestor(fixture, multiGenerationSubject.id), true);

  const unknownMediaId = await insertTestImageAssetMedia(fixture, now, { model: "seedream-5-pro" });
  const unknownSubject = (await fixture.handle.db.insert(mediaProvenanceSubjects).values({
    assetMediaId: unknownMediaId,
    mediaResultId: null,
    sourceChannel: "unknown",
    sourceGenerationAttemptId: null,
    providerAssetId: null,
    observedAt: now,
  }).returning({ id: mediaProvenanceSubjects.id }))[0]!;
  const unknownChildId = await insertTestImageResult(fixture, now, 12);
  const unknownChildSubject = (await fixture.handle.db.insert(mediaProvenanceSubjects).values({
    assetMediaId: null,
    mediaResultId: unknownChildId,
    sourceChannel: "first_party_generation",
    sourceGenerationAttemptId: fixture.generationAttemptId,
    providerAssetId: null,
    observedAt: now,
  }).returning({ id: mediaProvenanceSubjects.id }))[0]!;
  await fixture.handle.db.insert(mediaProvenanceParentEdges).values({
    childSubjectId: unknownChildSubject.id,
    parentSubjectId: unknownSubject.id,
    createdAt: now,
  });
  assert.equal(await containsExternalImageAncestor(fixture, unknownChildSubject.id), true);

  const selfProducedId = await insertTestImageResult(fixture, now, 13);
  const selfProducedSubject = (await fixture.handle.db.insert(mediaProvenanceSubjects).values({
    assetMediaId: null,
    mediaResultId: selfProducedId,
    sourceChannel: "first_party_generation",
    sourceGenerationAttemptId: fixture.generationAttemptId,
    providerAssetId: null,
    observedAt: now,
  }).returning({ id: mediaProvenanceSubjects.id }))[0]!;
  assert.equal(await containsExternalImageAncestor(fixture, selfProducedSubject.id), false);

  await assert.rejects(
    () => fixture.handle.db.update(mediaProvenanceSubjects).set({ sourceChannel: "first_party_generation" })
      .where(eq(mediaProvenanceSubjects.id, externalSubject.id)),
    (error: unknown) => errorChainMatches(error, /media provenance subjects are immutable/),
  );
  await assert.rejects(
    () => fixture.handle.db.insert(mediaProvenanceParentEdges).values({
      childSubjectId: externalSubject.id,
      parentSubjectId: multiGenerationSubject.id,
      createdAt: now,
    }),
    (error: unknown) => errorChainMatches(error, /must not introduce a cycle/),
  );
}));

test("普通、Excel 和视觉图片入库均在媒体事务写入 external_upload 来源事实", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const now = new Date();
  const existingMediaId = await insertTestImageAssetMedia(fixture, now, { source: "fixture-owner" });
  const existingMedia = (await fixture.handle.db.select({
    assetEntityId: assetMedia.assetEntityId,
  }).from(assetMedia).where(eq(assetMedia.id, existingMediaId)).limit(1))[0];
  assert.ok(existingMedia?.assetEntityId);

  const uploadedMediaId = randomUUID();
  const repository = new DrizzleAssetMediaUploadRepository(fixture.handle.db);
  const uploaded = await repository.persistUploadedMedia({
    actorId: fixture.actorId,
    assetId: existingMedia.assetEntityId,
    mediaId: uploadedMediaId,
    originalFileName: "external-reference.png",
    declaredContentType: "image/png",
    title: "外部上传参考图",
    description: "S49 provenance integration test",
    isPrimary: false,
    sha256: "a".repeat(64),
    media: {
      kind: "image",
      format: "png",
      extension: "png",
      contentType: "image/png",
      width: 1024,
      height: 1024,
    },
    stored: {
      bucket: "s49-test",
      storagePath: `uploads/${uploadedMediaId}.png`,
      storageUrl: `https://assets.example.test/uploads/${uploadedMediaId}.png`,
    },
  });
  assert.equal(uploaded.id, uploadedMediaId);
  const subject = (await fixture.handle.db.select().from(mediaProvenanceSubjects)
    .where(eq(mediaProvenanceSubjects.assetMediaId, uploadedMediaId)).limit(1))[0];
  assert.equal(subject?.sourceChannel, "external_upload");
  assert.equal(subject?.sourceGenerationAttemptId, null);
  assert.equal(subject?.providerAssetId, null);

  const ingestRepository = new AssetMediaRepository(fixture.handle.db);
  const ingested = await ingestRepository.create({
    assetEntityId: existingMedia.assetEntityId,
    mediaKind: "image",
    viewAngle: "unknown",
    title: "Excel/视觉入库参考图",
    storageBucket: "s49-test",
    storagePath: `ingest/${randomUUID()}.png`,
    storageUrl: "https://assets.example.test/ingest/external.png",
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: "b".repeat(64),
    isPrimary: false,
    approved: true,
    sortOrder: 2,
    metadata: { source_channel: "first_party_generation", client_claim: "forged" },
  });
  const ingestedSubject = (await fixture.handle.db.select().from(mediaProvenanceSubjects)
    .where(eq(mediaProvenanceSubjects.assetMediaId, ingested.id)).limit(1))[0];
  assert.equal(ingestedSubject?.sourceChannel, "external_upload");
}));

test("外来图片无当前可用登记（含 stale-active）时，真实 PostgreSQL 在报价、提交、重试、批量和 worker 组包前都拒绝", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const now = new Date();
  const externalMediaId = await insertTestImageAssetMedia(fixture, now, { source: "external-test" });
  const externalMedia = (await fixture.handle.db.select().from(assetMedia)
    .where(eq(assetMedia.id, externalMediaId)).limit(1))[0]!;
  await fixture.handle.db.insert(mediaProvenanceSubjects).values({
    assetMediaId: externalMediaId,
    mediaResultId: null,
    sourceChannel: "external_upload",
    sourceGenerationAttemptId: null,
    providerAssetId: null,
    observedAt: now,
  });
  const staleRegistrationId = randomUUID();
  const staleRemoteAssetId = `Asset-stale-active-${randomUUID()}`;
  const staleVerifiedAt = new Date(now.getTime() - SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS - 1_000);
  await fixture.handle.db.insert(seedanceAssetRegistrations).values({
    id: staleRegistrationId,
    assetMediaId: externalMediaId,
    sourceMediaResultId: null,
    assetGroupId: "s49-stale-active",
    projectName: "shortdrama-dev",
    remoteAssetId: staleRemoteAssetId,
    status: "active",
    createdByUserId: fixture.actorId,
    lastActionByUserId: fixture.actorId,
    createdAt: staleVerifiedAt,
    updatedAt: staleVerifiedAt,
    lastActionAt: staleVerifiedAt,
    activatedAt: staleVerifiedAt,
    authorizationExpiresAt: null,
    lastVerifiedAt: staleVerifiedAt,
  });
  const pricingRuleId = randomUUID();
  await fixture.handle.db.insert(pricingRules).values({
    id: pricingRuleId,
    provider: "ark",
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
    currency: "CNY",
    source: "s49-provenance-test",
    active: true,
    effectiveFrom: new Date(now.getTime() - 60_000),
    effectiveTo: null,
    metadata: {
      price_source_kind: "实测",
      capability_tier: {
        tier_id: "vid-seedance20fast-916-720p-4s",
        params: {
          aspect_ratio: "9:16",
          resolution: "720p",
          duration_seconds: 4,
          quantity: 1,
          watermark: false,
        },
        status: "active",
      },
    },
    createdAt: now,
    updatedAt: now,
  });
  const request = normalizeGenerationInput({
    projectId: fixture.projectId,
    episodeId: fixture.episodeId,
    shotId: fixture.shotId,
    mediaKind: "video",
    model: "doubao-seedance-2-0-fast-260128",
    tierId: "vid-seedance20fast-916-720p-4s",
    prompt: "外来参考图不得回退 TOS",
    referenceMediaIds: [externalMediaId],
    referenceAssetSnapshots: [{
      kind: "image",
      mediaId: externalMediaId,
      url: externalMedia.storageUrl!,
      role: "reference_image",
    }],
    parameters: {
      resolution: "720p",
      ratio: "9:16",
      durationSeconds: 4,
      watermark: false,
      generateAudio: true,
    },
    quantity: 1,
    clientIdempotencyKey: `s49-external-${randomUUID()}`,
  });
  const requestHash = hashGenerationRequest(request);
  const repository = new PostgresGenerationRepository(fixture.handle.db, 1_000);
  await assert.rejects(
    () => repository.createSubmissionQuote({
      actorId: fixture.actorId,
      authorizedProjectId: fixture.projectId,
      source: "web",
      requestHash,
      request,
      ttlSeconds: 300,
    }),
    isSeedanceAdmissionFailure,
  );

  const quoteId = randomUUID();
  const { clientIdempotencyKey: _clientIdempotencyKey, ...normalizedRequest } = request;
  const priceSnapshot = {
    tierId: "vid-seedance20fast-916-720p-4s",
    pricingRuleId,
    provider: "ark",
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video",
    billingUnit: "second",
    unitPriceFen: 80,
    billableUnits: 4,
    estimatedCostFen: 320,
    currency: "CNY",
  };
  await fixture.handle.db.insert(generationQuotes).values({
    id: quoteId,
    userId: fixture.actorId,
    source: "web",
    action: "submit",
    assistantSessionId: null,
    originalRequestId: null,
    baseAttemptId: null,
    baseAttemptNo: null,
    requestHash,
    normalizedRequest,
    pricingRuleId,
    priceSnapshot,
    estimatedCostFen: 320,
    status: "pending_confirmation",
    expiresAt: new Date(now.getTime() + 300_000),
    confirmedAt: null,
    consumedAt: null,
    generationRequestId: null,
    generationAttemptId: null,
    createdAt: now,
    updatedAt: now,
  });
  const batch = {
    projectId: fixture.projectId,
    clientIdempotencyKey: `s49-batch-${randomUUID()}`,
    expectedTotalEstimatedCostFen: 320,
    items: [{ itemId: "external-reference", quoteId }],
  };
  const batchAuthorization = await repository.createBatchAuthorization({
    actorId: fixture.actorId,
    authorizedProjectId: fixture.projectId,
    source: "web",
    batch,
    listHash: hashGenerationBatch(batch),
  });
  assert.equal(batchAuthorization.status, "confirmed");
  const batchOutcome = await repository.submitBatchAuthorization({
    actorId: fixture.actorId,
    authorizedProjectId: fixture.projectId,
    source: "web",
    authorizationId: batchAuthorization.authorizationId,
    budgetLimitFen: 50_000,
  });
  assert.equal(batchOutcome.items[0]?.status, "failed");
  assert.equal(batchOutcome.items[0]?.error?.code, "control_asset_invalid_usage");

  await fixture.handle.db.update(generationQuotes).set({
    status: "confirmed",
    confirmedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(generationQuotes.id, quoteId));
  await assert.rejects(
    () => repository.createSubmission({
      actorId: fixture.actorId,
      authorizedProjectId: fixture.projectId,
      source: "web",
      quoteId,
      requestHash,
      request,
      budgetLimitFen: 50_000,
    }),
    isSeedanceAdmissionFailure,
  );

  const workerRequestId = randomUUID();
  const workerAttemptId = randomUUID();
  await fixture.handle.db.insert(generationRequests).values({
    id: workerRequestId,
    userId: fixture.actorId,
    projectId: fixture.projectId,
    episodeId: fixture.episodeId,
    sceneId: null,
    shotId: fixture.shotId,
    targetAssetEntityId: null,
    mediaKind: "video",
    prompt: request.prompt,
    referenceMediaIds: request.referenceMediaIds,
    referenceAssetSnapshots: request.referenceAssetSnapshots
      .map((snapshot) => ({ ...snapshot }) as Record<string, unknown>),
    parameters: request.parameters,
    quantity: 1,
    clientIdempotencyKey: `s49-worker-${randomUUID()}`,
    requestHash,
    createdAt: now,
    updatedAt: now,
  });
  await fixture.handle.db.insert(generationAttempts).values({
    id: workerAttemptId,
    requestId: workerRequestId,
    attemptNo: 1,
    retryIdempotencyKey: null,
    provider: "ark",
    providerTaskId: null,
    model: "doubao-seedance-2-0-fast-260128",
    parameters: request.parameters,
    quantity: 1,
    status: "pending",
    phase: "created",
    providerStatus: null,
    providerResponse: null,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    estimatedCostFen: 320,
    actualCostFen: null,
    actualCostStatus: "unavailable",
    pricingRuleId,
    priceSnapshot,
    lastQueryError: null,
    nextPollAt: now,
    lastPolledAt: null,
    leaseOwner: null,
    leaseUntil: null,
    submittedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await assert.rejects(() => repository.markSubmitting(workerAttemptId), isSeedanceAdmissionFailure);
  const workerAttempt = (await fixture.handle.db.select({
    status: generationAttempts.status,
    phase: generationAttempts.phase,
  }).from(generationAttempts).where(eq(generationAttempts.id, workerAttemptId)).limit(1))[0];
  assert.deepEqual(workerAttempt, { status: "pending", phase: "created" });

  // Retry has its own quote and submit path.  Mark the fixture terminal so
  // the retry state guard permits reaching the S49 admission re-check.
  await fixture.handle.db.update(generationAttempts).set({
    status: "failed",
    phase: "complete",
    errorCode: "S49_TEST_FAILED",
    errorMessage: "retry gate fixture",
    finishedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(generationAttempts.id, workerAttemptId));
  await assert.rejects(
    () => repository.createRetryQuote({
      actorId: fixture.actorId,
      authorizedProjectId: fixture.projectId,
      source: "web",
      requestId: workerRequestId,
      ttlSeconds: 300,
    }),
    isSeedanceAdmissionFailure,
  );
  const retryQuoteId = randomUUID();
  await fixture.handle.db.insert(generationQuotes).values({
    id: retryQuoteId,
    userId: fixture.actorId,
    source: "web",
    action: "retry",
    assistantSessionId: null,
    originalRequestId: workerRequestId,
    baseAttemptId: workerAttemptId,
    baseAttemptNo: 1,
    requestHash,
    normalizedRequest,
    pricingRuleId,
    priceSnapshot,
    estimatedCostFen: 320,
    status: "confirmed",
    expiresAt: new Date(now.getTime() + 300_000),
    confirmedAt: new Date(),
    confirmedByUserId: fixture.actorId,
    consumedAt: null,
    generationRequestId: null,
    generationAttemptId: null,
    createdAt: now,
    updatedAt: now,
  });
  await assert.rejects(
    () => repository.createRetry({
      actorId: fixture.actorId,
      authorizedProjectId: fixture.projectId,
      source: "web",
      requestId: workerRequestId,
      quoteId: retryQuoteId,
      clientIdempotencyKey: `s49-retry-${randomUUID()}`,
      budgetLimitFen: 50_000,
    }),
    isSeedanceAdmissionFailure,
  );
  assert.equal(
    (await fixture.handle.db.select().from(generationRequests)
      .where(eq(generationRequests.clientIdempotencyKey, request.clientIdempotencyKey))).length,
    0,
  );

  // A fresh GetAsset observation restores only the registration channel.
  // Ordinary references must then use the exact formal asset:// identity.
  await fixture.handle.db.update(seedanceAssetRegistrations).set({
    lastVerifiedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(seedanceAssetRegistrations.id, staleRegistrationId));
  const refreshedRequest = normalizeGenerationInput({
    ...request,
    referenceAssetSnapshots: [{
      kind: "image",
      mediaId: externalMediaId,
      url: `asset://${staleRemoteAssetId}`,
      role: "reference_image",
    }],
    clientIdempotencyKey: `s49-refreshed-${randomUUID()}`,
  });
  const refreshedQuote = await repository.createSubmissionQuote({
    actorId: fixture.actorId,
    authorizedProjectId: fixture.projectId,
    source: "web",
    requestHash: hashGenerationRequest(refreshedRequest),
    request: refreshedRequest,
    ttlSeconds: 300,
  });
  assert.equal(refreshedQuote.status, "pending_confirmation");
}));

test("CreateAsset 准入按精确媒体版本分类，过旧核验可由人工刷新恢复", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  const now = new Date();
  const exactMediaId = await insertTestImageAssetMedia(fixture, now, { source: "admission-exact" });
  const exactMedia = (await fixture.handle.db.select({
    assetEntityId: assetMedia.assetEntityId,
  }).from(assetMedia).where(eq(assetMedia.id, exactMediaId)).limit(1))[0]!;
  const exactRegistrationId = randomUUID();
  const remoteAssetId = `Asset-admission-${randomUUID()}`;
  await fixture.handle.db.insert(seedanceAssetRegistrations).values({
    id: exactRegistrationId,
    assetMediaId: exactMediaId,
    sourceMediaResultId: null,
    assetGroupId: "s49-admission",
    projectName: "shortdrama-dev",
    remoteAssetId,
    status: "active",
    createdByUserId: fixture.actorId,
    lastActionByUserId: fixture.actorId,
    createdAt: now,
    updatedAt: now,
    lastActionAt: now,
    activatedAt: now,
    authorizationExpiresAt: null,
    lastVerifiedAt: now,
  });
  const repository = new PostgresGenerationRepository(fixture.handle.db, 1_000);
  const resolve = () => repository.resolveControlReferenceSnapshots(
    fixture.actorId,
    "video",
    { referenceMediaIds: [exactMediaId] },
    { useRegisteredSeedanceAssetUris: true, authorizedProjectId: fixture.projectId },
  );
  assert.equal((await resolve())[0]?.url, `asset://${remoteAssetId}`);

  const staleVerifiedAt = new Date(Date.now() - SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS - 1_000);
  await fixture.handle.db.update(seedanceAssetRegistrations).set({
    lastVerifiedAt: staleVerifiedAt,
    updatedAt: new Date(),
  }).where(eq(seedanceAssetRegistrations.id, exactRegistrationId));
  await assert.rejects(resolve, (error: unknown) => error instanceof GenerationError
    && error.code === "control_asset_invalid_usage"
    && /登记核验已过期，请刷新登记/.test(error.message));

  const registrationRepository = new SeedanceAssetRegistrationRepository(fixture.handle.db);
  await registrationRepository.recordAssetStatus(exactRegistrationId, fixture.actorId, {
    status: "Active",
    requestId: "s49-admission-refresh",
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
  });
  assert.equal((await resolve())[0]?.url, `asset://${remoteAssetId}`);

  await fixture.handle.db.update(seedanceAssetRegistrations).set({
    authorizationExpiresAt: new Date(Date.now() - 1_000),
    updatedAt: new Date(),
  }).where(eq(seedanceAssetRegistrations.id, exactRegistrationId));
  await assert.rejects(resolve, (error: unknown) => error instanceof GenerationError
    && error.code === "control_asset_invalid_usage"
    && /登记授权已过期，请重新登记或联系管理员协助/.test(error.message));

  const siblingMediaId = randomUUID();
  await fixture.handle.db.insert(assetMedia).values({
    id: siblingMediaId,
    assetEntityId: exactMedia.assetEntityId,
    assetVariantId: null,
    mediaKind: "image",
    viewAngle: "unknown",
    title: "同实体已登记版本",
    description: null,
    storageBucket: "s49-test",
    storagePath: `admission/${siblingMediaId}.png`,
    storageUrl: `https://assets.example.test/admission/${siblingMediaId}.png`,
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: siblingMediaId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    isPrimary: false,
    approved: true,
    sortOrder: 1,
    metadata: {},
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  });
  await fixture.handle.db.update(seedanceAssetRegistrations).set({
    status: "processing",
    activatedAt: null,
    updatedAt: new Date(),
  }).where(eq(seedanceAssetRegistrations.id, exactRegistrationId));
  await fixture.handle.db.insert(seedanceAssetRegistrations).values({
    id: randomUUID(),
    assetMediaId: siblingMediaId,
    sourceMediaResultId: null,
    assetGroupId: "s49-admission",
    projectName: "shortdrama-dev",
    remoteAssetId: `Asset-sibling-${randomUUID()}`,
    status: "active",
    createdByUserId: fixture.actorId,
    lastActionByUserId: fixture.actorId,
    createdAt: now,
    updatedAt: now,
    lastActionAt: now,
    activatedAt: now,
    authorizationExpiresAt: null,
    lastVerifiedAt: new Date(),
  });
  await assert.rejects(resolve, (error: unknown) => error instanceof GenerationError
    && error.code === "control_asset_invalid_usage"
    && /当前选中的图片版本尚未登记，请选择已登记的版本或登记当前版本/.test(error.message));

  await fixture.handle.db.update(assetMedia).set({ deletedAt: new Date(), deletedByUserId: fixture.actorId })
    .where(eq(assetMedia.id, siblingMediaId));
  await assert.rejects(resolve, (error: unknown) => error instanceof GenerationError
    && error.code === "control_asset_invalid_usage"
    && /请先点击“转为参考资产”/.test(error.message));

  await fixture.handle.db.update(seedanceAssetRegistrations).set({
    status: "active",
    activatedAt: new Date(),
    authorizationExpiresAt: null,
    lastVerifiedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(seedanceAssetRegistrations.id, exactRegistrationId));
  await fixture.handle.db.insert(mediaProvenanceSubjects).values({
    assetMediaId: exactMediaId,
    mediaResultId: null,
    sourceChannel: "provider_library",
    sourceGenerationAttemptId: null,
    providerAssetId: `Asset-provider-mismatch-${randomUUID()}`,
    observedAt: new Date(),
  });
  await assert.rejects(resolve, (error: unknown) => error instanceof GenerationError
    && error.code === "control_asset_invalid_usage"
    && /登记已失效或远端素材编号已变化，请刷新后重新提交/.test(error.message));

  const unregisteredMediaId = await insertTestImageAssetMedia(fixture, now, { source: "admission-unregistered" });
  await assert.rejects(
    () => repository.resolveControlReferenceSnapshots(
      fixture.actorId,
      "video",
      { referenceMediaIds: [unregisteredMediaId] },
      { useRegisteredSeedanceAssetUris: true, authorizedProjectId: fixture.projectId },
    ),
    (error: unknown) => error instanceof GenerationError
      && error.code === "control_asset_invalid_usage"
      && /请先点击“转为参考资产”/.test(error.message),
  );
}));

interface Fixture {
  handle: DatabaseHandle;
  actorId: string;
  projectId: string;
  episodeId: string;
  shotId: string;
  generationRequestId: string;
  generationAttemptId: string;
  mediaResultId: string;
  extraUserIds: string[];
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const testSchema = assertSafeDisposableTestDatabase();
  const handle = createDatabase(databaseUrl);
  const lockClient = await handle.pool.connect();
  let lockAcquired = false;
  const actorId = randomUUID();
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const shotId = randomUUID();
  const generationRequestId = randomUUID();
  const generationAttemptId = randomUUID();
  const mediaResultId = randomUUID();
  const now = new Date("2026-07-23T00:00:00.000Z");
  const fixture = {
    handle,
    actorId,
    projectId,
    episodeId,
    shotId,
    generationRequestId,
    generationAttemptId,
    mediaResultId,
    extraUserIds: [],
  };
  try {
    await lockClient.query("SELECT pg_advisory_lock($1, hashtext($2))", [
      disposableSchemaLockNamespace,
      settings.postgresSchema,
    ]);
    lockAcquired = true;
    await resetDisposableTestSchema(handle, testSchema);
    await handle.db.insert(users).values({
      id: actorId, username: `seedance-${actorId.slice(0, 8)}`, displayName: "Seedance Test",
      passwordHash: "test-only-hash", active: true, createdAt: now, updatedAt: now,
    });
    await handle.db.insert(projects).values({
      id: projectId, ownerUserId: actorId, name: "Seedance Registration Test", description: null,
      status: "active", createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(episodes).values({
      id: episodeId, projectId, episodeNo: 1, name: "第一集", sortOrder: 0,
      status: "active", createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(shots).values({
      id: shotId, episodeId, sceneId: null, shotCode: "REG-01", title: "登记测试分镜",
      scriptText: null, directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: null,
      sortOrder: 0, referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null,
      createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(generationRequests).values({
      id: generationRequestId,
      userId: actorId,
      projectId,
      episodeId,
      sceneId: null,
      shotId,
      targetAssetEntityId: null,
      mediaKind: "image",
      prompt: "用于登记验证的已生成参考图",
      referenceMediaIds: [],
      referenceAssetSnapshots: [],
      parameters: {},
      quantity: 1,
      clientIdempotencyKey: `seedance-registration-${generationRequestId}`,
      requestHash: generationRequestId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(generationAttempts).values({
      id: generationAttemptId,
      requestId: generationRequestId,
      attemptNo: 1,
      retryIdempotencyKey: null,
      provider: "ark",
      providerTaskId: `seedance-registration-${generationAttemptId}`,
      model: "doubao-seedance-2-0-fast-260128",
      parameters: {},
      quantity: 1,
      status: "succeeded",
      phase: "complete",
      providerStatus: "Success",
      providerResponse: {},
      errorCode: null,
      errorMessage: null,
      retryable: false,
      estimatedCostFen: 0,
      actualCostFen: null,
      actualCostStatus: "unavailable",
      pricingRuleId: null,
      priceSnapshot: {},
      lastQueryError: null,
      nextPollAt: null,
      lastPolledAt: null,
      leaseOwner: null,
      leaseUntil: null,
      submittedAt: now,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(mediaResults).values({
      id: mediaResultId, requestId: generationRequestId, attemptId: generationAttemptId, shotId, originKind: "generation",
      sourceAssetMediaId: null, registeredByUserId: null, mediaKind: "image", resultIndex: 0,
      providerResultKey: `result-${mediaResultId}`, providerUrl: null, providerUrlExpiresAt: null, persistenceStatus: "persisted",
      storageBucket: "seedance-test", storagePath: `results/${mediaResultId}.png`,
      storageUrl: `https://assets.example.test/results/${mediaResultId}.png`,
      sha256: mediaResultId.replaceAll("-", "").padEnd(64, "0").slice(0, 64), mimeType: "image/png",
      widthPx: 1024, heightPx: 1024, durationSeconds: null, reviewStatus: "needs_review",
      createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await run(fixture);
  } finally {
    try {
      if (lockAcquired) await lockClient.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
    } finally {
      try {
        if (lockAcquired) {
          await lockClient.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
            disposableSchemaLockNamespace,
            settings.postgresSchema,
          ]);
        }
      } finally {
        lockClient.release();
        await handle.pool.end();
      }
    }
  }
}

function assertSafeDisposableTestDatabase(): string {
  assert.ok(databaseUrl, "SEEDANCE_ASSET_REGISTRATION_TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  assert.ok(
    url.protocol === "postgres:" || url.protocol === "postgresql:",
    "SEEDANCE_ASSET_REGISTRATION_TEST_DATABASE_URL must be a PostgreSQL URL",
  );
  assert.ok(
    localPostgresHosts.has(url.hostname.toLowerCase()),
    "SEEDANCE_ASSET_REGISTRATION_TEST_DATABASE_URL must target localhost, 127.0.0.1, or ::1",
  );
  const configuredSchema = process.env.POSTGRES_SCHEMA;
  assert.ok(configuredSchema, "POSTGRES_SCHEMA must explicitly name an S49 disposable test schema");
  assert.equal(configuredSchema, settings.postgresSchema, "POSTGRES_SCHEMA must be read before this test starts");
  assert.ok(safeSchemaName.test(configuredSchema), "POSTGRES_SCHEMA must be a safe PostgreSQL identifier");
  assert.ok(
    configuredSchema.startsWith(disposableSchemaPrefix),
    `POSTGRES_SCHEMA must start with ${disposableSchemaPrefix}`,
  );
  return quoteIdentifier(configuredSchema);
}

async function resetDisposableTestSchema(handle: DatabaseHandle, testSchema: string): Promise<void> {
  await handle.pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
  await handle.pool.query(`CREATE SCHEMA ${testSchema}`);
  await runMigrations(handle);
}

async function insertTestImageAssetMedia(
  fixture: Fixture,
  now: Date,
  metadata: Record<string, unknown>,
): Promise<string> {
  const entityId = randomUUID();
  const mediaId = randomUUID();
  await fixture.handle.db.insert(assetEntities).values({
    id: entityId,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId: fixture.actorId,
    visibility: "personal",
    assetKind: "reference",
    role: null,
    usageMode: "reference",
    name: `S49 provenance ${entityId.slice(0, 8)}`,
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
    approved: true,
    reuseScope: "all_projects",
    status: "active",
    sourceFileUrl: null,
    metadata,
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
  });
  await fixture.handle.db.insert(assetMedia).values({
    id: mediaId,
    assetEntityId: entityId,
    assetVariantId: null,
    mediaKind: "image",
    viewAngle: "unknown",
    title: `S49 provenance ${mediaId.slice(0, 8)}`,
    description: null,
    storageBucket: "s49-test",
    storagePath: `provenance/${mediaId}.png`,
    storageUrl: `https://assets.example.test/provenance/${mediaId}.png`,
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: mediaId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata,
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  });
  return mediaId;
}

async function insertTestImageResult(fixture: Fixture, now: Date, resultIndex: number): Promise<string> {
  const id = randomUUID();
  await fixture.handle.db.insert(mediaResults).values({
    id,
    requestId: fixture.generationRequestId,
    attemptId: fixture.generationAttemptId,
    shotId: fixture.shotId,
    originKind: "generation",
    sourceAssetMediaId: null,
    registeredByUserId: null,
    mediaKind: "image",
    resultIndex,
    providerResultKey: `s49-provenance-${id}`,
    providerUrl: null,
    providerUrlExpiresAt: null,
    persistenceStatus: "persisted",
    storageBucket: "s49-test",
    storagePath: `provenance/results/${id}.png`,
    storageUrl: `https://assets.example.test/provenance/results/${id}.png`,
    sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    mimeType: "image/png",
    widthPx: 1024,
    heightPx: 1024,
    durationSeconds: null,
    reviewStatus: "needs_review",
    complianceMetadata: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  });
  return id;
}

async function containsExternalImageAncestor(fixture: Fixture, subjectId: number): Promise<boolean> {
  const row = (await fixture.handle.db.select({
    containsExternalImageAncestor: mediaProvenanceAuthority.containsExternalImageAncestor,
  }).from(mediaProvenanceAuthority).where(eq(mediaProvenanceAuthority.id, subjectId)).limit(1))[0];
  assert.ok(row);
  return row.containsExternalImageAncestor;
}

function userFixture(
  id: string,
  suffix: string,
  now: Date,
  role: "admin" | "member",
) {
  return {
    id,
    username: `seedance-${suffix}-${id.slice(0, 8)}`,
    displayName: `Seedance ${suffix}`,
    passwordHash: "test-only-hash",
    active: true,
    role,
    createdAt: now,
    updatedAt: now,
  };
}

function isStatus(expected: number) {
  return (error: unknown) => error instanceof AppError && error.statusCode === expected;
}

function isSeedanceAdmissionFailure(error: unknown): boolean {
  return error instanceof GenerationError
    && error.code === "control_asset_invalid_usage"
    && /缺少当前可用 CreateAsset 登记|禁止回退 TOS|登记核验已过期|未完成视频生成所需的素材登记/.test(error.message);
}

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (pattern.test(current.message)) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
