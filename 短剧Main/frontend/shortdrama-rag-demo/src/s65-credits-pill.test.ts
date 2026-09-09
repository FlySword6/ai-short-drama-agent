/* ============================================================
   s65-credits-pill.test.ts — S65「我的积分」顶栏 pill 组件渲染断言

   ① 就绪态：余额格式化显示 + hover 明细（今日剩余/日额度/结算日）；
   ② 离线演示：示例值并明示「示例」（A3 口径：真栈不出现占位）；
   ③ 读取中/读取失败：失败给重试出路（错误态否决清单 #7），不裸技术错误。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreditsPillView, creditsPillTitle } from "./components/credits-pill";
import { DEMO_CREDIT_SUMMARY, type AccountCreditSummary } from "./operations";

const summary: AccountCreditSummary = {
  userId: "u1",
  balancePoints: 12400,
  dailyLimitPoints: 50000,
  usedTodayPoints: 860,
  remainingTodayPoints: 49140,
  dayDate: "2026-07-28",
  pointToFen: 1,
};

test("S65-C 渲染：就绪态显示余额与「积分」单位，hover 给今日明细", () => {
  const html = renderToStaticMarkup(React.createElement(CreditsPillView, { state: "ready", summary }));
  assert.ok(html.includes("1.24 万"), "余额应千分位/万缩写格式化");
  assert.ok(html.includes("积分"), "单位口径必须是「积分」，不得出现元/费用");
  assert.ok(!html.includes("元</"), "不得引入「元」单位");
  assert.ok(html.includes("今日剩余"), "hover 缺今日剩余");
  assert.ok(html.includes("2026-07-28"), "hover 缺结算日");
  assert.ok(!html.includes("（示例）"), "真栈不得标示例");
});

test("S65-C 渲染：离线演示显示示例值并明示「示例」", () => {
  const html = renderToStaticMarkup(React.createElement(CreditsPillView, { state: "demo" }));
  assert.ok(html.includes("（示例）"), "演示值必须明示示例");
  assert.ok(html.includes("积分"));
  assert.equal(DEMO_CREDIT_SUMMARY.balancePoints, 12400, "演示口径沿用 A3 拍板的 12,400");
});

test("S65-C 渲染：读取中与读取失败（失败给重试出路，不裸技术错误）", () => {
  const loading = renderToStaticMarkup(React.createElement(CreditsPillView, { state: "loading" }));
  assert.ok(loading.includes("积分读取中"));

  const error = renderToStaticMarkup(React.createElement(CreditsPillView, { state: "error", onRetry: () => {} }));
  assert.ok(error.includes("积分读取失败"), "失败要直说");
  assert.ok(error.includes("重试"), "失败必须给出路（重试）");
  assert.ok(!error.includes("HTTP"), "不得裸露技术错误");

  /* 真栈读不到数据（summary 为空）与失败同位：同样给重试，不摆占位数字 */
  const empty = renderToStaticMarkup(React.createElement(CreditsPillView, { state: "ready", summary: null, onRetry: () => {} }));
  assert.ok(empty.includes("积分读取失败"), "无数据不得摆占位数字");
});

test("S65-C 文案：creditsPillTitle 口径与后端字段一致", () => {
  const title = creditsPillTitle(summary);
  assert.ok(title.includes("余额 1.24 万 积分"), "余额口径不对");
  assert.ok(title.includes("今日剩余 4.91 万 / 5 万 积分"), "今日剩余/日额度口径不对");
  assert.ok(title.includes("2026-07-28"), "缺结算日");
  assert.ok(title.includes("自然日"), "缺重置口径说明");
});
