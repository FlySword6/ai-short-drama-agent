import assert from "node:assert/strict";
import test from "node:test";
import {
  ArkAssetRegistryClient,
  ArkAssetRegistryError,
  type ArkAssetRegistryFetch,
} from "./arkAssetRegistry.js";

const endpoint = "https://ark.cn-beijing.volcengineapi.com/";

function client(fetchImpl: ArkAssetRegistryFetch): ArkAssetRegistryClient {
  return new ArkAssetRegistryClient({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret-example",
    endpoint,
    fetchImpl,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createInput(overrides: Partial<{
  groupId: string;
  url: string;
  assetType: "Image";
  projectName: string;
  name: string;
}> = {}) {
  return {
    groupId: "asset-group-1",
    url: "https://media.example.com/reference.png",
    assetType: "Image" as const,
    projectName: "shortdrama-dev",
    name: "角色参考图 [a1b2c3d4]",
    ...overrides,
  };
}

test("CreateAssetGroup 使用官方 2024-01-01 字段并返回素材组 ID", async () => {
  let requestUrl = "";
  let requestBody = "";
  const fetchImpl: ArkAssetRegistryFetch = (async (url, init) => {
    requestUrl = String(url);
    requestBody = String(init?.body);
    return jsonResponse({
      ResponseMetadata: { RequestId: "req-group-1" },
      Result: { Id: "group-created-1" },
    });
  }) as ArkAssetRegistryFetch;

  const result = await client(fetchImpl).createAssetGroup({
    name: "shortdrama-assets",
    description: "中文在线 AI 短剧平台素材库",
    groupType: "AIGC",
    projectName: "shortdrama-dev",
  });

  assert.deepEqual(result, {
    groupId: "group-created-1",
    requestId: "req-group-1",
    httpStatus: 200,
  });
  assert.equal(requestUrl, `${endpoint}?Action=CreateAssetGroup&Version=2024-01-01`);
  assert.deepEqual(JSON.parse(requestBody), {
    Name: "shortdrama-assets",
    Description: "中文在线 AI 短剧平台素材库",
    GroupType: "AIGC",
    ProjectName: "shortdrama-dev",
  });
});

test("CreateAssetGroup 缺 ID 或本地字段非法时 fail closed", async () => {
  let calls = 0;
  const invalidInputClient = client((async () => {
    calls += 1;
    return jsonResponse({});
  }) as ArkAssetRegistryFetch);
  await assert.rejects(
    () => invalidInputClient.createAssetGroup({
      name: "名".repeat(65),
      description: "素材组",
      groupType: "AIGC",
      projectName: "default",
    }),
    (error: unknown) => error instanceof ArkAssetRegistryError
      && error.errorCode === "INVALID_ASSET_REGISTRY_INPUT",
  );
  assert.equal(calls, 0);

  await assert.rejects(
    () => client((async () => jsonResponse({
      ResponseMetadata: { RequestId: "req-group-missing-id" },
      Result: {},
    })) as ArkAssetRegistryFetch).createAssetGroup({
      name: "shortdrama-assets",
      description: "素材组",
      groupType: "AIGC",
      projectName: "default",
    }),
    (error: unknown) => error instanceof ArkAssetRegistryError
      && error.errorCode === "MISSING_ASSET_GROUP_ID"
      && error.requestId === "req-group-missing-id",
  );
});

test("CreateAsset 使用官方 Name 字段，不发送漂移字段，并返回安全 requestId", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl: ArkAssetRegistryFetch = (async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return jsonResponse({
      ResponseMetadata: { RequestId: "req-create-1" },
      Result: { Id: "asset-created-1" },
    });
  }) as ArkAssetRegistryFetch;

  const result = await client(fetchImpl).createAsset(createInput());

  assert.deepEqual(result, {
    assetId: "asset-created-1",
    requestId: "req-create-1",
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
  });
  assert.equal(requestUrl, `${endpoint}?Action=CreateAsset&Version=2024-01-01`);
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    GroupId: "asset-group-1",
    URL: "https://media.example.com/reference.png",
    Name: "角色参考图 [a1b2c3d4]",
    AssetType: "Image",
    ProjectName: "shortdrama-dev",
  });
  const body = JSON.parse(String(requestInit?.body));
  assert.equal(Object.hasOwn(body, "assetName"), false);
  assert.equal(Object.hasOwn(body, "assetDesc"), false);
  assert.equal(Object.hasOwn(body, "userName"), false);
  const headers = requestInit?.headers as Record<string, string> | undefined;
  assert.equal(headers?.Authorization?.includes("AKIDEXAMPLE"), true);
});

