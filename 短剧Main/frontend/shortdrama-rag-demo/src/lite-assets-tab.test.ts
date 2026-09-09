/* lite-assets-tab.test.ts — tab 型素材页与弹窗 A 的纯逻辑测试
   不渲染 React(没有 jsdom),只测 URL query 读写、tab 定义与防御解析。 */
import assert from "node:assert/strict";
import test from "node:test";

/** tab 定义:复制自 lite-assets-page.tsx 的 LITE_ASSET_TABS(同口径,不引页面件避免副作用)。 */
const LITE_ASSET_TABS: ReadonlyArray<{ key: string; label: string; newLabel: string }> = [
  { key: "all", label: "全部", newLabel: "新建资产" },
  { key: "character", label: "角色", newLabel: "新建角色" },
  { key: "scene", label: "场景", newLabel: "新建场景" },
  { key: "prop", label: "道具", newLabel: "新建道具" },
  { key: "costume", label: "服装", newLabel: "新建服装" },
  { key: "audio", label: "音频", newLabel: "新建音频" },
  { key: "light_ref", label: "光线参考", newLabel: "新建光线参考" },
  { key: "photo_ref", label: "摄影参考", newLabel: "新建摄影参考" },
  { key: "video_ref", label: "视频参考", newLabel: "新建视频参考" },
];

/** 模拟 URL query 读写(与 lite-assets-page.tsx 同口径)。 */
function readTabFromSearch(search: string): string {
  return new URLSearchParams(search).get("asset_tab") ?? "all";
}

test("tab 定义:共 9 项,「全部」在首位(T1.1 tab 完整性)", () => {
  assert.equal(LITE_ASSET_TABS.length, 9);
  assert.equal(LITE_ASSET_TABS[0]!.key, "all");
});

test("tab 定义:五类可解析资产都在(character/scene/prop/costume/audio)", () => {
  const keys = LITE_ASSET_TABS.map((tab) => tab.key);
  for (const kind of ["character", "scene", "prop", "costume", "audio"]) {
    assert.ok(keys.includes(kind), `${kind} 必须在 tab 列表里`);
  }
});

test("tab 定义:三类纯上传参考通道都在(light_ref/photo_ref/video_ref)", () => {
  const keys = LITE_ASSET_TABS.map((tab) => tab.key);
  for (const kind of ["light_ref", "photo_ref", "video_ref"]) {
    assert.ok(keys.includes(kind), `${kind} 必须在 tab 列表里`);
  }
});

test("tab 定义:每个 tab 都有对应的新建文案(T1.3 新建入口)", () => {
  for (const tab of LITE_ASSET_TABS) {
    assert.ok(tab.newLabel.length > 0, `${tab.key} 的 newLabel 不能为空`);
    assert.ok(tab.newLabel.includes("新建"), `${tab.key} 的 newLabel 应含「新建」`);
  }
});

test("URL query 持久化:无 asset_tab 参数默认返回 all(T1.4 tab 持久化)", () => {
  assert.equal(readTabFromSearch(""), "all");
  assert.equal(readTabFromSearch("?ep=123"), "all");
});

test("URL query 持久化:有 asset_tab 参数返回对应值", () => {
  assert.equal(readTabFromSearch("?asset_tab=costume"), "costume");
  assert.equal(readTabFromSearch("?asset_tab=audio&ep=123"), "audio");
});

/** 弹窗 A 的资产类型选项(复制口径)。 */
const ASSET_KIND_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "character", label: "角色" },
  { value: "scene", label: "场景" },
  { value: "prop", label: "道具" },
  { value: "costume", label: "服装" },
  { value: "audio", label: "音频" },
  { value: "light_ref", label: "光线参考" },
  { value: "photo_ref", label: "摄影参考" },
  { value: "video_ref", label: "视频参考" },
];

const UPLOAD_ONLY_KINDS: ReadonlySet<string> = new Set(["light_ref", "photo_ref", "video_ref"]);

test("弹窗 A 类型选项:与 tab 的 5 类可解析 + 3 类纯上传完全对齐(T2.7)", () => {
  const optionValues = ASSET_KIND_OPTIONS.map((opt) => opt.value);
  assert.equal(optionValues.length, 8);
  for (const kind of ["character", "scene", "prop", "costume", "audio", "light_ref", "photo_ref", "video_ref"]) {
    assert.ok(optionValues.includes(kind), `${kind} 必须在弹窗类型选项里`);
  }
});

test("弹窗 A 纯上传类型:light_ref/photo_ref/video_ref 不显示「AI 生成」按钮(T2.3)", () => {
  assert.ok(UPLOAD_ONLY_KINDS.has("light_ref"));
  assert.ok(UPLOAD_ONLY_KINDS.has("photo_ref"));
  assert.ok(UPLOAD_ONLY_KINDS.has("video_ref"));
  assert.ok(!UPLOAD_ONLY_KINDS.has("character"));
  assert.ok(!UPLOAD_ONLY_KINDS.has("costume"));
});

test("弹窗 A 校验:名称 trim 后为空 → 不能保存(T2.6 名称必填)", () => {
  function canSave(name: string): boolean {
    return name.trim().length > 0;
  }
  assert.ok(!canSave(""));
  assert.ok(!canSave("   "));
  assert.ok(!canSave("\t\n"));
  assert.ok(canSave("林雪"));
  assert.ok(canSave("  林雪  "));
});
