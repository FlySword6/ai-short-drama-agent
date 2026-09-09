import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDirectorPreviewGlbHasNoExternalUris,
  buildDirectorPreviewRenderJobs,
  canReuseDirectorPreview,
  directorPreviewPaths,
  isDirectorPreviewRequestAllowed,
  validateDirectorPreviewDescriptions,
  type DirectorPreviewDescriptionManifest,
} from "./directorPreviewRenderer.js";
import {
  DIRECTOR_ASSET_EXPECTED_COUNT,
  type DirectorManifest,
} from "./directorManifestImport.js";

function sourceManifest(): DirectorManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-04T00:00:00.000Z",
    assets: Array.from({ length: DIRECTOR_ASSET_EXPECTED_COUNT }, (_, index) => ({
      id: `demo/asset-${index}`,
      name: `Asset ${index}`,
      category: "human",
      source: "test",
      license: "CC0-1.0",
      tosKey: `director-assets/v1/test/human/asset-${index}.glb`,
      file: `test/human/asset-${index}.glb`,
      size: index + 1,
      sha256: index.toString(16).padStart(64, "0"),
      tags: ["demo"],
    })),
  };
}

function descriptionManifest(source = sourceManifest()): DirectorPreviewDescriptionManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-04T01:00:00.000Z",
    descriptions: source.assets.map((asset, index) => ({
      sourceTosKey: asset.tosKey,
      descriptionZh: `第 ${index} 个导演资产的中文视觉描述`,
      sourceSummary: "经审核的视觉描述清单",
    })),
  };
}

test("519 条中文描述与源 GLB 一一绑定并生成稳定输出路径", () => {
  const source = sourceManifest();
  const descriptions = descriptionManifest(source);
  validateDirectorPreviewDescriptions(descriptions, source);
  const first = buildDirectorPreviewRenderJobs(source, descriptions);
  const second = buildDirectorPreviewRenderJobs(source, descriptions);
  assert.equal(first.length, DIRECTOR_ASSET_EXPECTED_COUNT);
  assert.deepEqual(first, second);
  assert.equal(first[0]!.sourceFile, "runtime/director-assets/test/human/asset-0.glb");
  assert.equal(first[0]!.localFile, "runtime/director-previews/test/human/asset-0.png");
  assert.equal(first[0]!.storageKey, "asset-renditions/v1/director/edc622d930c1771f070f99520d40f2c2fa794507d0fe051fed7c3d19d927df99.png");
  assert.throws(
    () => directorPreviewPaths(
      "director-assets/v1/test/human/asset-0.glb",
      "../asset-0.glb",
    ),
    /safe TOS-relative path/,
  );
});

test("公开预览 storageKey 使用稳定不透明的源身份摘要", () => {
  const sourceTosKey = "director-assets/v1/test/human/asset-0.glb";
  const first = directorPreviewPaths(sourceTosKey, "test/human/asset-0.glb");
  const second = directorPreviewPaths(sourceTosKey, "test/human/asset-0.glb");
  assert.equal(first.storageKey, second.storageKey);
  assert.match(first.storageKey, /^asset-renditions\/v1\/director\/[a-f0-9]{64}\.png$/);
  assert.doesNotMatch(first.storageKey, /test\/human|asset-0/);
});
test("缺项、重复源和非中文占位都会在渲染前拦截", () => {
  const source = sourceManifest();
  const descriptions = descriptionManifest(source);
  assert.throws(() => validateDirectorPreviewDescriptions({
    ...descriptions,
    descriptions: descriptions.descriptions.slice(1),
  }, source), /exactly 519/);
  assert.throws(() => validateDirectorPreviewDescriptions({
    ...descriptions,
    descriptions: [...descriptions.descriptions.slice(0, -1), descriptions.descriptions[0]!],
  }, source), /duplicate/);
  assert.throws(() => validateDirectorPreviewDescriptions({
    ...descriptions,
    descriptions: descriptions.descriptions.map((item, index) =>
      index === 0 ? { ...item, descriptionZh: "preview placeholder" } : item
    ),
  }, source), /reviewed Chinese description/);
});

test("离屏浏览器只允许精确 renderer origin 与运行必需的 data/blob", () => {
  const port = 43127;
  assert.equal(isDirectorPreviewRequestAllowed(`http://127.0.0.1:${port}/render`, port), true);
  assert.equal(isDirectorPreviewRequestAllowed("data:application/octet-stream;base64,AA==", port), true);
  assert.equal(isDirectorPreviewRequestAllowed("blob:http://127.0.0.1:43127/asset", port), true);
  for (const blocked of [
    `http://localhost:${port}/render`,
    "http://127.0.0.1:43128/render",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/internal",
    "https://example.com/model.glb",
  ]) {
    assert.equal(isDirectorPreviewRequestAllowed(blocked, port), false, blocked);
  }
});

test("缓存 PNG 必须与上一版 manifest 的源和输出哈希同时匹配", () => {
  const job = {
    sourceTosKey: "director-assets/v1/test/human/asset-0.glb",
    sourceSha256: "a".repeat(64),
  };
  const outputSha256 = "b".repeat(64);
  assert.equal(canReuseDirectorPreview(job, outputSha256, { ...job, outputSha256 }), true);
  assert.equal(canReuseDirectorPreview({ ...job, sourceSha256: "c".repeat(64) }, outputSha256, { ...job, outputSha256 }), false);
  assert.equal(canReuseDirectorPreview(job, "d".repeat(64), { ...job, outputSha256 }), false);
  assert.equal(canReuseDirectorPreview(job, outputSha256, undefined), false);
});

test("GLB 中的外部 URI 在启动浏览器前被拒绝", () => {
  const document = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, images: [{ uri: "http://169.254.169.254/secret" }] }));
  const glb = Buffer.alloc(20 + document.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(document.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  document.copy(glb, 20);
  assert.throws(() => assertDirectorPreviewGlbHasNoExternalUris(glb), /external URIs/);
});
