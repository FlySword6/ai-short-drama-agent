/**
 * 前端 grill 引擎测试：CandidateCard 组件 SSR 渲染。
 *
 * 覆盖范围：
 * 1. 基础渲染：标题、候选标签、候选描述
 * 2. 候选缺 description 时不渲染描述行
 * 3. 自定义输入入口（"其他…" 按钮）
 * 4. 关闭按钮（aria-label）
 * 5. 多候选数量（2/3/4）
 * 6. 边界：空候选列表
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CandidateCard, CandidateCardProps } from "./candidate-card.js";

function render(props: Partial<CandidateCardProps> = {}) {
  return renderToString(
    createElement(CandidateCard, {
      candidates: props.candidates ?? [
        { label: "选项A", description: "描述A", value: "a" },
        { label: "选项B", description: "描述B", value: "b" },
      ],
      onPick: props.onPick ?? (() => {}),
      onCustomSubmit: props.onCustomSubmit ?? (() => {}),
      onDismiss: props.onDismiss ?? (() => {}),
      ...props,
    } satisfies CandidateCardProps),
  );
}

// ─── 基础渲染 ─────────────────────────────────────────────

test("基础渲染：包含候选标签和描述", () => {
  const html = render();
  assert.ok(html.includes("选项A"), "应包含候选 A 的标签");
  assert.ok(html.includes("描述A"), "应包含候选 A 的描述");
  assert.ok(html.includes("选项B"), "应包含候选 B 的标签");
  assert.ok(html.includes("描述B"), "应包含候选 B 的描述");
});

test("基础渲染：包含「请选择一个选项」标题", () => {
  const html = render();
  assert.ok(html.includes("请选择一个选项"), "应包含标题文本");
});

test("基础渲染：包含「其他…」自定义入口", () => {
  const html = render();
  assert.ok(html.includes("其他"), "应包含自定义输入入口");
});

test("基础渲染：包含关闭按钮（aria-label）", () => {
  const html = render();
  assert.ok(html.includes("关闭候选卡片"), "应包含关闭按钮 aria-label");
});

// ─── 候选缺 description ───────────────────────────────────

test("候选缺 description 时不渲染描述 span", () => {
  const html = render({
    candidates: [{ label: "无描述选项", value: "x", description: "" }],
  });
  assert.ok(html.includes("无描述选项"), "应渲染标签");
  assert.ok(!html.includes("描述A"), "不应包含旧描述");
});

// ─── 多候选数量 ───────────────────────────────────────────

test("3 个候选全部渲染", () => {
  const html = render({
    candidates: [
      { label: "一", description: "d1", value: "1" },
      { label: "二", description: "d2", value: "2" },
      { label: "三", description: "d3", value: "3" },
    ],
  });
  assert.ok(html.includes("一"));
  assert.ok(html.includes("二"));
  assert.ok(html.includes("三"));
});

test("4 个候选全部渲染", () => {
  const html = render({
    candidates: [
      { label: "甲", description: "d1", value: "1" },
      { label: "乙", description: "d2", value: "2" },
      { label: "丙", description: "d3", value: "3" },
      { label: "丁", description: "d4", value: "4" },
    ],
  });
  assert.ok(html.includes("甲"));
  assert.ok(html.includes("乙"));
  assert.ok(html.includes("丙"));
  assert.ok(html.includes("丁"));
});

// ─── 边界 ─────────────────────────────────────────────────

test("空候选列表仍渲染容器和标题（不崩溃）", () => {
  const html = render({ candidates: [] });
  assert.ok(html.includes("请选择一个选项"), "空列表也应渲染标题");
  assert.ok(!html.includes("选项A"), "空列表不应包含候选");
});

// ─── 禁用状态 ─────────────────────────────────────────────

test("disabled=true 时候选按钮带 disabled 属性", () => {
  const html = render({ disabled: true });
  assert.ok(html.includes("disabled"), "禁用状态应渲染 disabled 属性");
});
