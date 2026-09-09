import assert from "node:assert/strict";
import test from "node:test";
import {
  canManageAsset,
  canReferenceAsset,
  canViewAsset,
  permanentDeletionBlockers,
  type AssetAccessRecord,
} from "./access.js";

function asset(input: Partial<AssetAccessRecord> = {}): AssetAccessRecord {
  return {
    id: "asset-1",
    ownerUserId: "user-a",
    visibility: "personal",
    status: "approved",
    deletedAt: null,
    ...input,
  };
}

test("个人资产只对所有者可见和可管理", () => {
  assert.equal(canViewAsset(asset(), "user-a"), true);
  assert.equal(canViewAsset(asset(), "user-b"), false);
  assert.equal(canManageAsset(asset(), "user-a"), true);
  assert.equal(canManageAsset(asset(), "user-b"), false);
});

test("只有已过审通用资产对普通用户可见和可引用", () => {
  const common = asset({ ownerUserId: null, visibility: "common" });
  assert.equal(canViewAsset(common, "user-b"), true);
  assert.equal(canReferenceAsset(common, "user-b"), true);
  assert.equal(canManageAsset(common, "user-b"), false);

  const pending = asset({ ownerUserId: null, visibility: "common", status: "pending_review" });
  assert.equal(canViewAsset(pending, "user-b"), false);
  assert.equal(canReferenceAsset(pending, "user-b"), false);
  assert.equal(canViewAsset(pending, "admin-user", false, true), true);
});

test("回收站资产默认不可见也不可引用", () => {
  const deleted = asset({ deletedAt: new Date() });
  assert.equal(canViewAsset(deleted, "user-a"), false);
  assert.equal(canViewAsset(deleted, "user-a", true), true);
  assert.equal(canReferenceAsset(deleted, "user-a"), false);
});

test("永久删除列出全部业务引用阻止原因", () => {
  assert.deepEqual(permanentDeletionBlockers({
    activeProjectReferences: 2,
    activeShotReferences: 1,
    selectedMediaReferences: 1,
    deliveryReferences: 1,
  }), ["仍被项目引用", "仍被分镜引用", "仍是分镜主版本", "仍在交付记录中"]);
});
