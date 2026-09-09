import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { Database } from "../../db/client.js";
import type { AssetUploadTaskRow } from "../../db/schema.js";
import type {
  SeedanceAssetRegistrationPort,
  SeedanceAssetRegistrationView,
} from "../seedance-assets/types.js";
import { cleanupUpload, saveUpload } from "../../shared/files.js";
import { AppError, ExternalServiceError, NotFoundError } from "../../shared/errors.js";
import { AssetUploadTaskService } from "./service.js";
import type { AssetUploadTaskRepository } from "./repository.js";
import {
  registrationFormSnapshot,
  type AssetRegistrationForm,
} from "./registrationSchema.js";
import {
  assetUploadNotificationData,
  assetUploadTaskData,
  registerAssetUploadRoutes,
} from "./routes.js";
import type { AssetUploadNotificationView, AssetUploadTaskView } from "./types.js";

const dummyDb = {} as Database;
const actorId = "user-s42";
const taskId = "44444444-4444-4444-8444-444444444444";
const assetEntityId = "55555555-5555-4555-8555-555555555555";
const assetMediaId = "66666666-6666-4666-8666-666666666666";
const registrationId = "77777777-7777-4777-8777-777777777777";

function taskRow(patch: Partial<AssetUploadTaskRow> = {}): AssetUploadTaskRow {
  return {
    id: taskId,
    userId: actorId,
    clientIdempotencyKey: null,
    status: "queued",
    originalFileName: "角色.png",
    contentType: "image/png",
    assetKindHint: null,
    contentSha256: null,
    requestSha256: null,
    registrationForm: null,
    stagedPath: "/nonexistent/s42/staged.png",
    stagedBytes: 128,
    resultAssetEntityId: null,
    resultAssetMediaId: null,
    resultRegistrationId: null,
    resultRegistrationStatus: null,
    registrationErrorCode: null,
    registrationErrorMessage: null,
    resultAssetName: null,
    errorCode: null,
    errorMessage: null,
    durationSeconds: null,
    acknowledgedAt: null,
    createdAt: new Date("2026-07-27T01:00:00.000Z"),
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

function activeView(patch: Partial<AssetUploadTaskView> = {}): AssetUploadTaskView {
  return {
    id: taskId,
    status: "queued",
    originalFileName: "角色.png",
    assetKindHint: "character",
    assetKind: "character",
    factorType: null,
    queuePosition: 1,
    estimatedDurationSeconds: 12,
    estimatedDurationSampleCount: 6,
    result: null,
    error: null,
    createdAt: new Date("2026-07-27T01:00:00.000Z"),
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

function notificationView(patch: Partial<AssetUploadNotificationView> = {}): AssetUploadNotificationView {
  return {
    id: taskId,
    status: "succeeded",
    originalFileName: "角色.png",
    resultAssetEntityId: assetEntityId,
    resultAssetMediaId: null,
    resultAssetName: "白衣女主",
    seedanceRegistration: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-07-27T01:00:00.000Z"),
    finishedAt: new Date("2026-07-27T01:00:12.000Z"),
    ...patch,
  };
}

function fakeRepository(overrides: Partial<AssetUploadTaskRepository> = {}): AssetUploadTaskRepository {
  return {
    create: async () => taskRow(),
    createOrReuse: async (input) => ({ task: await (overrides.create ?? (async () => taskRow()))(input), created: true }),
    getByUser: async () => null,
    listActiveByUser: async () => [],
    listUnacknowledgedTerminal: async () => [],
    acknowledge: async () => {},
    claimNextQueued: async () => null,
    markSucceeded: async () => {},
    recordLocalResult: async () => {},
    markFailed: async () => {},
    requeueInterrupted: async () => 0,
    queuePositionFor: async () => 1,
    estimatedDuration: async () => ({ seconds: 12, sampleCount: 6 }),
    ...overrides,
  };
}

function registrationForm(): AssetRegistrationForm {
  return {
    schemaVersion: "asset-registration-v1",
    dictionaryVersion: "asset-factor-v0.2",
    name: "灰发老人",
    description: "正面中性肖像",
    assetKind: "character",
    factorType: "face_identity",
    tags: ["正面肖像"],
    factorAttributes: { view_type: "front" },
    rightsDeclaration: {
      sourceKind: "self_created",
      containsRealPerson: false,
      referenceUseConfirmed: true,
    },
  };
}

function seedanceView(patch: Partial<SeedanceAssetRegistrationView> = {}): SeedanceAssetRegistrationView {
  return {
    id: registrationId,
    assetMediaId,
    sourceMediaResultId: null,
    assetGroupId: "asset-group-test",
    remoteAssetId: "remote-asset-1",
    status: "processing",
    createdAt: new Date("2026-08-02T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:01.000Z"),
    activatedAt: null,
    authorizationExpiresAt: null,
    lastVerifiedAt: null,
    latestRequestId: "req-create-test",
    latestErrorCode: null,
    latestErrorMessage: null,
    retryCount: 0,
    lastRetryAt: null,
    ...patch,
  };
}

function fakeSeedance(overrides: Partial<SeedanceAssetRegistrationPort> = {}): SeedanceAssetRegistrationPort {
  const unavailable = async () => { throw new Error("unused seedance method"); };
  return {
    registerMediaResult: unavailable,
    registerAssetMedia: async () => seedanceView(),
    refreshMediaResult: unavailable,
    refreshAssetMedia: unavailable,
    getMediaResult: unavailable,
    getAssetMedia: async () => { throw new NotFoundError(); },
    getRegistration: unavailable,
    refreshRegistration: unavailable,
    ...overrides,
  };
}

function multipartBody(boundary: string, fileName: string, contentType: string, extraFields: Record<string, string> = {}) {
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.from("fake-image-bytes"),
  ];
  for (const [name, value] of Object.entries(extraFields)) {
    parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`));
  }
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

test("提交图片上传返回 202 与排队事实,并唤醒队列 worker", async () => {
  const app = Fastify({ logger: false });
  let captured: Parameters<AssetUploadTaskService["submitImage"]>[1] | undefined;
  let capturedActor = "";
  let kicks = 0;
  await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetUploadRoutes(app, () => dummyDb, {
    createService: () => ({
      submitImage: async (actualActorId, input) => {
        capturedActor = actualActorId;
        captured = input;
        return activeView();
      },
      listActive: async () => [],
      get: async () => activeView(),
      listNotifications: async () => [],
      acknowledge: async () => {},
    }),
    worker: { kick: () => { kicks += 1; } },
  });

  try {
    const boundary = "s42-submit-boundary";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-upload-tasks",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "角色.png", "image/png", { asset_kind_hint: "character" }),
    });
    assert.equal(response.statusCode, 202);
    const payload = response.json() as { ok: boolean; data: Record<string, unknown> };
    assert.equal(payload.ok, true);
    assert.equal(payload.data.id, taskId);
    assert.equal(payload.data.status, "queued");
    assert.equal(payload.data.queue_position, 1);
    assert.equal(payload.data.estimated_duration_seconds, 12);
    assert.equal(payload.data.estimated_duration_sample_count, 6);
    assert.equal(capturedActor, actorId);
    assert.equal(captured?.fileName, "角色.png");
    assert.equal(captured?.declaredContentType, "image/png");
    assert.equal(captured?.assetKindHint, "character");
    assert.equal(captured?.content.toString(), "fake-image-bytes");
    assert.equal(kicks, 1);
  } finally {
    await app.close();
  }
});

test("登记上传把版本化表单与幂等键交给既有任务服务", async () => {
  const app = Fastify({ logger: false });
  let captured: Parameters<AssetUploadTaskService["submitImage"]>[1] | undefined;
  await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetUploadRoutes(app, () => dummyDb, {
    createService: () => ({
      submitImage: async (_actualActorId, input) => {
        captured = input;
        return activeView({ factorType: "face_identity" });
      },
      listActive: async () => [],
      get: async () => activeView(),
      listNotifications: async () => [],
      acknowledge: async () => {},
    }),
  });

  try {
    const boundary = "asset-registration-submit-boundary";
    const registration = {
      schema_version: "asset-registration-v1",
      dictionary_version: "asset-factor-v0.2",
      name: "灰发老人",
      asset_kind: "character",
      factor_type: "face_identity",
      tags: [],
      factor_attributes: { view_type: "front" },
      rights_declaration: {
        source_kind: "self_created",
        contains_real_person: false,
        reference_use_confirmed: true,
      },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-upload-tasks",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "portrait.png", "image/png", {
        client_idempotency_key: "88888888-8888-4888-8888-888888888888",
        registration: JSON.stringify(registration),
      }),
    });
    assert.equal(response.statusCode, 202);
    assert.equal(captured?.clientIdempotencyKey, "88888888-8888-4888-8888-888888888888");
    assert.deepEqual(captured?.registration, registration);
  } finally {
    await app.close();
  }
});

test("登记 schema 与单任务详情都使用冻结信封和 snake_case", async () => {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetUploadRoutes(app, () => dummyDb, {
    createSchemaService: () => ({
      getSchema: async () => ({
        schemaVersion: "asset-registration-v1",
        dictionaryVersion: "asset-factor-v0.2",
        acceptedMediaKinds: ["image"] as const,
        assetKinds: [{
          id: "character",
          displayName: "角色",
          factorTypes: [{ id: "face_identity", displayName: "面部身份" }],
        }],
        fields: [{
          id: "name",
          displayName: "资产名称",
          valueType: "text" as const,
          required: true,
          maxLength: 128,
          inputSource: "user" as const,
        }],
        systemManagedFields: ["confidence_score"],
        defaults: {
          visibility: "personal" as const,
          status: "approved" as const,
          clearance: {
            search: true,
            genReference: true,
            commercialPublish: false,
            modelTraining: false,
          },
        },
      }),
    }),
    createService: () => ({
      submitImage: async () => activeView(),
      listActive: async () => [],
      get: async (actualActorId, actualTaskId) => {
        assert.equal(actualActorId, actorId);
        assert.equal(actualTaskId, taskId);
        return activeView({
          status: "succeeded",
          queuePosition: null,
          estimatedDurationSeconds: null,
          factorType: "face_identity",
          result: {
            asset: { id: assetEntityId, mediaId: assetMediaId, scope: "personal", status: "approved" },
            seedanceRegistration: {
              id: registrationId,
              status: "processing",
              remoteAssetId: "remote-asset-1",
              lastVerifiedAt: null,
              freshUntil: null,
              canUseAsSeedanceReference: false,
              nextAction: "refresh",
              errorCode: null,
              errorMessage: null,
            },
          },
        });
      },
      listNotifications: async () => [],
      acknowledge: async () => {},
    }),
  });

  try {
    const schema = await app.inject({
      method: "GET",
      url: "/api/v1/assets/registration-schema?asset_kind=character&factor_type=face_identity",
    });
    assert.equal(schema.statusCode, 200);
    assert.equal(schema.json().data.schema_version, "asset-registration-v1");
    assert.equal(schema.json().data.fields[0].input_source, "user");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/asset-upload-tasks/${taskId}`,
    });
    assert.equal(detail.statusCode, 200);
    const data = detail.json().data;
    assert.equal(data.asset_kind, "character");
    assert.equal(data.factor_type, "face_identity");
    assert.equal(data.result.asset.media_id, assetMediaId);
    assert.equal(data.result.seedance_registration.next_action, "refresh");
  } finally {
    await app.close();
  }
});

