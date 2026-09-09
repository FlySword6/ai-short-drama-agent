import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { notificationResultPath } from "./routing";
import { LiteTaskNotificationPanel } from "./pages/lite/lite-task-notification-badge";
import type { GenerationAttemptNotification } from "./types";

const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
/* K2G：notificationResultPath 自 app.tsx 收敛进 routing.ts（首页「最近动态」共用同一出口），
   目标计算断言跟着函数走；app.tsx 侧仍断调用点。 */
const routing = readFileSync(new URL("./routing.ts", import.meta.url), "utf8");
/* B(2026-08-19)：生成终态提醒的轮询/确认收敛进 task-notifications.ts，卡片渲染收敛进
   components/generation-notification-card.tsx——完整版 Dock 与 Lite 顶栏徽标共用，断言跟着走。 */
const taskNotifications = readFileSync(new URL("./task-notifications.ts", import.meta.url), "utf8");
const card = readFileSync(new URL("./components/generation-notification-card.tsx", import.meta.url), "utf8");
const liteShell = readFileSync(new URL("./pages/lite/lite-shell.tsx", import.meta.url), "utf8");
const badge = readFileSync(new URL("./pages/lite/lite-task-notification-badge.tsx", import.meta.url), "utf8");

function notification(partial: Partial<GenerationAttemptNotification> = {}): GenerationAttemptNotification {
  return {
    id: "n1",
    generation_request_id: "gr1",
    attempt_id: "at1",
    project_id: "p1",
    episode_id: "e1",
    shot_id: "s1",
    target_asset_entity_id: "a1",
    media_kind: "image",
    /* 与 home-next-step.test.ts 同款口径：GenerationStatus 含 string 会坍缩联合，
       Extract 出的 status 类型是 never，字面量需显式断言。 */
    status: "succeeded" as GenerationAttemptNotification["status"],
    display_reason: null,
    created_at: "2026-08-19T00:00:00Z",
    ...partial,
  };
}

test("S29 终态提醒是持久站内卡片：回到应用后轮询，用户明确确认才移除", () => {
  assert.ok(app.includes("GenerationAttemptNotificationDock"), "App 壳未挂载站内任务提醒");
  /* 轮询/确认收敛到共享 hook（task-notifications.ts）：完整版 Dock 与 Lite 徽标同一份。 */
  assert.ok(taskNotifications.includes("document.hidden || inFlight.current"), "隐藏标签页仍在无意义轮询");
  assert.ok(taskNotifications.includes('document.addEventListener("visibilitychange"'), "回到应用后没有立即刷新提醒");
  assert.ok(taskNotifications.includes("notificationResultPath"), "提醒没有按任务目标计算返回路径");
  assert.ok(taskNotifications.includes("未确认的提醒不许消失"), "未确认提醒语义缺失");
  /* 卡片（成功=查看结果/失败=查看任务，显式确认）收敛到共享卡组件。 */
  assert.ok(card.includes("查看结果"), "完成提醒没有查看结果入口");
  assert.ok(card.includes("查看任务"), "失败提醒没有查看任务入口");
  assert.ok(card.includes("onClick={() => void onAcknowledge(notification)}"), "缺少用户明确确认入口");
  assert.ok(card.includes('audio: "音频"'), "音频提醒标签缺失（audio 生成本该显示「音频任务」）");
  assert.ok(routing.includes("target_asset_entity_id: targetAssetEntityId"), "资产生成提醒会跳到无关页面");
  assert.equal(app.includes("if (notifications.length === 0) return null"), false, "空的 live region 不应被卸载");
});

test("v1.9 十.5 失败卡自动消退:失败终态卡 10s 自动确认,hover 暂停;成功卡保持显式确认", () => {
  assert.ok(card.includes("FailureAutoAckSection"), "失败卡应走自动确认组件");
  assert.ok(card.includes("FAILURE_AUTO_ACK_MS"), "自动确认倒计时应可配置常量(10s)");
  assert.ok(card.includes("onMouseEnter={() => setPaused(true)}"), "hover 应暂停倒计时");
  assert.ok(card.includes("onAck={() => void onAcknowledge(notification)}"), "失败卡自动确认应复用 acknowledge");
});

