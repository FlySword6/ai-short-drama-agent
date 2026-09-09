import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import {
  assetEntities,
  episodes,
  projectAssetRefs,
  projectMembers,
  projects,
  scenes,
  shots,
  users,
} from "../src/db/schema.js";
import { DrizzleCommandPaletteRepository } from "../src/modules/command-palette/repository.js";

/**
 * 真 PostgreSQL 验证 ⌘K 命令面板搜索(S30)的服务端可见性兜底:member 只命中
 * 自己 owner/成员的项目链,admin 全可见;软删除行不命中;LIKE 通配符被转义;
 * 项目资产按实体去重。连接串只允许本机或本地 Compose,拒绝云 RDS。
 */
const requestedDatabaseUrl = process.env.COMMAND_PALETTE_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;

test("command palette search: 可见性兜底、软删除过滤、通配符转义、资产去重", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const repository = new DrizzleCommandPaletteRepository(handle.db);
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const outsiderId = randomUUID();
  const adminId = randomUUID();
  const ownProjectId = randomUUID();
  const memberProjectId = randomUUID();
  const foreignProjectId = randomUUID();
  const episodeId = randomUUID();
  const foreignEpisodeId = randomUUID();
  const sceneId = randomUUID();
  const shotId = randomUUID();
  const deletedShotId = randomUUID();
  const assetId = randomUUID();
  const refId = randomUUID();
  const refId2 = randomUUID();
  const now = new Date("2026-07-26T09:00:00.000Z");
  try {
    await handle.db.insert(users).values([
      userValues(ownerId, "cp-owner", "member", now),
      userValues(memberId, "cp-member", "member", now),
      userValues(outsiderId, "cp-outsider", "member", now),
      userValues(adminId, "cp-admin", "admin", now),
    ]);
    await handle.db.insert(projects).values([
      projectValues(ownProjectId, ownerId, "夜航西飞", now),
      projectValues(memberProjectId, outsiderId, "夜探剧组", now),
      projectValues(foreignProjectId, outsiderId, "夜色深处", now),
    ]);
    // member 是 memberProjectId 的 editor;ownProjectId 靠 owner 兜底可见;
    // foreignProjectId 与 member 无关,member 搜索不得命中。
    await handle.db.insert(projectMembers).values({
      projectId: memberProjectId, userId: memberId, role: "editor",
      addedByUserId: outsiderId, createdAt: now,
    });
    await handle.db.insert(episodes).values([
      { ...episodeValues(episodeId, ownProjectId, 1, "夜航第一集", now) },
      { ...episodeValues(foreignEpisodeId, foreignProjectId, 1, "夜航番外", now) },
    ]);
    await handle.db.insert(scenes).values({
      id: sceneId, episodeId, sceneNo: 2, name: "夜航码头", description: null, sortOrder: 0,
      sourceBreakdownRunId: null, sourceCandidateId: null,
      createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(shots).values([
      { ...shotValues(shotId, episodeId, "YH-01", "夜航回头", now) },
      { ...shotValues(deletedShotId, episodeId, "YH-02", "夜航已删", now), deletedAt: now, deletedByUserId: ownerId },
    ]);
    await handle.db.insert(assetEntities).values({
      ...assetValues(assetId, ownerId, "夜航船长", now),
    });
    // 同一实体挂到两个项目(活跃唯一索引允许跨项目各一条):owner 项目一条、
    // member 项目一条。搜索应按 (实体, 项目) 去重——同项目一条,跨项目各一条。
    await handle.db.insert(projectAssetRefs).values([
      { ...refValues(refId, ownProjectId, assetId, ownerId, now) },
      { ...refValues(refId2, memberProjectId, assetId, outsiderId, now) },
    ]);

    // 1) owner 搜「夜航」:五组都命中自己项目链;软删除分镜不出现;
    //    自己项目的资产一条,他人项目的同一实体引用不出现。
    const ownerHits = await repository.searchVisible({ id: ownerId, role: "member" }, "夜航", 5);
    assert.deepEqual(ownerHits.projects.map((hit) => hit.id), [ownProjectId]);
    assert.deepEqual(ownerHits.episodes.map((hit) => hit.id), [episodeId]);
    assert.deepEqual(ownerHits.scenes.map((hit) => hit.id), [sceneId]);
    assert.deepEqual(ownerHits.shots.map((hit) => hit.id), [shotId]);
    assert.deepEqual(ownerHits.assets.map((hit) => hit.id), [assetId], "同项目同一实体只出一条");
    assert.equal(ownerHits.assets[0]?.projectId, ownProjectId);

    // 2) member 搜「夜」:只命中成员项目(夜探剧组)及其资产,owner/他人项目链不出现。
    const memberHits = await repository.searchVisible({ id: memberId, role: "member" }, "夜", 5);
    assert.deepEqual(memberHits.projects.map((hit) => hit.id), [memberProjectId]);
    assert.deepEqual(memberHits.episodes, [], "他人项目的剧集不可见");
    assert.deepEqual(memberHits.scenes, []);
    assert.deepEqual(memberHits.shots, []);
    assert.deepEqual(memberHits.assets.map((hit) => hit.id), [assetId], "成员项目的资产可见");
    assert.equal(memberHits.assets[0]?.projectId, memberProjectId);

    // 3) admin 搜「夜」:三个项目都命中(平台观察者全可见);
    //    同一实体在两个项目各出一条引用,按 (实体, 项目) 去重。
    const adminHits = await repository.searchVisible({ id: adminId, role: "admin" }, "夜", 5);
    assert.deepEqual(
      adminHits.projects.map((hit) => hit.id).sort(),
      [foreignProjectId, memberProjectId, ownProjectId].sort(),
    );
    assert.equal(adminHits.assets.length, 2, "同一实体跨两个项目各出一条");
    assert.deepEqual(
      adminHits.assets.map((hit) => hit.projectId).sort(),
      [memberProjectId, ownProjectId].sort(),
    );

    // 4) LIKE 通配符转义:查询「%」不得退化成全表命中。
    const wildcardHits = await repository.searchVisible({ id: adminId, role: "admin" }, "%", 5);
    assert.deepEqual(wildcardHits.projects, []);
    assert.deepEqual(wildcardHits.shots, []);
  } finally {
    await handle.db.delete(projectAssetRefs).where(inArray(projectAssetRefs.id, [refId, refId2])).catch(() => undefined);
    await handle.db.delete(assetEntities).where(eq(assetEntities.id, assetId)).catch(() => undefined);
    await handle.db.delete(shots).where(inArray(shots.id, [shotId, deletedShotId])).catch(() => undefined);
    await handle.db.delete(scenes).where(eq(scenes.id, sceneId)).catch(() => undefined);
    await handle.db.delete(episodes).where(inArray(episodes.id, [episodeId, foreignEpisodeId])).catch(() => undefined);
    await handle.db.delete(projectMembers).where(eq(projectMembers.projectId, memberProjectId)).catch(() => undefined);
    await handle.db.delete(projects).where(inArray(projects.id, [ownProjectId, memberProjectId, foreignProjectId])).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, [ownerId, memberId, outsiderId, adminId])).catch(() => undefined);
    await handle.pool.end();
  }
});

