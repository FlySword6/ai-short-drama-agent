import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import {
  assetEntities,
  assetMedia,
  episodes,
  generationAttempts,
  generationRequests,
  mediaResults,
  pricingRules,
  projects,
  shots,
  users,
} from "../src/db/schema.js";
import { DashboardService } from "../src/modules/dashboard/service.js";
import { AssetCatalogService } from "../src/modules/assets/catalog.js";
import { DrizzleDashboardRepository } from "../src/modules/dashboard/repository.js";
import { DeliveryService } from "../src/modules/delivery/service.js";
import { DrizzleDeliveryRepository } from "../src/modules/delivery/repository.js";
import { ProjectAssetRepository } from "../src/modules/project-assets/repository.js";
import { ShotMediaRepository } from "../src/modules/shot-media/repository.js";
import { DrizzleStoryboardImportRepository } from "../src/modules/storyboard/repository.js";
import { TrashService } from "../src/modules/trash/service.js";
import {
  DrizzleTrashRepository,
  type TrashExternalCleaner,
} from "../src/modules/trash/repository.js";
import type { StoryboardPreview } from "../src/modules/storyboard/types.js";

const databaseUrl = process.env.OPS_TEST_DATABASE_URL;

test("V0.1 业务接线在新 PostgreSQL 上闭环", { skip: !databaseUrl }, async () => {
  const handle = createDatabase(databaseUrl);
  const { db } = handle;
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    emptyProject: randomUUID(),
    orphanAsset: randomUUID(),
    failedPurgeAsset: randomUUID(),
    pricing: randomUUID(),
    request: randomUUID(),
    attempt: randomUUID(),
    media: randomUUID(),
  };
  const now = new Date();

  try {
    await db.insert(users).values({
      id: ids.user,
      username: `ops-${ids.user.slice(0, 8)}`,
      displayName: "制作同事",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projects).values({
      id: ids.project,
      ownerUserId: ids.user,
      name: "真实接线测试",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });

    const preview: StoryboardPreview = {
      rows: [{
        sourceSheet: "分镜表",
        sourceRow: 2,
        episodeNo: 1,
        sceneName: "院子",
        shotCode: "G01",
        sortOrder: 1,
        screenDescription: "角色走进院子",
        cameraMovement: "跟拍",
        shotSizeAngle: "中景",
        dialogue: null,
        soundEffect: null,
        referenceImageNote: null,
        storyboardImageNote: null,
        rawFields: {},
      }],
      issues: [],
      episodeCount: 1,
      sceneCount: 1,
      shotCount: 1,
      canConfirm: true,
    };
    const storyboardRepository = new DrizzleStoryboardImportRepository(db, "a".repeat(64));
    const importRecord = await storyboardRepository.createPreview({
      projectId: ids.project,
      uploadedBy: ids.user,
      fileName: "storyboard.xlsx",
      preview,
    });
    const confirmedImport = await storyboardRepository.confirm({
      importId: importRecord.id,
      projectId: ids.project,
      actorId: ids.user,
      rows: preview.rows,
    });
    const repeatedConfirmation = await storyboardRepository.confirm({
      importId: importRecord.id,
      projectId: ids.project,
      actorId: ids.user,
      rows: preview.rows,
    });
    assert.ok(confirmedImport.confirmationResult);
    assert.deepEqual(repeatedConfirmation.confirmationResult, confirmedImport.confirmationResult);
    const shotRows = await db.select().from(shots);
    assert.equal(shotRows.length, 1, "重复确认不应重复创建分镜");
    const shot = shotRows[0];
    assert.ok(shot);

    const assetId = randomUUID();
    await db.insert(assetEntities).values(assetValues(assetId, ids.user, null));
    const assetMediaA = randomUUID();
    const assetMediaB = randomUUID();
    await db.insert(assetMedia).values([
      assetMediaValues(assetMediaA, assetId, true, 0),
      assetMediaValues(assetMediaB, assetId, false, 1),
    ]);
    const assetCatalog = new AssetCatalogService(db);
    const personalAssets = await assetCatalog.list(ids.user, { scope: "personal" });
    assert.equal(personalAssets.length, 1);
    assert.equal(personalAssets[0]?.storageUrl, `https://storage.example/${assetMediaA}.png`);
    assert.equal((await assetCatalog.versions(ids.user, assetId)).length, 2);
    await assetCatalog.setPrimary(ids.user, assetId, assetMediaB);
    assert.equal((await assetCatalog.get(ids.user, assetId)).storageUrl, `https://storage.example/${assetMediaB}.png`);
    const updatedAsset = await assetCatalog.update(ids.user, assetId, { displayName: "已更新资产" });
    assert.equal(updatedAsset.displayName, "已更新资产");
    const projectAssets = new ProjectAssetRepository(db);
    const firstReference = await projectAssets.add(ids.user, ids.project, { assetEntityId: assetId });
    const repeatedReference = await projectAssets.add(ids.user, ids.project, { assetEntityId: assetId });
    assert.equal(repeatedReference.id, firstReference.id, "重复引用应幂等");
    assert.equal((await projectAssets.list(ids.user, ids.project)).length, 1);

    const [episode] = await db.select().from(episodes).where(eq(episodes.projectId, ids.project));
    assert.ok(episode);
    await db.insert(pricingRules).values({
      id: ids.pricing,
      provider: "ark",
      model: "seedance-test",
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 100,
      currency: "CNY",
      source: "integration-test",
      active: true,
      effectiveFrom: now,
      effectiveTo: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(generationRequests).values({
      id: ids.request,
      userId: ids.user,
      projectId: ids.project,
      episodeId: episode.id,
      sceneId: shot.sceneId,
      shotId: shot.id,
      targetAssetEntityId: null,
      mediaKind: "video",
      prompt: "角色走进院子",
      referenceMediaIds: [],
      referenceAssetSnapshots: [],
      parameters: { duration_seconds: 3 },
      quantity: 1,
      clientIdempotencyKey: randomUUID(),
      requestHash: "b".repeat(64),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(generationAttempts).values({
      id: ids.attempt,
      requestId: ids.request,
      attemptNo: 1,
      provider: "ark",
      providerTaskId: "provider-test-1",
      model: "seedance-test",
      parameters: { duration_seconds: 3 },
      quantity: 1,
      status: "succeeded",
      phase: "complete",
      providerStatus: "succeeded",
      providerResponse: {},
      errorCode: null,
      errorMessage: null,
      retryable: false,
      estimatedCostFen: 300,
      actualCostFen: null,
      actualCostStatus: "unavailable",
      pricingRuleId: ids.pricing,
      priceSnapshot: { unit_price_fen: 100 },
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
    });
    await db.insert(mediaResults).values({
      id: ids.media,
      requestId: ids.request,
      attemptId: ids.attempt,
      shotId: shot.id,
      originKind: "generation",
      sourceAssetMediaId: null,
      registeredByUserId: null,
      mediaKind: "video",
      resultIndex: 0,
      providerResultKey: "provider-result-1",
      providerUrl: null,
      providerUrlExpiresAt: null,
      persistenceStatus: "persisted",
      storageBucket: "test-bucket",
      storagePath: "projects/test/video.mp4",
      storageUrl: "https://storage.example/video.mp4",
      sha256: "c".repeat(64),
      mimeType: "video/mp4",
      widthPx: 1920,
      heightPx: 1080,
      durationSeconds: 3,
      reviewStatus: "accepted",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });

    const selected = await new ShotMediaRepository(db).setPrimary(ids.user, shot.id, ids.media);
    assert.equal(selected.mediaKind, "video");
    const manifest = await new DeliveryService(new DrizzleDeliveryRepository(db)).getManifest(ids.user, episode.id, now);
    assert.equal(manifest.items[0]?.mediaId, ids.media);
    assert.equal(manifest.estimatedCostFen, 300);

    const dashboardRepository = new DrizzleDashboardRepository(db);
    const dashboard = await new DashboardService(dashboardRepository).getSummary(ids.user);
    assert.equal(dashboard.data.shots, 1);
    assert.equal(dashboard.data.videos, 1);
    assert.equal(dashboard.costs.totalEstimatedCostFen, 300);
    const replacementPrice = await dashboardRepository.replaceUnitPrice(ids.user, {
      provider: "ark",
      model: "seedance-test",
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 125,
      currency: "CNY",
      effectiveFrom: new Date(now.getTime() + 1_000),
    });
    assert.equal(replacementPrice.unitPriceFen, 125);
    assert.equal((await dashboardRepository.listUnitPrices()).length, 1);

    await db.update(projects).set({ deletedAt: now, deletedByUserId: ids.user }).where(eq(projects.id, ids.project));
    const cleanerCalls: string[] = [];
    const cleaner: TrashExternalCleaner = {
      deleteStoragePath: async (path) => { cleanerCalls.push(`storage:${path}`); },
      deleteVectorIds: async (values) => { cleanerCalls.push(`vectors:${values.join(",")}`); },
    };
    const trashRepository = new DrizzleTrashRepository(db, cleaner);
    const blocked = await trashRepository.checkPermanentDeletion("project", ids.project);
    assert.match(blocked.blockers.join(";"), /生成和费用历史/);
    await db.update(projects).set({ deletedAt: null, deletedByUserId: null }).where(eq(projects.id, ids.project));

    await db.insert(projects).values({
      id: ids.emptyProject,
      ownerUserId: ids.user,
      name: "可永久删除空项目",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
      deletedByUserId: ids.user,
    });
    await new TrashService(trashRepository).permanentlyDelete({
      actorId: ids.user,
      kind: "project",
      id: ids.emptyProject,
    });
    assert.equal((await db.select().from(projects).where(eq(projects.id, ids.emptyProject))).length, 0);

    await db.insert(assetEntities).values(assetValues(ids.orphanAsset, ids.user, null));
    const orphanReference = await projectAssets.add(ids.user, ids.project, { assetEntityId: ids.orphanAsset });
    await projectAssets.remove(ids.user, ids.project, orphanReference.id);
    await db.update(assetEntities).set({ deletedAt: now, deletedByUserId: ids.user })
      .where(eq(assetEntities.id, ids.orphanAsset));
    await new TrashService(trashRepository).permanentlyDelete({
      actorId: ids.user,
      kind: "asset",
      id: ids.orphanAsset,
    });
    assert.equal((await db.select().from(assetEntities).where(eq(assetEntities.id, ids.orphanAsset))).length, 0);
    assert.equal(cleanerCalls.some((value) => value.includes(ids.orphanAsset)), true);

    await db.insert(assetEntities).values(assetValues(ids.failedPurgeAsset, ids.user, now));
    const failedCleaner: TrashExternalCleaner = {
      deleteStoragePath: async () => undefined,
      deleteVectorIds: async () => { throw new Error("向量删除暂时失败"); },
    };
    const failedPurge = new TrashService(new DrizzleTrashRepository(db, failedCleaner));
    await assert.rejects(failedPurge.permanentlyDelete({
      actorId: ids.user,
      kind: "asset",
      id: ids.failedPurgeAsset,
    }), /向量删除暂时失败/);
    const [failedAsset] = await db.select({ status: assetEntities.status }).from(assetEntities)
      .where(eq(assetEntities.id, ids.failedPurgeAsset));
    assert.equal(failedAsset?.status, "purging");
    await assert.rejects(failedPurge.restore({
      actorId: ids.user,
      kind: "asset",
      id: ids.failedPurgeAsset,
    }), /只能重试永久删除/);

    await projectAssets.remove(ids.user, ids.project, firstReference.id);
    assert.equal((await db.select().from(projects).where(and(eq(projects.id, ids.project), eq(projects.ownerUserId, ids.user)))).length, 1);
  } finally {
    await handle.pool.end();
  }
});

function assetValues(id: string, ownerUserId: string, deletedAt: Date | null) {
  const now = new Date();
  return {
    id,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId,
    visibility: "personal",
    assetKind: "character",
    name: `资产-${id.slice(0, 8)}`,
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
    status: "approved",
    sourceFileUrl: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    deletedAt,
    deletedByUserId: deletedAt ? ownerUserId : null,
  };
}

function assetMediaValues(id: string, assetEntityId: string, isPrimary: boolean, sortOrder: number) {
  return {
    id,
    assetEntityId,
    assetVariantId: null,
    mediaKind: "image",
    viewAngle: "front",
    title: `版本-${sortOrder + 1}`,
    description: null,
    storageBucket: "test-bucket",
    storagePath: `assets/${id}.png`,
    storageUrl: `https://storage.example/${id}.png`,
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    isPrimary,
    approved: true,
    sortOrder,
    metadata: {},
    createdAt: new Date(),
    deletedAt: null,
    deletedByUserId: null,
  };
}
