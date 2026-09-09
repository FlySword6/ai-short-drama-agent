import assert from "node:assert/strict";
import test from "node:test";
import { DIRECTOR_SOURCE_PROJECT_ID } from "./directorManifestImport.js";
import { diagnoseAssetMedia } from "./mediaHealth.js";
import type { AssetRepairBundle } from "./mediaRepairTypes.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const sourceSha = "a".repeat(64);

function bundle(): AssetRepairBundle {
  return {
    asset: {
      id: assetId,
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      visibility: "personal",
      status: "approved",
      sourceProjectId: null,
      intro: null,
      metadata: {},
      deletedAt: null,
    },
    variants: [],
    media: [{
      id: mediaId,
      assetEntityId: assetId,
      assetVariantId: null,
      mediaKind: "image",
      title: "图片",
      description: null,
      storageBucket: "assets",
      storagePath: "asset/a.png",
      widthPx: 1280,
      heightPx: 720,
      format: "png",
      sha256: sourceSha,
      approved: true,
      metadata: {},
      deletedAt: null,
    }],
    renditions: (["thumbnail", "detail"] as const).map((kind, index) => ({
      id: `${index + 4}4444444-4444-4444-8444-444444444444`,
      assetMediaId: mediaId,
      renditionKind: kind,
      strategy: "stored_object",
      status: "healthy",
      processSpec: null,
      storageBucket: "assets",
      storagePath: `asset-renditions/v1/${kind === "thumbnail" ? "aa" : "bb"}/${kind === "thumbnail" ? "a".repeat(64) : "b".repeat(64)}.webp`,
      storageUrl: null,
      sourceSha256: sourceSha,
      widthPx: kind === "thumbnail" ? 320 : 1280,
      heightPx: kind === "thumbnail" ? 180 : 720,
      format: "webp",
      sha256: String(index + 1).repeat(64),
      errorCode: null,
      checkedAt: new Date("2026-08-04T00:00:00.000Z"),
    })),
    activeRepairTaskId: null,
  };
}

test("完整图片事实与两档已核验变体为 healthy", () => {
  const result = diagnoseAssetMedia(bundle(), new Date("2026-08-04T01:00:00.000Z"));
  assert.equal(result.status, "healthy");
  assert.equal(result.issues.length, 0);
  assert.equal(result.healthyMediaCount, 1);
});

test("缺图片元数据和展示变体会诚实降级且标为可自愈", () => {
  const input = bundle();
  input.media[0] = { ...input.media[0]!, widthPx: null, sha256: null };
  input.renditions = [];
  const result = diagnoseAssetMedia(input);
  assert.equal(result.status, "degraded");
  assert.deepEqual(
    result.issues.map((item) => item.code),
    ["image_metadata_missing", "image_thumbnail_missing", "image_detail_missing"],
  );
  assert.equal(result.issues.every((item) => item.autoRepairable && !item.blocker), true);
});

test("归属错位、3D 缺预览和导演资产缺中文视觉描述均为 blocker", () => {
  const input = bundle();
  input.asset.sourceProjectId = DIRECTOR_SOURCE_PROJECT_ID;
  input.variants = [{
    id: "55555555-5555-4555-8555-555555555555",
    assetEntityId: "66666666-6666-4666-8666-666666666666",
    deletedAt: null,
  }];
  input.media = [{
    ...input.media[0]!,
    mediaKind: "model_3d",
    assetVariantId: input.variants[0]!.id,
    widthPx: null,
    heightPx: null,
    format: "glb",
  }];
  input.renditions = [];
  const result = diagnoseAssetMedia(input);
  assert.equal(result.status, "broken");
  assert.deepEqual(new Set(result.issues.map((item) => item.code)), new Set([
    "media_entity_variant_mismatch",
    "model_preview_missing",
    "director_chinese_description_missing",
  ]));
  assert.equal(result.issues.every((item) => item.blocker), true);
});

