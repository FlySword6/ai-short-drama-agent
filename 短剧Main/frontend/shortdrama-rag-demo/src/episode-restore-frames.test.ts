/* ============================================================
   episode-restore-frames.test.ts — 集详情页「已拍画面 + 流程阶段条 + 空状态出路」(EPISODE-RESTORE 单)

   背景:8/2 镜像对照走查(outputs/uiux-vs-0802-image-20260805.md 退步 3)——
   集详情页把「六步流程进度条」与「镜头缩略图网格」弄丢了,只剩「控制包 X/7」数字,
   看实际画面要多点一步进分场。本文件守五件事:
   ① 挑帧口径:生成任务列表按集过滤,每镜一帧,图片优先/同种最新,只收 succeeded+可展示 URL;
   ② 阶段判定真源唯一:episodeStageStates 只做下标→三态映射,判定全走 inferProductionProgress;
   ③ 真渲染(renderToStaticMarkup):六步条三态/aria-current,网格图+台词+点击落点;
   ④ 空状态不是死路:noScriptExits 必有「先去备素材」,有别集时给「看看别集」;
   ⑤ 边界:生产页零新后端接口(只用 shots/projectGenerations/episodeDeliveries 既有方法)、零新轮询。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  episodeStageStates,
  noScriptExits,
  pickShotFrames,
  pickShotFramesFromRecords,
  shotFrameTarget,
} from "./episode-frames";
import { EpisodeStageStrip, ShotFrameGrid } from "./episode-restore";
import { PRODUCTION_STEPS, type ProductionShotRecord } from "./production-progress";
import type { Episode, GenerationTask, Shot } from "./types";

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/** 剥注释(块注释+行注释),「不出现某规则」类断言只看可执行代码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const episode: Episode = { id: "ep1", project_id: "p1", episode_no: 1, name: "第 1 集" };

function shotOf(id: string, extra: Partial<Shot> = {}): Shot {
  return { id, episode_id: "ep1", shot_no: id.replace("s", ""), scene_id: `sc-${id}`, ...extra };
}

function taskOf(shotId: string, media: NonNullable<GenerationTask["media_results"]>, extra: Partial<GenerationTask> = {}): GenerationTask {
  return { generation_request_id: `req-${shotId}-${media[0]?.id ?? "x"}`, status: "succeeded", episode_id: "ep1", shot_id: shotId, media_results: media, ...extra };
}

/* ---------- ① 挑帧口径 ---------- */

test("pickShotFrames:只收本集+succeeded+有可展示 URL 的产物", () => {
  const frames = pickShotFrames([
    taskOf("s1", [{ id: "m1", media_kind: "image", storage_url: "https://cdn/x1.png" }]),
    taskOf("s2", [{ id: "m2", media_kind: "image", storage_url: "https://cdn/x2.png" }], { episode_id: "ep-other" }),
    taskOf("s3", [{ id: "m3", media_kind: "image", storage_url: "https://cdn/x3.png" }], { status: "failed" }),
    taskOf("s4", [{ id: "m4", media_kind: "image", storage_url: null }]),
    taskOf("s5", [{ id: "m5", media_kind: "audio", storage_url: "https://cdn/x5.mp3" }]),
    taskOf("s6", [], {}),
  ], "ep1");
  assert.deepEqual([...frames.keys()], ["s1"], "别集/失败/无 URL/非图视产物都不得进网格");
  assert.equal(frames.get("s1")?.url, "https://cdn/x1.png");
});

test("pickShotFrames:每镜一帧——图片优先于视频,同种取最新", () => {
  const frames = pickShotFrames([
    /* 同镜多任务:旧图 → 新图 → 视频,最后留下的必须是新图 */
    taskOf("s1", [{ id: "m1", media_kind: "image", storage_url: "https://cdn/old.png", created_at: "2026-08-01T00:00:00Z" }]),
    taskOf("s1", [{ id: "m2", media_kind: "video", storage_url: "https://cdn/v1.mp4", created_at: "2026-08-03T00:00:00Z" }]),
    taskOf("s1", [{ id: "m3", media_kind: "image", storage_url: "https://cdn/new.png", created_at: "2026-08-02T00:00:00Z" }]),
    /* 只有视频的镜:如实给视频帧 */
    taskOf("s2", [{ id: "m4", media_kind: "video", storage_url: "https://cdn/v2.mp4", created_at: "2026-08-02T00:00:00Z" }]),
  ], "ep1");
  assert.equal(frames.size, 2);
  assert.deepEqual(frames.get("s1"), { shotId: "s1", kind: "image", url: "https://cdn/new.png", createdAt: "2026-08-02T00:00:00Z" });
  assert.equal(frames.get("s2")?.kind, "video");
});

