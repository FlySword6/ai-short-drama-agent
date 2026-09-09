import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { assetEntities, assetMedia, videoIngestTasks } from "../../db/schema.js";
import {
  buildVideoAssetName,
  shouldReplaceVideoAssetName,
  VideoIngestRepository,
} from "./repository.js";
import type { NormalizedVideoUnderstanding } from "./types.js";

test("video ingest success splits searchable video text into display fields", async () => {
  const normalized = {
    summary: "Rain night chase with handheld camera motion.",
    video_subtype: "action_reference",
    scene: "wet neon street",
    characters: ["lead"],
    actions: ["running"],
    camera_motion: ["handheld tracking"],
    visual_style: ["high contrast"],
    audio_cues: ["rain"],
    timeline: [],
    tags: ["rain", "chase"],
  } satisfies NormalizedVideoUnderstanding;
  const vectorText = [
    "\u7d20\u6750\u7c7b\u578b\uff1a\u53c2\u8003\u89c6\u9891",
    "\u6458\u8981\uff1aRain night chase with handheld camera motion.",
    "\u573a\u666f\uff1awet neon street",
  ].join("\n");
  const task = {
    id: "task-1",
    assetEntityId: "asset-1",
    assetMediaId: "media-1",
    operatorTaskId: "operator-task-1",
    taskTemplate: "dense_video_captioning",
  };
  const asset = {
    id: "asset-1",
    name: "asset-videos/source.mp4",
    displayName: "asset-videos/source.mp4",
    intro: null,
    appearance: "old appearance",
    outfitDescription: null,
    metadata: {},
  };
  const media = {
    id: "media-1",
    title: "asset-videos/source.mp4",
    description: null,
    widthPx: null,
    heightPx: null,
    metadata: {},
  };
  const assetPatches: Array<Record<string, unknown>> = [];

  const transaction = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === videoIngestTasks) return [task];
            if (table === assetEntities) return [asset];
            if (table === assetMedia) return [media];
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        if (table === assetEntities) assetPatches.push(patch);
        return {
          where: () => ({
            returning: async () => table === assetEntities ? [{ ...asset, ...patch }] : [],
          }),
        };
      },
    }),
  };
  const db = {
    transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  } as unknown as Database;

  const updated = await new VideoIngestRepository(db).markSucceeded({
    taskId: task.id,
    rawResult: {},
    normalizedResult: normalized,
    vectorText,
  });

  const assetPatch = assetPatches[0];
  assert.ok(assetPatch);
  assert.equal(assetPatch.appearance, [
    "\u573a\u666f\uff1awet neon street",
    "\u89d2\u8272\uff1alead",
    "\u52a8\u4f5c\uff1arunning",
    "\u8fd0\u955c\uff1ahandheld tracking",
    "\u58f0\u97f3\u7ebf\u7d22\uff1arain",
  ].join("\n"));
  assert.doesNotMatch(String(assetPatch.appearance), /\u7d20\u6750\u7c7b\u578b|\u6458\u8981|\u89c6\u89c9\u98ce\u683c|\u6807\u7b7e/);
  assert.equal(assetPatch.outfitDescription, "\u89c6\u89c9\u98ce\u683c\uff1ahigh contrast");
  assert.equal(assetPatch.category, "\u89c6\u9891");
  assert.equal(updated.appearance, assetPatch.appearance);
  assert.equal(updated.outfitDescription, "\u89c6\u89c9\u98ce\u683c\uff1ahigh contrast");
  assert.equal(updated.category, "\u89c6\u9891");
});

test("视频资产命名: UUID/hash 名称解析成功后应替换为业务短名", () => {
  const normalized: NormalizedVideoUnderstanding = {
    summary: "黄昏的乡村村口，年轻男孩看到老人后从惊讶转为动容，上前和老人拥抱，呈现出温暖的重逢场景",
    video_subtype: "finished_style_reference",
    scene: "黄昏日落时分的乡村村落村口",
    characters: ["老年男性", "年轻背包男孩"],
    actions: ["两人紧紧相拥"],
    camera_motion: [],
    visual_style: ["暖金色黄昏光影"],
    audio_cues: [],
    timeline: [],
    tags: ["亲情重逢", "乡村黄昏", "祖孙", "拥抱", "3D动画"],
  };

  assert.equal(buildVideoAssetName(normalized, "87f6d2cf-3841-4919-b296-2deca3e3c145"), "亲情重逢 · 乡村黄昏 · 祖孙");
  assert.equal(
    shouldReplaceVideoAssetName("87f6d2cf-3841-4919-b296-2deca3e3c145", "87f6d2cf-3841-4919-b296-2deca3e3c145"),
    true,
  );
});

test("视频资产命名: 人工填写的业务名不被解析结果覆盖", () => {
  assert.equal(shouldReplaceVideoAssetName("雨夜追逐动作参考", "雨夜追逐动作参考"), false);
  assert.equal(shouldReplaceVideoAssetName("rain chase", "rain chase"), false);
});
