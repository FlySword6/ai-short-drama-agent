import assert from "node:assert/strict";
import test from "node:test";
import { assetEntities, assetMedia, mediaProvenanceSubjects } from "../../db/schema.js";
import { audioAssetClassification, audioMediaFormatFromFile, AudioAssetIngestRepository } from "./repository.js";
import type { AudioAssetMetadata } from "./types.js";

test("音频资产分类:新增音频固定写 audio 大类且不写生成引用用途", () => {
  assert.deepEqual(audioAssetClassification("音色"), {
    assetKind: "audio",
    category: "音色",
    role: null,
    usageMode: null,
  });
  assert.deepEqual(audioAssetClassification("背景音乐"), {
    assetKind: "audio",
    category: "背景音乐",
    role: null,
    usageMode: null,
  });
});

test("音频媒体格式:只识别 wav/mp3/ogg/opus,未知格式不默认成 mp3", () => {
  assert.equal(audioMediaFormatFromFile("voice.opus", "application/octet-stream"), "opus");
  assert.equal(audioMediaFormatFromFile("voice", "audio/opus"), "opus");
  assert.equal(audioMediaFormatFromFile("voice.ogg", "audio/opus"), "ogg");
  assert.equal(audioMediaFormatFromFile("voice", "audio/ogg"), "ogg");
  assert.equal(audioMediaFormatFromFile("voice.flac", "audio/flac"), null);
  assert.equal(audioMediaFormatFromFile("voice", "application/octet-stream"), null);
});

test("createAudioAsset 在同一事务写入资产、音频媒体和来源记录,不创建任务数据", async () => {
  const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const db = {
    transaction: async <T>(run: (transaction: unknown) => Promise<T>) => run({
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          inserts.push({ table, value });
          return { returning: async () => [value] };
        },
      }),
    }),
  };
  const audioMetadata: AudioAssetMetadata = {
    kind: "voice",
    voice_traits: ["低沉", "克制"],
    speaking_style: "旁白",
  };

  const result = await new AudioAssetIngestRepository(db as never).createAudioAsset({
    actorId: "11111111-1111-4111-8111-111111111111",
    sourceProjectId: "22222222-2222-4222-8222-222222222222",
    sourceProjectName: "参考音频素材库",
    name: "沈舟旁白",
    description: "低沉克制的男主旁白参考",
    category: "音色",
    audioMetadata,
    styleTags: ["音色", "低沉", "克制", "旁白"],
    vectorText: "名称:沈舟旁白\n类型:音频 / 音色\n描述:低沉克制的男主旁白参考",
    audio: {
      storageBucket: "shortdrama-assets",
      storagePath: "asset-audio/voice.mp3",
      storageUrl: "https://tos.example/asset-audio/voice.mp3",
      originalFileName: "voice.mp3",
      contentType: "audio/mpeg",
      contentLength: 1024,
      format: "mp3",
      sha256: "abc123",
    },
  });

  assert.equal(inserts.length, 3);
  assert.equal(inserts[0]?.table, assetEntities);
  assert.equal(inserts[1]?.table, assetMedia);
  assert.equal(inserts[2]?.table, mediaProvenanceSubjects);

  const asset = inserts[0]!.value;
  assert.equal(asset.id, result.assetId);
  assert.equal(asset.assetKind, "audio");
  assert.equal(asset.category, "音色");
  assert.equal(asset.role, null);
  assert.equal(asset.usageMode, null);
  assert.equal(asset.visibility, "personal");
  assert.equal(asset.approved, true);
  assert.equal(asset.status, "approved");
  assert.equal(asset.intro, "低沉克制的男主旁白参考");
  assert.equal(asset.appearance, "名称:沈舟旁白\n类型:音频 / 音色\n描述:低沉克制的男主旁白参考");
  assert.deepEqual(asset.styleTags, ["音色", "低沉", "克制", "旁白"]);
  const assetAudio = (asset.metadata as { audio_asset?: Record<string, unknown> }).audio_asset;
  assert.deepEqual(assetAudio?.voice_traits, ["低沉", "克制"]);
  assert.equal(assetAudio?.speaking_style, "旁白");
  assert.equal("description" in (assetAudio ?? {}), false);

  const media = inserts[1]!.value;
  assert.equal(media.id, result.mediaId);
  assert.equal(media.assetEntityId, result.assetId);
  assert.equal(media.mediaKind, "audio");
  assert.equal(media.description, "低沉克制的男主旁白参考");
  assert.equal(media.storageBucket, "shortdrama-assets");
  assert.equal(media.storagePath, "asset-audio/voice.mp3");
  assert.equal(media.format, "mp3");
  const mediaMetadata = media.metadata as { audio_asset?: Record<string, unknown>; vector_text?: string };
  assert.equal("description" in (mediaMetadata.audio_asset ?? {}), false);
  assert.equal(mediaMetadata.vector_text, asset.appearance);

  const provenance = inserts[2]!.value;
  assert.equal(provenance.assetMediaId, result.mediaId);
  assert.equal(provenance.sourceChannel, "external_upload");
  assert.equal(result.storageBucket, "shortdrama-assets");
  assert.equal(result.storagePath, "asset-audio/voice.mp3");
  assert.equal("taskId" in result, false);
});
