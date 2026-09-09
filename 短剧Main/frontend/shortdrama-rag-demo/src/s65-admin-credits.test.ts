/* ============================================================
   s65-admin-credits.test.ts — S65 超管「账户与邀请码」组件渲染 + 逻辑断言

   文案类断言全部走组件渲染（renderToStaticMarkup）：
   ① 自注册策略卡：赠送 0 积分固定、日额度可编辑、保存按钮在；
   ② 档位列表：名称/编码/赠送/日额度/状态；
   ③ 邀请码列表：掩码、已用/上限、剩余、三种状态（可用/已用完/已停用）；
   ④ 调账二次确认：明细齐全，大额（≥10 万积分）出额外警告、小额不出；
   ⑤ 本次调账记录列表；
   ⑥ inviteCodeStatus 派生态顺序：停用 > 过期 > 用尽 > 可用。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdjustConfirmSummary,
  AdjustmentLog,
  CodeList,
  LARGE_ADJUSTMENT_POINTS,
  PolicyCard,
  TierList,
  adjustmentLargeNote,
} from "./pages/admin-credits-panel";
import {
  DEMO_INVITE_CODES,
  DEMO_INVITE_TIERS,
  DEMO_SELF_REGISTRATION_POLICY,
  inviteCodeStatus,
} from "./operations";

const noopAsync = async () => {};

test("S65-B 渲染：自注册策略卡——赠送 0 积分固定说明 + 当前日额度 + 保存按钮", () => {
  const html = renderToStaticMarkup(React.createElement(PolicyCard, { policy: DEMO_SELF_REGISTRATION_POLICY, saving: false, onSave: noopAsync }));
  assert.ok(html.includes("自注册策略"), "缺标题");
  assert.ok(html.includes("赠送"), "缺赠送说明");
  assert.ok(html.includes("（固定）"), "赠送 0 积分应标注为固定，不给编辑错觉");
  assert.ok(html.includes('value="50000"'), "当前日额度应回填");
  assert.ok(html.includes("保存策略"), "缺保存按钮");
  assert.ok(html.includes("只影响之后注册的账号"), "缺不回写说明");
});

test("S65-B 渲染：档位列表显示名称/编码/赠送/日额度/状态", () => {
  const html = renderToStaticMarkup(React.createElement(TierList, { tiers: DEMO_INVITE_TIERS, busy: false, onEdit: () => {}, onDeactivate: () => {} }));
  assert.ok(html.includes("开发者"), "缺档位名");
  assert.ok(html.includes("developer"), "缺档位编码");
  assert.ok(html.includes("10 万"), "赠送 100000 应格式化显示");
  assert.ok(html.includes("启用中"), "缺状态徽标");
  assert.ok(html.includes("编辑"), "缺编辑入口");
  assert.ok(html.includes("停用"), "缺停用入口");
});

test("S65-B 渲染：邀请码列表显示掩码/已用上限/剩余/三种状态", () => {
  const html = renderToStaticMarkup(React.createElement(CodeList, { codes: DEMO_INVITE_CODES, busy: false, onDeactivate: () => {} }));
  assert.ok(html.includes("SD-K7X2••••"), "缺掩码前缀");
  assert.ok(!html.includes("plaintext"), "列表绝不出明文");
  assert.ok(html.includes("2 / 5"), "已用/上限口径不对");
  assert.ok(html.includes("可用"), "缺可用状态");
  assert.ok(html.includes("已用完"), "缺已用完状态");
  assert.ok(html.includes("已停用"), "缺已停用状态");
  assert.ok(html.includes("长期有效"), "无到期时间应显示长期有效");
});

test("S65-B 风控：大额调账（≥10 万积分）出额外警告，小额不出", () => {
  assert.ok(LARGE_ADJUSTMENT_POINTS === 100_000, "阈值口径变动需同步任务包风控要求");
  const large = adjustmentLargeNote(100_000);
  assert.ok(large && large.includes("大额调账") && large.includes("¥1,000"), "大额警告应含金额折合");
  assert.equal(adjustmentLargeNote(99_999), null);
  assert.equal(adjustmentLargeNote(-50_000), null);
  const largeNegative = adjustmentLargeNote(-200_000);
  assert.ok(largeNegative && largeNegative.includes("大额调账"), "负数大额同样要警告");

  const html = renderToStaticMarkup(React.createElement(AdjustConfirmSummary, { targetLabel: "陈默（@chenmo）", amountPoints: 200_000, reason: "内测补偿" }));
  assert.ok(html.includes("陈默（@chenmo）"), "缺用户");
  assert.ok(html.includes("+20 万 积分"), "增减额格式不对");
  assert.ok(html.includes("内测补偿"), "缺原因");
  assert.ok(html.includes("大额调账"), "大额警告未渲染");
  assert.ok(html.includes('role="alert"'), "大额警告应为 alert");

  const small = renderToStaticMarkup(React.createElement(AdjustConfirmSummary, { targetLabel: "周岚（@zhoulan）", amountPoints: 5_000, reason: "活动奖励" }));
  assert.ok(!small.includes("大额调账"), "小额不应出大额警告");
  const negative = renderToStaticMarkup(React.createElement(AdjustConfirmSummary, { targetLabel: "周岚（@zhoulan）", amountPoints: -200, reason: "误充值回收" }));
  assert.ok(negative.includes("-200 积分"), "负数增减额格式不对");
  assert.ok(negative.includes("余额不能为负"), "扣减要提示余额为负会被拒绝");
});

test("S65-B 渲染：本次调账记录列表（用户/增减/余额/原因）", () => {
  const records = [{ userId: "u1", targetLabel: "陈默（@chenmo）", balancePoints: 55_000, amountPoints: 5_000, reason: "内测补偿", createdAt: "2026-07-28T02:00:00Z" }];
  const html = renderToStaticMarkup(React.createElement(AdjustmentLog, { records }));
  assert.ok(html.includes("本次打开后台以来的调账（1 笔）"), "缺范围说明（防误读为全量台账）");
  assert.ok(html.includes("+5,000"), "缺增减额");
  assert.ok(html.includes("内测补偿"), "缺原因");
  const empty = renderToStaticMarkup(React.createElement(AdjustmentLog, { records: [] }));
  assert.equal(empty, "", "无记录时应整体隐藏");
});

test("S65-B 逻辑：inviteCodeStatus 判读顺序 停用 > 过期 > 用尽 > 可用", () => {
  const now = Date.parse("2026-07-28T00:00:00Z");
  const base = { active: true, expiresAt: null, maxRedemptions: 5, usedRedemptions: 2 };
  assert.equal(inviteCodeStatus(base, now), "active");
  assert.equal(inviteCodeStatus({ ...base, usedRedemptions: 5 }, now), "exhausted");
  assert.equal(inviteCodeStatus({ ...base, expiresAt: "2026-07-01T00:00:00Z" }, now), "expired");
  assert.equal(inviteCodeStatus({ ...base, active: false }, now), "revoked");
  assert.equal(inviteCodeStatus({ ...base, active: false, usedRedemptions: 5 }, now), "revoked", "停用优先于用尽");
  assert.equal(inviteCodeStatus({ ...base, expiresAt: "2026-08-01T00:00:00Z" }, now), "active", "未到期仍可用");
});
