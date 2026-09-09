import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import {
  assetEntities,
  assetMedia,
  assetMediaRenditions,
  assetTags,
  assetUploadTasks,
  assetVariants,
  episodes,
  generationRequests,
  mediaProvenanceSubjects,
  projectAssetRefs,
  projects,
  scenes,
  shots,
  tagVocabulary,
  users,
} from "../src/db/schema.js";
import { AssetCatalogService } from "../src/modules/assets/catalog.js";
import { AssetCopyRepository } from "../src/modules/assets/copyRepository.js";
import { HybridAssetSearchRepository } from "../src/modules/assets/hybridSearchRepository.js";
import { AssetPostgresFallbackSearchService } from "../src/modules/assets/searchFallback.js";
import { AssetUsageService } from "../src/modules/assets/usage.js";
import { PostgresAssetUploadTaskRepository } from "../src/modules/asset-uploads/repository.js";
import { DrizzleRegisteredImageRepository } from "../src/modules/asset-uploads/registeredImage.js";
import { ProjectAssetRepository } from "../src/modules/project-assets/repository.js";
import { AssetMediaRepository } from "../src/repositories/assetMediaRepository.js";
import { AssetVariantRepository } from "../src/repositories/assetVariantRepository.js";
import { ConflictError, ForbiddenError } from "../src/shared/errors.js";

/**
 * 真 PostgreSQL 验证资产分镜级使用明细(R8):三条链(控制包参考栏、生成
 * 请求 reference_media_ids、项目资产登记)的计数与明细、deleted_at 过滤、
 * 可见性与 project_id 过滤。连接串只允许本机或本地 Compose,拒绝云 RDS。
 */
const requestedDatabaseUrl = process.env.ASSET_USAGE_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;
const schema = quoteIdentifier(settings.postgresSchema);

