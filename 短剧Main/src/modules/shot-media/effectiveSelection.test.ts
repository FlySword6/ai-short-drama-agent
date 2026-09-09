import assert from "node:assert/strict";
import test from "node:test";
import type { MediaReviewStrategies } from "../reviews/mediaPolicy.js";
import { resolveEffectiveShotMedia, type EffectiveMediaCandidate } from "./effectiveSelection.js";

const automatic: MediaReviewStrategies = { image: "automatic", video: "automatic", audio: "automatic" };

test("无人工选择时按媒体类型取最新成功生成结果", () => {
  const selected = resolveEffectiveShotMedia(
    { imageId: null, videoId: null },
    [
      media("image-old", "image", "2026-08-06T01:00:00.000Z"),
      media("image-new", "image", "2026-08-06T02:00:00.000Z"),
      media("video-new", "video", "2026-08-06T03:00:00.000Z"),
    ],
    automatic,
  );
  assert.deepEqual(selected, {
    image: { id: "image-new", source: "latest_default" },
    video: { id: "video-new", source: "latest_default" },
  });
});

test("图片与视频独立定稿，人工选择固定后新结果不能覆盖", () => {
  const selected = resolveEffectiveShotMedia(
    { imageId: "image-manual", videoId: null },
    [
      media("image-newer", "image", "2026-08-06T03:00:00.000Z"),
      media("video-default", "video", "2026-08-06T04:00:00.000Z"),
    ],
    automatic,
  );
  assert.deepEqual(selected.image, { id: "image-manual", source: "manual" });
  assert.deepEqual(selected.video, { id: "video-default", source: "latest_default" });
});

test("系统默认不使用失败、未持久化、被拒绝或资产登记结果", () => {
  const candidates = [
    media("failed", "image", "2026-08-06T04:00:00.000Z", { attemptStatus: "failed" }),
    media("pending", "image", "2026-08-06T03:00:00.000Z", { persistenceStatus: "pending_persistence" }),
    media("rejected", "image", "2026-08-06T02:00:00.000Z", { reviewStatus: "rejected" }),
    media("asset", "image", "2026-08-06T01:00:00.000Z", { originKind: "asset_media" }),
  ];
  assert.equal(resolveEffectiveShotMedia({ imageId: null, videoId: null }, candidates, automatic).image, null);
});

test("同一批多个结果稳定选择 result_index 最小的一张", () => {
  const createdAt = "2026-08-06T01:00:00.000Z";
  const selected = resolveEffectiveShotMedia(
    { imageId: null, videoId: null },
    [
      media("second", "image", createdAt, { resultIndex: 1 }),
      media("first", "image", createdAt, { resultIndex: 0 }),
    ],
    automatic,
  );
  assert.deepEqual(selected.image, { id: "first", source: "latest_default" });
});

function media(
  id: string,
  mediaKind: "image" | "video",
  createdAt: string,
  overrides: Partial<EffectiveMediaCandidate> = {},
): EffectiveMediaCandidate {
  return {
    id,
    mediaKind,
    originKind: "generation",
    persistenceStatus: "persisted",
    reviewStatus: "accepted",
    attemptStatus: "succeeded",
    batchId: `batch-${createdAt}`,
    batchCreatedAt: new Date(createdAt),
    resultIndex: 0,
    ...overrides,
  };
}
