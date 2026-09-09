/* ============================================================
   home-next-step.test.ts — K2G 首页「我该去哪」（GP-02 / A1-03 销账）

   剧本步 1 口径：登录 → 首页能回答「我该去哪」（上次的项目 / 最近动态可见）。
   本文件守四件事：
   ① 推导纯函数：选哪个项目（pickResumeProject）、上次看到哪（rememberedPlaceLabel）、
      继续卡视图模型（buildResumeWorkModel 三档：推导直达/回到上次页面/打开生产页）、
      demo 数据归属（hasDemoProductionData / demoRecordsForProject——fixture 不跨项目串）、
      最近动态合并排序（toHomeActivityItems，与通知 Dock 同源同口径）。
   ② 组件真渲染（renderToStaticMarkup）：ResumeWorkView / HomeActivityView / HomeStartGuide。
   ③ 诚实化：demo 最近动态=如实说明（不造假动态）；推导不出=如实降级（不编进度）。
   ④ 接线源码断言：ProjectsPage 挂三件套、项目卡「去导入剧本」、Dock demo 恒禁现状不动。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeActivityView, HomeStartGuide, ResumeWorkView } from "./components/home-next-step";
import {
  buildResumeWorkModel,
  demoRecordsForProject,
  hasDemoProductionData,
  pickResumeProject,
  rememberedPlaceLabel,
  toHomeActivityItems,
  type HomeProjectRef,
} from "./home-next-step";
import { inferProductionProgress, type ProductionProgress } from "./production-progress";
import type { GenerationAttemptNotification } from "./types";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function project(partial: Partial<HomeProjectRef> & { id: string }): HomeProjectRef {
  return { name: `项目${partial.id}`, status: "进行中", ...partial };
}

/* ---------- ① 选哪个项目 ---------- */

test("pickResumeProject：按更新时间倒序取最近一个，剔除已归档", () => {
  const projects = [
    project({ id: "p-old", updated_at: "2026-07-20T09:00:00Z" }),
    project({ id: "p-new", updated_at: "2026-07-23T09:00:00Z" }),
    project({ id: "p-archived", status: "已归档", updated_at: "2026-07-27T09:00:00Z" }),
  ];
  assert.equal(pickResumeProject(projects)?.id, "p-new");
});

test("pickResumeProject：缺更新时间的项目用创建时间兜底，全都给不出时间也不炸", () => {
  const projects = [
    project({ id: "p-no-date" }),
    project({ id: "p-created", created_at: "2026-07-21T09:00:00Z" }),
  ];
  assert.equal(pickResumeProject(projects)?.id, "p-created");
  assert.equal(pickResumeProject([]), null);
  assert.equal(pickResumeProject([project({ id: "p-archived", status: "archived" })]), null);
});

/* ---------- ① 上次看到哪 ---------- */

test("rememberedPlaceLabel：项目内路径翻译成人话位置，认不出回 null", () => {
  assert.equal(rememberedPlaceLabel("/projects/p1/storyboards/e1/shots/s1"), "工作台");
  assert.equal(rememberedPlaceLabel("/projects/p1/storyboards"), "生产页");
  assert.equal(rememberedPlaceLabel("/projects/p1/assets"), "资产面板");
  assert.equal(rememberedPlaceLabel("/projects/p1/assets/a1"), "资产面板");
  assert.equal(rememberedPlaceLabel("/projects/p1/director"), "导演台");
  assert.equal(rememberedPlaceLabel("/projects/p1/script-breakdown"), "剧本分镜");
  assert.equal(rememberedPlaceLabel("/projects/p1/costs"), "消耗看板");
  assert.equal(rememberedPlaceLabel("/projects"), null);
  assert.equal(rememberedPlaceLabel(null), null);
});

/* ---------- ① 继续卡三档 ---------- */

