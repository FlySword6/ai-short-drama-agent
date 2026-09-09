import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AssetSearchItem } from "../../domain/assets/types.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import type { HybridSearchInput, HybridSearchResult } from "./hybridSearchService.js";
import type { ProjectAccess } from "../project-access/types.js";
import { NotFoundError } from "../../shared/errors.js";
import { registerAssetRoutes } from "./routes.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "asset.searcher",
  displayName: "资产检索用户",
  role: "member",
};
const projectId = "22222222-2222-4222-8222-222222222222";
const dummyDb = {} as Database;

test("POST /asset-search 先验证项目 read 权限，再以 snake_case 返回单一混合结果合同", async () => {
  const calls: string[] = [];
  let received: HybridSearchInput | undefined;
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createProjectAccessService: () => ({
      require: async (actualActor, requestedProjectId, action) => {
        calls.push(`access:${actualActor.id}:${requestedProjectId}:${action}`);
        return readAccess(requestedProjectId);
      },
    }),
    createHybridSearchService: () => ({
      search: async (input: HybridSearchInput): Promise<HybridSearchResult> => {
        calls.push("hybrid-search");
        received = input;
        return {
          items: [searchItem("asset-1")],
          page: 2,
          pageSize: 5,
          hasMore: true,
          diagnostics: {
            status: "results",
            lexicalAvailable: true,
            semanticAvailable: false,
            relaxedOnce: false,
          },
        };
      },
    }),
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-search",
      payload: { query: "雨夜巷口", project_id: projectId, page: 2, page_size: 5 },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, [`access:${actor.id}:${projectId}:read`, "hybrid-search"]);
    assert.deepEqual(received, {
      actorId: actor.id,
      projectId,
      query: "雨夜巷口",
      page: 2,
      pageSize: 5,
    });
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        items: [{
          score: 0.5,
          lexical_hit: false,
          semantic_hit: false,
          source_table: "asset_entities",
          source_id: "asset-1",
          scope: "common",
          status: "approved",
          asset_kind: "scene",
          name: "asset-1",
          display_name: "asset-1",
          parent_entity_id: null,
          parent_entity_name: null,
          intro: null,
          appearance: null,
          description: null,
          usage_context: null,
          visual_prompt: null,
          source_file_url: null,
          metadata: {},
          vector_text: null,
        }],
        page: 2,
        page_size: 5,
        has_more: true,
        diagnostics: {
          status: "results",
          lexical_available: true,
          semantic_available: false,
          relaxed_once: false,
        },
      },
    });
  } finally {
    await app.close();
  }
});

test("资产中心 scope 进入服务端检索边界，且不能与 project_id 混用", async () => {
  let received: HybridSearchInput | undefined;
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createHybridSearchService: () => ({
      search: async (input: HybridSearchInput): Promise<HybridSearchResult> => {
        received = input;
        return {
          items: [searchItem("personal-asset", "personal")],
          page: 1,
          pageSize: 24,
          hasMore: false,
          diagnostics: {
            status: "results",
            lexicalAvailable: true,
            semanticAvailable: true,
            relaxedOnce: false,
          },
        };
      },
    }),
  });
  try {
    const scoped = await app.inject({
      method: "POST",
      url: "/api/v1/asset-search",
      payload: { query: "肖像", scope: "personal", page: 1, page_size: 24 },
    });
    assert.equal(scoped.statusCode, 200, scoped.body);
    assert.deepEqual(received, {
      actorId: actor.id,
      libraryScope: "personal",
      query: "肖像",
      page: 1,
      pageSize: 24,
    });
    assert.equal(scoped.json().data.items[0].scope, "personal");
    assert.equal(scoped.json().data.items[0].status, "approved");

    const conflicting = await app.inject({
      method: "POST",
      url: "/api/v1/asset-search",
      payload: { query: "肖像", scope: "personal", project_id: projectId },
    });
    assert.equal(conflicting.statusCode, 400, conflicting.body);
    assert.match(conflicting.body, /请检查标出的填写内容/);
  } finally {
    await app.close();
  }
});

test("项目不可读时 POST /asset-search 不会调用混合检索服务", async () => {
  let hybridCalls = 0;
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createProjectAccessService: () => ({
      require: async () => { throw new NotFoundError("项目不存在或你没有访问权限"); },
    }),
    createHybridSearchService: () => ({
      search: async () => {
        hybridCalls += 1;
        throw new Error("must not be called");
      },
    }),
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-search",
      payload: { query: "雨夜巷口", project_id: projectId },
    });

    assert.equal(response.statusCode, 404, response.body);
    assert.equal(hybridCalls, 0);
  } finally {
    await app.close();
  }
});

