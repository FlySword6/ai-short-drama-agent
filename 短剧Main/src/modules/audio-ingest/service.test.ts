import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { BadRequestError } from "../../shared/errors.js";
import { assertAudioContent, AudioIngestService } from "./service.js";
import type { CreateAudioAssetInput, CreatedAudioAssetRecord } from "./repository.js";

const actorId = "55555555-5555-4555-8555-555555555555";
const assetId = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";

test("submitUploadedFile 上传本地音频后同步创建音色资产,不返回任务字段", async () => {
  const content = Buffer.from("fake audio content");
  const expectedHash = createHash("sha256").update(content).digest("hex");
  let uploaded: { storagePath: string; contentType: string; content: Buffer } | undefined;
  let created: CreateAudioAssetInput | undefined;
  let vectorSynced = false;
  const service = createService({
    storage: {
      uploadBytes: async (actualContent, storagePath, contentType) => {
        uploaded = { content: actualContent, storagePath, contentType };
        return {
          bucket: "shortdrama-assets",
          storagePath,
          storageUrl: `https://tos.example/${storagePath}`,
        };
      },
      headObject: async () => {
        throw new Error("not used");
      },
    },
    repository: {
      createAudioAsset: async (input: CreateAudioAssetInput) => {
        created = input;
        return createdRecord(input);
      },
    },
    vectorSync: {
      syncEntity: async () => {
        vectorSynced = true;
      },
    },
  });

  const result = await service.submitUploadedFile({
    actorId,
    sourceProjectName: "audio refs",
    name: " low voice ",
    description: " calm ",
    category: "音色",
    audioMetadata: {
      kind: "voice",
      voice_traits: ["  低沉  ", "克制", "低沉"],
      speaking_style: "  旁白  ",
    },
    file: {
      fileName: "low voice.mp3",
      contentType: "audio/mpeg",
      content,
    },
  });

  assert.equal(uploaded?.content, content);
  assert.equal(uploaded?.contentType, "audio/mpeg");
  assert.equal(uploaded?.storagePath, `asset-audio/${expectedHash.slice(0, 12)}_low_voice.mp3`);
  assert.equal(created?.sourceProjectId, "11111111-1111-4111-8111-111111111111");
  assert.equal(created?.sourceProjectName, "audio refs");
  assert.equal(created?.name, "low voice");
  assert.equal(created?.description, "calm");
  assert.equal(created?.category, "音色");
  assert.deepEqual(created?.audioMetadata, {
    kind: "voice",
    voice_traits: ["低沉", "克制"],
    speaking_style: "旁白",
  });
  assert.deepEqual(created?.styleTags, ["音色", "低沉", "克制", "旁白"]);
  assert.match(created?.vectorText ?? "", /描述:calm/);
  assert.equal(created?.audio.originalFileName, "low voice.mp3");
  assert.equal(created?.audio.contentLength, content.length);
  assert.equal(created?.audio.sha256, expectedHash);
  assert.equal(result.assetId, assetId);
  assert.equal(result.mediaId, mediaId);
  assert.equal(result.storageBucket, "shortdrama-assets");
  assert.equal("taskId" in result, false);
  assert.equal("status" in result, false);
  assert.equal(vectorSynced, true);
});

