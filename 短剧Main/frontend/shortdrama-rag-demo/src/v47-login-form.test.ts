/* ============================================================
   v47-login-form.test.ts — V-47 登录形态收口守卫

   形态合同(设计线 2026-08-04 拍定):
   ①LoginCard 独立成文件(pages/login-card.tsx),global-pages 不再有 LoginPage/LoginCard;
   ②整页登录退役:登出/401/未登录深链三条路全走 loginEntryPathFor→落地页+自动展开登录卡,
     redirect 照传,登录成功回原位;/login 换乘;
   ③「回到片场,接着拍」与 V{APP_VERSION} 页脚随整页死;
   ④品牌位不进弹窗(无 kicker/副文案/BrandLockup);
   ⑤旧形态锁(s8-login-brand.test.ts/login-hero-shader.tsx)已拆;
   弹层专属样式(landing-login-*)与登录卡样式(login-panel 等)保留。
   ============================================================ */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loginEntryPathFor } from "./routing";
import { LoginCard } from "./pages/login-card";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
function fileGone(relativePath: string): boolean {
  return !existsSync(new URL(relativePath, import.meta.url));
}

const appShell = readSource("./app.tsx");
const globalPages = readSource("./pages/global-pages.tsx");
const landing = readSource("./pages/landing-page.tsx");
const loginCardSource = readSource("./pages/login-card.tsx");
const tkLoginCss = readSource("./styles/tk-login.css");

/* ---------- ① LoginCard 独立成文件;global-pages 无登录页/登录卡 ---------- */

test("① LoginCard 独立文件;global-pages 不再定义/引用 LoginPage 与 LoginCard", () => {
  assert.ok(!globalPages.includes("export function LoginPage"), "LoginPage 仍在 global-pages");
  assert.ok(!globalPages.includes("export function LoginCard"), "LoginCard 仍在 global-pages");
  assert.ok(!globalPages.includes("login-hero-shader"), "global-pages 仍引 shader");
  assert.ok(!globalPages.includes("BrandLockup"), "global-pages 仍留品牌位引用");
});

/* ---------- ② 三条路同走 loginEntryPathFor;全站无 LoginPage 渲染引用 ---------- */

test("② app.tsx:无 LoginPage import/渲染;三条路全部 loginEntryPathFor→/landing", () => {
  assert.ok(!appShell.includes("LoginPage"), "app.tsx 仍有 LoginPage 引用");
  assert.ok(!appShell.includes("loginPathFor"), "app.tsx 仍用旧 loginPathFor");
  /* 未登录深链(boot)+me() 失败+401 兜底+登出+换账号,五处换乘全在新函数上 */
  const uses = appShell.split("loginEntryPathFor(").length - 1;
  assert.ok(uses >= 5, `loginEntryPathFor 调用点不足(=${uses}),三条路没接全`);
  assert.ok(appShell.includes('pathname === "/login"'), "缺 /login 换乘分支");
});

test("② loginEntryPathFor 语义:深链带参;/login 带参原样换乘;裸地址给默认去向;已落地保留参数", () => {
  assert.equal(loginEntryPathFor("/projects/p1/assets?kind=scene"), "/landing?redirect=%2Fprojects%2Fp1%2Fassets%3Fkind%3Dscene");
  assert.equal(loginEntryPathFor("/login?redirect=%2Fprojects%2Fp1"), "/landing?redirect=%2Fprojects%2Fp1");
  assert.equal(loginEntryPathFor("/login"), "/landing?redirect=/projects");
  assert.equal(loginEntryPathFor("/"), "/landing?redirect=/projects");
  assert.equal(loginEntryPathFor("/landing?redirect=%2Fassets"), "/landing?redirect=%2Fassets", "401 事件与 boot catch 连跳两次,第二跳不得抹掉 redirect");
});

test("② 落地页:URL 带 redirect 挂载即自动展开登录卡", () => {
  assert.ok(landing.includes("safeRedirectTarget(window.location.search)"), "落地页未按 redirect 自动展开");
  assert.ok(landing.includes('from "./login-card"'), "落地页未从独立文件引 LoginCard");
});

/* ---------- ③④ 卡内:旧标题/版本号/品牌位全灭,任务纯粹 ---------- */

test("③④ LoginCard 渲染:标题「登录/创建账号」,无旧标语无 kicker 无版本号无品牌位", () => {
  const html = renderToStaticMarkup(React.createElement(LoginCard, { onAuthenticated: () => {} }));
  assert.ok(html.includes(">登录</h1>"), "缺任务化标题「登录」");
  assert.ok(!html.includes("回到片场"), "旧标语「回到片场,接着拍」未随葬");
  assert.ok(!html.includes("一站式 AI 短剧平台"), "kicker 未摘(品牌位不进弹窗)");
  assert.ok(!html.includes("进度随时接着"), "副文案未摘");
  assert.ok(!loginCardSource.includes("APP_VERSION"), "登录卡仍引版本号");
  assert.ok(!loginCardSource.includes("BrandLockup"), "登录卡仍引品牌位");
  /* 表单要件不破:字段/忘记密码/注册切换 */
  assert.ok(html.includes("忘记密码"), "忘记密码出路丢了");
  assert.ok(html.includes("没有账号？注册一个"), "注册切换丢了");
});

/* ---------- ⑤ 旧形态锁已拆;CSS 只剩卡与弹层 ---------- */

test("⑤ 旧形态文件全灭(s8 守卫/login-hero-shader/整页 CSS 类)", () => {
  assert.ok(fileGone("./pages/login-hero-shader.tsx"), "login-hero-shader.tsx 未删");
  assert.ok(fileGone("./s8-login-brand.test.ts"), "s8-login-brand.test.ts 未拆");
  for (const dead of ["login-page", "aurora-field", "grain-overlay", "login-vignette", "vf-corner", "login-brand-row", "login-hero", "login-poster", "login-credits", "login-kicker"]) {
    assert.ok(!tkLoginCss.includes(`.${dead}`), `整页 CSS 类 .${dead} 未清`);
  }
  for (const alive of [".login-panel", ".login-form", ".login-heading", ".login-field-note", ".landing-login-overlay", ".landing-login-card"]) {
    assert.ok(tkLoginCss.includes(alive), `弹层/卡样式 ${alive} 被误删`);
  }
});
