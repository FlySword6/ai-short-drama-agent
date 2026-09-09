import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import sharp from "sharp";
import type { Database } from "../../db/client.js";
import type { AssetMediaRow } from "../../db/schema.js";
import { toHttpErrorResponse } from "../../http/errorResponse.js";
import type { StoredObject } from "../../integrations/tosStorage.js";
import { BadRequestError, ExternalServiceError, ForbiddenError } from "../../shared/errors.js";
import {
  ASSET_MEDIA_MAX_AUDIO_BYTES,
  ASSET_MEDIA_MAX_IMAGE_BYTES,
  ASSET_MEDIA_MAX_PIXELS,
  AssetMediaUploadService,
  buildAssetMediaStoragePath,
  inspectUploadedAudio,
  inspectUploadedImage,
  type AssetMediaUploadRepositoryPort,
  type AssetObjectStoragePort,
  type PersistUploadedAssetMediaInput,
} from "./mediaUpload.js";
import { ASSET_MEDIA_MAX_FILE_BYTES, registerAssetRoutes } from "./routes.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";
const dummyDb = {} as Database;

test("上传媒体版本使用真实内容摘要和安全路径，并保留主版本选择", async () => {
  const persisted: PersistUploadedAssetMediaInput[] = [];
  const uploaded: Array<{ content: Buffer; storagePath: string; contentType: string }> = [];
  const repository: AssetMediaUploadRepositoryPort = {
    assertManageable: async (actualActorId, actualAssetId) => {
      assert.equal(actualActorId, actorId);
      assert.equal(actualAssetId, assetId);
    },
    persistUploadedMedia: async (input) => {
      persisted.push(input);
      return mediaRow(input);
    },
  };
  const storage: AssetObjectStoragePort = {
    uploadBytes: async (content, storagePath, contentType) => {
      uploaded.push({ content, storagePath, contentType });
      return storedObject(storagePath);
    },
    deleteObject: async () => undefined,
  };
  const service = new AssetMediaUploadService(dummyDb, {
    repository,
    storage,
    inspectImage: async () => ({
      format: "png",
      extension: "png",
      contentType: "image/png",
      width: 24,
      height: 32,
    }),
    createMediaId: () => mediaId,
  });
  const content = Buffer.from("test-image-bytes");
  const sha256 = createHash("sha256").update(content).digest("hex");

  const item = await service.upload({
    actorId,
    assetId,
    fileName: "../../角色\r\n主图.png",
    declaredContentType: "application/octet-stream",
    content,
    title: "角色主图",
    isPrimary: true,
  });

  const expectedPath = `prod/asset/${assetId}/media/${mediaId}_${sha256.slice(0, 16)}.png`;
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0]?.storagePath, expectedPath);
  assert.equal(uploaded[0]?.contentType, "image/png", "使用检测出的类型，不信任声明类型");
  assert.equal(persisted[0]?.sha256, sha256);
  assert.equal(persisted[0]?.isPrimary, true);
  assert.equal(persisted[0]?.stored.storagePath, expectedPath);
  assert.equal(persisted[0]?.originalFileName.includes(".."), false);
  assert.equal(item.id, mediaId);
  assert.equal(item.isPrimary, true);
  assert.equal(item.widthPx, 24);
  assert.equal(item.heightPx, 32);
});

test("上传触发模型(2026-08-19):is_primary=true persist 成功后自动登记;非主图上传不触发", async () => {
  const persisted: PersistUploadedAssetMediaInput[] = [];
  const registerCalls: Array<{ actorId: string; assetId: string; mediaId: string }> = [];
  const repository: AssetMediaUploadRepositoryPort = {
    assertManageable: async () => undefined,
    persistUploadedMedia: async (input) => {
      persisted.push(input);
      return mediaRow(input);
    },
  };
  const makeService = () => new AssetMediaUploadService(dummyDb, {
    repository,
    storage: {
      uploadBytes: async () => storedObject(`prod/asset/${assetId}/media/${mediaId}_0123456789abcdef.png`),
      deleteObject: async () => undefined,
    },
    inspectImage: async () => ({ format: "png", extension: "png", contentType: "image/png", width: 1, height: 1 }),
    createMediaId: () => mediaId,
    registerPrimary: (input) => {
      registerCalls.push(input);
    },
  });

  const primary = await makeService().upload({
    actorId, assetId, fileName: "primary.png", content: Buffer.from("primary"), isPrimary: true,
  });
  assert.equal(primary.isPrimary, true);
  assert.equal(registerCalls.length, 1, "is_primary=true 上传 persist 后必须自动登记");
  assert.deepEqual(registerCalls[0], { actorId, assetId, mediaId });
  assert.equal(persisted[0]?.isPrimary, true, "登记发生在 persist 之后,登记输入用同一 mediaId");

  const normal = await makeService().upload({
    actorId, assetId, fileName: "normal.png", content: Buffer.from("normal"),
  });
  assert.equal(normal.isPrimary, false);
  assert.equal(registerCalls.length, 1, "非主图上传不得触发登记");
});

