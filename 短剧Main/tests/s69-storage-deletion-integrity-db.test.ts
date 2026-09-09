import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  projects,
  storyboardImports,
  users,
} from "../src/db/schema.js";
import {
  ASSET_VECTOR_FACETS,
  buildAssetVectorId,
} from "../src/domain/assets/vectorKeys.js";
import { AssetCatalogService } from "../src/modules/assets/catalog.js";
import { AssetCopyRepository } from "../src/modules/assets/copyRepository.js";
import {
  DrizzleTrashRepository,
  type TrashExternalCleaner,
} from "../src/modules/trash/repository.js";
import { TrashService } from "../src/modules/trash/service.js";

const execFileAsync = promisify(execFile);
const POSTGRES_IMAGE = process.env.POSTGRES_IMAGE ?? "postgres:14-alpine";

class InMemoryExternalCleaner implements TrashExternalCleaner {
  readonly storageObjects = new Set<string>();
  readonly vectorRows = new Set<string>();
  readonly deletedStoragePaths: string[] = [];
  readonly deletedVectorIds: string[] = [];
  failStoragePathOnce: string | null = null;

  async deleteStoragePath(storagePath: string): Promise<void> {
    if (this.failStoragePathOnce === storagePath) {
      this.failStoragePathOnce = null;
      throw new Error("stub storage delete failed once");
    }
    this.deletedStoragePaths.push(storagePath);
    this.storageObjects.delete(storagePath);
  }

  async deleteVectorIds(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.deletedVectorIds.push(id);
      this.vectorRows.delete(id);
    }
  }
}

