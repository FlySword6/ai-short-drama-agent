/**
 * 运营底座的公开业务类型。
 *
 * 数据库列与 SQL 由 repository 持有；这里刻意只表达服务层需要的稳定业务
 * 合同，避免把 Drizzle 或迁移编号泄漏到 HTTP 层。
 */

export const PLATFORM_ROLES = ["admin", "operator", "member"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PROJECT_ROLES = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/**
 * 项目生产职责与 owner/editor/viewer 访问权限正交。一个成员可以承担多个
 * 职责，但职责本身不授予审核、成员管理或付费生成权限。
 */
export const PROJECT_PRODUCTION_ROLES = [
  "director",
  "art",
  "screenwriter",
  "coordinator",
  "reviewer",
] as const;
export type ProjectProductionRole = (typeof PROJECT_PRODUCTION_ROLES)[number];

export const REVIEW_STRATEGIES = ["automatic", "pending_review"] as const;
export type ReviewStrategy = (typeof REVIEW_STRATEGIES)[number];

/**
 * 项目体裁为自由文本（S24 解冻）：建议词来自 vocabulary 模块的
 * genre_suggestions 表，入库不再限定固定枚举。
 */
export type ProjectGenre = string;

export type ProjectCostGroupBy = "member" | "model" | "day";
export type AdminCostGroupBy = "project" | "team" | "user" | "model";

export interface OperationsActor {
  userId: string;
  sessionId?: string;
}

export interface CurrentActor {
  userId: string;
  username: string;
  displayName: string;
  role: PlatformRole;
}

export interface ProjectMembership {
  projectId: string;
  userId: string;
  username: string;
  displayName: string;
  platformRole: PlatformRole;
  projectRole: ProjectRole;
  productionRoles: ProjectProductionRole[];
  addedByUserId: string | null;
  createdAt: Date;
}

export interface TeamRecord {
  id: string;
  name: string;
  parentTeamId: string | null;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserDirectoryRecord {
  id: string;
  username: string;
  displayName: string;
  platformRole: PlatformRole;
  active: boolean;
  createdAt: Date;
}

export interface UserGroupRecord {
  id: string;
  name: string;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperationList<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProjectReviewPolicyPatch {
  defaultStrategy?: ReviewStrategy;
  reviewerUserId?: string | null;
}

export interface ProjectOperationsPatch {
  genre?: ProjectGenre | null;
  reviewPolicies?: Partial<Record<"image" | "video", ProjectReviewPolicyPatch>>;
}

export interface ProjectOperationsRecord {
  id: string;
  ownerUserId: string;
  teamId: string | null;
  genre: ProjectGenre | null;
  reviewPolicies: Array<{
    mediaKind: "image" | "video";
    defaultStrategy: ReviewStrategy;
    reviewerUserId: string | null;
  }>;
}

export interface CostFilter {
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface CostAggregateRow {
  key: string;
  label: string;
  chargedPoints: number;
  unpricedCount: number;
  entryCount: number;
}

export interface CostAggregatePage {
  groupBy: ProjectCostGroupBy | AdminCostGroupBy;
  rows: CostAggregateRow[];
  totals: Omit<CostAggregateRow, "key" | "label">;
  total: number;
  page: number;
  pageSize: number;
}

export interface CapabilityProjectRole {
  projectId: string;
  role: ProjectRole;
  productionRoles: ProjectProductionRole[];
}

export interface Capabilities {
  platformRole: PlatformRole;
  allowMemberCreateProject: boolean;
  projectRoles: CapabilityProjectRole[];
  permissions: string[];
}

export interface OperationsStore {
  getCurrentActor(userId: string): Promise<CurrentActor | undefined>;
  getCapabilities(userId: string, allowMemberCreateProject: boolean): Promise<Capabilities>;
  listProjectMembers(actor: OperationsActor, projectId: string): Promise<ProjectMembership[]>;
  addProjectMember(
    actor: OperationsActor,
    projectId: string,
    input: {
      userId: string;
      role: ProjectRole;
      productionRoles?: ProjectProductionRole[];
    },
  ): Promise<ProjectMembership>;
  updateProjectMember(
    actor: OperationsActor,
    projectId: string,
    userId: string,
    input: {
      role?: ProjectRole;
      productionRoles?: ProjectProductionRole[];
    },
  ): Promise<ProjectMembership>;
  removeProjectMember(actor: OperationsActor, projectId: string, userId: string): Promise<void>;
  listTeams(actor: OperationsActor, filter: ListFilter): Promise<OperationList<TeamRecord>>;
  createTeam(actor: OperationsActor, input: { name: string; parentTeamId?: string | null }): Promise<TeamRecord>;
  updateTeam(actor: OperationsActor, teamId: string, input: { name?: string; parentTeamId?: string | null }): Promise<TeamRecord>;
  deleteTeam(actor: OperationsActor, teamId: string): Promise<void>;
  listTeamMembers(actor: OperationsActor, teamId: string): Promise<UserDirectoryRecord[]>;
  addTeamMember(actor: OperationsActor, teamId: string, userId: string): Promise<void>;
  removeTeamMember(actor: OperationsActor, teamId: string, userId: string): Promise<void>;
  listUserGroups(actor: OperationsActor, filter: ListFilter): Promise<OperationList<UserGroupRecord>>;
  createUserGroup(actor: OperationsActor, input: { name: string }): Promise<UserGroupRecord>;
  updateUserGroup(actor: OperationsActor, groupId: string, input: { name: string }): Promise<UserGroupRecord>;
  deleteUserGroup(actor: OperationsActor, groupId: string): Promise<void>;
  listUserGroupMembers(actor: OperationsActor, groupId: string): Promise<UserDirectoryRecord[]>;
  addUserGroupMember(actor: OperationsActor, groupId: string, userId: string): Promise<void>;
  removeUserGroupMember(actor: OperationsActor, groupId: string, userId: string): Promise<void>;
  getProjectCosts(
    actor: OperationsActor,
    projectId: string,
    groupBy: ProjectCostGroupBy,
    filter: CostFilter,
  ): Promise<CostAggregatePage>;
  getAdminCosts(
    actor: OperationsActor,
    groupBy: AdminCostGroupBy,
    filter: CostFilter,
  ): Promise<CostAggregatePage>;
  patchProjectOperations(
    actor: OperationsActor,
    projectId: string,
    patch: ProjectOperationsPatch,
  ): Promise<ProjectOperationsRecord>;
}

export interface ListFilter {
  page: number;
  pageSize: number;
  query?: string;
}