const IMAGE_PROGRESS: ProductionProgress = {
  current: "image",
  currentIndex: 1,
  episodeId: "e1",
  shotId: "s1",
  description: "素材 #1 还没有可用图片。",
  actionLabel: "去生成图片",
};

test("buildResumeWorkModel：有进度推导=下一步描述+动作直达对应工作台", () => {
  const model = buildResumeWorkModel({
    projectId: "p1",
    projectName: "《杀穿女频》",
    rememberedPath: "/projects/p1/storyboards",
    progress: IMAGE_PROGRESS,
    updatedLabel: "5 天前",
  });
  assert.equal(model.nextStepText, "素材 #1 还没有可用图片。");
  assert.equal(model.actionLabel, "去生成图片");
  assert.equal(model.targetPath, "/projects/p1/storyboards/e1/shots/s1");
  assert.equal(model.contextText, "上次看到：生产页 · 更新于 5 天前");
});

test("buildResumeWorkModel：推导不出但有记忆=如实降级「回到上次页面」，不编进度", () => {
  const model = buildResumeWorkModel({
    projectId: "p1",
    projectName: "《老公诈死》",
    rememberedPath: "/projects/p1/storyboards/e1/shots/s9",
    progress: null,
    updatedLabel: "6 天前",
  });
  assert.equal(model.nextStepText, null);
  assert.equal(model.actionLabel, "回到工作台");
  assert.equal(model.targetPath, "/projects/p1/storyboards/e1/shots/s9");
  assert.equal(model.contextText, "上次看到：工作台 · 更新于 6 天前");
});

test("buildResumeWorkModel：推导不出也没记忆=降级「打开生产页」；无时间无位置整行隐藏", () => {
  const model = buildResumeWorkModel({
    projectId: "p1",
    projectName: "《重返十八岁》",
    rememberedPath: null,
    progress: null,
    updatedLabel: "",
  });
  assert.equal(model.nextStepText, null);
  assert.equal(model.actionLabel, "打开生产页");
  assert.equal(model.targetPath, "/projects/p1/storyboards");
  assert.equal(model.contextText, "");
});

/* ---------- ① demo 数据归属（GP-04 教训：fixture 不跨项目串） ---------- */

test("demo 归属：demo-project-2 有集镜数据可推导；其他 demo 项目如实降级", () => {
  assert.equal(hasDemoProductionData("demo-project-2"), true);
  assert.equal(hasDemoProductionData("demo-project-1"), false);
  assert.equal(hasDemoProductionData("demo-project-999"), false);
  const records = demoRecordsForProject("demo-project-2");
  assert.equal(records.length, 6);
  assert.ok(records.every((record) => record.episode.project_id === "demo-project-2"));
  const progress = inferProductionProgress(records);
  /* K2P 彩排剧情(5 镜过审可交付+1 缺口)下:素材 #6 没有视频主版本——媒体维度的缺口,
     推导器如实指到它(推导器不看 review_status,与 K2A 审核队列维度正交,语义不变)。
     原期望 delivery 基于 K2A 原 fixture(六镜媒体全齐),随彩排剧情更新(K2P 07-29 rebase 到 33ae312)。 */
  assert.equal(progress.current, "video");
  assert.equal(progress.episodeId, "demo-episode-1");
  assert.equal(progress.shotId, "demo-shot-6");
  /* 无归属 fixture 的项目：records 为空也不许拿空数组硬算（调用方走 progress=null 降级） */
  assert.equal(demoRecordsForProject("demo-project-1").length, 0);
});

/* ---------- ① 最近动态合并 ---------- */

