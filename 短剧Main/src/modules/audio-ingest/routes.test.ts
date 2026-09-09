import assert from "node:assert/strict";
import test from "node:test";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { registerAudioIngestRoutes } from "./routes.js";
import type { CreatedAudioAsset } from "./types.js";

const dummyDb = {} as Database;
const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "audio.user",
  displayName: "Audio User",
  role: "member",
};

const created: CreatedAudioAsset = {
  assetId: "22222222-2222-4222-8222-222222222222",
  mediaId: "33333333-3333-4333-8333-333333333333",
  storageBucket: "shortdrama-assets",
  storagePath: "asset-audio/fake.ogg",
  storageUrl: "https://tos.example/asset-audio/fake.ogg",
};

test("POST /asset-ingest/audio: 登记 TOS 音色音频并同步返回创建结果", async () => {
  let received: unknown;
  const app = await testApp({
    submit: async (input): Promise<CreatedAudioAsset> => {
      received = input;
      return created;
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-ingest/audio",
      payload: {
        source_project_name: "参考音频素材库",
        name: "低声旁白",
        description: "低沉克制",
        category: "音色",
        voice_traits: ["低沉", "克制"],
        speaking_style: "旁白",
        audio: {
          storage_bucket: "shortdrama-assets",
          storage_path: "asset-audio/voice.mp3",
          original_file_name: "voice.mp3",
          content_type: "audio/mpeg",
        },
      },
    });

    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(received, {
      actorId: actor.id,
      sourceProjectName: "参考音频素材库",
      name: "低声旁白",
      description: "低沉克制",
      category: "音色",
      audioMetadata: {
        kind: "voice",
        voice_traits: ["低沉", "克制"],
        speaking_style: "旁白",
      },
      audio: {
        storageBucket: "shortdrama-assets",
        storagePath: "asset-audio/voice.mp3",
        storageUrl: undefined,
        originalFileName: "voice.mp3",
        contentType: "audio/mpeg",
      },
    });
    assert.deepEqual(response.json().data, {
      asset_id: created.assetId,
      media_id: created.mediaId,
      storage_bucket: created.storageBucket,
      storage_path: created.storagePath,
      storage_url: created.storageUrl,
    });
    assert.equal("task_id" in response.json().data, false);
    assert.equal("status" in response.json().data, false);
  } finally {
    await app.close();
  }
});

test("POST /asset-ingest/audio/upload: 上传单个背景音乐并解析专属字段", async () => {
  let received: unknown;
  const content = Buffer.from("fake ogg bytes");
  const app = await testApp({
    submitUploadedFile: async (input): Promise<CreatedAudioAsset> => {
      received = input;
      return created;
    },
  });
  try {
    const boundary = "audio-upload-ok";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-ingest/audio/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [
        { name: "file", filename: "rain.ogg", contentType: "audio/ogg", content },
        { name: "source_project_name", content: "audio refs" },
        { name: "name", content: "rain bed" },
        { name: "description", content: "steady rain" },
        { name: "category", content: "背景音乐" },
        { name: "music_traits", content: "悬疑，压抑\n低频" },
        { name: "tempo", content: "慢" },
        { name: "usage_scene", content: "反转" },
      ]),
    });

    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(received, {
      actorId: actor.id,
      sourceProjectName: "audio refs",
      name: "rain bed",
      description: "steady rain",
      category: "背景音乐",
      audioMetadata: {
        kind: "background_music",
        music_traits: ["悬疑", "压抑", "低频"],
        tempo: "慢",
        usage_scene: "反转",
      },
      file: {
        fileName: "rain.ogg",
        contentType: "audio/ogg",
        content,
      },
    });
    assert.deepEqual(response.json().data, {
      asset_id: created.assetId,
      media_id: created.mediaId,
      storage_bucket: created.storageBucket,
      storage_path: created.storagePath,
      storage_url: created.storageUrl,
    });
  } finally {
    await app.close();
  }
});

test("POST /asset-ingest/audio rejects invalid category before service call", async () => {
  let called = false;
  const app = await testApp({
    submit: async () => {
      called = true;
      throw new Error("not expected");
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-ingest/audio",
      payload: {
        name: "bad",
        category: "人声",
        audio: {
          storage_path: "asset-audio/a.mp3",
          original_file_name: "a.mp3",
          content_type: "audio/mpeg",
        },
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("POST /asset-ingest/audio rejects cross-category metadata fields", async () => {
  let called = false;
  const app = await testApp({
    submit: async () => {
      called = true;
      throw new Error("not expected");
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-ingest/audio",
      payload: {
        name: "bad",
        category: "音色",
        music_traits: ["悬疑"],
        audio: {
          storage_path: "asset-audio/a.mp3",
          original_file_name: "a.mp3",
          content_type: "audio/mpeg",
        },
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("未登录访问音频入库端点返回 401", async () => {
  const app = Fastify({ logger: false });
  await registerAudioIngestRoutes(app, () => dummyDb);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-ingest/audio",
      payload: {
        name: "低声旁白",
        category: "音色",
        voice_traits: [],
        audio: {
          storage_path: "asset-audio/voice.mp3",
          original_file_name: "voice.mp3",
          content_type: "audio/mpeg",
        },
      },
    });
    assert.equal(response.statusCode, 401, response.body);
  } finally {
    await app.close();
  }
});

test("旧音频任务端点不再注册", async () => {
  const app = await testApp();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/audio-ingest-tasks?limit=5" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/audio-ingest-tasks/22222222-2222-4222-8222-222222222222" })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/audio-ingest-tasks/22222222-2222-4222-8222-222222222222/retry" })).statusCode, 404);
  } finally {
    await app.close();
  }
});

async function testApp(overrides: Partial<Pick<import("./service.js").AudioIngestService, "submit" | "submitUploadedFile">> = {}) {
  const app = Fastify({ logger: false });
  await app.register(multipart);
  app.addHook("preHandler", async (request) => {
    request.authUser = actor;
  });
  await registerAudioIngestRoutes(app, () => dummyDb, {
    createService: () => ({
      submit: async (): Promise<CreatedAudioAsset> => created,
      submitUploadedFile: async (): Promise<CreatedAudioAsset> => created,
      ...overrides,
    }),
  });
  return app;
}

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