test("B(2026-08-19):Lite 任务提醒收敛顶栏徽标,右下 Dock 只在完整版;两处共用共享轮询/卡片", () => {
  assert.ok(app.includes("{!isLitePath ? <GenerationAttemptNotificationDock"), "Lite 页仍挂右下 Dock（应收敛为顶栏徽标）");
  assert.ok(liteShell.includes("<LiteTaskNotificationBadge"), "Lite 顶栏未挂任务提醒徽标");
  assert.ok(badge.includes("useGenerationNotifications"), "Lite 徽标未复用共享轮询（task-notifications.ts）");
  assert.ok(badge.includes("GenerationNotificationCard"), "Lite 徽标未复用共享卡片（generation-notification-card.tsx）");
  assert.ok(badge.includes("LiteTaskNotificationPanel"), "徽标缺少可独立渲染的面板组件");
});

test("S29 提醒接口只走站内 API，不接邮件、短信或第三方推送", () => {
  assert.ok(api.includes("/generation-attempt-notifications"), "缺少提醒读取接口");
  assert.ok(api.includes("/acknowledge"), "缺少提醒确认接口");
  assert.equal(/sendEmail|\/sms|Notification\.requestPermission/.test(api), false);
});

test("S76: queryString() 自带 ? 前缀，调用方不得再手写 ?(双问号会让 limit 静默丢失)", () => {
  assert.equal(/\?\$\{queryString/.test(api), false, "api.ts 出现 `?${queryString` 双问号拼接");
  assert.ok(api.includes("/asset-upload-notifications${queryString({ limit })}"));
  assert.ok(api.includes("/generation-attempt-notifications${queryString({ limit })}"));
});

test("B(2026-08-19):Lite 任务提醒面板真实渲染:空态/成功失败卡/「还有 N 条」摘要", () => {
  /* 面板是纯展示组件（无 hook），可直接 renderToStaticMarkup 真渲染断言——空态、成功卡、失败卡、
     剩余摘要都必须在。 */
  const html = renderToStaticMarkup(
    React.createElement(LiteTaskNotificationPanel, {
      notifications: [
        notification(),
        notification({
          id: "n2",
          media_kind: "video",
          status: "failed" as GenerationAttemptNotification["status"],
          display_reason: "配额不足",
        }),
        notification({ id: "n3", media_kind: "audio" }),
        notification({ id: "n4", media_kind: "image" }),
      ],
      onOpen: () => undefined,
      onAcknowledge: async () => undefined,
    }),
  );
  assert.ok(html.includes("图片任务已完成"), "成功图片卡未渲染");
  assert.ok(html.includes("视频任务失败"), "失败视频卡未渲染");
  assert.ok(html.includes("音频任务已完成"), "音频提醒标签缺失（audio 生成本该显示「音频任务」）");
  assert.ok(html.includes("查看结果"), "成功卡缺少查看结果入口");
  assert.ok(html.includes("查看任务"), "失败卡缺少查看任务入口");
  assert.ok(html.includes("还有 1 条任务更新"), "超过 3 条未给「还有 N 条」摘要");
  const empty = renderToStaticMarkup(
    React.createElement(LiteTaskNotificationPanel, { notifications: [], onOpen: () => undefined, onAcknowledge: async () => undefined }),
  );
  assert.ok(empty.includes("暂无新的任务提醒"), "空态缺提示");
});

test("查看去处跟随界面模式：Lite 生图/生音频后点「查看」落 Lite 资产详情，完整版仍落 /projects 页", () => {
  /* 完整版/无 window（Node 测试环境）：保持原目标不回归。 */
  assert.equal(notificationResultPath(notification()), "/projects/p1/assets/a1");
  assert.equal(
    notificationResultPath(notification({ target_asset_entity_id: null })),
    "/projects/p1/storyboards/e1/shots/s1",
  );
  assert.equal(
    notificationResultPath(notification({ target_asset_entity_id: null, shot_id: null })),
    "/projects/p1/storyboards",
  );
  /* Lite 模式：目标切换为 Lite 对应页（资产生成 → Lite 资产详情；分镜产物 → Lite 分镜详情；其余 → Lite 制作页）。
     Node 无 window 全局，用 Reflect 装最小 stub（DOM lib 已把 window 声明为完整 Window，
     反射写入绕开赋值类型检查；浏览器端本来就有这个全局）。 */
  Reflect.set(globalThis, "window", { location: { pathname: "/lite/projects/p1/assets" } });
  try {
    assert.equal(notificationResultPath(notification()), "/lite/projects/p1/assets/a1", "Lite 资产生成应落 Lite 资产详情页");
    assert.equal(
      notificationResultPath(notification({ target_asset_entity_id: null })),
      "/lite/projects/p1/shots/s1",
      "Lite 分镜产物应落 Lite 分镜详情页",
    );
    assert.equal(
      notificationResultPath(notification({ target_asset_entity_id: null, shot_id: null })),
      "/lite/projects/p1/workspace",
      "无锚点提醒在 Lite 应落制作页",
    );
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});
