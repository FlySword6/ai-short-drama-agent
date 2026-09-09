import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type {
  AssetEntityRow,
  AssetMediaRenditionRow,
  AssetMediaRow,
} from "../src/db/schema.js";
import {
  ASSET_IMAGE_MEDIA_KINDS,
  isAssetImageMediaKind,
} from "../src/modules/assets/assetImageKinds.js";
import {
  directorPreviewBinding,
  directorPreviewIntentSql,
  hasDirectorPreviewIntent,
} from "../src/modules/assets/directorPreviewBinding.js";
import {
  resolveAssetMediaDisplaySource,
  toAssetData,
} from "../src/modules/assets/catalog.js";
import { diagnoseAssetMedia } from "../src/modules/assets/mediaHealth.js";
import type {
  AssetRepairBundle,
  AssetRepairMediaSnapshot,
} from "../src/modules/assets/mediaRepairTypes.js";

test("asset image kinds: Excel 细分标签与普通 image 共用唯一图片定义", () => {
  assert.deepEqual(ASSET_IMAGE_MEDIA_KINDS, [
    "image",
    "character_final",
    "character_reference",
    "character_turnaround",
    "costume_reference",
    "scene_final",
    "scene_multi_view",
    "scene_reference",
    "animal_reference",
    "cinematography_reference",
    "video_reference",
    "other",
  ]);
  for (const kind of ASSET_IMAGE_MEDIA_KINDS) {
    assert.equal(isAssetImageMediaKind(kind), true, kind);
  }
  for (const kind of ["model_3d", "video", "audio", "", "unknown"]) {
    assert.equal(isAssetImageMediaKind(kind), false, kind);
  }
});

