import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { VideoIngestService } from "./service.js";
import type { CreateVideoIngestSubmissionInput } from "./repository.js";
import { buildVideoEntityVectorText } from "./normalizer.js";

test("submitUploadedFile uploads local video to TOS before queueing LAS parsing", async () => {
  const content = Buffer.from("fake video content");
  const expectedHash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  let uploaded: { storagePath: string; contentType: string; content: Buffer } | undefined;
  let created: CreateVideoIngestSubmissionInput | undefined;

  const service = new VideoIngestService({} as Database, {
    storage: {
      uploadBytes: async (actualContent, storagePath, contentType) => {
        uploaded = { content: actualContent, storagePath, contentType };
        return {
          bucket: "shortdrama-assets",
          storagePath,
          storageUrl: `https://tos.example/${storagePath}`,
        };
      },
      headObject: async (storagePath, bucket) => {
        assert.equal(bucket, "shortdrama-assets");
        assert.equal(storagePath, uploaded?.storagePath);
        return {
          contentLength: content.length,
          contentType: "video/mp4",
          etag: "etag",
          lastModified: null,
        };
      },
      createDownloadUrl: async () => {
        throw new Error("not used");
      },
    },
    sourceProjects: {
      getOrCreate: async (input: { name: string }) => ({
        id: "11111111-1111-4111-8111-111111111111",
        name: input.name,
      }) as never,
    },
    repository: {
      createSubmission: async (input: CreateVideoIngestSubmissionInput) => {
        created = input;
        return {
          assetId: "22222222-2222-4222-8222-222222222222",
          mediaId: "33333333-3333-4333-8333-333333333333",
          taskId: "44444444-4444-4444-8444-444444444444",
        };
      },
    } as never,
  });

  const result = await service.submitUploadedFile({
    actorId: "55555555-5555-4555-8555-555555555555",
    sourceProjectName: "video refs",
    name: "rain chase",
    description: "handheld tracking",
    file: {
      fileName: "rain run.mp4",
      contentType: "video/mp4",
      content,
    },
  });

  assert.equal(uploaded?.content, content);
  assert.equal(uploaded?.contentType, "video/mp4");
  assert.equal(uploaded?.storagePath, `asset-videos/${expectedHash}_rain_run.mp4`);
  assert.equal(result.storageBucket, "shortdrama-assets");
  assert.equal(result.storagePath, uploaded?.storagePath);
  assert.equal(result.taskId, "44444444-4444-4444-8444-444444444444");
  assert.equal(created?.sourceProjectId, "11111111-1111-4111-8111-111111111111");
  assert.equal(created?.sourceProjectName, "video refs");
  assert.equal(created?.video.storageBucket, "shortdrama-assets");
  assert.equal(created?.video.storagePath, uploaded?.storagePath);
  assert.equal(created?.video.originalFileName, "rain run.mp4");
  assert.equal(created?.video.contentLength, content.length);
});

test("submitUploadedFile keeps blank video source empty", async () => {
  const content = Buffer.from("fake video content");
  let sourceProjectCalls = 0;
  let created: CreateVideoIngestSubmissionInput | undefined;

  const service = new VideoIngestService({} as Database, {
    storage: {
      uploadBytes: async (_actualContent, storagePath) => ({
        bucket: "shortdrama-assets",
        storagePath,
        storageUrl: `https://tos.example/${storagePath}`,
      }),
      headObject: async () => ({
        contentLength: content.length,
        contentType: "video/mp4",
        etag: "etag",
        lastModified: null,
      }),
      createDownloadUrl: async () => {
        throw new Error("not used");
      },
    },
    sourceProjects: {
      getOrCreate: async () => {
        sourceProjectCalls += 1;
        throw new Error("not used");
      },
    },
    repository: {
      createSubmission: async (input: CreateVideoIngestSubmissionInput) => {
        created = input;
        return {
          assetId: "22222222-2222-4222-8222-222222222222",
          mediaId: "33333333-3333-4333-8333-333333333333",
          taskId: "44444444-4444-4444-8444-444444444444",
        };
      },
    } as never,
  });

  await service.submitUploadedFile({
    actorId: "55555555-5555-4555-8555-555555555555",
    sourceProjectName: "   ",
    name: "rain chase",
    description: null,
    file: {
      fileName: "rain run.mp4",
      contentType: "video/mp4",
      content,
    },
  });

  assert.equal(sourceProjectCalls, 0);
  assert.equal(created?.sourceProjectId, null);
  assert.equal(created?.sourceProjectName, null);
});

test("processNextQueued syncs video vector from asset name and media vector text only", async () => {
  const raw = {
    data: {
      result: JSON.stringify({
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
      }),
    },
  };
  const updatedAsset = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "rain chase reference",
    appearance: "场景：wet neon street\n动作：running",
    outfitDescription: "视觉风格：high contrast",
    styleTags: ["rain", "chase"],
    assetKind: "video",
  };
  let markedVectorText = "";
  let syncedText = "";

  const service = new VideoIngestService({} as Database, {
    repository: {
      claimNextQueued: async () => ({
        id: "44444444-4444-4444-8444-444444444444",
        attemptCount: 1,
        sourceVideoBucket: "shortdrama-assets",
        sourceVideoPath: "asset-videos/rain-run.mp4",
        taskTemplate: "dense_video_captioning",
      }),
      recordOperatorTask: async () => undefined,
      markSucceeded: async (input: { vectorText: string }) => {
        markedVectorText = input.vectorText;
        return updatedAsset;
      },
      markFailed: async (_taskId: string, _errorCode: string, message: string) => {
        throw new Error(message);
      },
    } as never,
    storage: {
      createDownloadUrl: async () => ({ url: "https://tos.example/rain-run.mp4", expiresAt: new Date() }),
      headObject: async () => {
        throw new Error("not used");
      },
      uploadBytes: async () => {
        throw new Error("not used");
      },
    },
    las: {
      submit: async () => ({ taskId: "operator-task-1", raw: { accepted: true } }),
      poll: async () => ({ status: "completed", raw }),
    },
    entityRepository: {
      toData: (row: unknown) => row,
      getById: async () => null,
    } as never,
    vectorSync: {
      syncEntityWithText: async (_entity: unknown, text: string) => {
        syncedText = text;
      },
    },
    pollIntervalMs: 0,
    maxPolls: 1,
  });

  const processed = await service.processNextQueued();

  assert.equal(processed, true);
  assert.equal(syncedText, buildVideoEntityVectorText(updatedAsset.name, markedVectorText));
  assert.match(syncedText, /^rain chase reference\n素材类型：参考视频\n摘要：Rain night chase/);
  assert.doesNotMatch(syncedText, /外观：|服装：|\n风格：/);
});
