import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import type { Database } from "../../../db/client.js";
import type { StoredObject } from "../../../integrations/tosStorage.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { DirectorProjectAccessPort } from "../projectAccess.js";
import {
  buildDirectorCaptureStoragePath,
  DIRECTOR_CAPTURE_MAX_DIMENSION_PX,
  DIRECTOR_CAPTURE_MAX_FILE_BYTES,
  DirectorCaptureService,
  inspectDirectorCapturePng,
  type DirectorCaptureRepositoryPort,
  type DirectorCaptureStoragePort,
} from "./service.js";
import type { PersistDirectorCaptureInput } from "./repository.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assetEntityId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const assetMediaId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const dummyDb = {} as Database;

const fixedIds = () => ({ assetEntityId, assetMediaId });

function okRepository(overrides: Partial<DirectorCaptureRepositoryPort> = {}): DirectorCaptureRepositoryPort {
  return {
    assertPlacement: async () => undefined,
    persistCapture: async (input) => ({
      assetEntityId: input.assetEntityId,
      assetMediaId: input.assetMediaId,
      projectAssetRefId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }),
    ...overrides,
  };
}

function allowProjectAccess(overrides: Partial<DirectorProjectAccessPort> = {}): DirectorProjectAccessPort {
  return {
    require: async (actor, requestedProjectId) => ({
      projectId: requestedProjectId,
      actorId: actor.id,
      platformRole: actor.role ?? "member",
      membershipRole: "owner",
      isPlatformObserver: false,
    }),
    ...overrides,
  };
}

function storedObject(storagePath: string): StoredObject {
  return { bucket: "test-bucket", storagePath, storageUrl: `https://storage.example/${storagePath}` };
}

function recordingStorage(failDelete = false) {
  const uploaded: Array<{ content: Buffer; storagePath: string; contentType: string }> = [];
  const deleted: string[] = [];
  const storage: DirectorCaptureStoragePort = {
    uploadBytes: async (content, storagePath, contentType) => {
      uploaded.push({ content, storagePath, contentType });
      return storedObject(storagePath);
    },
    deleteObject: async (storagePath) => {
      deleted.push(storagePath);
      if (failDelete) throw new Error("cleanup failed");
    },
  };
  return { storage, uploaded, deleted };
}

async function pngBuffer(width = 4, height = 3): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();
}

test("成功上传：PNG 实解码、sha256 路径、TOS 后写库且个人截图免审", async () => {
  const content = await pngBuffer();
  const persisted: Array<PersistDirectorCaptureInput> = [];
  const accessActions: string[] = [];
  const { storage, uploaded, deleted } = recordingStorage();
  const service = new DirectorCaptureService(dummyDb, {
    repository: okRepository({
      persistCapture: async (input) => {
        persisted.push(input);
        return {
          assetEntityId: input.assetEntityId,
          assetMediaId: input.assetMediaId,
          projectAssetRefId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        };
      },
    }),
    storage,
    projectAccess: allowProjectAccess({
      require: async (actor, requestedProjectId, action) => {
        accessActions.push(action);
        return {
          projectId: requestedProjectId,
          actorId: actor.id,
          platformRole: "member",
          membershipRole: "editor",
          isPlatformObserver: false,
        };
      },
    }),
    createIds: fixedIds,
  });

  const result = await service.upload({
    actor: actorId,
    projectId,
    fileName: "../../截图\r\n主机位.png",
    declaredContentType: "image/png",
    content,
    placement: { episodeId: "12121212-1212-4212-8212-121212121212" },
    title: "主机位截图",
  });

  const sha256 = createHash("sha256").update(content).digest("hex");
  const expectedPath = `prod/director/${projectId}/captures/${assetMediaId}_${sha256.slice(0, 16)}.png`;
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0]?.storagePath, expectedPath);
  assert.equal(uploaded[0]?.contentType, "image/png", "写 TOS 用实解码类型，不信任声明");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.sha256, sha256);
  assert.equal(persisted[0]?.originalFileName.includes(".."), false);
  assert.deepEqual(persisted[0]?.placement, { episodeId: "12121212-1212-4212-8212-121212121212" });
  assert.equal(result.status, "approved");
  assert.equal(result.approved, true);
  assert.equal(result.widthPx, 4);
  assert.equal(result.heightPx, 3);
  assert.deepEqual(accessActions, ["create"], "截图入库必须走统一项目创作权限");
  assert.equal(deleted.length, 0, "成功路径不触发补偿删除");
});

test("声明 MIME 非 PNG 直接 400，不碰存储与数据库", async () => {
  const { storage, uploaded } = recordingStorage();
  let persistCalls = 0;
  const service = new DirectorCaptureService(dummyDb, {
    repository: okRepository({ persistCapture: async () => { persistCalls += 1; throw new Error("不应执行"); } }),
    storage,
  });
  await assert.rejects(
    service.upload({
      actor: actorId, projectId, fileName: "x.png", declaredContentType: "image/jpeg", content: Buffer.from("x"),
    }),
    (error: unknown) => error instanceof BadRequestError && /文件格式不支持/.test(error.message),
  );
  assert.equal(uploaded.length, 0);
  assert.equal(persistCalls, 0);
});

