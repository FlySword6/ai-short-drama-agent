/* ============================================================
   production-manual-entry.test.ts — 生产页手动建集/加分镜通路(不依赖 AI 拆分镜)

   产品负责人走查原话:"新建项目后在生产那里没法自己手动加集，我就是不想拆分镜，
   也没必要在这个平台拆分镜"——要一条完全不依赖 AI 剧本解析的平行通路。
   源码级守卫(与 uiux-fix1/block2-route-retire 同一先例,页面级改动走源码断言):
   ① 集切换器旁挂 CreateEpisodeButton,单集/多集两种形态都有;建完自动切到新集+
      刷新集列表(不需要用户手动刷新);
   ② 手动加分镜复用 project-pages.tsx 死代码里 addShot() 的"镜号取当前最大值+1"口径,
      但绝不 import 死文件(死文件头写死禁止新增引用);
   ③ 没有场时自动建默认场——本页场卡按场分组渲染(scenes INNER JOIN 起query),
      scene_id 缺省的孤儿分镜在 production-status 投影里连场卡都进不去,
      "加了看不见"是真坑,必须堵掉(第四件判断落地处);
   ④ demoMode 分支保留,与死代码同一提示文案(不写入服务)。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const view = readSource("./pages/production-view-page.tsx");
const api = readSource("./api.ts");

/* ---------- api 层补口:createScene ---------- */

test("api 补齐 createScene(后端接口是好的，前端没接，routes.ts:215-224)", () => {
  assert.ok(api.includes("async createScene("), "api 缺 createScene 方法");
  assert.ok(
    api.includes("/episodes/${encodeURIComponent(episodeId)}/scenes"),
    "createScene 应挂后端既有 POST /episodes/:id/scenes（不是新造接口）",
  );
});

/* ---------- 零 import 死文件 ---------- */

test("生产页零 import 死文件(project-pages.tsx 头部写死禁止新增引用)", () => {
  assert.ok(!view.includes('from "./project-pages"'), "禁止 import 退役中的 StoryboardPage 死文件");
  assert.ok(!view.includes('from "./project-pages.tsx"'), "禁止 import 退役中的 StoryboardPage 死文件");
});

/* ---------- 第一件:新建集入口 ---------- */

test("集切换器旁挂新建集入口，单集/多集两种形态共用同一处（不重复实现）", () => {
  assert.ok(view.includes("<CreateEpisodeButton"), "缺新建集按钮");
  const h1Idx = view.indexOf("sortedEpisodes.length > 1 ?");
  assert.ok(h1Idx > 0, "集标题三态分支不在了");
  const createIdx = view.indexOf("<CreateEpisodeButton", h1Idx);
  assert.ok(createIdx > h1Idx, "新建集入口应紧跟标题三态分支之后，单/多集共用一处（不是各写一遍）");
});

test("建集成功后自动切到新集 + 刷新集列表（不用手动刷新页面）", () => {
  const idx = view.lastIndexOf("<CreateEpisodeButton");
  const chunk = view.slice(idx, idx + 500);
  assert.ok(chunk.includes("episodes.retry()"), "建集成功未刷新集列表");
  assert.ok(chunk.includes("switchEpisode("), "建集成功未自动切到新集");
});

/* ---------- 第二件:手动加分镜 ---------- */

test("手动加分镜函数存在，镜号取「本集当前最大值 +1」（复用死代码 addShot 口径）", () => {
  assert.ok(view.includes("async function addShot"), "缺手动加分镜函数");
  const start = view.indexOf("async function addShot");
  const body = view.slice(start, start + 1400);
  assert.ok(body.includes("Number.parseInt"), "镜号取数未复用「最大值+1」口径");
});

test("手动加分镜按钮已接线到页面（不是孤立函数）", () => {
  assert.ok(view.includes("void addShot("), "加分镜函数没接按钮 onClick");
});

/* ---------- 第三件:demoMode 分支保留 ---------- */

test("手动加分镜 demoMode 分支保留，提示文案与死代码一致", () => {
  const start = view.indexOf("async function addShot");
  const body = view.slice(start, start + 700);
  assert.ok(body.includes("demoMode"), "addShot 缺 demoMode 判断");
  assert.ok(body.includes("离线演示只更新当前页面，未写入服务"), "demoMode 分支的提示文案被丢了");
});

/* ---------- 第四件:没有场时自动建场，不产生「加了看不见」的孤儿分镜 ---------- */

test("手动加分镜：没有场时自动建默认场，不留 scene_id=null 的孤儿分镜", () => {
  const start = view.indexOf("async function addShot");
  const nextFnIdx = view.indexOf("\nasync function", start + 20);
  const body = view.slice(start, nextFnIdx > 0 ? nextFnIdx : start + 2000);
  assert.ok(body.includes("api.createScene("), "0 场时未自动建场——分镜在场卡视图里会显示不出来");
});

test("场数 >= 2 时加分镜可选目标场（不是死默认永远第一场）", () => {
  assert.ok(view.includes('aria-label="加分镜目标场"'), "多场时缺场选择器，用户选不了分镜归哪场");
});

/* ---------- 界面文案不得含内部黑话/英文错误串 ---------- */

test("新增文案不含内部状态名/HTTP 码/字段名（业务语言化纪律）", () => {
  const addIdx = view.indexOf("async function addShot");
  const chunk = view.slice(addIdx, addIdx + 1600);
  for (const forbidden of ["scene_id", "episode_id", "shot_no", "status: 4", "status: 5", "undefined"]) {
    assert.ok(!chunk.includes(`"${forbidden}`) && !chunk.includes(`（${forbidden}`), `文案疑似泄漏内部标识 ${forbidden}`);
  }
});
