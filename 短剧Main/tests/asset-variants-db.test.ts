import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { assetEntities, assetVariants, users } from "../src/db/schema.js";
import type { AssetEntityData, AssetVariantData } from "../src/domain/assets/types.js";
import { AssetVariantService } from "../src/modules/assets/variants.js";
import { ForbiddenError } from "../src/shared/errors.js";

/**
 * 真 PostgreSQL 验证人设变体写入:行锁串行、is_primary 部分唯一索引的
 * 先清后立、episode_nos 落 metadata、可见性/可管性。默认库已由全量迁移
 * 建好 asset_variants(001),本测试不额外跑迁移。
 * 连接串只允许本机或本地 Compose,拒绝云 RDS。
 */
const requestedDatabaseUrl = process.env.ASSET_VARIANTS_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;

test("asset variants: 写入串行化、主标记唯一、可见性与幂等重放", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const otherUserId = randomUUID();
  const personalAssetId = randomUUID();
  const commonAssetId = randomUUID();
  const now = new Date("2026-07-24T08:00:00.000Z");
  const vectorCalls: Array<{ variant: AssetVariantData; parent: AssetEntityData }> = [];
  const service = new AssetVariantService(handle.db, {
    vectorSync: {
      syncVariant: async (variant, parent) => {
        vectorCalls.push({ variant, parent });
      },
    },
  });
  try {
    await handle.db.insert(users).values([
      userValues(actorId, "variant-actor", now),
      userValues(otherUserId, "variant-other", now),
    ]);
    await handle.db.insert(assetEntities).values([
      assetValues(personalAssetId, actorId, "personal", "变体宿主个人资产", now),
      assetValues(commonAssetId, null, "common", "变体宿主通用资产", now),
    ]);

    const first = await service.create({
      actorId, assetId: personalAssetId, name: "少年形态", variantKind: "age",
      description: "十六岁的主角", usageContext: "回忆场次", visualPrompt: "少年,校服",
      isPrimary: true, sortOrder: 0, episodeNos: [1, 2, 5],
    });
    assert.equal(first.status, "approved", "个人资产变体免审并立即可用");
    assert.equal(first.approved, true);
    assert.equal(first.isPrimary, true);
    assert.deepEqual(first.metadata, { episode_nos: [1, 2, 5] }, "出现集数关系必须落 metadata.episode_nos");
    assert.equal(vectorCalls.length, 1, "向量同步必须在提交后触发一次");
    assert.equal(vectorCalls[0]?.parent.id, personalAssetId);
    assert.equal(vectorCalls[0]?.variant.id, first.id);

    const second = await service.create({
      actorId, assetId: personalAssetId, name: "老年形态", variantKind: "age",
      isPrimary: true, sortOrder: 1,
    });
    const primaries = await handle.db.select({ id: assetVariants.id, isPrimary: assetVariants.isPrimary })
      .from(assetVariants).where(and(
        eq(assetVariants.assetEntityId, personalAssetId),
        eq(assetVariants.variantKind, "age"),
        isNull(assetVariants.deletedAt),
      ));
    assert.deepEqual(
      Object.fromEntries(primaries.map((row) => [row.id, row.isPrimary])),
      { [first.id ?? ""]: false, [second.id ?? ""]: true },
      "同实体同 variant_kind 只允许一个主标记(先清后立)",
    );

    const otherKind = await service.create({
      actorId, assetId: personalAssetId, name: "默认外观", variantKind: "look",
      isPrimary: true, sortOrder: 0,
    });
    const agePrimary = await primaryOf(handle, personalAssetId, "age");
    assert.equal(agePrimary, second.id, "不同 variant_kind 的主标记互不影响");
    assert.ok(otherKind.id);

    const replay = await service.create({
      actorId, assetId: personalAssetId, name: "老年形态", variantKind: "age",
      isPrimary: false, sortOrder: 9,
    });
    assert.equal(replay.id, second.id, "同 kind 同名重放必须收敛到同一变体(upsert 幂等)");
    const listed = await service.list(actorId, personalAssetId);
    assert.equal(listed.length, 3, "重放不能产生重复行");
    assert.deepEqual(
      listed.map((row) => row.name),
      ["少年形态", "默认外观", "老年形态"],
      "list 按 sort_order 升序(重放后的 sort_order=9 排最后)",
    );

    await assert.rejects(
      service.create({
        actorId: otherUserId, assetId: personalAssetId, name: "越权", variantKind: "look",
        isPrimary: false, sortOrder: 0,
      }),
      (error: unknown) => error instanceof ForbiddenError,
      "他人个人资产不能写变体",
    );
    await assert.rejects(
      service.create({
        actorId, assetId: commonAssetId, name: "越权", variantKind: "look",
        isPrimary: false, sortOrder: 0,
      }),
      (error: unknown) => error instanceof ForbiddenError,
      "通用资产只读,不能写变体",
    );
    await assert.rejects(
      service.list(otherUserId, personalAssetId),
      (error: unknown) => error instanceof ForbiddenError,
      "他人个人资产的变体列表不可见",
    );
    const commonListed = await service.list(otherUserId, commonAssetId);
    assert.deepEqual(commonListed, [], "通用资产的变体列表所有人可见");
  } finally {
    await handle.db.delete(assetVariants).where(inArray(assetVariants.assetEntityId, [personalAssetId, commonAssetId])).catch(() => undefined);
    await handle.db.delete(assetEntities).where(inArray(assetEntities.id, [personalAssetId, commonAssetId])).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, [actorId, otherUserId])).catch(() => undefined);
    await handle.pool.end();
  }
});

async function primaryOf(handle: DatabaseHandle, assetId: string, variantKind: string): Promise<string | null> {
  const rows = await handle.db.select({ id: assetVariants.id }).from(assetVariants).where(and(
    eq(assetVariants.assetEntityId, assetId),
    eq(assetVariants.variantKind, variantKind),
    eq(assetVariants.isPrimary, true),
    isNull(assetVariants.deletedAt),
  ));
  return rows[0]?.id ?? null;
}

function userValues(id: string, username: string, now: Date) {
  return {
    id, username: `${username}-${id.slice(0, 8)}`, displayName: username, passwordHash: "test-only-hash",
    active: true, createdAt: now, updatedAt: now,
  };
}

function assetValues(id: string, ownerUserId: string | null, visibility: "personal" | "common", name: string, now: Date) {
  return {
    id, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId, visibility,
    assetKind: "character", name, displayName: name, intro: null, appearance: null, ageValue: null, gender: null,
    heightCm: null, hairDescription: null, outfitDescription: null, category: null, styleTags: [], approved: true,
    reuseScope: "all_projects", status: "approved", sourceFileUrl: null, metadata: {}, createdAt: now,
    updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
  };
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("ASSET_VARIANTS_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
