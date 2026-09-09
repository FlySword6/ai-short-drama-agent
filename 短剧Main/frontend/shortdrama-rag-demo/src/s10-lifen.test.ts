/* ============================================================
   s10-lifen.test.ts — S10 丽芬批次五件 + 裁决 2 源码级验收断言（D 线）
   D1 回收站独立页：被删项目/个人资产/项目内单删三分组，还原回原位，
      显著提示自动清理即将上线（K2-B 止血：TTL 未实现，不写天数）；项目内单删（集/场景/分镜）后端 V0.1 不回收不恢复
      （src/modules/trash repository.assertSupportedKind 仅 project+asset），如实说明不造假按钮。
   D2 素材详情补上下文：项目资产详情页（AssetDetailPage）补所属项目（真 GET /projects/:id）+
      版本/变体计数 + 版本备注（version.description 真字段）；集/分镜/场景使用明细
      接口未回传（toAssetData 无绑定 / Shot 无资产清单 / generationData 不含 shotId 与
      reference_asset_snapshots），诚实缺口行，不编造。
   D3 命名区分：项目内资产页「项目资产」改「本剧资产」+「去资产中心」互链；
      资产中心留位「项目使用情况，功能上线后展示」（不摆空假表；S46 B-3 改用户语言）。
   D4 文件夹式浏览：资产中心列表/树状两视图并存，树状按类型分组且消费同一份
      filtered（标签/搜索/审核筛选不被取代）。
   D5 项目信息可编辑：项目卡加「编辑项目信息」，走真 PATCH /api/v1/projects/:project_id
      （后端 routes.ts updateProjectSchema 既有 name/description）。
   裁决 2：项目列表「已完成」tab 摘除（后端 status 仅 active/archived，completed 桶恒空）；
      逻辑层在他线文件 batch-generate-drawer.tsx（ProjectFilterTab 类型合同不动），
      completed→桶 死值映射由死值清理线按裁决另行收敛，与本线同向。
   主体为 readSource 源码断言；D4d 起引入真渲染行为断言（AssetKindTreeView 经
   renderToStaticMarkup 渲染，import 链不引 CSS，与 asset-center.test.ts 同口径）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetKindTreeView } from "./pages/global-pages";
import type { Asset } from "./types";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const operationsPages = readSource("./pages/operations-pages.tsx");
const projectPages = readSource("./pages/project-pages.tsx");
const globalPages = readSource("./pages/global-pages.tsx");
const batchDrawer = readSource("./pages/batch-generate-drawer.tsx");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ---------- D1：回收站三分组 + 自动清理提示 + 项目内单删诚实说明 ---------- */

test("D1a：回收站显著提示「保留 180 天后自动彻底删除」真话口径(TTL 已由 S 主线交付)", () => {
  assert.ok(operationsPages.includes("移入回收站的内容保留 180 天，之后自动彻底删除。"), "缺 180 天保留期显著提示");
  assert.ok(operationsPages.includes('role="note"'), "提示行缺 role=note 语义");
  assert.ok(operationsPages.includes("删除的项目和个人资产会出现在这里，保留 180 天后自动彻底删除。"), "空态缺 180 天诚实口径");
  assert.ok(!operationsPages.includes("自动清理功能即将上线"), "K2-B 止血期假承诺文案残留");
  assert.ok(!operationsPages.includes("到期自动清理"), "「到期自动清理」假承诺残留");
  assert.ok(!operationsPages.includes("保留 30 天"), "空态「保留 30 天」残留");
  // 用户可见两处载体的天数口径只允许 180(DC 2026-08-02 r150 卡;K2-B 止血期「不写天数」决策随 TTL 交付退役)
  for (const match of operationsPages.matchAll(/<span>[^<]*?(\d+)\s*天|description="[^"]*?(\d+)\s*天/g)) {
    assert.equal(match[1] ?? match[2], "180", "用户可见文案出现 180 以外的天数承诺");
  }
});

test("D1b：被删项目 / 个人资产 / 项目内单删三分组信息架构", () => {
  assert.ok(operationsPages.includes("TrashGroup"), "缺分组组件 TrashGroup");
  assert.equal(countOccurrences(operationsPages, "<TrashGroup"), 2, "只有被删项目/个人资产两组渲染真实条目");
  assert.ok(operationsPages.includes('title="被删项目"'), "缺被删项目组");
  assert.ok(operationsPages.includes('title="个人资产"'), "缺个人资产组");
  assert.ok(operationsPages.includes("项目内单删（集 / 场景 / 分镜）"), "缺项目内单删第三组");
  // 类型过滤行与三组同名（全部/被删项目/个人资产）
  assert.ok(operationsPages.includes('{ value: "project", label: "被删项目" }'), "过滤项未同步「被删项目」命名");
});

