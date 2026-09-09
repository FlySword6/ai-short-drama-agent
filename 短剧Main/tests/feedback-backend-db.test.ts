import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  events,
  users,
} from "../src/db/schema.js";
import { AssetCopyRepository } from "../src/modules/assets/copyRepository.js";
import { DrizzleEventRepository } from "../src/modules/events/repository.js";

const databaseUrl = process.env.FEEDBACK_BACKEND_TEST_DATABASE_URL;

test("feedback backend: PostgreSQL keeps common asset copy idempotent and media reference-only", {
  skip: !databaseUrl,
}, async () => withFeedbackFixture(async ({ handle, actorId, sourceAssetId }) => {
  const repository = new AssetCopyRepository(handle.db);
  const [first, retry] = await Promise.all([
    repository.copyCommonToPersonal(actorId, sourceAssetId),
    repository.copyCommonToPersonal(actorId, sourceAssetId),
  ]);

  assert.equal(first.assetId, retry.assetId, "并发重放必须收敛到同一份个人资产");
  assert.equal(Number(first.created) + Number(retry.created), 1, "并发请求只能创建一次");
  assert.equal(first.copiedVariantCount, 1);
  assert.equal(first.copiedMediaCount, 2);

  const copies = await handle.db.select().from(assetEntities).where(and(
    eq(assetEntities.ownerUserId, actorId),
    eq(assetEntities.visibility, "personal"),
    eq(assetEntities.copiedFromAssetEntityId, sourceAssetId),
    isNull(assetEntities.deletedAt),
  ));
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0]?.metadata.source_lineage, {
    relation: "common_asset_copy",
    source_id: sourceAssetId,
  });

  const copyVariants = await handle.db.select().from(assetVariants).where(
    eq(assetVariants.assetEntityId, first.assetId),
  );
  assert.equal(copyVariants.length, 1);
  const copyMedia = await handle.db.select().from(assetMedia).where(or(
    eq(assetMedia.assetEntityId, first.assetId),
    inArray(assetMedia.assetVariantId, copyVariants.map((row) => row.id)),
  ));
  assert.equal(copyMedia.length, 2);
  assert.deepEqual(
    copyMedia.map((row) => [row.storageBucket, row.storagePath, row.storageUrl]).sort(),
    [
      ["asset-bucket", "common/character/front.png", "https://assets.test/common/character/front.png"],
      ["asset-bucket", "common/character/turnaround.glb", "https://assets.test/common/character/turnaround.glb"],
    ].sort(),
    "个人副本只能复用 TOS 引用，不能制造新的对象路径",
  );
}));

test("feedback backend: PostgreSQL records authenticated events and aggregates in UTC", {
  skip: !databaseUrl,
}, async () => withFeedbackFixture(async ({ handle, actorId }) => {
  const repository = new DrizzleEventRepository(handle.db);
  await repository.record(actorId, {
    event: "asset.search.submitted",
    props: { scope: "common", result_count: 12 },
    occurredAt: new Date("2026-07-21T23:30:00.000Z"),
  });
  await repository.record(actorId, {
    event: "asset.search.submitted",
    props: { scope: "personal", result_count: 3 },
    occurredAt: new Date("2026-07-22T00:30:00.000Z"),
  });

  const summary = await repository.aggregate({
    event: "asset.search.submitted",
    userId: actorId,
    occurredFrom: new Date("2026-07-21T00:00:00.000Z"),
    occurredTo: new Date("2026-07-22T23:59:59.999Z"),
  });
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.byEvent, [{ event: "asset.search.submitted", count: 2 }]);
  assert.equal(summary.byUser.length, 1);
  assert.equal(summary.byUser[0]?.userId, actorId);
  assert.equal(summary.byUser[0]?.count, 2);
  assert.deepEqual(summary.byDate, [
    { date: "2026-07-21", count: 1 },
    { date: "2026-07-22", count: 1 },
  ]);
}));

interface FeedbackFixtureContext {
  handle: DatabaseHandle;
  actorId: string;
  sourceAssetId: string;
}

