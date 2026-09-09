import assert from "node:assert/strict";
import test from "node:test";
import type { SeedanceAssetRegistrationRow } from "../../db/schema.js";
import {
  VolcAssetRegistryOperationError,
  type ListVolcAssetsResult,
} from "../assets/volcAssetRegistry.js";
import {
  SeedanceAssetRegistrationService,
  type SeedanceAssetRegistrationServiceDependencies,
} from "./service.js";
import type { PreparedRegistration } from "./repository.js";
import type { SeedanceAssetRegistrationView } from "./types.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const resultId = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";
const registrationId = "44444444-4444-4444-8444-444444444444";
const groupId = "asset-group-test";
const remoteAssetId = "Asset-registered";

function registration(
  status: SeedanceAssetRegistrationRow["status"] = "pending",
  overrides: Partial<SeedanceAssetRegistrationRow> = {},
): SeedanceAssetRegistrationRow {
  const now = new Date("2026-08-05T00:00:00.000Z");
  const hasRemote = status === "processing" || status === "active" || status === "unavailable";
  const hasFailure = status === "failed" || status === "unknown" || status === "unavailable";
  return {
    id: registrationId,
    assetMediaId: mediaId,
    sourceMediaResultId: resultId,
    assetGroupId: groupId,
    projectName: "shortdrama-dev",
    remoteAssetId: hasRemote ? remoteAssetId : null,
    remoteAssetName: hasRemote ? "角色参考 [33333333]" : null,
    status,
    createdByUserId: actorId,
    lastActionByUserId: actorId,
    createdAt: now,
    updatedAt: now,
    lastActionAt: now,
    activatedAt: status === "active" ? now : null,
    authorizationExpiresAt: null,
    lastVerifiedAt: status === "active" || status === "unavailable" ? now : null,
    latestRequestId: null,
    latestErrorCode: hasFailure ? "ARK_TEST_FAILURE" : null,
    latestErrorMessage: hasFailure ? "火山素材登记未完成" : null,
    retryCount: 0,
    lastRetryAt: null,
    ...overrides,
  };
}

function view(
  status: SeedanceAssetRegistrationView["status"] = "pending",
  overrides: Partial<SeedanceAssetRegistrationView> = {},
): SeedanceAssetRegistrationView {
  const row = registration(status);
  return {
    id: row.id,
    assetMediaId: row.assetMediaId,
    sourceMediaResultId: row.sourceMediaResultId,
    assetGroupId: row.assetGroupId,
    remoteAssetId: row.remoteAssetId,
    status: status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    activatedAt: row.activatedAt,
    authorizationExpiresAt: row.authorizationExpiresAt,
    lastVerifiedAt: row.lastVerifiedAt,
    latestRequestId: row.latestRequestId,
    latestErrorCode: row.latestErrorCode ? "ASSET_REGISTRY_FAILED" : null,
    latestErrorMessage: row.latestErrorMessage,
    retryCount: row.retryCount,
    lastRetryAt: row.lastRetryAt,
    ...overrides,
  };
}

function prepared(
  status: SeedanceAssetRegistrationRow["status"] = "pending",
  overrides: Partial<SeedanceAssetRegistrationRow> = {},
): PreparedRegistration {
  return {
    registration: registration(status, overrides),
    source: {
      assetMediaId: mediaId,
      sourceMediaResultId: resultId,
      storageUrl: "https://assets.example.test/reference.png",
      assetType: "Image",
      name: "角色参考",
    },
    created: false,
  };
}

function configuration(enabled = true) {
  return {
    enabled,
    providerReady: true,
    assetGroupId: groupId,
    assetGroupName: "中文在线短剧素材",
    assetGroupDescription: "中文在线 AI 短剧平台登记的图片参考素材",
    projectName: "shortdrama-dev",
  };
}

type Registry = NonNullable<SeedanceAssetRegistrationServiceDependencies["registry"]>;

function registry(overrides: Partial<Registry> = {}): Registry {
  return {
    createAssetGroup: async () => ({
      groupId,
      requestId: "req-group",
      httpStatus: 200,
    }),
    createAsset: async () => ({
      assetId: remoteAssetId,
      requestId: "req-create",
      httpStatus: 200,
      errorCode: null,
      errorMessage: null,
    }),
    listAssets: async () => listResult([]),
    ...overrides,
  };
}

