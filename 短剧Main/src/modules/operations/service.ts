import { BadRequestError, ConflictError, isPostgresUniqueViolation } from "../../shared/errors.js";
import { OperationsRepository } from "./repository.js";
import type {
  AdminCostGroupBy,
  CostFilter,
  ListFilter,
  OperationsActor,
  OperationsStore,
  ProjectCostGroupBy,
  ProjectOperationsPatch,
  ProjectProductionRole,
  ProjectRole,
} from "./types.js";

export interface OperationsServiceOptions {
  /** Deployment policy, deliberately not a second database config table. */
  allowMemberCreateProject?: boolean;
}

/**
 * The service keeps transport validation and authorization-independent rules
 * out of the repository. Database authorization and all writes still remain
 * transactionally co-located with their audit action in OperationsRepository.
 */
export class OperationsService {
  private readonly allowMemberCreateProject: boolean;

  constructor(
    private readonly store: OperationsStore,
    options: OperationsServiceOptions = {},
  ) {
    this.allowMemberCreateProject = options.allowMemberCreateProject ?? false;
  }

  getCapabilities(userId: string) {
    return this.store.getCapabilities(userId, this.allowMemberCreateProject);
  }

  listProjectMembers(actor: OperationsActor, projectId: string) {
    return this.store.listProjectMembers(actor, projectId);
  }

  addProjectMember(
    actor: OperationsActor,
    projectId: string,
    input: {
      userId: string;
      role: ProjectRole;
      productionRoles?: ProjectProductionRole[];
    },
  ) {
    return this.withConflict("该成员或角色已发生变化，请刷新后重试", () =>
      this.store.addProjectMember(actor, projectId, input));
  }

  updateProjectMember(
    actor: OperationsActor,
    projectId: string,
    userId: string,
    input: {
      role?: ProjectRole;
      productionRoles?: ProjectProductionRole[];
    },
  ) {
    return this.withConflict("该成员或角色已发生变化，请刷新后重试", () =>
      this.store.updateProjectMember(actor, projectId, userId, input));
  }

  removeProjectMember(actor: OperationsActor, projectId: string, userId: string) {
    return this.store.removeProjectMember(actor, projectId, userId);
  }

  listTeams(actor: OperationsActor, filter: ListFilter) {
    return this.store.listTeams(actor, filter);
  }

  createTeam(actor: OperationsActor, input: { name: string; parentTeamId?: string | null }) {
    return this.withConflict("团队名称已经存在", () => this.store.createTeam(actor, {
      name: normalizeName(input.name),
      ...(input.parentTeamId === undefined ? {} : { parentTeamId: input.parentTeamId }),
    }));
  }

  updateTeam(actor: OperationsActor, teamId: string, input: { name?: string; parentTeamId?: string | null }) {
    return this.withConflict("团队名称已经存在", () => this.store.updateTeam(actor, teamId, normalizeTeamInput(input)));
  }

  deleteTeam(actor: OperationsActor, teamId: string) {
    return this.store.deleteTeam(actor, teamId);
  }

  listTeamMembers(actor: OperationsActor, teamId: string) {
    return this.store.listTeamMembers(actor, teamId);
  }

  addTeamMember(actor: OperationsActor, teamId: string, userId: string) {
    return this.store.addTeamMember(actor, teamId, userId);
  }

  removeTeamMember(actor: OperationsActor, teamId: string, userId: string) {
    return this.store.removeTeamMember(actor, teamId, userId);
  }

  listUserGroups(actor: OperationsActor, filter: ListFilter) {
    return this.store.listUserGroups(actor, filter);
  }

  createUserGroup(actor: OperationsActor, input: { name: string }) {
    return this.withConflict("用户分组名称已经存在", () => this.store.createUserGroup(actor, { name: normalizeName(input.name) }));
  }

  updateUserGroup(actor: OperationsActor, groupId: string, input: { name: string }) {
    return this.withConflict("用户分组名称已经存在", () => this.store.updateUserGroup(actor, groupId, { name: normalizeName(input.name) }));
  }

  deleteUserGroup(actor: OperationsActor, groupId: string) {
    return this.store.deleteUserGroup(actor, groupId);
  }

  listUserGroupMembers(actor: OperationsActor, groupId: string) {
    return this.store.listUserGroupMembers(actor, groupId);
  }

  addUserGroupMember(actor: OperationsActor, groupId: string, userId: string) {
    return this.store.addUserGroupMember(actor, groupId, userId);
  }

  removeUserGroupMember(actor: OperationsActor, groupId: string, userId: string) {
    return this.store.removeUserGroupMember(actor, groupId, userId);
  }

  getProjectCosts(actor: OperationsActor, projectId: string, groupBy: ProjectCostGroupBy, filter: CostFilter) {
    return this.store.getProjectCosts(actor, projectId, groupBy, validateCostFilter(filter));
  }

  getAdminCosts(actor: OperationsActor, groupBy: AdminCostGroupBy, filter: CostFilter) {
    return this.store.getAdminCosts(actor, groupBy, validateCostFilter(filter));
  }

  patchProjectOperations(actor: OperationsActor, projectId: string, patch: ProjectOperationsPatch) {
    if (patch.genre === undefined && !hasReviewPolicyChange(patch)) {
      throw new BadRequestError("至少提供一个要修改的项目运营字段");
    }
    return this.store.patchProjectOperations(actor, projectId, patch);
  }

  static fromDatabase(db: ConstructorParameters<typeof OperationsRepository>[0], options: OperationsServiceOptions = {}) {
    return new OperationsService(new OperationsRepository(db), options);
  }

  private async withConflict<T>(message: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError(message, "duplicate_resource");
      throw error;
    }
  }
}

function normalizeTeamInput(input: { name?: string; parentTeamId?: string | null }) {
  return {
    ...(input.name === undefined ? {} : { name: normalizeName(input.name) }),
    ...(input.parentTeamId === undefined ? {} : { parentTeamId: input.parentTeamId }),
  };
}

function normalizeName(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new BadRequestError("名称不能为空");
  return normalized;
}

function validateCostFilter(filter: CostFilter): CostFilter {
  if (filter.from && filter.to && filter.from.getTime() > filter.to.getTime()) {
    throw new BadRequestError("开始日期不能晚于结束日期");
  }
  return filter;
}

function hasReviewPolicyChange(patch: ProjectOperationsPatch): boolean {
  return Object.values(patch.reviewPolicies ?? {}).some((policy) => policy !== undefined);
}
