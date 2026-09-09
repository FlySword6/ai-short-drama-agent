import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier } from "../src/db/migrate.js";
import {
  assetEntities,
  assetMedia,
  episodes,
  projectMembers,
  projects,
  scenePrepItems,
  scenes,
  shots,
  users,
} from "../src/db/schema.js";
import { ScenePrepRepository } from "../src/modules/prep/repository.js";

const databaseUrl = process.env.PREP_TEST_DATABASE_URL;
const schema = quoteIdentifier(settings.postgresSchema);

test("备戏真 PG：场级提交不碰控制包，全场提交原子写入项目引用与控制包", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const now = new Date("2026-08-02T12:00:00.000Z");
  const actorId = randomUUID();
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const sceneId = randomUUID();
  const shotId = randomUUID();
  const sceneAssetId = randomUUID();
  const sceneMediaId = randomUUID();
  const shotAssetId = randomUUID();
  const shotMediaId = randomUUID();
  try {
    await handle.db.insert(users).values({
      id: actorId,
      username: `prep-${actorId.slice(0, 8)}`,
      displayName: "备戏测试导演",
      passwordHash: "test-only-hash",
      active: true,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(projects).values({
      id: projectId,
      ownerUserId: actorId,
      name: "备戏真库项目",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(projectMembers).values({
      projectId,
      userId: actorId,
      role: "owner",
      addedByUserId: actorId,
      createdAt: now,
    }).onConflictDoNothing();
    await handle.db.insert(episodes).values({
      id: episodeId,
      projectId,
      episodeNo: 1,
      name: "第一集",
      sortOrder: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(scenes).values({
      id: sceneId,
      episodeId,
      sceneNo: 1,
      name: "第一场",
      description: null,
      sortOrder: 1,
      sourceBreakdownRunId: null,
      sourceCandidateId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(shots).values({
      id: shotId,
      episodeId,
      sceneId,
      shotCode: "PREP-01",
      title: "备戏镜头",
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
    });
    await handle.db.insert(assetEntities).values([
      assetValue(sceneAssetId, "场级角色", now),
      assetValue(shotAssetId, "镜头道具", now),
    ]);
    await handle.db.insert(assetMedia).values([
      mediaValue(sceneMediaId, sceneAssetId, now),
      mediaValue(shotMediaId, shotAssetId, now),
    ]);

    const actor = { id: actorId, role: "member" as const };
    const repository = new ScenePrepRepository(handle.db);
    const sceneItem = await repository.pull(actor, sceneId, {
      lane: "character",
      assetEntityId: sceneAssetId,
      assetMediaId: sceneMediaId,
      clientIdempotencyKey: "prep-pull-scene-0001",
    });
    const sceneCommit = await repository.commit(actor, sceneId, {
      itemIds: [sceneItem.id],
      allShots: false,
      clientIdempotencyKey: "prep-commit-scene-0001",
    });
    assert.equal(sceneCommit.mode, "scene");
    assert.equal(sceneCommit.projectAssetRefIds.length, 1);
    assert.deepEqual(sceneCommit.controlPackageRefIds, []);

    const storedSceneItem = (await handle.db.select().from(scenePrepItems)
      .where(eq(scenePrepItems.id, sceneItem.id)).limit(1))[0];
    assert.equal(storedSceneItem?.status, "committed");
    assert.ok(storedSceneItem?.projectAssetRefId, "状态与项目引用必须在同一条 UPDATE 中满足 CHECK");

    const replay = await repository.commit(actor, sceneId, {
      itemIds: [sceneItem.id],
      allShots: false,
      clientIdempotencyKey: "prep-commit-scene-0001",
    });
    assert.equal(replay.commitId, sceneCommit.commitId);
    assert.equal(replay.idempotentReplay, true);

    const shotItem = await repository.pull(actor, sceneId, {
      lane: "prop",
      assetEntityId: shotAssetId,
      assetMediaId: shotMediaId,
      clientIdempotencyKey: "prep-pull-shot-0001",
    });
    const allShotsCommit = await repository.commit(actor, sceneId, {
      itemIds: [shotItem.id],
      allShots: true,
      clientIdempotencyKey: "prep-commit-all-0001",
    });
    assert.equal(allShotsCommit.mode, "all_shots");
    assert.deepEqual(allShotsCommit.shotIds, [shotId]);
    assert.equal(allShotsCommit.controlPackageRefCount, 1);
    const controlRefs = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ${schema}.control_package_refs r
         JOIN ${schema}.control_packages p ON p.id = r.package_id
        WHERE p.shot_id = $1`,
      [shotId],
    );
    assert.equal(controlRefs.rows[0]?.count, "1");
  } finally {
    await handle.pool.end();
  }
});

function assetValue(id: string, name: string, now: Date) {
  return {
    id,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId: null,
    visibility: "common",
    assetKind: "character",
    name,
    displayName: name,
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
  };
}

function mediaValue(id: string, assetEntityId: string, now: Date) {
  return {
    id,
    assetEntityId,
    assetVariantId: null,
    mediaKind: "image",
    viewAngle: "front",
    title: "备戏参考图",
    description: null,
    storageBucket: "prep-test",
    storagePath: `assets/${id}.png`,
    storageUrl: `https://assets.test/${id}.png`,
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: id.replaceAll("-", "").repeat(2).slice(0, 64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata: {},
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}
