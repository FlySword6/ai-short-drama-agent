/* ============================================================
   s74-no-unused-locals.test.ts — noUnusedLocals 门禁与它清出的死枝(前端侧)

   背景:S12 引入的 ProjectCostAggregateBlock「只赋值给局部变量、从不渲染」
   在仓库里活到 S73 才被人工发现。根因不是那次疏忽,是 tsconfig 没开
   noUnusedLocals,typecheck 报不出来。S74 把门禁打开并清净存量。

   本文件守两件事:
   ① 门禁本身还开着(两份 tsconfig 都有 noUnusedLocals)——没了门禁,下面的
      断言就只是一次性打扫,死枝会照旧长回来;
   ② 判定为「产品上要」的那处真的接回了渲染(走 renderToStaticMarkup 真渲染,
      不是源码字符串);判定为「删净」的几处不留半套。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ReferenceList } from "./components/reference-lanes";
import { emptyLanesState, laneCompleteness, laneDef } from "./reference-lanes";

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/** 剥注释(块注释+行注释),「符号不存在」类断言只看可执行代码,不被考古注释误伤。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 渲染参考清单:state 直接给,组定义走词表内置快照(与页面同源)。 */
function renderLanes(state: Parameters<typeof ReferenceList>[0]["state"]): string {
  return renderToStaticMarkup(React.createElement(ReferenceList, {
    state,
    demoMode: true,
    onLaneAction: () => undefined,
    onPickFromLibrary: () => undefined,
    onRemoveItem: () => undefined,
    onSaveCameraNote: () => undefined,
  }));
}

/** 取第一组(角色)的完备度页脚切片。 */
function firstFooter(html: string): string {
  const match = html.match(/<footer[^>]*>[\s\S]*?<\/footer>/);
  assert.ok(match, "参考组卡片没渲染出完备度页脚");
  return match[0];
}

/* ---------- ① 门禁本身 ---------- */

test("S74 门禁:前后端两份 tsconfig 都开着 noUnusedLocals", () => {
  const frontend = JSON.parse(readSource("../tsconfig.json")) as { compilerOptions?: Record<string, unknown> };
  const backend = JSON.parse(readSource("../../../tsconfig.json")) as { compilerOptions?: Record<string, unknown> };
  assert.equal(
    frontend.compilerOptions?.noUnusedLocals, true,
    "前端 tsconfig 关掉了 noUnusedLocals——死枝会重新变成 typecheck 报不出来的东西",
  );
  assert.equal(
    backend.compilerOptions?.noUnusedLocals, true,
    "后端 tsconfig 关掉了 noUnusedLocals",
  );
});

/* ---------- ② 判定「产品上要」:参考组完备度接回渲染 ---------- */

test("S74 渲染:空组的完备度页脚逐条列出建议要素,未满足是 Minus 不是对勾", () => {
  const footer = firstFooter(renderLanes(emptyLanesState()));
  const expected = laneCompleteness(laneDef("character"), []);
  for (const label of [...expected.missingRequired, ...expected.missingOptional]) {
    assert.ok(footer.includes(label), `完备度页脚缺建议要素「${label}」`);
  }
  assert.ok(footer.includes('class="size-3"'), "未满足要素必须是 Minus(灰)");
  assert.ok(!footer.includes("text-success"), "空组不该出现满足态对勾");
  assert.ok(footer.includes("（可选）"), "增强要素必须标「（可选）」,不与必备项混为一谈");
});

test("S74 渲染:组里有条目后,同一批要素翻成满足态对勾", () => {
  const footer = firstFooter(renderLanes({
    ...emptyLanesState(),
    character: [{ id: "asset:a1", name: "任天野", kind: "image", origin: "asset" }],
  }));
  const expected = laneCompleteness(laneDef("character"), [
    { id: "asset:a1", name: "任天野", kind: "image", origin: "asset" },
  ]);
  assert.equal(expected.missingRequired.length, 0, "判定真源认为仍有缺口,前提就不成立");
  assert.ok(footer.includes('class="size-3 text-success"'), "满足要素必须是对勾(绿)");
  assert.ok(!/class="size-3"[^]*?<\/footer>/.test(footer.replace(/class="size-3 text-success"/g, "")),
    "满足态下不该还留着 Minus");
});

test("S74 判定真源唯一:视图层消费 laneCompleteness,不再内联复算「有条目即到位」", () => {
  const view = stripComments(readSource("./components/reference-lanes.tsx"));
  assert.ok(
    view.includes("completeness.satisfied.includes(element.key)"),
    "完备度页脚没消费 laneCompleteness——算了不用就是 S12 死枝那个形状",
  );
  assert.ok(
    !/const satisfied = has;/.test(view),
    "视图层又内联复刻了一份完备度规则,两处各写一遍必然漂移",
  );
});

/* ---------- ③ 判定「删净」:不留只赋值不渲染的半套 ---------- */

test("S74 死枝:工作台页面级整集分镜取数删净(取数改由 ProductionStepper / EpisodeTimeline 各自承接)", () => {
  const workbench = stripComments(readSource("./pages/workbench-page.tsx"));
  assert.ok(
    !workbench.includes("episodeShotsState"),
    "episodeShotsState 复活了——它是一次真实网络请求且从没被读过",
  );
  /* 衔接功能没坏,只是取数源换了地方:跨集「下一个待生成」在 ProductionStepper,
     本集时间线在 EpisodeTimeline 自取。两处都还在,才轮得到删页面级那一份。 */
  assert.ok(
    stripComments(readSource("./production-progress.ts")).includes("missingImage"),
    "「下一个待生成分镜」的推导没了,页面级取数就不该删",
  );
  assert.ok(workbench.includes("function EpisodeTimeline"), "整集时间线没了");
});

test("S74 死枝:导演台快照的反向转换助手删净(加载端统一走带运行时校验的 readVec)", () => {
  const snapshot = stripComments(readSource("./components/director/snapshot.ts"));
  assert.ok(!snapshot.includes("xyzToVec"), "xyzToVec 复活了——加载端入参是 unknown,必须走带校验的 readVec");
  assert.ok(!snapshot.includes("isBackendAspect"), "isBackendAspect 复活了");
  assert.ok(snapshot.includes("function readVecFlexible"), "readVecFlexible 没了,反向转换就没有承接方");
});

test("S74 死枝:全局页不再直连 package.json,版本号仍是 version.ts 单一来源(V-47 后全局页已不用版本号)", () => {
  const globalPages = stripComments(readSource("./pages/global-pages.tsx"));
  assert.ok(
    !globalPages.includes('from "../../package.json"'),
    "全局页又直接读 package.json——版本号单一来源=src/version.ts(S14-13)",
  );
  assert.ok(!globalPages.includes("V{APP_VERSION}"), "整页登录页脚版本号未随葬(V-47)");
});
