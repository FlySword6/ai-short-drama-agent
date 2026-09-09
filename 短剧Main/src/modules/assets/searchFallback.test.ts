import assert from "node:assert/strict";
import test from "node:test";
import {
  AssetPostgresFallbackSearchService,
  postgresSearchTerms,
  type AssetPostgresSearchPort,
} from "./searchFallback.js";
import {
  isRebuildableSearchDependencyFailure,
  searchWithPostgresFailover,
  searchWithPostgresFailoverResult,
} from "./searchFailover.js";
import { ExternalServiceError } from "../../shared/errors.js";

test("PostgreSQL fallback keeps catalog access scopes and de-duplicates assets", async () => {
  const calls: Array<{ scope: string; query?: string }> = [];
  const catalog: AssetPostgresSearchPort = {
    list: async (_actorId, filters) => {
      calls.push(filters);
      return filters.scope === "personal" && filters.query === "红斗篷"
        ? [{ id: "asset-a", name: "红斗篷少女", assetKind: "character", metadata: {} }]
        : filters.scope === "common" && filters.query === "少女"
          ? [{ id: "asset-a", name: "红斗篷少女", assetKind: "character", metadata: {} }]
          : [];
    },
  };
  const service = new AssetPostgresFallbackSearchService(catalog);

  const items = await service.search("user-a", "红斗篷少女", 10);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.sourceId, "asset-a");
  assert.equal(items[0]?.metadata.search_mode, "postgres_fallback");
  assert.equal(calls.some((call) => call.scope === "personal"), true);
  assert.equal(calls.some((call) => call.scope === "common"), true);
});

test("natural-language fallback produces bounded CJK terms", () => {
  const terms = postgresSearchTerms("  想找红斗篷少女，雨夜场景  ");
  assert.equal(terms[0], "想找红斗篷少女，雨夜场景");
  assert.equal(terms.includes("红斗篷"), true);
  assert.equal(terms.includes("少女"), true);
  assert.equal(terms.length <= 12, true);
});

test("Milvus or embedding outage falls back, while PostgreSQL errors remain visible", async () => {
  let fallbackCalls = 0;
  const fallback = {
    search: async () => {
      fallbackCalls += 1;
      return [];
    },
  };
  const unavailable = {
    search: async () => { throw new ExternalServiceError("Milvus", "unavailable"); },
  };
  await searchWithPostgresFailover(unavailable, fallback, "user-a", "红斗篷少女", 10);
  assert.equal(fallbackCalls, 1);

  const databaseFailure = {
    search: async () => { throw new Error("database unavailable"); },
  };
  await assert.rejects(
    searchWithPostgresFailover(databaseFailure, fallback, "user-a", "红斗篷少女", 10),
    /database unavailable/,
  );
  assert.equal(fallbackCalls, 1);

  assert.equal(isRebuildableSearchDependencyFailure(new ExternalServiceError("Milvus", "unavailable")), true);
  assert.equal(isRebuildableSearchDependencyFailure(new ExternalServiceError("Ark", "unavailable")), false);
  assert.equal(isRebuildableSearchDependencyFailure({ code: "ECONNREFUSED" }), false);
});

test("降级检索在顶层提供稳定模式和原因，保留条目级兼容元数据", async () => {
  const result = await searchWithPostgresFailoverResult(
    { search: async () => { throw new ExternalServiceError("Embedding", "unavailable"); } },
    {
      search: async () => [{
        score: null,
        sourceTable: "asset_entities",
        sourceId: "asset-a",
        assetKind: "character",
        name: "红斗篷少女",
        displayName: null,
        parentEntityId: null,
        parentEntityName: null,
        intro: null,
        appearance: null,
        description: null,
        usageContext: null,
        visualPrompt: null,
        sourceFileUrl: null,
        metadata: { search_mode: "postgres_fallback" },
        vectorText: null,
      }],
    },
    "user-a",
    "红斗篷少女",
    10,
  );
  assert.equal(result.mode, "structured_fallback");
  assert.equal(result.degradedReason, "semantic_search_unavailable");
  assert.equal(result.items[0]?.metadata.search_mode, "postgres_fallback");
});

test("语义投影正常时在顶层标记 hybrid 且不虚构降级原因", async () => {
  const result = await searchWithPostgresFailoverResult(
    { search: async () => [] },
    { search: async () => { throw new Error("fallback should not run"); } },
    "user-a",
    "红斗篷少女",
    10,
  );

  assert.equal(result.mode, "hybrid");
  assert.equal(result.degradedReason, undefined);
});