for (const [resultKey, idKey] of [
  ["Result", "Id"],
  ["Result", "id"],
  ["result", "Id"],
  ["result", "id"],
] as const) {
  test(`CreateAsset 接受 DC 契约允许的 ${resultKey}.${idKey} 响应外壳`, async () => {
    const fetchImpl: ArkAssetRegistryFetch = (async () => jsonResponse({
      ResponseMetadata: { RequestId: `req-${resultKey}-${idKey}` },
      [resultKey]: { [idKey]: `asset-${resultKey}-${idKey}` },
    })) as ArkAssetRegistryFetch;

    const result = await client(fetchImpl).createAsset(createInput());
    assert.equal(result.assetId, `asset-${resultKey}-${idKey}`);
  });
}

test("CreateAsset 缺少四种允许外壳中的 ID 时 fail closed", async () => {
  const fetchImpl: ArkAssetRegistryFetch = (async () => jsonResponse({
    ResponseMetadata: { RequestId: "req-missing-asset-id" },
    Result: { ID: "asset-with-wrong-casing" },
    result: { identifier: "also-not-an-asset-id" },
  })) as ArkAssetRegistryFetch;

  await assert.rejects(
    () => client(fetchImpl).createAsset(createInput()),
    (error: unknown) => {
      assert.ok(error instanceof ArkAssetRegistryError);
      assert.equal(error.errorCode, "MISSING_ASSET_ID");
      assert.equal(error.requestId, "req-missing-asset-id");
      return true;
    },
  );
});

test("CreateAsset 在本地拒绝非法字段与非公共 HTTPS URL，不发送请求", async () => {
  let fetchCalls = 0;
  const fetchImpl: ArkAssetRegistryFetch = (async () => {
    fetchCalls += 1;
    return jsonResponse({});
  }) as ArkAssetRegistryFetch;
  const registry = client(fetchImpl);

  for (const input of [
    createInput({ name: "   " }),
    createInput({ name: "名".repeat(65) }),
    createInput({ url: "http://media.example.com/reference.png" }),
    createInput({ url: "https://127.0.0.1/reference.png" }),
    createInput({ url: "https://user:password@media.example.com/reference.png" }),
    { ...createInput(), assetType: "Video" as never },
  ]) {
    await assert.rejects(
      () => registry.createAsset(input),
      (error: unknown) => error instanceof ArkAssetRegistryError && error.errorCode === "INVALID_ASSET_REGISTRY_INPUT",
    );
  }
  assert.equal(fetchCalls, 0);
});

