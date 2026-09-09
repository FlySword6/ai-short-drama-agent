/* ============================================================
   user-menu.test.ts — W5.5 头像下拉菜单验收断言
   ① 菜单结构：三项固定顺序（个人信息 → 设置 → 退出登录），action 唯一
   ② 个人信息诚实说明：资料编辑接口未接，当前为只读
   ③ 菜单不依赖后端接口：demoMode 下同样可用
   ④ 接线（app.tsx）：两个 header 共用 UserMenu，旧 user-pill 直退已清；
      /settings 的 Pi 上下文标签为「设置」，不再叫「版本排片」
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROFILE_READONLY_NOTE, USER_MENU_ITEMS } from "./components/user-menu";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const appSource = readSource("./app.tsx");
const menuSource = readSource("./components/user-menu.tsx");
const dropdownSource = readSource("./components/ui/dropdown-menu.tsx");

/* ---------- ① 菜单结构 ---------- */

test("菜单三项固定顺序：个人信息 → 设置 → 退出登录，action 唯一", () => {
  assert.deepEqual(
    USER_MENU_ITEMS.map((item) => item.action),
    ["profile", "settings", "logout"],
  );
  assert.deepEqual(
    USER_MENU_ITEMS.map((item) => item.label),
    ["个人信息", "设置", "退出登录"],
  );
  assert.equal(new Set(USER_MENU_ITEMS.map((item) => item.action)).size, USER_MENU_ITEMS.length);
});

/* ---------- ② 诚实说明 ---------- */

test("个人信息说明：资料编辑即将开放，当前为只读（S17 起禁开发词）", () => {
  assert.ok(PROFILE_READONLY_NOTE.includes("即将开放"), "缺「即将开放」说明");
  assert.ok(PROFILE_READONLY_NOTE.includes("只读"), "缺「只读」声明");
  assert.ok(!PROFILE_READONLY_NOTE.includes("接口未接"), "仍含开发词");
});

/* ---------- ③ demoMode 可用（无后端依赖） ---------- */

test("菜单不调用后端接口：demoMode 下同样可用（个人信息即当前 user）", () => {
  assert.ok(!menuSource.includes('from "../api"'), "user-menu.tsx 不应引入 api");
  assert.ok(menuSource.includes("user.username") && menuSource.includes("user.display_name"), "个人信息应展示 username 与 display_name");
});

/* ---------- ④ 接线与无障碍 ---------- */

test("交互与无障碍：Radix 原语接管 focus trap/Esc/方向键/点外关闭/定位", () => {
  // Radix DropdownMenu 内建 aria/Esc/方向键/点外关闭/碰撞定位——user-menu 走本地 wrapper，
  // wrapper 内封装 @radix-ui/react-dropdown-menu；断言链路而非手搓属性。
  assert.ok(menuSource.includes("./ui/dropdown-menu"), "user-menu 未走 ui/dropdown-menu wrapper");
  assert.ok(dropdownSource.includes("@radix-ui/react-dropdown-menu"), "wrapper 未封装 Radix 原语");
  assert.ok(menuSource.includes("DropdownMenuTrigger"), "缺触发器");
  assert.ok(menuSource.includes("DropdownMenuContent"), "缺菜单容器");
  assert.ok(menuSource.includes("DropdownMenuItem"), "缺菜单项");
  assert.ok(menuSource.includes('aria-label={`账号菜单：${user.display_name}`}'), "触发按钮缺可访问名");
  assert.ok(menuSource.includes("destructive"), "退出登录未标 destructive");
});

test("接线：UserMenu 收编 rail 底组一次(compact),积分余额行随挂,旧直退已清", () => {
  // 2026-08-02 Fable 改锚:R2 壳后双 header 退役,UserMenu=rail 底组唯一挂点(compact+creditsRow)。
  const railSource = readSource("./components/app-rail.tsx");
  assert.equal((railSource.match(/<UserMenu\b/g) ?? []).length, 1, "rail 底组应恰好一次 UserMenu");
  assert.ok(railSource.includes("<UserMenu user={user} compact menuSide="), "rail UserMenu 缺 compact/menuSide(F09:菜单向右开不回头盖 rail)");
  assert.ok(railSource.includes("onLogout={onLogout} creditsRow="), "rail UserMenu 缺 onLogout/creditsRow");
  assert.equal((appSource.match(/<UserMenu\b/g) ?? []).length, 0, "app.tsx 不应再直挂 UserMenu(载体=rail)");
  assert.ok(!appSource.includes("user-pill"), "旧 user-pill 按钮仍留在 app.tsx");
});

test("接线（app.tsx）：/settings 的 Pi 上下文标签为「设置」，不再叫「版本排片」", () => {
  assert.ok(appSource.includes('pathname === "/settings" ? "设置"'), "routeContext 标签未改为「设置」");
  assert.ok(!appSource.includes('"版本排片"'), "routeContext 仍把 /settings 标成「版本排片」");
});
