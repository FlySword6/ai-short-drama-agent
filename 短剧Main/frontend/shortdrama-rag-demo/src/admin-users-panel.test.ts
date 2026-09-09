/* ============================================================
   admin-users-panel.test.ts — 后台「用户管理」页签（卡 #152）接线与诚实态断言
   ① 页签接线：管理后台出现「用户管理」，读写全走 /admin/users 管理端点
   ② 新增用户：登录账号/显示名/角色三字段；初始密码只显示一次，不落地
   ③ 改角色/调积分/停用接通；「恢复」在后端 enable 路由到位前置灰并写明原因（缺口不装假）
   ④ 登录账号只读并说明为什么；积分余额可点、跳到成本页按用户分组
   ⑤ 界面文案无开发词（接口/枚举/HTTP 码/英文报错不上屏）
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adminUserAccountFromUnknown, USERNAME_READONLY_REASON } from "./operations";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const adminPageSource = readSource("./pages/admin-page.tsx");
const panelSource = readSource("./pages/admin-users-panel.tsx");
const apiSource = readSource("./api.ts");

test("① 管理后台挂「用户管理」页签，面板读写全走管理端点", () => {
  assert.ok(adminPageSource.includes('"users", "用户管理"'), "缺「用户管理」页签");
  assert.ok(adminPageSource.includes("AdminUsersPanel"), "页签未接面板");
  for (const method of ["adminUserAccounts", "adminCreateUser", "adminUpdateUserRole", "adminDisableUser", "adminResetUserPassword", "adjustAccountCredits"]) {
    assert.ok(panelSource.includes(`api.${method}`), `面板未走 ${method}`);
  }
  for (const endpoint of ['"/admin/users"', "`/admin/users/${encodeURIComponent(userId)}`", "/disable", "/reset-password"]) {
    assert.ok(apiSource.includes(endpoint), `api.ts 缺端点 ${endpoint}`);
  }
});

test("② 新增用户三字段齐备；初始密码只显示一次、不落地存储", () => {
  assert.ok(panelSource.includes("登录账号") && panelSource.includes("显示名") && panelSource.includes("角色"), "新增弹窗缺字段");
  assert.ok(panelSource.includes("只显示这一次"), "初始密码缺一次性提示");
  assert.ok(!panelSource.includes("localStorage"), "密码/用户数据不得落地 localStorage");
  assert.ok(panelSource.includes("USERNAME_PATTERN"), "登录账号缺格式校验");
  assert.ok(panelSource.includes("建好他就能用"), "缺「建号即可登录」的说明");
});

test("③ 改角色/调积分/停用接通；恢复在后端接口到位前置灰并写明原因", () => {
  assert.ok(panelSource.includes("adminUpdateUserRole") && panelSource.includes("RoleSelect"), "缺行内改角色");
  assert.ok(panelSource.includes("AdjustConfirmDialog"), "调积分未复用二次确认弹窗");
  assert.ok(panelSource.includes("停用不是删除"), "停用缺「不是删除」说明");
  assert.ok(panelSource.includes("RESTORE_PENDING_REASON") && panelSource.includes(">恢复</Button>"), "缺置灰的恢复按钮");
  assert.ok(panelSource.includes("恢复」的后端开关还没做出来"), "恢复置灰缺原因说明");
  assert.ok(panelSource.includes("不能停用当前登录账号") || apiSource.includes("disable"), "停用接线缺失");
});

test("④ 登录账号只读并给原因；积分余额可点跳成本页", () => {
  assert.ok(USERNAME_READONLY_REASON.includes("身份锚点"), "登录账号只读说明缺失");
  assert.ok(panelSource.includes("USERNAME_READONLY_REASON"), "面板未挂只读说明");
  assert.ok(panelSource.includes("onShowUserCosts"), "积分列缺跳转回调");
  assert.ok(adminPageSource.includes('setGroupBy("user")') || adminPageSource.includes('"user"'), "成本页未按用户分组定位");
  assert.ok(adminPageSource.includes("costsFocusUser"), "成本页缺高亮定位");
});

test("⑤ 界面文案无开发词（接口/枚举/HTTP 码/英文报错不上屏）", () => {
  for (const banned of [">接口<", "真源", "枚举", "HTTP", "endpoint", "toggle", "provider", "vendor"]) {
    assert.ok(!panelSource.includes(banned), `面板出现开发词「${banned}」`);
  }
  /* 403/404 只允许出现在权限判断代码里，用户可见的必须是中文人话。 */
  assert.ok(panelSource.includes("只有管理员能管用户"), "403 缺中文人话");
});

test("归一：admin/users 管理行 snake→camel，积分账户可空", () => {
  const full = adminUserAccountFromUnknown({
    id: "u1",
    username: "litong",
    display_name: "李彤",
    role: "operator",
    active: false,
    email: "litong@example.com",
    account_credit: { balance_points: 1200, daily_limit_points: 5000, used_today_points: 30, remaining_today_points: 4970 },
    created_at: "2026-08-06T01:00:00Z",
    updated_at: "2026-08-06T02:00:00Z",
  });
  assert.equal(full.displayName, "李彤");
  assert.equal(full.platformRole, "operator");
  assert.equal(full.active, false);
  assert.equal(full.accountCredit?.balancePoints, 1200);

  const bare = adminUserAccountFromUnknown({ id: "u2", username: "wangwu", role: "member", active: true, account_credit: null });
  assert.equal(bare.displayName, "wangwu");
  assert.equal(bare.accountCredit, null);
});
