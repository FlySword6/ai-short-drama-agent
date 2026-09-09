import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import type { AssetSearchItem } from "../../domain/assets/types.js";
import type { EmbeddingClient } from "../../integrations/embeddingClient.js";
import type { MilvusVectorStore } from "../../integrations/milvusVectorStore.js";
import { ExternalServiceError } from "../../shared/errors.js";
import type {
  HybridLexicalCandidate,
  HybridSearchKey,
  HybridSearchRepositoryPort,
} from "./hybridSearchRepository.js";
import {
  HybridAssetSearchService,
  rankWithReciprocalRankFusion,
} from "./hybridSearchService.js";

const actorId = "11111111-1111-4111-8111-111111111111";

test("RRF 合并会去重，并把双通道命中的资产排在单通道命中之前", () => {
  const ranked = rankWithReciprocalRankFusion(
    [
      lexical("asset-a", 0.98),
      lexical("asset-b", 0.92),
    ],
    [
      key("asset-b"),
      key("asset-c"),
    ],
  );

  assert.deepEqual(ranked.map((item) => item.sourceId), ["asset-b", "asset-a", "asset-c"]);
  assert.equal(new Set(ranked.map((item) => `${item.sourceTable}:${item.sourceId}`)).size, 3);
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("Embedding 或 Milvus 的可恢复故障只降级到词法检索", async () => {
  for (const failurePoint of ["embedding", "milvus"] as const) {
    let vectorSearchCalls = 0;
    const repository: HybridSearchRepositoryPort = {
      lexicalRecall: async () => [lexical("lexical-only", 0.9)],
      hydrate: async (keys) => keys.map((candidate) => item(candidate.sourceId)),
    };
    const embedding: EmbeddingClient = failurePoint === "embedding"
      ? { embedImage: async () => [0.1, 0.2], embedText: async () => { throw new ExternalServiceError("Embedding", "temporarily unavailable"); } }
      : { embedImage: async () => [0.1, 0.2], embedText: async () => [0.1, 0.2] };
    const vectors: Pick<MilvusVectorStore, "search"> = {
      search: async () => {
        vectorSearchCalls += 1;
        throw new ExternalServiceError("Milvus", "temporarily unavailable");
      },
    };
    const service = new HybridAssetSearchService({} as Database, { repository, embedding, vectors });

    const result = await service.search({ actorId, query: "雨夜巷口" });

    assert.deepEqual(result.items.map((candidate) => candidate.sourceId), ["lexical-only"], failurePoint);
    assert.equal(result.diagnostics.semanticAvailable, false, failurePoint);
    assert.equal(result.diagnostics.lexicalAvailable, true, failurePoint);
    assert.equal(vectorSearchCalls, failurePoint === "embedding" ? 0 : 1, failurePoint);
  }
});

test("Milvus gRPC 临时超时也只降级到词法检索", async () => {
  const repository: HybridSearchRepositoryPort = {
    lexicalRecall: async () => [lexical("lexical-only", 0.9)],
    hydrate: async (keys) => keys.map((candidate) => item(candidate.sourceId)),
  };
  const grpcTimeout = Object.assign(new Error("deadline exceeded"), { code: 4 });
  const service = new HybridAssetSearchService({} as Database, {
    repository,
    embedding: { embedImage: async () => [0.1, 0.2], embedText: async () => [0.1, 0.2] },
    vectors: { search: async () => { throw grpcTimeout; } },
  });

  const result = await service.search({ actorId, query: "雨夜巷口" });

  assert.deepEqual(result.items.map((candidate) => candidate.sourceId), ["lexical-only"]);
  assert.equal(result.diagnostics.semanticAvailable, false);
});

test("不可恢复的 embedding 错误不能伪装成词法降级", async () => {
  const repository: HybridSearchRepositoryPort = {
    lexicalRecall: async () => [lexical("would-have-matched", 0.9)],
    hydrate: async (keys) => keys.map((candidate) => item(candidate.sourceId)),
  };
  const service = new HybridAssetSearchService({} as Database, {
    repository,
    embedding: { embedImage: async () => [0.1, 0.2], embedText: async () => { throw new Error("embedding payload malformed"); } },
    vectors: { search: async () => [] },
  });

  await assert.rejects(
    service.search({ actorId, query: "雨夜巷口" }),
    /embedding payload malformed/,
  );
});

test("资产中心 scope 同时约束词法召回和最终水合", async () => {
  const scopes: unknown[] = [];
  const repository: HybridSearchRepositoryPort = {
    lexicalRecall: async (_query, scope) => {
      scopes.push(scope);
      return [lexical("personal-only", 0.9)];
    },
    hydrate: async (keys, scope) => {
      scopes.push(scope);
      return keys.map((candidate) => item(candidate.sourceId));
    },
  };
  const service = new HybridAssetSearchService({} as Database, {
    repository,
    embedding: { embedImage: async () => [0.1, 0.2], embedText: async () => [0.1, 0.2] },
    vectors: { search: async () => [] },
  });

  await service.search({ actorId, libraryScope: "personal", query: "肖像" });

  assert.deepEqual(scopes, [
    { actorId, libraryScope: "personal" },
    { actorId, libraryScope: "personal" },
  ]);
});

test("无结果时最多只移除一次低置信意图前缀", async () => {
  const queries: string[] = [];
  const repository: HybridSearchRepositoryPort = {
    lexicalRecall: async (query) => {
      queries.push(query);
      return [];
    },
    hydrate: async () => [],
  };
  const service = new HybridAssetSearchService({} as Database, {
    repository,
    embedding: { embedImage: async () => [0.1, 0.2], embedText: async () => [0.1, 0.2] },
    vectors: { search: async () => [] },
  });

  const result = await service.search({ actorId, query: "帮我找一下找一下雨夜巷口" });

  assert.deepEqual(queries, ["帮我找一下找一下雨夜巷口", "找一下雨夜巷口"]);
  assert.equal(result.diagnostics.relaxedOnce, true);
  assert.equal(result.diagnostics.reason, "query_expression_problem");
});

test("检索结果按请求分页，并且召回窗口随深页增长而不固定截断为 500", async () => {
  const candidates = [lexical("asset-a", 0.9), lexical("asset-b", 0.8), lexical("asset-c", 0.7)];
  const repository: HybridSearchRepositoryPort = {
    lexicalRecall: async () => candidates,
    hydrate: async (keys) => keys.map((candidate) => item(candidate.sourceId)),
  };
  const service = new HybridAssetSearchService({} as Database, {
    repository,
    embedding: { embedImage: async () => [0.1, 0.2], embedText: async () => [0.1, 0.2] },
    vectors: { search: async () => [] },
  });

  const result = await service.search({ actorId, query: "雨夜", page: 2, pageSize: 1 });

  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 1);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.items.map((candidate) => candidate.sourceId), ["asset-b"]);
});

