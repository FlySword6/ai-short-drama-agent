import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import type { AssetSearchItem } from "../../domain/assets/types.js";
import { AppError } from "../../shared/errors.js";
import { createAssistantToolServices } from "./services.js";

const item: AssetSearchItem = {
  score: 0.72,
  lexicalHit: true,
  semanticHit: false,
  sourceTable: "asset_entities",
  sourceId: "asset-visible",
  assetKind: "scene",
  name: "雨夜巷口",
  displayName: "雨夜巷口",
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

test("Pi asset search uses the unified hybrid service and exposes lexical/semantic hits", async () => {
  let calls = 0;
  const services = createAssistantToolServices({} as Database, {
    createHybridSearchService: () => ({
      search: async (input) => {
        calls += 1;
        assert.equal(input.actorId, "user-a");
        assert.equal(input.query, "雨夜巷口");
        assert.equal(input.pageSize, 10);
        return {
          items: [item],
          page: 1,
          pageSize: 10,
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

  const result = await services.searchAssets({
    actorId: "user-a",
    query: "雨夜巷口",
    limit: 10,
  }) as {
    receipt: { kind: string; status: string };
    mode: string;
    degraded: boolean;
    count: number;
    items: Array<{ source_id: string; lexical_hit: boolean; semantic_hit: boolean }>;
  };

  assert.equal(calls, 1);
  assert.deepEqual(result.receipt, { kind: "asset_search", status: "completed" });
  assert.equal(result.mode, "hybrid");
  assert.equal(result.degraded, false);
  assert.equal(result.count, 1);
  assert.deepEqual(result.items[0], {
    score: 0.72,
    lexical_hit: true,
    semantic_hit: false,
    source_table: "asset_entities",
    source_id: "asset-visible",
    asset_kind: "scene",
    name: "雨夜巷口",
    display_name: "雨夜巷口",
    description: null,
  });
});

test("Pi asset search reports degraded hybrid results when semantic recall is unavailable", async () => {
  const services = createAssistantToolServices({} as Database, {
    createHybridSearchService: () => ({
      search: async () => ({
        items: [item],
        page: 1,
        pageSize: 10,
        hasMore: false,
        diagnostics: {
          status: "results",
          lexicalAvailable: true,
          semanticAvailable: false,
          relaxedOnce: false,
        },
      }),
    }),
  });

  const result = await services.searchAssets({
    actorId: "user-a",
    query: "雨夜巷口",
    limit: 10,
  }) as { mode: string; degraded: boolean; degraded_reason?: string };

  assert.equal(result.mode, "hybrid");
  assert.equal(result.degraded, true);
  assert.equal(result.degraded_reason, "semantic_search_unavailable");
});

test("Pi asset search does not hide hybrid service failures", async () => {
  const failure = new AppError(500, "database_unavailable", "database unavailable", true);
  const services = createAssistantToolServices({} as Database, {
    createHybridSearchService: () => ({
      search: async () => {
        throw failure;
      },
    }),
  });

  await assert.rejects(
    services.searchAssets({ actorId: "user-a", query: "雨夜巷口", limit: 10 }),
    (error: unknown) => error === failure,
  );
});