test("上传触发模型:persist 失败则不登记(回滚语义)", async () => {
  let registerCalls = 0;
  const service = new AssetMediaUploadService(dummyDb, {
    repository: {
      assertManageable: async () => undefined,
      persistUploadedMedia: async () => { throw new Error("db down"); },
    },
    storage: {
      uploadBytes: async () => storedObject(`prod/asset/${assetId}/media/${mediaId}_0123456789abcdef.png`),
      deleteObject: async () => undefined,
    },
    inspectImage: async () => ({ format: "png", extension: "png", contentType: "image/png", width: 1, height: 1 }),
    createMediaId: () => mediaId,
    registerPrimary: () => {
      registerCalls += 1;
    },
  });
  await assert.rejects(
    () => service.upload({ actorId, assetId, fileName: "primary.png", content: Buffer.from("x"), isPrimary: true }),
    /db down/,
  );
  assert.equal(registerCalls, 0, "persist 失败时对象已回滚清理,不得触发登记");
});

test("没有管理权限时不会写对象存储", async () => {
  let storageCalls = 0;
  const service = new AssetMediaUploadService(dummyDb, {
    repository: {
      assertManageable: async () => { throw new ForbiddenError("通用资产为只读"); },
      persistUploadedMedia: async () => { throw new Error("不应执行"); },
    },
    storage: {
      uploadBytes: async () => { storageCalls += 1; return storedObject("unused"); },
      deleteObject: async () => undefined,
    },
    inspectImage: async () => ({
      format: "png",
      extension: "png",
      contentType: "image/png",
      width: 1,
      height: 1,
    }),
  });

  await assert.rejects(service.upload({
    actorId,
    assetId,
    fileName: "image.png",
    content: Buffer.from("image"),
  }), (error: unknown) => error instanceof ForbiddenError);
  assert.equal(storageCalls, 0);
});

test("数据库保存失败时尽量删除刚上传对象，清理失败也不覆盖原错误", async () => {
  const deleted: string[] = [];
  const databaseError = new Error("database write failed");
  const storagePath = `prod/asset/${assetId}/media/${mediaId}_0123456789abcdef.png`;
  const service = new AssetMediaUploadService(dummyDb, {
    repository: {
      assertManageable: async () => undefined,
      persistUploadedMedia: async () => { throw databaseError; },
    },
    storage: {
      uploadBytes: async () => storedObject(storagePath),
      deleteObject: async (value) => {
        deleted.push(value);
        throw new Error("cleanup failed");
      },
    },
    inspectImage: async () => ({
      format: "png",
      extension: "png",
      contentType: "image/png",
      width: 1,
      height: 1,
    }),
    createMediaId: () => mediaId,
  });

  await assert.rejects(service.upload({
    actorId,
    assetId,
    fileName: "image.png",
    content: Buffer.from("image"),
  }), (error: unknown) => error === databaseError);
  assert.deepEqual(deleted, [storagePath]);
});

test("真实图片检测会解码像素并拒绝伪图片", async () => {
  const valid = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "#336699" },
  }).png().toBuffer();
  const info = await inspectUploadedImage(valid);
  assert.deepEqual(info, {
    format: "png",
    extension: "png",
    contentType: "image/png",
    width: 3,
    height: 2,
  });
  await assert.rejects(inspectUploadedImage(Buffer.from("not-a-real-image")), (error: unknown) => (
    error instanceof BadRequestError && error.statusCode === 400
  ));
});

test("真实图片检测明确拒绝超过 2500 万像素的图片", async () => {
  const oversized = await sharp({
    create: {
      width: 5_001,
      height: 5_000,
      channels: 3,
      background: "#000000",
    },
  }).png({ compressionLevel: 9 }).toBuffer();
  assert.equal(5_001 * 5_000 > ASSET_MEDIA_MAX_PIXELS, true);
  await assert.rejects(inspectUploadedImage(oversized), (error: unknown) => (
    error instanceof BadRequestError
      && error.statusCode === 400
      && /2500 万/.test(error.message)
  ));
});

