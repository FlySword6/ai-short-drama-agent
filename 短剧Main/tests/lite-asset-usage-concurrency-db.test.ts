import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type Database, type DatabaseHandle } from "../src/db/client.js";
import { assetEntities, assetVariants, projectAssetRefs, projects, users } from "../src/db/schema.js";
import { quoteIdentifier } from "../src/db/migrate.js";
import { DrizzleLiteRepository } from "../src/modules/lite/repository.js";
import { LiteAssetService } from "../src/modules/lite/service.js";
import { ProjectAccessRepository } from "../src/modules/project-access/repository.js";
import { ProjectAccessService } from "../src/modules/project-access/service.js";
import { BadRequestError, NotFoundError } from "../src/shared/errors.js";

const databaseUrl = process.env.LITE_ASSET_USAGE_CONCURRENCY_TEST_DATABASE_URL;
const schema = quoteIdentifier(settings.postgresSchema);

test("Lite 资产关联并发、去重与权限边界在 PostgreSQL 闭环", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const actorId = randomUUID();
  const outsiderId = randomUUID();
  const projectId = randomUUID();
  const assetId = randomUUID();
  const variantIds = [randomUUID(), randomUUID()];
  const now = new Date("2026-08-22T14:00:00.000Z");

  try {
    await seedAsset(handle.db, {
      actorId,
      projectId,
      assetId,
      variantIds,
      now,
      metadata: { audit: { keep: true } },
    });
    await handle.db.insert(users).values({
      id: outsiderId,
      username: `usage-outsider-${outsiderId.slice(0, 8)}`,
      displayName: "无权用户",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const repository = new DrizzleLiteRepository(handle.db);

    // add/add：两个事务必须都在读完目标资产后被 gate 挡住，解除后仍保留两条。
    let releaseGate: (() => Promise<void>) | null = await lockVariantTable(handle.pool);
    try {
      const additions = variantIds.map((variantId, index) => repository.addAssetShotUsages({
        projectId,
        assetEntityId: assetId,
        actorId,
        now: new Date(now.getTime() + index + 1),
        items: [{ variantId, episodeNo: index + 1, shotNo: 1 }],
      }));
      await waitForConcurrentQueries(handle.pool, 2);
      await releaseGate();
      releaseGate = null;
      await Promise.all(additions);
    } finally {
      if (releaseGate) await releaseGate().catch(() => undefined);
    }

    const afterAdd = await readMetadata(handle.db, assetId);
    const addedUsages = usagesOf(afterAdd);
    assert.deepEqual(
      new Set(addedUsages.map((usage) => usage.variant_id)),
      new Set(variantIds),
      "两个并发请求新增的关联都必须保留",
    );
    assert.deepEqual(afterAdd.audit, { keep: true }, "metadata 其它命名空间不得被覆盖");

    const duplicate = await repository.addAssetShotUsages({
      projectId,
      assetEntityId: assetId,
      actorId,
      now: new Date(now.getTime() + 3),
      items: [{ variantId: variantIds[0], episodeNo: 1, shotNo: 1 }],
    });
    assert.deepEqual(duplicate, { added: 0, pending: 0 }, "相同关联重复添加必须幂等");
    assert.equal(usagesOf(await readMetadata(handle.db, assetId)).length, 2);

    // add/remove：add 先读旧快照并卡在 variant 表；remove 同时删除旧条目。
    // 无 asset row lock 时 add 会把已删条目写回来；有锁时 remove 在 add 提交后重读。
    const removedUsageId = addedUsages[0]?.usage_id;
    const keptUsageId = addedUsages[1]?.usage_id;
    assert.ok(typeof removedUsageId === "string");
    assert.ok(typeof keptUsageId === "string");
    releaseGate = await lockVariantTable(handle.pool);
    try {
      const addition = repository.addAssetShotUsages({
        projectId,
        assetEntityId: assetId,
        actorId,
        now: new Date(now.getTime() + 4),
        items: [{ variantId: variantIds[0], episodeNo: 99, shotNo: 1 }],
      });
      await waitForConcurrentQueries(handle.pool, 1);
      const removal = repository.removeAssetShotUsage({
        projectId,
        assetEntityId: assetId,
        usageId: removedUsageId,
        now: new Date(now.getTime() + 5),
      });
      await waitForConcurrentQueries(handle.pool, 2);
      await releaseGate();
      releaseGate = null;
      await Promise.all([addition, removal]);
    } finally {
      if (releaseGate) await releaseGate().catch(() => undefined);
    }

    const finalMetadata = await readMetadata(handle.db, assetId);
    const finalUsages = usagesOf(finalMetadata);
    assert.equal(finalUsages.some((usage) => usage.usage_id === removedUsageId), false, "并发 add 不得写回已删除关联");
    assert.equal(finalUsages.some((usage) => usage.usage_id === keptUsageId), true, "并发 remove 不得吞掉无关关联");
    assert.equal(finalUsages.some((usage) => usage.episode_no === 99), true, "并发 add 的新关联必须保留");
    assert.deepEqual(finalMetadata.audit, { keep: true });

    await assert.rejects(
      repository.addAssetShotUsages({
        projectId: randomUUID(),
        assetEntityId: assetId,
        actorId,
        now,
        items: [{ variantId: variantIds[0], episodeNo: 7, shotNo: 1 }],
      }),
      (error: unknown) => error instanceof BadRequestError && error.message === "找不到这个资产，可能已经被删除",
      "跨项目 repository 写入仍须隐藏资产",
    );

    const service = new LiteAssetService(
      repository,
      ProjectAccessService.fromDatabase(new ProjectAccessRepository(handle.db)),
    );
    await assert.rejects(
      service.addAssetShotUsages(
        { id: outsiderId, role: "member" },
        projectId,
        assetId,
        [{ variantId: variantIds[0], episodeNo: 8, shotNo: 1 }],
      ),
      (error: unknown) => error instanceof NotFoundError && error.message === "项目不存在或你没有访问权限",
      "无项目权限用户不得写关联，也不得获知项目存在",
    );
  } finally {
    await handle.db.delete(projectAssetRefs).where(eq(projectAssetRefs.assetEntityId, assetId)).catch(() => undefined);
    await handle.db.delete(assetVariants).where(eq(assetVariants.assetEntityId, assetId)).catch(() => undefined);
    await handle.db.delete(assetEntities).where(eq(assetEntities.id, assetId)).catch(() => undefined);
    await handle.db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, outsiderId)).catch(() => undefined);
    await handle.db.delete(users).where(eq(users.id, actorId)).catch(() => undefined);
    await handle.pool.end();
  }
});

