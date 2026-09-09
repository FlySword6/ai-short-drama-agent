/* ============================================================
   operations.ts — 运营底座前端域（合同 v0.2.0/operations-foundation）

   硬规矩（合同 §设计纪律）：
   - 入口显隐全部由 GET /api/v1/me/capabilities 驱动，前端不自判角色；
   - 成本三处同源：概览/排行/后台只许调 costs 接口，禁止前端自己算；
   - 403（看得到但不能做）给人话，404 自然消失于列表不额外过滤。
   wire 事实：success() 递归 toSnakeCaseJson——全部按 snake 读、归一为 camel。
   纯逻辑、零 DOM，node:test 直接 import（s12-operations.test.ts）。
   ============================================================ */

/* ---------- 类型（合同 §一/§二） ---------- */

export type PlatformRole = "admin" | "operator" | "member";
/** 文案分叉用的角色口径：权限读到了才有角色，读取中/读不到是 unknown——它不等于「不是管理员」。 */
export type PlatformRoleForCopy = PlatformRole | "unknown";
export type ProjectRole = "owner" | "editor" | "viewer";

export interface Capabilities {
  platformRole: PlatformRole;
  allowMemberCreateProject: boolean;
  /** 当前用户是成员的项目及角色；非成员项目天然不在列表（后端 404 口径）。 */
  projects: Array<{ projectId: string; role: ProjectRole }>;
  permissions: string[];
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  username: string;
  displayName: string;
  platformRole: PlatformRole;
  projectRole: ProjectRole;
  addedByUserId: string | null;
  createdAt: string;
}

export interface CostAggregateRow {
  key: string;
  label: string;
  chargedPoints: number;
  /** 未计价笔数（未知价格按 0 聚合但单独标出，不伪造价格）——有就要如实显示。 */
  unpricedCount: number;
  entryCount: number;
}

export interface CostAggregatePage {
  groupBy: string;
  rows: CostAggregateRow[];
  totals: { chargedPoints: number; unpricedCount: number; entryCount: number };
  total: number;
  page: number;
  pageSize: number;
}

/** 项目消耗页聚合维度（GET /projects/:id/costs?group_by= 必填,与后端 zod 枚举一致）。 */
export type ProjectCostGroupBy = "day" | "member" | "model";

export const PROJECT_COST_GROUP_BY_LABEL: Record<ProjectCostGroupBy, string> = { day: "按日期", member: "按成员", model: "按模型" };

export interface TeamRecord {
  id: string;
  name: string;
  parentTeamId: string | null;
  createdAt: string;
}

export interface UserGroupRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface UserDirectoryRecord {
  id: string;
  username: string;
  displayName: string;
  platformRole: PlatformRole;
  active: boolean;
  createdAt: string;
}

/* ---------- 题材（S24 解冻：自由文本,建议词走 genre_suggestions 词表接口） ---------- */

export type ProjectGenre = string;

/* ---------- 归一 mapper（snake wire → camel） ---------- */

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean => v === true;
const optStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function platformRoleOf(v: unknown): PlatformRole {
  return v === "admin" || v === "operator" ? v : "member";
}
function projectRoleOf(v: unknown): ProjectRole {
  return v === "owner" || v === "editor" ? v : "viewer";
}

export function capabilitiesFromUnknown(value: unknown): Capabilities {
  const r = (value ?? {}) as Raw;
  const projects = Array.isArray(r.projects) ? r.projects : [];
  return {
    platformRole: platformRoleOf(r.platform_role),
    allowMemberCreateProject: bool(r.allow_member_create_project),
    projects: projects.map((item) => {
      const p = (item ?? {}) as Raw;
      return { projectId: str(p.project_id), role: projectRoleOf(p.role) };
    }).filter((p) => p.projectId !== ""),
    permissions: Array.isArray(r.permissions) ? r.permissions.filter((p): p is string => typeof p === "string") : [],
  };
}

export function memberFromUnknown(value: unknown): ProjectMember {
  const r = (value ?? {}) as Raw;
  return {
    projectId: str(r.project_id),
    userId: str(r.user_id),
    username: str(r.username),
    displayName: str(r.display_name) || str(r.username),
    platformRole: platformRoleOf(r.platform_role),
    projectRole: projectRoleOf(r.project_role ?? r.role),
    addedByUserId: optStr(r.added_by_user_id),
    createdAt: str(r.created_at),
  };
}

