/* ============================================================
   s73-loose-ends.test.ts — S73 前端收尾杂项的渲染/死枝断言

   规矩(任务包硬规矩):文案与交互类改动禁止只用源码字符串断言——
   本文件全部走 renderToStaticMarkup 组件渲染,或断言死代码「不存在」。
   ① 「自动校验素材」开关:aria-disabled(可聚焦/可悬浮出 tooltip),不用 disabled;
   ② 死枝两处:ProjectCostAggregateBlock 删净;「收起其余类型」展开后可逆。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AutoValidateSwitch } from "./components/gen-node-features";
import { AccountCreditsMenuRow, CreditsPillView } from "./components/credits-pill";
import { Switch } from "./components/ui/primitives";
import { AUTO_VALIDATE_SWITCH_TOOLTIP } from "./gen-node-capability";

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/** 剥注释(块注释+行注释),「符号不存在」类断言只看可执行代码,不被考古注释误伤。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/* ---------- ① 「自动校验素材」开关(S66 纪律修复) ---------- */

test("S73-3 渲染:「自动校验素材」灰显开关用 aria-disabled,不用 disabled 属性", () => {
  const html = renderToStaticMarkup(React.createElement(AutoValidateSwitch));
  assert.ok(html.includes('role="switch"'), "开关角色缺失");
  assert.ok(html.includes('aria-label="自动校验素材"'), "开关 aria-label 缺失");
  assert.ok(html.includes('aria-disabled="true"'), "灰显开关必须用 aria-disabled(可聚焦/可悬浮出 tooltip)");
  assert.ok(!html.includes("disabled=\"\""), "不许再用 disabled 属性——disabled 的 input 不吃 hover/focus,tooltip 出不来");
  assert.ok(html.includes("自动校验素材"), "可见标签缺失");
});

test("S73-3 渲染:Switch 原语 ariaDisabled 态——aria-disabled 落 input、点击被拦、轨道压暗", () => {
  let changed = 0;
  const html = renderToStaticMarkup(
    React.createElement(Switch, { checked: false, ariaDisabled: true, label: "测试开关", onChange: () => { changed += 1; } }),
  );
  assert.ok(html.includes('aria-disabled="true"'));
  assert.ok(!/disabled=""/.test(html), "ariaDisabled 态不得写 disabled 属性");
  assert.equal(changed, 0, "渲染期不应触发 onChange");
  const enabled = renderToStaticMarkup(
    React.createElement(Switch, { checked: true, label: "测试开关", onChange: () => undefined }),
  );
  assert.ok(!enabled.includes('aria-disabled="'), "正常开关不得带 aria-disabled 属性");
});

test("S73-3 tooltip 文案真源:说清「规划中」且不再复读两遍", () => {
  assert.ok(AUTO_VALIDATE_SWITCH_TOOLTIP.startsWith("规划中"), "灰显项 tooltip 必须带「规划中」前缀口径");
  assert.equal(AUTO_VALIDATE_SWITCH_TOOLTIP.split("规划中").length - 1, 1, "「规划中」出现两次的旧病复发");
  assert.ok(AUTO_VALIDATE_SWITCH_TOOLTIP.includes("校验参考素材"), "tooltip 必须说清校验什么");
});

/* ---------- ①b 顶栏折行修复:积分 pill ≤1180px 收进账户菜单 ----------
   2026-08-04 口径更新(issue #26/#67):R2 壳后 pill 已从 header 退役(app-rail.test 锁
   「二级条不收 AccountCreditsPill」),rail 只剩余额快览,账户菜单行升级为全宽度的
   唯一明细位(余额/今日剩余/日额度三数同见),S73「宽屏隐藏防重复」前提已不存在。 */

test("S73-1 渲染:账户菜单积分行——三数同见(余额/今日剩余/日额度),全宽度显示", () => {
  const html = renderToStaticMarkup(React.createElement(AccountCreditsMenuRow, { demoMode: true }));
  assert.ok(html.includes("余额"), "菜单行缺「余额」");
  assert.ok(html.includes("1.24 万"), "菜单行余额格式化与 pill 不同源");
  assert.ok(html.includes("今日剩余"), "菜单行缺「今日剩余」(issue #67 三数判据)");
  assert.ok(html.includes("/5 万"), "菜单行缺日额度");
  assert.ok(html.includes("（示例）"), "演示值必须明示示例(A3 口径)");
  assert.ok(!html.includes("min-[1180px]:hidden"), "pill 退役后菜单行=唯一明细位,不得再宽屏隐藏");
});

test("S73-1 渲染:pill 本体 ≤1180px 隐藏(收进账户菜单,顶栏右组减负保 nav 单行)", () => {
  const html = renderToStaticMarkup(React.createElement(CreditsPillView, { state: "demo" }));
  assert.ok(html.includes("max-[1180px]:hidden"), "pill 必须在 ≤1180px 隐藏——S65 验收隔离的折行因果");
  assert.ok(!html.includes("max-[640px]:hidden"), "旧断点 640 残留(901–1180 正是折行缺陷带)");
});

/* ---------- ② 死枝清理:ProjectCostAggregateBlock 删净 ---------- */
test("S73-4 死枝①:ProjectCostAggregateBlock 删净——组件、局部变量、import 全不存在", () => {
  const operationsPages = stripComments(readSource("./pages/operations-pages.tsx"));
  assert.ok(
    !operationsPages.includes("ProjectCostAggregateBlock"),
    "ProjectCostAggregateBlock 仍在 operations-pages.tsx——要么接上要么删净,不留只赋值不渲染的半套",
  );
});

/* ---------- ③ 死枝②:「收起其余类型」展开后可逆(渲染断言在 global-pages 行为层) ---------- */

test("S73-4 死枝②:「收起其余类型」渲染门带展开态,展开后按钮不消失(K2 起按簇生效)", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  assert.ok(
    globalPages.includes("onClick={() => toggleKindCluster(cluster.category)}"),
    "展开/收起必须是同一个可逆开关(K2 起按簇取反 toggleKindCluster)",
  );
  assert.ok(
    !globalPages.includes("{hiddenCount > 0 ? ("),
    "渲染门仍是 hiddenCount > 0——展开后 hiddenCount 归零按钮消失,展开单向不可逆的旧病复发",
  );
});