function listResult(
  items: ListVolcAssetsResult["items"],
  overrides: Partial<ListVolcAssetsResult> = {},
): ListVolcAssetsResult {
  return {
    items,
    totalCount: items.length,
    pageNumber: 1,
    pageSize: 100,
    requestId: "req-list",
    httpStatus: 200,
    ...overrides,
  };
}

test("disabled 或缺 AK/SK 时在读取素材和远端写入前 fail closed", async () => {
  for (const config of [
    configuration(false),
    { ...configuration(), providerReady: false },
  ]) {
    let prepareCalls = 0;
    let remoteCalls = 0;
    const service = new SeedanceAssetRegistrationService({
      prepareForMediaResult: async () => {
        prepareCalls += 1;
        return prepared();
      },
    } as never, {
      configuration: config,
      registry: registry({
        createAsset: async () => {
          remoteCalls += 1;
          throw new Error("must not run");
        },
      }),
    });

    await assert.rejects(
      () => service.registerMediaResult(actorId, resultId),
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error.code === "seedance_asset_registration_disabled"
          || error.code === "seedance_asset_registration_unavailable"),
    );
    assert.equal(prepareCalls, 0);
    assert.equal(remoteCalls, 0);
  }
});
test("权限/TOS 预检后解析并绑定素材组，再原子领取一次 CreateAsset", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const repository = {
    prepareForMediaResult: async (...args: unknown[]) => {
      calls.push({ method: "prepare", args });
      return prepared("pending", { assetGroupId: null });
    },
    bindAssetGroup: async (...args: unknown[]) => {
      calls.push({ method: "bind-group", args });
      return registration("pending");
    },
    claimCreate: async (...args: unknown[]) => {
      calls.push({ method: "claim", args });
      return {
        kind: "create" as const,
        registration: registration("submitting"),
        source: {
          ...prepared().source,
          storageUrl: "https://assets.example.test/reference-current.png",
          name: "事务重读角色参考",
        },
      };
    },
    recordCreateSubmitted: async (...args: unknown[]) => {
      calls.push({ method: "submitted", args });
      return view("processing");
    },
  };
  const service = new SeedanceAssetRegistrationService(repository as never, {
    configuration: { ...configuration(), assetGroupId: null },
    assetGroups: {
      resolve: async (...args) => {
        calls.push({ method: "resolve-group", args });
        return { kind: "resolved", groupId, requestId: "req-group" };
      },
    },
    registry: registry({
      createAsset: async (input) => {
        calls.push({ method: "create", args: [input] });
        return {
          assetId: remoteAssetId,
          requestId: "req-create",
          httpStatus: 200,
          errorCode: null,
          errorMessage: null,
        };
      },
    }),
  });

  assert.equal((await service.registerMediaResult(actorId, resultId)).status, "processing");
  assert.deepEqual(calls.map((call) => call.method), [
    "prepare",
    "resolve-group",
    "bind-group",
    "claim",
    "create",
    "submitted",
  ]);
  assert.deepEqual(calls.find((call) => call.method === "create")?.args[0], {
    groupId,
    url: "https://assets.example.test/reference-current.png",
    assetType: "Image",
    projectName: "shortdrama-dev",
    name: "事务重读角色参考 [33333333]",
  });
  assert.deepEqual(calls.find((call) => call.method === "submitted")?.args[2], {
    assetId: remoteAssetId,
    assetName: "事务重读角色参考 [33333333]",
    requestId: "req-create",
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
  });
});

