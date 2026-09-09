import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVideoAppearanceText,
  buildVideoOutfitDescriptionText,
  buildVideoVectorText,
  normalizeVideoUnderstanding,
  videoUnderstandingQuery,
} from "./normalizer.js";
import type { NormalizedVideoUnderstanding } from "./types.js";

test("video appearance excludes summary, tags and visual style while outfit keeps visual style", () => {
  const normalized = {
    summary: "Village reunion summary.",
    video_subtype: "finished_style_reference",
    scene: "village gate at dusk",
    characters: ["young man", "elder"],
    actions: ["hug"],
    camera_motion: ["slow push in"],
    visual_style: ["3D cartoon render", "warm dusk light"],
    audio_cues: ["soft music"],
    timeline: [{ start: 0, end: 5.2, description: "young man hugs elder" }],
    tags: ["family reunion", "3D animation"],
  } satisfies NormalizedVideoUnderstanding;

  const appearanceText = buildVideoAppearanceText(normalized);
  const outfitText = buildVideoOutfitDescriptionText(normalized);

  assert.equal(appearanceText, [
    "\u573a\u666f\uff1avillage gate at dusk",
    "\u89d2\u8272\uff1ayoung man\u3001elder",
    "\u52a8\u4f5c\uff1ahug",
    "\u8fd0\u955c\uff1aslow push in",
    "\u58f0\u97f3\u7ebf\u7d22\uff1asoft music",
    "\u65f6\u95f4\u7ebf\uff1a0s-5.2s young man hugs elder",
  ].join("\n"));
  assert.equal(outfitText, "\u89c6\u89c9\u98ce\u683c\uff1a3D cartoon render\u3001warm dusk light");
  assert.doesNotMatch(appearanceText, /\u7d20\u6750\u7c7b\u578b|\u6458\u8981|\u89c6\u89c9\u98ce\u683c|\u6807\u7b7e/);
});

test("视频理解标准化: 从 LAS JSON 字符串提取业务字段并生成检索文本", () => {
  const normalized = normalizeVideoUnderstanding({
    data: {
      result: JSON.stringify({
        summary: "女主在雨夜街头奔跑，镜头手持跟拍。",
        video_subtype: "action_reference",
        scene: "夜晚街道",
        characters: ["年轻女性"],
        actions: ["奔跑", "回头", "奔跑"],
        camera_motion: ["手持跟拍"],
        visual_style: ["雨夜", "紧张"],
        audio_cues: ["雨声", "脚步声"],
        timeline: [{ start: 0, end: 5.2, description: "女主从巷口跑出" }],
        tags: ["雨夜", "追逐"],
      }),
    },
  }, "fallback.mp4");

  assert.equal(normalized.video_subtype, "action_reference");
  assert.deepEqual(normalized.actions, ["奔跑", "回头"]);
  assert.deepEqual(normalized.timeline, [{ start: 0, end: 5.2, description: "女主从巷口跑出" }]);
  const vectorText = buildVideoVectorText(normalized);
  assert.match(vectorText, /素材类型：参考视频/);
  assert.match(vectorText, /手持跟拍/);
  assert.match(vectorText, /0s-5.2s 女主从巷口跑出/);
});

test("视频理解标准化: 优先解析 LAS data.final_summary 字符串", () => {
  const normalized = normalizeVideoUnderstanding({
    data: {
      final_summary: JSON.stringify({
        summary: "黄昏乡村村口，男孩与老人温暖重逢拥抱。",
        video_subtype: "finished_style_reference",
        scene: "黄昏日落时分的乡村村口",
        characters: ["老年男性", "年轻背包男孩"],
        actions: [
          { time_range: "0-2s", content: "老人静立于村口空地" },
          { time_range: "8-14s", content: "两人紧紧相拥" },
        ],
        camera_motion: ["固定远景后切近景"],
        visual_style: "3D卡通渲染，暖金色黄昏光影",
        audio_cues: "无明确台词，舒缓温情",
        timeline: [{ start: 0, end: 2, description: "老人站在黄昏乡村村口" }],
        tags: ["亲情重逢", "乡村黄昏"],
      }),
      video_duration: 15.104,
    },
  }, "asset-videos/fallback.mp4");

  assert.equal(normalized.summary, "黄昏乡村村口，男孩与老人温暖重逢拥抱。");
  assert.equal(normalized.video_subtype, "finished_style_reference");
  assert.equal(normalized.scene, "黄昏日落时分的乡村村口");
  assert.deepEqual(normalized.actions, ["老人静立于村口空地", "两人紧紧相拥"]);
  assert.deepEqual(normalized.tags, ["亲情重逢", "乡村黄昏"]);
  assert.notEqual(normalized.summary, "asset-videos/fallback.mp4");
});

test("视频理解 query 固定要求短剧参考视频 JSON 字段", () => {
  const query = videoUnderstandingQuery();
  assert.match(query, /短剧参考视频/);
  assert.match(query, /summary/);
  assert.match(query, /camera_motion/);
  assert.match(query, /timeline/);
});