test("D1c：还原回原位——按钮「还原」+ 回原位提示 + 成功 toast", () => {
  assert.ok(operationsPages.includes(">还原</Button>"), "恢复按钮未改名「还原」");
  assert.ok(operationsPages.includes("还原后回到项目列表"), "缺项目还原去向提示");
  assert.ok(operationsPages.includes("还原后回到个人资产库"), "缺资产还原去向提示");
  assert.ok(operationsPages.includes("已还原回原位"), "缺还原成功 toast");
  assert.ok(operationsPages.includes("还原后回到原来的位置"), "页头说明未交代还原回原位");
});

test("D1d：项目内单删如实说明「暂不可恢复」，不给假恢复按钮（UIFIX2-B：「后续版本补齐」人话换代机器话）", () => {
  assert.ok(operationsPages.includes("删除后暂不可恢复"), "缺暂不可恢复说明");
  assert.ok(operationsPages.includes("恢复能力会在后续版本补齐"), "缺恢复能力后续补齐的承诺(UIFIX2-B 人话口径)");
  const noteStart = operationsPages.indexOf('aria-label="项目内单删说明"');
  assert.ok(noteStart > 0, "缺项目内单删说明区");
  const noteBlock = operationsPages.slice(noteStart, noteStart + 700);
  assert.ok(!noteBlock.includes("<button") && !noteBlock.includes("<Button"), "项目内单删说明区不允许出现按钮（禁止假恢复按钮）");
});

test("D1e：回收站分页兜底不漂移（S9-19 合同保持）", () => {
  assert.ok(operationsPages.includes("const TRASH_PAGE_SIZE = 12;"), "缺 TRASH_PAGE_SIZE");
  assert.ok(operationsPages.includes("paginateItems(items, safePage, TRASH_PAGE_SIZE)"), "回收站未切片");
  assert.ok(operationsPages.includes('itemNoun="项" ariaLabel="回收站分页" pageSize={TRASH_PAGE_SIZE}'), "回收站未接 ListPager");
  assert.ok(operationsPages.includes("useEffect(() => { setPage(1); }, [kind]);"), "类型切换未回第一页");
});

/* ---------- D2：素材详情补上下文 ---------- */

test("D2a：资产详情页补「上下文」卡——所属项目走真接口 + 版本/变体真实计数", () => {
  assert.ok(projectPages.includes('data-testid="asset-context-card"'), "缺上下文卡");
  assert.ok(projectPages.includes("所属项目：{detailProjectState.data.name}"), "所属项目未渲染");
  assert.ok(projectPages.includes("api.project(projectId)"), "所属项目未走真 GET /projects/:id");
  assert.ok(projectPages.includes("{versions.length} 个版本 · {allGroups.length} 个变体"), "缺版本/变体计数");
});

test("D2b：集/分镜/场景使用明细留位（S17 起用户语言，不编造绑定数据；S46 B-3 改用户语言）", () => {
  assert.ok(projectPages.includes("哪一集、哪个分镜、哪个场景在用它"), "缺集/分镜/场景上下文行");
  assert.ok(projectPages.includes("使用情况功能上线后"), "缺留位说明");
  assert.ok(!projectPages.includes("使用情况统计即将上线"), "工程状态自述残留");
  assert.ok(!projectPages.includes("分镜级使用明细接口暂未回传"), "死文案残留");
});

test("D2c：版本列表补版本备注（version.description 真字段，有值才展示）", () => {
  assert.ok(projectPages.includes("备注：{version.description}"), "版本网格缺版本备注行");
  assert.ok(projectPages.includes("version.description?.trim()"), "备注未按空值隐藏");
});

/* ---------- D3：「本剧资产」命名区分 + 互链 + 使用情况留位 ---------- */

