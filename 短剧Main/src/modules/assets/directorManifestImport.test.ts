import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECTOR_ASSET_EXPECTED_COUNT,
  buildDirectorAssetImportPlan,
  classifyDirectorAssetPath,
  deterministicUuid,
  summarizeDirectorAssetDryRun,
  validateDirectorManifest,
  validateKimiDirectorUploadReceipt,
  type DirectorManifest,
} from "./directorManifestImport.js";

function manifest(): DirectorManifest {
  const assets = Array.from({ length: DIRECTOR_ASSET_EXPECTED_COUNT }, (_, index) => ({
    id: `demo/asset-${index}`,
    name: `Asset ${index}`,
    category: "demo",
    source: "test",
    license: "CC0-1.0",
    tosKey: `director-assets/v1/human/asset-${index}.glb`,
    file: `human/asset-${index}.glb`,
    size: index + 1,
    sha256: index.toString(16).padStart(64, "0"),
    tags: ["demo", "3d"],
  }));
  return { schemaVersion: 1, generatedAt: "2026-07-20T08:22:17.054Z", assets };
}

const acceptedReceipt = `uploaded=518 / skipped=1（canary）/ failed=0\n匿名 HEAD 200 = 519/519\ndrama-asset / cn-beijing / director-assets/v1/`;

test("Kimi receipt and 519-entry manifest must be complete and uniquely addressable", () => {
  const value = manifest();
  validateKimiDirectorUploadReceipt(acceptedReceipt);
  validateDirectorManifest(value);
  assert.throws(() => validateDirectorManifest({ ...value, assets: value.assets.slice(1) }), /exactly 519/);
  assert.throws(() => validateDirectorManifest({ ...value, assets: [...value.assets.slice(0, -1), value.assets[0]!] }), /duplicate id/);
  assert.throws(() => validateKimiDirectorUploadReceipt("uploaded=519 / failed=0"), /incomplete/);
});

test("deterministic IDs and import plan remain stable across repeat runs", () => {
  const value = manifest();
  const first = buildDirectorAssetImportPlan(value, {
    bucket: "drama-asset",
    publicBaseUrl: "https://assets.example.com/",
    receiptAcceptedAt: "2026-07-20T00:00:00.000Z",
    reviewerUserId: "11111111-1111-4111-8111-111111111111",
  });
  const second = buildDirectorAssetImportPlan(value, {
    bucket: "drama-asset",
    publicBaseUrl: "https://assets.example.com",
    receiptAcceptedAt: "2026-07-20T00:00:00.000Z",
    reviewerUserId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(first.sourceProject.id, second.sourceProject.id);
  assert.equal(first.assets[0]!.entity.id, second.assets[0]!.entity.id);
  assert.equal(first.assets[0]!.media.id, second.assets[0]!.media.id);
  assert.equal(first.assets[0]!.auditAction?.id, second.assets[0]!.auditAction?.id);
  assert.equal(first.assets[0]!.auditAction?.toStatus, "approved");
  assert.equal(first.assets[0]!.media.storageUrl, "https://assets.example.com/director-assets/v1/human/asset-0.glb");
  assert.equal(deterministicUuid("same"), deterministicUuid("same"));
  assert.notEqual(deterministicUuid("same"), deterministicUuid("different"));
});

test("path map separates character, scene, prop, clothing and reference classes", () => {
  assert.equal(classifyDirectorAssetPath("director-assets/v1/human/actor.glb")?.assetKind, "character");
  assert.equal(classifyDirectorAssetPath("director-assets/v1/city-roads/street.glb")?.assetKind, "scene");
  assert.equal(classifyDirectorAssetPath("director-assets/v1/furniture/chair.glb")?.assetKind, "prop");
  assert.equal(classifyDirectorAssetPath("director-assets/v1/clothing/coat.glb")?.assetKind, "clothing");
  assert.equal(classifyDirectorAssetPath("director-assets/v1/reference/camera.glb")?.assetKind, "other");
  assert.equal(classifyDirectorAssetPath("director-assets/v1/unknown/item.glb"), null);
});

test("pending switch follows review states and dry-run reports unknown paths", () => {
  const value = manifest();
  const plan = buildDirectorAssetImportPlan(value, {
    bucket: "drama-asset",
    publicBaseUrl: "https://assets.example.com",
    receiptAcceptedAt: "2026-07-20T00:00:00.000Z",
    reviewState: "pending",
    reviewerUserId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(plan.assets[0]!.entity.status, "pending_review");
  assert.equal(plan.assets[0]!.entity.approved, null);
  assert.equal(plan.assets[0]!.auditAction?.action, "submitted");
  assert.equal(plan.assets[0]!.auditAction?.toStatus, "pending_review");
  value.assets[0]!.tosKey = "director-assets/v1/unknown/item.glb";
  const dryRun = summarizeDirectorAssetDryRun(value);
  assert.deepEqual(dryRun.unrecognized, [{ id: "demo/asset-0", tosKey: "director-assets/v1/unknown/item.glb" }]);
  assert.throws(() => buildDirectorAssetImportPlan(value, {
    bucket: "drama-asset",
    publicBaseUrl: "https://assets.example.com",
    receiptAcceptedAt: "2026-07-20T00:00:00.000Z",
  }), /unrecognized path/);
});

test("plan fails closed when bucket or manifest prefix is inconsistent", () => {
  const value = manifest();
  assert.throws(() => buildDirectorAssetImportPlan(value, {
    bucket: "another-bucket",
    publicBaseUrl: "https://assets.example.com",
    receiptAcceptedAt: "2026-07-20T00:00:00.000Z",
  }), /TOS_BUCKET/);
  value.assets[0]!.tosKey = "elsewhere/asset.glb";
  assert.throws(() => validateDirectorManifest(value), /director-assets/);
});