test("素材组明确失败如实落登记失败，素材组创建中则不调用 CreateAsset", async () => {
  for (const resolution of [
    {
      kind: "failure" as const,
      status: "failed" as const,
      failure: {
        errorCode: "ASSET_GROUP_ACCESS_DENIED" as const,
        errorMessage: "火山素材组创建失败，请核对素材库权限和配置后再次明确提交",
        requestId: "req-denied",
        httpStatus: 403,
      },
    },
    { kind: "settling" as const },
  ]) {
    let createCalls = 0;
    let failureCalls = 0;
    const repository = {
      prepareForMediaResult: async () => prepared("pending", { assetGroupId: null }),
      recordGroupFailure: async () => {
        failureCalls += 1;
        return view("failed");
      },
      viewForRegistration: async () => view("pending"),
    };
    const service = new SeedanceAssetRegistrationService(repository as never, {
      configuration: { ...configuration(), assetGroupId: null },
      assetGroups: { resolve: async () => resolution },
      registry: registry({
        createAsset: async () => {
          createCalls += 1;
          throw new Error("must not run");
        },
      }),
    });
    const result = await service.registerMediaResult(actorId, resultId);
    assert.equal(result.status, resolution.kind === "failure" ? "failed" : "pending");
    assert.equal(failureCalls, resolution.kind === "failure" ? 1 : 0);
    assert.equal(createCalls, 0);
  }
});

test("非图片在素材组远端动作前拒绝", async () => {
  let groupCalls = 0;
  let claimCalls = 0;
  const unsupported = prepared();
  // 仓库层 volcAssetType 已对 video 抛错;这里直接构造越类型值,验证服务层闸门仍兜底。
  unsupported.source.assetType = "Video" as never;
  const service = new SeedanceAssetRegistrationService({
    prepareForMediaResult: async () => unsupported,
    claimCreate: async () => {
      claimCalls += 1;
      return {
        kind: "create",
        registration: registration("submitting"),
        source: prepared().source,
      };
    },
  } as never, {
    configuration: configuration(),
    assetGroups: {
      resolve: async () => {
        groupCalls += 1;
        return { kind: "resolved", groupId, requestId: null };
      },
    },
    registry: registry(),
  });
  await assert.rejects(
    () => service.registerMediaResult(actorId, resultId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_request",
  );
  assert.equal(groupCalls, 0);
  assert.equal(claimCalls, 0);
});

test("音频登记直达 CreateAsset(assetType=Audio),名称按 createAssetName 归一", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const audioSource: PreparedRegistration["source"] = {
    ...prepared().source,
    assetType: "Audio",
    storageUrl: "https://assets.example.test/voice.mp3",
    name: "旁白音频",
  };
  const repository = {
    prepareForAssetMedia: async () => ({
      registration: registration("pending", { assetGroupId: null }),
      source: audioSource,
      created: false,
    }),
    bindAssetGroup: async () => registration("pending"),
    claimCreate: async () => ({ kind: "create", registration: registration("submitting"), source: audioSource }),
    recordCreateSubmitted: async (...args: unknown[]) => {
      calls.push({ method: "submitted", args });
      return view("processing");
    },
  };
  const service = new SeedanceAssetRegistrationService(repository as never, {
    configuration: { ...configuration(), assetGroupId: null },
    assetGroups: {
      resolve: async () => {
        calls.push({ method: "resolve-group", args: [] });
        return { kind: "resolved", groupId, requestId: "req-group" };
      },
    },
    registry: registry({
      createAsset: async (input) => {
        calls.push({ method: "create", args: [input] });
        return { assetId: remoteAssetId, requestId: "req-create", httpStatus: 200, errorCode: null, errorMessage: null };
      },
    }),
  });
  const result = await service.registerAssetMedia(actorId, "asset-1", mediaId);
  assert.equal(result.status, "processing");
  const createCall = calls.find((call) => call.method === "create");
  assert.ok(createCall, "音频主变体必须到达 CreateAsset");
  const createArgs = createCall.args[0] as { assetType?: string; url?: string };
  assert.equal(createArgs.assetType, "Audio");
  assert.equal(createArgs.url, "https://assets.example.test/voice.mp3");
});