test("旧 /asset-search/semantic shim 映射 CLI limit，保留旧响应并与新路由等价", async () => {
  const received: HybridSearchInput[] = [];
  const deprecationLogs: unknown[][] = [];
  const originalConsoleInfo = console.info;
  console.info = (...args: unknown[]) => { deprecationLogs.push(args); };
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createHybridSearchService: () => ({
      search: async (input: HybridSearchInput): Promise<HybridSearchResult> => {
        received.push(input);
        return {
          items: [searchItem("legacy-asset")],
          page: input.page ?? 1,
          pageSize: input.pageSize ?? 20,
          hasMore: false,
          diagnostics: {
            status: "results",
            lexicalAvailable: true,
            semanticAvailable: true,
            relaxedOnce: false,
          },
        };
      },
    }),
  });
  try {
    const legacy = await app.inject({
      method: "POST",
      url: "/api/v1/asset-search/semantic",
      payload: { query: "雨夜巷口", limit: 7 },
    });
    const current = await app.inject({
      method: "POST",
      url: "/api/v1/asset-search",
      payload: { query: "雨夜巷口", page: 1, page_size: 7 },
    });

    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.equal(current.statusCode, 200, current.body);
    assert.deepEqual(received, [
      { actorId: actor.id, query: "雨夜巷口", page: 1, pageSize: 7 },
      { actorId: actor.id, query: "雨夜巷口", page: 1, pageSize: 7 },
    ]);
    assert.deepEqual(legacy.json(), {
      ok: true,
      data: {
        mode: "hybrid",
        count: 1,
        items: [{
          score: 0.5,
          source_table: "asset_entities",
          source_id: "legacy-asset",
          asset_kind: "scene",
          name: "legacy-asset",
          display_name: "legacy-asset",
          parent_entity_id: null,
          parent_entity_name: null,
          intro: null,
          appearance: null,
          description: null,
          usage_context: null,
          visual_prompt: null,
          source_file_url: null,
          metadata: {},
          vector_text: null,
        }],
      },
    });
    const currentItem = current.json().data.items[0] as Record<string, unknown>;
    const { scope: _scope, status: _status, lexical_hit: _lexicalHit, semantic_hit: _semanticHit, ...legacyItem } = currentItem;
    assert.deepEqual(legacy.json().data.items, [legacyItem]);
    assert.deepEqual(deprecationLogs, [
      ["[asset-search] deprecated endpoint /api/v1/asset-search/semantic called"],
    ]);
  } finally {
    console.info = originalConsoleInfo;
    await app.close();
  }
});

test("旧 /asset-search/semantic shim 按原合同限制 limit", async () => {
  const received: HybridSearchInput[] = [];
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createHybridSearchService: () => ({
      search: async (input: HybridSearchInput): Promise<HybridSearchResult> => {
        received.push(input);
        return {
          items: [],
          page: input.page ?? 1,
          pageSize: input.pageSize ?? 20,
          hasMore: false,
          diagnostics: {
            status: "no_results",
            lexicalAvailable: true,
            semanticAvailable: true,
            relaxedOnce: false,
          },
        };
      },
    }),
  });
  try {
    for (const payload of [{ query: "一" }, { query: "一", limit: 1 }, { query: "一", limit: 50 }]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/asset-search/semantic",
        payload,
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    for (const limit of [0, 51]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/asset-search/semantic",
        payload: { query: "一", limit },
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.deepEqual(received, [
      { actorId: actor.id, query: "一", page: 1, pageSize: 10 },
      { actorId: actor.id, query: "一", page: 1, pageSize: 1 },
      { actorId: actor.id, query: "一", page: 1, pageSize: 50 },
    ]);
  } finally {
    await app.close();
  }
});

function readAccess(actualProjectId: string): ProjectAccess {
  return {
    projectId: actualProjectId,
    actorId: actor.id,
    platformRole: "member",
    membershipRole: "viewer",
    isPlatformObserver: false,
  };
}

function searchItem(sourceId: string, scope: "personal" | "common" = "common"): AssetSearchItem {
  return {
    score: 0.5,
    sourceTable: "asset_entities",
    sourceId,
    scope,
    status: "approved",
    assetKind: "scene",
    name: sourceId,
    displayName: sourceId,
    parentEntityId: null,
    parentEntityName: null,
    intro: null,
    appearance: null,
    description: null,
    usageContext: null,
    visualPrompt: null,
    sourceFileUrl: null,
    metadata: {},
    vectorText: null,
  };
}
