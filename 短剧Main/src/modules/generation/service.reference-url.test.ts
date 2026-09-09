import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGenerationInput } from "./service.js";
import { ARK_SEEDREAM_5_PRO_MODEL, V01_VIDEO_MODEL } from "./v01Contract.js";

const common = {
  projectId: "0bf44a4b-9154-44e6-9865-75d3d38a7996",
  targetAssetEntityId: "b9389d2e-37e2-4fa8-9e20-c1e29f07c1fb",
  prompt: "雨夜巷口，人物缓慢回头",
  clientIdempotencyKey: "seedance-asset-uri-test",
  quantity: 1,
} as const;

test("已注册素材 URI 能穿过 Seedance 视频提交规范化", () => {
  const normalized = normalizeGenerationInput({
    ...common,
    mediaKind: "video",
    model: V01_VIDEO_MODEL,
    referenceAssetSnapshots: [{ kind: "image", url: "asset://Asset-registered" }],
  });
  assert.deepEqual(normalized.referenceAssetSnapshots, [
    { kind: "image", url: "asset://Asset-registered", role: "reference_image" },
  ]);
});

test("已注册素材 URI 在非 Seedance 或锚帧位置严格拒绝", () => {
  assert.throws(
    () => normalizeGenerationInput({
      ...common,
      mediaKind: "image",
      model: ARK_SEEDREAM_5_PRO_MODEL,
      referenceAssetSnapshots: [{ kind: "image", url: "asset://Asset-registered" }],
    }),
    /视频生成的普通参考位/,
  );
  assert.throws(
    () => normalizeGenerationInput({
      ...common,
      mediaKind: "video",
      model: V01_VIDEO_MODEL,
      referenceAssetSnapshots: [{ kind: "image", url: "asset://Asset-registered", role: "first_frame" }],
    }),
    /首帧或尾帧/,
  );
});