async function withFeedbackFixture(
  run: (context: FeedbackFixtureContext) => Promise<void>,
): Promise<void> {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const sourceAssetId = randomUUID();
  const sourceVariantId = randomUUID();
  const now = new Date("2026-07-21T08:00:00.000Z");
  try {
    await handle.db.insert(users).values({
      id: actorId,
      username: `feedback-${actorId.slice(0, 8)}`,
      displayName: "Feedback Integration",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(assetEntities).values({
      id: sourceAssetId,
      copiedFromAssetEntityId: null,
      sourceProjectId: null,
      sourceProjectName: "采购资产库",
      ownerUserId: null,
      visibility: "common",
      assetKind: "character",
      name: `common-character-${sourceAssetId.slice(0, 8)}`,
      displayName: "雨夜男子",
      intro: "采购角色资产",
      appearance: "黑色长风衣",
      ageValue: 28,
      gender: "male",
      heightCm: 180,
      hairDescription: "黑色短发",
      outfitDescription: "深色长风衣",
      category: "lead",
      styleTags: ["cinematic", "rainy-night"],
      approved: true,
      reuseScope: "all_projects",
      status: "approved",
      sourceFileUrl: "https://assets.test/common/character/front.png",
      metadata: { license: "procured" },
      createdAt: now,
      updatedAt: now,
      useCount: 0,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(assetVariants).values({
      id: sourceVariantId,
      assetEntityId: sourceAssetId,
      variantKind: "turnaround",
      name: "角色转面",
      description: null,
      usageContext: "全能参考",
      visualPrompt: null,
      approved: true,
      status: "approved",
      isPrimary: true,
      sortOrder: 0,
      sourceFileUrl: "https://assets.test/common/character/turnaround.glb",
      sourceText: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(assetMedia).values([
      {
        id: randomUUID(),
        assetEntityId: sourceAssetId,
        assetVariantId: null,
        mediaKind: "image",
        viewAngle: "front",
        title: "角色正面",
        description: null,
        storageBucket: "asset-bucket",
        storagePath: "common/character/front.png",
        storageUrl: "https://assets.test/common/character/front.png",
        widthPx: 2048,
        heightPx: 2048,
        format: "png",
        sha256: "a".repeat(64),
        isPrimary: true,
        approved: true,
        sortOrder: 0,
        metadata: {},
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      },
      {
        id: randomUUID(),
        assetEntityId: null,
        assetVariantId: sourceVariantId,
        mediaKind: "model_3d",
        viewAngle: null,
        title: "角色三维模型",
        description: null,
        storageBucket: "asset-bucket",
        storagePath: "common/character/turnaround.glb",
        storageUrl: "https://assets.test/common/character/turnaround.glb",
        widthPx: null,
        heightPx: null,
        format: "glb",
        sha256: "b".repeat(64),
        isPrimary: true,
        approved: true,
        sortOrder: 0,
        metadata: {},
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      },
    ]);

    await run({ handle, actorId, sourceAssetId });
  } finally {
    const copyRows = await handle.db.select({ id: assetEntities.id }).from(assetEntities).where(
      eq(assetEntities.copiedFromAssetEntityId, sourceAssetId),
    ).catch(() => []);
    const copyIds = copyRows.map((row) => row.id);
    const copyVariants = copyIds.length
      ? await handle.db.select({ id: assetVariants.id }).from(assetVariants).where(
        inArray(assetVariants.assetEntityId, copyIds),
      ).catch(() => [])
      : [];
    const copyVariantIds = copyVariants.map((row) => row.id);
    if (copyIds.length || copyVariantIds.length) {
      const mediaConditions = [
        ...(copyIds.length ? [inArray(assetMedia.assetEntityId, copyIds)] : []),
        ...(copyVariantIds.length ? [inArray(assetMedia.assetVariantId, copyVariantIds)] : []),
      ];
      if (mediaConditions.length) await handle.db.delete(assetMedia).where(or(...mediaConditions));
    }
    if (copyVariantIds.length) await handle.db.delete(assetVariants).where(inArray(assetVariants.id, copyVariantIds));
    if (copyIds.length) await handle.db.delete(assetEntities).where(inArray(assetEntities.id, copyIds));
    await handle.db.delete(events).where(eq(events.userId, actorId)).catch(() => undefined);
    await handle.db.delete(assetMedia).where(or(
      eq(assetMedia.assetEntityId, sourceAssetId),
      eq(assetMedia.assetVariantId, sourceVariantId),
    )).catch(() => undefined);
    await handle.db.delete(assetVariants).where(eq(assetVariants.id, sourceVariantId)).catch(() => undefined);
    await handle.db.delete(assetEntities).where(eq(assetEntities.id, sourceAssetId)).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
}
