/* ============================================================
   lite-shot-asset-picker-dialog.test.ts — 分镜详情「匹配+选择」资产弹窗测试
   （2026-08-18 弹窗裁定；见 lite-shot-detail-page.test.ts 源码口径与
   docs/design/prd-v2/lite-assets-page.md 问题八 8.8/8.9 匹配合同）。
   覆盖（纯逻辑，无 DOM 渲染）：
   - pickerKey：变体键 assetId::variantId / 资产级 assetId::asset；
   - isLinked：已关联键集精确匹配（含资产级）；
   - groupPickerKeysByAsset：按资产分组写入 items，资产级不传 variant_id，全部带
     shot_id——即弹窗确认走 POST .../usages 批量路径的请求体形状；
   - splitPickerKey：拆键为 (assetId, variantKey)（弹窗取消/usage 解析用）；
   - splitPickerChanges：selected − linkedKeys = toAdd，linkedKeys − selected =
     toRemove——双向编辑差异合同（2026-08-19 用户裁定：已关联默认勾选、取消即移除）；
   - pickerKeyLabel：已选清单展示名（资产名 + 变体名）。
   弹窗组件本体（渲染/交互）由真栈人工走查，本文件只锁「写合同」的纯函数形状。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

/* happy-dom 先落地全局，再动态 import（同 lite-shot-detail-page.test.ts 基建纪律）。 */
const happyWindow = new Window({ url: "http://localhost/" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const {
  groupPickerKeysByAsset,
  isLinked,
  pickerKey,
  pickerKeyLabel,
  splitPickerChanges,
  splitPickerKey,
} = await import("./pages/lite/lite-shot-asset-picker-dialog");

test("pickerKey：变体键 = assetId::variantId；无变体资产 = assetId::asset", () => {
  assert.equal(pickerKey("a1", "v1"), "a1::v1");
  assert.equal(pickerKey("a1", null), "a1::asset");
});

test("isLinked：已关联键集精确匹配（含资产级）", () => {
  const linked = new Set(["a1::v1", "a2::asset"]);
  assert.equal(isLinked(linked, "a1", "v1"), true);
  assert.equal(isLinked(linked, "a1", null), false, "资产级键不与同资产变体键混同");
  assert.equal(isLinked(linked, "a2", null), true);
  assert.equal(isLinked(linked, "a2", "v9"), false, "资产级关联不等于任一变体关联");
});

test("groupPickerKeysByAsset：按资产分组，资产级不传 variant_id，全部带 shot_id", () => {
  const byAsset = groupPickerKeysByAsset(new Set(["a1::v1", "a1::v2", "a2::asset"]), "shot-1");
  assert.deepEqual([...byAsset.keys()], ["a1", "a2"]);
  assert.deepEqual(byAsset.get("a1"), [
    { shot_id: "shot-1", variant_id: "v1" },
    { shot_id: "shot-1", variant_id: "v2" },
  ]);
  assert.deepEqual(byAsset.get("a2"), [{ shot_id: "shot-1" }], "资产级关联不带 variant_id");
});

test("groupPickerKeysByAsset：空选择 → 空分组；坏键跳过", () => {
  assert.equal(groupPickerKeysByAsset(new Set(), "shot-1").size, 0);
  assert.equal(groupPickerKeysByAsset(new Set(["bad-key-without-sep", "a3::asset"]), "shot-1").size, 1);
});

test("splitPickerKey：拆键为 (assetId, variantKey)；坏键回退资产级", () => {
  assert.deepEqual(splitPickerKey("a1::v1"), { assetId: "a1", variantKey: "v1" });
  assert.deepEqual(splitPickerKey("a2::asset"), { assetId: "a2", variantKey: "asset" });
  assert.deepEqual(splitPickerKey("bad-key-without-sep"), { assetId: "bad-key-without-sep", variantKey: "asset" });
});

test("splitPickerChanges：selected−linked=新增，linked−selected=取消", () => {
  const linked = new Set(["a1::v1", "a2::asset"]);
  /* 只新增：取消勾掉 a1::v1、新增 a1::v2、保留 a2::asset。 */
  assert.deepEqual(splitPickerChanges(new Set(["a1::v2", "a2::asset"]), linked), {
    toAdd: ["a1::v2"],
    toRemove: ["a1::v1"],
  });
});

test("splitPickerChanges：无差异 → 全空（确认按钮据此禁用）", () => {
  const linked = new Set(["a1::v1"]);
  assert.deepEqual(splitPickerChanges(new Set(["a1::v1"]), linked), { toAdd: [], toRemove: [] });
  assert.deepEqual(splitPickerChanges(new Set(), new Set()), { toAdd: [], toRemove: [] });
});

test("splitPickerChanges：全部取消 → 全部进 toRemove", () => {
  const linked = new Set(["a1::v1", "a1::v2"]);
  assert.deepEqual(splitPickerChanges(new Set(), linked), { toAdd: [], toRemove: ["a1::v1", "a1::v2"] });
});

test("pickerKeyLabel：已选清单展示名（资产名 + 变体名；资产级与未知回退）", () => {
  const assets = [{
    asset_entity_id: "a1",
    name: "男主",
    intro: null,
    asset_kind: "character",
    audio_kind: null,
    primary_media_url: null,
    has_media: false,
    has_primary: false,
    has_pending_generation: false,
    last_modified_at: "2026-08-18T00:00:00Z",
  }];
  const variants = { a1: [{ variant_id: "v1", display_name: "现代装", variant_kind: "character", is_primary: true }] };
  assert.equal(pickerKeyLabel("a1::v1", assets, variants), "男主 · 现代装");
  assert.equal(pickerKeyLabel("a1::asset", assets, variants), "男主");
  assert.equal(pickerKeyLabel("a9::v1", assets, variants), "未命名资产", "未知资产回退占位");
});
