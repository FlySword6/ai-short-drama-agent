/* ============================================================
   uiux-fix1.test.ts — UIUX 审计第一批(auth/账号域)修复断言

   逐 F 销账（审计报告 outputs/uiux-sim-audit-20260804.md）:
   F05 首页第二按钮不许空愿;F06 邀请码第一栏+报错保住已发验证码;
   F07 忘记密码指路;F08 登录字段标签按部署形态;F09 菜单不透明+图层+余额行提顶;
   F10 账号名中段省略;F11 积分双口径解释行;F12 项目页右上账号入口;
   代码审两尾巴:密码规则前端真校验、登录错误码表化(不裸透传)。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiClientError } from "./api";
import { AccountCreditsMenuRow } from "./components/credits-pill";
import { UserMenu } from "./components/user-menu";
import { LoginCard } from "./pages/login-card";
import {
  PASSWORD_MIN_LENGTH,
  RegisterForm,
  loginErrorMessage,
  registerErrorMessage,
} from "./pages/register-form";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const landing = readSource("./pages/landing-page.tsx");
const loginCard = readSource("./pages/login-card.tsx");
const dropdownMenu = readSource("./components/ui/dropdown-menu.tsx");
const userMenu = readSource("./components/user-menu.tsx");
const appRail = readSource("./components/app-rail.tsx");
const appShell = readSource("./app.tsx");
const registerFormSource = readSource("./pages/register-form.tsx");

const demoUser = { id: "u1", username: "u-194887a7a0b8d2218dda8f3c9f1e2b", display_name: "kimi2-fe-1785844493461", role: "member" as const, ui_mode: "full" as const, active: true, created_at: "2026-08-04T00:00:00Z" };

/* ---------- F05:首页第二按钮不许空愿 ---------- */

test("F05:第二按钮改说真话「登录进片场」,空愿文案清除", () => {
  assert.ok(!landing.includes("先看一集怎么拍"), "「先看一集怎么拍」仍在——演示不存在不许承诺");
  assert.ok(landing.includes("登录进片场"), "缺诚实文案「登录进片场」");
});

/* ---------- F06:邀请码第一栏 + 报错保住已发验证码 ---------- */

test("F06 渲染:邀请码是注册表单第一栏(先于邮箱/验证码)", () => {
  const html = renderToStaticMarkup(React.createElement(RegisterForm, { sendCode: async () => {}, register: async () => {} }));
  const inviteAt = html.indexOf("邀请码");
  const emailAt = html.indexOf("邮箱");
  const codeAt = html.indexOf("验证码");
  assert.ok(inviteAt >= 0 && emailAt > inviteAt && codeAt > inviteAt, "邀请码必须是第一栏(最贵往返最先暴露)");
});

test("F06 文案:验证码已发出时,邀请码报错告知「仍有效,直接重提」", () => {
  const make = (code: string) => new ApiClientError(code, { status: 422, code });
  const invalidSent = registerErrorMessage(make("invite_code_invalid"), { codeSent: true });
  assert.ok(invalidSent.includes("仍然有效"), "已发码时报错必须保住验证码");
  assert.ok(invalidSent.includes("直接重新提交"), "要给「改对直接重提」的动作");
  const invalidFresh = registerErrorMessage(make("invite_code_invalid"));
  assert.ok(!invalidFresh.includes("仍然有效"), "没发码时不画蛇添足");
  assert.ok(registerErrorMessage(make("invite_code_required"), { codeSent: true }).includes("仍然有效"), "缺码同口径");
});

/* ---------- 代码审尾巴①:密码规则前端真校验 ---------- */

test("密码规则:前端真校验最少 8 位(与后端默认 AUTH_PASSWORD_MIN_LENGTH 对齐)", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.ok(registerFormSource.includes("password.length < PASSWORD_MIN_LENGTH"), "缺密码长度前端校验");
  assert.ok(registerFormSource.includes("密码至少"), "缺密码长度人话报错");
});

/* ---------- F07/F08:登录卡出路与字段标签 ---------- */

test("F07 渲染:登录卡给「忘记密码找管理员重置」出路", () => {
  const html = renderToStaticMarkup(React.createElement(LoginCard, { onAuthenticated: () => {} }));
  assert.ok(html.includes("忘记密码"), "缺忘记密码出路");
  assert.ok(html.includes("联系管理员重置"), "出路要指到人(管理员)");
});

