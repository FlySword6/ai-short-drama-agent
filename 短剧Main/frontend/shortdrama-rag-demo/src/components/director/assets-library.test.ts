/**
 * 3D 导演台 · 资产库纯逻辑测试（3D 过滤 / kind 分组 / 搜索 / 中文映射 / fixture 自检）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BUILTIN_ASSET_DISPLAY_NAMES } from "./asset-display-names";
import {
  ASSET_KIND_LABELS,
  BUILTIN_ASSETS,
  DIRECTOR_ASSET_KINDS,
  assetDisplayName,
  assetGlbUrl,
  fetchDirector3dAssets,
  filterAssetsByQuery,
  groupAssetsByKind,
  humanModelLoadError,
  isDirector3dAsset,
} from "./assets-library";
import type { Asset } from "../../types";
import { newId } from "../../uuid";

function makeAsset(patch: Partial<Asset>): Asset {
  return { id: newId(), ...patch };
}

test("assetGlbUrl：GLB 媒体优先（selected 先于 current），format 大小写不敏感", () => {
  const asset = makeAsset({
    asset_kind: "prop",
    storage_url: "https://cdn.example.com/fallback.glb",
    selected_media: { id: "m1", format: "GLB", storage_url: "https://cdn.example.com/a.glb" },
    current_media: { id: "m2", media_kind: "model_3d", storage_url: "https://cdn.example.com/b.glb" },
  });
  assert.equal(assetGlbUrl(asset), "https://cdn.example.com/a.glb");

  // selected 非 GLB → 落 current 的 model_3d
  const noSelected = makeAsset({
    asset_kind: "prop",
    selected_media: { id: "m1", format: "png", storage_url: "https://cdn.example.com/a.png" },
    current_media: { id: "m2", media_kind: "model_3d", storage_url: "https://cdn.example.com/b.glb" },
  });
  assert.equal(assetGlbUrl(noSelected), "https://cdn.example.com/b.glb");
});

test("assetGlbUrl：无 GLB 媒体时兜底 .glb 结尾 storage_url（带查询串也认）；非 3D 返回 null", () => {
  assert.equal(
    assetGlbUrl(makeAsset({ storage_url: "https://cdn.example.com/chair.glb?x-oss=1" })),
    "https://cdn.example.com/chair.glb?x-oss=1",
  );
  assert.equal(assetGlbUrl(makeAsset({ storage_url: "https://cdn.example.com/photo.jpg" })), null);
  assert.equal(
    assetGlbUrl(
      makeAsset({
        current_media: { id: "m1", format: "png", storage_url: "https://cdn.example.com/a.png" },
      }),
    ),
    null,
  );
  assert.equal(assetGlbUrl(makeAsset({})), null);
});

test("isDirector3dAsset：类目白名单 + GLB 直链双条件", () => {
  const glb = { storage_url: "https://cdn.example.com/a.glb" };
  for (const kind of DIRECTOR_ASSET_KINDS) {
    assert.equal(isDirector3dAsset(makeAsset({ asset_kind: kind, ...glb })), true, kind);
  }
  // 白名单外类目 / 缺类目 / 无 GLB 都不入台
  assert.equal(isDirector3dAsset(makeAsset({ asset_kind: "texture", ...glb })), false);
  assert.equal(isDirector3dAsset(makeAsset({ ...glb })), false);
  assert.equal(
    isDirector3dAsset(makeAsset({ asset_kind: "prop", storage_url: "https://cdn.example.com/a.png" })),
    false,
  );
});

test("groupAssetsByKind：固定 5 组顺序与计数；白名单外类目不进组", () => {
  const assets = [
    makeAsset({ asset_kind: "prop", name: "椅子", storage_url: "https://cdn.example.com/a.glb" }),
    makeAsset({ asset_kind: "character", name: "男主", storage_url: "https://cdn.example.com/b.glb" }),
    makeAsset({ asset_kind: "prop", name: "桌子", storage_url: "https://cdn.example.com/c.glb" }),
    makeAsset({ asset_kind: "texture", name: "贴图", storage_url: "https://cdn.example.com/d.glb" }),
  ];
  const groups = groupAssetsByKind(assets);
  assert.deepEqual(
    groups.map((group) => group.kind),
    [...DIRECTOR_ASSET_KINDS],
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    DIRECTOR_ASSET_KINDS.map((kind) => ASSET_KIND_LABELS[kind]),
  );
  const countOf = (kind: string) => groups.find((group) => group.kind === kind)?.items.length;
  assert.equal(countOf("character"), 1);
  assert.equal(countOf("prop"), 2);
  assert.equal(countOf("scene"), 0);
  assert.equal(countOf("clothing"), 0);
  assert.equal(countOf("other"), 0);
  // 白名单外类目不进任何组
  assert.equal(groups.reduce((sum, group) => sum + group.items.length, 0), 3);
});

test("filterAssetsByQuery：名称大小写不敏感子串；空串/纯空白原样返回", () => {
  const assets = [
    makeAsset({ name: "Building A" }),
    makeAsset({ name: "building Type B" }),
    makeAsset({ name: "苹果" }),
    makeAsset({ display_name: "救护车" }), // name 缺失回落 display_name
  ];
  assert.equal(filterAssetsByQuery(assets, "building").length, 2);
  assert.equal(filterAssetsByQuery(assets, "BUILDING").length, 2);
  assert.equal(filterAssetsByQuery(assets, " 苹 ").length, 1);
  assert.equal(filterAssetsByQuery(assets, "救护").length, 1);
  assert.equal(filterAssetsByQuery(assets, "").length, 4);
  assert.equal(filterAssetsByQuery(assets, "   ").length, 4);
  assert.equal(filterAssetsByQuery(assets, "不存在的资产").length, 0);
});

test("assetDisplayName：name → display_name → intro → 占位", () => {
  assert.equal(assetDisplayName(makeAsset({ name: "  椅子  " })), "椅子");
  assert.equal(assetDisplayName(makeAsset({ name: " ", display_name: "展示名" })), "展示名");
  assert.equal(assetDisplayName(makeAsset({ intro: "简介" })), "简介");
  assert.equal(assetDisplayName(makeAsset({})), "未命名资产");
});

test("内置资产中文名映射（P1-10）：覆盖全部 BUILTIN_ASSETS，assetDisplayName 返回中文名", () => {
  // 映射键集合与内置资产 id 一一对应（不多不漏，新增内置资产漏登记即红）
  assert.deepEqual(
    Object.keys(BUILTIN_ASSET_DISPLAY_NAMES).sort(),
    BUILTIN_ASSETS.map((asset) => asset.id).sort(),
  );
  for (const asset of BUILTIN_ASSETS) {
    const mapped = BUILTIN_ASSET_DISPLAY_NAMES[asset.id];
    assert.ok(mapped, `${asset.id} 缺中文名映射`);
    assert.ok(/\p{Script=Han}/u.test(mapped), `${asset.id} 映射名应含中文：${mapped}`);
    // 映射优先于英文 name（Female Looking Up → 仰望的女性）
    assert.equal(assetDisplayName(asset), mapped, asset.id);
    // 原始英文名仍留在 asset.name 上（列表 title / 属性面板来源区回显用）
    assert.ok(asset.name && asset.name !== mapped, `${asset.id} 原名未保留`);
  }
});

test("filterAssetsByQuery：内置资产中文名与英文原名都可检索", () => {
  assert.equal(filterAssetsByQuery(BUILTIN_ASSETS, "仰望").length, 1);
  assert.equal(filterAssetsByQuery(BUILTIN_ASSETS, "female").length, 1);
  assert.equal(filterAssetsByQuery(BUILTIN_ASSETS, "苹果").length, 1);
  assert.equal(filterAssetsByQuery(BUILTIN_ASSETS, "Apple").length, 1);
  assert.equal(filterAssetsByQuery(BUILTIN_ASSETS, "救护车").length, 1);
});

test("UI 合同（P1-10）：资产列表以 assetDisplayName 渲染中文名，title 回显原始英文名", () => {
  const source = readFileSync(new URL("./ui/AssetsPanel.tsx", import.meta.url), "utf8");
  // 条目名只能走 assetDisplayName（中文映射唯一入口），不许直读 asset.name
  assert.ok(source.includes("assetDisplayName(asset)"), "列表条目名未走 assetDisplayName");
  assert.ok(source.includes("ds-assets__item-name"));
  // title 保留原名可见：intro 优先，回落 asset.name（英文原名）
  assert.ok(source.includes("asset.intro ?? asset.name ?? name"), "列表 title 未回显原始名");
});

test("UI 合同（P1-10）：对象清单模型行 title 回显原始文件名", () => {
  const source = readFileSync(new URL("./ui/ObjectListPanel.tsx", import.meta.url), "utf8");
  assert.ok(
    source.includes('`${object.fileName} · 双击重命名`'),
    "模型行 title 未带原始文件名",
  );
});

test("BUILTIN_ASSETS fixture 自检：全部通过 3D 过滤且覆盖角色/场景/道具", () => {
  assert.ok(BUILTIN_ASSETS.length >= 3);
  for (const asset of BUILTIN_ASSETS) {
    assert.equal(isDirector3dAsset(asset), true, asset.id);
    assert.ok(assetGlbUrl(asset)?.startsWith("https://"), asset.id);
  }
  const kinds = new Set(BUILTIN_ASSETS.map((asset) => asset.asset_kind));
  assert.ok(kinds.has("character"));
  assert.ok(kinds.has("scene"));
  assert.ok(kinds.has("prop"));
  // 分组结构与线上数据同构
  const groups = groupAssetsByKind(BUILTIN_ASSETS);
  assert.equal(groups.length, DIRECTOR_ASSET_KINDS.length);
});

test("humanModelLoadError：404/网络/解析/兜底四类人话", () => {
  assert.equal(humanModelLoadError(new Error("fetch for '…' responded with 404")), "模型文件不存在或已下架");
  assert.equal(humanModelLoadError(new TypeError("Failed to fetch")), "网络异常，模型下载失败");
  assert.equal(humanModelLoadError(new Error("Unexpected token in JSON")), "模型文件损坏，无法解析");
  assert.equal(humanModelLoadError(new Error("weird loader crash")), "模型加载失败，请重试");
  assert.equal(humanModelLoadError("404"), "模型文件不存在或已下架");
});

test("fetchDirector3dAssets（W7-C）：按 kind 三拉合并去重，三类计数合计=后端总条数", async () => {
  const glb = (id: string, kind: string): Asset => ({
    id,
    asset_kind: kind,
    name: id,
    current_media: { id: `m-${id}`, media_kind: "model_3d", format: "glb", storage_url: `https://x/${id}.glb` },
  });
  const image2d = (id: string, kind: string): Asset => ({
    id,
    asset_kind: kind,
    name: id,
    current_media: { id: `m-${id}`, media_kind: "image", format: "jpg", storage_url: `https://x/${id}.jpg` },
  });
  const backend: Record<string, Asset[]> = {
    prop: [glb("p1", "prop"), glb("p2", "prop"), image2d("p-img", "prop")],
    scene: [glb("s1", "scene"), glb("p1", "prop")], // p1 重复出现（跨类同 id 干扰项）
    character: [glb("c1", "character"), image2d("c-img", "character")],
  };
  const asked: string[] = [];
  const result = await fetchDirector3dAssets(async (kind) => {
    asked.push(kind);
    const items = backend[kind] ?? [];
    return { items, count: items.length };
  });
  // 三类都拉到（顺序即 DIRECTOR_FETCH_KINDS）
  assert.deepEqual(asked, ["prop", "scene", "character"]);
  // 三类计数合计 = 后端总条数（2+3+2=7，含 2D 与重复 id）
  assert.equal((result.counts.prop ?? 0) + (result.counts.scene ?? 0) + (result.counts.character ?? 0), 7);
  // 可见 3D 资产 = 去重 + 3D 过滤（p1/p2/s1/c1 四件；2D 出局，重复 id 合并）
  assert.deepEqual(result.assets.map((asset) => asset.id).sort(), ["c1", "p1", "p2", "s1"]);
});
