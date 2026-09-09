import assert from "node:assert/strict";
import test from "node:test";
import {
  isDirectAssetUsableForGeneration,
  isProjectAssetReferenceCompatible,
  providerReferenceUrl,
} from "./repository.js";

test("Seedance 只按 CreateAsset 登记路由:注册参考走 asset://,未登记 fail-closed", () => {
  assert.equal(
    providerReferenceUrl("https://tos.example.test/reference.png", "reference", "Asset-registered", true),
    "asset://Asset-registered",
  );
  assert.throws(
    () => providerReferenceUrl("https://tos.example.test/reference.png", "reference", null, true),
    /请先点击“转为参考资产”/,
  );
  assert.throws(
    () => providerReferenceUrl("https://tos.example.test/first.png", "first_frame", null, true),
    /请先点击“转为参考资产”/,
  );
  assert.equal(
    providerReferenceUrl("https://tos.example.test/first.png", "first_frame", "Asset-registered", true),
    "https://tos.example.test/first.png",
  );
  assert.equal(
    providerReferenceUrl("https://tos.example.test/reference.png", "reference", "Asset-registered"),
    "https://tos.example.test/reference.png",
  );
});

test("Seedance 素材准入按 PostgreSQL 分类给出公开中文指引", () => {
  const storageUrl = "https://tos.example.test/reference.png";

  assert.throws(
    () => providerReferenceUrl(storageUrl, "reference", null, true, "verification_expired"),
    /登记核验已过期，请刷新登记/,
  );
  assert.throws(
    () => providerReferenceUrl(storageUrl, "reference", null, true, "authorization_expired"),
    /登记授权已过期，请重新登记或联系管理员协助/,
  );
  assert.throws(
    () => providerReferenceUrl(storageUrl, "reference", null, true, "different_media_version_registered"),
    /当前选中的图片版本尚未登记，请选择已登记的版本或登记当前版本/,
  );
  assert.throws(
    () => providerReferenceUrl(storageUrl, "reference", null, true, "provider_asset_id_mismatch"),
    /登记已失效或远端素材编号已变化，请刷新后重新提交/,
  );
  assert.throws(
    () => providerReferenceUrl(storageUrl, "reference", null, true, "unregistered"),
    /请先点击“转为参考资产”/,
  );
});

test("项目成员只能把项目引用锁定的个人资产媒体传给生成链", () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const otherMediaId = "22222222-2222-4222-8222-222222222222";
  const variantId = "33333333-3333-4333-8333-333333333333";

  assert.equal(
    isProjectAssetReferenceCompatible({ assetMediaId: mediaId, assetVariantId: null }, { id: mediaId, assetVariantId: null }),
    true,
  );
  assert.equal(
    isProjectAssetReferenceCompatible({ assetMediaId: mediaId, assetVariantId: null }, { id: otherMediaId, assetVariantId: null }),
    false,
  );
  assert.equal(
    isProjectAssetReferenceCompatible({ assetMediaId: null, assetVariantId: variantId }, { id: mediaId, assetVariantId: variantId }),
    true,
  );
  assert.equal(
    isProjectAssetReferenceCompatible({ assetMediaId: null, assetVariantId: variantId }, { id: mediaId, assetVariantId: null }),
    false,
  );
  assert.equal(isProjectAssetReferenceCompatible(undefined, { id: mediaId, assetVariantId: null }), false);
});

test("分镜生成只直接使用已过审通用资产或本人个人资产", () => {
  const actorId = "11111111-1111-4111-8111-111111111111";
  assert.equal(isDirectAssetUsableForGeneration({
    visibility: "common",
    status: "approved",
    ownerUserId: null,
  }, actorId), true);
  assert.equal(isDirectAssetUsableForGeneration({
    visibility: "common",
    status: "pending_review",
    ownerUserId: null,
  }, actorId), false);
  assert.equal(isDirectAssetUsableForGeneration({
    visibility: "personal",
    status: "approved",
    ownerUserId: actorId,
  }, actorId), true);
});
