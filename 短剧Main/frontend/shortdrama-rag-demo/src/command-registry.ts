/* ============================================================
   command-registry.ts — ⌘K 命令面板指令注册表(S30)

   config_entries 里的指令行只有 id 与文案;id → 行为的映射在这里。
   面板对未注册的 id 一律报「这条指令还没接上」,不静默吞掉;
   新增指令=迁移播种一行 + 这里注册一个分支,组件不用动。

   落点原则:指令只负责导航到既有页面并带参数,动作本身由落点页
   的既有按钮/弹窗完成(付费红线:面板不替人点任何生成)。
   ============================================================ */

import { canSeeAdminConsole } from "./operations";
import { capabilityGate, type CapabilitiesState } from "./capabilities-state";
import type { CommandPaletteItem } from "./command-palette";

/** 已注册指令 id;迁移 026 播种的五行 + nav.queue(R2 壳,Fable 放行单①:
    注册表五→六;播种迁移行=sol 小件,守卫「五 id」期望由 Fable 合流时改)。 */
export const COMMAND_IDS = [
  "action.create_project",
  "action.create_shot",
  "nav.settings",
  "nav.releases",
  "nav.admin",
  "nav.queue",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export interface CommandExecutionContext {
  /** 当前项目 id(项目外为 null)。 */
  projectId: string | null;
  capabilities: CapabilitiesState;
  navigate: (path: string) => void;
}

/** 面板显隐:context/requires 之外,未知 id 不展示(没注册的指令不出现在面板)。 */
export function commandRegistered(command: string): command is CommandId {
  return (COMMAND_IDS as readonly string[]).includes(command);
}

export function commandAvailable(item: CommandPaletteItem, ctx: CommandExecutionContext): boolean {
  if (!commandRegistered(item.command)) return false;
  if (item.context === "project" && !ctx.projectId) return false;
  /* 权限没读到时不上架 admin 指令。面板里不解释这件事——它是一层浮在页面上的检索框,
     不是交代系统状态的地方;关掉面板,壳层那条「权限信息没读到 · 重试」就在页面顶上。 */
  if (item.requires === "admin" && capabilityGate(ctx.capabilities, canSeeAdminConsole) !== "allowed") return false;
  return true;
}

/**
 * 执行指令:导航到落点。未注册返回 false(调用方给人话)。
 * action.create_project 的落点弹窗是否展开由项目列表页按既有
  * 权限自行判定(canCreateProject),面板不越权代判。
 */
export function runPaletteCommand(command: string, ctx: CommandExecutionContext): boolean {
  if (!commandRegistered(command)) return false;
  switch (command) {
    case "action.create_project":
      ctx.navigate("/projects?create=1");
      return true;
    case "action.create_shot":
      if (!ctx.projectId) return false;
      ctx.navigate(`/projects/${encodeURIComponent(ctx.projectId)}/storyboards?addShot=1`);
      return true;
    case "nav.settings":
      ctx.navigate("/settings");
      return true;
    case "nav.releases":
      ctx.navigate("/settings?section=releases");
      return true;
    case "nav.admin":
      ctx.navigate("/admin");
      return true;
    case "nav.queue":
      ctx.navigate("/queue");
      return true;
  }
}
