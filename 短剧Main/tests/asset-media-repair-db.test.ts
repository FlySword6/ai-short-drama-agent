import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createDatabase } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  assetEntities,
  assetMedia,
  assetMediaRenditions,
  assetMediaRepairActions,
  assetMediaRepairTasks,
  assetVariants,
  users,
} from "../src/db/schema.js";
import { PostgresAssetMediaRepairRepository } from "../src/modules/assets/mediaRepairRepository.js";
import { AssetMediaRepairService } from "../src/modules/assets/mediaRepairService.js";
import {
  applyDirectorPreviewImportPlan,
  type DirectorPreviewImportPlan,
} from "../src/modules/assets/directorPreviewImport.js";
import type { AssetMediaStoragePort } from "../src/modules/assets/mediaRepairTypes.js";
import {
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from "../src/shared/errors.js";

const databaseUrl = process.env.ASSET_MEDIA_REPAIR_TEST_DATABASE_URL;

test("052 真 PostgreSQL：迁移重放、幂等任务、图片自愈和 append-only 审计闭环", {
  skip: !databaseUrl,
}, async () => {
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const assetId = randomUUID();
  const mediaId = randomUUID();
  const conflictingAssetId = randomUUID();
  const conflictingVariantOwnerId = randomUUID();
  const conflictingVariantId = randomUUID();
  const conflictingMediaId = randomUUID();
  const idempotencyKey = randomUUID();
  const now = new Date();
  const source = await sharp({
    create: { width: 640, height: 360, channels: 3, background: "#735b47" },
  }).png().toBuffer();
  const thumbnail = await sharp(source).resize(320, 180, { fit: "cover" }).webp().toBuffer();
  const detail = await sharp(source).resize(1280, 720, { fit: "inside" }).webp().toBuffer();
  const uploaded = new Map<string, Buffer>();
  const storage: AssetMediaStoragePort = {
    async uploadBytes(content, storagePath) {
      uploaded.set(storagePath, Buffer.from(content));
      return {
        bucket: "db-test-assets",
        storagePath,
        storageUrl: `https://private-storage.invalid/${storagePath}`,
      };
    },
    async headObject() {
      return { contentLength: source.length, contentType: "image/png", etag: "db-test-etag", lastModified: null };
    },
    async readObjectBytes(path, options) {
      if (path.startsWith("asset-renditions/v1/")) {
        assert.equal(options.bucket, "db-test-assets");
        assert.equal(options.process, undefined);
        const content = uploaded.get(path);
        assert.ok(content, "最终 rendition 必须从已上传对象回读");
        return content;
      }
      if (!options.process) return source;
      return options.process.includes("w_320") ? thumbnail : detail;
    },
    createDownloadUrl() {
      return {
        url: "https://signed.example.test/original",
        expiresAt: new Date(Date.now() + 300_000),
      };
    },
  };

  try {
    const firstApply = await runMigrations(handle);
    assert.ok(firstApply.includes("052_asset_media_repair.sql") || firstApply.length === 0);
    assert.deepEqual(await runMigrations(handle), []);
    await handle.db.insert(users).values({
      id: actorId,
      username: `asset-repair-${actorId.slice(0, 8)}`,
      displayName: "资产媒体修理真库测试",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(assetEntities).values({
      id: assetId,
      sourceProjectId: null,
      sourceProjectName: null,
      ownerUserId: actorId,
      visibility: "personal",
      assetKind: "character",
      name: "待修图片资产",
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
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(assetMedia).values({
      id: mediaId,
      assetEntityId: assetId,
      assetVariantId: null,
      mediaKind: "character_final",
      viewAngle: "front",
      title: "待修原图",
      description: null,
      storageBucket: "db-test-assets",
      storagePath: `asset/${mediaId}.png`,
      storageUrl: "https://original.example.test/must-not-leave-api.png",
      widthPx: null,
      heightPx: null,
      format: null,
      sha256: null,
      isPrimary: true,
      approved: true,
      sortOrder: 0,
      metadata: {},
      createdAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });

    const repository = new PostgresAssetMediaRepairRepository(handle.db);
    const service = new AssetMediaRepairService(repository, storage);
    const first = await service.submit({
      actor: { id: actorId, role: "member" },
      assetId,
      clientIdempotencyKey: idempotencyKey,
      mode: "safe",
    });
    const replay = await service.submit({
      actor: { id: actorId, role: "member" },
      assetId,
      clientIdempotencyKey: idempotencyKey,
      mode: "safe",
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.idempotentReplay, true);
    await assert.rejects(
      service.submit({
        actor: { id: actorId, role: "member" },
        assetId,
        clientIdempotencyKey: randomUUID(),
        mode: "safe",
      }),
      (error: unknown) =>
        error instanceof Error
        && "code" in error
        && (error as { code: unknown }).code === "asset_media_repair_in_progress",
      "不同幂等键即使 payload 相同也必须视为不同活跃任务",
    );
    assert.equal(await service.processNextQueued(), true);

    const [taskRow, mediaRow, renditions, actions] = await Promise.all([
      handle.db.select().from(assetMediaRepairTasks).where(eq(assetMediaRepairTasks.id, first.id)),
      handle.db.select().from(assetMedia).where(eq(assetMedia.id, mediaId)),
      handle.db.select().from(assetMediaRenditions).where(eq(assetMediaRenditions.assetMediaId, mediaId)),
      handle.db.select().from(assetMediaRepairActions).where(eq(assetMediaRepairActions.taskId, first.id)),
    ]);
    assert.equal(taskRow[0]?.status, "succeeded");
    assert.equal(mediaRow[0]?.widthPx, 640);
    assert.equal(mediaRow[0]?.heightPx, 360);
    assert.match(mediaRow[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(
      renditions.map((row) => [row.renditionKind, row.status]).sort(),
      [["detail", "healthy"], ["thumbnail", "healthy"]],
    );
    assert.equal(actions.length, 3);

    const sourceModelId = randomUUID();
    const previewMediaId = randomUUID();
    const sourceModelSha = "7".repeat(64);
    const sourceTosKey = `director-assets/v1/human/${sourceModelId}.glb`;
    const previewStorageKey = `asset-renditions/v1/director/${"8".repeat(64)}.png`;
    await handle.db.insert(assetMedia).values({
      id: sourceModelId,
      assetEntityId: assetId,
      assetVariantId: null,
      mediaKind: "model_3d",
      viewAngle: null,
      title: "实时源 GLB",
      description: null,
      storageBucket: "drama-asset",
      storagePath: sourceTosKey,
      storageUrl: null,
      widthPx: null,
      heightPx: null,
      format: "glb",
      sha256: sourceModelSha,
      isPrimary: false,
      approved: true,
      sortOrder: 10,
      metadata: {},
      createdAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    const previewPlan: DirectorPreviewImportPlan = {
      manifestGeneratedAt: now.toISOString(),
      media: [{
        id: previewMediaId,
        assetEntityId: assetId,
        assetVariantId: null,
        mediaKind: "image",
        viewAngle: "default",
        title: "3D 预览图",
        description: "实时绑定测试预览",
        storageBucket: "drama-asset",
        storagePath: previewStorageKey,
        storageUrl: null,
        widthPx: 512,
        heightPx: 512,
        format: "png",
        sha256: "8".repeat(64),
        isPrimary: false,
        approved: true,
        sortOrder: 1,
        metadata: {
          role: "director_3d_preview",
          sourceMediaId: sourceModelId,
          sourceTosKey,
          sourceSha256: sourceModelSha,
        },
      }],
      descriptions: [{
        assetEntityId: assetId,
        previewMediaId,
        descriptionZh: "实时绑定测试预览",
        sourceSummary: "真 PostgreSQL 锁定源媒体验证",
      }],
    };
    await applyDirectorPreviewImportPlan(handle.db, previewPlan);
    assert.equal(
      (await handle.db.select().from(assetMedia).where(eq(assetMedia.id, previewMediaId)))[0]?.sha256,
      "8".repeat(64),
    );
    await handle.db.update(assetMedia).set({ sha256: "9".repeat(64) })
      .where(eq(assetMedia.id, sourceModelId));
    await assert.rejects(
      applyDirectorPreviewImportPlan(handle.db, {
        ...previewPlan,
        media: [{ ...previewPlan.media[0]!, sha256: "a".repeat(64) }],
      }),
      /current approved GLB/,
      "过期 manifest 不得覆盖已落库 preview",
    );
    assert.equal(
      (await handle.db.select().from(assetMedia).where(eq(assetMedia.id, previewMediaId)))[0]?.sha256,
      "8".repeat(64),
      "源 SHA 漂移时整笔 preview apply 必须回滚",
    );
    await handle.db.delete(assetMedia).where(eq(assetMedia.id, previewMediaId));
    await handle.db.delete(assetMedia).where(eq(assetMedia.id, sourceModelId));

    await handle.db.insert(assetEntities).values([
      {
        id: conflictingAssetId, sourceProjectId: null, sourceProjectName: null, ownerUserId: actorId,
        visibility: "personal", assetKind: "scene", name: "冲突媒体直接归属", displayName: null, intro: null,
        appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null,
        category: null, styleTags: [], approved: true, reuseScope: "all_projects", status: "approved",
        sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
      },
      {
        id: conflictingVariantOwnerId, sourceProjectId: null, sourceProjectName: null, ownerUserId: actorId,
        visibility: "personal", assetKind: "scene", name: "冲突媒体变体归属", displayName: null, intro: null,
        appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null,
        category: null, styleTags: [], approved: true, reuseScope: "all_projects", status: "approved",
        sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
      },
    ]);
    await handle.db.insert(assetVariants).values({
      id: conflictingVariantId,
      assetEntityId: conflictingVariantOwnerId,
      variantKind: "look",
      name: "冲突媒体变体",
      description: null,
      usageContext: null,
      visualPrompt: null,
      approved: true,
      status: "approved",
      isPrimary: true,
      sortOrder: 0,
      sourceFileUrl: null,
      sourceText: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(assetMedia).values({
      id: conflictingMediaId,
      assetEntityId: conflictingAssetId,
      assetVariantId: conflictingVariantId,
      mediaKind: "scene_reference",
      viewAngle: "front",
      title: "双归属媒体不得自愈",
      description: null,
      storageBucket: "db-test-assets",
      storagePath: `asset/${conflictingMediaId}.png`,
      storageUrl: null,
      widthPx: null,
      heightPx: null,
      format: null,
      sha256: null,
      isPrimary: true,
      approved: true,
      sortOrder: 0,
      metadata: {},
      createdAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    assert.equal(
      await repository.enqueueSelfHealCandidates(20),
      0,
      "健康图片不重复入队，双归属图片也不得消耗任一资产的自愈批次",
    );

    // A single row can be claimed only once.  A stale owner cannot terminally
    // overwrite the replacement owner's lease after it expires.
    const leaseTaskId = randomUUID();
    await handle.db.insert(assetMediaRepairTasks).values({
      id: leaseTaskId,
      assetEntityId: assetId,
      requestedByUserId: null,
      clientIdempotencyKey: null,
      requestHash: "a".repeat(64),
      mode: "safe",
      trigger: "batch",
      mediaIds: [],
      status: "queued",
      claimToken: null,
      leaseExpiresAt: null,
      diagnosis: {},
      result: {},
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    });
    const otherRepository = new PostgresAssetMediaRepairRepository(handle.db);
    const [firstClaim, competingClaim] = await Promise.all([
      repository.claimNextQueued(),
      otherRepository.claimNextQueued(),
    ]);
    const owner = firstClaim?.id === leaseTaskId ? repository : otherRepository;
    const staleOwner = owner === repository ? otherRepository : repository;
    const leaseClaim = firstClaim?.id === leaseTaskId ? firstClaim : competingClaim;
    assert.ok(leaseClaim, "其中一个 worker 必须取得租约");
    assert.notEqual(firstClaim?.id === leaseTaskId, competingClaim?.id === leaseTaskId, "双 worker 不得并行 claim 同一任务");
    await handle.db.update(assetMediaRepairTasks).set({
      leaseExpiresAt: new Date(Date.now() - 1_000),
    }).where(eq(assetMediaRepairTasks.id, leaseTaskId));
    const replacement = await staleOwner.claimNextQueued();
    assert.equal(replacement?.id, leaseTaskId, "过期租约必须能被下一 worker 回收");
    await assert.rejects(
      owner.completeTask(leaseTaskId, leaseClaim!.claimToken!, {
        status: "succeeded", diagnosis: {}, result: {}, errorCode: null, errorMessage: null, finishedAt: new Date(),
      }),
      /另一工作进程接手/,
    );
    const afterStaleTerminal = (await handle.db.select().from(assetMediaRepairTasks)
      .where(eq(assetMediaRepairTasks.id, leaseTaskId)))[0];
    assert.equal(afterStaleTerminal?.status, "processing", "过期 token 不得终结新 owner 的任务");
    const detailBeforeRollback = renditions.find((row) => row.renditionKind === "detail")!;
    await assert.rejects(
      staleOwner.upsertRenditionsAndAppendAction(leaseTaskId, replacement!.claimToken!, [{
        assetMediaId: mediaId,
        renditionKind: "detail",
        strategy: "stored_object",
        status: "healthy",
        processSpec: null,
        storageBucket: detailBeforeRollback.storageBucket,
        storagePath: detailBeforeRollback.storagePath,
        storageUrl: null,
        sourceSha256: detailBeforeRollback.sourceSha256,
        widthPx: detailBeforeRollback.widthPx,
        heightPx: detailBeforeRollback.heightPx,
        format: detailBeforeRollback.format,
        sha256: "d".repeat(64),
        errorCode: null,
        errorMessage: null,
        checkedAt: new Date(),
      }], {
        assetMediaId: mediaId,
        action: "refresh_rendition",
        status: "invalid" as "succeeded",
        before: {},
        after: {},
      }),
      (error: unknown) =>
        error instanceof Error
        && "cause" in error
        && (error as { cause?: { constraint?: string } }).cause?.constraint
          === "asset_media_repair_actions_status_check",
    );
    assert.equal(
      (await handle.db.select().from(assetMediaRenditions)
        .where(eq(assetMediaRenditions.id, detailBeforeRollback.id)))[0]?.sha256,
      detailBeforeRollback.sha256,
      "rendition upsert 与 action 写入必须同事务回滚",
    );
    await staleOwner.completeTask(leaseTaskId, replacement!.claimToken!, {
      status: "succeeded", diagnosis: {}, result: {}, errorCode: null, errorMessage: null, finishedAt: new Date(),
    });

    const blockedAssetId = randomUUID();
    const blockedMediaId = randomUUID();
    await handle.db.insert(assetEntities).values({
      id: blockedAssetId, sourceProjectId: null, sourceProjectName: null, ownerUserId: actorId,
      visibility: "personal", assetKind: "character", name: "长期缺源资产", displayName: null, intro: null,
      appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null,
      category: null, styleTags: [], approved: true, reuseScope: "all_projects", status: "approved",
      sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(assetMedia).values({
      id: blockedMediaId, assetEntityId: blockedAssetId, assetVariantId: null, mediaKind: "scene_final", viewAngle: "front",
      title: "不可读源", description: null, storageBucket: "db-test-assets", storagePath: `asset/${blockedMediaId}.png`,
      storageUrl: null, widthPx: null, heightPx: null, format: null, sha256: null, isPrimary: true, approved: true,
      sortOrder: 0, metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null,
    });
    assert.equal(await repository.enqueueSelfHealCandidates(20), 1);
    const blockedClaim = await repository.claimNextQueued();
    assert.equal(blockedClaim?.assetId, blockedAssetId);
    await repository.appendAction({
      taskId: blockedClaim!.id, claimToken: blockedClaim!.claimToken!, assetMediaId: blockedMediaId, action: "mark_blocked", status: "blocked",
      before: {}, after: {}, errorCode: "source_object_missing", errorMessage: "测试 hard blocker",
    });
    await repository.completeTask(blockedClaim!.id, blockedClaim!.claimToken!, {
      status: "failed", diagnosis: {}, result: {}, errorCode: "asset_media_repair_incomplete", errorMessage: "blocked", finishedAt: new Date(),
    });
    assert.equal(await repository.enqueueSelfHealCandidates(20), 0, "同一 blocker 状态第一轮不得重入队");
    assert.equal(await repository.enqueueSelfHealCandidates(20), 0, "同一 blocker 状态第二轮不得重入队");
    await handle.db.update(assetEntities).set({ updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(assetEntities.id, blockedAssetId));
    assert.equal(await repository.enqueueSelfHealCandidates(20), 1, "资产或媒体状态变化后应重新入队");

    const otherUserId = randomUUID();
    const commonAssetId = randomUUID();
    await handle.db.insert(users).values({
      id: otherUserId,
      username: `asset-repair-other-${otherUserId.slice(0, 8)}`,
      displayName: "资产媒体权限矩阵用户",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(assetEntities).values({
      id: commonAssetId, sourceProjectId: null, sourceProjectName: null, ownerUserId: null,
      visibility: "common", assetKind: "scene", name: "通用资产权限矩阵", displayName: null, intro: null,
      appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null,
      category: null, styleTags: [], approved: true, reuseScope: "all_projects", status: "approved",
      sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
    });
    await assert.rejects(
      service.submit({
        actor: { id: otherUserId, role: "member" },
        assetId,
        clientIdempotencyKey: randomUUID(),
        mode: "safe",
      }),
      (error: unknown) => error instanceof ForbiddenError,
      "非 owner 不能修个人资产",
    );
    await assert.rejects(
      service.submit({
        actor: { id: otherUserId, role: "member" },
        assetId: commonAssetId,
        clientIdempotencyKey: randomUUID(),
        mode: "safe",
      }),
      (error: unknown) => error instanceof ForbiddenError,
      "普通成员不能修通用资产",
    );
    const adminTask = await service.submit({
      actor: { id: otherUserId, role: "admin" },
      assetId: commonAssetId,
      clientIdempotencyKey: randomUUID(),
      mode: "safe",
    });
    assert.equal(adminTask.assetId, commonAssetId, "管理员可以提交通用资产修复");
    await assert.rejects(
      service.submit({
        actor: { id: actorId, role: "member" },
        assetId,
        clientIdempotencyKey: randomUUID(),
        mediaIds: [blockedMediaId],
        mode: "safe",
      }),
      (error: unknown) => error instanceof UnprocessableEntityError,
      "跨资产 media_id 不能进入修复任务",
    );
    await assert.rejects(
      service.createDownloadUrl({ id: actorId, role: "member" }, assetId, blockedMediaId),
      (error: unknown) => error instanceof NotFoundError,
      "跨资产 media_id 不能获取原件下载地址",
    );

    const schema = process.env.POSTGRES_SCHEMA;
    assert.ok(schema && /^[A-Za-z_][A-Za-z0-9_]*$/.test(schema));
    await assert.rejects(
      handle.pool.query(`UPDATE "${schema}"."asset_media_repair_actions" SET status = 'failed' WHERE id = $1`, [actions[0]!.id]),
      /append-only/,
    );
  } finally {
    await handle.pool.end();
  }
});