test("submit 登记已有 TOS 背景音乐并复用对象元数据", async () => {
  let headed: { path: string; bucket?: string } | undefined;
  let uploaded = false;
  let created: CreateAudioAssetInput | undefined;
  const service = createService({
    storage: {
      headObject: async (storagePath, bucket) => {
        headed = { path: storagePath, bucket };
        return {
          contentLength: 1_579_736,
          contentType: "audio/opus",
          etag: "etag",
          lastModified: null,
        };
      },
      uploadBytes: async () => {
        uploaded = true;
        throw new Error("not used");
      },
    },
    repository: {
      createAudioAsset: async (input: CreateAudioAssetInput) => {
        created = input;
        return createdRecord(input);
      },
    },
  });

  const result = await service.submit({
    actorId,
    sourceProjectName: "audio refs",
    name: "moonlit",
    description: null,
    category: "背景音乐",
    audioMetadata: {
      kind: "background_music",
      music_traits: ["悬疑", "低频"],
      tempo: "慢",
      usage_scene: "反转",
    },
    audio: {
      storageBucket: "shortdrama-assets",
      storagePath: "asset-audio/moonlit.opus",
      storageUrl: null,
      originalFileName: "moonlit.opus",
      contentType: "",
    },
  });

  assert.deepEqual(headed, { path: "asset-audio/moonlit.opus", bucket: "shortdrama-assets" });
  assert.equal(uploaded, false);
  assert.equal(result.storagePath, "asset-audio/moonlit.opus");
  assert.equal(created?.audio.contentType, "audio/opus");
  assert.equal(created?.audio.contentLength, 1_579_736);
  assert.equal(created?.audio.format, "opus");
  assert.deepEqual(created?.audioMetadata, {
    kind: "background_music",
    music_traits: ["悬疑", "低频"],
    tempo: "慢",
    usage_scene: "反转",
  });
  assert.match(created?.vectorText ?? "", /音乐特征:悬疑、低频/);
  assert.match(created?.vectorText ?? "", /使用场景:反转/);
});

test("空来源名称不创建来源项目", async () => {
  const content = Buffer.from("fake audio content");
  let sourceProjectCalls = 0;
  let created: CreateAudioAssetInput | undefined;
  const service = createService({
    sourceProjects: {
      getOrCreate: async () => {
        sourceProjectCalls += 1;
        throw new Error("not used");
      },
    },
    repository: {
      createAudioAsset: async (input: CreateAudioAssetInput) => {
        created = input;
        return createdRecord(input);
      },
    },
  });

  await service.submitUploadedFile({
    actorId,
    sourceProjectName: "   ",
    name: "low voice",
    description: null,
    category: "音色",
    audioMetadata: {
      kind: "voice",
      voice_traits: [],
      speaking_style: null,
    },
    file: {
      fileName: "low voice.mp3",
      contentType: "audio/mpeg",
      content,
    },
  });

  assert.equal(sourceProjectCalls, 0);
  assert.equal(created?.sourceProjectId, null);
  assert.equal(created?.sourceProjectName, null);
});

test("audio content guard accepts only wav/mp3/ogg/opus", () => {
  assert.equal(assertAudioContent("a.wav", "application/octet-stream"), "wav");
  assert.equal(assertAudioContent("a.mp3", "application/octet-stream"), "mp3");
  assert.equal(assertAudioContent("a.ogg", "application/octet-stream"), "ogg");
  assert.equal(assertAudioContent("a.opus", "application/octet-stream"), "opus");
  assert.equal(assertAudioContent("a", "audio/opus"), "opus");
  assert.equal(assertAudioContent("a", "audio/ogg"), "ogg");
  assert.throws(() => assertAudioContent("a.flac", "audio/flac"), BadRequestError);
  assert.throws(() => assertAudioContent("a.m4a", "audio/mp4"), BadRequestError);
});

test("向量同步失败不回滚已创建的 PostgreSQL 资产", async () => {
  const originalError = console.error;
  let vectorCalls = 0;
  let created = false;
  console.error = () => undefined;
  const service = createService({
    repository: {
      createAudioAsset: async (input: CreateAudioAssetInput) => {
        created = true;
        return createdRecord(input);
      },
    },
    vectorSync: {
      syncEntity: async () => {
        vectorCalls += 1;
        throw new Error("vector down");
      },
    },
  });

  try {
    const result = await service.submitUploadedFile({
      actorId,
      name: "bgm",
      description: "反转前的压迫感铺底",
      category: "背景音乐",
      audioMetadata: {
        kind: "background_music",
        music_traits: ["压抑"],
        tempo: "慢",
        usage_scene: "反转",
      },
      file: {
        fileName: "bgm.ogg",
        contentType: "audio/ogg",
        content: Buffer.from("ogg"),
      },
    });

    assert.equal(created, true);
    assert.equal(vectorCalls, 1);
    assert.equal(result.assetId, assetId);
  } finally {
    console.error = originalError;
  }
});