test("非图片文件被 400 拒绝且不会落盘排队", async () => {
  const app = Fastify({ logger: false });
  let creates = 0;
  await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  const repository = fakeRepository({
    create: async () => {
      creates += 1;
      return taskRow();
    },
  });
  await registerAssetUploadRoutes(app, () => dummyDb, {
    createService: () => new AssetUploadTaskService(dummyDb, repository),
  });

  try {
    const boundary = "s42-reject-boundary";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/asset-upload-tasks",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "资产清单.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(creates, 0);
  } finally {
    await app.close();
  }
});

test("活跃任务列表与终态提醒按当前用户返回,提醒可确认", async () => {
  const app = Fastify({ logger: false });
  const acknowledged: string[] = [];
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetUploadRoutes(app, () => dummyDb, {
    createService: () => ({
      submitImage: async () => activeView(),
      listActive: async (actualActorId) => {
        assert.equal(actualActorId, actorId);
        return [activeView(), activeView({ id: "t-2", status: "processing", queuePosition: null })];
      },
      get: async () => activeView(),
      listNotifications: async (actualActorId, limit) => {
        assert.equal(actualActorId, actorId);
        assert.equal(limit, 20);
        return [
          notificationView(),
          notificationView({ id: "t-3", status: "failed", resultAssetEntityId: null, resultAssetName: null, errorMessage: "图片理解或入库失败,请稍后重试;若多次失败请换一张图片" }),
        ];
      },
      acknowledge: async (actualActorId, actualTaskId) => {
        assert.equal(actualActorId, actorId);
        acknowledged.push(actualTaskId);
      },
    }),
  });

  try {
    const active = await app.inject({ method: "GET", url: "/api/v1/asset-upload-tasks" });
    assert.equal(active.statusCode, 200);
    const activePayload = active.json() as { data: { count: number; items: Array<Record<string, unknown>> } };
    assert.equal(activePayload.data.count, 2);
    assert.deepEqual(activePayload.data.items.map((item) => item.status), ["queued", "processing"]);
    assert.equal(activePayload.data.items[1]!.queue_position, null);

    const notifications = await app.inject({ method: "GET", url: "/api/v1/asset-upload-notifications" });
    assert.equal(notifications.statusCode, 200);
    const notificationPayload = notifications.json() as { data: { count: number; items: Array<Record<string, unknown>> } };
    assert.equal(notificationPayload.data.count, 2);
    assert.equal(notificationPayload.data.items[0]!.result_asset_entity_id, assetEntityId);
    assert.equal(notificationPayload.data.items[1]!.status, "failed");
    assert.match(String(notificationPayload.data.items[1]!.error_message), /重试/);
    assert.match(String(notificationPayload.data.items[1]!.display_reason), /重试/);

    const acknowledgedResponse = await app.inject({
      method: "POST",
      url: `/api/v1/asset-upload-notifications/${taskId}/acknowledge`,
    });
    assert.equal(acknowledgedResponse.statusCode, 200);
    assert.deepEqual(acknowledgedResponse.json(), {
      ok: true,
      data: { notification_id: taskId, acknowledged: true },
    });
    assert.deepEqual(acknowledged, [taskId]);
  } finally {
    await app.close();
  }
});

