import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultAssetClearance, type AssetEntityRow, type AssetMediaRenditionRow, type AssetMediaRow } from "../../db/schema.js";
import {
  resolveAssetMediaDisplaySource,
  selectDisplayMediaByEntity,
  toAssetData,
  toAssetMediaData,
  type AssetMediaWithRenditions,
} from "./catalog.js";

test("展示媒体优先图片预览，同时保留无图片资产的主媒体回落", () => {
  const model = media({
    id: "11111111-1111-4111-8111-111111111111",
    assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mediaKind: "model_3d",
    format: "glb",
  });
  const preview = media({
    id: "22222222-2222-4222-8222-222222222222",
    assetEntityId: model.assetEntityId,
    mediaKind: "image",
    format: "png",
    metadata: {
      role: "director_3d_preview",
      sourceMediaId: model.id,
      sourceSha256: model.sha256,
    },
  });
  const audio = media({
    id: "33333333-3333-4333-8333-333333333333",
    assetEntityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    mediaKind: "audio",
    format: "mp3",
  });

  const selected = selectDisplayMediaByEntity([model, preview, audio]);

  assert.equal(selected.get(model.assetEntityId!)?.id, preview.id);
  assert.equal(selected.get(audio.assetEntityId!)?.id, audio.id);
});

test("同一 3D 资产下的普通图片不能冒充绑定预览", () => {
  const model = media({
    id: "55555555-5555-4555-8555-555555555555",
    assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mediaKind: "model_3d",
    format: "glb",
  });
  const unrelated = media({
    id: "66666666-6666-4666-8666-666666666666",
    assetEntityId: model.assetEntityId,
    mediaKind: "image",
    format: "png",
  });
  assert.equal(selectDisplayMediaByEntity([unrelated, model]).get(model.assetEntityId!)?.id, model.id);
});

test("3D 预览不会因伪造 metadata 跨资产、跨变体或跨个人和通用资产错绑", () => {
  const commonEntityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const personalEntityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const commonVariantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const personalVariantId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const model = media({
    id: "77777777-7777-4777-8777-777777777777",
    assetEntityId: null,
    assetVariantId: commonVariantId,
    mediaKind: "model_3d",
    format: "glb",
  });
  const previewMetadata = {
    role: "director_3d_preview",
    sourceMediaId: model.id,
    sourceSha256: model.sha256,
  };
  const crossEntity = media({
    id: "88888888-8888-4888-8888-888888888888",
    assetEntityId: personalEntityId,
    mediaKind: "image",
    format: "png",
    metadata: previewMetadata,
  });
  const crossVariant = media({
    id: "99999999-9999-4999-8999-999999999999",
    assetEntityId: null,
    assetVariantId: personalVariantId,
    mediaKind: "image",
    format: "png",
    metadata: previewMetadata,
  });
  const entityLevelPreview = media({
    id: "12121212-1212-4212-8212-121212121212",
    assetEntityId: commonEntityId,
    mediaKind: "image",
    format: "png",
    metadata: previewMetadata,
  });
  const exactVariantPreview = media({
    id: "13131313-1313-4313-8313-131313131313",
    assetEntityId: null,
    assetVariantId: commonVariantId,
    mediaKind: "image",
    format: "png",
    metadata: previewMetadata,
  });
  const owners = new Map([
    [commonVariantId, commonEntityId],
    [personalVariantId, personalEntityId],
  ]);

  const selected = selectDisplayMediaByEntity(
    [model, crossEntity, crossVariant, entityLevelPreview, exactVariantPreview],
    owners,
  );

  assert.equal(selected.get(commonEntityId)?.id, exactVariantPreview.id);
  assert.equal(selected.has(personalEntityId), false);
});

test("3D 预览拒绝双归属冲突，无 owner map 时只接受纯 variant 精确绑定", () => {
  const entityA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const entityB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const variantB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const dirtyModel = media({
    id: "14141414-1414-4414-8414-141414141414",
    assetEntityId: entityA,
    assetVariantId: variantB,
    mediaKind: "model_3d",
    format: "glb",
  });
  const dirtyPreview = media({
    id: "15151515-1515-4515-8515-151515151515",
    assetEntityId: entityA,
    assetVariantId: variantB,
    mediaKind: "image",
    format: "png",
    metadata: {
      role: "director_3d_preview",
      sourceMediaId: dirtyModel.id,
      sourceSha256: dirtyModel.sha256,
    },
  });
  const owners = new Map([[variantB, entityB]]);

  assert.equal(resolveAssetMediaDisplaySource(dirtyModel, [dirtyPreview], owners), null);
  assert.equal(selectDisplayMediaByEntity([dirtyModel, dirtyPreview], owners).size, 0);

  const pureModel = media({
    ...dirtyModel,
    assetEntityId: null,
  });
  const purePreview = media({
    ...dirtyPreview,
    assetEntityId: null,
  });
  assert.equal(
    resolveAssetMediaDisplaySource(pureModel, [purePreview])?.id,
    purePreview.id,
    "无 owner map 时，纯 variant-owned 行仍可凭精确同 variant 绑定",
  );
});