test("活跃任务优先投影 repairing，但不吞掉具体问题", () => {
  const input = bundle();
  input.renditions = [];
  input.activeRepairTaskId = "77777777-7777-4777-8777-777777777777";
  const result = diagnoseAssetMedia(input);
  assert.equal(result.status, "repairing");
  assert.equal(result.activeRepairTaskId, input.activeRepairTaskId);
  assert.equal(result.issues.length, 2);
});

test("零媒体资产必须报告 blocker，不能被误判为 healthy", () => {
  const input = bundle();
  input.media = [];
  input.renditions = [];
  const result = diagnoseAssetMedia(input);
  assert.equal(result.status, "broken");
  assert.deepEqual(result.issues.map((item) => item.code), ["asset_media_missing"]);
  assert.equal(result.mediaCount, 0);
  assert.equal(result.healthyMediaCount, 0);
});

test("缺 source SHA、核验时间或独立对象位置的 healthy 行仍按 stale 处理", () => {
  const input = bundle();
  input.renditions[0] = {
    ...input.renditions[0]!,
    sourceSha256: null,
    checkedAt: null,
    storagePath: null,
  };
  const result = diagnoseAssetMedia(input);
  assert.equal(result.status, "degraded");
  assert.equal(result.issues.some((item) =>
    item.code === "rendition_stale" && item.renditionKind === "thumbnail"
  ), true);
});

test("3D 预览必须同时绑定 sourceMediaId 与当前 sourceSha256", () => {
  const input = bundle();
  const model = {
    ...input.media[0]!,
    mediaKind: "model_3d",
    format: "glb",
  };
  const preview = {
    ...input.media[0]!,
    id: "88888888-8888-4888-8888-888888888888",
    metadata: {
      role: "director_3d_preview",
      sourceMediaId: model.id,
      sourceSha256: model.sha256,
    },
  };
  input.media = [model, preview];
  input.renditions = input.renditions.map((rendition) => ({
    ...rendition,
    assetMediaId: preview.id,
  }));
  assert.equal(
    diagnoseAssetMedia(input).issues.some((item) => item.code === "model_preview_missing"),
    false,
  );
  preview.metadata = { ...preview.metadata, sourceSha256: "f".repeat(64) };
  assert.equal(
    diagnoseAssetMedia(input).issues.some((item) => item.code === "model_preview_missing"),
    true,
  );
});

test("跨变体、未审核或双归属冲突的 3D 预览不能通过健康诊断", () => {
  const variantA = "99999999-9999-4999-8999-999999999999";
  const variantB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const validModelAndPreview = () => {
    const input = bundle();
    input.variants = [
      { id: variantA, assetEntityId: assetId, deletedAt: null },
      { id: variantB, assetEntityId: assetId, deletedAt: null },
    ];
    const model = { ...input.media[0]!, mediaKind: "model_3d", format: "glb", assetVariantId: variantA };
    const preview = {
      ...input.media[0]!,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      assetVariantId: variantA,
      metadata: { role: "director_3d_preview", sourceMediaId: model.id, sourceSha256: model.sha256 },
    };
    input.media = [model, preview];
    input.renditions = input.renditions.map((rendition) => ({ ...rendition, assetMediaId: preview.id }));
    return { input, preview };
  };

  const crossVariant = validModelAndPreview();
  crossVariant.preview.assetVariantId = variantB;
  const crossVariantHealth = diagnoseAssetMedia(crossVariant.input);
  assert.equal(crossVariantHealth.issues.some((item) => item.code === "model_preview_missing"), true);
  assert.equal(crossVariantHealth.healthyMediaCount, 0);

  const unapproved = validModelAndPreview();
  unapproved.preview.approved = false;
  const unapprovedHealth = diagnoseAssetMedia(unapproved.input);
  assert.equal(unapprovedHealth.issues.some((item) => item.code === "model_preview_missing"), true);
  assert.equal(unapprovedHealth.healthyMediaCount, 0);

  const conflictingOwner = validModelAndPreview();
  conflictingOwner.preview.assetEntityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const conflictingHealth = diagnoseAssetMedia(conflictingOwner.input);
  assert.equal(conflictingHealth.issues.some((item) => item.code === "model_preview_missing"), true);
  assert.equal(conflictingHealth.healthyMediaCount, 0);
});
