import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import {
  RegisteredImageAssetService,
  type RegisteredImagePersistenceInput,
} from "./registeredImage.js";
import type { AssetRegistrationForm } from "./registrationSchema.js";

const dummyDb = {} as Database;
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

function form(): AssetRegistrationForm {
  return {
    schemaVersion: "asset-registration-v1",
    dictionaryVersion: "asset-factor-v0.2",
    name: "用户命名",
    description: "用户填写的说明",
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

test("登记图片使用用户表单为正式事实，模型理解只作为 inferred 输入交给持久层", async () => {
  let persisted: RegisteredImagePersistenceInput | undefined;
  const uploadedPaths: string[] = [];
  let idIndex = 0;
  const service = new RegisteredImageAssetService(dummyDb, {
    createId: () => ids[idIndex++]!,
    inspectImage: async () => ({
      format: "png",
      extension: "png",
      contentType: "image/png",
      width: 512,
      height: 512,
    }),
    vision: {
      describeImage: async () => ({
        name: "模型另一个命名",
        asset_kind: "scene",
        confidence_score: 0.99,
      }),
    },
    storage: {
      uploadBytes: async (_content, storagePath) => {
        uploadedPaths.push(storagePath);
        return { bucket: "test-bucket", storagePath, storageUrl: `https://assets.invalid/${storagePath}` };
      },
      deleteObject: async () => {},
    },
    repository: {
      persist: async (input) => {
        persisted = input;
        return { assetId: input.assetId, mediaId: input.mediaId, name: input.form.name };
      },
    },
  });

  const result = await service.ingest({
    taskId: "33333333-3333-4333-8333-333333333333",
    actorId: "actor",
    fileName: "portrait.png",
    declaredContentType: "image/png",
    content: Buffer.from("valid-image-test-bytes"),
    form: form(),
  });

  assert.equal(result.name, "用户命名");
  assert.equal(persisted?.form.name, "用户命名");
  assert.equal(persisted?.form.assetKind, "character");
  assert.equal(persisted?.inferred.name, "模型另一个命名");
  assert.match(uploadedPaths[0]!, /^prod\/asset\/11111111-1111-4111-8111-111111111111\/media\//);
});

test("TOS 已写但数据库事务失败时清理无主对象", async () => {
  const deleted: string[] = [];
  let idIndex = 0;
  const service = new RegisteredImageAssetService(dummyDb, {
    createId: () => ids[idIndex++]!,
    inspectImage: async () => ({
      format: "png",
      extension: "png",
      contentType: "image/png",
      width: 100,
      height: 100,
    }),
    vision: { describeImage: async () => ({ asset_kind: "character" }) },
    storage: {
      uploadBytes: async (_content, storagePath) => ({
        bucket: "test-bucket",
        storagePath,
        storageUrl: `https://assets.invalid/${storagePath}`,
      }),
      deleteObject: async (storagePath) => { deleted.push(storagePath); },
    },
    repository: {
      persist: async () => { throw new Error("database failed"); },
    },
  });

  await assert.rejects(service.ingest({
    taskId: "33333333-3333-4333-8333-333333333333",
    actorId: "actor",
    fileName: "portrait.png",
    declaredContentType: "image/png",
    content: Buffer.from("valid-image-test-bytes"),
    form: form(),
  }), /database failed/);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0]!, /^prod\/asset\//);
});
