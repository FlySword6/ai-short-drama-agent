import assert from "node:assert/strict";
import test from "node:test";
import type { ControlPackageReference } from "../src/modules/vnext/control-packages/types.js";
import { VnextDatabaseReferenceResolver } from "../src/modules/vnext/generation/referenceResolver.js";
import { TosStorage } from "../src/integrations/tosStorage.js";

const projectId = "aaaaaaaa-0000-4000-8000-000000000001";
const storyboardVersionId = "bbbbbbbb-0000-4000-8000-000000000002";
const assetVersionId = "cccccccc-0000-4000-8000-000000000003";

function reference(referenceVersionId: string, position: number): ControlPackageReference {
  return {
    referenceId: "dddddddd-0000-4000-8000-000000000004",
    referenceVersionId,
    label: `参考 ${position + 1}`,
    reason: "保持画面一致",
    position,
    capabilitySnapshot: { version: "caps-1", capturedAt: "2026-08-16T00:00:00.000Z", capabilities: ["image-reference"] },
  };
}

test("reference resolver preserves control-package order and provider media kind", async () => {
  const db = {
    async execute() {
      return { rows: [
        { reference_version_id: assetVersionId, kind: "video", url: "https://assets.example/reference.mp4" },
        { reference_version_id: storyboardVersionId, kind: "image", url: "https://assets.example/storyboard.png" },
      ] };
    },
  };
  const resolver = new VnextDatabaseReferenceResolver(db as never);
  const result = await resolver.resolve(projectId, [reference(storyboardVersionId, 0), reference(assetVersionId, 1)]);
  assert.deepEqual(result, [
    { referenceVersionId: storyboardVersionId, kind: "image", url: "https://assets.example/storyboard.png" },
    { referenceVersionId: assetVersionId, kind: "video", url: "https://assets.example/reference.mp4" },
  ]);
});

test("reference resolver signs private TOS video versions before provider submission", async () => {
  const videoVersionId = "eeeeeeee-0000-4000-8000-000000000005";
  const db = {
    async execute() {
      return { rows: [{
        reference_version_id: videoVersionId,
        kind: "video",
        url: "https://drama-asset.tos-cn-beijing.volces.com/vnext/origin.mp4",
        storage_bucket: "drama-asset",
        object_key: "vnext/generation/task/attempt/0.mp4",
      }] };
    },
  };
  const calls: Array<{ storagePath: string; options: unknown }> = [];
  const resolver = new VnextDatabaseReferenceResolver(db as never, {
    async createDownloadUrl(storagePath, options) {
      calls.push({ storagePath, options });
      return { url: "https://drama-asset.tos-cn-beijing.volces.com/vnext/origin.mp4?X-Tos-Signature=test", expiresAt: new Date() };
    },
  });

  const result = await resolver.resolve(projectId, [reference(videoVersionId, 0)]);
  assert.deepEqual(result, [{
    referenceVersionId: videoVersionId,
    kind: "video",
    url: "https://drama-asset.tos-cn-beijing.volces.com/vnext/origin.mp4?X-Tos-Signature=test",
  }]);
  assert.deepEqual(calls, [{
    storagePath: "vnext/generation/task/attempt/0.mp4",
    options: { bucket: "drama-asset", expiresSeconds: 900 },
  }]);
});

test("TOS upload uses an HTTPS bucket URL without a configured public base", async () => {
  const storage = new TosStorage({
    client: { async putObject() {} },
    config: { bucket: "assets", endpoint: "tos.example.com", accessKey: "test", secretKey: "test", region: "cn-beijing" },
  });

  assert.deepEqual(await storage.uploadBytes(Buffer.from("content"), "vnext/video.mp4", "video/mp4"), {
    bucket: "assets",
    storagePath: "vnext/video.mp4",
    storageUrl: "https://assets.tos.example.com/vnext/video.mp4",
  });
});

test("reference resolver fails closed when an immutable version cannot be resolved", async () => {
  const db = { async execute() { return { rows: [] }; } };
  const resolver = new VnextDatabaseReferenceResolver(db as never);
  await assert.rejects(
    resolver.resolve(projectId, [reference(storyboardVersionId, 0)]),
    /不存在、未通过审核或不支持/,
  );
});