test("asset usage: 三链计数与明细、删除过滤、可见性与项目过滤", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const otherUserId = randomUUID();
  const projectId = randomUUID();
  const hiddenProjectId = randomUUID();
  const episodeId = randomUUID();
  const hiddenEpisodeId = randomUUID();
  const sceneId = randomUUID();
  const shotId = randomUUID();
  const hiddenShotId = randomUUID();
  const deletedShotId = randomUUID();
  const assetId = randomUUID();
  const emptyAssetId = randomUUID();
  const variantId = randomUUID();
  const directMediaId = randomUUID();
  const variantMediaId = randomUUID();
  const requestOnShotId = randomUUID();
  const requestNoShotId = randomUUID();
  const hiddenRequestId = randomUUID();
  const now = new Date("2026-07-24T09:00:00.000Z");
  const service = new AssetUsageService(handle.db);
  try {
    await applyMigrations(handle);
    await handle.db.insert(users).values([
      userValues(actorId, "usage-actor", now),
      userValues(otherUserId, "usage-other", now),
    ]);
    await handle.db.insert(projects).values(projectValues(projectId, actorId, "Usage Project", now));
    await handle.db.insert(projects).values(projectValues(hiddenProjectId, otherUserId, "Hidden Usage Project", now));
    await handle.db.insert(episodes).values(episodeValues(episodeId, projectId, now));
    await handle.db.insert(episodes).values(episodeValues(hiddenEpisodeId, hiddenProjectId, now));
    await handle.db.insert(scenes).values({
      id: sceneId, episodeId, sceneNo: 2, name: "酒吧", description: null, sortOrder: 0,
      createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(shots).values([
      { ...shotValues(shotId, episodeId, "US-01", now), sceneId },
      { ...shotValues(deletedShotId, episodeId, "US-DELETED", now), deletedAt: now, deletedByUserId: actorId },
      shotValues(hiddenShotId, hiddenEpisodeId, "HIDDEN-01", now),
    ]);
    await handle.db.insert(assetEntities).values([
      assetValues(assetId, actorId, "personal", "Usage Host", now),
      assetValues(emptyAssetId, otherUserId, "personal", "Usage Empty", now),
    ]);
    await handle.db.insert(assetVariants).values({
      id: variantId, assetEntityId: assetId, variantKind: "look", name: "默认外观",
      description: null, usageContext: null, visualPrompt: null, approved: true, status: "approved",
      isPrimary: true, sortOrder: 0, sourceFileUrl: null, sourceText: null, metadata: {},
      createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(assetMedia).values([
      mediaValues(directMediaId, assetId, now),
      { ...mediaValues(variantMediaId, assetId, now), assetEntityId: null, assetVariantId: variantId },
    ]);
    await handle.db.insert(generationRequests).values([
      generationRequestValues(requestOnShotId, projectId, actorId, [directMediaId], shotId, now),
      { ...generationRequestValues(requestNoShotId, projectId, actorId, [variantMediaId], null, now), targetAssetEntityId: assetId },
      generationRequestValues(hiddenRequestId, hiddenProjectId, otherUserId, [directMediaId], hiddenShotId, now),
    ]);
    await handle.db.insert(projectAssetRefs).values({
      id: randomUUID(), projectId, assetEntityId: assetId, assetVariantId: null, assetMediaId: null,
      versionSnapshot: {}, createdByUserId: actorId, createdAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(projectAssetRefs).values({
      id: randomUUID(), projectId: hiddenProjectId, assetEntityId: assetId, assetVariantId: null, assetMediaId: null,
      versionSnapshot: {}, createdByUserId: otherUserId, createdAt: now, deletedAt: null, deletedByUserId: null,
    });
    // 活分镜控制包:两个参考栏各挂一个媒体;已删分镜的控制包必须被过滤。
    await handle.pool.query(
      `INSERT INTO ${schema}.control_packages (id, shot_id, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [randomUUID(), shotId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${schema}.control_packages (id, shot_id, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [randomUUID(), deletedShotId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${schema}.control_package_refs (id, package_id, lane, asset_media_id, sort_order, created_at)
       SELECT $1, id, $2, $3, 0, $4 FROM ${schema}.control_packages WHERE shot_id = $5`,
      [randomUUID(), "character", directMediaId, now, shotId],
    );
    await handle.pool.query(
      `INSERT INTO ${schema}.control_package_refs (id, package_id, lane, asset_media_id, sort_order, created_at)
       SELECT $1, id, $2, $3, 0, $4 FROM ${schema}.control_packages WHERE shot_id = $5`,
      [randomUUID(), "prop", variantMediaId, now, shotId],
    );
    await handle.pool.query(
      `INSERT INTO ${schema}.control_package_refs (id, package_id, lane, asset_media_id, sort_order, created_at)
       SELECT $1, id, $2, $3, 0, $4 FROM ${schema}.control_packages WHERE shot_id = $5`,
      [randomUUID(), "character", directMediaId, now, deletedShotId],
    );

    const report = await service.report(actorId, assetId);
    assert.deepEqual(report.counts, { controlPackages: 1, shots: 1, generationRequests: 2 });
    assert.equal(report.shots.length, 1, "已删分镜上的控制包引用必须被过滤");
    const shot = report.shots[0]!;
    assert.equal(shot.shotId, shotId);
    assert.equal(shot.shotCode, "US-01");
    assert.equal(shot.episodeId, episodeId);
    assert.equal(shot.episodeNo, 1);
    assert.equal(shot.sceneId, sceneId);
    assert.equal(shot.sceneNo, 2);
    assert.deepEqual(shot.via, ["control_package", "generation_request"]);
    assert.deepEqual(shot.lanes, ["character", "prop"]);
    assert.deepEqual(shot.mediaIds, [directMediaId, variantMediaId].sort());
    assert.deepEqual(report.bindings, [{
      projectId, projectName: "Usage Project", episodeNos: [1], shotCount: 1,
    }]);

    const filtered = await service.report(actorId, assetId, randomUUID());
    assert.deepEqual(filtered, {
      counts: { controlPackages: 0, shots: 0, generationRequests: 0 },
      bindings: [],
      shots: [],
    }, "project_id 过滤必须同时收窄三链与登记");

    const hiddenProject = await service.report(actorId, assetId, hiddenProjectId);
    assert.deepEqual(hiddenProject, {
      counts: { controlPackages: 0, shots: 0, generationRequests: 0 },
      bindings: [],
      shots: [],
    }, "无权项目必须保持旧接口的空报告语义，且不能泄露该项目的使用边");

    const empty = await service.report(otherUserId, emptyAssetId);
    assert.deepEqual(empty, {
      counts: { controlPackages: 0, shots: 0, generationRequests: 0 },
      bindings: [],
      shots: [],
    }, "无媒体资产必须返回全零而不是报错");

    await assert.rejects(
      service.report(otherUserId, assetId),
      (error: unknown) => error instanceof ForbiddenError,
      "他人个人资产的使用明细不可见",
    );
  } finally {
    await handle.pool.query(`DELETE FROM ${schema}.control_package_refs WHERE package_id IN (SELECT id FROM ${schema}.control_packages WHERE shot_id IN ($1, $2))`, [shotId, deletedShotId]).catch(() => undefined);
    await handle.pool.query(`DELETE FROM ${schema}.control_packages WHERE shot_id IN ($1, $2)`, [shotId, deletedShotId]).catch(() => undefined);
    await handle.db.delete(projectAssetRefs).where(eq(projectAssetRefs.assetEntityId, assetId)).catch(() => undefined);
    await handle.db.delete(generationRequests).where(inArray(generationRequests.id, [requestOnShotId, requestNoShotId, hiddenRequestId])).catch(() => undefined);
    await handle.db.delete(assetMedia).where(inArray(assetMedia.id, [directMediaId, variantMediaId])).catch(() => undefined);
    await handle.db.delete(assetVariants).where(eq(assetVariants.id, variantId)).catch(() => undefined);
    await handle.db.delete(assetEntities).where(inArray(assetEntities.id, [assetId, emptyAssetId])).catch(() => undefined);
    await handle.db.delete(shots).where(inArray(shots.id, [shotId, deletedShotId, hiddenShotId])).catch(() => undefined);
    await handle.db.delete(scenes).where(eq(scenes.id, sceneId)).catch(() => undefined);
    await handle.db.delete(episodes).where(inArray(episodes.id, [episodeId, hiddenEpisodeId])).catch(() => undefined);
    await handle.db.delete(projects).where(inArray(projects.id, [projectId, hiddenProjectId])).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, [actorId, otherUserId])).catch(() => undefined);
    await handle.pool.end();
  }
});

test("asset browse v1: 服务端筛选排序、徽标计数与采用次数在真 PostgreSQL 闭环", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const projectId = randomUUID();
  const sourceProjectId = randomUUID();
  const imageFirstId = randomUUID();
  const imageSecondId = randomUUID();
  const modelOnlyId = randomUUID();
  const sceneId = randomUUID();
  const pendingId = randomUUID();
  const unapprovedImageAssetId = randomUUID();
  const conflictingImageAssetId = randomUUID();
  const imageSecondVariantId = randomUUID();
  const tagId = `cinematic-${randomUUID().slice(0, 8)}`;
  const now = new Date("2026-08-01T00:00:00.000Z");
  const older = new Date("2026-07-30T00:00:00.000Z");
  const newest = new Date("2026-08-01T01:00:00.000Z");
  const mediaIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const catalog = new AssetCatalogService(handle.db);
  try {
    await applyMigrations(handle);
    await handle.db.insert(users).values(userValues(actorId, "browse-actor", now));
    await handle.db.insert(projects).values(projectValues(projectId, actorId, "Browse Project", now));
    await handle.db.insert(tagVocabulary).values({
      id: tagId,
      canonicalId: tagId,
      domain: "style",
      displayName: "电影感",
      sort: 0,
      active: true,
      createdBy: actorId,
      createdAt: now,
    });
    await handle.db.insert(assetEntities).values([
      {
        ...assetValues(imageFirstId, null, "common", "Browse Hero A", older),
        sourceProjectId,
        category: "modern",
        gender: "female",
        metadata: { age_band: "adult" },
        useCount: 9,
        createdAt: older,
        updatedAt: now,
      },
      {
        ...assetValues(imageSecondId, null, "common", "Browse Hero B", older),
        sourceProjectId,
        category: "modern",
        gender: "female",
        metadata: { age_band: "adult" },
        useCount: 9,
        createdAt: newest,
        updatedAt: now,
      },
      {
        ...assetValues(modelOnlyId, null, "common", "Browse Hero Model", older),
        sourceProjectId,
        category: "modern",
        gender: "female",
        metadata: { age_band: "adult" },
        useCount: 99,
        createdAt: now,
        updatedAt: now,
      },
      {
        ...assetValues(sceneId, null, "common", "Browse Scene", older),
        sourceProjectId,
        assetKind: "scene",
        category: "modern",
        useCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        ...assetValues(pendingId, null, "common", "Pending Browse Secret", now),
        status: "pending_review",
        approved: null,
      },
    ]);
    await handle.db.insert(assetVariants).values({
      id: imageSecondVariantId,
      assetEntityId: imageSecondId,
      variantKind: "look",
      name: "图片变体",
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
    await handle.db.insert(assetTags).values([
      { assetEntityId: imageFirstId, tagId, createdBy: actorId, createdAt: now },
      { assetEntityId: imageSecondId, tagId, createdBy: actorId, createdAt: now },
      { assetEntityId: modelOnlyId, tagId, createdBy: actorId, createdAt: now },
      { assetEntityId: sceneId, tagId, createdBy: actorId, createdAt: now },
    ]);
    await handle.db.insert(assetMedia).values([
      {
        ...mediaValues(mediaIds[0]!, imageFirstId, now),
        mediaKind: "character_final",
      },
      {
        ...mediaValues(mediaIds[1]!, imageSecondId, now),
        assetEntityId: null,
        assetVariantId: imageSecondVariantId,
        mediaKind: "character_turnaround",
      },
      {
        ...mediaValues(mediaIds[2]!, modelOnlyId, now),
        mediaKind: "model_3d",
        format: "glb",
        storagePath: `assets/${modelOnlyId}.glb`,
        storageUrl: `https://assets.test/${modelOnlyId}.glb`,
      },
      {
        ...mediaValues(mediaIds[3]!, sceneId, now),
        mediaKind: "scene_final",
      },
    ]);

    const composite = await catalog.listPage(actorId, {
      scope: "common",
      status: "approved",
      sort: "composite",
    }, 1, 24);
    const tiedImageIds = [imageFirstId, imageSecondId].sort();
    assert.deepEqual(
      composite.items.map((item) => item.id),
      [...tiedImageIds, sceneId, modelOnlyId],
      "有图优先，其内按 use_count、updated_at、id 稳定排序",
    );
    const firstPage = await catalog.listPage(actorId, {
      scope: "common",
      status: "approved",
      sort: "composite",
    }, 1, 1);
    const secondPage = await catalog.listPage(actorId, {
      scope: "common",
      status: "approved",
      sort: "composite",
    }, 2, 1);
    assert.deepEqual(
      [firstPage.items[0]?.id, secondPage.items[0]?.id],
      tiedImageIds,
      "全部排序键相同的资产按 id ASC 跨页无重复、无遗漏",
    );

    const newestPage = await catalog.listPage(actorId, {
      scope: "common",
      status: "approved",
      sort: "newest",
    }, 1, 24);
    assert.equal(newestPage.items[0]?.id, imageSecondId, "最新入库按 created_at DESC");

    // Public image filters must use the same approved + consistent-owner policy
    // as the card projection. Otherwise these hidden rows leak through counts.
    await handle.db.insert(assetEntities).values([
      {
        ...assetValues(unapprovedImageAssetId, null, "common", "Browse Unapproved Image", now),
        sourceProjectId,
        category: "modern",
      },
      {
        ...assetValues(conflictingImageAssetId, null, "common", "Browse Conflicting Image", now),
        sourceProjectId,
        category: "modern",
      },
    ]);
    await handle.db.insert(assetTags).values([
      { assetEntityId: unapprovedImageAssetId, tagId, createdBy: actorId, createdAt: now },
      { assetEntityId: conflictingImageAssetId, tagId, createdBy: actorId, createdAt: now },
    ]);
    await handle.db.insert(assetMedia).values([
      {
        ...mediaValues(mediaIds[4]!, unapprovedImageAssetId, now),
        mediaKind: "character_reference",
        approved: false,
      },
      {
        ...mediaValues(mediaIds[5]!, conflictingImageAssetId, now),
        assetVariantId: imageSecondVariantId,
        mediaKind: "character_reference",
      },
    ]);

    const filtered = await catalog.listPage(actorId, {
      scope: "common",
      query: "Browse",
      assetKind: "character",
      status: "approved",
      tags: [tagId, "missing-tag"],
      media: "image",
      category: "modern",
      sourceProjectId,
      sort: "composite",
    }, 1, 24);
    assert.deepEqual(filtered.items.map((item) => item.id), tiedImageIds);
    assert.equal(filtered.total, 3, "未审或双归属图片不能污染跨类型总数");
    assert.equal(filtered.filteredTotal, 2, "未审或双归属图片不能污染当前类型页签");
    assert.deepEqual(
      filtered.kindCounts,
      { character: 2, scene: 1 },
      "徽标计数保留搜索、媒体与高级筛选，但拒绝未审和双归属图片",
    );
    const filteredSecondPage = await catalog.listPage(actorId, {
      scope: "common",
      query: "Browse",
      assetKind: "character",
      status: "approved",
      tags: [tagId, "missing-tag"],
      media: "image",
      category: "modern",
      sourceProjectId,
      sort: "composite",
    }, 2, 1);
    assert.equal(
      filteredSecondPage.hasMore,
      false,
      "分页边界使用 filteredTotal，不能被跨类型 total 虚构出第三页",
    );

    const roleFiltered = await catalog.listPage(actorId, {
      scope: "common",
      assetKind: "character",
      status: "approved",
      gender: "female",
      ageBand: "adult",
      sort: "composite",
    }, 1, 24);
    assert.deepEqual(roleFiltered.items.map((item) => item.id), [...tiedImageIds, modelOnlyId]);

    const modelOnly = await catalog.listPage(actorId, {
      scope: "common",
      status: "approved",
      media: "model3d",
      sort: "composite",
    }, 1, 24);
    assert.deepEqual(modelOnly.items.map((item) => item.id), [modelOnlyId]);

    await assert.rejects(
      catalog.get(actorId, pendingId),
      (error: unknown) => error instanceof ForbiddenError,
      "普通用户不能凭 ID 读取待审通用资产",
    );
    const copy = new AssetCopyRepository(handle.db);
    await assert.rejects(
      copy.copyCommonToPersonal(actorId, pendingId),
      /通用资产不存在/,
      "待审通用资产不能绕过列表直接导入个人库",
    );
    const fallback = new AssetPostgresFallbackSearchService(catalog);
    assert.equal(
      (await fallback.search(actorId, "Pending Browse Secret", 10))
        .some((item) => item.sourceId === pendingId),
      false,
      "PostgreSQL 降级搜索同样只召回已过审通用资产",
    );

    const copyResults = await Promise.all([
      copy.copyCommonToPersonal(actorId, imageFirstId),
      copy.copyCommonToPersonal(actorId, imageFirstId),
    ]);
    assert.equal(copyResults.filter((result) => result.created).length, 1);
    assert.equal(copyResults.filter((result) => !result.created).length, 1);

    const projectAssets = new ProjectAssetRepository(handle.db);
    await assert.rejects(
      projectAssets.add(actorId, projectId, { assetEntityId: pendingId }, projectId),
      (error: unknown) => error instanceof ForbiddenError,
      "待审通用资产不能绕过列表直接引用到项目",
    );
    const references = await Promise.all([
      projectAssets.add(actorId, projectId, { assetEntityId: modelOnlyId }, projectId),
      projectAssets.add(actorId, projectId, { assetEntityId: modelOnlyId }, projectId),
    ]);
    assert.equal(references[0]?.id, references[1]?.id);

    const counts = await handle.db.select({
      id: assetEntities.id,
      useCount: assetEntities.useCount,
    }).from(assetEntities).where(inArray(assetEntities.id, [imageFirstId, modelOnlyId]));
    assert.deepEqual(
      Object.fromEntries(counts.map((row) => [row.id, row.useCount])),
      { [imageFirstId]: 10, [modelOnlyId]: 100 },
      "导入个人和引用项目均只在首次采用时 +1",
    );
  } finally {
    await handle.db.delete(projectAssetRefs).where(eq(projectAssetRefs.projectId, projectId)).catch(() => undefined);
    const copiedIds = (await handle.db.select({ id: assetEntities.id }).from(assetEntities)
      .where(eq(assetEntities.ownerUserId, actorId)).catch(() => []))
      .map((row) => row.id);
    if (copiedIds.length) {
      await handle.db.delete(assetMedia).where(inArray(assetMedia.assetEntityId, copiedIds)).catch(() => undefined);
      await handle.db.delete(assetVariants).where(inArray(assetVariants.assetEntityId, copiedIds)).catch(() => undefined);
      await handle.db.delete(assetEntities).where(inArray(assetEntities.id, copiedIds)).catch(() => undefined);
    }
    await handle.db.delete(assetTags).where(inArray(
      assetTags.assetEntityId,
      [
        imageFirstId,
        imageSecondId,
        modelOnlyId,
        sceneId,
        pendingId,
        unapprovedImageAssetId,
        conflictingImageAssetId,
      ],
    )).catch(() => undefined);
    await handle.db.delete(assetMedia).where(inArray(assetMedia.id, mediaIds)).catch(() => undefined);
    await handle.db.delete(assetVariants).where(eq(assetVariants.id, imageSecondVariantId)).catch(() => undefined);
    await handle.db.delete(assetEntities).where(inArray(
      assetEntities.id,
      [
        imageFirstId,
        imageSecondId,
        modelOnlyId,
        sceneId,
        pendingId,
        unapprovedImageAssetId,
        conflictingImageAssetId,
      ],
    )).catch(() => undefined);
    await handle.db.delete(tagVocabulary).where(eq(tagVocabulary.id, tagId)).catch(() => undefined);
    await handle.db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

test("R128: 个人资产的变体和媒体仓储强制免审，通用资产保留审核输入", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const personalAssetId = randomUUID();
  const commonAssetId = randomUUID();
  const now = new Date("2026-08-01T02:00:00.000Z");
  const mediaIds: string[] = [];
  const variantIds: string[] = [];
  try {
    await applyMigrations(handle);
    await handle.db.insert(users).values(userValues(actorId, "personal-child-boundary", now));
    await handle.db.insert(assetEntities).values([
      assetValues(personalAssetId, actorId, "personal", "个人子对象边界", now),
      assetValues(commonAssetId, null, "common", "通用子对象边界", now),
    ]);

    const variants = new AssetVariantRepository(handle.db);
    const personalVariant = await variants.save({
      assetEntityId: personalAssetId,
      variantKind: "look",
      name: "个人待审输入",
      status: "pending_review",
      approved: null,
    });
    const commonVariant = await variants.save({
      assetEntityId: commonAssetId,
      variantKind: "look",
      name: "通用待审输入",
      status: "pending_review",
      approved: null,
    });
    variantIds.push(personalVariant.id, commonVariant.id);
    assert.equal(personalVariant.status, "approved");
    assert.equal(personalVariant.approved, true);
    assert.equal(commonVariant.status, "pending_review");
    assert.equal(commonVariant.approved, null);

    const media = new AssetMediaRepository(handle.db);
    const personalMedia = await media.create({
      assetEntityId: personalAssetId,
      mediaKind: "image",
      isPrimary: false,
      approved: false,
      sortOrder: 0,
    });
    const commonMedia = await media.create({
      assetEntityId: commonAssetId,
      mediaKind: "image",
      isPrimary: false,
      approved: false,
      sortOrder: 0,
    });
    mediaIds.push(personalMedia.id, commonMedia.id);
    assert.equal(personalMedia.approved, true);
    assert.equal(commonMedia.approved, false);
    await assert.rejects(
      media.create({
        assetEntityId: commonAssetId,
        assetVariantId: personalVariant.id,
        mediaKind: "image",
        isPrimary: false,
        approved: true,
        sortOrder: 0,
      }),
      (error: unknown) => error instanceof ConflictError && error.code === "asset_variant_mismatch",
      "媒体仓储必须拒绝把其他资产的变体挂到当前实体",
    );
  } finally {
    if (mediaIds.length) await handle.db.delete(assetMedia).where(inArray(assetMedia.id, mediaIds)).catch(() => undefined);
    if (variantIds.length) await handle.db.delete(assetVariants).where(inArray(assetVariants.id, variantIds)).catch(() => undefined);
    await handle.db.delete(assetEntities).where(inArray(assetEntities.id, [personalAssetId, commonAssetId])).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

test("R128 搜索边界: personal/common 在实体、变体、词法召回和水合中均不串域", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const otherUserId = randomUUID();
  const marker = `scopeprobe${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const ids = {
    actorPersonal: randomUUID(),
    otherPersonal: randomUUID(),
    approvedCommon: randomUUID(),
    pendingCommon: randomUUID(),
    rejectedCommon: randomUUID(),
    crossMediaCommon: randomUUID(),
    actorVariant: randomUUID(),
    otherVariant: randomUUID(),
    approvedCommonVariant: randomUUID(),
    pendingCommonVariant: randomUUID(),
    pendingEntityVariant: randomUUID(),
    approvedDirectMedia: randomUUID(),
    approvedDetailRendition: randomUUID(),
    unapprovedDirectMedia: randomUUID(),
    pendingVariantMedia: randomUUID(),
    crossEntityMedia: randomUUID(),
  };
  const now = new Date("2026-08-01T02:30:00.000Z");
  const repository = new HybridAssetSearchRepository(handle.db);
  const variantValues = (
    id: string,
    assetEntityId: string,
    label: string,
    status: "approved" | "pending_review",
  ) => ({
    id,
    assetEntityId,
    variantKind: "look",
    name: `${marker} ${label}`,
    description: null,
    usageContext: null,
    visualPrompt: null,
    approved: status === "approved" ? true : null,
    status,
    isPrimary: false,
    sortOrder: 0,
    sourceFileUrl: null,
    sourceText: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  });
  try {
    await applyMigrations(handle);
    await handle.db.insert(users).values([
      userValues(actorId, "hybrid-scope-actor", now),
      userValues(otherUserId, "hybrid-scope-other", now),
    ]);
    await handle.db.insert(assetEntities).values([
      assetValues(ids.actorPersonal, actorId, "personal", `${marker} actor personal`, now),
      assetValues(ids.otherPersonal, otherUserId, "personal", `${marker} other personal`, now),
      assetValues(ids.approvedCommon, null, "common", `${marker} approved common`, now),
      {
        ...assetValues(ids.pendingCommon, null, "common", `${marker} pending common`, now),
        status: "pending_review",
        approved: null,
      },
      {
        ...assetValues(ids.rejectedCommon, null, "common", `${marker} rejected common`, now),
        status: "rejected",
        approved: false,
      },
      assetValues(ids.crossMediaCommon, null, "common", `${marker} cross media common`, now),
    ]);
    await handle.db.insert(assetVariants).values([
      variantValues(ids.actorVariant, ids.actorPersonal, "actor variant", "approved"),
      variantValues(ids.otherVariant, ids.otherPersonal, "other variant", "approved"),
      variantValues(ids.approvedCommonVariant, ids.approvedCommon, "approved common variant", "approved"),
      variantValues(ids.pendingCommonVariant, ids.approvedCommon, "pending common variant", "pending_review"),
      variantValues(ids.pendingEntityVariant, ids.pendingCommon, "pending entity variant", "approved"),
    ]);
    await handle.db.insert(assetMedia).values([
      {
        ...mediaValues(ids.approvedDirectMedia, ids.approvedCommon, now),
        isPrimary: false,
        sortOrder: 10,
        storageUrl: "https://assets.test/approved-direct.png",
      },
      {
        ...mediaValues(ids.unapprovedDirectMedia, ids.approvedCommon, now),
        isPrimary: true,
        approved: false,
        sortOrder: -10,
        storageUrl: "https://assets.test/unapproved-direct.png",
      },
      {
        ...mediaValues(ids.pendingVariantMedia, ids.approvedCommon, now),
        assetEntityId: null,
        assetVariantId: ids.pendingCommonVariant,
        isPrimary: true,
        sortOrder: -20,
        storageUrl: "https://assets.test/pending-variant.png",
      },
      {
        ...mediaValues(ids.crossEntityMedia, ids.crossMediaCommon, now),
        assetVariantId: ids.approvedCommonVariant,
        isPrimary: true,
        sortOrder: -30,
        storageUrl: "https://assets.test/cross-entity.png",
      },
    ]);
    await handle.db.insert(assetMediaRenditions).values({
      id: ids.approvedDetailRendition,
      assetMediaId: ids.approvedDirectMedia,
      renditionKind: "detail",
      strategy: "stored_object",
      status: "healthy",
      processSpec: null,
      storageBucket: "asset-usage-test",
      storagePath: `asset-renditions/v1/aa/${"b".repeat(64)}.webp`,
      storageUrl: null,
      sourceSha256: ids.approvedDirectMedia.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
      widthPx: 1280,
      heightPx: 720,
      format: "webp",
      sha256: "b".repeat(64),
      errorCode: null,
      errorMessage: null,
      checkedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const allKeys = [
      { sourceTable: "asset_entities" as const, sourceId: ids.actorPersonal },
      { sourceTable: "asset_entities" as const, sourceId: ids.otherPersonal },
      { sourceTable: "asset_entities" as const, sourceId: ids.approvedCommon },
      { sourceTable: "asset_entities" as const, sourceId: ids.pendingCommon },
      { sourceTable: "asset_entities" as const, sourceId: ids.rejectedCommon },
      { sourceTable: "asset_entities" as const, sourceId: ids.crossMediaCommon },
      { sourceTable: "asset_variants" as const, sourceId: ids.actorVariant },
      { sourceTable: "asset_variants" as const, sourceId: ids.otherVariant },
      { sourceTable: "asset_variants" as const, sourceId: ids.approvedCommonVariant },
      { sourceTable: "asset_variants" as const, sourceId: ids.pendingCommonVariant },
      { sourceTable: "asset_variants" as const, sourceId: ids.pendingEntityVariant },
    ];
    const expectedPersonal = [ids.actorPersonal, ids.actorVariant].sort();
    const expectedCommon = [ids.approvedCommon, ids.approvedCommonVariant, ids.crossMediaCommon].sort();

    const recallIds = async (libraryScope?: "personal" | "common") => (
      await repository.lexicalRecall(marker, {
        actorId,
        ...(libraryScope ? { libraryScope } : {}),
      }, 50)
    ).map((item) => item.sourceId).sort();
    const hydratedIds = async (libraryScope?: "personal" | "common") => (
      await repository.hydrate(allKeys, {
        actorId,
        ...(libraryScope ? { libraryScope } : {}),
      })
    ).map((item) => item.sourceId).sort();

    assert.deepEqual(await recallIds("personal"), expectedPersonal);
    assert.deepEqual(await hydratedIds("personal"), expectedPersonal);
    assert.deepEqual(await recallIds("common"), expectedCommon);
    assert.deepEqual(await hydratedIds("common"), expectedCommon);
    assert.deepEqual(await recallIds(), [...expectedPersonal, ...expectedCommon].sort(), "未传 scope 保留既有混合搜索");
    assert.deepEqual(await hydratedIds(), [...expectedPersonal, ...expectedCommon].sort(), "未传 scope 保留既有混合水合");
    const previewRows = await repository.hydrate([
      { sourceTable: "asset_entities", sourceId: ids.approvedCommon },
      { sourceTable: "asset_entities", sourceId: ids.crossMediaCommon },
    ], { actorId, libraryScope: "common" });
    assert.equal(
      previewRows.find((item) => item.sourceId === ids.approvedCommon)?.sourceFileUrl,
      `https://assets.test/asset-renditions/v1/aa/${"b".repeat(64)}.webp`,
      "未审媒体和待审变体媒体不能抢占已审通用媒体的独立展示变体",
    );
    assert.equal(
      previewRows.find((item) => item.sourceId === ids.crossMediaCommon)?.sourceFileUrl,
      null,
      "跨实体错配的变体媒体不能成为当前资产预览",
    );
  } finally {
    await handle.db.delete(assetMediaRenditions)
      .where(eq(assetMediaRenditions.id, ids.approvedDetailRendition))
      .catch(() => undefined);
    await handle.db.delete(assetMedia).where(inArray(assetMedia.id, [
      ids.approvedDirectMedia,
      ids.unapprovedDirectMedia,
      ids.pendingVariantMedia,
      ids.crossEntityMedia,
    ])).catch(() => undefined);
    await handle.db.delete(assetVariants).where(inArray(assetVariants.id, [
      ids.actorVariant,
      ids.otherVariant,
      ids.approvedCommonVariant,
      ids.pendingCommonVariant,
      ids.pendingEntityVariant,
    ])).catch(() => undefined);
    await handle.db.delete(assetEntities).where(inArray(assetEntities.id, [
      ids.actorPersonal,
      ids.otherPersonal,
      ids.approvedCommon,
      ids.pendingCommon,
      ids.rejectedCommon,
      ids.crossMediaCommon,
    ])).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, [actorId, otherUserId])).catch(() => undefined);
    await handle.pool.end();
  }
});

test("R183 真 PostgreSQL: catalog 3D 预览只接受同资产同变体且已审的精确绑定", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const assetA = randomUUID();
  const assetB = randomUUID();
  const variantA = randomUUID();
  const variantAOther = randomUUID();
  const variantB = randomUUID();
  const modelId = randomUUID();
  const validPreviewId = randomUUID();
  const crossVariantPreviewId = randomUUID();
  const crossEntityPreviewId = randomUUID();
  const unapprovedPreviewId = randomUUID();
  const conflictingModelId = randomUUID();
  const conflictingPreviewId = randomUUID();
  const conflictingImageId = randomUUID();
  const now = new Date("2026-08-04T16:00:00.000Z");
  const modelSha = "a".repeat(64);
  const previewRows = [
    {
      id: validPreviewId,
      variantId: variantA,
      approved: true,
      sha256: "b".repeat(64),
      path: `asset-renditions/v1/aa/${"b".repeat(64)}.webp`,
    },
    {
      id: crossVariantPreviewId,
      variantId: variantAOther,
      approved: true,
      sha256: "c".repeat(64),
      path: `asset-renditions/v1/cc/${"c".repeat(64)}.webp`,
    },
    {
      id: crossEntityPreviewId,
      variantId: variantB,
      approved: true,
      sha256: "d".repeat(64),
      path: `asset-renditions/v1/dd/${"d".repeat(64)}.webp`,
    },
    {
      id: unapprovedPreviewId,
      variantId: variantA,
      approved: false,
      sha256: "e".repeat(64),
      path: `asset-renditions/v1/ee/${"e".repeat(64)}.webp`,
    },
  ];
  try {
    await applyMigrations(handle);
    await handle.db.insert(users).values(userValues(actorId, "r183-catalog-actor", now));
    await handle.db.insert(assetEntities).values([
      assetValues(assetA, null, "common", "R183 资产 A", now),
      assetValues(assetB, null, "common", "R183 资产 B", now),
    ]);
    await handle.db.insert(assetVariants).values([
      variantValuesForTest(variantA, assetA, "R183 A 主变体", now),
      variantValuesForTest(variantAOther, assetA, "R183 A 错变体", now),
      variantValuesForTest(variantB, assetB, "R183 B 变体", now),
    ]);
    await handle.db.insert(assetMedia).values([
      {
        ...mediaValues(conflictingModelId, assetA, now),
        assetEntityId: assetA,
        assetVariantId: variantB,
        mediaKind: "model_3d",
        storagePath: `director-assets/v1/${conflictingModelId}.glb`,
        storageUrl: `https://assets.test/director-assets/v1/${conflictingModelId}.glb`,
        widthPx: null,
        heightPx: null,
        format: "glb",
        sha256: "f".repeat(64),
        isPrimary: true,
        sortOrder: -1000,
        metadata: {},
      },
      {
        ...mediaValues(modelId, assetA, now),
        assetEntityId: null,
        assetVariantId: variantA,
        mediaKind: "model_3d",
        storagePath: `director-assets/v1/${modelId}.glb`,
        storageUrl: `https://assets.test/director-assets/v1/${modelId}.glb`,
        widthPx: null,
        heightPx: null,
        format: "glb",
        sha256: modelSha,
        metadata: {},
      },
      ...previewRows.map((preview, index) => ({
        ...mediaValues(preview.id, assetA, now),
        assetEntityId: null,
        assetVariantId: preview.variantId,
        approved: preview.approved,
        isPrimary: preview.id !== validPreviewId,
        sortOrder: -100 - index,
        sha256: preview.sha256,
        metadata: {
          ...(preview.id === validPreviewId
            ? {
              previewOfAssetMediaId: modelId,
              previewOfSha256: modelSha,
            }
            : {
              role: "director_3d_preview",
              sourceMediaId: modelId,
              sourceSha256: modelSha,
            }),
        },
      })),
      {
        ...mediaValues(conflictingPreviewId, assetA, now),
        assetEntityId: assetA,
        assetVariantId: variantB,
        approved: true,
        isPrimary: false,
        sortOrder: -1000,
        sha256: "1".repeat(64),
        metadata: {
          role: "director_3d_preview",
          sourceMediaId: conflictingModelId,
          sourceSha256: "f".repeat(64),
        },
      },
      {
        ...mediaValues(conflictingImageId, assetA, now),
        assetEntityId: assetA,
        assetVariantId: variantB,
        approved: true,
        isPrimary: true,
        sortOrder: -2000,
        sha256: "2".repeat(64),
        metadata: {},
      },
    ]);
    await handle.db.insert(assetMediaRenditions).values([
      ...previewRows.map((preview) => ({
        id: randomUUID(),
        assetMediaId: preview.id,
        renditionKind: "detail" as const,
        strategy: "stored_object" as const,
        status: "healthy" as const,
        processSpec: null,
        storageBucket: "asset-usage-test",
        storagePath: preview.path,
        storageUrl: null,
        sourceSha256: preview.sha256,
        widthPx: 1280,
        heightPx: 720,
        format: "webp",
        sha256: preview.sha256,
        errorCode: null,
        errorMessage: null,
        checkedAt: now,
        createdAt: now,
        updatedAt: now,
      })),
      {
        id: randomUUID(),
        assetMediaId: conflictingPreviewId,
        renditionKind: "detail",
        strategy: "stored_object",
        status: "healthy",
        processSpec: null,
        storageBucket: "asset-usage-test",
        storagePath: `asset-renditions/v1/11/${"1".repeat(64)}.webp`,
        storageUrl: null,
        sourceSha256: "1".repeat(64),
        widthPx: 1280,
        heightPx: 720,
        format: "webp",
        sha256: "1".repeat(64),
        errorCode: null,
        errorMessage: null,
        checkedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: randomUUID(),
        assetMediaId: conflictingImageId,
        renditionKind: "detail",
        strategy: "stored_object",
        status: "healthy",
        processSpec: null,
        storageBucket: "asset-usage-test",
        storagePath: `asset-renditions/v1/22/${"2".repeat(64)}.webp`,
        storageUrl: null,
        sourceSha256: "2".repeat(64),
        widthPx: 1280,
        heightPx: 720,
        format: "webp",
        sha256: "2".repeat(64),
        errorCode: null,
        errorMessage: null,
        checkedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const catalog = new AssetCatalogService(handle.db);
    const items = await catalog.list(actorId, { scope: "common" });
    const itemA = items.find((item) => item.id === assetA);
    const itemB = items.find((item) => item.id === assetB);
    assert.ok(itemA);
    assert.ok(itemB);
    assert.equal(
      itemA.storageUrl,
      `https://assets.test/${previewRows[0]!.path}`,
      "只有同资产、同变体且已审的精确预览可公开",
    );
    assert.equal(itemB.storageUrl, null, "跨资产伪造绑定不能给另一资产借图");
    assert.doesNotMatch(
      JSON.stringify(itemA),
      new RegExp([
        previewRows[1]!.path,
        previewRows[2]!.path,
        previewRows[3]!.path,
        "asset-renditions/v1/11/",
      ].join("|")),
      "双归属冲突的源和预览即使彼此同 variant、同直接 entity 也必须 fail-closed",
    );
    const versions = await catalog.versions(actorId, assetA);
    assert.equal(
      versions.some((version) =>
        version.id === conflictingModelId || version.id === conflictingImageId
      ),
      false,
      "versions 不能通过直接 entity 的 OR 分支纳入冲突 variant 媒体",
    );
    assert.doesNotMatch(
      JSON.stringify(versions),
      /asset-renditions\/v1\/22\//u,
      "双归属冲突图片的 rendition 不能进入公开 versions 响应",
    );

    const hybrid = new HybridAssetSearchRepository(handle.db);
    const hydrated = await hybrid.hydrate([
      { sourceTable: "asset_entities", sourceId: assetA },
      { sourceTable: "asset_entities", sourceId: assetB },
      { sourceTable: "asset_variants", sourceId: variantA },
    ], { actorId, libraryScope: "common" });
    assert.equal(
      hydrated.find((item) => item.sourceId === assetA)?.sourceFileUrl,
      `https://assets.test/${previewRows[0]!.path}`,
      "实体水合只采用同 owner、同活动变体、已审且精确绑定的 preview",
    );
    assert.equal(
      hydrated.find((item) => item.sourceId === variantA)?.sourceFileUrl,
      `https://assets.test/${previewRows[0]!.path}`,
      "变体水合与实体水合保持相同的精确绑定合同",
    );
    assert.equal(
      hydrated.find((item) => item.sourceId === assetB)?.sourceFileUrl,
      null,
      "跨资产或双归属冲突媒体不能进入另一资产的搜索水合",
    );
    assert.doesNotMatch(
      JSON.stringify(hydrated),
      /asset-renditions\/v1\/(?:11|22)\//u,
      "Hybrid Search 不能经普通图片或 preview 分支泄露双归属冲突 rendition",
    );
  } finally {
    await handle.db.delete(assetMediaRenditions)
      .where(inArray(assetMediaRenditions.assetMediaId, [
        ...previewRows.map((row) => row.id),
        conflictingPreviewId,
        conflictingImageId,
      ]))
      .catch(() => undefined);
    await handle.db.delete(assetMedia)
      .where(inArray(assetMedia.id, [
        modelId,
        conflictingModelId,
        conflictingPreviewId,
        conflictingImageId,
        ...previewRows.map((row) => row.id),
      ]))
      .catch(() => undefined);
    await handle.db.delete(assetVariants)
      .where(inArray(assetVariants.id, [variantA, variantAOther, variantB]))
      .catch(() => undefined);
    await handle.db.delete(assetEntities)
      .where(inArray(assetEntities.id, [assetA, assetB]))
      .catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

test("041 真 PostgreSQL: 历史个人实体、变体和媒体归一且幂等，不碰通用资产与时间戳", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const personalAssetId = randomUUID();
  const commonAssetId = randomUUID();
  const personalVariantId = randomUUID();
  const commonVariantId = randomUUID();
  const personalMediaId = randomUUID();
  const commonMediaId = randomUUID();
  const createdAt = new Date("2026-07-01T00:00:00.000Z");
  const updatedAt = new Date("2026-07-02T00:00:00.000Z");
  try {
    await applyMigrations(handle);
    await handle.db.insert(users).values(userValues(actorId, "personal-review-migration", createdAt));
    await handle.db.insert(assetEntities).values([
      { ...assetValues(personalAssetId, actorId, "personal", "历史个人资产", createdAt), status: "rejected", approved: false, updatedAt },
      { ...assetValues(commonAssetId, null, "common", "历史通用资产", createdAt), status: "pending_review", approved: false, updatedAt },
    ]);
    await handle.db.insert(assetVariants).values([
      {
        id: personalVariantId, assetEntityId: personalAssetId, variantKind: "look", name: "历史个人变体",
        description: null, usageContext: null, visualPrompt: null, approved: null, status: "pending_review",
        isPrimary: false, sortOrder: 0, sourceFileUrl: null, sourceText: null, metadata: {},
        createdAt, updatedAt, deletedAt: null, deletedByUserId: null,
      },
      {
        id: commonVariantId, assetEntityId: commonAssetId, variantKind: "look", name: "历史通用变体",
        description: null, usageContext: null, visualPrompt: null, approved: null, status: "pending_review",
        isPrimary: false, sortOrder: 0, sourceFileUrl: null, sourceText: null, metadata: {},
        createdAt, updatedAt, deletedAt: null, deletedByUserId: null,
      },
    ]);
    await handle.db.insert(assetMedia).values([
      { ...mediaValues(personalMediaId, personalAssetId, createdAt), approved: false },
      { ...mediaValues(commonMediaId, commonAssetId, createdAt), approved: false },
    ]);

    const migration = await readFile(path.resolve("migrations", "041_personal_assets_bypass_review.sql"), "utf8");
    const sql = renderMigrationSql(migration, settings.postgresSchema);
    await handle.pool.query(sql);
    await handle.pool.query(sql);

    const entities = await handle.db.select().from(assetEntities)
      .where(inArray(assetEntities.id, [personalAssetId, commonAssetId]));
    const personalEntity = entities.find((row) => row.id === personalAssetId)!;
    const commonEntity = entities.find((row) => row.id === commonAssetId)!;
    assert.equal(personalEntity.status, "approved");
    assert.equal(personalEntity.approved, true);
    assert.equal(personalEntity.createdAt.toISOString(), createdAt.toISOString());
    assert.equal(personalEntity.updatedAt.toISOString(), updatedAt.toISOString());
    assert.equal(commonEntity.status, "pending_review");
    assert.equal(commonEntity.approved, false);

    const variants = await handle.db.select().from(assetVariants)
      .where(inArray(assetVariants.id, [personalVariantId, commonVariantId]));
    const personalVariant = variants.find((row) => row.id === personalVariantId)!;
    const commonVariant = variants.find((row) => row.id === commonVariantId)!;
    assert.equal(personalVariant.status, "approved");
    assert.equal(personalVariant.approved, true);
    assert.equal(personalVariant.createdAt.toISOString(), createdAt.toISOString());
    assert.equal(personalVariant.updatedAt.toISOString(), updatedAt.toISOString());
    assert.equal(commonVariant.status, "pending_review");
    assert.equal(commonVariant.approved, null);

    const mediaRows = await handle.db.select().from(assetMedia)
      .where(inArray(assetMedia.id, [personalMediaId, commonMediaId]));
    assert.equal(mediaRows.find((row) => row.id === personalMediaId)!.approved, true);
    assert.equal(mediaRows.find((row) => row.id === commonMediaId)!.approved, false);
  } finally {
    await handle.db.delete(assetMedia).where(inArray(assetMedia.id, [personalMediaId, commonMediaId])).catch(() => undefined);
    await handle.db.delete(assetVariants).where(inArray(assetVariants.id, [personalVariantId, commonVariantId])).catch(() => undefined);
    await handle.db.delete(assetEntities).where(inArray(assetEntities.id, [personalAssetId, commonAssetId])).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

test("043 真 PostgreSQL: 登记任务幂等、个人资产事务和任务恢复指针闭环", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const assetId = randomUUID();
  const mediaId = randomUUID();
  const idempotencyKey = randomUUID();
  const tagId = `登记标签-${randomUUID().slice(0, 8)}`;
  const now = new Date("2026-08-02T02:00:00.000Z");
  const tasks = new PostgresAssetUploadTaskRepository(handle.db);
  const registeredImages = new DrizzleRegisteredImageRepository(handle.db);
  const requestSha256 = "a".repeat(64);
  try {
    await applyMigrations(handle);
    await handle.db.insert(users).values(userValues(actorId, "asset-registration", now));
    const first = await tasks.createOrReuse({
      userId: actorId,
      originalFileName: "portrait.png",
      contentType: "image/png",
      assetKindHint: "character",
      clientIdempotencyKey: idempotencyKey,
      contentSha256: "b".repeat(64),
      requestSha256,
      registrationForm: {
        schema_version: "asset-registration-v1",
        dictionary_version: "asset-factor-v0.2",
        name: "真库登记角色",
        description: "正面中性肖像",
        asset_kind: "character",
        factor_type: "face_identity",
        tags: [tagId],
        factor_attributes: { view_type: "front" },
        rights_declaration: {
          source_kind: "self_created",
          contains_real_person: false,
          reference_use_confirmed: true,
        },
      },
      stagedPath: "/tmp/asset-registration-first.png",
      stagedBytes: 128,
    });
    assert.equal(first.created, true);
    // Replace the generated task id only in local variables used below.
    const persistedTaskId = first.task.id;
    const replay = await tasks.createOrReuse({
      userId: actorId,
      originalFileName: "portrait.png",
      contentType: "image/png",
      assetKindHint: "character",
      clientIdempotencyKey: idempotencyKey,
      contentSha256: "b".repeat(64),
      requestSha256,
      registrationForm: first.task.registrationForm,
      stagedPath: "/tmp/asset-registration-replay.png",
      stagedBytes: 128,
    });
    assert.equal(replay.created, false);
    assert.equal(replay.task.id, persistedTaskId);
    await assert.rejects(
      tasks.createOrReuse({
        userId: actorId,
        originalFileName: "other.png",
        contentType: "image/png",
        assetKindHint: "character",
        clientIdempotencyKey: idempotencyKey,
        contentSha256: "c".repeat(64),
        requestSha256: "d".repeat(64),
        registrationForm: first.task.registrationForm,
        stagedPath: "/tmp/asset-registration-conflict.png",
        stagedBytes: 129,
      }),
      (error: unknown) => error instanceof ConflictError && error.code === "idempotency_key_conflict",
    );

    await registeredImages.persist({
      taskId: persistedTaskId,
      actorId,
      assetId,
      mediaId,
      fileName: "portrait.png",
      declaredContentType: "image/png",
      contentSha256: "b".repeat(64),
      image: {
        format: "png",
        extension: "png",
        contentType: "image/png",
        width: 1024,
        height: 1024,
      },
      stored: {
        bucket: "asset-registration-test",
        storagePath: `prod/asset/${assetId}/media/${mediaId}.png`,
        storageUrl: `https://assets.test/${mediaId}.png`,
      },
      form: {
        schemaVersion: "asset-registration-v1",
        dictionaryVersion: "asset-factor-v0.2",
        name: "真库登记角色",
        description: "正面中性肖像",
        assetKind: "character",
        factorType: "face_identity",
        tags: [tagId],
        factorAttributes: { view_type: "front" },
        rightsDeclaration: {
          sourceKind: "self_created",
          containsRealPerson: false,
          referenceUseConfirmed: true,
        },
      },
      inferred: { name: "模型命名不得覆盖", asset_kind: "scene" },
    });

    const [entity] = await handle.db.select().from(assetEntities).where(eq(assetEntities.id, assetId));
    assert.equal(entity?.ownerUserId, actorId);
    assert.equal(entity?.visibility, "personal");
    assert.equal(entity?.status, "approved");
    assert.equal(entity?.approved, true);
    assert.equal(entity?.name, "真库登记角色");
    assert.equal((entity?.metadata.asset_factor as Record<string, unknown>).input_origin, "user_declared");

    const [media] = await handle.db.select().from(assetMedia).where(eq(assetMedia.id, mediaId));
    assert.equal(media?.mediaKind, "image");
    assert.equal(media?.isPrimary, true);
    assert.equal(media?.approved, true);
    const provenance = await handle.db.select().from(mediaProvenanceSubjects)
      .where(eq(mediaProvenanceSubjects.assetMediaId, mediaId));
    assert.equal(provenance[0]?.sourceChannel, "external_upload");
    const links = await handle.db.select().from(assetTags).where(eq(assetTags.assetEntityId, assetId));
    assert.deepEqual(links.map((link) => link.tagId), [tagId]);

    const [task] = await handle.db.select().from(assetUploadTasks).where(eq(assetUploadTasks.id, persistedTaskId));
    assert.equal(task?.resultAssetEntityId, assetId);
    assert.equal(task?.resultAssetMediaId, mediaId);
    assert.equal(task?.resultAssetName, "真库登记角色");
  } finally {
    await handle.db.delete(assetUploadTasks).where(eq(assetUploadTasks.userId, actorId)).catch(() => undefined);
    await handle.db.delete(mediaProvenanceSubjects)
      .where(eq(mediaProvenanceSubjects.assetMediaId, mediaId)).catch(() => undefined);
    await handle.db.delete(assetTags).where(eq(assetTags.assetEntityId, assetId)).catch(() => undefined);
    await handle.db.delete(assetMedia).where(eq(assetMedia.id, mediaId)).catch(() => undefined);
    await handle.db.delete(assetEntities).where(eq(assetEntities.id, assetId)).catch(() => undefined);
    await handle.db.delete(tagVocabulary).where(eq(tagVocabulary.id, tagId)).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

async function applyMigrations(handle: DatabaseHandle): Promise<void> {
  for (const file of ["013_control_packages.sql", "020_vocabulary_and_media_kind_audio.sql"]) {
    const source = await readFile(path.resolve("migrations", file), "utf8");
    await handle.pool.query(renderMigrationSql(source, settings.postgresSchema));
  }
}

function userValues(id: string, username: string, now: Date) {
  return {
    id, username: `${username}-${id.slice(0, 8)}`, displayName: username, passwordHash: "test-only-hash",
    active: true, createdAt: now, updatedAt: now,
  };
}

function projectValues(id: string, ownerUserId: string, name: string, now: Date) {
  return {
    id, ownerUserId, name, description: null, status: "active", createdAt: now, updatedAt: now,
    deletedAt: null, deletedByUserId: null,
  };
}

function episodeValues(id: string, projectId: string, now: Date) {
  return {
    id, projectId, episodeNo: 1, name: "第一集", sortOrder: 0, status: "active", createdAt: now,
    updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function shotValues(id: string, episodeId: string, code: string, now: Date) {
  return {
    id, episodeId, sceneId: null, shotCode: code, title: "使用明细粗剪素材", scriptText: null,
    directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: null, sortOrder: 0,
    referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null,
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function assetValues(id: string, ownerUserId: string | null, visibility: "common" | "personal", name: string, now: Date) {
  return {
    id, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId, visibility,
    assetKind: "character", name, displayName: name, intro: null, appearance: null, ageValue: null, gender: null,
    heightCm: null, hairDescription: null, outfitDescription: null, category: null, styleTags: [], approved: true,
    reuseScope: "all_projects", status: "approved", sourceFileUrl: null, metadata: {}, createdAt: now,
    updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
  };
}

function mediaValues(id: string, assetEntityId: string, now: Date) {
  return {
    id, assetEntityId, assetVariantId: null, mediaKind: "image", viewAngle: "front", title: "使用明细图",
    description: null, storageBucket: "asset-usage-test", storagePath: `assets/${id}.png`,
    storageUrl: `https://assets.test/${id}.png`, widthPx: 1024, heightPx: 1024, format: "png",
    sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64), isPrimary: true, approved: true,
    sortOrder: 0, metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function variantValuesForTest(id: string, assetEntityId: string, name: string, now: Date) {
  return {
    id,
    assetEntityId,
    variantKind: "look",
    name,
    description: null,
    usageContext: null,
    visualPrompt: null,
    approved: true,
    status: "approved",
    isPrimary: false,
    sortOrder: 0,
    sourceFileUrl: null,
    sourceText: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function generationRequestValues(
  id: string,
  projectId: string,
  userId: string,
  referenceMediaIds: string[],
  shotId: string | null,
  now: Date,
) {
  return {
    id, userId, projectId, episodeId: null, sceneId: null, shotId, targetAssetEntityId: null,
    mediaKind: "image", prompt: "asset usage chain test", referenceMediaIds,
    referenceAssetSnapshots: [], parameters: {}, quantity: 1,
    clientIdempotencyKey: `asset-usage-${id}`, requestHash: "d".repeat(64), createdAt: now, updatedAt: now,
  };
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("ASSET_USAGE_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