test("非法音频格式在上传和落库前被拒绝", async () => {
  let uploaded = false;
  let created = false;
  const service = createService({
    storage: {
      uploadBytes: async () => {
        uploaded = true;
        throw new Error("not used");
      },
      headObject: async () => {
        throw new Error("not used");
      },
    },
    repository: {
      createAudioAsset: async (input: CreateAudioAssetInput) => {
        created = true;
        return createdRecord(input);
      },
    },
  });

  await assert.rejects(
    service.submitUploadedFile({
      actorId,
      name: "bad",
      category: "背景音乐",
      audioMetadata: {
        kind: "background_music",
        music_traits: [],
        tempo: null,
        usage_scene: null,
      },
      file: {
        fileName: "bad.flac",
        contentType: "audio/flac",
        content: Buffer.from("flac"),
      },
    }),
    BadRequestError,
  );
  assert.equal(uploaded, false);
  assert.equal(created, false);
});

function createService(overrides: Partial<AudioIngestTestDependencies> = {}): AudioIngestService {
  return new AudioIngestService({} as Database, {
    storage: overrides.storage ?? {
      uploadBytes: async (_content, storagePath, contentType) => ({
        bucket: "shortdrama-assets",
        storagePath,
        storageUrl: `https://tos.example/${storagePath}`,
      }),
      headObject: async (_storagePath, _bucket) => ({
        contentLength: 100,
        contentType: "audio/mpeg",
        etag: "etag",
        lastModified: null,
      }),
    },
    sourceProjects: overrides.sourceProjects ?? {
      getOrCreate: async (input: { name: string }) => ({
        id: "11111111-1111-4111-8111-111111111111",
        name: input.name,
        code: null,
        description: null,
        projectType: "audio_asset_ingest",
        metadata: {},
        createdAt: null,
        updatedAt: null,
      }),
    },
    repository: overrides.repository as never ?? {
      createAudioAsset: async (input: CreateAudioAssetInput) => createdRecord(input),
    } as never,
    vectorSync: overrides.vectorSync ?? {
      syncEntity: async () => undefined,
    },
    entityRepository: overrides.entityRepository ?? {
      toData: (row) => row as never,
    },
  });
}

interface AudioIngestTestDependencies {
  storage: {
    headObject: (storagePath: string, bucket?: string) => Promise<{
      contentLength: number;
      contentType: string | null;
      etag: string | null;
      lastModified: string | null;
    }>;
    uploadBytes: (content: Buffer, storagePath: string, contentType: string) => Promise<{
      bucket: string;
      storagePath: string;
      storageUrl: string;
    }>;
  };
  sourceProjects: {
    getOrCreate: (input: { name: string }) => Promise<{
      id: string;
      name: string | null;
      code: string | null;
      description: string | null;
      projectType: string | null;
      metadata: Record<string, unknown> | null;
      createdAt: Date | null;
      updatedAt: Date | null;
    }>;
  };
  repository: {
    createAudioAsset: (input: CreateAudioAssetInput) => Promise<CreatedAudioAssetRecord>;
  };
  vectorSync: {
    syncEntity: (entity: unknown) => Promise<void>;
  };
  entityRepository: {
    toData: (row: unknown) => never;
  };
}

function createdRecord(input: CreateAudioAssetInput): CreatedAudioAssetRecord {
  return {
    assetId,
    mediaId,
    storageBucket: input.audio.storageBucket,
    storagePath: input.audio.storagePath,
    storageUrl: input.audio.storageUrl,
    asset: {
      id: assetId,
      assetKind: "audio",
      category: input.category,
      name: input.name,
      intro: input.description,
      metadata: { audio_asset: input.audioMetadata },
    } as never,
  };
}