test("CreateAsset 不确定结果进入 unknown，连续点击不会由服务层自动重发", async () => {
  let createCalls = 0;
  let state: "pending" | "unknown" = "pending";
  const repository = {
    prepareForMediaResult: async () => prepared(state),
    bindAssetGroup: async () => registration(state),
    claimCreate: async () => state === "pending"
      ? {
        kind: "create" as const,
        registration: registration("submitting"),
        source: prepared().source,
      }
      : { kind: "settling" as const, registration: registration("unknown") },
    recordCreateUnknown: async () => {
      state = "unknown";
      return view("unknown");
    },
    viewForRegistration: async () => view("unknown"),
  };
  const service = new SeedanceAssetRegistrationService(repository as never, {
    configuration: configuration(),
    registry: registry({
      createAsset: async () => {
        createCalls += 1;
        throw new VolcAssetRegistryOperationError(
          {
            errorCode: "ASSET_REGISTRY_INVALID_RESPONSE",
            errorMessage: "missing asset id",
            requestId: "req-missing-id",
            httpStatus: 200,
          },
          true,
        );
      },
    }),
  });
  assert.equal((await service.registerMediaResult(actorId, resultId)).status, "unknown");
  assert.equal((await service.registerMediaResult(actorId, resultId)).status, "unknown");
  assert.equal(createCalls, 1);
});

test("ListAssets 翻页后只按 Asset ID + Group ID + ProjectName 精确回读", async () => {
  const listCalls: unknown[] = [];
  const recorded: unknown[] = [];
  const repository = {
    getPreparedSourceForMediaResult: async () => prepared("processing"),
    recordAssetStatus: async (...args: unknown[]) => {
      recorded.push(args);
      return view("active");
    },
  };
  const matchingItem = {
    assetId: remoteAssetId,
    name: "角色参考 [33333333]",
    groupId,
    assetType: "Image" as const,
    status: "Active" as const,
    errorCode: null,
    errorMessage: null,
    projectName: "shortdrama-dev",
    createTime: "2026-08-05T00:00:00Z",
    updateTime: "2026-08-05T00:00:01Z",
    lastInferenceTime: null,
  };
  const service = new SeedanceAssetRegistrationService(repository as never, {
    configuration: configuration(),
    registry: registry({
      listAssets: async (input) => {
        listCalls.push(input);
        return input.pageNumber === 1
          ? listResult([], { totalCount: 101, pageNumber: 1 })
          : listResult([matchingItem], { totalCount: 101, pageNumber: 2 });
      },
    }),
  });
  assert.equal((await service.refreshMediaResult(actorId, resultId)).status, "active");
  assert.equal(listCalls.length, 2);
  assert.deepEqual(listCalls[0], {
    groupIds: [groupId],
    groupType: "AIGC",
    statuses: ["Active", "Processing", "Failed"],
    name: "角色参考 [33333333]",
    pageNumber: 1,
    pageSize: 100,
    sortBy: "CreateTime",
    sortOrder: "Desc",
    projectName: "shortdrama-dev",
  });
  assert.equal((recorded[0] as unknown[])[2] && ((recorded[0] as unknown[])[2] as { status: string }).status, "Active");
});

test("ListAssets 暂未找到时保持 processing；身份冲突或协议失败转 unknown", async () => {
  const cases = [
    {
      list: async () => listResult([]),
      expected: "processing",
      expectedMethod: "status",
    },
    {
      list: async () => listResult([{
        assetId: remoteAssetId,
        name: "角色参考 [33333333]",
        groupId: "wrong-group",
        assetType: "Image" as const,
        status: "Active" as const,
        errorCode: null,
        errorMessage: null,
        projectName: "shortdrama-dev",
        createTime: "2026-08-05T00:00:00Z",
        updateTime: "2026-08-05T00:00:01Z",
        lastInferenceTime: null,
      }]),
      expected: "unknown",
      expectedMethod: "failure",
    },
  ];
  for (const item of cases) {
    const calls: string[] = [];
    const repository = {
      getPreparedSourceForMediaResult: async () => prepared("processing"),
      recordAssetStatus: async () => {
        calls.push("status");
        return view("processing");
      },
      recordRefreshFailure: async () => {
        calls.push("failure");
        return view("unknown");
      },
    };
    const service = new SeedanceAssetRegistrationService(repository as never, {
      configuration: configuration(),
      registry: registry({ listAssets: item.list }),
    });
    assert.equal((await service.refreshMediaResult(actorId, resultId)).status, item.expected);
    assert.deepEqual(calls, [item.expectedMethod]);
  }
});
