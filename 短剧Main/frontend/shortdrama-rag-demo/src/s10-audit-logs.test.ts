/* ============================================================
   s10-audit-logs.test.ts — S10「AI 日志页点亮」验收断言
   ① wire 归一：aiAuditEntryFromUnknown / aiAuditLogPageFromUnknown
     （snake/camel 双吃——P0 在 api.ts 归一 {items,total,hasMore}，页面 mapper 兼容两种形状）
   ② 展示纯函数：auditActionLabel / auditStatusSuffix / auditUsageText（未回传如实，不编数）
   ③ 分页：sliceAuditLogPage 与后端 page/page_size/has_more 同口径（routes.ts: has_more = page*size < total）
   ④ demo fixture 形状：每条含 provider/model/usage/时间字段位，页面标注「示例数据」
   ⑤ 源码级：AI 日志页签已接真（项目选择器/分页表格/如实降级），旧「预计上线」占位已摘
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AI_AUDIT_LOG_PAGE_SIZE,
  DEMO_AI_AUDIT_LOGS,
  aiAuditEntryFromUnknown,
  aiAuditLogPageFromUnknown,
  auditActionLabel,
  auditStatusSuffix,
  auditUsageText,
  sliceAuditLogPage,
  type AiAuditLogEntry,
} from "./pages/settings-page";

const settingsPageSource = readFileSync(new URL("./pages/settings-page.tsx", import.meta.url), "utf8");

/* ---------- ① wire 归一 ---------- */

test("entry 归一：后端 snake wire（routes.ts auditLogData 真形）→ 页面 camel 规范形", () => {
  const entry = aiAuditEntryFromUnknown({
    id: "msg-1",
    role: "assistant",
    tool_name: "search_assets",
    status: "completed",
    provider: "ark",
    model: "doubao-seed-1.6",
    usage: { status: "ok", input_tokens: 812, output_tokens: 196, total_tokens: 1008 },
    created_at: "2026-07-22T13:57:12.000Z",
  });
  assert.deepEqual(entry, {
    id: "msg-1",
    createdAt: "2026-07-22T13:57:12.000Z",
    role: "assistant",
    toolName: "search_assets",
    status: "completed",
    provider: "ark",
    model: "doubao-seed-1.6",
    usage: { status: "ok", inputTokens: 812, outputTokens: 196, totalTokens: 1008 },
  });
});

test("entry 归一：camel 形状（P0 归一后）原样通过；缺省字段落 null/空串", () => {
  const entry = aiAuditEntryFromUnknown({ id: "msg-2", role: "user", createdAt: "2026-07-22T13:55:40.000Z" });
  assert.ok(entry, "camel 形状应通过");
  assert.equal(entry.createdAt, "2026-07-22T13:55:40.000Z");
  assert.equal(entry.toolName, null);
  assert.equal(entry.provider, null);
  assert.equal(entry.model, null);
  assert.equal(entry.usage, null);
});

test("entry 归一：脏输入丢 null（非对象 / 缺 id / 空 id），不抛异常", () => {
  assert.equal(aiAuditEntryFromUnknown(null), null);
  assert.equal(aiAuditEntryFromUnknown("msg-1"), null);
  assert.equal(aiAuditEntryFromUnknown({}), null);
  assert.equal(aiAuditEntryFromUnknown({ id: "  " }), null);
});

test("page 归一：{items,total,has_more} snake → {items,total,hasMore} camel；脏行被丢弃", () => {
  const page = aiAuditLogPageFromUnknown({
    items: [
      { id: "ok-1", role: "assistant", created_at: "2026-07-22T13:58:00.000Z" },
      { role: "assistant" },
      "garbage",
    ],
    total: 42,
    has_more: true,
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.id, "ok-1");
  assert.equal(page.total, 42);
  assert.equal(page.hasMore, true);
});

test("page 归一：缺 total 回 items.length；缺 hasMore 视为无下一页（不多翻）", () => {
  const page = aiAuditLogPageFromUnknown({ items: [{ id: "a" }, { id: "b" }] });
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, false);
  assert.deepEqual(aiAuditLogPageFromUnknown(undefined), { items: [], total: 0, hasMore: false });
  assert.deepEqual(aiAuditLogPageFromUnknown({ items: "not-array" }), { items: [], total: 0, hasMore: false });
});

/* ---------- ② 展示纯函数 ---------- */

test("动作列：工具调用显示中文动作名（#18），assistant/user 说人话，未知 role 不裸显", () => {
  assert.equal(auditActionLabel({ role: "assistant", toolName: "search_assets" }), "工具 · 检索资产");
  assert.equal(auditActionLabel({ role: "assistant", toolName: "brand_new_tool" }), "工具 · 工具调用", "未知工具不裸显 snake_case");
  assert.equal(auditActionLabel({ role: "assistant", toolName: null }), "助手回复");
  assert.equal(auditActionLabel({ role: "user", toolName: null }), "用户输入");
  assert.equal(auditActionLabel({ role: "system", toolName: null }), "调用", "英文 role 不裸显");
  assert.equal(auditActionLabel({ role: "", toolName: null }), "调用");
});