test("pickShotFramesFromRecords(demo 口径):persisted+storage_url 才收,偏好与真栈一致", () => {
  const records: ProductionShotRecord[] = [{
    episode,
    shot: shotOf("s1"),
    media: [
      { id: "d1", media_kind: "video", persistence_status: "persisted", storage_url: "https://cdn/v.mp4" },
      { id: "d2", media_kind: "image", persistence_status: "persisted", storage_url: "https://cdn/i.png" },
      { id: "d3", media_kind: "image", persistence_status: "pending", storage_url: "https://cdn/pending.png" },
    ],
  }];
  const frames = pickShotFramesFromRecords(records);
  assert.equal(frames.size, 1);
  assert.equal(frames.get("s1")?.kind, "image", "图片优先");
  assert.equal(frames.get("s1")?.url, "https://cdn/i.png", "未持久化的产物不进网格");
});

/* ---------- ② 阶段条三态(判定真源=inferProductionProgress) ---------- */

test("episodeStageStates:无分镜且未导入剧本=第 0 步 current;已导入=第 0 步 complete 且无 current", () => {
  const none = episodeStageStates([], { scriptHas: false });
  assert.equal(none.length, PRODUCTION_STEPS.length);
  assert.equal(none[0]?.state, "current");
  assert.ok(none.slice(1).every((step) => step.state === "upcoming"));

  const has = episodeStageStates([], { scriptHas: true });
  assert.equal(has[0]?.state, "complete", "剧本已导入,「导入剧本」不许再标进行中(不抢答)");
  assert.ok(has.slice(1).every((step) => step.state === "upcoming"));
  assert.ok(has.every((step) => step.state !== "current"), "拆分镜缺口不由六步条虚构当前步,动作消歧交给下一步条");
});

test("episodeStageStates:卡在生成视频——前两步 complete、生成视频 current、之后 upcoming", () => {
  const records: ProductionShotRecord[] = [
    { episode, shot: shotOf("s1", { selected_image_result_id: "i1", selected_video_result_id: "v1" }), media: [] },
    { episode, shot: shotOf("s2", { selected_image_result_id: "i2" }), media: [] },
  ];
  const states = episodeStageStates(records, { scriptHas: true });
  assert.deepEqual(states.map((step) => step.state), ["complete", "complete", "current", "upcoming", "upcoming", "upcoming"]);
  assert.equal(states[2]?.label, "生成视频");
});

test("episodeStageStates:已交付终态=前五步 complete、「已交付」current", () => {
  const records: ProductionShotRecord[] = [
    { episode, shot: shotOf("s1", { selected_image_result_id: "i1", selected_video_result_id: "v1" }), media: [] },
  ];
  const states = episodeStageStates(records, { scriptHas: true, deliveredEpisodeIds: new Set(["ep1"]) });
  assert.deepEqual(states.map((step) => step.state), ["complete", "complete", "complete", "complete", "complete", "current"]);
  assert.equal(states[5]?.label, "已交付");
});

test("episodeStageStates 判定真源唯一:只做映射,不碰 selected_*/persistence_status 判定字段", () => {
  const source = stripComments(readSource("./episode-frames.ts"));
  assert.ok(source.includes("inferProductionProgress("), "阶段判定必须复用 inferProductionProgress(S77 收敛规矩)");
  const fnStart = source.indexOf("export function episodeStageStates");
  const fnEnd = source.indexOf("export function shotFrameTarget");
  const body = source.slice(fnStart, fnEnd);
  for (const token of ["selected_image_result_id", "selected_video_result_id", "persistence_status", "media_kind"]) {
    assert.ok(!body.includes(token), `episodeStageStates 又复制了判定字段 ${token}——判定真源只能有 production-progress.ts 一处`);
  }
});

/* ---------- ③ 真渲染 ---------- */

test("EpisodeStageStrip 真渲染:六步齐、当前步 aria-current=step、完成步 ✓、占位与故障态诚实", () => {
  const states = episodeStageStates([
    { episode, shot: shotOf("s1", { selected_image_result_id: "i1" }), media: [] },
  ], { scriptHas: true });
  const html = renderToStaticMarkup(React.createElement(EpisodeStageStrip, { states }));
  for (const step of PRODUCTION_STEPS) assert.ok(html.includes(step.label), `缺步骤 ${step.label}`);
  assert.ok(html.includes('aria-label="生产流程进度"'));
  assert.ok(html.includes('aria-current="step"'), "当前步缺 aria-current");
  assert.ok(html.includes("<svg"), "完成步缺 ✓ 图标");

  assert.ok(renderToStaticMarkup(React.createElement(EpisodeStageStrip, { states: null })).includes("正在读取流程进度"), "加载中不许抢答");
  assert.ok(renderToStaticMarkup(React.createElement(EpisodeStageStrip, { states: null, error: "x" })).includes("暂时无法读取"), "故障态如实交代");
});