test("director preview binding: 规范字段与 519 条历史字段归一成同一合同", () => {
  const sourceMediaId = "11111111-1111-4111-8111-111111111111";
  const sourceSha256 = "a".repeat(64);
  const expected = { sourceMediaId, sourceSha256 };

  assert.deepEqual(directorPreviewBinding({
    role: "director_3d_preview",
    sourceMediaId,
    sourceSha256,
  }), expected);
  assert.deepEqual(directorPreviewBinding({
    previewOfAssetMediaId: sourceMediaId,
    previewOfSha256: sourceSha256,
  }), expected);
  assert.equal(directorPreviewBinding({
    role: "director_3d_preview",
    sourceMediaId,
    sourceSha256,
    previewOfAssetMediaId: sourceMediaId,
    previewOfSha256: sourceSha256,
  }), null, "两套字段同时存在时 fail closed，不保留双真源");
  assert.equal(directorPreviewBinding({
    role: "director_3d_preview",
    sourceMediaId,
    sourceSha256,
    previewOfAssetMediaId: null,
  }), null, "旧字段键即使是 null 也不能绕过双形态拒绝");
  assert.equal(directorPreviewBinding({
    previewOfAssetMediaId: sourceMediaId,
    previewOfSha256: "not-a-sha",
  }), null);
  assert.equal(hasDirectorPreviewIntent({ sourceMediaId, sourceSha256 }), true);
  const intentSql = new PgDialect().sqlToQuery(
    directorPreviewIntentSql(sql`candidate.metadata`),
  ).sql;
  assert.match(intentSql, /candidate\.metadata \? 'sourceMediaId'/u);
  assert.match(intentSql, /candidate\.metadata \? 'previewOfAssetMediaId'/u);
  assert.match(intentSql, /^coalesce\(/u);
});

test("catalog: 细分图片可直接展示，历史 3D 预览仍需精确 ID/hash/归属绑定", () => {
  const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const subtype = media({
    id: "22222222-2222-4222-8222-222222222222",
    assetEntityId: entityId,
    mediaKind: "scene_final",
  });
  assert.equal(resolveAssetMediaDisplaySource(subtype, [subtype])?.id, subtype.id);
  assert.equal(resolveAssetMediaDisplaySource({
    ...subtype,
    metadata: {
      sourceMediaId: "99999999-9999-4999-8999-999999999999",
      sourceSha256: "b".repeat(64),
    },
  }, [subtype]), null, "缺 role 的 canonical 预览意图不能 fail-open 成普通图片");

  const model = media({
    id: "33333333-3333-4333-8333-333333333333",
    assetEntityId: entityId,
    mediaKind: "model_3d",
    format: "glb",
  });
  const legacyPreview = media({
    id: "44444444-4444-4444-8444-444444444444",
    assetEntityId: entityId,
    mediaKind: "image",
    metadata: {
      previewOfAssetMediaId: model.id,
      previewOfSha256: model.sha256,
    },
  });
  assert.equal(
    resolveAssetMediaDisplaySource(model, [model, legacyPreview])?.id,
    legacyPreview.id,
  );
  assert.equal(
    resolveAssetMediaDisplaySource(model, [
      model,
      { ...legacyPreview, assetEntityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ]),
    null,
    "兼容历史字段不能放宽跨资产保护",
  );
});

test("media health: 细分图片进入缩略图/详情诊断，历史 3D 预览不再误报缺图", () => {
  const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const subtype = repairMedia({
    id: "55555555-5555-4555-8555-555555555555",
    assetEntityId: entityId,
    mediaKind: "character_final",
  });
  const subtypeHealth = diagnoseAssetMedia(bundle(entityId, [subtype]));
  assert.deepEqual(
    subtypeHealth.issues.map((issue) => issue.code).sort(),
    ["image_detail_missing", "image_thumbnail_missing"],
  );
  assert.equal(subtypeHealth.status, "degraded");

  const model = repairMedia({
    id: "66666666-6666-4666-8666-666666666666",
    assetEntityId: entityId,
    mediaKind: "model_3d",
    format: "glb",
  });
  const preview = repairMedia({
    id: "77777777-7777-4777-8777-777777777777",
    assetEntityId: entityId,
    mediaKind: "image",
    metadata: {
      previewOfAssetMediaId: model.id,
      previewOfSha256: model.sha256,
    },
  });
  const modelHealth = diagnoseAssetMedia(bundle(entityId, [model, preview]));
  assert.equal(
    modelHealth.issues.some((issue) => issue.code === "model_preview_missing"),
    false,
  );
  assert.equal(
    modelHealth.issues.some((issue) => issue.code === "image_thumbnail_missing"),
    true,
  );
});

test("catalog wire data: 无图、源不可读、可自愈与已就绪四态可区分", () => {
  const asset = entity();
  const missing = toAssetData(asset);
  const image = media({
    id: "88888888-8888-4888-8888-888888888888",
    assetEntityId: asset.id,
    mediaKind: "costume_reference",
  });
  const repairable = toAssetData(asset, image);
  const unreadable = toAssetData(asset, {
    ...image,
    displayRenditions: [rendition(image.id, {
      status: "failed",
      errorCode: "source_object_unreadable",
    })],
  });
  const ready = toAssetData(asset, {
    ...image,
    displayRenditions: [rendition(image.id)],
  }, {
    displayBaseUrl: "https://assets.test",
    displayBucket: "asset-image-visible-test",
  });

  assert.equal(missing.imageStatus, "missing");
  assert.equal(unreadable.imageStatus, "unreadable");
  assert.equal(repairable.imageStatus, "repairable");
  assert.equal(ready.imageStatus, "ready");
});

test("common 资产本地筛选变化会把 URL 分页归一到第一页", () => {
  const source = readFileSync(
    new URL("../frontend/shortdrama-rag-demo/src/pages/global-pages.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /previousCommonLocalFilterKey/);
  assert.match(source, /isCommon && changed && browse\.page !== 1\) setBrowse\(\{ page: 1 \}\)/);
});

function entity(): AssetEntityRow {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceProjectId: null,
    sourceProjectName: null,
    copiedFromAssetEntityId: null,
    ownerUserId: null,
    visibility: "common",
    assetKind: "character",
    role: null,
    usageMode: null,
    name: "资产图片可见性测试",
    displayName: null,
    intro: null,
    appearance: null,
    ageValue: null,
    gender: null,
    heightCm: null,
    hairDescription: null,
    outfitDescription: null,
    category: null,
    styleTags: [],
    approved: true,
    reuseScope: "all_projects",
    status: "approved",
    sourceFileUrl: null,
    clearance: {
      display: true,
      search: true,
      reference: true,
      edit: false,
      generate: false,
      export: false,
    },
    metadata: {},
    useCount: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function media(
  overrides: Partial<AssetMediaRow> & Pick<AssetMediaRow, "id" | "mediaKind">,
): AssetMediaRow {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    id: overrides.id,
    assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assetVariantId: null,
    mediaKind: overrides.mediaKind,
    viewAngle: null,
    title: null,
    description: null,
    storageBucket: "asset-image-visible-test",
    storagePath: `images/${overrides.id}.png`,
    storageUrl: null,
    widthPx: 512,
    heightPx: 512,
    format: overrides.format ?? "png",
    sha256: "a".repeat(64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata: {},
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

function repairMedia(
  overrides: Partial<AssetRepairMediaSnapshot> & Pick<AssetRepairMediaSnapshot, "id" | "mediaKind">,
): AssetRepairMediaSnapshot {
  const row = media(overrides as Partial<AssetMediaRow> & Pick<AssetMediaRow, "id" | "mediaKind">);
  return {
    id: row.id,
    assetEntityId: row.assetEntityId,
    assetVariantId: row.assetVariantId,
    mediaKind: row.mediaKind,
    title: row.title,
    description: row.description,
    storageBucket: row.storageBucket,
    storagePath: row.storagePath,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    format: row.format,
    sha256: row.sha256,
    approved: row.approved,
    metadata: row.metadata,
    deletedAt: row.deletedAt,
  };
}

function rendition(
  assetMediaId: string,
  overrides: Partial<AssetMediaRenditionRow> = {},
): AssetMediaRenditionRow {
  const now = new Date("2026-08-06T00:00:00.000Z");
  return {
    id: "99999999-9999-4999-8999-999999999999",
    assetMediaId,
    renditionKind: "thumbnail",
    strategy: "stored_object",
    status: "healthy",
    processSpec: null,
    storageBucket: "asset-image-visible-test",
    storagePath: `asset-renditions/v1/bb/${"b".repeat(64)}.webp`,
    storageUrl: null,
    sourceSha256: "a".repeat(64),
    widthPx: 320,
    heightPx: 180,
    format: "webp",
    sha256: "b".repeat(64),
    errorCode: null,
    errorMessage: null,
    checkedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function bundle(assetId: string, mediaRows: AssetRepairMediaSnapshot[]): AssetRepairBundle {
  return {
    asset: {
      id: assetId,
      ownerUserId: null,
      visibility: "common",
      status: "approved",
      sourceProjectId: null,
      intro: null,
      metadata: {},
      deletedAt: null,
    },
    variants: [],
    media: mediaRows,
    renditions: [],
    activeRepairTaskId: null,
  };
}
