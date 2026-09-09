/* ============================================================
   lite-review.ts — Lite 就地审核（#187 拍板 A）的权限判定与文案助手。
   纯函数零 DOM，node:test 直接 import。

   权限镜像 = 后端 reviews/repository.ts canDecideProjectReview：
   平台 admin 恒可；operator 恒不可；项目 owner 可；项目成员且是该媒体
   类型的指定审核人可；其余不可。前端据此决定候选图上出不出
   「通过并选用」；出不出来都不得把人引去别的页面（等审核条说清找谁）。
   ============================================================ */
import type { Capabilities, ProjectMember } from "../../operations";

/** 当前用户对本项目产物有没有终审权（与后端裁决口径逐条对齐）。
    只收已拿到的能力：还没读到、读不到不是「无权」，那两态由调用方在上层画。 */
export function canDecideLiteReview(
  capabilities: Capabilities,
  projectId: string,
  userId: string,
  reviewerUserId: string | null | undefined,
): boolean {
  if (capabilities.platformRole === "admin") return true;
  if (capabilities.platformRole === "operator") return false;
  const role = capabilities.projects.find((project) => project.projectId === projectId)?.role ?? null;
  if (role === "owner") return true;
  return role !== null && reviewerUserId != null && reviewerUserId === userId;
}

/** 「谁能过这张」的名字清单：指定审核人（在成员里）+ 项目 owner，去重保序。
    成员列表对普通成员不可读（operations 成员端点 owner/admin 限定），
    读不到时调用方退回「项目审核人」通称，不编造名字。 */
export function liteReviewerNames(members: readonly ProjectMember[], reviewerUserId: string | null | undefined): string[] {
  const names: string[] = [];
  const push = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed && !names.includes(trimmed)) names.push(trimmed);
  };
  if (reviewerUserId) {
    const reviewer = members.find((member) => member.userId === reviewerUserId);
    if (reviewer) push(reviewer.displayName || reviewer.username);
  }
  for (const member of members) {
    if (member.projectRole === "owner") push(member.displayName || member.username);
  }
  return names;
}