test("ShotFrameGrid 真渲染:缩略图+镜号+场名+台词,视频帧用 video 标签,整卡是可点按钮", () => {
  const html = renderToStaticMarkup(
    React.createElement(ShotFrameGrid, {
      items: [
        { shot: shotOf("s1", { script_text: "雨夜,沈孤舟拆开一封信。" }), frame: { shotId: "s1", kind: "image" as const, url: "https://cdn/a.png", createdAt: null }, sceneName: "巷口雨夜" },
        { shot: shotOf("s2", { script_text: "面馆黄灯下,两故人隔桌无言。" }), frame: { shotId: "s2", kind: "video" as const, url: "https://cdn/b.mp4", createdAt: null }, sceneName: "面馆深夜" },
      ],
      onOpen: () => undefined,
    }),
  );
  assert.ok(html.includes('aria-label="已拍画面"'), "缺分区可访问名");
  assert.ok(html.includes("2 镜"), "缺计数");
  assert.ok(html.includes('src="https://cdn/a.png"'), "图片帧缺 src");
  assert.ok(html.includes("<video"), "视频帧应用 video 标签(与时间线带同款)");
  assert.ok(html.includes("#1") && html.includes("#2"), "缺镜号");
  assert.ok(html.includes("巷口雨夜") && html.includes("面馆深夜"), "缺场名");
  assert.ok(html.includes("雨夜,沈孤舟拆开一封信。"), "缺台词");
  assert.ok(html.includes("<button"), "整卡须为可点按钮(点击进对应分场)");
});

test("shotFrameTarget:有 scene_id 落场级工作台;缺 scene_id 退镜级换乘口", () => {
  assert.equal(shotFrameTarget("p1", "ep1", shotOf("s1")), "/projects/p1/storyboards/ep1/scenes/sc-s1");
  assert.equal(shotFrameTarget("p1", "ep1", shotOf("s9", { scene_id: null })), "/projects/p1/storyboards/ep1/shots/s9");
});

/* ---------- ④ 空状态出路 ---------- */

test("noScriptExits:必有「先去备素材」进项目资产页;有别集时给「看看别集」", () => {
  const withOther = noScriptExits("p1", { id: "ep2", label: "第 2 集" });
  assert.deepEqual(withOther.map((exit) => exit.key), ["assets", "other-episode"]);
  assert.equal(withOther[0]?.path, "/projects/p1/assets");
  assert.equal(withOther[1]?.episodeId, "ep2");
  assert.ok(withOther[1]?.label.includes("第 2 集"));

  const solo = noScriptExits("p1", null);
  assert.deepEqual(solo.map((exit) => exit.key), ["assets"], "单集项目不虚构别集出口");
});

/* ---------- ⑤ 边界:零新后端接口/零新轮询/既有锚点不丢 ---------- */

test("生产页接线源码级:用既有接口+展示件,不加轮询,旧守卫锚点不受影响", () => {
  const view = stripComments(readSource("./pages/production-view-page.tsx"));
  for (const token of ["api.shots(", "api.projectGenerations(", "api.episodeDeliveries(", "EpisodeStageStrip", "ShotFrameGrid", "noScriptExits", "shotFrameTarget("]) {
    assert.ok(view.includes(token), `生产页缺接线 ${token}`);
  }
  assert.ok(!view.includes("setInterval"), "生产页新挂了轮询——刷新只能事件驱动(15s 轮询全站只在 stepper 共享 hook)");
  assert.ok(!view.includes("/storyboards`"), "生产页仍产旧列表页 URL 字面量");
  assert.ok(!view.includes('navigate("/assets")'), "空状态出路不许裸跳,走 noScriptExits  Builder");
  const frames = stripComments(readSource("./episode-frames.ts"));
  assert.ok(!frames.includes("/storyboards"), "跳转目标必须走路由 helper(sceneWorkbenchPath/shotWorkbenchPath),不拼字面量");
});

test("episode-restore.tsx 保持 css-free(门禁可 import 真渲染),网格/阶段条不私引样式", () => {
  const component = stripComments(readSource("./episode-restore.tsx"));
  assert.ok(!component.includes(".css"), "展示件私引 css 会把门禁 import 打死");
});
