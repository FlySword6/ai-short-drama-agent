import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../db/client.js";
import { ArkAssetRegistryAdapter } from "../integrations/arkAssetRegistryAdapter.js";
import { AssetUploadTaskService } from "../modules/asset-uploads/service.js";
import { VolcAssetGroupResolver } from "../modules/assets/volcAssetGroups.js";
import { SeedanceAssetRegistrationService } from "../modules/seedance-assets/service.js";
import {
  createAssetUploadTaskService,
  createSeedanceAssetRegistrationService,
  createSnapshotARegistration,
} from "./seedanceAssetRegistration.js";
import { VolcSnapshotRegistrationAdapter } from "../modules/vnext/assets/registrationAdapter.js";

const database = {} as Database;

test("生产 composition root 为路由和上传 worker 组装同一套真实 Ark 适配器", () => {
  const registration = createSeedanceAssetRegistrationService(database);
  assert.ok(registration instanceof SeedanceAssetRegistrationService);
  assert.ok(privateField(registration, "registry") instanceof ArkAssetRegistryAdapter);
  assert.ok(privateField(registration, "assetGroups") instanceof VolcAssetGroupResolver);

  const upload = createAssetUploadTaskService(database);
  assert.ok(upload instanceof AssetUploadTaskService);
  const nestedRegistration = privateField(upload, "seedance");
  assert.ok(nestedRegistration instanceof SeedanceAssetRegistrationService);
  assert.ok(
    privateField(nestedRegistration, "registry") instanceof ArkAssetRegistryAdapter,
  );

  const configuration = privateField<Record<string, unknown>>(
    nestedRegistration,
    "configuration",
  );
  assert.deepEqual(Object.keys(configuration).sort(), [
    "assetGroupDescription",
    "assetGroupId",
    "assetGroupName",
    "enabled",
    "projectName",
    "providerReady",
  ]);
  assert.equal(Object.keys(configuration).some((key) => /access|secret|token|key/i.test(key)), false);
});

test("生产 composition root 为 Snapshot A 组装既有 Ark 注册后端,且默认关闭不误接", () => {
  const wired = createSnapshotARegistration({ enabled: true, providerReady: true });
  assert.ok(wired instanceof VolcSnapshotRegistrationAdapter, "开启且有凭据时必须复用既有 Ark 注册后端");
  assert.ok(privateField(wired, "registry") instanceof ArkAssetRegistryAdapter);
  assert.equal(
    Object.keys(privateField<Record<string, unknown>>(wired, "configuration")).some((key) => /access|secret|token|key/i.test(key)),
    false,
  );

  assert.equal(createSnapshotARegistration({ enabled: false, providerReady: true }), undefined, "未开启不得组装注册后端");
  assert.equal(createSnapshotARegistration({ enabled: true, providerReady: false }), undefined, "缺凭据不得组装注册后端");
});
test("生产 composition root 在无显式素材组 ID 时复用既有素材组解析器", async () => {
  let resolveCalls = 0;
  const wired = createSnapshotARegistration({
    enabled: true,
    providerReady: true,
    assetGroups: {
      async importConfigured() { return { kind: "resolved", groupId: "group-configured", requestId: null }; },
      async claimCreate() { resolveCalls += 1; return { kind: "result", result: { kind: "resolved", groupId: "group-resolved", requestId: null } }; },
      async recordCreated() { return { kind: "resolved", groupId: "group-resolved", requestId: null }; },
      async recordFailure() {},
    },
    registry: {
      async createAssetGroup() { throw new Error("repository port must own group idempotency"); },
      async createAsset(input) { return { assetId: `asset-${input.groupId}`, requestId: null, httpStatus: 200, errorCode: null, errorMessage: null }; },
      async listAssets() { return { items: [], totalCount: 0, pageNumber: 1, pageSize: 100, requestId: null, httpStatus: 200 }; },
    },
    configuration: { assetGroupId: null, projectName: "shortdrama" },
  });
  assert.ok(wired, "开启且有凭据且注入素材组仓储时必须组装注册后端");
  const first = await wired!.register({ assetId: "11111111-1111-4111-8111-111111111111", mediaUrl: "https://example.test/a.png", mediaSha256: "a".repeat(64), name: "素材" });
  const second = await wired!.readbackByName({ assetId: "11111111-1111-4111-8111-111111111111", name: "素材" });
  assert.equal(first.registrationId, "asset-group-resolved", "无显式素材组 ID 时必须先解析既有素材组再登记");
  assert.equal(resolveCalls, 1, "同一进程内素材组解析结果必须缓存,不得每次登记重复创建");
  assert.equal(second.status, "unknown");
});

function privateField<T = unknown>(target: object, name: string): T {
  return (target as Record<string, T>)[name]!;
}
