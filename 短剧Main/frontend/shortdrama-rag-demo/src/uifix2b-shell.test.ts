/* ============================================================
   uifix2b-shell.test.ts — 界面诚实修复批二 B 包守卫(壳层账号区+回收站文案)

   ① rail 账号区:任何角色名长度完整可读——rail 惯例 icon 方块+9px 尾部截断标签,
     截断只在尾部,全名进 title/aria,容器不溢出不硬裁字头(DC 实证「本地管理员→地管理员」);
   ② 回收站文案:删除确认/恢复/空态/失败/说明行全部普通人中文,
     不出现「服务端/后端/V0.1/生成记录/服务数据」这类机器话。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMenu } from "./components/user-menu";
import { demoUser } from "./demo";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** 剥注释(块注释+行注释):「用户可见文案无机器词」只看可执行代码,不被 why 注释误伤。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const operationsPages = stripComments(readSource("./pages/operations-pages.tsx"));
const globalPages = stripComments(readSource("./pages/global-pages.tsx"));
const appRail = readSource("./components/app-rail.tsx");

/* ---------- ① rail 账号区:任何长度完整可读 ---------- */

test("① compact 触发器=rail 惯例(icon 方块+9px 标签),与队列/积分同构", () => {
  const html = renderToStaticMarkup(React.createElement(UserMenu, { user: demoUser, onLogout: () => {}, compact: true }));
  assert.ok(html.includes("size-8"), "缺 icon 方块托(与 rail 其他按钮同构)");
  assert.ok(html.includes("text-[9px]"), "缺 9px 标签(rail 惯例字号)");
  assert.ok(html.includes("flex w-14 flex-col items-center"), "缺 rail 纵排结构(w-14)");
});

test("① 截断只发生在尾部:长名全名进 title/aria,label 尾部省略", () => {
  const longUser = { ...demoUser, display_name: "张三是合肥动漫部的前端实习生小李" };
  const html = renderToStaticMarkup(React.createElement(UserMenu, { user: longUser, onLogout: () => {}, compact: true }));
  assert.ok(html.includes('title="张三是合肥动漫部的前端实习生小李"'), "全名必须进 title(悬停可读)");
  assert.ok(html.includes('aria-label="账号菜单：张三是合肥动漫部的前端实习生小李"'), "全名必须进 aria");
  assert.ok(html.includes("truncate"), "标签缺尾部截断");
  /* 短名全显(9px 下 2-5 个汉字放得下) */
  const shortHtml = renderToStaticMarkup(React.createElement(UserMenu, { user: { ...demoUser, display_name: "李明" }, onLogout: () => {}, compact: true }));
  assert.ok(shortHtml.includes("李明"), "短名应完整显示");
});

test("① 旧肇事结构清场:pill 居中溢出结构不再,middleEllipsis 退役", () => {
  const userMenu = readSource("./components/user-menu.tsx");
  assert.ok(!userMenu.includes("middleEllipsis"), "middleEllipsis 死码未清");
  const compactBranch = userMenu.slice(userMenu.indexOf("const trigger = compact"), userMenu.indexOf(") : ("));
  assert.ok(!compactBranch.includes("rounded-full"), "rail 触发器仍是 pill 结构(裁字头的肇事结构)");
  assert.ok(appRail.includes("compact menuSide="), "rail 仍应传 compact+menuSide");
});

/* ---------- ② 回收站文案:四态全部普通人中文 ---------- */


test("② 删除确认(项目/回收站永久删除弹窗):无机器话,吓人话换因果话", () => {
  assert.ok(!globalPages.includes("服务端会再次检查"), "项目删除确认仍说「服务端检查」");
  assert.ok(globalPages.includes("永久删除后无法恢复，系统会先检查它是否仍被使用"), "项目删除确认缺因果说明");
  assert.ok(!operationsPages.includes("服务端会先检查项目引用、生成记录和外部文件"), "永久删除弹窗仍堆机器话");
  assert.ok(operationsPages.includes("系统会先检查它是否仍被使用"), "永久删除弹窗缺「仍被使用」因果");
});

test("② 项目内单删说明行:「后端回收站 V0.1」机器话清账", () => {
  assert.ok(!operationsPages.includes("后端回收站 V0.1"), "「后端回收站 V0.1」仍在");
  assert.ok(operationsPages.includes("恢复能力会在后续版本补齐"), "缺「后续版本补齐」的人话落点");
});

test("② demo 说明行与空态:无「服务数据」,空态人话保持", () => {
  assert.ok(!operationsPages.includes("服务数据"), "demo 说明行仍说「服务数据」");
  assert.ok(operationsPages.includes("回收站是空的"), "空态标题丢了");
  assert.ok(operationsPages.includes("保留 180 天"), "180 天保留期口径丢了");
});

test("② 全文红线:回收站用户可见文案无机器词", () => {
  /* 回收站页全区(TrashPage 函数体)+两处删除确认弹窗——管理后台成本页的「服务端账本」
     属管理员语境,不在本包红线内(分批,别误伤)。 */
  const trashPage = operationsPages.slice(operationsPages.indexOf("function TrashPage"), operationsPages.indexOf("export function EpisodePlaybackModal"));
  for (const word of ["服务端", "后端", "V0.1", "生成记录", "服务数据", "消耗历史", "生成历史", "条目", "操作失败"]) {
    assert.ok(!trashPage.includes(word), `回收站页仍含机器词「${word}」`);
  }
  assert.ok(!globalPages.includes("服务端会再次检查"), "项目删除确认仍说「服务端检查」");
  assert.ok(!globalPages.includes("永久删除前服务端还会检查"), "资产删除确认仍说「服务端检查」");
  /* 恢复/失败态:人话出口在 */
  assert.ok(operationsPages.includes("还原后回到项目列表"), "恢复去向提示丢了");
  assert.ok(operationsPages.includes('"还原失败，请重试"'), "恢复失败人话丢了");
});
