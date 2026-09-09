/* ============================================================
   s46b-release-preview.test.ts — S46 B-7 版本预告口径 组件渲染断言
   R46:预告只放功能;管理后台编辑面对非「新功能」类卡即时预警。
   渲染真实的 SectionEditor(renderToStaticMarkup),不读源码字符串。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionEditor } from "./pages/admin-release-plan-panel";
import type { ReleaseCard, ReleaseCategory } from "./release-plan";

function card(category: ReleaseCategory): ReleaseCard {
  return {
    id: `card-${category}`,
    title: "示例功能",
    tagline: "一句话价值",
    status: "scheduled",
    category,
    release: "v0.3",
  };
}

function render(category: ReleaseCategory): string {
  return renderToStaticMarkup(React.createElement(SectionEditor, {
    form: { entryKey: "v0.3", entryStatus: "draft", title: "v0.3", sectionStatus: "scheduled", note: "", cards: [card(category)] },
    isNew: true,
    saving: false,
    onChange: () => undefined,
    onSave: () => undefined,
    onCancel: () => undefined,
  }));
}

test("B-7 渲染:「优化」类卡在编辑面即时预警——不会显示在预告页", () => {
  const html = render("improvement");
  assert.ok(html.includes("不会显示在预告页"), "优化类卡缺预警");
  assert.ok(html.includes("预告只放功能"), "预警未说口径");
});

test("B-7 渲染:「修复」类卡同样预警", () => {
  assert.ok(render("fix").includes("不会显示在预告页"), "修复类卡缺预警");
});

test("B-7 渲染:「新功能」类卡不预警", () => {
  assert.ok(!render("feature").includes("不会显示在预告页"), "功能卡误预警");
});