test("提交时文件先落盘再入队,视图带排位与 ETA", async () => {
  let stagedPath = "";
  const repository = fakeRepository({
    create: async (input) => {
      stagedPath = input.stagedPath;
      assert.equal(input.userId, actorId);
      assert.equal(input.originalFileName, "场景.jpg");
      assert.equal(input.stagedBytes, Buffer.byteLength("fake-image-bytes"));
      return taskRow({ stagedPath: input.stagedPath });
    },
    queuePositionFor: async () => 2,
    estimatedDuration: async () => ({ seconds: null, sampleCount: 3 }),
  });
  const service = new AssetUploadTaskService(dummyDb, repository);
  try {
    const view = await service.submitImage(actorId, {
      fileName: "场景.jpg",
      declaredContentType: "image/jpeg",
      content: Buffer.from("fake-image-bytes"),
    });
    assert.ok(stagedPath.length > 0);
    assert.equal(view.status, "queued");
    assert.equal(view.queuePosition, 2);
    // 样本不足时 ETA 是 null,不是编出来的数字。
    assert.equal(view.estimatedDurationSeconds, null);
    assert.equal(view.estimatedDurationSampleCount, 3);
  } finally {
    if (stagedPath) await cleanupUpload(stagedPath).catch(() => false);
  }
});

