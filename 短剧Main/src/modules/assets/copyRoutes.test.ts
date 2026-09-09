import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { registerAssetRoutes } from "./routes.js";
import type { AssetCopyPort } from "./copyService.js";
import { withLineage } from "./copyRepository.js";
import type { AssetCatalogService } from "./catalog.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "director.one",
  displayName: "导演一",
};
const sourceAssetId = "22222222-2222-4222-8222-222222222222";
const copiedAssetId = "33333333-3333-4333-8333-333333333333";

test("复制通用资产创建个人快照，并在重复调用时返回同一资产", async () => {
  const calls: Array<{ actorId: string; sourceAssetId: string }> = [];
  let created = true;
  const repository: AssetCopyPort = {
    copyCommonToPersonal: async (actorId, actualSourceAssetId) => {
      calls.push({ actorId, sourceAssetId: actualSourceAssetId });
      const result = {
        assetId: copiedAssetId,
        sourceAssetId: actualSourceAssetId,
        created,
        copiedVariantCount: 2,
        copiedMediaCount: 5,
      };
      created = false;
      return result;
    },
  };
  const app = await buildApp(actor, repository);
  try {
    const first = await app.inject({ method: "POST", url: `/api/v1/assets/${sourceAssetId}/copy-to-personal` });
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(first.json(), {
      ok: true,
      data: {
        asset_id: copiedAssetId,
        source_asset_id: sourceAssetId,
        created: true,
        copied_variant_count: 2,
        copied_media_count: 5,
      },
    });

    const retry = await app.inject({ method: "POST", url: `/api/v1/assets/${sourceAssetId}/copy-to-personal` });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().data.asset_id, copiedAssetId);
    assert.equal(retry.json().data.created, false);
    assert.deepEqual(calls, [
      { actorId: actor.id, sourceAssetId },
      { actorId: actor.id, sourceAssetId },
    ]);
  } finally {
    await app.close();
  }
});

test("未登录不能复制通用资产", async () => {
  let called = false;
  const app = await buildApp(undefined, {
    copyCommonToPersonal: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  try {
    const response = await app.inject({ method: "POST", url: `/api/v1/assets/${sourceAssetId}/copy-to-personal` });
    assert.equal(response.statusCode, 401);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("导入通用资产使用固定 body 合同，个人副本免审并返回完整资产", async () => {
  const calls: Array<{ actorId: string; sourceAssetId: string }> = [];
  let created = true;
  const repository: AssetCopyPort = {
    copyCommonToPersonal: async (actorId, actualSourceAssetId) => {
      calls.push({ actorId, sourceAssetId: actualSourceAssetId });
      const result = {
        assetId: copiedAssetId,
        sourceAssetId: actualSourceAssetId,
        created,
        copiedVariantCount: 2,
        copiedMediaCount: 5,
      };
      created = false;
      return result;
    },
  };
  const app = await buildApp(actor, repository, {
    get: async (actorId, assetId) => ({
      id: assetId,
      ownerUserId: actorId,
      visibility: "personal",
      name: "雨夜男子",
      status: "approved",
    }),
  });
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/assets/import-personal",
      payload: { asset_id: sourceAssetId },
    });
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(first.json(), {
      ok: true,
      data: {
        id: copiedAssetId,
        owner_user_id: actor.id,
        visibility: "personal",
        name: "雨夜男子",
        status: "approved",
        created: true,
        source_asset_id: sourceAssetId,
        copied_variant_count: 2,
        copied_media_count: 5,
      },
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/assets/import-personal",
      payload: { asset_id: sourceAssetId },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().data.id, copiedAssetId);
    assert.equal(retry.json().data.created, false);
    assert.deepEqual(calls, [
      { actorId: actor.id, sourceAssetId },
      { actorId: actor.id, sourceAssetId },
    ]);
  } finally {
    await app.close();
  }
});

test("导入个人资产拒绝路径参数旧合同和不合法 body", async () => {
  let called = false;
  const app = await buildApp(actor, {
    copyCommonToPersonal: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  try {
    const oldPath = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${sourceAssetId}/import-personal`,
      payload: {},
    });
    assert.equal(oldPath.statusCode, 404);

    const invalidBody = await app.inject({
      method: "POST",
      url: "/api/v1/assets/import-personal",
      payload: { asset_id: "not-a-uuid" },
    });
    assert.equal(invalidBody.statusCode, 400);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("来源追溯元数据不修改原对象", () => {
  const source = { studio: "asset-team" };
  assert.deepEqual(withLineage(source, "common_asset_copy", sourceAssetId), {
    studio: "asset-team",
    source_lineage: { relation: "common_asset_copy", source_id: sourceAssetId },
  });
  assert.deepEqual(source, { studio: "asset-team" });
});

async function buildApp(
  user: AuthenticatedUser | undefined,
  repository: AssetCopyPort,
  catalog: Partial<AssetCatalogService> = {},
) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (user) request.authUser = user;
  });
  await registerAssetRoutes(app, () => ({} as Database), {
    createAssetCopyService: () => repository,
    createAssetCatalogService: () => catalog as AssetCatalogService,
  });
  return app;
}
