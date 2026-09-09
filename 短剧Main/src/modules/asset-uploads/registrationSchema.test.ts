import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { AppError } from "../../shared/errors.js";
import {
  ASSET_FACTOR_DICTIONARY_VERSION,
  ASSET_REGISTRATION_SCHEMA_VERSION,
  AssetRegistrationSchemaService,
  type AssetKindVocabularyPort,
} from "./registrationSchema.js";

const dummyDb = {} as Database;
const vocabulary: AssetKindVocabularyPort = {
  listActive: async () => [
    { id: "character", canonicalId: "character", displayName: "角色", sort: 10 },
    { id: "costume", canonicalId: "costume", displayName: "服装", sort: 20 },
    { id: "clothing", canonicalId: "costume", displayName: "服装别名", sort: 21 },
    { id: "video", canonicalId: "video", displayName: "视频", sort: 30 },
  ],
};

function validRegistration() {
  return {
    schema_version: ASSET_REGISTRATION_SCHEMA_VERSION,
    dictionary_version: ASSET_FACTOR_DICTIONARY_VERSION,
    name: "灰发老人",
    description: "正面中性肖像",
    asset_kind: "character",
    factor_type: "face_identity",
    tags: ["写实人像", "写实人像"],
    factor_attributes: {
      view_type: "front",
      stable_feature_notes: "灰发、短须",
    },
    rights_declaration: {
      source_kind: "self_created",
      contains_real_person: false,
      reference_use_confirmed: true,
    },
  };
}

test("登记 schema 从词表给出图片类型、字典版本戳和因子字段", async () => {
  const service = new AssetRegistrationSchemaService(dummyDb, vocabulary);
  const schema = await service.getSchema("character", "face_identity");
  assert.equal(schema.schemaVersion, "asset-registration-v1");
  assert.equal(schema.dictionaryVersion, "asset-factor-v0.2");
  assert.deepEqual(schema.acceptedMediaKinds, ["image"]);
  assert.deepEqual(schema.assetKinds.map((kind) => kind.id), ["character", "costume"]);
  assert.deepEqual(schema.fields.map((field) => field.id), [
    "name",
    "description",
    "view_type",
    "stable_feature_notes",
  ]);
  assert.ok(schema.systemManagedFields.includes("confidence_score"));
  assert.equal(schema.defaults.status, "approved");
});

test("登记提交解析别名为 canonical，并保持用户声明来源", async () => {
  const service = new AssetRegistrationSchemaService(dummyDb, vocabulary);
  const parsed = await service.validate({
    ...validRegistration(),
    asset_kind: "clothing",
    factor_type: "costume",
    factor_attributes: { dominant_colors: ["蓝", "白"], material: "棉" },
  });
  assert.equal(parsed.assetKind, "costume");
  assert.equal(parsed.factorType, "costume");
  assert.deepEqual(parsed.tags, ["写实人像"]);
  assert.deepEqual(parsed.factorAttributes, {
    dominant_colors: ["蓝", "白"],
    material: "棉",
  });
});

test("版本戳、未知因子字段和权利确认分别返回稳定业务错误", async () => {
  const service = new AssetRegistrationSchemaService(dummyDb, vocabulary);
  await assert.rejects(
    service.validate({ ...validRegistration(), dictionary_version: "asset-factor-v0.1" }),
    (error: unknown) => error instanceof AppError && error.code === "registration_schema_mismatch",
  );
  await assert.rejects(
    service.validate({
      ...validRegistration(),
      factor_attributes: { confidence_score: 0.99 },
    }),
    (error: unknown) => error instanceof AppError && error.code === "unknown_factor_field",
  );
  await assert.rejects(
    service.validate({
      ...validRegistration(),
      rights_declaration: {
        ...validRegistration().rights_declaration,
        reference_use_confirmed: false,
      },
    }),
    (error: unknown) => error instanceof AppError && error.code === "rights_confirmation_required",
  );
});
