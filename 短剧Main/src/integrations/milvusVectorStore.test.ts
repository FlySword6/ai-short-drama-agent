import assert from "node:assert/strict";
import test from "node:test";
import { ExternalServiceError } from "../shared/errors.js";
import { MilvusVectorStore, milvusIdFilter } from "./milvusVectorStore.js";

test("Milvus 删除条件安全转义字符串 ID", () => {
  assert.equal(milvusIdFilter(["asset-1", "variant-\"2"]), 'id in ["asset-1", "variant-\\\"2"]');
});

test("Milvus search does not provision a missing collection", async () => {
  let createCalls = 0;
  let loadCalls = 0;
  const store = new MilvusVectorStore("asset_entity_vectors_v2", {
    uri: "http://milvus.example.invalid:19530",
    client: {
      hasCollection: async () => false,
      loadCollection: async () => { loadCalls += 1; },
      createCollection: async () => { createCalls += 1; },
      upsert: async () => undefined,
      search: async () => [],
      deleteEntities: async () => undefined,
    },
  });

  await assert.rejects(
    store.search([0.1, 0.2]),
    (error: unknown) => error instanceof ExternalServiceError && error.message === "Milvus: Configured vector collection is unavailable",
  );
  assert.equal(createCalls, 0);
  assert.equal(loadCalls, 0);
});

test("Milvus provisioning derives the vector dimension from the first indexed vector", async () => {
  let created: Record<string, unknown> | undefined;
  let loaded = false;
  let upserted: Record<string, unknown> | undefined;
  const store = new MilvusVectorStore("asset_entity_vectors_v2", {
    uri: "http://milvus.example.invalid:19530",
    moduleValue: { DataType: {}, MetricType: {} },
    client: {
      hasCollection: async () => false,
      loadCollection: async () => { loaded = true; },
      createCollection: async (input) => { created = input; },
      upsert: async (input) => { upserted = input; },
      search: async () => [],
      deleteEntities: async () => undefined,
    },
  });

  await store.upsert("entity:1", [0.1, 0.2, 0.3], "雨夜巷口", {});

  const fields = created?.fields;
  assert.ok(Array.isArray(fields));
  const vectorField = fields.find((field) => typeof field === "object" && field !== null && (field as { name?: unknown }).name === "vector") as { dim?: unknown } | undefined;
  assert.equal(vectorField?.dim, 3);
  const names = fields.map((field) => typeof field === "object" && field !== null ? (field as { name?: unknown }).name : null);
  assert.deepEqual(names, [
    "id",
    "vector",
    "text",
    "source_table",
    "source_id",
    "parent_entity_id",
    "source_project_id",
    "source_project_name",
    "asset_kind",
    "gender",
    "approval_state",
    "status",
    "text_hash",
    "embedding_model",
    "metadata",
  ]);
  assert.equal(loaded, true);
  assert.ok(upserted);
});

test("Milvus upsert writes flattened v2 fields", async () => {
  let upserted: Record<string, unknown> | undefined;
  const store = new MilvusVectorStore("asset_entity_vectors_v2", {
    uri: "http://milvus.example.invalid:19530",
    client: {
      hasCollection: async () => true,
      loadCollection: async () => undefined,
      createCollection: async () => undefined,
      upsert: async (input) => { upserted = input; },
      search: async () => [],
      deleteEntities: async () => undefined,
    },
  });

  await store.upsert("asset_entities:entity-1:full", [0.1, 0.2], "名称：冷宫", {
    source_table: "asset_entities",
    source_id: "entity-1",
    source_project_id: "project-1",
    source_project_name: "测试项目",
    asset_kind: "scene",
    gender: "",
    approval_state: "approved",
    status: "approved",
    embedding_model: "ep-test",
    metadata_note: "kept",
  });

  const data = Array.isArray(upserted?.data) ? upserted.data[0] as Record<string, unknown> : {};
  assert.equal(upserted?.collection_name, "asset_entity_vectors_v2");
  assert.equal(data.id, "asset_entities:entity-1:full");
  assert.equal(data.source_table, "asset_entities");
  assert.equal(data.source_id, "entity-1");
  assert.equal(data.source_project_id, "project-1");
  assert.equal(data.source_project_name, "测试项目");
  assert.equal(data.asset_kind, "scene");
  assert.equal(data.approval_state, "approved");
  assert.equal(data.status, "approved");
  assert.equal(typeof data.text_hash, "string");
  assert.equal((data.text_hash as string).length, 64);
  assert.equal(data.embedding_model, "ep-test");
  assert.equal((data.metadata as Record<string, unknown>).metadata_note, "kept");
  assert.equal((data.metadata as Record<string, unknown>).facet, "full");
});

test("Milvus search merges flattened v2 fields back into metadata", async () => {
  const store = new MilvusVectorStore("asset_entity_vectors_v2", {
    uri: "http://milvus.example.invalid:19530",
    client: {
      hasCollection: async () => true,
      loadCollection: async () => undefined,
      createCollection: async () => undefined,
      upsert: async () => undefined,
      search: async () => ({
        results: [{
          id: "asset_entities:entity-1:full",
          distance: 0.87,
          entity: {
            text: "名称：冷宫",
            source_table: "asset_entities",
            source_id: "entity-1",
            parent_entity_id: "",
            source_project_id: "project-1",
            source_project_name: "测试项目",
            asset_kind: "scene",
            gender: "",
            approval_state: "approved",
            status: "approved",
            text_hash: "a".repeat(64),
            embedding_model: "ep-test",
            metadata: { name: "冷宫" },
          },
        }],
      }),
      deleteEntities: async () => undefined,
    },
  });

  const [hit] = await store.search([0.1, 0.2], 1);

  assert.equal(hit?.id, "asset_entities:entity-1:full");
  assert.equal(hit?.metadata.source_table, "asset_entities");
  assert.equal(hit?.metadata.source_id, "entity-1");
  assert.equal(hit?.metadata.source_project_name, "测试项目");
  assert.equal(hit?.metadata.asset_kind, "scene");
  assert.equal(hit?.metadata.approval_state, "approved");
  assert.equal(hit?.metadata.embedding_model, "ep-test");
});

test("Milvus delete treats a missing collection as an empty rebuildable projection", async () => {
  let createCalls = 0;
  let deleteCalls = 0;
  const store = new MilvusVectorStore("asset_entity_vectors_v2", {
    uri: "http://milvus.example.invalid:19530",
    client: {
      hasCollection: async () => false,
      loadCollection: async () => undefined,
      createCollection: async () => { createCalls += 1; },
      upsert: async () => undefined,
      search: async () => [],
      deleteEntities: async () => { deleteCalls += 1; },
    },
  });

  await store.deleteByIds(["asset_entities:1"]);

  assert.equal(createCalls, 0);
  assert.equal(deleteCalls, 0);
});