test("D3a：项目内资产页改名「本剧资产」，旁边有「去资产中心」链接", () => {
  assert.ok(projectPages.includes(">本剧资产</h1>"), "页标题未改「本剧资产」");
  assert.ok(projectPages.includes(">去资产中心</button>"), "标题旁缺「去资产中心」链接");
  assert.ok(projectPages.includes('<HelpHint label="本剧资产说明">'), "HelpHint 标签未同步改名");
  assert.ok(!projectPages.includes('<h1 className="text-page-title text-ink-1">项目资产</h1>'), "旧页名「项目资产」仍在标题位");
  // 面包屑两处（资产页 + 生产页）结构不变
  assert.equal(countOccurrences(projectPages, 'aria-label="面包屑"'), 2, "面包屑数量漂移");
});

test("D3b：资产详情页返回链同步「本剧资产」", () => {
  assert.ok(projectPages.includes("<ArrowLeft aria-hidden=\"true\" />本剧资产</button>"), "详情页返回链未同步改名");
});

test("D3c：资产中心「哪些项目在用这个资产」诚实留位，不摆空假表", () => {
  assert.ok(globalPages.includes("项目使用情况，功能上线后展示"), "缺项目使用情况留位说明");
  assert.ok(!globalPages.includes("数据接入后展示"), "工程状态自述残留");
  assert.ok(globalPages.includes("通用资产由平台管理员审核"), "通用资产审核权限说明缺失");
});

/* ---------- D4：资产中心树状浏览（列表/树状并存，筛选不撤） ---------- */

test("D4a：列表/树状视图切换入口在位", () => {
  assert.ok(globalPages.includes('aria-label="浏览视图"'), "缺视图切换组");
  assert.ok(globalPages.includes('aria-label="按类型树状浏览"'), "缺树状视图切换按钮");
  assert.ok(globalPages.includes('useState<"list" | "tree">("list")'), "缺 viewMode 状态（默认列表）");
});

test("D4b：树状按类型分组（S88 唯一归属口径），分组源仍是统一类型枚举", () => {
  assert.ok(globalPages.includes("function AssetKindTreeView"), "缺树状视图组件");
  const treeStart = globalPages.indexOf("function AssetKindTreeView");
  const treeBlock = globalPages.slice(treeStart, treeStart + 1200);
  assert.ok(treeBlock.includes("ASSET_KIND_OPTIONS"), "树状分组未用统一类型枚举");
  // S88：陈列走唯一归属（别名归主类型、animal 归「角色·动物」自己），
  // 不再用 assetKindMatches 的上卷口径——否则老虎会同时躺在「角色」和「角色·动物」两个文件夹
  assert.ok(treeBlock.includes("assetKindGroupValue"), "树状分组未走 S88 唯一归属口径");
  assert.ok(treeBlock.includes("{items.length} 个资产"), "树状组头缺真实计数");
});

test("D4c：树状消费筛选后的 filtered，列表视图与分页原样保留", () => {
  assert.ok(globalPages.includes("<AssetKindTreeView assets={filtered}"), "树状未消费筛选结果（筛选被取代）");
  assert.ok(globalPages.includes("paginateItems(filtered, safePage)"), "列表视图切片被改动");
  assert.ok(globalPages.includes('itemNoun="个资产" ariaLabel="资产分页"'), "列表分页器漂移");
});

test("D4d（S88b 行为断言）：树状唯一归属真渲染——animal 只进「角色·动物」一次，词表外值进「未分类」", () => {
  /* R4 整改：D4b 的字符串断言注释里写 assetKindGroupValue 就能骗过（验收人 M5 变异不红）。
     改为真渲染 AssetKindTreeView：老虎（animal）若被换回 assetKindMatches 上卷口径，
     会同时躺进「角色」与「角色·动物」两个文件夹，「查看 山林猛虎 详情」出现 2 次 → 红。 */
  const assets = [
    { id: "tiger", name: "山林猛虎", asset_kind: "animal", status: "ready" },
    { id: "keeper", name: "守林人", asset_kind: "character", status: "ready" },
    { id: "odd", name: "旧格式素材", asset_kind: "scene_reference", status: "ready" },
  ] as unknown as Asset[];
  const html = renderToStaticMarkup(React.createElement(AssetKindTreeView, { assets, onOpen: () => undefined }));
  assert.equal(countOccurrences(html, "查看 山林猛虎 详情"), 1, "老虎在树状里出现次数 ≠ 1（上卷重复占位或丢失）");
  const sectionHtml = (label: string): string => html.match(new RegExp(`<section[^>]*aria-label="${label}分组"[\\s\\S]*?</section>`))?.[0] ?? "";
  assert.ok(sectionHtml("角色·动物").includes("山林猛虎"), "老虎不在「角色·动物」组");
  assert.ok(sectionHtml("角色").includes("守林人"), "守林人不在「角色」组");
  assert.ok(!sectionHtml("角色").includes("山林猛虎"), "老虎误进「角色」组（上卷口径回潮）");
  assert.ok(sectionHtml("未分类").includes("旧格式素材"), "词表外值未进「未分类」组");
});

