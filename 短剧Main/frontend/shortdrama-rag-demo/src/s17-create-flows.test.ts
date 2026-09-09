/* ============================================================
   s17-create-flows.test.ts — S17-B 新建人设/资产流（DC「都有问题」复现修复）

   根因两条（实证）：
   ① 后端入库「先提交后补索引」——索引失败（embedding 未配置）接口报 500
      但资产已建，用户看到假失败重试建重；② 项目内创建只进个人库、产物不回家
      （用户在本剧资产里找不到刚建的人设）。
   修复：韧性入库（报错前回查）+ 写职责 + 创建即加入本剧资产（后端接受无媒体
   引用，实证 201）+ 表单引导「成功后去哪」。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ingestAssetVerified, roleForAssetKind } from "./components/asset-shared";
import type { Asset } from "./types";

const apiSource = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
const projectPages = readFileSync(new URL("./pages/project-pages.tsx", import.meta.url), "utf8");
const globalPages = readFileSync(new URL("./pages/global-pages.tsx", import.meta.url), "utf8");

function assetOf(name: string, id = `id-${name}`): Asset {
  return { id, name, asset_kind: "character" } as Asset;
}

describe("ingestAssetVerified 韧性入库", () => {
  const item = { asset_kind: "character", name: "任天野" };

  it("正常成功：返回入库响应 id，indexed=true", async () => {
    const result = await ingestAssetVerified(item, {
      ingest: async () => ({ items: [{ id: "new-1" }] }),
      lookup: async () => [],
    });
    assert.deepEqual(result, { assetId: "new-1", indexed: true });
  });

  it("假 500（提交后索引失败）：回查命中=已建，indexed=false，不报假失败", async () => {
    const result = await ingestAssetVerified(item, {
      ingest: async () => {
        throw new Error("Doubao embedding: Missing ARK_API_KEY");
      },
      lookup: async () => [assetOf("任天野", "committed-1")],
    });
    assert.deepEqual(result, { assetId: "committed-1", indexed: false });
  });

  it("真失败（回查无此资产）：原始错误照常抛出，不假装成功", async () => {
    const failure = new Error("网络断开");
    await assert.rejects(
      () => ingestAssetVerified(item, {
        ingest: async () => {
          throw failure;
        },
        lookup: async () => [assetOf("别人")],
      }),
      (reason: unknown) => reason === failure,
    );
  });

  it("回查本身失败（列表也挂了）：按原始入库错误抛出", async () => {
    const failure = new Error("Doubao embedding: Missing ARK_API_KEY");
    await assert.rejects(
      () => ingestAssetVerified(item, {
        ingest: async () => {
          throw failure;
        },
        lookup: async () => {
          throw new Error("list down");
        },
      }),
      (reason: unknown) => reason === failure,
    );
  });
});

describe("roleForAssetKind 类型→职责", () => {
  it("角色/场景/道具/光影/摄影映射；未知 kind 给 undefined", () => {
    assert.equal(roleForAssetKind("character"), "character_identity");
    assert.equal(roleForAssetKind("scene"), "scene");
    assert.equal(roleForAssetKind("prop"), "prop");
    assert.equal(roleForAssetKind("lighting"), "style_env");
    assert.equal(roleForAssetKind("camera"), "camera_storyboard");
    assert.equal(roleForAssetKind("video"), undefined);
  });
});

describe("页面接线（源码断言）", () => {
  it("addProjectAsset 媒体可空（空资产建档可直接回家），不再人工拦截", () => {
    assert.ok(!apiSource.includes("asset_media_required"), "旧拦截残留");
    assert.ok(apiSource.includes("assetMediaId?.trim()"), "未按可空发送");
  });

  it("项目内创建入口：韧性入库+写职责+创建即加入本剧资产（S17-C 去重后只此一处）", () => {
    const start = projectPages.indexOf("function createKindAsset");
    const slice = projectPages.slice(start, start + 1800);
    assert.ok(slice.includes("ingestAssetVerified"), "createKindAsset 未接韧性入库");
    assert.ok(slice.includes("roleForAssetKind"), "createKindAsset 未写职责");
    assert.ok(slice.includes("api.addProjectAsset(projectId, assetId)"), "createKindAsset 未接产物回家");
    assert.ok(slice.includes("加入项目失败"), "createKindAsset 缺部分失败诚实提示");
    assert.ok(projectPages.includes("创建后加入本剧资产"), "弹窗缺闭环引导");
    /* S17-C：详情页「新建人设」重复入口撤下——创建归列表页一处，不再两处表达 */
    assert.ok(!projectPages.includes("createPersona"), "详情页重复创建入口残留");
    assert.ok(projectPages.includes("去生产页使用"), "资产详情缺下一步去路");
  });

  it("资产中心建档：韧性入库+刷新不冒充创建失败", () => {
    assert.ok(globalPages.includes("ingestAssetVerified"), "建档未接韧性入库");
    const createStart = globalPages.indexOf("async function createBlankAsset");
    // K2（N1）起函数内含 demo 本地回显分支变长：切片到下一个声明为止，不再用定长窗口
    const createEnd = globalPages.indexOf("const [uploading", createStart);
    const slice = globalPages.slice(createStart, createEnd > createStart ? createEnd : createStart + 1500);
    const finallyIndex = slice.indexOf("setCreatingAsset(false)");
    const retryIndex = slice.indexOf("retry()");
    assert.ok(finallyIndex > 0 && retryIndex > finallyIndex, "retry 应在 try/catch 之外（刷新失败不冒充创建失败）");
  });
});
