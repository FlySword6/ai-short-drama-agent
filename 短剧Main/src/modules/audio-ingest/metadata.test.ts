import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAudioAssetMetadata,
  buildAudioAssetVectorText,
  buildAudioStyleTags,
} from "./metadata.js";

test("音色 metadata 只保存 voice_traits 和 speaking_style,不复制 description", () => {
  const metadata = buildAudioAssetMetadata({
    category: "音色",
    voiceTraits: ["  低沉  ", "克制", "", "低沉", "温柔".repeat(20)],
    speakingStyle: "  旁白  ",
    musicTraits: ["不应保留"],
    tempo: "慢",
    usageScene: "反转",
  });

  assert.equal(metadata.kind, "voice");
  assert.deepEqual(metadata.voice_traits, ["低沉", "克制", "温柔".repeat(16)]);
  assert.equal(metadata.speaking_style, "旁白");
  assert.equal("music_traits" in metadata, false);
  assert.equal("tempo" in metadata, false);
  assert.equal("usage_scene" in metadata, false);
  assert.equal("description" in metadata, false);
});

test("背景音乐 metadata 只保存 music_traits、tempo 和 usage_scene", () => {
  const metadata = buildAudioAssetMetadata({
    category: "背景音乐",
    voiceTraits: ["不应保留"],
    speakingStyle: "旁白",
    musicTraits: ["  悬疑  ", "压抑", "悬疑"],
    tempo: "  慢  ",
    usageScene: "  反转  ",
  });

  assert.deepEqual(metadata, {
    kind: "background_music",
    music_traits: ["悬疑", "压抑"],
    tempo: "慢",
    usage_scene: "反转",
  });
  assert.equal("voice_traits" in metadata, false);
  assert.equal("speaking_style" in metadata, false);
  assert.equal("description" in metadata, false);
});

test("音频 style tags 从分类和专属字段生成,去空去重", () => {
  const voice = buildAudioAssetMetadata({
    category: "音色",
    voiceTraits: ["低沉", "克制", "低沉"],
    speakingStyle: "旁白",
  });
  const music = buildAudioAssetMetadata({
    category: "背景音乐",
    musicTraits: ["悬疑", "压抑"],
    tempo: "慢",
    usageScene: "反转",
  });

  assert.deepEqual(buildAudioStyleTags("音色", voice), ["音色", "低沉", "克制", "旁白"]);
  assert.deepEqual(buildAudioStyleTags("背景音乐", music), ["背景音乐", "悬疑", "压抑", "慢", "反转"]);
});

test("音频检索文本包含名称、分类、通用描述和专属字段", () => {
  const voiceText = buildAudioAssetVectorText({
    name: "沈舟旁白",
    description: "低沉克制的男主旁白参考",
    category: "音色",
    metadata: {
      kind: "voice",
      voice_traits: ["低沉", "克制"],
      speaking_style: "旁白",
    },
  });
  assert.match(voiceText, /名称:沈舟旁白/);
  assert.match(voiceText, /类型:音频 \/ 音色/);
  assert.match(voiceText, /描述:低沉克制/);
  assert.match(voiceText, /音色特征:低沉、克制/);
  assert.match(voiceText, /说话方式:旁白/);

  const musicText = buildAudioAssetVectorText({
    name: "都市悬疑铺底",
    description: null,
    category: "背景音乐",
    metadata: {
      kind: "background_music",
      music_traits: ["悬疑", "低频"],
      tempo: "慢",
      usage_scene: "反转",
    },
  });
  assert.match(musicText, /名称:都市悬疑铺底/);
  assert.match(musicText, /类型:音频 \/ 背景音乐/);
  assert.match(musicText, /音乐特征:悬疑、低频/);
  assert.match(musicText, /节奏:慢/);
  assert.match(musicText, /使用场景:反转/);
});