test("ListAssets 冻结筛选、分页、排序字段并解析安全映射", async () => {
  let requestUrl = "";
  let requestBody = "";
  const fetchImpl: ArkAssetRegistryFetch = (async (url, init) => {
    requestUrl = String(url);
    requestBody = String(init?.body);
    return jsonResponse({
      ResponseMetadata: { RequestId: "req-list-1" },
      Result: {
        Items: [{
          Id: "asset-created-1",
          Name: "角色参考图 [a1b2c3d4]",
          URL: "https://provider.example.com/12-hour-url",
          GroupId: "asset-group-1",
          AssetType: "Image",
          Status: "Active",
          Moderation: { Strategy: "Default" },
          Error: { Code: "", Message: "" },
          ProjectName: "shortdrama-dev",
          CreateTime: "2026-08-05T01:00:00Z",
          UpdateTime: "2026-08-05T01:01:00Z",
        }],
        TotalCount: 1,
        PageNumber: 1,
        PageSize: 100,
      },
    });
  }) as ArkAssetRegistryFetch;

  const result = await client(fetchImpl).listAssets({
    groupIds: ["asset-group-1"],
    groupType: "AIGC",
    statuses: ["Active", "Processing", "Active"],
    name: "角色参考图 [a1b2c3d4]",
    pageNumber: 1,
    pageSize: 100,
    sortBy: "CreateTime",
    sortOrder: "Desc",
    projectName: "shortdrama-dev",
  });

  assert.equal(requestUrl, `${endpoint}?Action=ListAssets&Version=2024-01-01`);
  assert.deepEqual(JSON.parse(requestBody), {
    Filter: {
      GroupIds: ["asset-group-1"],
      GroupType: "AIGC",
      Statuses: ["Active", "Processing"],
      Name: "角色参考图 [a1b2c3d4]",
    },
    PageNumber: 1,
    PageSize: 100,
    SortBy: "CreateTime",
    SortOrder: "Desc",
    ProjectName: "shortdrama-dev",
  });
  assert.deepEqual(result, {
    items: [{
      assetId: "asset-created-1",
      name: "角色参考图 [a1b2c3d4]",
      groupId: "asset-group-1",
      assetType: "Image",
      status: "Active",
      errorCode: null,
      errorMessage: null,
      projectName: "shortdrama-dev",
      createTime: "2026-08-05T01:00:00Z",
      updateTime: "2026-08-05T01:01:00Z",
      lastInferenceTime: null,
    }],
    totalCount: 1,
    pageNumber: 1,
    pageSize: 100,
    requestId: "req-list-1",
    httpStatus: 200,
  });
  assert.equal("url" in result.items[0]!, false, "供应商 12 小时 URL 不离开适配层");
});

test("ListAssets 对无效分页和未知素材状态 fail closed", async () => {
  let calls = 0;
  const registry = client((async () => {
    calls += 1;
    return jsonResponse({});
  }) as ArkAssetRegistryFetch);
  await assert.rejects(
    () => registry.listAssets({ groupIds: [], pageSize: 101, projectName: "default" }),
    (error: unknown) => error instanceof ArkAssetRegistryError
      && error.errorCode === "INVALID_ASSET_REGISTRY_INPUT",
  );
  assert.equal(calls, 0);

  await assert.rejects(
    () => client((async () => jsonResponse({
      ResponseMetadata: { RequestId: "req-list-invalid-status" },
      Result: {
        Items: [{
          Id: "asset-1",
          Name: "素材",
          GroupId: "group-1",
          AssetType: "Image",
          Status: "Ready",
          ProjectName: "default",
          CreateTime: "2026-08-05T01:00:00Z",
          UpdateTime: "2026-08-05T01:00:00Z",
        }],
        TotalCount: 1,
        PageNumber: 1,
        PageSize: 100,
      },
    })) as ArkAssetRegistryFetch).listAssets({
      groupIds: ["group-1"],
      projectName: "default",
    }),
    (error: unknown) => error instanceof ArkAssetRegistryError
      && error.errorCode === "INVALID_ASSET_LIST_ITEM"
      && error.requestId === "req-list-invalid-status",
  );
});

test("CreateAsset 识别 HTTP 200 内的 ResponseMetadata.Error，并脱敏 URL", async () => {
  const fetchImpl: ArkAssetRegistryFetch = (async () => jsonResponse({
    ResponseMetadata: {
      RequestId: "req-error-1",
      Error: {
        Code: "InvalidParameter",
        Message: "source https://private.example.com/prefix/reference.png Authorization=should-not-leak x-api-key=also-not-leak is invalid",
      },
    },
  })) as ArkAssetRegistryFetch;

  await assert.rejects(
    () => client(fetchImpl).createAsset(createInput()),
    (error: unknown) => {
      assert.ok(error instanceof ArkAssetRegistryError);
      assert.equal(error.errorCode, "InvalidParameter");
      assert.equal(error.requestId, "req-error-1");
      assert.match(error.message, /\[已隐藏地址\]/);
      assert.doesNotMatch(error.message, /private\.example\.com|should-not-leak|also-not-leak|x-api-key/i);
      return true;
    },
  );
});