test("F08 渲染:开放自注册形态字段叫「邮箱」,不再「邮箱或账号」(遗留账号口径只留在关闭注册的部署)", () => {
  const html = renderToStaticMarkup(React.createElement(LoginCard, { onAuthenticated: () => {} }));
  assert.ok(html.includes(">邮箱<"), "自注册形态字段应叫「邮箱」");
  assert.ok(!html.includes("邮箱或账号"), "自注册形态不得再诱导用户猜账号名");
});

/* ---------- 代码审尾巴②:登录错误码表化,不裸透传 ---------- */

test("登录错误码表:401/网络/未知英文各有落点", () => {
  assert.equal(loginErrorMessage(new ApiClientError("x", { status: 401, code: "unauthorized" })), "账号或密码不正确，请检查后再试");
  assert.ok(loginErrorMessage(new ApiClientError("x", { code: "network_error" })).includes("连不上服务"));
  const weird = loginErrorMessage(new Error("socket hang up ECONNRESET"));
  assert.ok(!/socket|ECONNRESET/.test(weird), "未知技术串不得上屏");
  assert.ok(/[一-鿿]/.test(weird), "未知错误必须给中文话术");
});

test("登录卡源码:裸透传三元式已除(走 loginErrorMessage)", () => {
  assert.ok(!/reason instanceof Error \? reason\.message/.test(loginCard), "登录仍裸透传 reason.message");
  assert.ok(loginCard.includes("loginErrorMessage(reason)"), "登录失败未走码表");
});

/* ---------- F09:菜单不透明+图层+余额行提顶 ---------- */

test("F09 源码:菜单面板 surface-2 实心底+z 走 modal 档(压过 rail)", () => {
  assert.ok(dropdownMenu.includes("bg-surface-2"), "面板未升级为 surface-2 实心底");
  assert.ok(!dropdownMenu.includes("bg-surface-1"), "surface-1 与 rail 明度拉不开,已被取代");
  assert.ok(dropdownMenu.includes("z-[var(--z-modal)]"), "z 未走 modal 档(50>rail 32)");
  assert.ok(!dropdownMenu.includes("z-[70]"), "裸数字 z 已收敛进阶梯");
});

test("F09 源码:余额行提菜单顶部(rail 实例菜单向右开不回头盖 rail)", () => {
  assert.ok(userMenu.indexOf("{creditsRow}") < userMenu.indexOf("DropdownMenuLabel") || userMenu.indexOf("{creditsRow ?") < userMenu.indexOf("<DropdownMenuLabel"), "余额行必须在用户名之上");
  assert.ok(appRail.includes('menuSide="right"'), "rail 底组菜单未向右开");
});

/* ---------- F10:账号名截断(2026-08-05 UIFIX2-B 二次修复:rail 惯例 icon 方块+尾部截断) ---------- */

test("F10 渲染:compact 触发器=rail 惯例 icon 方块+9px 尾部截断标签,全名进 title,不硬裁字头", () => {
  const html = renderToStaticMarkup(React.createElement(UserMenu, { user: demoUser, onLogout: () => {}, compact: true }));
  assert.ok(html.includes("truncate"), "缺尾部截断(truncate 只裁尾不裁头)");
  assert.ok(html.includes("text-[9px]"), "rail 惯例 9px 标签未接");
  assert.ok(html.includes('title="kimi2-fe-1785844493461"'), "title 应留全名供悬浮");
  assert.ok(!html.includes("overflow-hidden rounded-full"), "旧 pill 溢出结构仍在(裁字头的肇事结构)");
});

/* ---------- F11:积分双口径解释行 ---------- */

test("F11 渲染:余额行下挂口径解释(怎么扣/何时重置)", () => {
  const html = renderToStaticMarkup(React.createElement(AccountCreditsMenuRow, { demoMode: true }));
  assert.ok(html.includes("生成按报价扣积分"), "缺「怎么扣」的解释");
  assert.ok(html.includes("每天 0 点重置"), "缺「何时重置」的解释");
});

/* ---------- F12:项目页右上账号入口 ---------- */

test("F12 源码:项目列表页右上挂同一 UserMenu(带积分行),app 壳 runtime 供 onLogout", () => {
  const projectsHeader = readSource("./pages/global-pages.tsx").split("回收站</Button>")[1] ?? "";
  assert.ok(projectsHeader.includes("<UserMenu"), "项目页右上缺账号入口");
  assert.ok(projectsHeader.includes("AccountCreditsMenuRow"), "右上入口未带积分行");
  assert.ok(appShell.includes("onLogout: () => void logout()"), "app 壳 runtime 未供 onLogout");
});
