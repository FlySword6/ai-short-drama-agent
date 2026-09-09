import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { registerVideoIngestRoutes } from "./routes.js";
import type { SubmittedUploadedVideoIngest, SubmittedVideoIngest, VideoIngestTaskView } from "./types.js";

const dummyDb = {} as Database;
const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "video.user",
  displayName: "Video User",
  role: "member",
};

const taskView: VideoIngestTaskView = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "queued",
  assetEntityId: "33333333-3333-4333-8333-333333333333",
  assetMediaId: "44444444-4444-4444-8444-444444444444",
  operatorTaskId: null,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date("2026-08-17T00:00:00.000Z"),
  startedAt: null,
  completedAt: null,
};

test("POST /asset-ingest/videos: 登记 TOS 视频并 kick worker", async () => {
  let kicked = 0;
  let received: unknown;
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerVideoIngestRoutes(app, () => dummyDb, {
    worker: { kick: () => { kicked += 1; } },
    createService: () => ({
      submit: async (input): Promise<SubmittedVideoIngest> => {
        received = input;
        return {
          assetId: taskView.assetEntityId,
          mediaId: taskView.assetMediaId,
          taskId: taskView.id,
          status: "queued",
        };
      },
      submitUploadedFile: async (): Promise<SubmittedUploadedVideoIngest> => ({
        assetId: taskView.assetEntityId,
        mediaId: taskView.assetMediaId,
        taskId: taskView.id,
        status: "queued",
        storageBucket: "shortdrama-assets",
        storagePath: "asset-videos/rain-run.mp4",
        storageUrl: "https://tos.example/asset-videos/rain-run.mp4",
      }),
      get: async () => taskView,
      listRecent: async () => [taskView],
      retry: async () => taskView,
    }),
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-ingest/videos",
      payload: {
        source_project_name: "参考视频素材库",
        name: "雨夜追逐动作参考",
        description: "手持跟拍",
        video: {
          storage_bucket: "shortdrama-assets",
          storage_path: "asset-videos/rain-run.mp4",
          original_file_name: "rain-run.mp4",
          content_type: "video/mp4",
        },
      },
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.equal(kicked, 1);
    assert.deepEqual(received, {
      actorId: actor.id,
      sourceProjectName: "参考视频素材库",
      name: "雨夜追逐动作参考",
      description: "手持跟拍",
      video: {
        storageBucket: "shortdrama-assets",
        storagePath: "asset-videos/rain-run.mp4",
        storageUrl: undefined,
        originalFileName: "rain-run.mp4",
        contentType: "video/mp4",
      },
      cover: null,
    });
    assert.deepEqual(response.json().data, {
      asset_id: taskView.assetEntityId,
      media_id: taskView.assetMediaId,
      task_id: taskView.id,
      status: "queued",
    });
  } finally {
    await app.close();
  }
});

test("POST /asset-ingest/videos/upload: upload local video then queue parsing task", async () => {
  let kicked = 0;
  let received: unknown;
  const content = Buffer.from("fake mp4 bytes");
  const app = Fastify({ logger: false });
  await app.register(multipart);
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerVideoIngestRoutes(app, () => dummyDb, {
    worker: { kick: () => { kicked += 1; } },
    createService: () => ({
      submit: async (): Promise<SubmittedVideoIngest> => ({
        assetId: taskView.assetEntityId,
        mediaId: taskView.assetMediaId,
        taskId: taskView.id,
        status: "queued",
      }),
      submitUploadedFile: async (input): Promise<SubmittedUploadedVideoIngest> => {
        received = input;
        return {
          assetId: taskView.assetEntityId,
          mediaId: taskView.assetMediaId,
          taskId: taskView.id,
          status: "queued",
          storageBucket: "shortdrama-assets",
          storagePath: "asset-videos/fake.mp4",
          storageUrl: "https://tos.example/asset-videos/fake.mp4",
        };
      },
      get: async () => taskView,
      listRecent: async () => [taskView],
      retry: async () => taskView,
    }),
  });
  try {
    const boundary = "video-upload-ok";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-ingest/videos/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [
        { name: "file", filename: "rain-run.mp4", contentType: "video/mp4", content },
        { name: "source_project_name", content: "video refs" },
        { name: "name", content: "rain chase" },
        { name: "description", content: "handheld tracking shot" },
      ]),
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.equal(kicked, 1);
    assert.deepEqual(received, {
      actorId: actor.id,
      sourceProjectName: "video refs",
      name: "rain chase",
      description: "handheld tracking shot",
      file: {
        fileName: "rain-run.mp4",
        contentType: "video/mp4",
        content,
      },
    });
    assert.deepEqual(response.json().data, {
      asset_id: taskView.assetEntityId,
      media_id: taskView.assetMediaId,
      task_id: taskView.id,
      status: "queued",
      storage_bucket: "shortdrama-assets",
      storage_path: "asset-videos/fake.mp4",
      storage_url: "https://tos.example/asset-videos/fake.mp4",
    });
  } finally {
    await app.close();
  }
});

function multipartPayload(boundary: string, parts: Array<{
  name: string;
  filename?: string;
  contentType?: string;
  content: Buffer | string;
}>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}`));
    chunks.push(typeof part.content === "string" ? Buffer.from(part.content) : part.content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test("POST /video-ingest-tasks/:id/retry: 重试失败任务并 kick worker", async () => {
  let kicked = 0;
  let retried: string | undefined;
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerVideoIngestRoutes(app, () => dummyDb, {
    worker: { kick: () => { kicked += 1; } },
    createService: () => ({
      submit: async () => ({ assetId: "a", mediaId: "m", taskId: "t", status: "queued" }),
      submitUploadedFile: async () => ({
        assetId: "a",
        mediaId: "m",
        taskId: "t",
        status: "queued",
        storageBucket: "b",
        storagePath: "p",
        storageUrl: null,
      }),
      get: async () => taskView,
      listRecent: async () => [taskView],
      retry: async (actorId, taskId) => {
        retried = `${actorId}:${taskId}`;
        return { ...taskView, status: "queued" };
      },
    }),
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/video-ingest-tasks/${taskView.id}/retry`,
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.equal(kicked, 1);
    assert.equal(retried, `${actor.id}:${taskView.id}`);
    assert.equal(response.json().data.task.status, "queued");
  } finally {
    await app.close();
  }
});
