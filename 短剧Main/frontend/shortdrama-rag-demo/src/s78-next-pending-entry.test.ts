/* ============================================================
   s78-next-pending-entry.test.ts — 工作台内「去下一个待生成分镜」一键入口(统筹裁决 R68)

   背景:S77 回执(docs/validation/v011-s74-no-unused-locals-handoff.md §2①)查证——
   「去下一个待生成分镜」一直由 ProductionStepper 承接,但工作台是 fullBleed,
   stepper 不在工作台内渲染;人在工作台生成完一条,想去下一条待生成的,
   得展开时间线自己认哪格写「待生成」。S78 把入口补进工作台。

   本文件守三件事:
   ① 真渲染(renderToStaticMarkup,不是源码里搜得到就算数):
      有待生成=入口可见可点(整行一个活按钮,带目标「第 N 集 #M · 缺什么」);
      无待生成=完成态(清零文案 + 连播活按钮,不渲染死按钮);
      当前这条是唯一待生成=非交互提示(指向自己的按钮是死按钮,不渲染);
   ② 判定真源唯一:入口消费 inferProductionProgress(S77 立的收敛规矩),
      recordsStartingAfterCurrent 只做扫描顺序重排,函数体里不许出现
      selected_/persistence_status/media_kind 任何判定字段;
   ③ 刷新触发器唯一:production-progress-changed 事件 + 15s 轮询只在
      useProductionShotRecords 一处,入口组件自己不挂监听与定时器(不加新轮询)。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  NextPendingShotEntry,
  nextPendingTarget,
  recordsStartingAfterCurrent,
} from "./production-stepper";
import { inferProductionProgress, type ProductionShotRecord } from "./production-progress";

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/** 剥注释(块注释+行注释),「不出现某规则」类断言只看可执行代码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const episode1 = { id: "episode-1", project_id: "project-1", episode_no: 1 };
const episode3 = { id: "episode-3", project_id: "project-1", episode_no: 3 };

/** done=true 造一条「图+视频+主版本齐」的分镜;否则默认全缺(待生成图片)。 */
function record(episode: typeof episode1, id: string, shotNo: string, done = false): ProductionShotRecord {
  return {
    episode,
    shot: done
      ? { id, episode_id: episode.id, shot_no: shotNo, selected_video_result_id: `video-${id}` }
      : { id, episode_id: episode.id, shot_no: shotNo },
    media: done
      ? [
          { id: `image-${id}`, media_kind: "image", persistence_status: "persisted", storage_url: "https://example.test/i.bin" },
          { id: `video-${id}`, media_kind: "video", persistence_status: "persisted", storage_url: "https://example.test/v.bin" },
        ]
      : [],
  };
}

function renderEntry(props: {
  records: ProductionShotRecord[] | null;
  shotId?: string;
  error?: string;
}): string {
  return renderToStaticMarkup(React.createElement(NextPendingShotEntry, {
    records: props.records,
    projectId: "project-1",
    episodeId: "episode-1",
    shotId: props.shotId ?? "shot-1",
    error: props.error,
    onRetry: () => undefined,
  }));
}

/* ---------- ① 真渲染三态 ---------- */

test("S78 渲染:有待生成=入口可见可点,目标是从当前往后数的下一条(旋转扫描)", () => {
  const html = renderEntry({
    records: [record(episode1, "shot-1", "1"), record(episode1, "shot-2", "2"), record(episode1, "shot-3", "3")],
    shotId: "shot-1",
  });
  assert.ok(html.includes("<button"), "有待生成时入口必须是可点的活按钮");
  assert.ok(!html.includes("disabled"), "入口按钮不许是禁用死按钮");
  assert.ok(html.includes("下一个待生成：第 1 集 #2"), "当前在 #1,下一个待生成应是 #2");
  assert.ok(!html.includes("下一个待生成：第 1 集 #1"), "入口不许指向当前分镜自身");
  assert.ok(html.includes("还缺图片"), "目标信息要带上缺什么(判定来自 inferProductionProgress)");
  assert.ok(html.includes("去生成图片"), "动作文案复用 progress.actionLabel,与 stepper 同口径");
  assert.ok(!html.includes("button-primary"), "入口不做第二个实心主按钮(V-31 否决清单 #5)");
});