test("第 11 页仍会请求足够的候选窗口，并如实保留继续翻页信号", async () => {
  let requestedLimit = 0;
  const repository: HybridSearchRepositoryPort = {
    lexicalRecall: async (_query, _scope, limit) => {
      requestedLimit = limit;
      return Array.from({ length: limit }, (_, index) => lexical(`asset-${index + 1}`, 1 - index / 1_000));
    },
    hydrate: async (keys) => keys.map((candidate) => item(candidate.sourceId)),
  };
  const service = new HybridAssetSearchService({} as Database, {
    repository,
    embedding: { embedImage: async () => [0.1, 0.2], embedText: async () => [0.1, 0.2] },
    vectors: { search: async () => [] },
  });

  const result = await service.search({ actorId, query: "雨夜", page: 11, pageSize: 50 });

  assert.equal(requestedLimit, 551);
  assert.equal(result.items.length, 50);
  assert.equal(result.items[0]?.sourceId, "asset-501");
  assert.equal(result.hasMore, true);
});

function key(sourceId: string): HybridSearchKey {
  return { sourceTable: "asset_entities", sourceId };
}

function lexical(sourceId: string, relevance: number): HybridLexicalCandidate {
  return { ...key(sourceId), relevance };
}

function item(sourceId: string): AssetSearchItem {
  return {
    score: null,
    sourceTable: "asset_entities",
    sourceId,
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