test("暂存文件丢失时任务诚实失败,不假装处理成功", async () => {
  const failed: Array<{ taskId: string; errorMessage: string }> = [];
  const repository = fakeRepository({
    claimNextQueued: async () => taskRow({ status: "processing", startedAt: new Date() }),
    markFailed: async (actualTaskId, patch) => {
      failed.push({ taskId: actualTaskId, errorMessage: patch.errorMessage });
    },
  });
  const service = new AssetUploadTaskService(dummyDb, repository);
  const processed = await service.processNextQueued();
  assert.equal(processed, true);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.taskId, taskId);
  assert.match(failed[0]!.errorMessage, /请重新上传/);
});

test("上传 worker 快照：存储服务原文不写入公开任务原因", async () => {
  const stagedPath = await saveUpload("portrait.png", Buffer.from("registration-image"));
  const failed: Array<{ errorCode?: string | null; errorMessage: string }> = [];
  const repository = fakeRepository({
    claimNextQueued: async () => taskRow({
      status: "processing",
      stagedPath,
      startedAt: new Date(),
    }),
    markFailed: async (_actualTaskId, patch) => {
      failed.push(patch);
    },
  });
  const service = new AssetUploadTaskService(dummyDb, repository, {
    legacyIngest: {
      ingest: async () => {
        throw new ExternalServiceError("TOS", "request failed with status 503");
      },
    },
  });

  await service.processNextQueued();

  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.errorCode, "external_service_error");
  assert.equal(
    failed[0]?.errorMessage,
    "素材没能保存：存储服务暂时没响应，请稍后重试。",
  );
});

