/* ============================================================
   block2-route-retire — 块 2:旧两页(镜级工作台/分镜列表枢纽页)动线退役守卫

   合同(重构靶单 core-refactor-plan v2 块 2 条):
   ① 旧 /storyboards 列表页与 /shots/ 镜级工作台从路由摘除,深链由换乘页接住;
   ② shots URL=换乘口:按 shot.scene_id 落场级工作台,未分场兜底生产页,
      不许把旧链接用户丢进错的场;?library=1 随乘;
   ③ 旧页五种深链(episode/playback/delivery=1|history/review)全承接到生产页,
      职能不许蒸发(整集连播=EpisodePlaybackModal 平移接线);
   ④ 站内入口归一:不再产旧列表页 URL;
   ⑤ 旧两页文件退役中但源码合同仍活(块 3 逐功能迁移),禁止新增 import。
   ============================================================ */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { shotRedirectTarget, storyboardsRedirectTarget } from "./routing";

function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/* ---------- ② 镜级换乘目标(纯函数) ---------- */

test("块 2 换乘:有归属场→场级工作台;?library=1 随乘;未分场→生产页兜底", () => {
  assert.equal(
    shotRedirectTarget("p1", "ep1", "scene-9", ""),
    "/projects/p1/storyboards/ep1/scenes/scene-9",
    "有场必须落场级工作台",
  );
  assert.equal(
    shotRedirectTarget("p1", "ep1", "scene-9", "?library=1"),
    "/projects/p1/storyboards/ep1/scenes/scene-9?library=1",
    "选主版本深链要随乘",
  );
  assert.equal(shotRedirectTarget("p1", "ep1", null, ""), "/projects/p1/production", "未分场兜底生产页");
  assert.equal(shotRedirectTarget("p1", "ep1", undefined, "?library=1"), "/projects/p1/production", "未分场时不携 library(生产页无此语义)");
});

/* ---------- ③ 列表页深链全承接(纯函数) ---------- */

test("块 2 换乘:旧列表页五种深链全部随乘到生产页,未知参数不带", () => {
  assert.equal(storyboardsRedirectTarget("p1", ""), "/projects/p1/production", "裸链落生产页");
  assert.equal(
    storyboardsRedirectTarget("p1", "?episode=ep2&playback=1"),
    "/projects/p1/production?episode=ep2&playback=1",
    "选集+整集连播随乘",
  );
  assert.equal(
    storyboardsRedirectTarget("p1", "?delivery=history&episode=ep1"),
    "/projects/p1/production?episode=ep1&delivery=history",
    "交付历史随乘",
  );
  assert.equal(storyboardsRedirectTarget("p1", "?delivery=1"), "/projects/p1/production?delivery=1", "交付随乘");
  assert.equal(storyboardsRedirectTarget("p1", "?review=1"), "/projects/p1/production?review=1", "审核队列随乘");
  assert.equal(storyboardsRedirectTarget("p1", "?foo=bar&playback=2"), "/projects/p1/production", "未知参数与非法值不随乘");
});

/* ---------- ①④⑤ 源码级:路由退役+入口归一+import 禁令 ---------- */

test("块 2 源码级:app.tsx 路由层——旧两页出路由,换乘页接管,旧页 import 断绝", () => {
  const app = readSource("./app.tsx");
  assert.ok(app.includes("<ShotWorkbenchRedirect"), "shots 路由未接换乘页");
  assert.ok(app.includes("<StoryboardsRedirect"), "storyboards 路由未接换乘页");
  assert.ok(!app.includes("<WorkbenchPage"), "镜级工作台仍挂在路由上");
  assert.ok(!app.includes("<StoryboardPage"), "旧分镜列表页仍挂在路由上");
  assert.ok(!app.includes('from "./pages/workbench-page"'), "app.tsx 仍 import 退役中的镜级工作台文件");
  assert.ok(!app.includes("WorkbenchShotPager"), "镜级 pager 页头残留");
});

test("块 2 源码级:生产页承接五种深链+整集连播接线(职能不蒸发)", () => {
  const production = readSource("./pages/production-view-page.tsx");
  for (const anchor of ['get("episode")', 'get("review")', 'get("delivery")', 'get("playback")'] as const) {
    assert.ok(production.includes(anchor), `生产页未接收深链参数 ${anchor}`);
  }
  assert.ok(production.includes("EpisodePlaybackModal"), "整集连播未接进生产页(预览全集仍是留位=职能蒸发)");
  assert.ok(production.includes("initialTab={deliveryInitialTab}"), "交付历史深链未接 initialTab");
  assert.ok(!production.includes("/storyboards`"), "生产页仍产旧列表页 URL");
});

test("块 2 源码级:段落工作台控制包取数已断开旧页文件(挪出成 control-pack 模块)", () => {
  const segment = readSource("./pages/segment-workbench-page.tsx");
  assert.ok(!segment.includes('from "./workbench-page"'), "段落工作台仍从退役中的旧页文件取数");
  assert.ok(segment.includes('from "../control-pack"'), "控制包取数未走独立模块");
});

test("块 2 源码级:旧两页文件带退役标记,等块 3 合同迁完才物理归档", () => {
  assert.ok(readSource("./pages/workbench-page.tsx").startsWith("/* ⚠️ 退役中"), "镜级工作台缺退役标记");
  assert.ok(readSource("./pages/project-pages.tsx").includes("StoryboardPage 退役中"), "旧列表页缺退役标记");
});

/* ---------- 块 3(2026-08-03):R173a 流对齐 + 退役承接表第五项 ---------- */

test("块 3 源码级:P-06 确认后只读分镜表承接位(退役承接表第五项)", () => {
  const page = readSource("./pages/script-breakdown-page.tsx");
  const confirmStart = page.indexOf("async function confirmRun");
  assert.ok(confirmStart > 0, "confirmRun 不在了");
  const confirmBody = page.slice(confirmStart, page.indexOf("async function discardRun"));
  assert.ok(!confirmBody.includes("navigate("), "确认后仍立即跳走——承接位=本页只读分镜表,不许直接跳 P-07");
  assert.ok(confirmBody.includes("detailState.retry()"), "确认后未刷新为已确认只读态");
  assert.ok(page.includes("分镜表 · 已确认（只读）"), "已确认态栏题未改口(只读分镜表)");
  assert.ok(page.includes("去项目资产"), "只读表脚缺裁定⑤ P-07 出口");
});

test("块 3 源码级:R173a 生产页集切换器走 ?episode= 深链,二级条页签=生产流序", () => {
  const production = readSource("./pages/production-view-page.tsx");
  assert.ok(production.includes("switchEpisode"), "生产页缺集切换器");
  assert.ok(production.includes("?episode="), "切集未走 ?episode= 深链");
  assert.ok(production.includes('aria-label="切换集"'), "集切换器缺可访问名");
  const app = readSource("./app.tsx");
  const navStart = app.indexOf('aria-label="项目内导航"');
  assert.ok(navStart > 0, "项目内导航不在了");
  const nav = app.slice(navStart, navStart + 1600);
  const order = ["剧本", "资产", "生产", "消耗"].map((tab) => nav.indexOf(`>${tab}<`));
  assert.ok(order.every((idx) => idx > 0), "四页签缺位");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "页签序≠生产流序(剧本→资产→生产→消耗)");
});
