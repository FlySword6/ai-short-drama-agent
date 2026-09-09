/* ============================================================
   project-assets-director-audio-entry.test.ts — 项目资产页挂 3D 导演台 + 音色浏览入口

   产品负责人原话:「做资产必须要项目的资产界面直接可以打开生图/生音频/生视频/3D导演台
   界面」——改动前 3D 导演台是零入口成品(全仓库只有测试文件引用),音色浏览器
   (TimbreBrowser)唯一挂载点是已退役的 workbench-page.tsx(文件头写死禁止新增 import)。
   源码级断言(与 production-manual-entry.test.ts 同一先例,页面级改动走源码合同):
   ① 3D 导演台入口用已有 projectDirectorPath 拼路径,不手拼字符串,且是标题行一级按钮
      (不埋进「更多」三级菜单);
   ② 音色浏览复用已有 TimbreBrowser 组件与 Dialog 弹窗原语(本文件已用 4 处),
      不新造抽屉/弹窗 markup,按需分包(不把音色 UI 打进主资产页 bundle);
   ③ 零 import 已退役的 workbench-page.tsx;
   ④ onSelect 诚实反馈——项目资产页没有生成上下文可写入,不假装"已保存/已加入项目"。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const view = readSource("./pages/project-pages.tsx");

/* ---------- 零 import 已退役文件 ---------- */

test("项目资产页零 import 已退役的 workbench-page.tsx", () => {
  assert.ok(!view.includes('from "./workbench-page"'), "禁止 import 已退役的 workbench-page.tsx");
  assert.ok(!view.includes('from "./workbench-page.tsx"'), "禁止 import 已退役的 workbench-page.tsx");
});

/* ---------- 第一件:3D 导演台入口 ---------- */

test("3D 导演台入口用 projectDirectorPath 拼路径，不手拼字符串", () => {
  assert.ok(view.includes("projectDirectorPath"), "缺 projectDirectorPath 引用");
  const idx = view.indexOf(">3D 导演台</Button>");
  assert.ok(idx > 0, "缺 3D 导演台按钮文案");
  const chunk = view.slice(Math.max(0, idx - 400), idx + 20);
  assert.ok(chunk.includes("projectDirectorPath(projectId)"), "3D 导演台入口未用 projectDirectorPath(projectId) 拼路径");
  assert.ok(!chunk.includes("/director`"), "3D 导演台入口疑似手拼路径字符串（应调用 projectDirectorPath）");
});

test("3D 导演台按钮是标题行一级按钮，不在「更多」三级菜单里", () => {
  const moreIdx = view.indexOf("更多</Button>");
  const directorIdx = view.indexOf(">3D 导演台</Button>");
  assert.ok(moreIdx > 0 && directorIdx > 0, "缺「更多」按钮或 3D 导演台按钮");
  const menuContentStart = view.indexOf("<DropdownMenuContent", moreIdx);
  const menuContentEnd = view.indexOf("</DropdownMenu>", menuContentStart);
  assert.ok(
    directorIdx < menuContentStart || directorIdx > menuContentEnd,
    "3D 导演台按钮被埋进了「更多」下拉菜单体内",
  );
});

/* ---------- 第二件:音色浏览入口(复用 TimbreBrowser + Dialog,不新造抽屉) ---------- */

test("音色浏览复用已有 TimbreBrowser 组件(不新写音色列表 UI)", () => {
  assert.ok(view.includes('import("../components/timbre-browser")'), "音色浏览未复用现成的 TimbreBrowser 组件");
  assert.ok(view.includes("module.TimbreBrowser"), "未取用 TimbreBrowser 具名导出");
});

test("音色浏览容器复用现成 Dialog 原语(本文件已用的弹窗模式)，不新造抽屉 markup", () => {
  const idx = view.indexOf("<TimbreBrowserLazy");
  assert.ok(idx > 0, "缺音色浏览懒加载接线");
  const chunk = view.slice(Math.max(0, idx - 600), idx + 200);
  assert.ok(chunk.includes("<Dialog"), "音色浏览未挂进 Dialog 容器");
  assert.ok(!chunk.includes('role="dialog" aria-modal="true"'), "音色浏览疑似自造了 aside/overlay 抽屉 markup（应直接复用 Dialog 原语）");
});

test("音色浏览按分包加载(lazy)，不把音色 UI 打进主资产页 bundle", () => {
  assert.ok(/lazy\(\(\)\s*=>\s*\n?\s*import\("\.\.\/components\/timbre-browser"\)/.test(view), "音色浏览未按分包加载");
});

/* ---------- 第三件:onSelect 诚实反馈,不假装已保存 ---------- */

test("音色 onSelect 不假装已保存到项目——项目资产页没有生成上下文可写入", () => {
  const start = view.indexOf("function handleTimbreSelect");
  assert.ok(start > 0, "缺音色选中回调 handleTimbreSelect");
  const body = view.slice(start, start + 700);
  for (const dishonest of ["已加入项目", "已保存", "已设为项目默认", "已绑定"]) {
    assert.ok(!body.includes(dishonest), `onSelect 文案疑似假装保存了:「${dishonest}」`);
  }
  assert.ok(body.includes("notify("), "onSelect 应给出反馈,不能悄无声息");
});