test("同一登记幂等键复用已有任务并清理本次多余暂存文件", async () => {
  let newlyStagedPath = "";
  const form = registrationForm();
  const repository = fakeRepository({
    createOrReuse: async (input) => {
      newlyStagedPath = input.stagedPath;
      return {
        task: taskRow({
          registrationForm: registrationFormSnapshot(form),
          clientIdempotencyKey: "88888888-8888-4888-8888-888888888888",
          requestSha256: input.requestSha256 ?? null,
          contentSha256: input.contentSha256 ?? null,
          assetKindHint: "character",
        }),
        created: false,
      };
    },
  });
  const service = new AssetUploadTaskService(dummyDb, repository, {
    registrationSchema: { validate: async () => form },
    seedance: fakeSeedance(),
    inspectImage: async () => ({
      format: "png",
      extension: "png",
      contentType: "image/png",
      width: 100,
      height: 100,
    }),
  });
  const result = await service.submitImage(actorId, {
    fileName: "portrait.png",
    declaredContentType: "image/png",
    content: Buffer.from("registration-image"),
    clientIdempotencyKey: "88888888-8888-4888-8888-888888888888",
    registration: {},
  });
  assert.equal(result.assetKind, "character");
  assert.equal(result.factorType, "face_identity");
  await assert.rejects(import("node:fs/promises").then(({ access }) => access(newlyStagedPath)));
});

test("登记 worker 先固化本地结果，再仅调用一次 Seedance CreateAsset", async () => {
  const stagedPath = await saveUpload("portrait.png", Buffer.from("registration-image"));
  const localResults: string[] = [];
  const succeeded: Array<Record<string, unknown>> = [];
  const vectorIds: string[] = [];
  let registerCalls = 0;
  const repository = fakeRepository({
    claimNextQueued: async () => taskRow({
      status: "processing",
      registrationForm: registrationFormSnapshot(registrationForm()),
      stagedPath,
      startedAt: new Date(),
    }),
    recordLocalResult: async (_taskId, patch) => {
      localResults.push(`${patch.resultAssetEntityId}:${patch.resultAssetMediaId}`);
    },
    markSucceeded: async (_taskId, patch) => { succeeded.push(patch); },
  });
  const service = new AssetUploadTaskService(dummyDb, repository, {
    registeredImages: {
      ingest: async () => ({ assetId: assetEntityId, mediaId: assetMediaId, name: "灰发老人" }),
    },
    seedance: fakeSeedance({
      registerAssetMedia: async () => {
        registerCalls += 1;
        return seedanceView();
      },
    }),
    queueVectorSync: (id) => { vectorIds.push(id); },
  });

  const processed = await service.processNextQueued();
  assert.equal(processed, true);
  assert.deepEqual(localResults, [`${assetEntityId}:${assetMediaId}`]);
  assert.equal(registerCalls, 1);
  assert.equal(succeeded[0]?.resultRegistrationStatus, "processing");
  assert.deepEqual(vectorIds, [assetEntityId]);
});

test("本地资产已存在时重启恢复不会重复上传或重复 CreateAsset", async () => {
  let ingests = 0;
  let creates = 0;
  const succeeded: Array<Record<string, unknown>> = [];
  const repository = fakeRepository({
    claimNextQueued: async () => taskRow({
      status: "processing",
      registrationForm: registrationFormSnapshot(registrationForm()),
      resultAssetEntityId: assetEntityId,
      resultAssetMediaId: assetMediaId,
      resultAssetName: "灰发老人",
    }),
    markSucceeded: async (_taskId, patch) => { succeeded.push(patch); },
  });
  const service = new AssetUploadTaskService(dummyDb, repository, {
    registeredImages: {
      ingest: async () => {
        ingests += 1;
        return { assetId: assetEntityId, mediaId: assetMediaId, name: "灰发老人" };
      },
    },
    seedance: fakeSeedance({
      getAssetMedia: async () => seedanceView(),
      registerAssetMedia: async () => {
        creates += 1;
        return seedanceView();
      },
    }),
    queueVectorSync: () => {},
  });
  await service.processNextQueued();
  assert.equal(ingests, 0);
  assert.equal(creates, 0);
  assert.equal(succeeded[0]?.resultRegistrationId, registrationId);
});