test("S78 渲染:下一个待生成在别的集,目标信息带跨集集号", () => {
  const html = renderEntry({
    records: [record(episode1, "shot-1", "1"), record(episode3, "shot-5", "5")],
    shotId: "shot-1",
  });
  assert.ok(html.includes("下一个待生成：第 3 集 #5"), "跨集目标必须显示它所在的集");
  assert.ok(html.includes('aria-label="去下一个待生成分镜：第 3 集 #5"'), "可访问名要带完整目标");
});

test("S78 渲染:无待生成=完成态(清零文案 + 连播活按钮),不渲染死按钮", () => {
  const html = renderEntry({
    records: [record(episode1, "shot-1", "1", true), record(episode1, "shot-2", "2", true)],
    shotId: "shot-1",
  });
  assert.ok(html.includes("待生成项已清零"), "完成态要有清零文案");
  assert.ok(html.includes("本集连播与交付"), "完成态给出的是连播活动作,不是灰掉的死按钮");
  assert.ok(html.includes("<button"), "完成态按钮(去连播)必须真实可点");
  assert.ok(!html.includes("disabled"), "完成态不许渲染禁用按钮");
  assert.ok(!html.includes("下一个待生成"), "完成态不再显示「下一个待生成」");
});

test("S78 渲染:当前这条是唯一待生成=非交互提示,不渲染指向自身的死按钮", () => {
  const html = renderEntry({
    records: [record(episode1, "shot-1", "1", true), record(episode1, "shot-2", "2"), record(episode1, "shot-3", "3", true)],
    shotId: "shot-2",
  });
  assert.ok(html.includes("当前这条就是最后一个待生成分镜"), "唯一待生成=当前时要说人话");
  assert.ok(!html.includes("<button"), "指向当前页的跳转按钮是死按钮,不许渲染");
  assert.ok(html.includes('role="status"'), "非交互提示用语义节点,不是按钮");
});

test("S78 渲染:读取中与读取失败两态如实显示,失败给活的重试", () => {
  const loading = renderEntry({ records: null });
  assert.ok(loading.includes("正在查找下一个待生成分镜…"), "读取中要有等待文案");
  assert.ok(loading.includes('aria-busy="true"'), "读取中要有 aria-busy");
  const failed = renderEntry({ records: null, error: "网络错误" });
  assert.ok(failed.includes("生产进度暂时无法读取"), "失败要如实说");
  assert.ok(failed.includes("重试"), "失败给活的重试按钮");
});

/* ---------- ①b 跳转目标与扫描顺序(纯函数行为) ---------- */

test("S78 顺序:recordsStartingAfterCurrent 只重排不判定,当前之后起扫、尾部绕回", () => {
  const records = [record(episode1, "shot-1", "1"), record(episode1, "shot-2", "2"), record(episode1, "shot-3", "3")];
  assert.deepEqual(recordsStartingAfterCurrent(records, "shot-2").map((item) => item.shot.id), ["shot-3", "shot-1", "shot-2"]);
  assert.deepEqual(recordsStartingAfterCurrent(records, "shot-3").map((item) => item.shot.id), ["shot-1", "shot-2", "shot-3"], "当前是末条时绕回开头");
  assert.deepEqual(recordsStartingAfterCurrent(records, "shot-404").map((item) => item.shot.id), ["shot-1", "shot-2", "shot-3"], "当前不在列表时原样返回");
});

test("S78 语义:旋转后 inferProductionProgress 的第一个待生成=从当前往后数的下一个", () => {
  const records = [record(episode1, "shot-1", "1"), record(episode1, "shot-2", "2"), record(episode1, "shot-3", "3")];
  assert.equal(inferProductionProgress(recordsStartingAfterCurrent(records, "shot-1")).shotId, "shot-2");
  assert.equal(inferProductionProgress(recordsStartingAfterCurrent(records, "shot-3")).shotId, "shot-1", "末条之后绕回全项目最早一条待生成");
});