test("图片文件按 multipart 全局限额之上的 10 兆分层上限拒绝", async () => {
  assert.equal(ASSET_MEDIA_MAX_IMAGE_BYTES < ASSET_MEDIA_MAX_FILE_BYTES, true);
  const oversized = Buffer.alloc(ASSET_MEDIA_MAX_IMAGE_BYTES + 1, 97);
  await assert.rejects(inspectUploadedImage(oversized), (error: unknown) => (
    error instanceof BadRequestError
      && error.statusCode === 400
      && /图片文件不能超过 10 兆/.test(error.message)
  ));
});

test("真实音频检测按文件头魔数识别白名单格式", async () => {
  const cases: Array<{ name: string; bytes: Buffer; expected: string }> = [
    { name: "mp3-id3", bytes: Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]), expected: "mp3" },
    { name: "wav", bytes: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]), expected: "wav" },
    { name: "flac", bytes: Buffer.from("fLaC\x00\x00\x00\x22"), expected: "flac" },
    { name: "ogg", bytes: Buffer.from("OggS\x00\x02"), expected: "ogg" },
    { name: "aac", bytes: Buffer.from([0xFF, 0xF1, 0x50, 0x80]), expected: "aac" },
  ];
  for (const item of cases) {
    const info = await inspectUploadedAudio(item.bytes);
    assert.equal(info.format, item.expected, item.name);
  }
  await assert.rejects(inspectUploadedAudio(Buffer.from("definitely not audio")), (error: unknown) => (
    error instanceof BadRequestError
      && error.statusCode === 400
      && /常见音频/.test(error.message)
  ));
});

test("音频文件超过 20 兆被 inspect 拒绝且不进入存储", async () => {
  const oversized = Buffer.alloc(ASSET_MEDIA_MAX_AUDIO_BYTES + 1, 0xFF);
  await assert.rejects(inspectUploadedAudio(oversized), (error: unknown) => (
    error instanceof BadRequestError
      && error.statusCode === 400
      && /音频文件不能超过 20 兆/.test(error.message)
  ));
});

test("mediaKind=audio 的上传走音频检测并保存音频媒体行", async () => {
  const persisted: PersistUploadedAssetMediaInput[] = [];
  const repository: AssetMediaUploadRepositoryPort = {
    assertManageable: async () => undefined,
    persistUploadedMedia: async (input) => {
      persisted.push(input);
      return mediaRow(input);
    },
  };
  const storage: AssetObjectStoragePort = {
    uploadBytes: async (content, storagePath, contentType) => {
      assert.equal(contentType, "audio/mpeg");
      return storedObject(storagePath);
    },
    deleteObject: async () => undefined,
  };
  const service = new AssetMediaUploadService(dummyDb, {
    repository,
    storage,
    inspectAudio: async (content) => {
      assert.equal(content.toString(), "fake-mp3");
      return { format: "mp3", extension: "mp3", contentType: "audio/mpeg" };
    },
    createMediaId: () => mediaId,
  });
  const item = await service.upload({
    actorId,
    assetId,
    fileName: "voice.mp3",
    content: Buffer.from("fake-mp3"),
    mediaKind: "audio",
  });
  assert.equal(item.mediaKind, "audio");
  assert.equal(persisted.length, 1);
  const input = persisted[0]!;
  assert.equal(input.media.kind, "audio");
  assert.equal(input.media.format, "mp3");
  const row = mediaRow(input);
  assert.equal(row.mediaKind, "audio");
  assert.equal(row.viewAngle, null);
  assert.equal(row.widthPx, null);
  assert.equal(row.heightPx, null);
});

test("对象路径只接受安全标识和扩展名", () => {
  const sha256 = "a".repeat(64);
  assert.equal(
    buildAssetMediaStoragePath(assetId, mediaId, sha256, "webp"),
    `prod/asset/${assetId}/media/${mediaId}_${sha256.slice(0, 16)}.webp`,
  );
  assert.throws(() => buildAssetMediaStoragePath(assetId, mediaId, sha256, "../png"), /extension/);
});