async function seedAsset(
  db: Database,
  input: {
    actorId: string;
    projectId: string;
    assetId: string;
    variantIds: string[];
    now: Date;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(users).values({
    id: input.actorId,
    username: `usage-race-${input.actorId.slice(0, 8)}`,
    displayName: "关联并发测试",
    passwordHash: "test-only-hash",
    active: true,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(projects).values({
    id: input.projectId,
    ownerUserId: input.actorId,
    name: "关联并发项目",
    description: null,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
    deletedByUserId: null,
  });
  await db.insert(assetEntities).values({
    id: input.assetId,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId: input.actorId,
    visibility: "personal",
    assetKind: "character",
    name: "关联并发资产",
    displayName: "关联并发资产",
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
    metadata: input.metadata,
    createdAt: input.now,
    updatedAt: input.now,
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
  });
  await db.insert(assetVariants).values(input.variantIds.map((id, index) => ({
    id,
    assetEntityId: input.assetId,
    variantKind: "look",
    name: `并发外观 ${index + 1}`,
    description: null,
    usageContext: null,
    visualPrompt: null,
    approved: true,
    status: "approved",
    isPrimary: index === 0,
    sortOrder: index,
    sourceFileUrl: null,
    sourceText: null,
    metadata: {},
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
    deletedByUserId: null,
  })));
  await db.insert(projectAssetRefs).values({
    id: randomUUID(),
    projectId: input.projectId,
    assetEntityId: input.assetId,
    assetVariantId: null,
    assetMediaId: null,
    versionSnapshot: {},
    createdByUserId: input.actorId,
    createdAt: input.now,
    deletedAt: null,
    deletedByUserId: null,
  });
}

async function lockVariantTable(pool: DatabaseHandle["pool"]): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`LOCK TABLE ${schema}.asset_variants IN ACCESS EXCLUSIVE MODE`);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  };
}

async function waitForConcurrentQueries(pool: DatabaseHandle["pool"], expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state = 'active'
         AND query NOT ILIKE '%pg_stat_activity%'`,
    );
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await delay(20);
  }
  throw new Error(`未观察到 ${expected} 个并发数据库查询`);
}

async function readMetadata(db: Database, assetId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ metadata: assetEntities.metadata })
    .from(assetEntities)
    .where(eq(assetEntities.id, assetId))
    .limit(1);
  if (!row?.metadata || typeof row.metadata !== "object" || Array.isArray(row.metadata)) return {};
  return row.metadata as Record<string, unknown>;
}

function usagesOf(metadata: Record<string, unknown>): Array<Record<string, unknown>> {
  const lite = metadata.lite;
  if (!lite || typeof lite !== "object" || Array.isArray(lite)) return [];
  const liteRecord = lite as Record<string, unknown>;
  const usages = liteRecord.usages;
  return Array.isArray(usages)
    ? usages.filter((usage): usage is Record<string, unknown> => usage !== null && typeof usage === "object" && !Array.isArray(usage))
    : [];
}

function assertLocalTestDatabase(value: string): void {
  const hostname = new URL(value).hostname;
  assert.ok(hostname === "127.0.0.1" || hostname === "localhost", "测试只允许连接本机 PostgreSQL");
}