test("S78 跳转:缺图/缺视频→该分镜工作台;待选主版本→带 ?library=1;交付态→连播当前集", () => {
  const records = [record(episode1, "shot-1", "1"), record(episode1, "shot-2", "2")];
  const imageProgress = inferProductionProgress(recordsStartingAfterCurrent(records, "shot-1"));
  assert.equal(nextPendingTarget("project-1", imageProgress, "episode-1"), "/projects/project-1/storyboards/episode-1/shots/shot-2");

  const primaryRecords = records.map((item) => ({
    ...item,
    media: [
      { id: `image-${item.shot.id}`, media_kind: "image" as const, persistence_status: "persisted" as const, storage_url: "https://example.test/i.bin" },
      { id: `video-${item.shot.id}`, media_kind: "video" as const, persistence_status: "persisted" as const, storage_url: "https://example.test/v.bin" },
    ],
  }));
  const primaryProgress = inferProductionProgress(recordsStartingAfterCurrent(primaryRecords, "shot-1"));
  assert.equal(primaryProgress.current, "primary", "前提:图视频齐、主版本未选");
  assert.equal(nextPendingTarget("project-1", primaryProgress, "episode-1"), "/projects/project-1/storyboards/episode-1/shots/shot-2?library=1");

  const doneProgress = inferProductionProgress(recordsStartingAfterCurrent(primaryRecords.map((item) => ({
    ...item,
    shot: { ...item.shot, selected_video_result_id: `video-${item.shot.id}` },
  })), "shot-1"));
  assert.equal(doneProgress.current, "delivery", "前提:全部就绪");
  assert.equal(
    nextPendingTarget("project-1", doneProgress, "episode-1"),
    "/projects/project-1/production?episode=episode-1&playback=1",
    "工作台语境下交付态连播当前集(块 2 起列表级落点=生产页)",
  );
});

/* ---------- ② 判定真源唯一 ---------- */

test("S78 判定收敛:入口消费 inferProductionProgress,旋转函数体零判定字段", () => {
  const source = stripComments(readSource("./production-stepper.tsx"));
  assert.ok(
    source.includes("inferProductionProgress(recordsStartingAfterCurrent(records, shotId))"),
    "入口必须消费共享判定 inferProductionProgress + 旋转后的记录,不许另起炉灶",
  );
  const rotation = source.slice(
    source.indexOf("export function recordsStartingAfterCurrent"),
    source.indexOf("export function nextPendingTarget"),
  );
  for (const field of ["selected_", "persistence_status", "media_kind"]) {
    assert.ok(!rotation.includes(field), `旋转函数出现判定字段 ${field}——「什么算待生成」又复制了一份`);
  }
});

test("S78 判定收敛:工作台页只接线 hook 与组件,不自己写「待生成」判定", () => {
  const workbench = stripComments(readSource("./pages/workbench-page.tsx"));
  assert.ok(workbench.includes("useProductionShotRecords("), "工作台入口必须复用 stepper 同源取数 hook");
  assert.ok(workbench.includes("<WorkbenchNextPending"), "入口没接进工作台渲染");
  assert.ok(!workbench.includes("hasPersistedMedia"), "工作台又复制了一份媒体判定——判定真源只能有 production-progress.ts 一处");
});

/* ---------- ③ 刷新触发器唯一 + 挂载点纪律 ---------- */

test("S78 刷新唯一:事件监听与 15s 轮询全站只在共享 hook 一处,入口组件不挂定时器", () => {
  const source = stripComments(readSource("./production-stepper.tsx"));
  assert.equal(source.split("setInterval").length - 1, 1, "轮询只能有一份(共享 hook 内)");
  assert.equal(source.split('addEventListener("production-progress-changed"').length - 1, 1, "事件监听只能有一份");
  const entry = source.slice(source.indexOf("export function NextPendingShotEntry"));
  for (const token of ["useEffect", "setInterval", "addEventListener"]) {
    assert.ok(!entry.includes(token), `入口组件自己挂了 ${token}——刷新必须复用既有 hook,不加新轮询`);
  }
});

test("S78 挂载纪律:stepper 样式由 app.tsx 挂载点引入,组件文件保持 css-free(门禁才能真渲染 import)", () => {
  const stepper = stripComments(readSource("./production-stepper.tsx"));
  assert.ok(!stepper.includes(".css"), "production-stepper.tsx 又直接 import 了 css——门禁 import 它会被 Unknown file extension 打死");
  const app = stripComments(readSource("./app.tsx"));
  assert.ok(app.includes('import "./production-stepper.css"'), "app.tsx 挂载点丢了 stepper 样式");
});