test("S69 永久删除在真 PostgreSQL 上保护共享对象并清理全部向量键", {
  timeout: 180_000,
}, async (context) => {
  const postgres = await startTemporaryPostgres();
  const handle = createDatabase(postgres.databaseUrl, {
    postgresSslMode: "disable",
    postgresSslRootCert: undefined,
  });
  context.after(async () => {
    await handle.pool.end();
    await postgres.stop();
  });
  await runMigrations(handle);

  const { db } = handle;
  const now = new Date();
  const actorA = randomUUID();
  const actorB = randomUUID();
  await db.insert(users).values([
    userValues(actorA, "s69-a", now),
    userValues(actorB, "s69-b", now),
  ]);

  const cleaner = new InMemoryExternalCleaner();
  const trash = new TrashService(new DrizzleTrashRepository(db, cleaner));

  await context.test("删除通用资产副本不伤原件对象和其他数据库引用", async () => {
    const sourceId = randomUUID();
    const sourceMediaId = randomUUID();
    const sharedPath = `s69/shared/${randomUUID()}.png`;
    cleaner.storageObjects.add(sharedPath);
    await db.insert(assetEntities).values(assetValues({
      id: sourceId,
      ownerUserId: null,
      visibility: "common",
      deletedAt: null,
    }));
    await db.insert(assetMedia).values(mediaValues({
      id: sourceMediaId,
      assetEntityId: sourceId,
      storagePath: sharedPath,
    }));

    const copied = await new AssetCopyRepository(db).copyCommonToPersonal(actorA, sourceId);
    await db.update(assetEntities).set({ deletedAt: now, deletedByUserId: actorA })
      .where(eq(assetEntities.id, copied.assetId));

    await trash.permanentlyDelete({ actorId: actorA, kind: "asset", id: copied.assetId });

    assert.equal(cleaner.storageObjects.has(sharedPath), true, "共享对象必须保留");
    const [sourceMedia] = await db.select({
      storagePath: assetMedia.storagePath,
      storageUrl: assetMedia.storageUrl,
    }).from(assetMedia).where(eq(assetMedia.id, sourceMediaId));
    assert.equal(sourceMedia?.storagePath, sharedPath);
    assert.equal(sourceMedia?.storageUrl, storageUrl(sharedPath), "数据库中的共享对象事实必须保留");
    const publicAsset = await new AssetCatalogService(db).get(actorA, sourceId);
    assert.equal(publicAsset.storageUrl, null, "未配置展示基址时不得把原件地址冒充展示图");
    assert.equal(JSON.stringify(publicAsset).includes(storageUrl(sharedPath)), false);
  });

  await context.test("删除原始实体时只要仍有另一行引用，同一路径对象就不删", async () => {
    const originalId = randomUUID();
    const retainedId = randomUUID();
    const originalMediaId = randomUUID();
    const retainedMediaId = randomUUID();
    const sharedPath = `s69/shared/${randomUUID()}.png`;
    cleaner.storageObjects.add(sharedPath);
    await db.insert(assetEntities).values([
      assetValues({ id: originalId, ownerUserId: actorA, visibility: "personal", deletedAt: now }),
      assetValues({ id: retainedId, ownerUserId: actorB, visibility: "personal", deletedAt: null }),
    ]);
    await db.insert(assetMedia).values([
      mediaValues({ id: originalMediaId, assetEntityId: originalId, storagePath: sharedPath }),
      mediaValues({ id: retainedMediaId, assetEntityId: retainedId, storagePath: sharedPath }),
    ]);

    await trash.permanentlyDelete({ actorId: actorA, kind: "asset", id: originalId });

    assert.equal(cleaner.storageObjects.has(sharedPath), true, "仍有引用时不能删对象");
    assert.equal((await db.select().from(assetEntities).where(eq(assetEntities.id, originalId))).length, 0);
    const [retainedMedia] = await db.select({
      storagePath: assetMedia.storagePath,
      storageUrl: assetMedia.storageUrl,
    }).from(assetMedia).where(eq(assetMedia.id, retainedMediaId));
    assert.equal(retainedMedia?.storagePath, sharedPath);
    assert.equal(retainedMedia?.storageUrl, storageUrl(sharedPath), "剩余引用的对象事实必须保留");
    const publicAsset = await new AssetCatalogService(db).get(actorB, retainedId);
    assert.equal(publicAsset.storageUrl, null, "未配置展示基址时不得把原件地址冒充展示图");
    assert.equal(JSON.stringify(publicAsset).includes(storageUrl(sharedPath)), false);
  });

  await context.test("变体媒体对象与实体/变体的两代向量键全部清理", async () => {
    const assetId = randomUUID();
    const variantId = randomUUID();
    const mediaId = randomUUID();
    const variantPath = `s69/variant/${randomUUID()}.png`;
    cleaner.storageObjects.add(variantPath);
    await db.insert(assetEntities).values(assetValues({
      id: assetId,
      ownerUserId: actorA,
      visibility: "personal",
      deletedAt: now,
    }));
    await db.insert(assetVariants).values(variantValues(variantId, assetId, now));
    await db.insert(assetMedia).values(mediaValues({
      id: mediaId,
      assetEntityId: null,
      assetVariantId: variantId,
      storagePath: variantPath,
    }));

    const seededVectorIds = [
      assetId,
      buildAssetVectorId("asset_entities", assetId, "identity"),
      buildAssetVectorId("asset_entities", assetId, "profile"),
      buildAssetVectorId("asset_entities", assetId, "style"),
      buildAssetVectorId("asset_entities", assetId, "full"),
      variantId,
      buildAssetVectorId("asset_variants", variantId, "style"),
      buildAssetVectorId("asset_variants", variantId, "full"),
    ];
    for (const vectorId of seededVectorIds) cleaner.vectorRows.add(vectorId);

    await trash.permanentlyDelete({ actorId: actorA, kind: "asset", id: assetId });

    assert.equal(cleaner.storageObjects.has(variantPath), false);
    for (const vectorId of seededVectorIds) {
      assert.equal(cleaner.vectorRows.has(vectorId), false, `孤儿向量仍存在: ${vectorId}`);
    }
    for (const facet of ASSET_VECTOR_FACETS) {
      assert.equal(
        cleaner.deletedVectorIds.includes(buildAssetVectorId("asset_entities", assetId, facet)),
        true,
      );
    }
    assert.equal(cleaner.deletedVectorIds.includes(assetId), true, "历史裸 UUID 必须删除");
    assert.equal(
      cleaner.deletedVectorIds.includes(buildAssetVectorId("asset_entities", assetId, "identity")),
      true,
      "历史 facet 复合键必须删除",
    );
    assert.equal((await db.select().from(assetMedia).where(eq(assetMedia.id, mediaId))).length, 0);
    assert.equal((await db.select().from(assetVariants).where(eq(assetVariants.id, variantId))).length, 0);
    assert.equal((await db.select().from(assetEntities).where(eq(assetEntities.id, assetId))).length, 0);
  });

  await context.test("项目导入对象走同一套先摘引用、后删对象的清理链", async () => {
    const projectId = randomUUID();
    const importId = randomUUID();
    const importPath = `s69/project/${randomUUID()}.xlsx`;
    cleaner.storageObjects.add(importPath);
    await db.insert(projects).values(projectValues(projectId, actorA, now));
    await db.insert(storyboardImports).values({
      id: importId,
      projectId,
      createdByUserId: actorA,
      sourceFileName: "storyboard.xlsx",
      sourceSha256: "a".repeat(64),
      sourceStoragePath: importPath,
      status: "previewed",
      previewRows: [],
      warnings: [],
      errors: [],
      confirmationResult: null,
      confirmedAt: null,
      confirmedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });

    await trash.permanentlyDelete({ actorId: actorA, kind: "project", id: projectId });

    assert.equal(cleaner.storageObjects.has(importPath), false);
    assert.equal((await db.select().from(storyboardImports).where(eq(storyboardImports.id, importId))).length, 0);
    assert.equal((await db.select().from(projects).where(eq(projects.id, projectId))).length, 0);
  });

  await context.test("外部删除失败后从 PostgreSQL 清理计划重放成功", async () => {
    const assetId = randomUUID();
    const mediaId = randomUUID();
    const retryPath = `s69/retry/${randomUUID()}.png`;
    cleaner.storageObjects.add(retryPath);
    cleaner.failStoragePathOnce = retryPath;
    await db.insert(assetEntities).values(assetValues({
      id: assetId,
      ownerUserId: actorA,
      visibility: "personal",
      deletedAt: now,
    }));
    await db.insert(assetMedia).values(mediaValues({
      id: mediaId,
      assetEntityId: assetId,
      storagePath: retryPath,
    }));

    await assert.rejects(
      trash.permanentlyDelete({ actorId: actorA, kind: "asset", id: assetId }),
      /stub storage delete failed once/,
    );
    const [preparedAsset] = await db.select({ status: assetEntities.status }).from(assetEntities)
      .where(eq(assetEntities.id, assetId));
    const [preparedMedia] = await db.select({
      storagePath: assetMedia.storagePath,
      metadata: assetMedia.metadata,
    }).from(assetMedia).where(eq(assetMedia.id, mediaId));
    assert.equal(preparedAsset?.status, "purging");
    assert.equal(preparedMedia?.storagePath, null, "对象删除前必须先摘掉数据库引用");
    assert.equal(
      (preparedMedia?.metadata._trash_purge as Record<string, unknown> | undefined)?.storage_path,
      retryPath,
    );

    await trash.permanentlyDelete({ actorId: actorA, kind: "asset", id: assetId });

    assert.equal(cleaner.storageObjects.has(retryPath), false);
    assert.equal((await db.select().from(assetEntities).where(eq(assetEntities.id, assetId))).length, 0);
  });
});

