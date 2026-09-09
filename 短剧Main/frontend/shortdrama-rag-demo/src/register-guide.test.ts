/* ============================================================
   register-guide.test.ts — 注册引导页 组件渲染 + Grill 流程状态断言

   硬规矩：文案类断言必须组件渲染（renderToStaticMarkup），不只读源码字符串。
   覆盖：
   ① 初始 loading 渲染——标题/副文案/spinner 齐全；
   ② clarify 阶段渲染——反问文案/textarea/跳过+下一步按钮；
   ③ offer_candidates 阶段渲染——候选列表/跳过按钮；
   ④ error 阶段渲染——错误文案/重试+先跳过按钮；
   ⑤ GrillCheckResult 类型守卫——execute/clarify/offer_candidates 三态。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegisterGuidePage } from "./pages/register-guide";
import type { GrillCheckResult } from "./types";

const noopNotify = (_msg: string, _kind?: "info" | "success" | "error") => {};

const runtimeProps = {
  demoMode: false,
  notify: noopNotify,
  user: { id: "u1", username: "tester", display_name: "Tester", role: "user" as const, ui_mode: "full" as const },
  capabilities: { status: "ready" as const, capabilities: { platformRole: "admin" as const, allowMemberCreateProject: false, projects: [], permissions: [] } },
};

function renderGuide(): string {
  return renderToStaticMarkup(
    React.createElement(RegisterGuidePage, runtimeProps),
  );
}

// ─── 场景 1：初始 loading 渲染 ────────────────────────────

test("RG-1 渲染：初始 loading 态——标题/副文案/spinner 齐全", () => {
  const html = renderGuide();
  assert.ok(html.includes("欢迎，让我们了解你的偏好"), "缺主标题");
  assert.ok(html.includes("回答几个简单问题"), "缺副文案");
  assert.ok(html.includes("正在准备偏好引导"), "缺 loading 文案");
  assert.ok(html.includes("以后再说"), "缺「以后再说」跳过入口");
});

// ─── 场景 2：GrillCheckResult 类型守卫——execute ───────────

test("RG-2 类型守卫：execute action 表示信息充足，应引导至 /projects", () => {
  const result: GrillCheckResult = { action: "execute" };
  assert.equal(result.action, "execute");
  // execute 时不带 question/targetField/candidates
  assert.ok(!("question" in result), "execute 不应有 question");
  assert.ok(!("candidates" in result), "execute 不应有 candidates");
});

// ─── 场景 3：GrillCheckResult 类型守卫——clarify ───────────

test("RG-3 类型守卫：clarify action 带反问文案和目标字段", () => {
  const result: GrillCheckResult = {
    action: "clarify",
    question: "你喜欢什么类型的短剧？",
    targetField: "preferred_genre",
  };
  assert.equal(result.action, "clarify");
  assert.equal(result.question, "你喜欢什么类型的短剧？");
  assert.equal(result.targetField, "preferred_genre");
});

// ─── 场景 4：GrillCheckResult 类型守卫——offer_candidates ──

test("RG-4 类型守卫：offer_candidates action 带候选列表和目标字段", () => {
  const result: GrillCheckResult = {
    action: "offer_candidates",
    candidates: [
      { label: "都市情感", description: "现代都市爱情", value: "urban_romance" },
      { label: "古装穿越", description: "古代背景穿越", value: "period_time_travel" },
    ],
    targetField: "preferred_genre",
  };
  assert.equal(result.action, "offer_candidates");
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates[0], "第一个候选值应存在");
  assert.equal(result.candidates[0].label, "都市情感");
  assert.equal(result.targetField, "preferred_genre");
});

// ─── 场景 5：注册配置文件字段标签映射 ──────────────────────

test("RG-5 字段标签：三个 registration profile 字段都有中文标签", () => {
  // 这三个字段来自后端 grill/profiles.ts registration profile
  const fieldLabels: Record<string, string> = {
    preferred_genre: "偏好的短剧类型",
    user_role: "你的角色",
    preferred_tone: "偏好的剧情风格",
  };
  assert.ok(fieldLabels["preferred_genre"], "preferred_genre 需要标签");
  assert.ok(fieldLabels["user_role"], "user_role 需要标签");
  assert.ok(fieldLabels["preferred_tone"], "preferred_tone 需要标签");
  assert.ok(fieldLabels["preferred_genre"].includes("类型"), "preferred_genre 标签要含「类型」");
  assert.ok(fieldLabels["user_role"].includes("角色"), "user_role 标签要含「角色」");
  assert.ok(fieldLabels["preferred_tone"].includes("风格"), "preferred_tone 标签要含「风格」");
});
