import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeliverableManifest,
  buildPlaybackList,
  manifestToCsv,
  type DeliverableMediaInput,
} from "./manifest.js";

function media(input: Partial<DeliverableMediaInput> = {}): DeliverableMediaInput {
  return {
    projectId: "project-1",
    projectName: "杀穿女频",
    episodeId: "episode-1",
    episodeNo: 1,
    shotId: "shot-1",
    shotCode: "1",
    shotSortOrder: 1,
    mediaId: "media-1",
    mediaKind: "video",
    originKind: "generation",
    sourceAssetMediaId: null,
    storageUrl: "https://tos.example/projects/project-1/shots/shot-1/video/task/result.mp4",
    storagePath: "projects/project-1/shots/shot-1/video/task/result.mp4",
    mimeType: "video/mp4",
    durationSeconds: 5,
    generationRequestId: "request-1",
    generationAttemptId: "attempt-1",
    provider: "ark",
    model: "seedance",
    parameters: { ratio: "16:9" },
    estimatedCostFen: 1250,
    ...input,
  };
}

test("交付清单按分镜排序并汇总预估费用", () => {
  const manifest = buildDeliverableManifest([
    media({ shotId: "shot-2", shotCode: "2", shotSortOrder: 2, mediaId: "media-2" }),
    media(),
  ], new Date("2026-07-14T12:00:00.000Z"));
  assert.equal(manifest.items[0]?.shotCode, "1");
  assert.equal(manifest.estimatedCostFen, 2500);
  assert.equal(manifest.estimatedCostNotice, "预估消耗，非云平台实际账单");
});

test("播放列表只包含视频并保持分镜顺序", () => {
  const manifest = buildDeliverableManifest([
    media({ mediaKind: "image", mediaId: "image-1" }),
    media({ shotId: "shot-2", shotCode: "2", shotSortOrder: 2, mediaId: "video-2" }),
    media(),
  ]);
  assert.deepEqual(buildPlaybackList(manifest).map((item) => item.mediaId), ["media-1", "video-2"]);
});

test("CSV 正确转义项目名", () => {
  const csv = manifestToCsv(buildDeliverableManifest([media({ projectName: "项目,第一期" })]));
  assert.match(csv, /"项目,第一期"/);
  assert.match(csv, /estimated_cost_fen/);
});

test("拒绝使用未持久化媒体生成交付清单", () => {
  assert.throws(() => buildDeliverableManifest([media({ storageUrl: "", storagePath: "" })]), /尚未持久化/);
});
