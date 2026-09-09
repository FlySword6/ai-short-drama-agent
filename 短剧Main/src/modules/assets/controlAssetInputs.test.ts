import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AssetEntityRow } from "../../db/schema.js";
import type { AssetEntityData } from "../../domain/assets/types.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { JsonAssetIngestService } from "../../services/assetIngestService.js";
import type { AssetEntityRepository } from "../../repositories/assetEntityRepository.js";
import type { VectorSyncService } from "../../services/vectorSyncService.js";
import type { AssetCatalogService } from "./catalog.js";
import { registerAssetRoutes, toJsonAssetInput } from "./routes.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "asset.editor",
  displayName: "资产编辑",
};
const assetId = "22222222-2222-4222-8222-222222222222";

test("PATCH /assets 接受并可清空控制资产字段", async () => {
  const updates: Array<{ actorId: string; id: string; input: unknown }> = [];
  const app = await buildApp({
    catalog: {
      update: async (actorId, id, input) => {
        updates.push({ actorId, id, input });
        return { id, role: input.role ?? null, usageMode: input.usageMode ?? null };
      },
    },
  });
  try {
    const set = await app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${assetId}`,
      payload: {
        role: "camera_storyboard",
        usage_mode: "reference",
        height_cm: "180",
        hair_description: "黑色长发",
        outfit_description: null,
      },
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual(updates[0], {
      actorId: actor.id,
      id: assetId,
      input: {
        role: "camera_storyboard",
        usageMode: "reference",
        heightCm: 180,
        hairDescription: "黑色长发",
        outfitDescription: null,
      },
    });
    assert.deepEqual(set.json().data, {
      id: assetId,
      role: "camera_storyboard",
      usage_mode: "reference",
    });

    const clear = await app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${assetId}`,
      payload: { role: null, usage_mode: null },
    });
    assert.equal(clear.statusCode, 200, clear.body);
    assert.deepEqual(updates[1]?.input, { role: null, usageMode: null });
  } finally {
    await app.close();
  }
});

test("JSON 入库在首次保存时写入控制资产字段", async () => {
  let saved: AssetEntityData | undefined;
  const service = new JsonAssetIngestService({} as Database, {
    entityRepository: {
      save: async (asset: AssetEntityData) => {
        saved = asset;
        return asset as unknown as AssetEntityRow;
      },
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
    } as unknown as AssetEntityRepository,
    vectorSync: {
      syncEntity: async () => undefined,
    } as unknown as VectorSyncService,
  });

  const items = await service.ingest({
    ownerUserId: actor.id,
    assets: [{
      assetKind: "other",
      name: "动作参考",
      role: "motion",
      usageMode: "reference",
      styleTags: [],
      reuseScope: "needs_review",
      status: "pending_review",
      metadata: {},
    }],
  });

  assert.equal(saved?.role, "motion");
  assert.equal(saved?.usageMode, "reference");
  assert.equal(items[0]?.role, "motion");
  assert.equal(items[0]?.usageMode, "reference");
});

test("JSON 入库请求把控制字段映射为保存链的 camelCase 输入", () => {
  const input = toJsonAssetInput({
    asset_kind: "other",
    name: "镜头板",
    style_tags: [],
    reuse_scope: "needs_review",
    status: "pending_review",
    metadata: {},
    role: "camera_storyboard",
    usage_mode: "reference",
  });
  assert.equal(input.role, "camera_storyboard");
  assert.equal(input.usageMode, "reference");
});

test("控制资产字段只接受六类角色和三种用途", async () => {
  let called = false;
  const app = await buildApp({
    catalog: {
      update: async () => {
        called = true;
        return {};
      },
    },
  });
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${assetId}`,
      payload: { role: "character", usage_mode: "all_reference" },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

async function buildApp(dependencies: {
  catalog: Partial<AssetCatalogService>;
}) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  // queueEntityVectorSync 在 setImmediate 中调用 getById，需要 db 有 select 方法
  // 避免 unhandled rejection 导致测试失败。
  const mockDb = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Database;
  await registerAssetRoutes(app, () => mockDb, {
    createAssetCatalogService: () => dependencies.catalog as AssetCatalogService,
    createVectorSyncService: () => ({ syncEntity: async () => undefined }),
  });
  return app;
}