test("3D 预览源与预览任一未审核都不能进入公开展示", () => {
  const model = media({
    id: "16161616-1616-4616-8616-161616161616",
    mediaKind: "model_3d",
    format: "glb",
  });
  const preview = media({
    id: "17171717-1717-4717-8717-171717171717",
    mediaKind: "image",
    format: "png",
    metadata: {
      role: "director_3d_preview",
      sourceMediaId: model.id,
      sourceSha256: model.sha256,
    },
  });

  assert.equal(resolveAssetMediaDisplaySource({ ...model, approved: false }, [preview]), null);
  assert.equal(resolveAssetMediaDisplaySource(model, [{ ...preview, approved: false }]), null);
});

test("变体图片也能作为所属资产的展示预览", () => {
  const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const variantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const preview = media({
    id: "44444444-4444-4444-8444-444444444444",
    assetEntityId: null,
    assetVariantId: variantId,
    mediaKind: "image",
    format: "png",
  });

  const selected = selectDisplayMediaByEntity([preview], new Map([[variantId, entityId]]));

  assert.equal(selected.get(entityId)?.id, preview.id);
});

test("资产列表展示媒体在 PostgreSQL 内每个资产只返回一条，不读取整份版本列表", () => {
  const source = readFileSync(new URL("./catalog.ts", import.meta.url), "utf8");
  const start = source.indexOf("private async displayMediaByEntity");
  const end = source.indexOf("private async mediaForEntities", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const method = source.slice(start, end);

  assert.match(method, /selectDistinctOn\(\[ownerId\]/);
  assert.match(method, /leftJoin\(assetVariants/);
  assert.doesNotMatch(method, /coalesce\(/, "owner 解析不能让直接 entity 掩盖冲突 variant");
  assert.match(method, /approvedAssetMediaOwnershipSql/);
  assert.match(method, /innerJoin\(previewSource/);
  assert.match(method, /previewSource\.id\}::text/);
  assert.match(method, /\$\{previewOwnerId\} = \$\{sourceOwnerId\}/);
  assert.match(method, /assetVariantId\} = \$\{previewSource\.assetVariantId\}/);
  assert.match(method, /isNull\(assetMedia\.deletedAt\)/);
  assert.match(method, /isNull\(previewVariant\.deletedAt\)/);
  assert.match(method, /isNull\(sourceVariant\.deletedAt\)/);
  assert.match(method, /approvedPreviewOwner/);
  assert.match(method, /approvedSourceOwner/);
  assert.match(method, /when \$\{assetMedia\.mediaKind\} = 'model_3d' then 0/);
  assert.match(method, /assetImageMediaKindSql\(assetMedia\.mediaKind\)/);
  assert.match(method, /directorPreviewSourceMediaIdSql\(assetMedia\.metadata\)/);
  assert.match(method, /directorPreviewBindingSql\(assetMedia\.metadata\)/);
  assert.doesNotMatch(method, /mediaForEntities\(/, "列表不得先读取全部媒体版本再在内存选一条");
});

test("versions 媒体查询同样拒绝未审、失活 variant 和双归属冲突行", () => {
  const source = readFileSync(new URL("./catalog.ts", import.meta.url), "utf8");
  const start = source.indexOf("private async mediaForEntities");
  const end = source.indexOf("private async attachRenditions", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const method = source.slice(start, end);

  assert.match(method, /leftJoin\(\s*assetVariants/);
  assert.match(method, /isNull\(assetVariants\.deletedAt\)/);
  assert.match(method, /approvedAssetMediaOwnershipSql/);
  assert.match(method, /inArray\(ownerId, entityIds\)/);
  assert.doesNotMatch(method, /inArray\(assetMedia\.assetEntityId, entityIds\)/);
});

test("公开媒体投影不暴露原对象地址，旧字段只允许承载展示变体", () => {
  const image = withRenditions(media({
    id: "88888888-8888-4888-8888-888888888888",
    mediaKind: "image",
    format: "png",
    metadata: {
      label: "正面",
      tosKey: "private/source.png",
      nested: { source_file_url: "https://private.invalid/source.png" },
    },
  }));
  const value = toAssetMediaData(
    image,
    image.assetEntityId!,
    image,
    {
      displayBaseUrl: "https://assets.test",
      displayBucket: "drama-asset",
    },
  ) as Record<string, unknown>;

  assert.equal(value.sourceFileUrl, null);
  assert.equal(value.storageBucket, null);
  assert.equal(value.storagePath, null);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(image.storageUrl!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(
    value.storageUrl,
    `https://assets.test/asset-renditions/v1/bb/${"b".repeat(64)}.webp`,
  );
  assert.doesNotMatch(String(value.storageUrl), /x-tos-process|private\/source/u);
  assert.deepEqual(value.metadata, { label: "正面", nested: {} });
  assert.equal(
    (value.original as Record<string, unknown>).downloadEndpoint,
    `/api/v1/assets/${image.assetEntityId}/media/${image.id}/download-url`,
  );

  const model = toAssetMediaData(media({
    id: "99999999-9999-4999-8999-999999999999",
    mediaKind: "model_3d",
    format: "glb",
  }), image.assetEntityId!) as Record<string, unknown>;
  assert.equal(model.storageUrl, null);
  assert.equal(model.thumbnailUrl, null);
});

test("视频资产列表返回当前媒体和同源播放地址，但不暴露 TOS 原始地址", () => {
  const video = media({
    id: "abababab-abab-4aba-8aba-abababababab",
    assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mediaKind: "video",
    format: "mp4",
    storageUrl: "https://private.invalid/source.mp4",
  });
  const value = toAssetData(assetEntity(video.assetEntityId!), video) as Record<string, unknown>;
  const currentMedia = value.currentMedia as Record<string, unknown>;

  assert.equal(value.storageUrl, null);
  assert.equal(value.thumbnailUrl, null);
  assert.equal(currentMedia.mediaKind, "video");
  assert.equal(currentMedia.storageUrl, null);
  assert.equal(currentMedia.downloadUrl, `/api/v1/assets/${video.assetEntityId}/media/${video.id}/download`);
  assert.doesNotMatch(JSON.stringify(value), /private\.invalid\/source\.mp4/u);
});

function media(overrides: Partial<AssetMediaRow> & Pick<AssetMediaRow, "id" | "mediaKind">): AssetMediaRow {
  const { id, mediaKind, ...rest } = overrides;
  return {
    id,
    assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assetVariantId: null,
    mediaKind,
    viewAngle: null,
    title: null,
    description: null,
    storageBucket: "drama-asset",
    storagePath: `previews/${id}.${overrides.format ?? "png"}`,
    storageUrl: `https://assets.example.com/previews/${id}.${overrides.format ?? "png"}`,
    widthPx: null,
    heightPx: null,
    format: overrides.format ?? null,
    sha256: "a".repeat(64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata: {},
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
    deletedAt: null,
    deletedByUserId: null,
    ...rest,
  };
}

function assetEntity(id: string): AssetEntityRow {
  return {
    id,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId: "44444444-4444-4444-8444-444444444444",
    visibility: "personal",
    assetKind: "video",
    role: "motion",
    usageMode: "reference",
    name: "参考视频",
    displayName: "参考视频",
    intro: null,
    appearance: null,
    ageValue: null,
    gender: null,
    heightCm: null,
    hairDescription: null,
    outfitDescription: null,
    category: "video_reference",
    styleTags: [],
    approved: true,
    reuseScope: "all_projects",
    clearance: { ...defaultAssetClearance },
    status: "approved",
    sourceFileUrl: null,
    metadata: {},
    searchText: "",
    createdAt: new Date("2026-08-17T00:00:00.000Z"),
    updatedAt: new Date("2026-08-17T00:00:00.000Z"),
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function withRenditions(value: AssetMediaRow): AssetMediaWithRenditions {
  return {
    ...value,
    displayRenditions: (["thumbnail", "detail"] as const).map((kind) => rendition(value.id, kind)),
  };
}

function rendition(
  assetMediaId: string,
  renditionKind: "thumbnail" | "detail",
): AssetMediaRenditionRow {
  return {
    id: renditionKind === "thumbnail"
      ? "77777777-7777-4777-8777-777777777777"
      : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    assetMediaId,
    renditionKind,
    strategy: "stored_object",
    status: "healthy",
    processSpec: null,
    storageBucket: "drama-asset",
    storagePath: `asset-renditions/v1/${renditionKind === "thumbnail" ? "aa" : "bb"}/${renditionKind === "thumbnail" ? "a".repeat(64) : "b".repeat(64)}.webp`,
    storageUrl: null,
    sourceSha256: "a".repeat(64),
    widthPx: renditionKind === "thumbnail" ? 320 : 1280,
    heightPx: renditionKind === "thumbnail" ? 180 : 720,
    format: "webp",
    sha256: "b".repeat(64),
    errorCode: null,
    errorMessage: null,
    checkedAt: new Date("2026-08-04T00:00:00.000Z"),
    createdAt: new Date("2026-08-04T00:00:00.000Z"),
    updatedAt: new Date("2026-08-04T00:00:00.000Z"),
  };
}