test("内容不是 PNG（实解码识别）返回 400，不碰存储", async () => {
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000000" } }).jpeg().toBuffer();
  const { storage, uploaded } = recordingStorage();
  const service = new DirectorCaptureService(dummyDb, { repository: okRepository(), storage, projectAccess: allowProjectAccess() });
  await assert.rejects(
    service.upload({ actor: actorId, projectId, fileName: "x.png", declaredContentType: "image/png", content: jpeg }),
    (error: unknown) => error instanceof BadRequestError && /文件格式不支持/.test(error.message),
  );
  assert.equal(uploaded.length, 0);
});

test("超过 10 兆与超过 4096 像素边长都拒绝", async () => {
  const service = new DirectorCaptureService(dummyDb, {
    repository: okRepository(),
    storage: recordingStorage().storage,
    projectAccess: allowProjectAccess(),
  });
  const oversized = Buffer.alloc(DIRECTOR_CAPTURE_MAX_FILE_BYTES + 1, 97);
  await assert.rejects(
    service.upload({ actor: actorId, projectId, fileName: "big.png", declaredContentType: "image/png", content: oversized }),
    (error: unknown) => error instanceof BadRequestError && /10 兆/.test(error.message),
  );

  const wide = await pngBuffer(DIRECTOR_CAPTURE_MAX_DIMENSION_PX + 1, 1);
  await assert.rejects(
    service.upload({ actor: actorId, projectId, fileName: "wide.png", declaredContentType: "image/png", content: wide }),
    (error: unknown) => error instanceof BadRequestError && /4096/.test(error.message),
  );
});

test("归属校验失败（他人项目/错位归置）不写 TOS", async () => {
  const { storage, uploaded } = recordingStorage();
  const forbidden = new DirectorCaptureService(dummyDb, {
    repository: okRepository(),
    projectAccess: allowProjectAccess({ require: async () => { throw new ForbiddenError(); } }),
    storage,
  });
  await assert.rejects(
    forbidden.upload({ actor: actorId, projectId, fileName: "x.png", declaredContentType: "image/png", content: await pngBuffer() }),
    (error: unknown) => error instanceof ForbiddenError,
  );

  const misplaced = new DirectorCaptureService(dummyDb, {
    repository: okRepository({
      assertPlacement: async () => { throw new NotFoundError("镜头不存在或不属于该项目"); },
    }),
    projectAccess: allowProjectAccess(),
    storage,
  });
  await assert.rejects(
    misplaced.upload({
      actor: actorId, projectId, fileName: "x.png", declaredContentType: "image/png",
      content: await pngBuffer(), placement: { shotId: "12121212-1212-4212-8212-121212121212" },
    }),
    (error: unknown) => error instanceof NotFoundError,
  );
  assert.equal(uploaded.length, 0, "任何归属失败都不应写对象存储");
});

test("DB 事务失败必须删除刚上传的 TOS 对象；清理失败不掩盖原始错误", async () => {
  const databaseError = new Error("database write failed");
  const { storage, uploaded, deleted } = recordingStorage(true);
  const service = new DirectorCaptureService(dummyDb, {
    repository: okRepository({
      persistCapture: async () => { throw databaseError; },
    }),
    storage,
    projectAccess: allowProjectAccess(),
    createIds: fixedIds,
  });
  await assert.rejects(
    service.upload({ actor: actorId, projectId, fileName: "x.png", declaredContentType: "image/png", content: await pngBuffer() }),
    (error: unknown) => error === databaseError,
  );
  assert.equal(uploaded.length, 1);
  assert.deepEqual(deleted, [uploaded[0]?.storagePath], "补偿删除必须针对刚上传的对象");
});

test("inspectDirectorCapturePng 拒绝伪 PNG，接受真实 PNG", async () => {
  const info = await inspectDirectorCapturePng(await pngBuffer(6, 5));
  assert.deepEqual(info, { format: "png", contentType: "image/png", width: 6, height: 5 });
  await assert.rejects(
    inspectDirectorCapturePng(Buffer.from("not-a-png")),
    (error: unknown) => error instanceof BadRequestError,
  );
});

test("存储路径只接受安全标识", () => {
  const sha256 = "a".repeat(64);
  assert.equal(
    buildDirectorCaptureStoragePath(projectId, assetMediaId, sha256),
    `prod/director/${projectId}/captures/${assetMediaId}_${sha256.slice(0, 16)}.png`,
  );
  assert.throws(() => buildDirectorCaptureStoragePath("not-a-uuid", assetMediaId, sha256), /projectId/);
});
