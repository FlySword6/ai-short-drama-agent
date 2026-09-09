import assert from "node:assert/strict";
import test from "node:test";
import type { AssetEntityData, AssetVariantData } from "./types.js";
import {
  ASSET_VECTOR_FACETS,
  buildAssetVectorDeletionIds,
  buildAssetVectorId,
  parseAssetVectorId,
} from "./vectorKeys.js";
import type { EmbeddingClient } from "../../integrations/embeddingClient.js";
import type { MilvusVectorStore } from "../../integrations/milvusVectorStore.js";
import { VectorSyncService } from "../../services/vectorSyncService.js";

test("资产向量键由一个构造函数统一生成和解析", () => {
  const id = "010ac524-102d-48eb-b5ba-2a2bac08720f";
  const key = buildAssetVectorId("asset_entities", id, "identity");

  assert.equal(key, `asset_entities:${id}:identity`);
  assert.deepEqual(parseAssetVectorId(key), {
    sourceTable: "asset_entities",
    sourceId: id,
    facet: "identity",
  });
});

test("删除键覆盖裸 UUID、无 facet 复合键及全部已知 facet", () => {
  const id = "010ac524-102d-48eb-b5ba-2a2bac08720f";
  const ids = buildAssetVectorDeletionIds("asset_entities", id);

  assert.equal(ids.includes(id), true);
  assert.equal(ids.includes(`asset_entities:${id}`), true);
  for (const facet of ASSET_VECTOR_FACETS) {
    assert.equal(ids.includes(`asset_entities:${id}:${facet}`), true);
  }
});

test("运行时实体与变体同步写 canonical full facet 键", async () => {
  const upserted: string[] = [];
  const embedding: EmbeddingClient = { embedImage: async () => [0.1, 0.2], embedText: async () => [0.1, 0.2] };
  const store = {
    upsert: async (id: string) => { upserted.push(id); },
  } as unknown as MilvusVectorStore;
  const service = new VectorSyncService({ embedding, store });
  const entity = {
    id: "010ac524-102d-48eb-b5ba-2a2bac08720f",
    name: "林夕",
    displayName: null,
    intro: "角色",
    appearance: null,
    hairDescription: null,
    outfitDescription: null,
    styleTags: [],
    gender: null,
    ageValue: null,
    heightCm: null,
    assetKind: "character",
    sourceProjectId: null,
  } as AssetEntityData;
  const variant = {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    name: "夜行造型",
    description: "黑色外套",
    visualPrompt: null,
    usageContext: null,
  } as AssetVariantData;

  await service.syncEntity(entity);
  await service.syncVariant(variant, entity);

  assert.deepEqual(upserted, [
    `asset_entities:${entity.id}:full`,
    `asset_variants:${variant.id}:full`,
  ]);
});

test("运行时实体可用指定文本同步 canonical full facet", async () => {
  const embeddedTexts: string[] = [];
  const upserted: Array<{ id: string; text: string }> = [];
  const embedding: EmbeddingClient = {
    embedImage: async () => [0.1, 0.2], embedText: async (text) => {
      embeddedTexts.push(text);
      return [0.1, 0.2];
    },
  };
  const store = {
    upsert: async (id: string, _vector: number[], text: string) => {
      upserted.push({ id, text });
    },
  } as unknown as MilvusVectorStore;
  const service = new VectorSyncService({ embedding, store });
  const entity = {
    id: "010ac524-102d-48eb-b5ba-2a2bac08720f",
    name: "参考视频",
    displayName: null,
    intro: "不应进入指定文本",
    appearance: "不应进入指定文本",
    hairDescription: null,
    outfitDescription: "不应进入指定文本",
    styleTags: ["不应进入指定文本"],
    gender: null,
    ageValue: null,
    heightCm: null,
    assetKind: "video",
    sourceProjectId: null,
  } as AssetEntityData;
  const text = "参考视频\n素材类型：参考视频\n摘要：黄昏重逢";

  await service.syncEntityWithText(entity, text);

  assert.deepEqual(embeddedTexts, [text]);
  assert.deepEqual(upserted, [{
    id: `asset_entities:${entity.id}:full`,
    text,
  }]);
});
