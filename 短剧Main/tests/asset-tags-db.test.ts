import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inArray } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { renderMigrationSql } from "../src/db/migrate.js";
import { assetEntities, tagVocabulary, users } from "../src/db/schema.js";
import { AssetCatalogService } from "../src/modules/assets/catalog.js";
import { DrizzleVocabularyRepository } from "../src/modules/vocabulary/repository.js";
import { AssetKindVocabularyService, TagVocabularyService } from "../src/modules/vocabulary/service.js";

/**
 * 真 PostgreSQL 验证 S41 标签体系与资产类型别名(迁移 031):
 *   验收① 资产类型过滤经词表展开别名(clothing→costume),他人资产不越界;
 *   验收② 一份资产挂多个不同域标签,别名打标/过滤/摘标全部一跳落规范词;
 *   缺省(不接词表端口)构造保持精确匹配,离线路径零行为变化。
 * 连接串只允许本机或本地 Compose,拒绝云 RDS。未设环境变量时整个文件 skip。
 */
const requestedDatabaseUrl = process.env.ASSET_TAGS_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;

test("asset tags & kind aliases: 别名展开、多域标签、打标摘标幂等", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const otherUserId = randomUUID();
  const costumeAssetId = randomUUID();
  const propAssetId = randomUUID();
  const foreignCostumeAssetId = randomUUID();
  const now = new Date("2026-07-27T09:00:00.000Z");
  try {
    await applyMigrations(handle);
    await handle.db.insert(users).values([
      userValues(actorId, "tags-actor", now),
      userValues(otherUserId, "tags-other", now),
    ]);
    await handle.db.insert(assetEntities).values([
      assetValues(costumeAssetId, actorId, "costume", "Tags Costume", now),
      assetValues(propAssetId, actorId, "prop", "Tags Prop", now),
      assetValues(foreignCostumeAssetId, otherUserId, "costume", "Foreign Costume", now),
    ]);

    const repo = new DrizzleVocabularyRepository(handle.db);
    const tagService = new TagVocabularyService(repo, repo);
    const catalog = new AssetCatalogService(handle.db, {
      kinds: new AssetKindVocabularyService(repo),
      tags: tagService,
    });

    // 验收①:assetKind 过滤接词表,别名 clothing 展开命中 costume;他人资产不越界。
    const byAlias = await catalog.list(actorId, { scope: "personal", assetKind: "clothing" });
    assert.deepEqual(byAlias.map((row) => row.id), [costumeAssetId], "别名 clothing 必须命中 costume 资产");
    const byCanonical = await catalog.list(actorId, { scope: "personal", assetKind: "costume" });
    assert.deepEqual(byCanonical.map((row) => row.id), [costumeAssetId], "规范词同样命中(展开含同族别名)");
    const byUnseeded = await catalog.list(actorId, { scope: "personal", assetKind: "storyboard" });
    assert.deepEqual(byUnseeded, [], "未收录 kind 原样精确匹配,不报错");

    // 缺省构造不接词表:精确匹配,离线/降级路径零行为变化。
    const identityCatalog = new AssetCatalogService(handle.db);
    const identityMiss = await identityCatalog.list(actorId, { scope: "personal", assetKind: "clothing" });
    assert.deepEqual(identityMiss, [], "identity 端口必须保持精确匹配");

    // 验收②:两个不同域的规范词 + 一个别名,挂到同一份资产。
    await tagService.ensureTag("仙侠", { domain: "题材", createdBy: actorId });
    await tagService.createTag({ id: "xianxia", canonicalId: "仙侠", displayName: "仙侠(拼音)", createdBy: actorId });
    await tagService.ensureTag("赛博朋克", { domain: "风格", createdBy: actorId });

    const attached = await tagService.attachTag(costumeAssetId, "xianxia", actorId);
    assert.equal(attached.created, true);
    assert.equal(attached.tag.id, "仙侠", "别名打标返回的恒为规范词");
    await tagService.attachTag(costumeAssetId, "赛博朋克", actorId);
    const duplicate = await tagService.attachTag(costumeAssetId, "xianxia", actorId);
    assert.equal(duplicate.created, false, "重复打标幂等");

    const listedTags = await tagService.listAssetTags(costumeAssetId);
    assert.deepEqual(listedTags.map((tag) => tag.id).sort(), ["仙侠", "赛博朋克"]);
    assert.deepEqual(listedTags.map((tag) => tag.domain).sort(), ["题材", "风格"], "一份资产可挂多个不同域标签");

    for (const input of ["xianxia", "仙侠", "赛博朋克"]) {
      const filtered = await catalog.list(actorId, { scope: "personal", tag: input });
      assert.deepEqual(filtered.map((row) => row.id), [costumeAssetId], `tag=${input} 必须命中同一资产`);
    }
    const unregistered = await catalog.list(actorId, { scope: "personal", tag: "不存在的标签" });
    assert.deepEqual(unregistered, [], "未注册标签短路为空");

    await tagService.detachTag(costumeAssetId, "xianxia");
    assert.deepEqual((await tagService.listAssetTags(costumeAssetId)).map((tag) => tag.id), ["赛博朋克"]);
    const afterDetach = await catalog.list(actorId, { scope: "personal", tag: "仙侠" });
    assert.deepEqual(afterDetach, [], "摘标后别名与规范词都不再命中");
    await tagService.detachTag(costumeAssetId, "xianxia"); // 再摘一次不报错(幂等)
    await tagService.detachTag(costumeAssetId, "未注册标签");
  } finally {
    // asset_tags 随资产删除级联;tag_vocabulary 自指 FK,先删别名再删规范词。
    await handle.db.delete(assetEntities)
      .where(inArray(assetEntities.id, [costumeAssetId, propAssetId, foreignCostumeAssetId]))
      .catch(() => undefined);
    await handle.db.delete(tagVocabulary).where(inArray(tagVocabulary.id, ["xianxia"])).catch(() => undefined);
    await handle.db.delete(tagVocabulary).where(inArray(tagVocabulary.id, ["仙侠", "赛博朋克"])).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, [actorId, otherUserId])).catch(() => undefined);
    await handle.pool.end();
  }
});

async function applyMigrations(handle: DatabaseHandle): Promise<void> {
  const source = await readFile(
    path.resolve("migrations", "031_tag_vocabulary_and_asset_kind_aliases.sql"),
    "utf8",
  );
  await handle.pool.query(renderMigrationSql(source, settings.postgresSchema));
}

function userValues(id: string, username: string, now: Date) {
  return {
    id, username: `${username}-${id.slice(0, 8)}`, displayName: username, passwordHash: "test-only-hash",
    active: true, createdAt: now, updatedAt: now,
  };
}

function assetValues(id: string, ownerUserId: string, assetKind: string, name: string, now: Date) {
  return {
    id, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId,
    visibility: "personal" as const, assetKind, name, displayName: name, intro: null, appearance: null,
    ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null,
    category: null, styleTags: [], approved: true, reuseScope: "all_projects", status: "approved",
    sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now, useCount: 0,
    deletedAt: null, deletedByUserId: null,
  };
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("ASSET_TAGS_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
