/* ============================================================
   admin-release-plan-panel.test.ts — 管理后台「版本计划」页签(S23)接线验收断言
   ① 页签接线:管理后台出现「版本计划」,面板读写走管理端点
   ② 治理能力:新建默认草稿(不直接上前台)、删除两步确认、403 给人话
   ③ 诚实态:读取失败可重试、离线演示如实说明、内容读不出来不硬编
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const adminPageSource = readSource("./pages/admin-page.tsx");
const panelSource = readSource("./pages/admin-release-plan-panel.tsx");

test("① 管理后台挂「版本计划」页签,面板增删改排序全走管理端点", () => {
  assert.ok(adminPageSource.includes('"releases", "版本计划"'), "缺「版本计划」页签");
  assert.ok(adminPageSource.includes("ReleasePlanPanel"), "页签未接面板");
  for (const method of ["adminConfigEntries", "createConfigEntry", "updateConfigEntry", "deleteConfigEntry"]) {
    assert.ok(panelSource.includes(`api.${method}`), `面板未走 ${method}`);
  }
  assert.ok(panelSource.includes("上移") && panelSource.includes("下移"), "缺排序操作");
});

test("② 新建默认草稿不直接上前台;删除两步确认;非管理员写动作给人话", () => {
  assert.ok(panelSource.includes('entryStatus: "draft"'), "新建未默认草稿");
  assert.ok(panelSource.includes("pendingDelete") && panelSource.includes("确认删除"), "删除缺两步确认");
  assert.ok(panelSource.includes("只有管理员可以管理版本计划"), "缺 403 人话");
  assert.ok(panelSource.includes("「显示中」保存后立即上前台"), "缺显示状态说明");
});

test("③ 读取失败可重试;离线演示如实说明;内容读不出来不给编辑假相", () => {
  assert.ok(panelSource.includes("版本计划读取失败，请稍后重试") && panelSource.includes("重试"), "缺读取失败重试");
  assert.ok(panelSource.includes("离线演示不展示版本计划管理"), "离线演示缺如实说明");
  assert.ok(panelSource.includes("这条内容格式读不出来，未能打开编辑"), "内容损坏时缺如实提示");
});

test("用户可见文案无开发词(接口/真源/枚举不得出现在按钮与说明里)", () => {
  for (const banned of [">接口<", "真源", "枚举", "seed", "JSON"]) {
    assert.ok(!panelSource.includes(banned), `面板出现开发词「${banned}」`);
  }
});