test("multipart 接口读取文件后的字段并返回新版本", async () => {
  const app = Fastify({ logger: false });
  let captured: Parameters<AssetMediaUploadService["upload"]>[0] | undefined;
  const calls: string[] = [];
  await app.register(multipart, { limits: { files: 1, fileSize: 1024 * 1024 } });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createMediaUploadService: () => ({
      assertManageable: async (actualActorId, actualAssetId) => {
        calls.push("permission");
        assert.equal(actualActorId, actorId);
        assert.equal(actualAssetId, assetId);
      },
      upload: async (input) => {
        calls.push("upload");
        captured = input;
        return { id: mediaId, isPrimary: input.isPrimary, title: input.title };
      },
    }),
  });

  try {
    const boundary = "asset-upload-test-boundary";
    const imageBytes = Buffer.from("fake-image-for-injected-service");
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="角色.png"\r\nContent-Type: image/png\r\n\r\n`),
      imageBytes,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="is_primary"\r\n\r\ntrue`),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n新主图`),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/media`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().data.is_primary, true);
    assert.equal(captured?.actorId, actorId);
    assert.equal(captured?.assetId, assetId);
    assert.equal(captured?.isPrimary, true);
    assert.equal(captured?.title, "新主图");
    assert.deepEqual(captured?.content, imageBytes);
    assert.deepEqual(calls, ["permission", "upload"]);
  } finally {
    await app.close();
  }
});

test("assets 错误信封快照：上传链不暴露存储服务原文", async () => {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { files: 1, fileSize: 1024 * 1024 } });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toHttpErrorResponse(error);
    return reply.code(statusCode).send({ ok: false, error: body });
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createMediaUploadService: () => ({
      assertManageable: async () => undefined,
      upload: async () => {
        throw new ExternalServiceError("TOS", "request failed with status 503");
      },
    }),
  });

  try {
    const boundary = "asset-copy-snapshot";
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/media`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="角色.png"\r\nContent-Type: image/png\r\n\r\n`),
        Buffer.from("fake-image"),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      ok: false,
      error: {
        code: "external_service_error",
        message: "素材没能保存：存储服务暂时没响应，请稍后重试。",
        retryable: true,
        details: null,
      },
    });
  } finally {
    await app.close();
  }
});

test("无权限时在读取 multipart 文件前返回 403", async () => {
  const app = Fastify({ logger: false });
  let uploadCalled = false;
  await app.register(multipart, {
    limits: { files: 1, fileSize: 20 * 1024 * 1024 },
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createMediaUploadService: () => ({
      assertManageable: async () => { throw new ForbiddenError("无权修改该资产"); },
      upload: async () => {
        uploadCalled = true;
        throw new Error("不应读取或上传文件");
      },
    }),
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/media`,
      headers: { "content-type": "multipart/form-data; boundary=malformed-large-file" },
      payload: Buffer.alloc(ASSET_MEDIA_MAX_FILE_BYTES + 1, 97),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(uploadCalled, false);
  } finally {
    await app.close();
  }
});

test("资产媒体接口用明确 413 拒绝超过 20 兆的文件", async () => {
  const app = Fastify({ logger: false });
  let uploadCalled = false;
  await app.register(multipart, {
    limits: { files: 1, fileSize: 20 * 1024 * 1024 },
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createMediaUploadService: () => ({
      assertManageable: async () => undefined,
      upload: async () => {
        uploadCalled = true;
        throw new Error("超限文件不应进入上传服务");
      },
    }),
  });

  try {
    const boundary = "asset-upload-size-limit";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.alloc(ASSET_MEDIA_MAX_FILE_BYTES + 1, 97),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/media`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(response.statusCode, 413);
    assert.match(response.json().message, /20 兆/);
    assert.equal(uploadCalled, false);
  } finally {
    await app.close();
  }
});

function storedObject(storagePath: string): StoredObject {
  return {
    bucket: "test-bucket",
    storagePath,
    storageUrl: `https://storage.example/${storagePath}`,
  };
}

function mediaRow(input: PersistUploadedAssetMediaInput): AssetMediaRow {
  return {
    id: input.mediaId,
    assetEntityId: input.assetId,
    assetVariantId: null,
    mediaKind: input.media.kind,
    viewAngle: input.media.kind === "image" ? "unknown" : null,
    title: input.title,
    description: input.description ?? null,
    storageBucket: input.stored.bucket,
    storagePath: input.stored.storagePath,
    storageUrl: input.stored.storageUrl,
    widthPx: input.media.kind === "image" ? input.media.width : null,
    heightPx: input.media.kind === "image" ? input.media.height : null,
    format: input.media.format,
    sha256: input.sha256,
    isPrimary: input.isPrimary,
    approved: true,
    sortOrder: 1,
    metadata: {},
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    deletedAt: null,
    deletedByUserId: null,
  };
}