function costRowFromUnknown(value: unknown): CostAggregateRow {
  const r = (value ?? {}) as Raw;
  return {
    key: str(r.key),
    label: str(r.label) || str(r.key),
    chargedPoints: num(r.charged_points),
    unpricedCount: num(r.unpriced_count),
    entryCount: num(r.entry_count),
  };
}

export function costPageFromUnknown(value: unknown): CostAggregatePage {
  const r = (value ?? {}) as Raw;
  const totals = (r.totals ?? {}) as Raw;
  return {
    groupBy: str(r.group_by),
    rows: Array.isArray(r.rows) ? r.rows.map(costRowFromUnknown) : [],
    totals: { chargedPoints: num(totals.charged_points), unpricedCount: num(totals.unpriced_count), entryCount: num(totals.entry_count) },
    total: num(r.total),
    page: num(r.page) || 1,
    pageSize: num(r.page_size) || 20,
  };
}

export function teamFromUnknown(value: unknown): TeamRecord {
  const r = (value ?? {}) as Raw;
  return { id: str(r.id), name: str(r.name), parentTeamId: optStr(r.parent_team_id), createdAt: str(r.created_at) };
}

export function userGroupFromUnknown(value: unknown): UserGroupRecord {
  const r = (value ?? {}) as Raw;
  return { id: str(r.id), name: str(r.name), createdAt: str(r.created_at) };
}

export function directoryUserFromUnknown(value: unknown): UserDirectoryRecord {
  const r = (value ?? {}) as Raw;
  return {
    id: str(r.id),
    username: str(r.username),
    // S17-A1：/users/directory 用 camelCase(displayName)，/admin/users 用 snake_case——两源兼容
    displayName: str(r.display_name) || str(r.displayName) || str(r.username),
    platformRole: platformRoleOf(r.platform_role ?? r.role),
    active: r.active !== false,
    createdAt: str(r.created_at),
  };
}

/* ---------- #152 后台用户管理（合同 docs/design/prd-v2/admin.md §4） ---------- */

