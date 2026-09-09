import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { JsonObject } from "../../domain/assets/types.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { registerAssetRoutes } from "./routes.js";
import type { AssetVariantService, CreateAssetVariantInput } from "./variants.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "director.one",
  displayName: "导演一",
};
const assetId = "22222222-2222-4222-8222-222222222222";

type VariantServiceStub = Pick<AssetVariantService, "create" | "list">;

test("创建人设变体:body 完整映射到 service,响应 snake_case 且 201", async () => {
  const calls: CreateAssetVariantInput[] = [];
  const service: VariantServiceStub = {
    create: async (input) => {
      calls.push(input);
      const metadata: JsonObject = {};
      if (input.episodeNos?.length) metadata.episode_nos = input.episodeNos;
      return {
        id: "33333333-3333-4333-8333-333333333333",
        assetEntityId: input.assetId,
        variantKind: input.variantKind,
        name: input.name,
        description: input.description ?? null,
        usageContext: input.usageContext ?? null,
        visualPrompt: input.visualPrompt ?? null,
        approved: true,
        status: "approved",
        isPrimary: input.isPrimary,
        sortOrder: input.sortOrder,
        sourceFileUrl: null,
        sourceText: null,
        metadata,
      };
    },
    list: async () => [],
  };
  const app = await buildApp(actor, service);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/variants`,
      payload: {
        name: "少年形态",
        variant_kind: "age",
        description: "十六岁的主角",
        usage_context: "回忆场次",
        visual_prompt: "少年,校服",
        is_primary: true,
        sort_order: 3,
        episode_nos: [1, 2, 5],
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        id: "33333333-3333-4333-8333-333333333333",
        asset_entity_id: assetId,
        variant_kind: "age",
        name: "少年形态",
        description: "十六岁的主角",
        usage_context: "回忆场次",
        visual_prompt: "少年,校服",
        approved: true,
        status: "approved",
        is_primary: true,
        sort_order: 3,
        source_file_url: null,
        source_text: null,
        metadata: { episode_nos: [1, 2, 5] },
      },
    });
    assert.deepEqual(calls, [{
      actorId: actor.id,
      assetId,
      name: "少年形态",
      variantKind: "age",
      description: "十六岁的主角",
      usageContext: "回忆场次",
      visualPrompt: "少年,校服",
      isPrimary: true,
      sortOrder: 3,
      episodeNos: [1, 2, 5],
    }]);
  } finally {
    await app.close();
  }
});

test("创建人设变体:缺省字段走默认口径", async () => {
  const calls: CreateAssetVariantInput[] = [];
  const app = await buildApp(actor, {
    create: async (input) => {
      calls.push(input);
      return {
        assetEntityId: input.assetId,
        variantKind: input.variantKind,
        name: input.name,
        isPrimary: input.isPrimary,
        sortOrder: input.sortOrder,
      };
    },
    list: async () => [],
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/variants`,
      payload: { name: "默认外观" },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(calls, [{
      actorId: actor.id,
      assetId,
      name: "默认外观",
      variantKind: "look",
      description: null,
      usageContext: null,
      visualPrompt: null,
      isPrimary: false,
      sortOrder: 0,
    }]);
  } finally {
    await app.close();
  }
});

test("创建人设变体:非法 body 一律 400 且不触达 service", async () => {
  let called = false;
  const app = await buildApp(actor, {
    create: async () => {
      called = true;
      throw new Error("must not run");
    },
    list: async () => [],
  });
  try {
    for (const payload of [
      {},
      { name: "x".repeat(129) },
      { name: "合法", usage_context: "x".repeat(256) },
      { name: "合法", episode_nos: [1.5] },
      { name: "合法", hacker: true },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/assets/${assetId}/variants`,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("变体端点未登录一律 401", async () => {
  let called = false;
  const app = await buildApp(undefined, {
    create: async () => {
      called = true;
      throw new Error("must not run");
    },
    list: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/variants`,
      payload: { name: "x" },
    });
    assert.equal(created.statusCode, 401);
    const listed = await app.inject({ method: "GET", url: `/api/v1/assets/${assetId}/variants` });
    assert.equal(listed.statusCode, 401);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("列人设变体:返回 items+count", async () => {
  const app = await buildApp(actor, {
    create: async () => {
      throw new Error("must not run");
    },
    list: async (actorId, actualAssetId) => {
      assert.equal(actorId, actor.id);
      assert.equal(actualAssetId, assetId);
      return [
        { id: "a", assetEntityId: assetId, variantKind: "look", name: "外观一", isPrimary: true, sortOrder: 0 },
        { id: "b", assetEntityId: assetId, variantKind: "motion", name: "动作一", isPrimary: false, sortOrder: 1 },
      ];
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/assets/${assetId}/variants` });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.count, 2);
    assert.equal(body.data.items[0].variant_kind, "look");
    assert.equal(body.data.items[1].name, "动作一");
  } finally {
    await app.close();
  }
});

async function buildApp(user: AuthenticatedUser | undefined, service: VariantServiceStub) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (user) request.authUser = user;
  });
  await registerAssetRoutes(app, () => ({} as Database), {
    createVariantService: () => service,
  });
  return app;
}