function generationNotification(partial: Partial<GenerationAttemptNotification>): GenerationAttemptNotification {
  return {
    id: "n1",
    generation_request_id: "r1",
    attempt_id: "a1",
    project_id: "p1",
    episode_id: "e1",
    shot_id: "s1",
    media_kind: "video",
    /* types.ts 既有潜伏伤：GenerationStatus 带 `| string`，字面量被基类型吸收，
       Extract<GenerationStatus,"succeeded"|"failed"> 实为 never；仓内无人构造字面量所以没炸过。
       本测试是第一个构造方，按既有运行值断言（修 types.ts 超出本包边界）。 */
    status: "succeeded" as GenerationAttemptNotification["status"],
    created_at: "2026-07-28T09:00:00Z",
    ...partial,
  };
}

test("toHomeActivityItems：两类提醒合并按时间倒序，项目名查得到就署名", () => {
  const items = toHomeActivityItems(
    [generationNotification({})],
    [{
      id: "u1",
      status: "failed",
      original_file_name: "角色.png",
      error_message: "TOS request failed",
      display_reason: "图片入库没成：格式不支持，请更换图片。",
      created_at: "2026-07-28T10:00:00Z",
    }],
    (projectId) => (projectId === "p1" ? "永恒之塔" : null),
  );
  assert.equal(items.length, 2);
  assert.equal(items[0]!.id, "upload-u1");
  assert.equal(items[0]!.title, "图片入库失败");
  assert.equal(items[0]!.body, "图片入库没成：格式不支持，请更换图片。");
  assert.equal(items[0]!.tone, "danger");
  assert.equal(items[0]!.targetPath, "/assets");
  assert.equal(items[1]!.title, "视频任务已完成");
  assert.equal(items[1]!.body, "《永恒之塔》 · 结果已保存");
  assert.equal(items[1]!.targetPath, "/projects/p1/storyboards/e1/shots/s1");
});

test("toHomeActivityItems：项目名查不到不编名；失败提醒只显示安全文案", () => {
  const items = toHomeActivityItems(
    [generationNotification({
      id: "n2",
      project_id: "p-gone",
      status: "failed" as GenerationAttemptNotification["status"],
      display_reason: "视频生成没成：生成服务暂时没响应，请稍后重试。",
    })],
    [],
    () => null,
  );
  assert.equal(items[0]!.title, "视频任务失败");
  assert.equal(items[0]!.body, "视频生成没成：生成服务暂时没响应，请稍后重试。");
  assert.ok(!items[0]!.body.includes("《"));
});

/* ---------- ② 组件真渲染：继续卡 ---------- */

test("ResumeWorkView 渲染：推导态=项目名+下一步+上下文+动作按钮", () => {
  const html = renderToStaticMarkup(React.createElement(ResumeWorkView, {
    model: buildResumeWorkModel({
      projectId: "p1",
      projectName: "《杀穿女频》",
      rememberedPath: "/projects/p1/storyboards/e1/shots/s1",
      progress: IMAGE_PROGRESS,
      updatedLabel: "5 天前",
    }),
  }));
  assert.ok(html.includes("继续上次工作"), "缺区块身份");
  assert.ok(html.includes("《杀穿女频》"));
  assert.ok(html.includes("素材 #1 还没有可用图片。"));
  assert.ok(html.includes("上次看到：工作台 · 更新于 5 天前"));
  assert.ok(html.includes("去生成图片"));
});

test("ResumeWorkView 渲染：降级态只字不提下一步，按钮=打开生产页", () => {
  const html = renderToStaticMarkup(React.createElement(ResumeWorkView, {
    model: buildResumeWorkModel({
      projectId: "p1",
      projectName: "《重返十八岁》",
      rememberedPath: null,
      progress: null,
      updatedLabel: "",
    }),
  }));
  assert.ok(html.includes("《重返十八岁》"));
  assert.ok(html.includes("打开生产页"));
  assert.ok(!html.includes("还没有可用"), "降级态编了进度");
  assert.ok(!html.includes("上次看到"), "没记忆却说了位置");
});

/* ---------- ② 组件真渲染：最近动态 ---------- */

const ACTIVITY_ITEMS = toHomeActivityItems(
  [generationNotification({})],
  [],
  () => "永恒之塔",
);