function userValues(id: string, username: string, role: "member" | "admin", now: Date) {
  return {
    id, username: `${username}-${id.slice(0, 8)}`, displayName: username, passwordHash: "test-only-hash",
    active: true, role, createdAt: now, updatedAt: now,
  };
}

function projectValues(id: string, ownerUserId: string, name: string, now: Date) {
  return {
    id, ownerUserId, teamId: null, genre: null, name, description: null, status: "active",
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function episodeValues(id: string, projectId: string, episodeNo: number, name: string, now: Date) {
  return {
    id, projectId, episodeNo, name, sortOrder: 0, status: "active", createdAt: now,
    updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function shotValues(id: string, episodeId: string, code: string, title: string, now: Date) {
  return {
    id, episodeId, sceneId: null, shotCode: code, title, scriptText: null,
    directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: null, sortOrder: 0,
    referenceAssetSnapshots: [], sourceBreakdownRunId: null, sourceCandidateId: null,
    selectedImageResultId: null, selectedVideoResultId: null,
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function assetValues(id: string, ownerUserId: string | null, name: string, now: Date) {
  return {
    id, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId,
    visibility: "personal", assetKind: "character", role: null, usageMode: null, name, displayName: name,
    intro: null, appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null,
    outfitDescription: null, category: null, styleTags: [], approved: true, reuseScope: "all_projects",
    status: "approved", sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now,
    useCount: 0, deletedAt: null, deletedByUserId: null,
  };
}

function refValues(id: string, projectId: string, assetEntityId: string, createdByUserId: string, now: Date) {
  return {
    id, projectId, assetEntityId, assetVariantId: null, assetMediaId: null,
    versionSnapshot: {}, createdByUserId, createdAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("COMMAND_PALETTE_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
