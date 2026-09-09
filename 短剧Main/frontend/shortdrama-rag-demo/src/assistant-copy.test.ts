/* ============================================================
   assistant-copy.test.ts — S46 B-5 Pi 面板上下文文案 纯逻辑断言
   R44②:上下文描述随页面变,消耗看板不再用资产检索文案,建议操作不成片空白。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { assistantContextCopy, assistantSuggestions } from "./assistant-copy";

const KNOWN_LABELS = ["项目面板", "工作台", "生产", "资产面板", "消耗看板", "数据看板", "参考测试", "素材智能体", "3D 导演台", "设置"];

test("B-5: 每个已知页面上下文都有一句随场景变的描述", () => {
  const copies = new Set(KNOWN_LABELS.map((label) => assistantContextCopy(label)));
  assert.equal(copies.size, KNOWN_LABELS.length, "有页面共享同一句描述");
});

test("B-5: 消耗看板不再用资产检索那段文案,说消耗的事", () => {
  const copy = assistantContextCopy("消耗看板");
  assert.ok(copy.includes("消耗"), "消耗看板文案不含消耗");
  assert.ok(!copy.includes("我能检索资产、把资产加入项目"), "仍是资产检索通用段");
  assert.notEqual(copy, assistantContextCopy("资产面板"), "与资产面板同文");
});

test("B-5: 未知上下文回退通用能力说明", () => {
  assert.equal(assistantContextCopy("不存在的页"), "我能检索资产、把资产加入项目、准备生成草稿和查询任务。");
});

test("B-5: 消耗看板建议操作 ≥2 条,面板不再大片空白;每个已知页面都有建议", () => {
  assert.ok(assistantSuggestions("消耗看板").length >= 2, "消耗看板建议不足两条");
  for (const label of KNOWN_LABELS) {
    assert.ok(assistantSuggestions(label).length >= 1, `${label} 缺建议操作`);
  }
});