test("Seedance 缺配置时本地资产仍成功，嵌套登记诚实标 unavailable", async () => {
  const stagedPath = await saveUpload("portrait.png", Buffer.from("registration-image"));
  const succeeded: Array<Record<string, unknown>> = [];
  const repository = fakeRepository({
    claimNextQueued: async () => taskRow({
      status: "processing",
      registrationForm: registrationFormSnapshot(registrationForm()),
      stagedPath,
    }),
    markSucceeded: async (_taskId, patch) => { succeeded.push(patch); },
  });
  const service = new AssetUploadTaskService(dummyDb, repository, {
    registeredImages: {
      ingest: async () => ({ assetId: assetEntityId, mediaId: assetMediaId, name: "灰发老人" }),
    },
    seedance: fakeSeedance({
      registerAssetMedia: async () => {
        throw new AppError(
          503,
          "seedance_asset_registration_unavailable",
          "火山素材注册缺少安全配置，未发送任何请求",
        );
      },
    }),
    queueVectorSync: () => {},
  });
  await service.processNextQueued();
  assert.equal(succeeded[0]?.resultAssetEntityId, assetEntityId);
  assert.equal(succeeded[0]?.resultRegistrationStatus, "unavailable");
  assert.equal(succeeded[0]?.registrationErrorCode, "ASSET_REGISTRY_UNAVAILABLE");
  assert.equal(
    succeeded[0]?.registrationErrorMessage,
    "图片已进入个人资产库：素材登记没成，可稍后重试。",
  );
});

test("历史上传任务中的供应商错误码在业务 view 与 API 前统一归一", async () => {
  const repository = fakeRepository({
    getByUser: async () => taskRow({
      status: "succeeded",
      resultAssetEntityId: assetEntityId,
      resultAssetMediaId: assetMediaId,
      resultAssetName: "灰发老人",
      resultRegistrationId: null,
      resultRegistrationStatus: "failed",
      registrationErrorCode: "AccessDenied",
      registrationErrorMessage: "AccessDenied: request_url=https://provider.invalid/?token=secret",
      finishedAt: new Date("2026-08-05T00:00:00.000Z"),
    }),
  });
  const service = new AssetUploadTaskService(dummyDb, repository);
  const result = await service.get(actorId, taskId);
  assert.equal(
    result.result?.seedanceRegistration?.errorCode,
    "ASSET_REGISTRY_ACCESS_DENIED",
  );
  assert.equal(
    result.result?.seedanceRegistration?.errorMessage,
    "火山素材库拒绝访问，请核对账号权限",
  );
  const serialized = assetUploadTaskData(result);
  assert.doesNotMatch(
    JSON.stringify(serialized),
    /AccessDenied|provider\.invalid|token=secret/,
  );
});

test("序列化保持站内等待期合同字段名", () => {
  const data = assetUploadTaskData(activeView());
  assert.deepEqual(Object.keys(data), [
    "id",
    "status",
    "original_file_name",
    "asset_kind_hint",
    "asset_kind",
    "factor_type",
    "queue_position",
    "estimated_duration_seconds",
    "estimated_duration_sample_count",
    "created_at",
    "started_at",
    "finished_at",
    "result",
    "error",
    "display_reason",
  ]);
  const notification = assetUploadNotificationData(notificationView({
    status: "failed",
    errorCode: "external_service_error",
    errorMessage: "TOS request failed with status 503",
  }));
  assert.equal(notification.id, taskId);
  assert.equal(notification.result_asset_entity_id, assetEntityId);
  assert.equal(notification.error_message, "TOS request failed with status 503");
  assert.equal(notification.display_reason, "图片入库没成：请重新上传图片；多次失败可换一张。");
});