/** 管理视角的用户行：比选人目录多邮箱与积分账户（GET /admin/users 的完整行）。 */
export interface AdminUserAccount {
  id: string;
  username: string;
  displayName: string;
  platformRole: PlatformRole;
  active: boolean;
  email: string | null;
  /** 还没建过积分账户的账号为 null——界面如实显示「还没开账户」，不伪造 0。 */
  accountCredit: {
    balancePoints: number;
    dailyLimitPoints: number;
    usedTodayPoints: number;
    remainingTodayPoints: number;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export function adminUserAccountFromUnknown(value: unknown): AdminUserAccount {
  const r = (value ?? {}) as Raw;
  const credit = (r.account_credit ?? null) as Raw | null;
  return {
    id: str(r.id),
    username: str(r.username),
    displayName: str(r.display_name) || str(r.username),
    platformRole: platformRoleOf(r.role),
    active: r.active !== false,
    email: optStr(r.email),
    accountCredit: credit
      ? {
          balancePoints: num(credit.balance_points),
          dailyLimitPoints: num(credit.daily_limit_points),
          usedTodayPoints: num(credit.used_today_points),
          remainingTodayPoints: num(credit.remaining_today_points),
        }
      : null,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

/** 登录账号是身份锚点：改它会让审计断链（合同 admin.md §4.3），界面上只读并给这句说明。 */
export const USERNAME_READONLY_REASON = "登录账号是这个人的身份锚点，改不了——改了，他做过的事记在谁头上就断链了。要换账号：停用这个，再新开一个。";

/* ---------- 显隐与文案（入口显隐唯一判据=capabilities）
   硬规矩：这些助手只收「已拿到」的能力，一律不收可空值——收了 null 就必然有人
   把「没读到」当「没权限」。读取中/读不到怎么画，由 capabilities-state 的四值闸门
   在界面层决定。 ---------- */

/** 项目级角色；非成员= null（后端 404，前端不另做过滤）。 */
export function projectRoleOf_(caps: Capabilities, projectId: string): ProjectRole | null {
  return caps.projects.find((p) => p.projectId === projectId)?.role ?? null;
}

/** 平台后台入口（团队/分组/后台成本）：admin/operator 才见。 */
export function canSeeAdminConsole(caps: Capabilities): boolean {
  return caps.platformRole === "admin" || caps.platformRole === "operator";
}

/** 新建项目：admin/operator 或平台开关允许的 member。 */
export function canCreateProject(caps: Capabilities): boolean {
  return caps.platformRole !== "member" || caps.allowMemberCreateProject;
}

/** 创作按钮（生成/编辑/导入/引用）：viewer 不可见。 */
export function canCreateInProject(caps: Capabilities, projectId: string): boolean {
  const role = projectRoleOf_(caps, projectId);
  return role === "owner" || role === "editor";
}

/** 项目成本视图：viewer 默认不可见（合同矩阵 viewer ✗）。 */
export function canSeeProjectCosts(caps: Capabilities, projectId: string): boolean {
  const role = projectRoleOf_(caps, projectId);
  return role === "owner" || role === "editor";
}

/**
 * F14：新建项目成功瞬间把「创建者=负责人」本地并入 caps（真源重拉随后覆盖）。
 * 已有该项目的记录不动（以服务端为准）。只在已拿到的能力上并入——在「还不知道」
 * 的状态上编一份具体权限，等于换个地方撒谎。
 */
export function withOwnedProject(caps: Capabilities, projectId: string): Capabilities {
  if (caps.projects.some((entry) => entry.projectId === projectId)) return caps;
  return { ...caps, projects: [...caps.projects, { projectId, role: "owner" }] };
}

/** 通用素材（跨项目公共库）的裁决入口：仅平台 admin。 */
export function canModerateCommonAssets(caps: Capabilities): boolean {
  return caps.platformRole === "admin";
}

/** 成员/审核策略管理：仅 owner。 */
export function canManageProject(caps: Capabilities, projectId: string): boolean {
  return projectRoleOf_(caps, projectId) === "owner";
}

export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = { admin: "管理员", operator: "运营", member: "成员" };
/* 条 3 改词（DC：「查看人员/可创作」第一眼读不懂）：角色=负责人/可编辑/仅查看；
   新建表单栏叫「谁可以看这部剧」。运营词纪律：第一眼读不懂的一律不上界面。 */
export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = { owner: "负责人", editor: "可编辑", viewer: "仅查看" };

/** 件 6：403 人话（看得到但不能做）。按场景给一句，不抛错误码（条 3 改词同步）。 */
export function forbiddenMessage(context: "create" | "member" | "cost" | "admin" | "generic"): string {
  switch (context) {
    case "create": return "你在本项目仅可查看，创作需要负责人授权。";
    case "member": return "成员与审核策略只有项目负责人能管理。";
    case "cost": return "你在本项目仅可查看，成本视图不开放。";
    case "admin": return "后台只对管理员和运营开放。";
    default: return "你在本项目仅可查看，这个操作需要负责人授权。";
  }
}

/* ---------- S65 账户积分与邀请码（合同 v0.2.0/self-registration-and-account-credits） ----------
   定值：1 积分 = 1 分；issue #26 起自注册必须核销固定邀请码（注册赠送 50,000 积分、
   日额度 50,000）；邀请码明文只在创建响应出现一次。 */

export interface AccountCreditSummary {
  userId: string;
  balancePoints: number;
  dailyLimitPoints: number;
  usedTodayPoints: number;
  remainingTodayPoints: number;
  /** Asia/Shanghai 自然日（服务端口径）。 */
  dayDate: string;
  pointToFen: number;
}

export interface InviteTier {
  id: string;
  code: string;
  name: string;
  grantPoints: number;
  dailyLimitPoints: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InviteCode {
  id: string;
  /** 掩码前缀（如 SD-ON••••）；明文永不回流。 */
  prefix: string;
  tierId: string;
  tierCode: string;
  /** 发码当刻的档位快照；后续改档不回写。 */
  grantPoints: number;
  dailyLimitPoints: number;
  maxRedemptions: number;
  usedRedemptions: number;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SelfRegistrationCreditPolicy {
  policyKey: string;
  dailyLimitPoints: number;
  updatedAt: string;
}

export interface AccountCreditAdjustment {
  userId: string;
  balancePoints: number;
  amountPoints: number;
  reason: string;
  createdAt: string;
}

export function accountCreditSummaryFromUnknown(value: unknown): AccountCreditSummary {
  const r = (value ?? {}) as Raw;
  return {
    userId: str(r.user_id),
    balancePoints: num(r.balance_points),
    dailyLimitPoints: num(r.daily_limit_points),
    usedTodayPoints: num(r.used_today_points),
    remainingTodayPoints: num(r.remaining_today_points),
    dayDate: str(r.day_date),
    pointToFen: num(r.point_to_fen) || 1,
  };
}

export function inviteTierFromUnknown(value: unknown): InviteTier {
  const r = (value ?? {}) as Raw;
  return {
    id: str(r.id),
    code: str(r.code),
    name: str(r.name),
    grantPoints: num(r.grant_points),
    dailyLimitPoints: num(r.daily_limit_points),
    active: bool(r.active),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function inviteCodeFromUnknown(value: unknown): InviteCode {
  const r = (value ?? {}) as Raw;
  const expiresAt = optStr(r.expires_at);
  return {
    id: str(r.id),
    prefix: str(r.prefix),
    tierId: str(r.tier_id),
    tierCode: str(r.tier_code),
    grantPoints: num(r.grant_points),
    dailyLimitPoints: num(r.daily_limit_points),
    maxRedemptions: num(r.max_redemptions),
    usedRedemptions: num(r.used_redemptions),
    expiresAt,
    active: bool(r.active),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function selfRegistrationPolicyFromUnknown(value: unknown): SelfRegistrationCreditPolicy {
  const r = (value ?? {}) as Raw;
  return { policyKey: str(r.policy_key), dailyLimitPoints: num(r.daily_limit_points), updatedAt: str(r.updated_at) };
}

export function accountCreditAdjustmentFromUnknown(value: unknown): AccountCreditAdjustment {
  const r = (value ?? {}) as Raw;
  return {
    userId: str(r.user_id),
    balancePoints: num(r.balance_points),
    amountPoints: num(r.amount_points),
    reason: str(r.reason),
    createdAt: str(r.created_at),
  };
}

/* ---------- 邀请码派生态（展示口径唯一出口） ---------- */

export type InviteCodeStatus = "active" | "exhausted" | "expired" | "revoked";

export function inviteCodeRemaining(code: Pick<InviteCode, "maxRedemptions" | "usedRedemptions">): number {
  return Math.max(0, code.maxRedemptions - code.usedRedemptions);
}

/** 状态判读顺序：停用 > 过期 > 用尽 > 可用（与后端核销口径同向）。 */
export function inviteCodeStatus(code: Pick<InviteCode, "active" | "expiresAt" | "maxRedemptions" | "usedRedemptions">, now: number = Date.now()): InviteCodeStatus {
  if (!code.active) return "revoked";
  if (code.expiresAt && new Date(code.expiresAt).getTime() <= now) return "expired";
  if (inviteCodeRemaining(code) <= 0) return "exhausted";
  return "active";
}

export const INVITE_CODE_STATUS_LABEL: Record<InviteCodeStatus, string> = {
  active: "可用",
  exhausted: "已用完",
  expired: "已过期",
  revoked: "已停用",
};

/* ---------- demo fixture（离线演示；真栈只走接口） ---------- */

export const DEMO_CAPABILITIES: Capabilities = {
  platformRole: "admin",
  allowMemberCreateProject: true,
  projects: [
    { projectId: "demo-project-1", role: "owner" },
    { projectId: "demo-project-2", role: "owner" },
    { projectId: "demo-project-3", role: "editor" },
  ],
  permissions: ["*"],
};

export const DEMO_MEMBERS: ProjectMember[] = [
  { projectId: "demo-project-2", userId: "demo-u-alice", username: "alice", displayName: "Alice", platformRole: "admin", projectRole: "owner", addedByUserId: null, createdAt: "2026-07-01T09:00:00Z" },
  { projectId: "demo-project-2", userId: "demo-u-chenmo", username: "chenmo", displayName: "陈默", platformRole: "member", projectRole: "editor", addedByUserId: "demo-u-alice", createdAt: "2026-07-03T10:00:00Z" },
  { projectId: "demo-project-2", userId: "demo-u-zhoul", username: "zhoulan", displayName: "周岚", platformRole: "member", projectRole: "viewer", addedByUserId: "demo-u-alice", createdAt: "2026-07-05T10:00:00Z" },
];

export const DEMO_ADMIN_COSTS_PROJECT: CostAggregatePage = {
  groupBy: "project",
  rows: [
    { key: "demo-project-2", label: "《杀穿女频》", chargedPoints: 1500, unpricedCount: 1, entryCount: 23 },
    { key: "demo-project-1", label: "《老公诈死》", chargedPoints: 920, unpricedCount: 0, entryCount: 16 },
    { key: "demo-project-3", label: "《回到1998》", chargedPoints: 240, unpricedCount: 0, entryCount: 5 },
  ],
  totals: { chargedPoints: 2660, unpricedCount: 1, entryCount: 44 },
  total: 3,
  page: 1,
  pageSize: 20,
};

/* S75 demo fixture：项目消耗三视图（day/member/model），与 DEMO_ADMIN_COSTS_PROJECT
   同口径——每个项目三视图的 totals 都等于后台按项目聚合的该行总账，
   从消耗排行点进项目页数字对得上；未计价笔数如实标出。 */
const DEMO_PROJECT_COST_ROWS: Record<string, Record<ProjectCostGroupBy, CostAggregateRow[]>> = {
  "demo-project-1": {
    day: [
      { key: "2026-07-13", label: "2026-07-13", chargedPoints: 300, unpricedCount: 0, entryCount: 5 },
      { key: "2026-07-14", label: "2026-07-14", chargedPoints: 420, unpricedCount: 0, entryCount: 7 },
      { key: "2026-07-15", label: "2026-07-15", chargedPoints: 200, unpricedCount: 0, entryCount: 4 },
    ],
    member: [
      { key: "demo-u-alice", label: "Alice", chargedPoints: 520, unpricedCount: 0, entryCount: 9 },
      { key: "demo-u-chenmo", label: "陈默", chargedPoints: 400, unpricedCount: 0, entryCount: 7 },
    ],
    model: [
      { key: "Seedance 2.0", label: "Seedance 2.0", chargedPoints: 600, unpricedCount: 0, entryCount: 6 },
      { key: "Seedream 4.5", label: "Seedream 4.5", chargedPoints: 320, unpricedCount: 0, entryCount: 10 },
    ],
  },
  "demo-project-2": {
    day: [
      { key: "2026-07-12", label: "2026-07-12", chargedPoints: 400, unpricedCount: 0, entryCount: 6 },
      { key: "2026-07-13", label: "2026-07-13", chargedPoints: 350, unpricedCount: 1, entryCount: 5 },
      { key: "2026-07-14", label: "2026-07-14", chargedPoints: 500, unpricedCount: 0, entryCount: 8 },
      { key: "2026-07-15", label: "2026-07-15", chargedPoints: 250, unpricedCount: 0, entryCount: 4 },
    ],
    member: [
      { key: "demo-u-alice", label: "Alice", chargedPoints: 800, unpricedCount: 0, entryCount: 12 },
      { key: "demo-u-chenmo", label: "陈默", chargedPoints: 500, unpricedCount: 1, entryCount: 8 },
      { key: "demo-u-zhoul", label: "周岚", chargedPoints: 200, unpricedCount: 0, entryCount: 3 },
    ],
    model: [
      { key: "Seedance 2.0", label: "Seedance 2.0", chargedPoints: 900, unpricedCount: 0, entryCount: 11 },
      { key: "Seedream 4.5", label: "Seedream 4.5", chargedPoints: 350, unpricedCount: 0, entryCount: 8 },
      { key: "Seedance 2.0 Fast", label: "Seedance 2.0 Fast", chargedPoints: 250, unpricedCount: 1, entryCount: 4 },
    ],
  },
  "demo-project-3": {
    day: [
      { key: "2026-07-14", label: "2026-07-14", chargedPoints: 140, unpricedCount: 0, entryCount: 3 },
      { key: "2026-07-15", label: "2026-07-15", chargedPoints: 100, unpricedCount: 0, entryCount: 2 },
    ],
    member: [
      { key: "demo-u-alice", label: "Alice", chargedPoints: 240, unpricedCount: 0, entryCount: 5 },
    ],
    model: [
      { key: "Seedream 4.5", label: "Seedream 4.5", chargedPoints: 240, unpricedCount: 0, entryCount: 5 },
    ],
  },
};

export function demoProjectCostsPage(projectId: string, groupBy: ProjectCostGroupBy): CostAggregatePage {
  const rows = DEMO_PROJECT_COST_ROWS[projectId]?.[groupBy] ?? [];
  const totals = rows.reduce(
    (acc, row) => ({
      chargedPoints: acc.chargedPoints + row.chargedPoints,
      unpricedCount: acc.unpricedCount + row.unpricedCount,
      entryCount: acc.entryCount + row.entryCount,
    }),
    { chargedPoints: 0, unpricedCount: 0, entryCount: 0 },
  );
  return { groupBy, rows, totals, total: rows.length, page: 1, pageSize: 100 };
}

export const DEMO_TEAMS: TeamRecord[] = [
  { id: "demo-team-1", name: "未分配", parentTeamId: null, createdAt: "2026-07-01T00:00:00Z" },
  { id: "demo-team-2", name: "短剧一部", parentTeamId: null, createdAt: "2026-07-02T00:00:00Z" },
];

export const DEMO_USER_GROUPS: UserGroupRecord[] = [
  { id: "demo-ug-1", name: "编剧组", createdAt: "2026-07-02T00:00:00Z" },
  { id: "demo-ug-2", name: "美术组", createdAt: "2026-07-02T00:00:00Z" },
];

export const DEMO_DIRECTORY: UserDirectoryRecord[] = [
  { id: "demo-u-alice", username: "alice", displayName: "Alice", platformRole: "admin", active: true, createdAt: "2026-07-01T09:00:00Z" },
  { id: "demo-u-chenmo", username: "chenmo", displayName: "陈默", platformRole: "member", active: true, createdAt: "2026-07-03T10:00:00Z" },
  { id: "demo-u-zhoul", username: "zhoulan", displayName: "周岚", platformRole: "member", active: true, createdAt: "2026-07-05T10:00:00Z" },
];

/** #152 离线演示：与 DEMO_DIRECTORY 同三人，补管理视角的邮箱与积分账户。 */
export const DEMO_ADMIN_USER_ACCOUNTS: AdminUserAccount[] = DEMO_DIRECTORY.map((user, index) => ({
  ...user,
  email: `${user.username}@example.com`,
  accountCredit: index === 2
    ? null
    : { balancePoints: 12400 - index * 2000, dailyLimitPoints: 50000, usedTodayPoints: 860, remainingTodayPoints: 49140 },
  updatedAt: user.createdAt,
}));

/* S65 demo fixture：与迁移 034 种子口径一致（developer 10 万 / invited 5 万积分）。 */
export const DEMO_CREDIT_SUMMARY: AccountCreditSummary = {
  userId: "demo-user",
  balancePoints: 12400,
  dailyLimitPoints: 50000,
  usedTodayPoints: 860,
  remainingTodayPoints: 49140,
  dayDate: "2026-07-28",
  pointToFen: 1,
};

export const DEMO_INVITE_TIERS: InviteTier[] = [
  { id: "demo-tier-dev", code: "developer", name: "开发者", grantPoints: 100000, dailyLimitPoints: 100000, active: true, createdAt: "2026-07-27T00:00:00Z", updatedAt: "2026-07-27T00:00:00Z" },
  { id: "demo-tier-invited", code: "invited", name: "受邀用户", grantPoints: 50000, dailyLimitPoints: 50000, active: true, createdAt: "2026-07-27T00:00:00Z", updatedAt: "2026-07-27T00:00:00Z" },
];

export const DEMO_INVITE_CODES: InviteCode[] = [
  { id: "demo-code-1", prefix: "SD-K7X2••••", tierId: "demo-tier-dev", tierCode: "developer", grantPoints: 100000, dailyLimitPoints: 100000, maxRedemptions: 5, usedRedemptions: 2, expiresAt: null, active: true, createdAt: "2026-07-27T03:00:00Z", updatedAt: "2026-07-27T03:00:00Z" },
  { id: "demo-code-2", prefix: "SD-M3Q9••••", tierId: "demo-tier-invited", tierCode: "invited", grantPoints: 50000, dailyLimitPoints: 50000, maxRedemptions: 1, usedRedemptions: 1, expiresAt: null, active: true, createdAt: "2026-07-27T04:00:00Z", updatedAt: "2026-07-27T04:00:00Z" },
  { id: "demo-code-3", prefix: "SD-T8W4••••", tierId: "demo-tier-invited", tierCode: "invited", grantPoints: 50000, dailyLimitPoints: 50000, maxRedemptions: 3, usedRedemptions: 0, expiresAt: "2026-08-31T16:00:00Z", active: false, createdAt: "2026-07-27T05:00:00Z", updatedAt: "2026-07-27T06:00:00Z" },
];

export const DEMO_SELF_REGISTRATION_POLICY: SelfRegistrationCreditPolicy = {
  policyKey: "self_registration",
  dailyLimitPoints: 50000,
  updatedAt: "2026-07-27T00:00:00Z",
};

/* 题材建议已随 S24 接线到 genre_suggestions 词表（api.vocabularyGenres /
   api.addVocabularyGenre）;localStorage 自定义题材机制（CUSTOM_GENRES_KEY）
   随之删除——换台电脑就丢的私有记忆不再是事实来源。 */
