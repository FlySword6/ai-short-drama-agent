import assert from "node:assert/strict";
import test from "node:test";
import { ArkAssetRegistryError } from "./arkAssetRegistry.js";
import { ArkAssetRegistryAdapter } from "./arkAssetRegistryAdapter.js";
import { VolcAssetRegistryOperationError } from "../modules/assets/volcAssetRegistry.js";

test("Ark adapter 把明确拒绝归一为可安全审计的确定失败", async () => {
  const adapter = new ArkAssetRegistryAdapter({
    createAssetGroup: async () => {
      throw new Error("must not run");
    },
    createAsset: async () => {
      throw new ArkAssetRegistryError(
        "AccessDenied",
        "provider denied",
        "req-denied",
        400,
        false,
        403,
      );
    },
    listAssets: async () => {
      throw new Error("must not run");
    },
  });

  await assert.rejects(
    () => adapter.createAsset({
      groupId: "group-test",
      url: "https://assets.example.test/reference.png",
      assetType: "Image",
      projectName: "shortdrama-dev",
      name: "测试素材",
    }),
    (error: unknown) => error instanceof VolcAssetRegistryOperationError
      && !error.outcomeUnknown
      && error.failure.errorCode === "ASSET_REGISTRY_ACCESS_DENIED"
      && error.failure.errorMessage === "火山素材库拒绝访问，请核对账号权限"
      && !error.failure.errorMessage.includes("provider denied")
      && error.failure.requestId === "req-denied"
      && error.failure.httpStatus === 403,
  );
});

test("Ark adapter 只在写入结果可能已发生时标记 outcomeUnknown", async () => {
  const adapter = new ArkAssetRegistryAdapter({
    createAssetGroup: async () => {
      throw new ArkAssetRegistryError(
        "MISSING_ASSET_GROUP_ID",
        "missing group id",
        "req-missing",
        502,
        false,
        200,
      );
    },
    createAsset: async () => {
      throw new Error("must not run");
    },
    listAssets: async () => {
      throw new Error("must not run");
    },
  });

  await assert.rejects(
    () => adapter.createAssetGroup({
      name: "测试素材组",
      description: "适配器结果归一测试",
      groupType: "AIGC",
      projectName: "shortdrama-dev",
    }),
    (error: unknown) => error instanceof VolcAssetRegistryOperationError
      && error.outcomeUnknown
      && error.failure.errorCode === "ASSET_REGISTRY_INVALID_RESPONSE",
  );
});

test("Ark adapter 的只读异常不会被业务层误判为一次未知写入", async () => {
  const adapter = new ArkAssetRegistryAdapter({
    createAssetGroup: async () => {
      throw new Error("must not run");
    },
    createAsset: async () => {
      throw new Error("must not run");
    },
    listAssets: async () => {
      throw new Error("transport details must stay inside adapter");
    },
  });

  await assert.rejects(
    () => adapter.listAssets({
      groupIds: ["group-test"],
      projectName: "shortdrama-dev",
    }),
    (error: unknown) => error instanceof VolcAssetRegistryOperationError
      && !error.outcomeUnknown
      && error.failure.errorCode === "ASSET_REGISTRY_UNAVAILABLE"
      && error.failure.requestId === null,
  );
});

test("Ark adapter 同时归一 ListAssets 素材项错误，不透传供应商码或消息", async () => {
  const adapter = new ArkAssetRegistryAdapter({
    createAssetGroup: async () => {
      throw new Error("must not run");
    },
    createAsset: async () => {
      throw new Error("must not run");
    },
    listAssets: async () => ({
      items: [{
        assetId: "Asset-failed",
        name: "失败素材",
        groupId: "group-test",
        assetType: "Image",
        status: "Failed",
        errorCode: "InvalidParameter",
        errorMessage: "raw provider URL https://secret.example.test/object",
        projectName: "shortdrama-dev",
        createTime: "2026-08-05T00:00:00Z",
        updateTime: "2026-08-05T00:01:00Z",
        lastInferenceTime: null,
      }],
      totalCount: 1,
      pageNumber: 1,
      pageSize: 100,
      requestId: "req-list-failed",
      httpStatus: 200,
    }),
  });

  const result = await adapter.listAssets({
    groupIds: ["group-test"],
    projectName: "shortdrama-dev",
  });
  assert.equal(result.items[0]?.errorCode, "ASSET_REGISTRY_INVALID_REQUEST");
  assert.equal(result.items[0]?.errorMessage, "素材注册请求不符合火山素材库合同");
  assert.doesNotMatch(JSON.stringify(result.items[0]), /InvalidParameter|secret\.example/);
});
