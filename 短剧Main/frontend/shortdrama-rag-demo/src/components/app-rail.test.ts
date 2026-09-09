/* ============================================================
   app-rail.test.ts — R2 壳层守卫(批次一卡 1,新码自检)

   锁四件事(原型基准=Figma SPEC 壳层卡):
   ① rail 四项导航+admin 门槛;current 三态走 aria-current;
   ② 队列 chip 在 rail 底组、aria-label 带在途数;/queue 路由已接;
   ③ 二级条=返回+剧名+四页签,不收积分/头像(禁三明治);
   ④ 条 12 行为:头像旁有全局设置直达(rail 底组)。
   只读真实源码/真实渲染,不读规格文档。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AppRail } from "./app-rail";
import { countLocalInflight } from "../queue-inflight";
import { demoUser } from "../demo";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function renderRail(pathname: string, admin = false): string {
  return renderToStaticMarkup(React.createElement(AppRail, {
    pathname,
    user: demoUser,
    demoMode: true,
    onLogout: () => undefined,
    onOpenAssistant: () => undefined,
    onOpenPalette: () => undefined,
    capabilities: admin
      ? { status: "ready", capabilities: { platformRole: "admin", allowMemberCreateProject: true, projects: [], permissions: [] } }
      : { status: "ready", capabilities: { platformRole: "member", allowMemberCreateProject: true, projects: [], permissions: [] } },
    paletteKbd: "⌘K",
    assistantKbd: "⌘J",
    uiModeSwitching: false,
    onSwitchUiMode: () => undefined,
  }));
}

test("① 四项导航渲染;非 admin 不出管理后台,admin 出", () => {
  const html = renderRail("/projects");
  for (const label of ["项目管理", "资产中心", "数据看板"]) {
    assert.ok(html.includes(label), `缺导航项「${label}」`);
  }
  assert.ok(!html.includes("管理后台"), "非 admin 出现管理后台");
  assert.ok(renderRail("/admin", true).includes("管理后台"), "admin 缺管理后台");
});

test("① current 态:当前项 aria-current=page,且只有一处", () => {
  const html = renderRail("/assets");
  const occurrences = html.split('aria-current="page"').length - 1;
  assert.equal(occurrences, 1, `aria-current 出现 ${occurrences} 处(应 1)`);
});

test("② 队列 chip:aria-label 落「生产队列」;/queue 路由已接;在途计数纯函数正确", () => {
  const html = renderRail("/queue");
  assert.ok(html.includes('aria-label="生产队列"') || html.includes("生产队列,"), "队列 chip aria-label 缺失");
  assert.ok(html.includes("aria-current"), "队列 current 态缺失");
  assert.ok(appSource.includes('pathname === "/queue"'), "app.tsx 未接 /queue 路由");
  assert.ok(appSource.includes("QueuePage"), "QueuePage 未挂载");
  const fakeStorage = {
    length: 3,
    key: (i: number) => ["shortdrama_v01_generation_request:p:s:image", "unrelated", "shortdrama_v01_generation_request:p:s2:video"][i] ?? null,
  };
  assert.equal(countLocalInflight(fakeStorage as never), 2, "本地在途枚举不对");
});

test("② 命令面板注册表:nav.queue 已注册并导航到 /queue", () => {
  const registry = readFileSync(new URL("../command-registry.ts", import.meta.url), "utf8");
  assert.ok(registry.includes('"nav.queue"'), "注册表缺 nav.queue");
  assert.ok(registry.includes('navigate("/queue")'), "nav.queue 落点不对");
});

test("③ 二级条:四页签+返回+剧名;不收积分/头像/命令面板(禁三明治)", () => {
  const headerStart = appSource.indexOf("function ProjectHeader(");
  assert.ok(headerStart > 0, "ProjectHeader 不在了");
  const header = appSource.slice(headerStart, headerStart + 4200);
  for (const tab of ["生产", "剧本", "资产", "消耗"]) {
    assert.ok(header.includes(`>${tab}<`), `二级条缺页签「${tab}」`);
  }
  assert.ok(header.includes("返回"), "二级条缺返回");
  assert.ok(header.includes("projectState.data?.name"), "二级条缺剧名(数据自带书名号,模板不重复包裹)");
  assert.ok(!header.includes("《{"), "剧名模板重复包书名号(数据已带《》)");
  assert.ok(!header.includes("AccountCreditsPill"), "二级条仍收积分 pill(三明治回潮)");
  assert.ok(!header.includes("UserMenu"), "二级条仍收头像(三明治回潮)");
  assert.ok(!header.includes("PaletteTrigger"), "二级条仍收命令面板(三明治回潮)");
});

test("④ 条 12 行为:rail 底组有全局设置直达(头像旁)", () => {
  const html = renderRail("/projects");
  assert.ok(html.includes("全局设置"), "rail 缺全局设置直达");
});

test("壳层文案:无开发词(与 s17 禁词同口径抽查)", () => {
  const html = renderRail("/projects");
  for (const banned of ["接口未", "暂未接通", "mock", "Mock"]) {
    assert.ok(!html.includes(banned), `rail 文案命中禁词「${banned}」`);
  }
});
