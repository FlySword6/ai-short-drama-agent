import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  episodes,
  generationAttempts,
  generationRequests,
  mediaResults,
  projectMembers,
  projectAssetRefs,
  projectReviewPolicies,
  projects,
  shots,
  users,
} from "../src/db/schema.js";
import { ControlPackageRepository } from "../src/modules/control-packages/repository.js";
import { DrizzleAudioVersionRepository } from "../src/modules/audio/repository.js";
import { AudioVersionService } from "../src/modules/audio/service.js";
import { ConflictError, errorBody, ForbiddenError, NotFoundError, UnprocessableEntityError } from "../src/shared/errors.js";

const databaseUrl = process.env.CONTROL_PACKAGES_TEST_DATABASE_URL;
const schema = quoteIdentifier(settings.postgresSchema);

test("control packages: PostgreSQL migration and repository preserve lanes, ownership and idempotency", {
  skip: !databaseUrl,
}, async () => withFixture(async (fixture) => {
  await applyMigrations(fixture.handle);
  const repository = new ControlPackageRepository(fixture.handle.db);
  const now = new Date("2026-07-22T08:00:00.000Z");

  const before = await repository.get(fixture.actorId, fixture.shotId);
  assert.deepEqual(before, emptyPackage(fixture.shotId));
  assert.equal(await controlPackageCount(fixture.handle, fixture.shotId), 0, "空包读取不能写入容器");

  const ready = await repository.setReady(fixture.actorId, fixture.shotId, true);
  assert.equal(ready.ready?.markedBy, fixture.actorId);
  assert.equal(ready.ready?.markedByName, "Control Package Actor");
  assert.ok(ready.ready?.markedAt);
  const packageId = ready.id;
  assert.ok(packageId);

  const unready = await repository.setReady(fixture.actorId, fixture.shotId, false);
  assert.equal(unready.id, packageId, "撤销就绪不应产生第二个控制包");
  assert.equal(unready.ready, null, "ready=false 必须清空人和时间");
  const storedReady = await fixture.handle.pool.query<{
    ready_marked_by: string | null;
    ready_marked_at: Date | null;
  }>(`SELECT ready_marked_by, ready_marked_at FROM ${schema}.control_packages WHERE id = $1`, [packageId]);
  assert.deepEqual(storedReady.rows[0], { ready_marked_by: null, ready_marked_at: null });
  await assert.rejects(
    fixture.handle.pool.query(
      `UPDATE ${schema}.control_packages SET ready_marked_by = $1 WHERE id = $2`,
      [fixture.actorId, packageId],
    ),
    (error: unknown) => postgresCheckViolation(error),
    "数据库必须拒绝只写入就绪责任人而没有时间的半状态",
  );

  const [first, replay] = await Promise.all([
    repository.addRef(fixture.actorId, fixture.shotId, {
      lane: "character",
      assetMediaId: fixture.commonAssetMediaId,
      note: "角色设定图",
    }),
    repository.addRef(fixture.actorId, fixture.shotId, {
      lane: "character",
      assetMediaId: fixture.commonAssetMediaId,
      note: "重放不应重复",
    }),
  ]);
  assert.equal(first.id, replay.id, "同 lane 同 source 并发重放必须收敛到同一参考物");
  assert.equal(await controlRefCount(fixture.handle, packageId), 1);
  assert.equal(first.kind, "asset");
  assert.equal(first.mediaId, fixture.commonAssetMediaId);

  const generated = await repository.addRef(fixture.actorId, fixture.shotId, {
    lane: "reference_video",
    mediaResultId: fixture.ownMediaResultId,
  });
  assert.equal(generated.kind, "generated");
  assert.equal(generated.mediaId, fixture.ownMediaResultId);
  const variantBacked = await repository.addRef(fixture.actorId, fixture.shotId, {
    lane: "camera_motion",
    assetMediaId: fixture.variantAssetMediaId,
  });
  assert.equal(variantBacked.kind, "asset", "只通过 variant 关联实体的合法媒体也应可引用");

  // 音频候选与控制包 audio lane 必须同一事务绑定：candidate 成功插入
  // 引用后才转 selected；selected 不能被另一个包抢走，也不能作为孤儿修复。
  const audioCandidateId = randomUUID();
  const audioDiscardedId = randomUUID();
  const audioSelectedId = randomUUID();
  const audioLockedId = randomUUID();
  const audioGenerationRequestId = randomUUID();
  const audioDiscardedRequestId = randomUUID();
  const audioSelectedRequestId = randomUUID();
  const audioLockedRequestId = randomUUID();
  const audioGenerationAttemptId = randomUUID();
  const audioDiscardedAttemptId = randomUUID();
  const audioSelectedAttemptId = randomUUID();
  const audioLockedAttemptId = randomUUID();
  const audioAssetId = randomUUID();
  const audioAssetMediaId = randomUUID();
  const audioProjectAssetRefId = randomUUID();
  const audioPendingPolicyId = randomUUID();
  const lockedProjectAssetRefId = randomUUID();
  fixture.ephemeralMediaResultIds.push(audioCandidateId, audioDiscardedId, audioSelectedId, audioLockedId);
  fixture.ephemeralGenerationRequestIds.push(
    audioGenerationRequestId, audioDiscardedRequestId, audioSelectedRequestId, audioLockedRequestId,
  );
  fixture.ephemeralGenerationAttemptIds.push(
    audioGenerationAttemptId, audioDiscardedAttemptId, audioSelectedAttemptId, audioLockedAttemptId,
  );
  fixture.ephemeralAssetEntityIds.push(audioAssetId);
  fixture.ephemeralAssetMediaIds.push(audioAssetMediaId);
  fixture.ephemeralProjectAssetRefIds.push(lockedProjectAssetRefId, audioProjectAssetRefId);
  const audioRequests = [
    audioGenerationRequestId, audioDiscardedRequestId, audioSelectedRequestId, audioLockedRequestId,
  ];
  const audioAttempts = [
    audioGenerationAttemptId, audioDiscardedAttemptId, audioSelectedAttemptId, audioLockedAttemptId,
  ];
  await fixture.handle.db.insert(generationRequests).values(audioRequests.map((id) => ({
    ...generationRequestValues(id, fixture.projectId, fixture.actorId, fixture.shotId, now),
    mediaKind: "audio",
    parameters: { original_duration: 5 },
  })));
  await fixture.handle.db.insert(generationAttempts).values(audioAttempts.map((id, index) =>
    generationAttemptValues(id, audioRequests[index]!, now),
  ));
  const candidateAudioResult = audioGeneratedMediaResultValues(
    audioCandidateId, audioGenerationRequestId, audioGenerationAttemptId, fixture.shotId, now,
  );
  await fixture.handle.db.insert(mediaResults).values([
    candidateAudioResult,
    audioGeneratedMediaResultValues(audioDiscardedId, audioDiscardedRequestId, audioDiscardedAttemptId, fixture.shotId, now),
    audioGeneratedMediaResultValues(audioSelectedId, audioSelectedRequestId, audioSelectedAttemptId, fixture.shotId, now),
    audioGeneratedMediaResultValues(audioLockedId, audioLockedRequestId, audioLockedAttemptId, fixture.shotId, now),
  ]);
  await fixture.handle.db.insert(assetEntities).values({
    ...assetValues(audioAssetId, fixture.actorId, "personal", "待审锁定测试声音", now),
    assetKind: "sound",
  });
  await fixture.handle.db.insert(assetMedia).values({
    ...mediaValues(audioAssetMediaId, audioAssetId, now),
    mediaKind: "audio",
    storageBucket: candidateAudioResult.storageBucket,
    storagePath: candidateAudioResult.storagePath,
    storageUrl: candidateAudioResult.storageUrl,
    format: "mp3",
    sha256: candidateAudioResult.sha256,
    widthPx: null,
    heightPx: null,
  });
  // 029 requires every locked version to retain its full asset/media/project
  // reference trio. The control-package test only exercises lifecycle binding,
  // so this fixture supplies a structurally valid locked reference; the audio
  // repository has the separate exact-media/review proof tests.
  await fixture.handle.db.insert(projectAssetRefs).values([
    {
      id: lockedProjectAssetRefId,
      projectId: fixture.projectId,
      assetEntityId: fixture.commonAssetId,
      assetVariantId: null,
      assetMediaId: fixture.commonAssetMediaId,
      versionSnapshot: {},
      createdByUserId: fixture.actorId,
      createdAt: now,
      deletedAt: null,
      deletedByUserId: null,
    },
    {
      id: audioProjectAssetRefId,
      projectId: fixture.projectId,
      assetEntityId: audioAssetId,
      assetVariantId: null,
      assetMediaId: audioAssetMediaId,
      versionSnapshot: {},
      createdByUserId: fixture.actorId,
      createdAt: now,
      deletedAt: null,
      deletedByUserId: null,
    },
  ]);
  await fixture.handle.db.insert(projectReviewPolicies).values({
    id: audioPendingPolicyId,
    projectId: fixture.projectId,
    mediaKind: "audio",
    defaultStrategy: "pending_review",
    updatedByUserId: fixture.actorId,
    reviewerUserId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await fixture.handle.pool.query(`
    INSERT INTO ${schema}.audio_versions
      (id, project_id, media_result_id, status, compliance_metadata, created_by_user_id,
       selected_by_user_id, selected_at, discarded_by_user_id, discarded_at,
       locked_asset_entity_id, locked_asset_media_id, project_asset_ref_id, locked_at,
       created_at, updated_at)
    VALUES
      ($1, $2, $3, 'candidate', '{}'::jsonb, $4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $5, $5),
      ($6, $2, $7, 'discarded', '{}'::jsonb, $4, NULL, NULL, $4, $5, NULL, NULL, NULL, NULL, $5, $5),
      ($8, $2, $9, 'selected', '{}'::jsonb, $4, $4, $5, NULL, NULL, NULL, NULL, NULL, NULL, $5, $5),
      ($10, $2, $11, 'locked', '{}'::jsonb, $4, $4, $5, NULL, NULL, $12, $13, $14, $5, $5, $5)
  `, [
    randomUUID(), fixture.projectId, audioCandidateId, fixture.actorId, now,
    randomUUID(), audioDiscardedId,
    randomUUID(), audioSelectedId,
    randomUUID(), audioLockedId, fixture.commonAssetId, fixture.commonAssetMediaId, lockedProjectAssetRefId,
  ]);
  await assert.rejects(
    repository.addRef(fixture.actorId, fixture.shotId, { lane: "reference_video", mediaResultId: audioCandidateId }),
    (error: unknown) => error instanceof UnprocessableEntityError && /只能放进声音参考栏/.test((error as Error).message),
    "声音素材绝不可绕进其他参考栏",
  );
  await assert.rejects(
    repository.addRef(fixture.actorId, fixture.shotId, { lane: "audio", assetMediaId: fixture.commonAssetMediaId }),
    (error: unknown) => error instanceof UnprocessableEntityError && /声音参考栏只能放声音素材/.test((error as Error).message),
    "非声音素材绝不可绕进声音参考栏",
  );
  const candidateAudio = await repository.addRef(fixture.actorId, fixture.shotId, {
    lane: "audio",
    mediaResultId: audioCandidateId,
  });
  assert.equal(candidateAudio.mediaId, audioCandidateId);
  assert.equal(
    await audioVersionStatus(fixture.handle, audioCandidateId),
    "selected",
    "audio 设为 pending_review 时，候选也必须能显式选入当前片段并在同一事务转为 selected",
  );
  const lifecycle = new AudioVersionService(new DrizzleAudioVersionRepository(fixture.handle.db), () => now);
  await assert.rejects(
    lifecycle.lock(audioCandidateId, {
      lockedAssetEntityId: audioAssetId,
      lockedAssetMediaId: audioAssetMediaId,
      projectAssetRefId: audioProjectAssetRefId,
    }),
    (error: unknown) => error instanceof ConflictError && error.code === "audio_lock_requires_review",
    "临时选入不等于锁定；没有人工声音资产审核事实仍不得锁定",
  );
  assert.equal(
    (await repository.addRef(fixture.actorId, fixture.shotId, { lane: "audio", mediaResultId: audioCandidateId })).id,
    candidateAudio.id,
    "同包重放必须保持已绑定的 selected 音频引用",
  );
  await assert.rejects(
    repository.addRef(fixture.actorId, fixture.shotId, { lane: "audio", mediaResultId: audioDiscardedId }),
    (error: unknown) => error instanceof UnprocessableEntityError && /已废弃/.test((error as Error).message),
    "discarded 音频不可重新绕过选择边界",
  );
  await assert.rejects(
    repository.addRef(fixture.actorId, fixture.shotId, {
      lane: "audio",
      mediaResultId: audioSelectedId,
    }),
    (error: unknown) => error instanceof UnprocessableEntityError && /使用记录不完整/.test((error as Error).message),
    "历史 selected 孤儿不能被静默绑定到当前控制包",
  );
  const lockedAudio = await repository.addRef(fixture.actorId, fixture.shotId, {
    lane: "audio",
    mediaResultId: audioLockedId,
  });
  await repository.deleteRef(fixture.actorId, lockedAudio.id);
  assert.equal(
    await audioVersionStatus(fixture.handle, audioLockedId),
    "locked",
    "移除唯一 audio ref 时不能把 locked 音频退回 candidate",
  );
  const secondShotId = randomUUID();
  await fixture.handle.db.insert(shots).values(shotValues(secondShotId, (await shotEpisodeId(fixture.handle, fixture.shotId)), "CP-02", now));
  try {
    await assert.rejects(
      repository.addRef(fixture.actorId, secondShotId, { lane: "audio", mediaResultId: audioCandidateId }),
      (error: unknown) => error instanceof UnprocessableEntityError && /其他控制包选用/.test((error as Error).message),
      "已被当前片段选中的音频不能被另一个控制包抢占",
    );
  } finally {
    await fixture.handle.pool.query(
      `DELETE FROM ${schema}.control_package_refs WHERE package_id IN (SELECT id FROM ${schema}.control_packages WHERE shot_id = $1)`,
      [secondShotId],
    );
    await fixture.handle.pool.query(`DELETE FROM ${schema}.control_packages WHERE shot_id = $1`, [secondShotId]);
    await fixture.handle.db.delete(shots).where(eq(shots.id, secondShotId));
  }
  await repository.deleteRef(fixture.actorId, candidateAudio.id);
  assert.equal(
    await audioVersionStatus(fixture.handle, audioCandidateId),
    "candidate",
    "删除唯一 audio ref 时必须把 selected 退回 candidate",
  );
  await fixture.handle.db.delete(projectReviewPolicies).where(eq(projectReviewPolicies.id, audioPendingPolicyId));

  await assert.rejects(
    repository.addRef(fixture.actorId, fixture.shotId, {
      lane: "scene",
      assetMediaId: fixture.otherPersonalAssetMediaId,
    }),
    (error: unknown) => error instanceof NotFoundError,
    "他人个人资产必须不可引用",
  );
  await assert.rejects(
    repository.addRef(fixture.editorUserId, fixture.shotId, {
      lane: "scene",
      assetMediaId: fixture.otherPersonalAssetMediaId,
    }),
    (error: unknown) => error instanceof NotFoundError,
    "editor 也不能引用未进入项目的协作者个人资产",
  );
  const collaboratorSiblingMediaId = randomUUID();
  const collaboratorProjectRefId = randomUUID();
  fixture.ephemeralAssetMediaIds.push(collaboratorSiblingMediaId);
  fixture.ephemeralProjectAssetRefIds.push(collaboratorProjectRefId);
  await fixture.handle.db.insert(assetMedia).values({
    ...mediaValues(collaboratorSiblingMediaId, fixture.otherPersonalAssetId, now),
    title: "未锁定的协作者同资产媒体",
    sortOrder: 1,
    isPrimary: false,
  });
  await fixture.handle.db.insert(projectAssetRefs).values({
    id: collaboratorProjectRefId,
    projectId: fixture.projectId,
    assetEntityId: fixture.otherPersonalAssetId,
    assetVariantId: null,
    assetMediaId: fixture.otherPersonalAssetMediaId,
    versionSnapshot: {},
    createdByUserId: fixture.actorId,
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  });
  const collaboratorRef = await repository.addRef(fixture.editorUserId, fixture.shotId, {
    lane: "scene",
    assetMediaId: fixture.otherPersonalAssetMediaId,
  });
  await repository.deleteRef(fixture.editorUserId, collaboratorRef.id);
  await assert.rejects(
    repository.addRef(fixture.editorUserId, fixture.shotId, {
      lane: "scene",
      assetMediaId: collaboratorSiblingMediaId,
    }),
    (error: unknown) => error instanceof NotFoundError,
    "精确媒体锁不能让 editor 看到同资产的其他媒体",
  );
  await assert.rejects(
    repository.addRef(fixture.actorId, fixture.shotId, {
      lane: "reference_video",
      mediaResultId: fixture.otherProjectMediaResultId,
    }),
    (error: unknown) => error instanceof NotFoundError,
    "别的项目生成产物必须不可引用",
  );
  await assert.rejects(
    repository.addRef(fixture.actorId, fixture.shotId, {
      lane: "reference_video",
      mediaResultId: fixture.conflictingProjectMediaResultId,
    }),
    (error: unknown) => error instanceof NotFoundError,
    "带 generation request 的产物必须以 request.project_id 为权威，不能借 shot 归属越权",
  );

  // Control packages share the project capability matrix: owner/editor create,
  // viewer reads only, platform admin writes globally, and operator observes
  // globally but cannot mutate. A non-member must receive the same 404 as a
  // missing project so this route never reveals a project through a ref id.
  await repository.get(fixture.actorId, fixture.shotId);
  const editorReady = await repository.setReady(fixture.editorUserId, fixture.shotId, true);
  assert.equal(editorReady.ready?.markedBy, fixture.editorUserId, "editor 必须能写入人工就绪标记");
  await repository.get(fixture.editorUserId, fixture.shotId);
  const editorRef = await repository.addRef(fixture.editorUserId, fixture.shotId, {
    lane: "lighting",
    assetMediaId: fixture.commonAssetMediaId,
  });
  await repository.deleteRef(fixture.editorUserId, editorRef.id);

  await repository.get(fixture.viewerUserId, fixture.shotId);
  await assert.rejects(
    repository.setReady(fixture.viewerUserId, fixture.shotId, true),
    (error: unknown) => error instanceof ForbiddenError,
    "viewer 已知项目但无创建权限时只能收到 403，不能获得额外对象信息",
  );
  await assert.rejects(
    repository.addRef(fixture.viewerUserId, fixture.shotId, {
      lane: "lighting",
      assetMediaId: fixture.commonAssetMediaId,
    }),
    (error: unknown) => error instanceof ForbiddenError,
    "viewer 不能挂入控制包参考物",
  );

  const adminActor = { id: fixture.adminUserId, role: "admin" as const };
  await repository.get(adminActor, fixture.shotId);
  const adminReady = await repository.setReady(adminActor, fixture.shotId, true);
  assert.equal(adminReady.ready?.markedBy, fixture.adminUserId, "admin 必须能跨项目写入");

  const operatorActor = { id: fixture.operatorUserId, role: "operator" as const };
  await repository.get(operatorActor, fixture.shotId);
  await assert.rejects(
    repository.setReady(operatorActor, fixture.shotId, true),
    (error: unknown) => error instanceof ForbiddenError,
    "operator 只能读取，不能写控制包",
  );
  await assert.rejects(
    repository.deleteRef(operatorActor, first.id),
    (error: unknown) => error instanceof ForbiddenError,
    "operator 不能通过参考物 ID 绕过只读矩阵",
  );

  const inaccessibleShotError = await captureError(() => repository.get(fixture.otherUserId, fixture.shotId));
  const missingShotError = await captureError(() => repository.get(fixture.actorId, randomUUID()));
  assert.ok(hiddenShotNotFound(inaccessibleShotError), "非成员读取必须隐藏为 404");
  assert.ok(hiddenShotNotFound(missingShotError), "不存在分镜必须隐藏为 404");
  assert.deepEqual(
    errorBody(inaccessibleShotError),
    errorBody(missingShotError),
    "真实 PG: 无权与不存在分镜的错误响应体必须完全相同",
  );
  await assert.rejects(
    repository.setReady(fixture.otherUserId, fixture.shotId, true),
    hiddenShotNotFound,
    "非成员写入必须隐藏为 404",
  );
  const inaccessibleRefError = await captureError(() => repository.deleteRef(fixture.otherUserId, first.id));
  const missingRefError = await captureError(() => repository.deleteRef(fixture.actorId, randomUUID()));
  assert.ok(hiddenControlRefNotFound(inaccessibleRefError), "非成员通过 ref id 删除也不能探测项目存在");
  assert.ok(hiddenControlRefNotFound(missingRefError), "不存在参考物必须隐藏为 404");
  assert.deepEqual(
    errorBody(inaccessibleRefError),
    errorBody(missingRefError),
    "真实 PG: 无权与不存在参考物的错误响应体必须完全相同",
  );

  await repository.deleteRef(fixture.actorId, first.id);
  assert.equal(await controlRefCount(fixture.handle, packageId), 2, "DELETE 只能摘除目标参考物");
  await assert.rejects(
    repository.deleteRef(fixture.actorId, first.id),
    (error: unknown) => error instanceof NotFoundError,
  );

  await assert.rejects(
    repository.addRef(fixture.actorId, fixture.shotId, {
      lane: "not_a_lane",
      assetMediaId: fixture.commonAssetMediaId,
    }),
    (error: unknown) => error instanceof UnprocessableEntityError,
    "未在词表登记的 lane 必须被词表校验以 422 拦下(先于数据库 FK)",
  );

  const customLaneId = `weather-${fixture.actorId.slice(0, 8)}`;
  await fixture.handle.pool.query(
    `INSERT INTO ${schema}.reference_lane_vocabulary (id, display_name, domain, pick_kind, sort, active)
     VALUES ($1, '天气', 'entity', NULL, 90, true)`,
    [customLaneId],
  );
  const customLaneRef = await repository.addRef(fixture.actorId, fixture.shotId, {
    lane: customLaneId,
    assetMediaId: fixture.commonAssetMediaId,
    note: "开放词表:登记后即可挂栏",
  });
  assert.equal(customLaneRef.kind, "asset", "词表登记的新 lane 必须立即可用");
  const withCustomLane = await repository.get(fixture.actorId, fixture.shotId);
  assert.equal(withCustomLane.lanes[customLaneId]?.length, 1, "读取时必须按动态 lane 键分组");

  await assert.rejects(
    fixture.handle.pool.query(`
      INSERT INTO ${schema}.control_package_refs
        (id, package_id, lane, asset_media_id, media_result_id, sort_order)
      VALUES ($1, $2, 'not_a_lane', $3, NULL, 0)
    `, [randomUUID(), packageId, fixture.commonAssetMediaId]),
    (error: unknown) => postgresForeignKeyViolation(error),
    "数据库必须以 FK 拒绝未登记 lane(020 后 lane 是 FK 不再是 CHECK)",
  );
  await assert.rejects(
    fixture.handle.pool.query(`
      INSERT INTO ${schema}.control_package_refs
        (id, package_id, lane, asset_media_id, media_result_id, sort_order)
      VALUES ($1, $2, 'prop', NULL, NULL, 0)
    `, [randomUUID(), packageId]),
    (error: unknown) => postgresCheckViolation(error),
    "数据库必须拒绝没有来源的引用",
  );
  await assert.rejects(
    fixture.handle.pool.query(`
      INSERT INTO ${schema}.control_package_refs
        (id, package_id, lane, asset_media_id, media_result_id, sort_order)
      VALUES ($1, $2, 'prop', $3, $4, 0)
    `, [randomUUID(), packageId, fixture.commonAssetMediaId, fixture.ownMediaResultId]),
    (error: unknown) => postgresCheckViolation(error),
    "数据库必须拒绝同时引用库存资产与生成产物",
  );

  // 待审资产挂栏校验(bug 账 A 裁决:检索可见可看不可用,未过审 422 人话)
  const reviewNow = new Date("2026-07-22T09:00:00.000Z");
  const pendingAssetId = randomUUID();
  const pendingAssetMediaId = randomUUID();
  const rejectedAssetId = randomUUID();
  const rejectedAssetMediaId = randomUUID();
  const pendingProjectRefId = randomUUID();
  const rejectedProjectRefId = randomUUID();
  const strictPolicyId = randomUUID();
  try {
    await fixture.handle.db.insert(assetEntities).values([
      { ...assetValues(pendingAssetId, null, "common", "待审角色", reviewNow), status: "pending_review" },
      { ...assetValues(rejectedAssetId, null, "common", "被拒角色", reviewNow), status: "rejected" },
    ]);
    await fixture.handle.db.insert(assetMedia).values([
      mediaValues(pendingAssetMediaId, pendingAssetId, reviewNow),
      mediaValues(rejectedAssetMediaId, rejectedAssetId, reviewNow),
    ]);
    await fixture.handle.db.insert(projectAssetRefs).values([
      {
        id: pendingProjectRefId,
        projectId: fixture.projectId,
        assetEntityId: pendingAssetId,
        assetVariantId: null,
        assetMediaId: pendingAssetMediaId,
        versionSnapshot: {},
        createdByUserId: fixture.actorId,
        createdAt: reviewNow,
        deletedAt: null,
        deletedByUserId: null,
      },
      {
        id: rejectedProjectRefId,
        projectId: fixture.projectId,
        assetEntityId: rejectedAssetId,
        assetVariantId: null,
        assetMediaId: rejectedAssetMediaId,
        versionSnapshot: {},
        createdByUserId: fixture.actorId,
        createdAt: reviewNow,
        deletedAt: null,
        deletedByUserId: null,
      },
    ]);
    await assert.rejects(
      repository.addRef(fixture.actorId, fixture.shotId, {
        lane: "prop",
        assetMediaId: pendingAssetMediaId,
      }),
      (error: unknown) => error instanceof UnprocessableEntityError
        && /尚未通过审核/.test((error as Error).message),
      "待审核资产必须被 422 拦下并说明审核状态",
    );
    await assert.rejects(
      repository.addRef(fixture.actorId, fixture.shotId, {
        lane: "prop",
        assetMediaId: rejectedAssetMediaId,
      }),
      (error: unknown) => error instanceof UnprocessableEntityError
        && /已拒绝/.test((error as Error).message),
      "已拒绝资产必须被 422 拦下并说明审核状态",
    );

    // 严格策略下 needs_review 产物同样不可挂栏;缺策略行=automatic(既有断言已证放行)
    await fixture.handle.db.insert(projectReviewPolicies).values({
      id: strictPolicyId,
      projectId: fixture.projectId,
      mediaKind: "image",
      defaultStrategy: "pending_review",
      updatedByUserId: fixture.actorId,
      reviewerUserId: null,
      version: 1,
      createdAt: reviewNow,
      updatedAt: reviewNow,
    });
    await assert.rejects(
      repository.addRef(fixture.actorId, fixture.shotId, {
        lane: "prop",
        mediaResultId: fixture.ownMediaResultId,
      }),
      (error: unknown) => error instanceof UnprocessableEntityError
        && /尚未通过审核/.test((error as Error).message),
      "严格审核策略下 needs_review 产物必须被 422 拦下",
    );
  } finally {
    await fixture.handle.db.delete(projectReviewPolicies).where(eq(projectReviewPolicies.id, strictPolicyId)).catch(() => undefined);
    await fixture.handle.db.delete(projectAssetRefs)
      .where(inArray(projectAssetRefs.id, [pendingProjectRefId, rejectedProjectRefId]))
      .catch(() => undefined);
    await fixture.handle.db.delete(assetMedia).where(inArray(assetMedia.id, [pendingAssetMediaId, rejectedAssetMediaId])).catch(() => undefined);
    await fixture.handle.db.delete(assetEntities).where(inArray(assetEntities.id, [pendingAssetId, rejectedAssetId])).catch(() => undefined);
  }
  await fixture.handle.pool.query(
    `DELETE FROM ${schema}.control_package_refs WHERE media_result_id = ANY($1::uuid[])`,
    [[audioCandidateId, audioDiscardedId, audioSelectedId, audioLockedId]],
  );
  await fixture.handle.db.delete(mediaResults).where(inArray(mediaResults.id, [
    audioCandidateId, audioDiscardedId, audioSelectedId, audioLockedId,
  ]));
  await fixture.handle.db.delete(projectAssetRefs).where(inArray(projectAssetRefs.id, fixture.ephemeralProjectAssetRefIds));
  await fixture.handle.db.delete(generationAttempts).where(inArray(generationAttempts.id, fixture.ephemeralGenerationAttemptIds));
  await fixture.handle.db.delete(generationRequests).where(inArray(generationRequests.id, fixture.ephemeralGenerationRequestIds));
  await fixture.handle.db.delete(assetMedia).where(inArray(assetMedia.id, fixture.ephemeralAssetMediaIds));
  await fixture.handle.db.delete(assetEntities).where(inArray(assetEntities.id, fixture.ephemeralAssetEntityIds));
}));

interface Fixture {
  handle: DatabaseHandle;
  actorId: string;
  otherUserId: string;
  editorUserId: string;
  viewerUserId: string;
  adminUserId: string;
  operatorUserId: string;
  projectId: string;
  shotId: string;
  commonAssetId: string;
  commonAssetMediaId: string;
  otherPersonalAssetId: string;
  otherPersonalAssetMediaId: string;
  variantAssetId: string;
  variantId: string;
  variantAssetMediaId: string;
  ownMediaResultId: string;
  otherProjectMediaResultId: string;
  conflictingProjectRequestId: string;
  conflictingProjectAttemptId: string;
  conflictingProjectMediaResultId: string;
  ephemeralMediaResultIds: string[];
  ephemeralProjectAssetRefIds: string[];
  ephemeralGenerationRequestIds: string[];
  ephemeralGenerationAttemptIds: string[];
  ephemeralAssetEntityIds: string[];
  ephemeralAssetMediaIds: string[];
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const otherUserId = randomUUID();
  const editorUserId = randomUUID();
  const viewerUserId = randomUUID();
  const adminUserId = randomUUID();
  const operatorUserId = randomUUID();
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const shotId = randomUUID();
  const otherProjectId = randomUUID();
  const otherEpisodeId = randomUUID();
  const otherShotId = randomUUID();
  const commonAssetId = randomUUID();
  const commonAssetMediaId = randomUUID();
  const otherPersonalAssetId = randomUUID();
  const otherPersonalAssetMediaId = randomUUID();
  const variantAssetId = randomUUID();
  const variantId = randomUUID();
  const variantAssetMediaId = randomUUID();
  const ownMediaResultId = randomUUID();
  const otherProjectMediaResultId = randomUUID();
  const conflictingProjectRequestId = randomUUID();
  const conflictingProjectAttemptId = randomUUID();
  const conflictingProjectMediaResultId = randomUUID();
  const now = new Date("2026-07-22T08:00:00.000Z");
  const fixture: Fixture = {
    handle,
    actorId,
    otherUserId,
    editorUserId,
    viewerUserId,
    adminUserId,
    operatorUserId,
    projectId,
    shotId,
    commonAssetId,
    commonAssetMediaId,
    otherPersonalAssetId,
    otherPersonalAssetMediaId,
    variantAssetId,
    variantId,
    variantAssetMediaId,
    ownMediaResultId,
    otherProjectMediaResultId,
    conflictingProjectRequestId,
    conflictingProjectAttemptId,
    conflictingProjectMediaResultId,
    ephemeralMediaResultIds: [],
    ephemeralProjectAssetRefIds: [],
    ephemeralGenerationRequestIds: [],
    ephemeralGenerationAttemptIds: [],
    ephemeralAssetEntityIds: [],
    ephemeralAssetMediaIds: [],
  };
  try {
    await handle.db.insert(users).values([
      userValues(actorId, "control-package-actor", "Control Package Actor", now),
      userValues(otherUserId, "control-package-other", "Control Package Other", now),
      userValues(editorUserId, "control-package-editor", "Control Package Editor", now),
      userValues(viewerUserId, "control-package-viewer", "Control Package Viewer", now),
      userValues(adminUserId, "control-package-admin", "Control Package Admin", now, "admin"),
      userValues(operatorUserId, "control-package-operator", "Control Package Operator", now, "operator"),
    ]);
    await handle.db.insert(projects).values([
      projectValues(projectId, actorId, "Control Package Project", now),
      projectValues(otherProjectId, otherUserId, "Other Control Package Project", now),
    ]);
    await handle.db.insert(episodes).values([
      episodeValues(episodeId, projectId, now),
      episodeValues(otherEpisodeId, otherProjectId, now),
    ]);
    await handle.db.insert(shots).values([
      shotValues(shotId, episodeId, "CP-01", now),
      shotValues(otherShotId, otherEpisodeId, "CP-OTHER-01", now),
    ]);
    await handle.db.insert(projectMembers).values([
      { projectId, userId: editorUserId, role: "editor", addedByUserId: actorId, createdAt: now },
      { projectId, userId: viewerUserId, role: "viewer", addedByUserId: actorId, createdAt: now },
    ]);
    await handle.db.insert(assetEntities).values([
      assetValues(commonAssetId, null, "common", "Control Package Common", now),
      assetValues(otherPersonalAssetId, otherUserId, "personal", "Other Personal", now),
      assetValues(variantAssetId, actorId, "personal", "Variant Backed Personal", now),
    ]);
    await handle.db.insert(assetVariants).values({
      id: variantId,
      assetEntityId: variantAssetId,
      variantKind: "motion", name: "动作变体", description: null, usageContext: null, visualPrompt: null,
      approved: true, status: "approved", isPrimary: true, sortOrder: 0, sourceFileUrl: null,
      sourceText: null, metadata: {}, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(assetMedia).values([
      mediaValues(commonAssetMediaId, commonAssetId, now),
      mediaValues(otherPersonalAssetMediaId, otherPersonalAssetId, now),
      { ...mediaValues(variantAssetMediaId, variantAssetId, now), assetEntityId: null, assetVariantId: variantId },
    ]);
    await handle.db.insert(mediaResults).values([
      mediaResultValues(ownMediaResultId, shotId, commonAssetMediaId, actorId, now),
      mediaResultValues(otherProjectMediaResultId, otherShotId, commonAssetMediaId, otherUserId, now),
    ]);
    await handle.db.insert(generationRequests).values(generationRequestValues(
      conflictingProjectRequestId,
      otherProjectId,
      otherUserId,
      shotId,
      now,
    ));
    await handle.db.insert(generationAttempts).values(generationAttemptValues(
      conflictingProjectAttemptId,
      conflictingProjectRequestId,
      now,
    ));
    await handle.db.insert(mediaResults).values(generatedMediaResultValues(
      conflictingProjectMediaResultId,
      conflictingProjectRequestId,
      conflictingProjectAttemptId,
      shotId,
      now,
    ));

    await run(fixture);
  } finally {
    await handle.pool.query(`DELETE FROM ${schema}.control_package_refs WHERE package_id IN (SELECT id FROM ${schema}.control_packages WHERE shot_id IN ($1, $2))`, [shotId, otherShotId]).catch(() => undefined);
    await handle.pool.query(`DELETE FROM ${schema}.control_packages WHERE shot_id IN ($1, $2)`, [shotId, otherShotId]).catch(() => undefined);
    await handle.pool.query(`DELETE FROM ${schema}.reference_lane_vocabulary WHERE id LIKE 'weather-%'`).catch(() => undefined);
    await handle.db.delete(mediaResults).where(inArray(mediaResults.id, [
      ownMediaResultId, otherProjectMediaResultId, conflictingProjectMediaResultId, ...fixture.ephemeralMediaResultIds,
    ])).catch(() => undefined);
    await handle.db.delete(projectAssetRefs).where(inArray(projectAssetRefs.id, fixture.ephemeralProjectAssetRefIds)).catch(() => undefined);
    await handle.db.delete(generationAttempts).where(inArray(generationAttempts.id, [
      conflictingProjectAttemptId,
      ...fixture.ephemeralGenerationAttemptIds,
    ])).catch(() => undefined);
    await handle.db.delete(generationRequests).where(inArray(generationRequests.id, [
      conflictingProjectRequestId,
      ...fixture.ephemeralGenerationRequestIds,
    ])).catch(() => undefined);
    await handle.db.delete(assetMedia).where(inArray(assetMedia.id, [
      commonAssetMediaId,
      otherPersonalAssetMediaId,
      variantAssetMediaId,
      ...fixture.ephemeralAssetMediaIds,
    ])).catch(() => undefined);
    await handle.db.delete(assetVariants).where(eq(assetVariants.id, variantId)).catch(() => undefined);
    await handle.db.delete(assetEntities).where(inArray(assetEntities.id, [
      commonAssetId,
      otherPersonalAssetId,
      variantAssetId,
      ...fixture.ephemeralAssetEntityIds,
    ])).catch(() => undefined);
    await handle.db.delete(shots).where(inArray(shots.id, [shotId, otherShotId])).catch(() => undefined);
    await handle.db.delete(episodes).where(inArray(episodes.id, [episodeId, otherEpisodeId])).catch(() => undefined);
    await handle.db.delete(projects).where(inArray(projects.id, [projectId, otherProjectId])).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, [
      actorId, otherUserId, editorUserId, viewerUserId, adminUserId, operatorUserId,
    ])).catch(() => undefined);
    await handle.pool.end();
  }
}

async function applyMigrations(handle: DatabaseHandle): Promise<void> {
  for (const file of [
    "013_control_packages.sql",
    "020_vocabulary_and_media_kind_audio.sql",
    "029_sound_workshop.sql",
  ]) {
    const source = await readFile(path.resolve("migrations", file), "utf8");
    await handle.pool.query(renderMigrationSql(source, settings.postgresSchema));
  }
}

async function controlPackageCount(handle: DatabaseHandle, shotId: string): Promise<number> {
  const result = await handle.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${schema}.control_packages WHERE shot_id = $1`,
    [shotId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function controlRefCount(handle: DatabaseHandle, packageId: string): Promise<number> {
  const result = await handle.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${schema}.control_package_refs WHERE package_id = $1`,
    [packageId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function audioVersionStatus(handle: DatabaseHandle, mediaResultId: string): Promise<string | null> {
  const result = await handle.pool.query<{ status: string }>(
    `SELECT status FROM ${schema}.audio_versions WHERE media_result_id = $1`,
    [mediaResultId],
  );
  return result.rows[0]?.status ?? null;
}

async function shotEpisodeId(handle: DatabaseHandle, shotId: string): Promise<string> {
  const result = await handle.pool.query<{ episode_id: string }>(
    `SELECT episode_id FROM ${schema}.shots WHERE id = $1`,
    [shotId],
  );
  const episodeId = result.rows[0]?.episode_id;
  assert.ok(episodeId, "测试片段必须存在");
  return episodeId;
}

function emptyPackage(shotId: string) {
  return {
    id: null,
    shotId,
    ready: null,
    lanes: { character: [], scene: [], prop: [], camera_motion: [], reference_video: [], audio: [] },
  };
}

function userValues(
  id: string,
  username: string,
  displayName: string,
  now: Date,
  role: "admin" | "operator" | "member" = "member",
) {
  return { id, username: `${username}-${id.slice(0, 8)}`, displayName, passwordHash: "test-only-hash", active: true, role, createdAt: now, updatedAt: now };
}

function hiddenShotNotFound(error: unknown): boolean {
  return error instanceof NotFoundError
    && error.message === "粗剪素材不存在或你没有访问权限";
}

function hiddenControlRefNotFound(error: unknown): boolean {
  return error instanceof NotFoundError
    && error.message === "控制包参考物不存在或你没有访问权限";
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail("预期操作失败，但实际成功");
}

function projectValues(id: string, ownerUserId: string, name: string, now: Date) {
  return { id, ownerUserId, name, description: null, status: "active", createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null };
}

function episodeValues(id: string, projectId: string, now: Date) {
  return { id, projectId, episodeNo: 1, name: "第一集", sortOrder: 0, status: "active", createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null };
}

function shotValues(id: string, episodeId: string, code: string, now: Date) {
  return {
    id, episodeId, sceneId: null, shotCode: code, title: "控制包粗剪素材", scriptText: null,
    directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: null, sortOrder: 0,
    referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null,
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function assetValues(id: string, ownerUserId: string | null, visibility: "common" | "personal", name: string, now: Date) {
  return {
    id, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId, visibility,
    assetKind: "keyframe", name, displayName: name, intro: null, appearance: null, ageValue: null, gender: null,
    heightCm: null, hairDescription: null, outfitDescription: null, category: null, styleTags: [], approved: true,
    reuseScope: "all_projects", status: "approved", sourceFileUrl: null, metadata: {}, createdAt: now,
    updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
  };
}

function mediaValues(id: string, assetEntityId: string, now: Date) {
  return {
    id, assetEntityId, assetVariantId: null, mediaKind: "image", viewAngle: "front", title: "控制包图", description: null,
    storageBucket: "control-package-test", storagePath: `assets/${id}.png`, storageUrl: `https://assets.test/${id}.png`,
    widthPx: 1024, heightPx: 1024, format: "png", sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    isPrimary: true, approved: true, sortOrder: 0, metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function mediaResultValues(id: string, shotId: string, sourceAssetMediaId: string, registeredByUserId: string, now: Date) {
  return {
    id, requestId: null, attemptId: null, shotId, originKind: "asset_media", sourceAssetMediaId, registeredByUserId,
    mediaKind: "image", resultIndex: 0, providerResultKey: null, providerUrl: null, providerUrlExpiresAt: null,
    persistenceStatus: "persisted", storageBucket: "control-package-test", storagePath: `results/${id}.png`,
    storageUrl: `https://assets.test/results/${id}.png`, sha256: id.replaceAll("-", "").padEnd(64, "1").slice(0, 64),
    mimeType: "image/png", widthPx: 1024, heightPx: 1024, durationSeconds: null, reviewStatus: "needs_review",
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function audioGeneratedMediaResultValues(id: string, requestId: string, attemptId: string, shotId: string, now: Date) {
  return {
    ...generatedMediaResultValues(id, requestId, attemptId, shotId, now),
    mediaKind: "audio",
    storagePath: `results/${id}.mp3`,
    storageUrl: `https://assets.test/results/${id}.mp3`,
    mimeType: "audio/mpeg",
    widthPx: null,
    heightPx: null,
    durationSeconds: 5,
  };
}

function generationRequestValues(id: string, projectId: string, userId: string, shotId: string, now: Date) {
  return {
    id, userId, projectId, episodeId: null, sceneId: null, shotId, targetAssetEntityId: null,
    mediaKind: "video", prompt: "cross-project authority test", referenceMediaIds: [],
    referenceAssetSnapshots: [], parameters: {}, quantity: 1,
    clientIdempotencyKey: `control-package-${id}`, requestHash: "c".repeat(64), createdAt: now, updatedAt: now,
  };
}

function generationAttemptValues(id: string, requestId: string, now: Date) {
  return {
    id, requestId, attemptNo: 1, retryIdempotencyKey: null, provider: "test", providerTaskId: `task-${id}`,
    model: "control-package-test", parameters: {}, quantity: 1, status: "succeeded", phase: "complete",
    providerStatus: "succeeded", providerResponse: {}, errorCode: null, errorMessage: null, retryable: false,
    estimatedCostFen: 0, actualCostFen: 0, actualCostStatus: "confirmed", pricingRuleId: null,
    priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: now, leaseOwner: null,
    leaseUntil: null, submittedAt: now, startedAt: now, finishedAt: now, createdAt: now, updatedAt: now,
  };
}

function generatedMediaResultValues(id: string, requestId: string, attemptId: string, shotId: string, now: Date) {
  return {
    id, requestId, attemptId, shotId, originKind: "generation", sourceAssetMediaId: null, registeredByUserId: null,
    mediaKind: "video", resultIndex: 0, providerResultKey: `result-${id}`, providerUrl: null,
    providerUrlExpiresAt: null, persistenceStatus: "persisted", storageBucket: "control-package-test",
    storagePath: `results/${id}.mp4`, storageUrl: `https://assets.test/results/${id}.mp4`,
    sha256: id.replaceAll("-", "").padEnd(64, "2").slice(0, 64), mimeType: "video/mp4",
    widthPx: 720, heightPx: 1280, durationSeconds: 4, reviewStatus: "needs_review", createdAt: now,
    updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function postgresCheckViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23514";
}

function postgresForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503";
}
