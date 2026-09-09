import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import {
  assetClearanceKeys,
  assetEntities,
  defaultAssetClearance,
  type AssetClearance,
  type AssetEntityRow,
} from "../../db/schema.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { AssetCatalogService } from "./catalog.js";
import { applyDirectorAssetImportPlan, type DirectorAssetImportPlan } from "./directorManifestImport.js";
import { registerAssetRoutes } from "./routes.js";

// S40 写入路径合规:任何到达 asset_entities 写口的 clearance 都必须过
// src/db/schema.ts 的唯一共享校验。HTTP 边界(PATCH /assets)目前不开放
// clearance 编辑——显式字段映射把它挡在门外,这一条用路由测试锁死。

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "asset.editor",
  displayName: "资产编辑",
};
const assetId = "22222222-2222-4222-8222-222222222222";

test("PATCH /assets 不开放 clearance 编辑:字段到不了服务层,更不会落库", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerAssetRoutes(app, () => ({} as Database), {
    createAssetCatalogService: () => ({
      update: async (_actorId: string, _id: string, input: Record<string, unknown>) => {
        updates.push(input);
        return { id: assetId };
      },
    }) as unknown as AssetCatalogService,
    createVectorSyncService: () => ({ syncEntity: async () => undefined }),
  });
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${assetId}`,
      payload: { name: "新名字", clearance: { search: false } },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(updates[0], { name: "新名字" });
  } finally {
    await app.close();
  }
});

test("catalog.update 携带合法 clearance 时按共享校验归一化后落库", async () => {
  const { service, captured } = buildUpdateCapture();
  await service.update(actor.id, assetId, { name: "新名字", clearance: { search: false } });
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.["clearance"], { ...defaultAssetClearance, search: false });
  assert.deepEqual(Object.keys(captured[0]?.["clearance"] as object), [...assetClearanceKeys]);
});

test("catalog.update 携带不合法 clearance 时抛错且写口根本没被触达", async () => {
  for (const bad of [{ search: "false" }, { derivatives: true }, { search: null }]) {
    const { service, captured } = buildUpdateCapture();
    await assert.rejects(
      service.update(actor.id, assetId, { clearance: bad }),
      /clearance 不合法/,
      `必须拒绝: ${JSON.stringify(bad)}`,
    );
    assert.equal(captured.length, 0, "校验失败时不得有任何值进入 UPDATE");
  }
});

test("个人资产不能通过编辑入口进入审核状态", async () => {
  const { service, captured } = buildUpdateCapture();
  await assert.rejects(
    service.update(actor.id, assetId, { status: "pending_review" }),
    (error: any) => error?.code === "personal_asset_review_not_applicable"
      && /个人资产无需审核/.test(error.message),
  );
  assert.equal(captured.length, 0);
});

test("编辑历史个人资产时顺带恢复为免审可用态", async () => {
  const { service, captured } = buildUpdateCapture(assetRow({
    status: "pending_review",
    approved: null,
  }));
  await service.update(actor.id, assetId, { name: "已修正" });
  assert.equal(captured[0]?.["status"], "approved");
  assert.equal(captured[0]?.["approved"], true);
});

test("director manifest 导入携带 clearance 时过共享校验;不合法则整批不落库", async () => {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const db = fakeTransactionDb(inserts);

  await applyDirectorAssetImportPlan(db, buildPlan({ clearance: { commercial_publish: true } as unknown as AssetClearance }));
  const entityInsert = inserts.find((entry) => entry.table === assetEntities);
  assert.deepEqual(entityInsert?.values["clearance"], {
    ...defaultAssetClearance,
    commercial_publish: true,
  });

  const before = inserts.length;
  await assert.rejects(
    applyDirectorAssetImportPlan(db, buildPlan({ clearance: { search: "false" } as unknown as AssetClearance })),
    /search 必须是布尔值/,
  );
  const entityInsertsAfter = inserts.slice(before).filter((entry) => entry.table === assetEntities);
  assert.equal(entityInsertsAfter.length, 0, "不合法 clearance 的 entity 不得落库");
});

function buildUpdateCapture(
  row: AssetEntityRow = assetRow(),
): { service: AssetCatalogService; captured: Array<Record<string, unknown>> } {
  const captured: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [row],
          orderBy: async () => [],
          then: (onFulfilled?: (value: unknown[]) => unknown) => Promise.resolve([]).then(onFulfilled),
        }),
      }),
    }),
    selectDistinctOn: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: async () => [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.push(values);
        return { where: () => ({ returning: async () => [row] }) };
      },
    }),
  } as unknown as Database;
  return { service: new AssetCatalogService(db), captured };
}

function fakeTransactionDb(inserts: Array<{ table: unknown; values: Record<string, unknown> }>): Database {
  return {
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn({
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    }),
  } as unknown as Database;
}

function assetRow(overrides: Partial<AssetEntityRow> = {}): AssetEntityRow {
  const now = new Date("2026-07-15T00:00:00.000Z");
  return {
    id: assetId,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId: actor.id,
    visibility: "personal",
    assetKind: "character",
    role: null,
    usageMode: null,
    name: "测试资产",
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
    clearance: { ...defaultAssetClearance },
    searchText: "",
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

function buildPlan(options: { clearance?: AssetClearance }): DirectorAssetImportPlan {
  const entityId = "33333333-3333-4333-8333-333333333333";
  return {
    sourceProject: {
      id: "44444444-4444-4444-8444-444444444444",
      name: "导入源",
      code: "test-source",
      description: null,
      projectType: "director_asset_library",
      metadata: {},
    },
    assets: [{
      entity: {
        id: entityId,
        sourceProjectId: "44444444-4444-4444-8444-444444444444",
        sourceProjectName: "导入源",
        ownerUserId: null,
        visibility: "common",
        assetKind: "prop",
        name: "导入资产",
        displayName: "导入资产",
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
        useCount: 0,
        ...(options.clearance === undefined ? {} : { clearance: options.clearance }),
      },
      media: {
        id: "55555555-5555-4555-8555-555555555555",
        assetEntityId: entityId,
        assetVariantId: null,
        mediaKind: "model_3d",
        viewAngle: null,
        title: "导入资产",
        description: null,
        storageBucket: "test-bucket",
        storagePath: "director-assets/v1/prop/chair.glb",
        storageUrl: "https://storage.example/chair.glb",
        widthPx: null,
        heightPx: null,
        format: "glb",
        sha256: "0".repeat(64),
        isPrimary: true,
        approved: true,
        sortOrder: 0,
        metadata: {},
      },
      auditAction: null,
    }],
  };
}
