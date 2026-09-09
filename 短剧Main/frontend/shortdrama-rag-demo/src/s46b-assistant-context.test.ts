/* ============================================================
   s46b-assistant-context.test.ts — S46 B-5 Pi 上下文卡 组件渲染断言
   R44②:上下文描述随页面变化;消耗看板不再显示资产检索文案;
   付费红线提醒常驻;建议按钮可点形态保持。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantContextCard } from "./components/assistant-context-card";
import { assistantSuggestions } from "./assistant-copy";

function render(label: string, showSuggestions = true): string {
  return renderToStaticMarkup(React.createElement(AssistantContextCard, {
    label,
    suggestions: assistantSuggestions(label),
    showSuggestions,
    busy: false,
    onPick: () => undefined,
  }));
}

test("B-5 渲染:消耗看板上下文显示消耗口径描述,不再是资产检索那段", () => {
  const html = render("消耗看板");
  assert.ok(html.includes("当前上下文：消耗看板"), "缺上下文标签");
  assert.ok(html.includes("我在消耗看板"), "缺随场景变的描述");
  assert.ok(html.includes("哪类生成最花积分"), "描述与看板无关");
  assert.ok(!html.includes("我能检索资产、把资产加入项目、准备生成草稿和查询任务。"), "资产检索通用段残留");
});

test("B-5 渲染:换页面换描述——工作台与消耗看板不同文", () => {
  const workbench = render("工作台");
  assert.ok(workbench.includes("我在当前粗剪素材的工作台"), "工作台描述未随场景变");
  assert.ok(!workbench.includes("我在消耗看板"), "串了别的页面文案");
});

test("B-5 渲染:付费红线提醒常驻;建议操作渲染为可点按钮", () => {
  const html = render("消耗看板");
  assert.ok(html.includes("付费生成永远由你亲手点击"), "付费红线提醒丢失");
  assert.ok(html.includes("哪个项目的消耗排第一？"), "缺消耗看板建议");
  assert.ok((html.match(/<button/g) ?? []).length >= 2, "建议未渲染为按钮");
});

test("B-5 渲染:收到消息后建议区隐藏,描述与红线仍在", () => {
  const html = render("消耗看板", false);
  assert.ok(!html.includes("哪个项目的消耗排第一？"), "建议未隐藏");
  assert.ok(html.includes("我在消耗看板"), "描述丢失");
  assert.ok(html.includes("付费生成永远由你亲手点击"), "红线提醒丢失");
});