test("HomeActivityView 渲染：demo=如实说明不造假动态", () => {
  const html = renderToStaticMarkup(React.createElement(HomeActivityView, { demoMode: true, state: "loading", items: [], total: 0 }));
  assert.ok(html.includes("离线演示不生成任务提醒"));
  assert.ok(!html.includes("任务已完成"), "demo 下造假动态");
});

test("HomeActivityView 渲染：读取中/读不出/无提醒 三态如实", () => {
  const loading = renderToStaticMarkup(React.createElement(HomeActivityView, { demoMode: false, state: "loading", items: [], total: 0 }));
  assert.ok(loading.includes("正在读取最近动态"));
  const error = renderToStaticMarkup(React.createElement(HomeActivityView, { demoMode: false, state: "error", items: [], total: 0 }));
  assert.ok(error.includes("任务提醒暂时读不出来"));
  const empty = renderToStaticMarkup(React.createElement(HomeActivityView, { demoMode: false, state: "ready", items: [], total: 0 }));
  assert.ok(empty.includes("最近没有生成或入库完成的提醒"));
});

test("HomeActivityView 渲染：有提醒铺条目+查看入口，超 3 条收成计数行", () => {
  const many = [...ACTIVITY_ITEMS, ...ACTIVITY_ITEMS.map((item, index) => ({ ...item, id: `x${index}` })), { ...ACTIVITY_ITEMS[0]!, id: "x2" }];
  const html = renderToStaticMarkup(React.createElement(HomeActivityView, { demoMode: false, state: "ready", items: many, total: 5 }));
  assert.ok(html.includes("视频任务已完成"));
  assert.ok(html.includes("《永恒之塔》"));
  assert.ok(html.includes("查看"));
  assert.equal((html.match(/视频任务已完成/g) ?? []).length, 3, "首屏最多铺 3 条");
  assert.ok(html.includes("还有 2 条任务提醒"));
});

/* ---------- ② 组件真渲染：新用户三步起步指引 ---------- */

test("HomeStartGuide 渲染：三步都是动作，第一步是可提交的建项目表单", () => {
  const html = renderToStaticMarkup(React.createElement(HomeStartGuide, {
    name: "",
    onNameChange: () => undefined,
    onSubmit: () => undefined,
    creating: false,
  }));
  assert.ok(html.includes("三步开出第一部"));
  for (const title of ["新建项目", "导入剧本", "拆分镜"]) assert.ok(html.includes(title), `缺第 ${title} 步`);
  assert.ok(html.includes("<form"), "第一步不是可提交表单");
  assert.ok(html.includes("剧名"), "缺剧名输入框");
  assert.ok(html.includes("到生产页导入第 1 集剧本 Excel"), "第二步没说清在哪做");
});

/* ---------- ④ 接线源码断言 ---------- */

test("接线：ProjectsPage 挂三件套；项目卡 0 集给「去导入剧本」；Dock demo 恒禁现状不动", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  assert.ok(globalPages.includes("<ResumeWorkCard"), "首页未挂继续卡");
  assert.ok(globalPages.includes("<HomeActivityStrip"), "首页未挂最近动态");
  assert.ok(globalPages.includes("<HomeStartGuide"), "空列表未挂三步指引");
  assert.ok(globalPages.includes("去导入剧本"), "新项目卡缺下一步直达");
  assert.ok(globalPages.includes("离线示例项目只保存在当前页面"), "demo 建项目口径标注被动过");
  const app = readSource("./app.tsx");
  assert.ok(app.includes("enabled={!demoMode}"), "Dock demo 恒禁现状被改动");
  assert.ok(!app.includes("function notificationResultPath"), "app.tsx 仍私藏跳转函数");
  const routing = readSource("./routing.ts");
  assert.ok(routing.includes("export function notificationResultPath"), "跳转函数未收敛到 routing.ts");
});