test("R128：个人资产树状卡不渲染审核徽标，通用资产仍显示", () => {
  const assets = [
    { id: "personal", name: "个人角色", asset_kind: "character", scope: "personal", status: "approved" },
    { id: "shared", name: "通用角色", asset_kind: "character", scope: "common", status: "approved" },
  ] as Asset[];
  const html = renderToStaticMarkup(React.createElement(AssetKindTreeView, { assets, onOpen: () => undefined }));
  const personalButton = html.match(/<button[^>]*aria-label="查看 个人角色 详情"[\s\S]*?<\/button>/)?.[0] ?? "";
  const commonButton = html.match(/<button[^>]*aria-label="查看 通用角色 详情"[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.ok(personalButton, "个人资产卡未渲染");
  assert.doesNotMatch(personalButton, /自动审核|待审核|已通过|已拒绝/);
  assert.match(commonButton, /已通过/);
});

test("R128：项目引入抽屉只在通用范围展示并应用审核筛选", () => {
  assert.ok(projectPages.includes('if (scope === "personal" && status) setStatus("");'), "切回个人范围未清除审核筛选");
  assert.ok(projectPages.includes('scope !== "common" || !status || assetReviewBucket(asset.status) === status'), "个人范围仍会应用审核状态");
  assert.ok(projectPages.includes('{scope === "common" ? ('), "审核筛选未受通用范围约束");
});

/* ---------- D5：项目信息可编辑（真 PATCH） ---------- */

test("D5a：项目卡有「编辑项目信息」入口", () => {
  assert.ok(globalPages.includes('label="编辑项目信息"'), "项目卡缺编辑入口");
  assert.ok(globalPages.includes("onEdit={() => openProjectEdit(project)}"), "项目卡未接编辑回调");
  assert.ok(globalPages.includes("<DialogTitle>编辑项目信息</DialogTitle>"), "缺编辑弹窗");
});

test("D5b：保存走真 PATCH /api/v1/projects/:project_id，名称必填", () => {
  assert.ok(globalPages.includes("`/projects/${encodeURIComponent(editing.id)}`"), "未指向项目 PATCH 端点");
  assert.ok(globalPages.includes('method: "PATCH"'), "未走 PATCH 方法");
  assert.ok(globalPages.includes("请输入项目名称"), "缺名称必填校验");
  assert.ok(globalPages.includes("项目信息已保存"), "缺保存成功 toast");
  assert.ok(globalPages.includes("离线示例项目只保存在当前页面，未写入服务"), "demo 分支缺诚实降级");
});

/* ---------- 裁决 2：项目列表「已完成」tab 摘除 ---------- */

test("裁决2a：状态页签整体退役,看板列归组承载状态语义(已完成不再是恒空空桶)", () => {
  // 2026-08-02 Fable 改锚:R2 看板化(批次一卡 3)后状态 tab 全部退役,
  // 裁决2a 的语义(不给恒空「已完成」桶)由看板四列超额达成——完成态=「已交」列,真数据可见。
  assert.ok(!globalPages.includes('label: "已完成"'), "「已完成」tab 不得回潮");
  assert.ok(!globalPages.includes('{ value: "all", label: "全部" }'), "状态 tab 已退役,不得回潮");
  assert.ok(globalPages.includes("projectBoardColumn"), "缺看板列归组(状态语义新载体)");
});

test("裁决2b：只摘 UI tab——filterProjects/ProjectFilterTab 类型合同未动（他线文件）", () => {
  // 逻辑层在他线文件 batch-generate-drawer.tsx：ProjectFilterTab 仍含 completed（filterProjects 入参合同不变），
  // UI 不再提供该入口；completed→桶 死值映射已由死值清理线按裁决收敛（现状无映射、恒 other），与「桶恒空」同向。
  assert.ok(batchDrawer.includes('"all" | "active" | "completed" | "archived"'), "ProjectFilterTab 类型合同漂移");
  assert.ok(batchDrawer.includes("export function filterProjects"), "filterProjects 被误删");
  assert.ok(batchDrawer.includes("export function projectStatusBucket"), "projectStatusBucket 被误删");
});