function userValues(id: string, prefix: string, now: Date) {
  return {
    id,
    username: `${prefix}-${id.slice(0, 8)}`,
    displayName: prefix,
    passwordHash: "test-only-hash",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

function assetValues(input: {
  id: string;
  ownerUserId: string | null;
  visibility: "common" | "personal";
  deletedAt: Date | null;
}) {
  const now = new Date();
  return {
    id: input.id,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId: input.ownerUserId,
    visibility: input.visibility,
    assetKind: "character",
    role: "character_identity" as const,
    usageMode: "reference" as const,
    name: `S69资产-${input.id.slice(0, 8)}`,
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
    deletedAt: input.deletedAt,
    deletedByUserId: input.deletedAt ? input.ownerUserId : null,
  };
}

function variantValues(id: string, assetEntityId: string, now: Date) {
  return {
    id,
    assetEntityId,
    variantKind: "look",
    name: "夜行造型",
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
  };
}

function mediaValues(input: {
  id: string;
  assetEntityId: string | null;
  assetVariantId?: string | null;
  storagePath: string;
}) {
  return {
    id: input.id,
    assetEntityId: input.assetEntityId,
    assetVariantId: input.assetVariantId ?? null,
    mediaKind: "image",
    viewAngle: "front",
    title: "S69 媒体",
    description: null,
    storageBucket: "stub-bucket",
    storagePath: input.storagePath,
    storageUrl: storageUrl(input.storagePath),
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: "b".repeat(64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata: {},
    createdAt: new Date(),
    deletedAt: null,
    deletedByUserId: null,
  };
}

function projectValues(id: string, ownerUserId: string, now: Date) {
  return {
    id,
    ownerUserId,
    name: `S69项目-${id.slice(0, 8)}`,
    description: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
    deletedByUserId: ownerUserId,
  };
}

function storageUrl(storagePath: string): string {
  return `https://storage.example/${storagePath}`;
}

interface TemporaryPostgres {
  databaseUrl: string;
  stop(): Promise<void>;
}

async function startTemporaryPostgres(): Promise<TemporaryPostgres> {
  const containerName = `s69-storage-${process.pid}-${randomUUID().slice(0, 8)}`;
  const password = "s69-local-only";
  const database = "s69_storage";
  let running = false;
  try {
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${database}`,
      "-p",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=256m",
      POSTGRES_IMAGE,
    ]);
    running = true;

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await dockerResult([
        "exec",
        containerName,
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-tAc",
        "SELECT 1",
      ]);
      if (result.exitCode === 0 && result.stdout.trim() === "1") {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("temporary PostgreSQL did not become ready");

    await docker([
      "exec",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "CREATE EXTENSION IF NOT EXISTS pg_trgm",
    ]);
    const portOutput = await docker(["port", containerName, "5432/tcp"]);
    const port = /:(\d+)\s*$/.exec(portOutput)?.[1];
    if (!port) throw new Error("temporary PostgreSQL port was unavailable");

    return {
      databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`,
      stop: async () => {
        if (!running) return;
        running = false;
        await dockerResult(["rm", "-f", containerName]);
      },
    };
  } catch (error) {
    if (running) await dockerResult(["rm", "-f", containerName]);
    throw error;
  }
}

async function docker(args: string[]): Promise<string> {
  const result = await execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}

async function dockerResult(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  try {
    return { exitCode: 0, stdout: await docker(args) };
  } catch (error) {
    const value = error as { code?: unknown; stdout?: unknown };
    return {
      exitCode: typeof value.code === "number" ? value.code : 1,
      stdout: typeof value.stdout === "string" ? value.stdout : "",
    };
  }
}