test("GetAsset 发送 Id 和可选 ProjectName，并返回 Processing", async () => {
  let requestUrl = "";
  let requestBody = "";
  const fetchImpl: ArkAssetRegistryFetch = (async (url, init) => {
    requestUrl = String(url);
    requestBody = String(init?.body);
    return jsonResponse({
      ResponseMetadata: { RequestId: "req-get-1" },
      Result: { Status: "Processing" },
    });
  }) as ArkAssetRegistryFetch;

  const result = await client(fetchImpl).getAsset({
    assetId: "asset-created-1",
    projectName: "shortdrama-dev",
  });

  assert.deepEqual(result, {
    status: "Processing",
    requestId: "req-get-1",
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
  });
  assert.equal(requestUrl, `${endpoint}?Action=GetAsset&Version=2024-01-01`);
  assert.deepEqual(JSON.parse(requestBody), { Id: "asset-created-1", ProjectName: "shortdrama-dev" });
});

test("GetAsset 保留 Failed 业务状态与脱敏后的业务错误", async () => {
  const fetchImpl: ArkAssetRegistryFetch = (async () => jsonResponse({
    ResponseMetadata: { RequestId: "req-failed-1" },
    Result: {
      Status: "Failed",
      Error: {
        Code: "ModerationFailed",
        Message: "blocked by https://private.example.com/evidence.png",
      },
    },
  })) as ArkAssetRegistryFetch;

  const result = await client(fetchImpl).getAsset({ assetId: "asset-created-1" });
  assert.equal(result.status, "Failed");
  assert.equal(result.errorCode, "ModerationFailed");
  assert.match(result.errorMessage ?? "", /\[已隐藏地址\]/);
  assert.doesNotMatch(result.errorMessage ?? "", /private\.example\.com/);
});

test("GetAsset 保留明确的 Removed、Revoked 和 Unavailable 状态供服务层 fail-closed 映射", async () => {
  for (const status of ["Removed", "Revoked", "Unavailable"] as const) {
    const fetchImpl: ArkAssetRegistryFetch = (async () => jsonResponse({
      ResponseMetadata: { RequestId: `req-${status}` },
      Result: { Status: status },
    })) as ArkAssetRegistryFetch;
    assert.equal((await client(fetchImpl).getAsset({ assetId: "asset-created-1" })).status, status);
  }
});

test("GetAsset 拒绝未知状态，避免把未定义状态误当成可用素材", async () => {
  const fetchImpl: ArkAssetRegistryFetch = (async () => jsonResponse({
    ResponseMetadata: { RequestId: "req-unknown-status" },
    Result: { Status: "Ready" },
  })) as ArkAssetRegistryFetch;

  await assert.rejects(
    () => client(fetchImpl).getAsset({ assetId: "asset-created-1" }),
    (error: unknown) => {
      assert.ok(error instanceof ArkAssetRegistryError);
      assert.equal(error.errorCode, "INVALID_ASSET_STATUS");
      assert.equal(error.requestId, "req-unknown-status");
      return true;
    },
  );
});

test("网络异常和非 JSON 响应不泄露请求 URL 或鉴权信息", async () => {
  const requestFailure: ArkAssetRegistryFetch = (async () => {
    throw new Error("fetch https://private.example.com/x failed Authorization=secret");
  }) as ArkAssetRegistryFetch;
  await assert.rejects(
    () => client(requestFailure).getAsset({ assetId: "asset-created-1" }),
    (error: unknown) => {
      assert.ok(error instanceof ArkAssetRegistryError);
      assert.equal(error.errorCode, "ARK_REQUEST_FAILED");
      assert.doesNotMatch(error.message, /private\.example\.com|secret/);
      return true;
    },
  );

  const invalidJson: ArkAssetRegistryFetch = (async () => new Response("not json", { status: 200 })) as ArkAssetRegistryFetch;
  await assert.rejects(
    () => client(invalidJson).getAsset({ assetId: "asset-created-1" }),
    (error: unknown) => {
      assert.ok(error instanceof ArkAssetRegistryError);
      assert.equal(error.errorCode, "INVALID_ARK_RESPONSE");
      return true;
    },
  );
});
