import assert from "node:assert/strict";
import test from "node:test";
import type { EmbeddingClient } from "../integrations/embeddingClient.js";
import type { MilvusVectorStore, VectorHit } from "../integrations/milvusVectorStore.js";
import { ExternalServiceError } from "../shared/errors.js";
import { parseVectorHitKey, recallAssetVectors } from "./searchService.js";

test("Milvus unavailable records a fallback and lets PostgreSQL recall continue", async () => {
  const embedding: EmbeddingClient = { embedImage: async () => [0.1, 0.2], embedText: async () => [0.1, 0.2] };
  const vectors: Pick<MilvusVectorStore, "search"> = {
    search: async () => { throw new ExternalServiceError("Milvus", "unavailable"); },
  };
  let hitCalls = 0;

  const fallbacks = await recallAssetVectors(["红斗篷少女"], 10, embedding, vectors, () => { hitCalls += 1; });

  assert.deepEqual(fallbacks, [{
    source: "milvus",
    reason: "vector_projection_unavailable",
  }]);
  assert.equal(hitCalls, 0);
});

test("projection fallback metadata never serializes a provider error body", async () => {
  const sentinel = "provider_secret_should_not_appear";
  const embedding: EmbeddingClient = {
    embedImage: async () => [0.1, 0.2], embedText: async () => { throw new ExternalServiceError("Embedding", sentinel); },
  };
  const vectors: Pick<MilvusVectorStore, "search"> = { search: async () => [] };

  const fallbacks = await recallAssetVectors(["雨夜巷口"], 10, embedding, vectors, () => undefined);

  assert.deepEqual(fallbacks, [{
    source: "embedding",
    reason: "vector_projection_unavailable",
  }]);
  assert.equal(JSON.stringify(fallbacks).includes(sentinel), false);
});

test("non-projection errors are not converted into empty search results", async () => {
  const embedding: EmbeddingClient = { embedImage: async () => [0.1, 0.2], embedText: async () => { throw new Error("database failure"); } };
  const vectors: Pick<MilvusVectorStore, "search"> = { search: async () => [] };

  await assert.rejects(recallAssetVectors(["红斗篷少女"], 10, embedding, vectors, () => undefined), /database failure/);
});

test("v2 compound id with identity facet parses to <table>:<uuid>", () => {
  const hit: VectorHit = {
    id: "asset_entities:010ac524-102d-48eb-b5ba-2a2bac08720f:identity",
    score: 0.92,
    text: "识别向量",
    metadata: {},
  };

  assert.equal(parseVectorHitKey(hit), "asset_entities:010ac524-102d-48eb-b5ba-2a2bac08720f");
});

test("v2 compound id with asset_variants prefix and style facet parses to <table>:<uuid>", () => {
  const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const hit: VectorHit = {
    id: `asset_variants:${uuid}:style`,
    score: 0.81,
    text: "风格向量",
    metadata: {},
  };

  assert.equal(parseVectorHitKey(hit), `asset_variants:${uuid}`);
});

test("v1 plain uuid id falls back to metadata.source_table", () => {
  const uuid = "5b1e9f2a-6c3d-4e11-8a2b-9d4f7c6e1a30";
  const hit: VectorHit = {
    id: uuid,
    score: 0.77,
    text: "本地向量",
    metadata: { source_table: "asset_variants" },
  };

  assert.equal(parseVectorHitKey(hit), `asset_variants:${uuid}`);
});

test("v1 plain uuid id without metadata defaults to asset_entities", () => {
  const uuid = "c1a2b3c4-d5e6-47f8-9012-3456789abcde";
  const hit: VectorHit = {
    id: uuid,
    score: 0.5,
    text: null,
    metadata: {},
  };

  assert.equal(parseVectorHitKey(hit), `asset_entities:${uuid}`);
});

test("two facet hits for the same asset merge onto the same recall key", () => {
  const uuid = "aa11bb22-cc33-4d44-8e55-ff66aa77bb88";
  const identityHit: VectorHit = {
    id: `asset_entities:${uuid}:identity`,
    score: 0.9,
    text: "身份向量",
    metadata: {},
  };
  const profileHit: VectorHit = {
    id: `asset_entities:${uuid}:profile`,
    score: 0.83,
    text: "人设向量",
    metadata: {},
  };

  assert.equal(parseVectorHitKey(identityHit), parseVectorHitKey(profileHit));
  assert.equal(parseVectorHitKey(identityHit), `asset_entities:${uuid}`);
});
