/* ============================================================
   lite-project-dialog.test.ts — Lite 项目弹窗成员选人回归守卫（2026-08-10）

   病根：选人下拉 portal 到 body 后继承 Radix modal Dialog 打在 body 上的
   pointer-events:none，鼠标事件穿透 → pick 永不触发 →「选择人员没有回显」。
   同时 PRD 口径「聚焦即展示全部可加用户」要求下拉排除已是成员的人，
   否则点已加入者只能吃「已经在成员里了」死路。

   机制：源码级断言锁定两处接线——菜单 pointerEvents:"auto" 必带；
   Lite 弹窗 excludeUserIds 必须含当前用户与全部成员。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const userSearchInput = readFileSync(new URL("./components/user-search-input.tsx", import.meta.url), "utf8");
const multiUserPicker = readFileSync(new URL("./components/multi-user-picker.tsx", import.meta.url), "utf8");
const liteProjectDialog = readFileSync(new URL("./pages/lite/lite-project-dialog.tsx", import.meta.url), "utf8");

describe("Lite 项目弹窗成员选人", () => {
  it("portal 菜单显式 pointerEvents:auto（modal Dialog 会给 body 打 none，继承即点选失灵）", () => {
    assert.ok(userSearchInput.includes('pointerEvents: "auto"'), "portal 菜单缺 pointerEvents:auto——modal 弹窗内点选会被穿透");
  });

  it("下拉只列可加用户：Lite 弹窗排除当前用户 + 已是成员的人", () => {
    assert.ok(userSearchInput.includes("excludeUserIds"), "组件缺 excludeUserIds 排除口");
    assert.ok(liteProjectDialog.includes("excludeUserIds={excludedPickerUserIds}"), "Lite 弹窗未接排除名单");
    assert.ok(
      liteProjectDialog.includes("currentUserId, ...members.map((member) => member.userId)"),
      "排除名单未含当前用户与全部成员",
    );
  });

  it("chip 保留移除入口（X + onRemove 接线）", () => {
    assert.ok(liteProjectDialog.includes("onRemove={removeMember}"), "Lite 弹窗未把 removeMember 接到 MultiUserPicker");
    assert.ok(multiUserPicker.includes("onRemove(member)"), "chip × 未调 onRemove");
    assert.ok(multiUserPicker.includes("X"), "chip 缺 X 删除图标");
  });

  it("multi-user-picker: portal 菜单显式 pointerEvents:auto（modal Dialog 会给 body 打 none，继承即点选失灵）", () => {
    assert.ok(multiUserPicker.includes('pointerEvents: "auto"'), "portal 菜单缺 pointerEvents:auto——modal 弹窗内点选会被穿透");
  });

  it("multi-user-picker: 排除名单走 ref（点选即刷新要读最新名单，否则刚加的人又列回来）", () => {
    assert.ok(multiUserPicker.includes("excludeRef.current"), "排除名单未走 ref——点选即刷新会读到旧名单");
  });

  it("multi-user-picker: 点选后保持展开并刷新候选（连续加人不断流）", () => {
    assert.ok(multiUserPicker.includes('runSearch("")'), "点选后未保持展开刷新候选——连续加人断");
  });

  it("多选加人场景点选后下拉保持展开并刷新候选（焦点未丢，关了再点已聚焦输入框不会再开）", () => {
    assert.ok(userSearchInput.includes("if (onPick) runSearch(\"\");"), "点选后未保持展开刷新——连续加人断");
    assert.ok(userSearchInput.includes("excludeRef.current"), "排除名单未走 ref——点选即刷新会读到旧名单");
  });
});
