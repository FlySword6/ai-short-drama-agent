import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, relative, isAbsolute } from "node:path";

export default function (pi: ExtensionAPI) {
  const userId = process.env.PI_USER_ID || "unknown";
  const agentId = process.env.PI_AGENT_ID || "unknown";
  const role = process.env.PI_ROLE || "unknown";
  const projectId = process.env.PI_PROJECT_ID || "none";
  const workspaceDir = resolve(process.env.PI_WORKSPACE_DIR || ".");

  const ROLE_DESCRIPTIONS: Record<string, string> = {
    art: "美术 (Art) —— 负责图片/视频素材的生成与编辑。你能使用 create image、asset ingest --type=image。你不能使用 script *、scene *、render *、subtitle *、create video/audio。",
    director: "导演 (Director) —— 负责分镜编排、渲染合成、字幕、视频/音频生成。你能使用 scene *、render *、subtitle *、create video/audio、result *。你不能使用 script *、create image、project create/update。",
    writer: "编剧 (Writer) —— 负责剧本导入、分析和拆解，以及项目管理。你能使用 script *、project create/update、breakdown *。你不能使用 create *、scene *、render *、subtitle *。",
  };

  function isInside(p: string): boolean {
    const abs = isAbsolute(p) ? p : resolve(workspaceDir, p);
    const rel = relative(workspaceDir, abs);
    return !rel.startsWith("..") && !isAbsolute(rel);
  }
  function toAbs(p: string): string {
    return isAbsolute(p) ? p : resolve(workspaceDir, p);
  }
  function audit(action: string, d: Record<string, unknown>) {
    console.error('[AUDIT] ' + JSON.stringify({ ts: new Date().toISOString(), userId, agentId, action, ...d }));
  }

  pi.on("session_start", async (_e, ctx) => {
    if (ctx.hasUI) ctx.ui.notify('[Guard] ' + userId + ' @ ' + workspaceDir, 'info');
    audit("session_start", { workspaceDir });
  });

  pi.on("before_agent_start", async (event) => {
    const roleDesc = ROLE_DESCRIPTIONS[role] || "未知角色";
    const info = [
      "",
      "## 角色身份 (Role Identity)",
      "- 角色: " + role + " — " + roleDesc,
      "- 项目: " + projectId + (projectId && projectId !== "none" ? " (同一个项目由编剧/美术/导演三位 agent 协作)" : ""),
      "- 查询命令（scene list、project info、script list 等）在所有角色间共享，你可以跨角色查看他人的产出。",
      "- 执行命令（create image、script analyze、scene create 等）是角色专属的。如果用户要求你执行不属于你角色的命令，请拒绝并说明应由哪个角色负责。",
      "- shortdrama-cli 已被包装脚本限制，越权命令会返回 BLOCKED。不要尝试绕过包装脚本直接调用真实 CLI。",
      "",
      "## Workspace Isolation",
      "- User: " + userId,
      "- Agent: " + agentId,
      "- Workspace: " + workspaceDir,
      "- All file operations are restricted to this workspace.",
      "- Do NOT access paths outside this workspace.",
      "",
    ].join("\n");
    return { systemPrompt: event.systemPrompt + info };
  });

  pi.on("tool_call", async (event) => {
    // write
    if (event.toolName === "write") {
      const input = event.input as { path: string; content: string };
      const abs = toAbs(input.path);
      if (!isInside(abs)) {
        audit("BLOCK_WRITE", { path: input.path });
        return { block: true, reason: 'Access denied: "' + input.path + '" is outside your workspace (' + workspaceDir + ')' };
      }
      input.path = abs;
      audit("WRITE_OK", { path: abs });
    }
    // edit
    if (event.toolName === "edit") {
      const input = event.input as { path: string };
      const abs = toAbs(input.path);
      if (!isInside(abs)) {
        audit("BLOCK_EDIT", { path: input.path });
        return { block: true, reason: "Access denied: cannot edit files outside your workspace." };
      }
      input.path = abs;
    }
    // read
    if (event.toolName === "read") {
      const input = event.input as { path: string };
      const abs = toAbs(input.path);
      if (!isInside(abs)) {
        audit("BLOCK_READ", { path: input.path });
        return { block: true, reason: "Access denied: cannot read files outside your workspace." };
      }
      input.path = abs;
    }
    // bash
    if (event.toolName === "bash") {
      const input = event.input as { command: string; cwd?: string };
      const matches = input.command.match(/\/root\/data\/[^/]+\/[^/]+/g) || [];
      for (const m of matches) {
        if (!m.includes(agentId + "/" + userId)) {
          audit("BLOCK_BASH_OTHER", { cmd: input.command.slice(0, 100), attempted: m });
          return { block: true, reason: "Access denied: cannot access other tenants' directories (" + m + ")" };
        }
      }
      if (input.command.includes("/root/.pi/") || input.command.includes("/root/.pi-web/")) {
        audit("BLOCK_BASH_DEFAULT", { cmd: input.command.slice(0, 100) });
        return { block: true, reason: "Access denied: cannot access the default instance directories." };
      }
      // 阻止直接调用真实 CLI 绕过角色 wrapper
      if (input.command.includes("/root/.shortdrama/bin/shortdrama-cli")) {
        audit("BLOCK_REAL_CLI", { cmd: input.command.slice(0, 100) });
        return { block: true, reason: "Access denied: must use wrapper at bin/shortdrama-cli. Direct calls to real CLI are forbidden." };
      }
      if (/\brm\s+-rf\s+[\/~*]/.test(input.command) || /:\(\)\s*\{\s*:\|:&\s*\};:/.test(input.command)) {
        audit("BLOCK_DANGER", { cmd: input.command.slice(0, 100) });
        return { block: true, reason: "Blocked dangerous command." };
      }
      input.cwd = workspaceDir;
      audit("BASH_OK", { cmd: input.command.slice(0, 100) });
    }
  });

  pi.on("tool_result", async (event) => {
    audit("TOOL_RESULT", { tool: event.toolName, isError: event.isError });
  });
}
