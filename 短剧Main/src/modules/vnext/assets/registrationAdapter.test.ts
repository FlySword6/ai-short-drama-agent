import assert from "node:assert/strict";
import test from "node:test";
import {
  VolcAssetRegistryOperationError,
  type ListVolcAssetsResult,
  type VolcAssetListItem,
  type VolcAssetRegistryPort,
} from "../../assets/volcAssetRegistry.js";
import { VolcSnapshotRegistrationAdapter, snapshotAssetName } from "./registrationAdapter.js";

function item(assetId: string, status: VolcAssetListItem["status"] = "Active"): VolcAssetListItem {
  return {
    assetId,
    name: `asset-${assetId}`,
    groupId: "group-309",
    assetType: "Image",
    status,
    errorCode: null,
    errorMessage: null,
    projectName: "shortdrama",
    createTime: "2026-08-15T00:00:00Z",
    updateTime: "2026-08-15T00:00:00Z",
    lastInferenceTime: null,
  };
}

function page(items: VolcAssetListItem[], totalCount: number, pageNumber: number): ListVolcAssetsResult {
  return { items, totalCount, pageNumber, pageSize: 100, requestId: `req-${pageNumber}`, httpStatus: 200 };
}

function adapterWithPages(pages: ListVolcAssetsResult[]): VolcSnapshotRegistrationAdapter {
  const registry: Pick<VolcAssetRegistryPort, "listAssets"> = {
    async listAssets(input) {
      const pageNumber = input.pageNumber ?? 1;
      const found = pages[pageNumber - 1];
      if (!found) throw new VolcAssetRegistryOperationError({
        errorCode: "ASSET_REGISTRY_UNAVAILABLE",
        errorMessage: "unexpected page request",
        requestId: null,
        httpStatus: null,
      }, false);
      return found;
    },
  };
  return new VolcSnapshotRegistrationAdapter(registry as VolcAssetRegistryPort, { assetGroupId: "group-309", projectName: "shortdrama" });
}

test("readback paginates beyond the first page using the bounded list pattern", async () => {
  const target = item("remote-beyond-page-one", "Active");
  const pages = [
    page(Array.from({ length: 100 }, (_, index) => item(`filler-a-${index}`)), 250, 1),
    page(Array.from({ length: 100 }, (_, index) => item(`filler-b-${index}`)), 250, 2),
    page([target, ...Array.from({ length: 49 }, (_, index) => item(`filler-c-${index}`))], 250, 3),
  ];
  const result = await adapterWithPages(pages).readback({ registrationId: "remote-beyond-page-one", name: "目标素材" });
  assert.equal(result.status, "active");
  assert.equal(result.registrationId, "remote-beyond-page-one");
  assert.equal((result.readback as { assetId?: string }).assetId, "remote-beyond-page-one");
});

test("readback reports not found only after exhausting bounded pages and keeps the remote id", async () => {
  const pages = [page([item("other")], 1, 1)];
  const result = await adapterWithPages(pages).readback({ registrationId: "remote-missing", name: "目标素材" });
  assert.equal(result.status, "unknown");
  assert.equal(result.registrationId, "remote-missing", "未找到不得清空已知远端素材 ID");
  assert.equal(result.failureCode, "ASSET_REGISTRY_NOT_FOUND");
});

test("readback limit keeps a known remote id readback-only", async () => {
  const pages = Array.from({ length: 10 }, (_, index) => page(
    Array.from({ length: 100 }, (_, itemIndex) => item(`filler-${index}-${itemIndex}`)),
    5_000,
    index + 1,
 ));
  const result = await adapterWithPages(pages).readback({ registrationId: "remote-deep", name: "目标素材" });
  assert.equal(result.status, "unknown");
  assert.equal(result.failureCode, "ASSET_REGISTRY_QUERY_LIMIT_REACHED");
  assert.equal(result.registrationId, "remote-deep", "超过查询上限不得清空已知远端素材 ID");
});

test("readback failures preserve the known remote id instead of blanking it", async () => {
  const registry: Pick<VolcAssetRegistryPort, "listAssets"> = {
    async listAssets() {
      throw new VolcAssetRegistryOperationError({
        errorCode: "ASSET_REGISTRY_UNAVAILABLE",
        errorMessage: "服务暂时不可用",
        requestId: "req-x",
        httpStatus: 503,
      }, true);
    },
  };
  const adapter = new VolcSnapshotRegistrationAdapter(registry as VolcAssetRegistryPort, { assetGroupId: "group-309", projectName: "shortdrama" });
  const result = await adapter.readback({ registrationId: "remote-known", name: "目标素材" });
  assert.equal(result.status, "unknown");
  assert.equal(result.registrationId, "remote-known", "瞬时故障不得把已知远端素材 ID 抹成 null");
  assert.equal(result.failureCode, "ASSET_REGISTRY_UNAVAILABLE");
});
test("readbackByName reconciles ambiguous registration by deterministic provider name", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const target = item("remote-reconciled", "Active");
  target.name = snapshotAssetName("目标素材", assetId);
  const pages = [page([target], 1, 1)];
  const result = await adapterWithPages(pages).readbackByName({ assetId, name: "目标素材" });
  assert.equal(result.status, "active");
  assert.equal(result.registrationId, "remote-reconciled", "按名回读必须绑定远端素材 ID");
});

test("register maps provider failures without claiming a remote id", async () => {
  const registry: Pick<VolcAssetRegistryPort, "createAsset"> = {
    async createAsset() {
      throw new VolcAssetRegistryOperationError({
        errorCode: "ASSET_REGISTRY_REJECTED",
        errorMessage: "内容不合规",
        requestId: "req-y",
        httpStatus: 400,
      }, false);
    },
  };
  const adapter = new VolcSnapshotRegistrationAdapter(registry as VolcAssetRegistryPort, { assetGroupId: "group-309", projectName: "shortdrama" });
  const result = await adapter.register({ assetId: "11111111-1111-4111-8111-111111111111", mediaUrl: "https://example.test/a.png", mediaSha256: "a".repeat(64), name: "素材" });
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "ASSET_REGISTRY_REJECTED");
  assert.equal(result.registrationId, null);
});

test("snapshot asset names stay deterministic and provider-safe", () => {
  assert.equal(
    snapshotAssetName("雨夜街道 https://evil.example/x.png\n控制符\u0007", "11111111-1111-4111-8111-111111111111"),
    "雨夜街道 参考素材 控制符 [11111111]",
  );
  assert.ok([...snapshotAssetName("x".repeat(200), "abcd")].length <= 64);
});