test("状态后缀：失败/已中止加注，完成态与缺省不加噪音", () => {
  assert.equal(auditStatusSuffix("failed"), "（失败）");
  assert.equal(auditStatusSuffix("aborted"), "（已中止）");
  assert.equal(auditStatusSuffix("completed"), "");
  assert.equal(auditStatusSuffix(null), "");
  assert.equal(auditStatusSuffix(undefined), "");
});

test("用量列：输入+输出 / 仅总量 / 未回传 / 空，如实展示不编数", () => {
  assert.equal(auditUsageText({ status: "ok", inputTokens: 812, outputTokens: 196, totalTokens: 1008 }), "输入 812 · 输出 196");
  assert.equal(auditUsageText({ status: "ok", totalTokens: 1952 }), "合计用量 1952", "英文单位 tokens 不上屏（#18）");
  assert.equal(auditUsageText({ status: "ok", inputTokens: 640 }), "输入 640");
  assert.equal(auditUsageText({ status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }), "未回传");
  assert.equal(auditUsageText({}), "未回传");
  assert.equal(auditUsageText(null), "—");
  assert.equal(auditUsageText(undefined), "—");
});

/* ---------- ③ 分页（与后端 has_more = page * page_size < total 同口径） ---------- */

function demoEntries(count: number): AiAuditLogEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e-${index + 1}`,
    createdAt: "2026-07-22T13:00:00.000Z",
    role: "assistant",
  }));
}

test("AI_AUDIT_LOG_PAGE_SIZE 冻结 20（后端 page_size ≤100，默认 50；前端按 20 一页）", () => {
  assert.equal(AI_AUDIT_LOG_PAGE_SIZE, 20);
});

test("sliceAuditLogPage：45 条按 20 一页，三页 20/20/5，hasMore 逐页正确", () => {
  const all = demoEntries(45);
  const page1 = sliceAuditLogPage(all, 1);
  assert.equal(page1.items.length, 20);
  assert.equal(page1.total, 45);
  assert.equal(page1.hasMore, true);
  const page2 = sliceAuditLogPage(all, 2);
  assert.equal(page2.items.length, 20);
  assert.equal(page2.hasMore, true, "45 > 40，第二页后仍有");
  const page3 = sliceAuditLogPage(all, 3);
  assert.equal(page3.items.length, 5);
  assert.equal(page3.hasMore, false);
});

test("sliceAuditLogPage：page 越界/非法值钳到第 1 页；超出范围给空页不越界", () => {
  const all = demoEntries(3);
  assert.equal(sliceAuditLogPage(all, 0).items[0]!.id, "e-1");
  assert.equal(sliceAuditLogPage(all, -2).items.length, 3);
  assert.equal(sliceAuditLogPage(all, Number.NaN).items.length, 3);
  const beyond = sliceAuditLogPage(all, 9);
  assert.deepEqual(beyond, { items: [], total: 3, hasMore: false });
});

/* ---------- ④ demo fixture ---------- */

test("demo 留痕：每条有 id/时间/role，至少一条带 provider/model/用量，供表格完整演示", () => {
  assert.ok(DEMO_AI_AUDIT_LOGS.length >= 3, "示例数据至少 3 条");
  for (const entry of DEMO_AI_AUDIT_LOGS) {
    assert.ok(entry.id.trim(), "缺 id");
    assert.ok(entry.createdAt.trim(), `${entry.id} 缺时间`);
    assert.ok(entry.role.trim(), `${entry.id} 缺 role`);
  }
  const withUsage = DEMO_AI_AUDIT_LOGS.filter((entry) => entry.provider && entry.model && entry.usage?.totalTokens != null);
  assert.ok(withUsage.length >= 2, "至少两条带 provider/model/用量");
  const page = sliceAuditLogPage(DEMO_AI_AUDIT_LOGS, 1);
  assert.equal(page.total, DEMO_AI_AUDIT_LOGS.length);
  assert.equal(page.hasMore, false, "示例数据一页装得下");
});

/* ---------- ⑤ 源码级：页签已点亮，旧占位已摘 ---------- */

test("AI 日志页签接真：项目选择器 + 分页表格 + P0 读取方法 + 如实降级", () => {
  assert.ok(settingsPageSource.includes("aiAuditLogs"), "未调用 P0 的 api.aiAuditLogs");
  assert.ok(settingsPageSource.includes("选择项目"), "缺项目选择器");
  for (const header of ["时间", "动作", "服务商", "模型", "用量"]) {
    assert.ok(settingsPageSource.includes(header), `表格缺「${header}」列`);
  }
  assert.ok(!settingsPageSource.includes(">Provider<"), "英文表头 Provider 不该上屏（#18）");
  assert.ok(settingsPageSource.includes("上一页") && settingsPageSource.includes("下一页"), "缺翻页控件");
  assert.ok(settingsPageSource.includes("reason.status === 404 || reason.status === 501"), "缺 404/501 如实降级");
});

test("旧「预计上线」占位已摘；demo 标注「示例数据」；无灰按钮占位", () => {
  assert.ok(!settingsPageSource.includes("AI_LOG_EMPTY"), "旧空态常量仍在");
  assert.ok(!settingsPageSource.includes("AI 调用日志预计"), "旧「预计上线」占位文案仍在");
  assert.ok(settingsPageSource.includes("示例数据"), "demo 缺「示例数据」标注");
  assert.ok(!settingsPageSource.includes("disabled"), "出现灰按钮占位");
});
