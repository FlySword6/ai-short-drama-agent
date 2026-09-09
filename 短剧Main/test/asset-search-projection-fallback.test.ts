import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../src/db/client.js";
import type { AssetSearchItem } from "../src/domain/assets/types.js";
import type { EmbeddingClient } from "../src/integrations/embeddingClient.js";
import type { MilvusVectorStore } from "../src/integrations/milvusVectorStore.js";
import { searchWithPostgresFailoverResult } from "../src/modules/assets/searchFailover.js";
import {
  AssetSearchService,
  VectorProjectionUnavailableError,
} from "../src/services/searchService.js";
import { ExternalServiceError } from "../src/shared/errors.js";

const visibleFallbackItem: AssetSearchItem = {
  score: null,
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
  metadata: { search_mode: "postgres_fallback" },
  vectorText: null,
};

test("skipped query understanding emits a typed projection signal and uses PostgreSQL fallback", async () => {
  const sentinel = "provider_secret_should_not_appear";
  const embedding: EmbeddingClient = {
    embedText: async () => { throw new ExternalServiceError("Embedding", sentinel); },
  };
  const vectors: Pick<MilvusVectorStore, "search"> = { search: async () => [] };
  // No repository method runs before the typed projection signal, so this is
  // intentionally a database-shaped stub rather than a real database.
  const semantic = new AssetSearchService({} as Database, {
    skipQueryUnderstanding: true,
    embedding,
    vectors,
  });

  await assert.rejects(
    semantic.search("雨夜巷口", 5, "user-a"),
    (error: unknown) => error instanceof VectorProjectionUnavailableError
      && !error.message.includes(sentinel),
  );

  const result = await searchWithPostgresFailoverResult(
    semantic,
    { search: async () => [visibleFallbackItem] },
    "user-a",
    "雨夜巷口",
    5,
  );

  assert.equal(result.mode, "structured_fallback");
  assert.equal(result.degradedReason, "semantic_search_unavailable");
  assert.deepEqual(result.items, [visibleFallbackItem]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("legacy semantic search also emits the signal instead of a hybrid empty result", async () => {
  const embedding: EmbeddingClient = {
    embedText: async () => { throw new ExternalServiceError("Embedding", "temporary outage"); },
  };
  const vectors: Pick<MilvusVectorStore, "search"> = { search: async () => [] };
  const semantic = new AssetSearchService({} as Database, {
    llm: { completeText: async () => "{}" },
    embedding,
    vectors,
  });
  // The default service continues through its bounded in-service structured
  // recall while collecting diagnostics. This stub makes that internal branch
  // deterministic; the public search() then emits the typed projection signal
  // so the caller uses the canonical PostgreSQL fallback service.
  (semantic as unknown as {
    structured: { searchEntities: () => Promise<[]> };
  }).structured = { searchEntities: async () => [] };

  const result = await searchWithPostgresFailoverResult(
    semantic,
    { search: async () => [visibleFallbackItem] },
    "user-a",
    "雨夜巷口",
    5,
  );

  assert.equal(result.mode, "structured_fallback");
  assert.equal(result.items[0]?.sourceId, "asset-visible");
});
