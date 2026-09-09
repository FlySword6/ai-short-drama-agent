/* ============================================================
   k2i-bible-note.test.ts — K2I 设计圣经导入放行标注（GP-01）验收断言

   背景：剧本步 3（docs/design/full-flow-screenplay.md）「导入设计圣经」功能归
   k3 包 4（后端），没做出来之前手工建资产替代，可放行测试版但记入发版说明
   并【标注】；GP-01 判 P0 的点是「标注缺失，用户根本不知道有这一步」。
   本文件守：
   ① 标注真渲染（renderToStaticMarkup）：概念名/用户语言状态/替代路径/直达动作
   ② 落位与克制：挂生产页面包屑旁、canCreate 门控、非 primary 按钮
   ③ 直达动作：?create=1 深链在本剧资产页剥参并自动打开「新建资产」弹窗
   ④ 标注文案禁词（s17 开发词表 + 用词纪律词）零命中
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BibleImportNote } from "./pages/project-pages";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const projectPages = readSource("./pages/project-pages.tsx");

function renderNote(): string {
  return renderToStaticMarkup(React.createElement(BibleImportNote, { projectId: "demo-project-1" }));
}

/* ---------- ① 标注真渲染 ---------- */

test("K2I ①：标注渲染——设计圣经概念名 + 即将上线 + 替代路径 + 直达动作齐备", () => {
  const html = renderNote();
  assert.ok(html.includes("设计圣经"), "缺「设计圣经」概念名（剧本步 3 的用户可见锚）");
  assert.ok(html.includes("即将上线"), "缺用户语言状态「即将上线」（病根 4：用户空间只有能用/即将上线两种状态）");
  assert.ok(html.includes("角色") && html.includes("场景"), "缺替代路径的对象：角色和场景");
  assert.ok(html.includes("手工建立"), "缺替代路径动作：手工建立");
  assert.ok(html.includes("去新建资产"), "缺直达动作「去新建资产」");
  assert.ok(html.includes('role="note"'), "缺 role=note 语义");
});

test("K2I ②：落位与克制——挂生产页面包屑旁、canCreate 门控、非 primary", () => {
  assert.ok(
    projectPages.includes("{canCreate ? <BibleImportNote projectId={projectId} /> : null}"),
    "标注未按 canCreate 门控挂在生产页（viewer 不能建资产，不应看到）",
  );
  const breadcrumbIndex = projectPages.indexOf('aria-label="面包屑"', projectPages.indexOf("export function StoryboardPage"));
  const noteIndex = projectPages.indexOf("<BibleImportNote projectId={projectId} />");
  const assetsSectionIndex = projectPages.indexOf('aria-label="使用资产"');
  assert.ok(breadcrumbIndex > -1 && noteIndex > breadcrumbIndex, "标注不在生产页面包屑之后");
  assert.ok(assetsSectionIndex > noteIndex, "标注应在「使用资产」区之前（开工先到位置）");
  assert.ok(!renderNote().includes("button-primary"), "标注动作不得是 primary 按钮");
  /* 直达目标：跳本剧资产页并带 ?create=1 自动开「新建资产」弹窗。 */
  assert.ok(projectPages.includes("navigate(`/projects/${projectId}/assets?create=1`)"), "缺 ?create=1 深链");
});

/* ---------- ③ 直达动作：本剧资产页剥参 + 自动开弹窗 ---------- */

test("K2I ③：?create=1 深链在本剧资产页剥参并自动打开「新建资产」弹窗", () => {
  assert.ok(projectPages.includes('params.get("create") !== "1"'), "本剧资产页未读 ?create=1 深链参数");
  assert.ok(projectPages.includes('navigate(`/projects/${projectId}/assets${query ? `?${query}` : ""}`, { replace: true })'), "深链剥参未走 replace（会污染刷新）");
  assert.ok(projectPages.includes("setCreateOpen(true)"), "深链未触发打开新建资产弹窗");
  const modalBlock = projectPages.slice(projectPages.indexOf("{createOpen ? ("), projectPages.indexOf("</section>", projectPages.indexOf("{createOpen ? (")));
  assert.ok(modalBlock.includes('title="新建资产"'), "深链弹窗标题不是「新建资产」");
  assert.ok(!modalBlock.includes("lockedKind"), "深链弹窗不应锁类型——角色/场景都要能建");
  assert.ok(modalBlock.includes("createKindAsset"), "深链弹窗未接既有创建链（createKindAsset）");
});

/* ---------- ④ 标注文案禁词（s17 开发词表 + 用词纪律词） ---------- */

test("K2I ④：标注渲染文案零命中 s17 开发词与用词纪律词", () => {
  const html = renderNote();
  for (const token of ["缺口", "mock", "Mock", "基线", "端点", "接口未", "后端未", "接口接入", "未对接", "暂未接通"]) {
    assert.ok(!html.includes(token), `标注文案命中 s17 开发词「${token}」`);
  }
  for (const word of ["闭环", "落地", "链路", "落点", "抓手", "心智"]) {
    assert.ok(!html.includes(word), `标注文案命中用词纪律词「${word}」`);
  }
});
