/* ============================================================
   s46b-project-settings.test.ts — S46 B-4 项目设置弹窗成员区重排 组件渲染断言
   R44①:角色下拉加 label / 添加成员成行 / 空态引导。
   渲染真实的 ProjectMembersSection(renderToStaticMarkup),不读源码字符串。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectMembersSection, type ProjectMembersSectionProps } from "./components/project-settings";
import type { ProjectMember } from "./operations";

function member(partial: Partial<ProjectMember>): ProjectMember {
  return {
    projectId: "p-1",
    userId: "u-1",
    username: "director",
    displayName: "导演一",
    platformRole: "member",
    projectRole: "editor",
    addedByUserId: null,
    createdAt: "2026-07-27T00:00:00Z",
    ...partial,
  };
}

function props(partial: Partial<ProjectMembersSectionProps> = {}): ProjectMembersSectionProps {
  return {
    members: [],
    membersError: "",
    busy: false,
    demoMode: true,
    newMemberName: "",
    newMemberRole: "viewer",
    onResolveDirectory: () => undefined,
    onNewMemberNameChange: () => undefined,
    onNewMemberRoleChange: () => undefined,
    onAddMember: () => undefined,
    onChangeRole: () => undefined,
    onRemoveMember: () => undefined,
    ...partial,
  };
}

function render(input: ProjectMembersSectionProps): string {
  return renderToStaticMarkup(React.createElement(ProjectMembersSection, input));
}

const owner = member({ userId: "u-0", username: "owner", displayName: "项目负责人", projectRole: "owner" });

test("B-4① 渲染:只有负责人时给空态引导(加谁/怎么加),不再一面白墙", () => {
  const html = render(props({ members: [owner] }));
  assert.ok(html.includes("还只有项目负责人"), "缺空态引导");
  assert.ok(html.includes("点「加成员」"), "引导缺行动指引");
});

test("B-4① 渲染:有协作成员后不显示空态引导", () => {
  const html = render(props({ members: [owner, member({ userId: "u-2", username: "art", displayName: "美术二" })] }));
  assert.ok(!html.includes("还只有项目负责人"), "引导误显示");
});

test("B-4① 渲染:角色下拉有可见 label——列头「角色」+ 加成员行「角色」", () => {
  const html = render(props({ members: [owner, member({})] }));
  // 列头一次 + 加成员行 caption 一次,至少两处可见「角色」字样。
  const occurrences = html.split(">角色<").length - 1;
  assert.ok(occurrences >= 2, `可见「角色」label 不足两处(实际 ${occurrences})`);
  assert.ok(html.includes(">成员<"), "缺列头「成员」");
  assert.ok(html.includes(">操作<"), "缺列头「操作」");
});

test("B-4① 渲染:添加成员成行——新成员/角色/加成员按钮同排底对齐", () => {
  const html = render(props({ members: [owner] }));
  assert.ok(html.includes("items-end"), "加成员行未底对齐成行");
  assert.ok(html.includes(">新成员<"), "缺「新成员」caption");
  assert.ok(html.includes('aria-label="新成员角色"'), "新成员角色下拉缺 aria-label");
  assert.ok(html.includes("加成员"), "缺加成员按钮");
});

test("B-4① 渲染:成员行角色下拉 aria-label 与移除入口保持", () => {
  const html = render(props({ members: [owner, member({})] }));
  assert.ok(html.includes("aria-label=\"调整 导演一 的角色\""), "成员角色下拉缺 aria-label");
  assert.ok(html.includes("aria-label=\"移除 导演一\""), "缺移除入口");
  assert.ok(html.includes("负责人"), "负责人徽章丢失");
});

test("B-4① 渲染:成员读取失败只报错误,不显示空态引导", () => {
  const html = render(props({ members: [], membersError: "成员列表读取失败，请稍后重试" }));
  assert.ok(html.includes("成员列表读取失败"), "错误条丢失");
  assert.ok(!html.includes("还只有项目负责人"), "错误态误导显示空态引导");
});
