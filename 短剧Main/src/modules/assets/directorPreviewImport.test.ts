import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import {
  DIRECTOR_ASSET_EXPECTED_COUNT,
  buildDirectorPreviewImportPlan,
  validateDirectorPreviewManifest,
  verifyDirectorPreviewPng,
  type DirectorManifest,
  type DirectorPreviewManifest,
} from "./directorPreviewImport.js";
import { directorPreviewPaths } from "./directorPreviewRenderer.js";

function sourceManifest(): DirectorManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-04T00:00:00.000Z",
    assets: Array.from({ length: DIRECTOR_ASSET_EXPECTED_COUNT }, (_, index) => ({
      id: `demo/asset-${index}`,
      name: `Asset ${index}`,
      category: "demo",
      source: "test",
      license: "CC0-1.0",
      tosKey: `director-assets/v1/human/asset-${index}.glb`,
      file: `human/asset-${index}.glb`,
      size: index + 1,
      sha256: index.toString(16).padStart(64, "0"),
      tags: ["demo"],
    })),
  };
}

function previewManifest(source = sourceManifest()): DirectorPreviewManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-04T00:00:00.000Z",
    storageBucket: "drama-asset",
    previews: source.assets.map((asset, index) => ({
      sourceTosKey: asset.tosKey,
      sourceSha256: asset.sha256,
      localFile: directorPreviewPaths(asset.tosKey, asset.file).localFile,
      storageKey: directorPreviewPaths(asset.tosKey, asset.file).storageKey,
      outputSha256: (index + 519).toString(16).padStart(64, "0"),
      width: 512,
      height: 512,
      descriptionZh: `第 ${index} 个导演资产预览`,
      sourceSummary: "由已验收 GLB 离屏渲染生成",
    })),
  };
}

test("preview manifest binds every PNG to the exact 519 GLB source hashes", () => {
  const source = sourceManifest();
  const previews = previewManifest(source);
  validateDirectorPreviewManifest(previews, source);
  assert.throws(
    () => validateDirectorPreviewManifest({ ...previews, previews: previews.previews.slice(1) }, source),
    /exactly 519/,
  );
  assert.throws(
    () => validateDirectorPreviewManifest({
      ...previews,
      previews: previews.previews.map((entry, index) => index === 0 ? { ...entry, descriptionZh: "preview" } : entry),
    }, source),
    /Chinese description/,
  );
  assert.throws(
    () => validateDirectorPreviewManifest({
      ...previews,
      previews: previews.previews.map((entry, index) => index === 0 ? { ...entry, sourceSha256: "f".repeat(64) } : entry),
    }, source),
    /source hash drift/,
  );
});

test("preview plan produces stable bound source image rows; WebP renditions remain repair work", () => {
  const source = sourceManifest();
  const previews = previewManifest(source);
  const first = buildDirectorPreviewImportPlan(previews, source);
  const second = buildDirectorPreviewImportPlan(previews, source);

  assert.equal(first.media.length, DIRECTOR_ASSET_EXPECTED_COUNT);
  assert.equal(first.descriptions.length, DIRECTOR_ASSET_EXPECTED_COUNT);
  assert.equal(first.media[0]!.id, second.media[0]!.id);
  assert.equal(first.media[0]!.mediaKind, "image");
  assert.equal(first.media[0]!.format, "png");
  assert.match(String(first.media[0]!.metadata.sourceMediaId), /^[0-9a-f-]{36}$/u);
  assert.match(first.media[0]!.storagePath, /^asset-renditions\/v1\/director\/[0-9a-f]{64}\.png$/u);
  assert.doesNotMatch(first.media[0]!.storagePath, /human|asset-0/u);
  assert.match(first.descriptions[0]!.descriptionZh, /导演资产预览/);
});

test("preview plan rejects missing PNG location and duplicate source bindings", () => {
  const source = sourceManifest();
  const previews = previewManifest(source);
  assert.throws(
    () => validateDirectorPreviewManifest({
      ...previews,
      previews: previews.previews.map((entry, index) => index === 0 ? { ...entry, storageKey: "" } : entry),
    }, source),
    /storageKey/,
  );
  assert.throws(
    () => validateDirectorPreviewManifest({
      ...previews,
      previews: [...previews.previews.slice(0, -1), previews.previews[0]!],
    }, source),
    /duplicate sourceTosKey/,
  );
  assert.throws(
    () => validateDirectorPreviewManifest({
      ...previews,
      previews: previews.previews.map((entry, index) =>
        index === 0 ? { ...entry, localFile: "runtime/director-previews/elsewhere.png" } : entry
      ),
    }, source),
    /output path drift/,
  );
});

test("本地 PNG 字节必须与清单的 512 尺寸和 SHA-256 同时一致", async () => {
  const content = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#7b6652" },
  }).png().toBuffer();
  const entry = {
    localFile: "runtime/director-previews/human/asset-0.png",
    outputSha256: createHash("sha256").update(content).digest("hex"),
    width: 512,
    height: 512,
  };
  await assert.doesNotReject(verifyDirectorPreviewPng(content, entry));
  await assert.rejects(
    verifyDirectorPreviewPng(content, { ...entry, outputSha256: "f".repeat(64) }),
    /hash drift/,
  );
  const wrongSize = await sharp({
    create: { width: 511, height: 512, channels: 3, background: "#7b6652" },
  }).png().toBuffer();
  await assert.rejects(verifyDirectorPreviewPng(wrongSize, entry), /metadata drift/);
});
