import assert from "node:assert/strict";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../../db/client.js";
import { HybridAssetSearchRepository } from "./hybridSearchRepository.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const otherOwnerId = "22222222-2222-4222-8222-222222222222";

test("项目窄媒体引用不会从他人的私有资产 metadata 泄露未锁定媒体或供应商载荷", async () => {
  const repository = new HybridAssetSearchRepository(fakeDatabase([foreignPrivateRow()]));

  const items = await repository.hydrate([{
    sourceTable: "asset_entities",
    sourceId: "33333333-3333-4333-8333-333333333333",
  }], {
    actorId,
    projectId: "44444444-4444-4444-8444-444444444444",
  });

  assert.notEqual(items[0]?.sourceFileUrl, "https://tos.example/allowed-media.png");
  if (items[0]?.sourceFileUrl) {
    assert.match(items[0].sourceFileUrl, /asset-renditions\/v1\/bb\/[b]{64}\.webp$/u);
    assert.doesNotMatch(items[0].sourceFileUrl, /x-tos-process/u);
  }
  assert.deepEqual(items[0]?.metadata, {});
});

test("本人或通用资产保留业务 metadata，但递归移除原对象定位字段", async () => {
  const row = foreignPrivateRow({
    visibility: "common",
    status: "approved",
    owner_user_id: otherOwnerId,
  });
  const repository = new HybridAssetSearchRepository(fakeDatabase([row]));

  const items = await repository.hydrate([{
    sourceTable: "asset_entities",
    sourceId: "33333333-3333-4333-8333-333333333333",
  }], { actorId });

  assert.deepEqual(items[0]?.metadata, {
    primary_image: {},
    raw_vision_asset: { provider_payload: "must-not-leak" },
  });
  assert.equal(items[0]?.scope, "common");
  assert.equal(items[0]?.status, "approved");
});

test("即使候选键命中，待审通用资产也不会通过最终水合", async () => {
  const repository = new HybridAssetSearchRepository(fakeDatabase([
    foreignPrivateRow({
      visibility: "common",
      status: "pending_review",
      owner_user_id: null,
    }),
  ]));

  const items = await repository.hydrate([{
    sourceTable: "asset_entities",
    sourceId: "33333333-3333-4333-8333-333333333333",
  }], { actorId });

  assert.deepEqual(items, []);
});

test("entity 和 variant 水合都将 3D preview 限定为同 owner、同活动 variant 的已审核来源", async () => {
  const statements: SQL[] = [];
  const repository = new HybridAssetSearchRepository(capturingDatabase(statements));

  await repository.hydrate([
    { sourceTable: "asset_entities", sourceId: "33333333-3333-4333-8333-333333333333" },
    { sourceTable: "asset_variants", sourceId: "44444444-4444-4444-8444-444444444444" },
  ], { actorId });

  assert.equal(statements.length, 2);
  for (const statement of statements) {
    const rendered = new PgDialect().sqlToQuery(statement).sql;
    assert.match(rendered, /candidate_media\.media_kind in \(/u);
    assert.match(rendered, /source_model\.id::text = case/u);
    assert.match(rendered, /source_model\.sha256 = case/u);
    assert.match(rendered, /candidate_media\.metadata->>'sourceMediaId'/u);
    assert.match(rendered, /candidate_media\.metadata->>'previewOfAssetMediaId'/u);
    assert.match(rendered, /candidate_media\.metadata->>'previewOfSha256'/u);
    assert.match(rendered, /source_model\.approved IS TRUE/u);
    assert.match(rendered, /candidate_media\.approved IS TRUE/u);
    assert.match(rendered, /source_model\.asset_variant_id IS NOT DISTINCT FROM candidate_media\.asset_variant_id|source_model\.asset_variant_id = variant\.id/u);
    assert.match(rendered, /candidate_media\.asset_variant_id IS NULL|candidate_media\.asset_variant_id = variant\.id/u);
    assert.match(rendered, /source_model\.asset_entity_id IS NULL\s+OR source_model\.asset_entity_id = entity\.id/u);
    assert.match(rendered, /candidate_media\.asset_entity_id IS NULL\s+OR candidate_media\.asset_entity_id = entity\.id/u);
  }
});

function fakeDatabase(rows: unknown[]): Database {
  return {
    execute: async () => ({ rows }),
  } as unknown as Database;
}

function capturingDatabase(statements: SQL[]): Database {
  return {
    execute: async (statement: SQL) => {
      statements.push(statement);
      return { rows: [] };
    },
  } as unknown as Database;
}

function foreignPrivateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_table: "asset_entities",
    source_id: "33333333-3333-4333-8333-333333333333",
    visibility: "personal",
    status: "approved",
    owner_user_id: otherOwnerId,
    asset_kind: "character",
    name: "雨夜男子",
    display_name: "雨夜男子",
    parent_entity_id: null,
    parent_entity_name: null,
    intro: null,
    appearance: null,
    description: null,
    usage_context: null,
    visual_prompt: null,
    media_source_sha256: "a".repeat(64),
    rendition_kind: "detail",
    rendition_strategy: "stored_object",
    rendition_status: "healthy",
    rendition_storage_bucket: "drama-asset",
    rendition_storage_path: `asset-renditions/v1/bb/${"b".repeat(64)}.webp`,
    rendition_source_sha256: "a".repeat(64),
    rendition_width_px: 1280,
    rendition_height_px: 720,
    rendition_format: "webp",
    rendition_sha256: "b".repeat(64),
    rendition_checked_at: new Date("2026-08-04T00:00:00.000Z"),
    metadata: {
      primary_image: { storage_url: "https://tos.example/not-allowed-media.png" },
      raw_vision_asset: { provider_payload: "must-not-leak" },
    },
    ...overrides,
  };
}
