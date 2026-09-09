import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { canReadGlobalCosts, platformRoleOrMember } from "../auth/types.js";
import type {
  ProjectAccess,
  ProjectAccessAction,
  ProjectAccessActor,
  ProjectAccessRecord,
  ProjectMembershipRole,
} from "./types.js";
import { ProjectAccessRepository } from "./repository.js";

export interface ProjectAccessRepositoryPort {
  findAccessRecord(actorId: string, projectId: string): Promise<ProjectAccessRecord | null>;
  findAccessRecords?(actorId: string, projectIds: string[]): Promise<ProjectAccessRecord[]>;
}

/**
 * One reusable permission decision point for project-scoped HTTP routes.
 *
 * A non-member must not be able to distinguish an inaccessible project from a
 * non-existent one. Once a caller is a project member (or a platform observer)
 * a disallowed action is a normal 403: the caller already knows the project.
 */
export class ProjectAccessService {
  private readonly repository: ProjectAccessRepositoryPort;

  constructor(repository: ProjectAccessRepositoryPort) {
    this.repository = repository;
  }

  static fromDatabase(repository: ProjectAccessRepository): ProjectAccessService {
    return new ProjectAccessService(repository);
  }

  async require(actor: ProjectAccessActor, projectId: string, action: ProjectAccessAction): Promise<ProjectAccess> {
    const record = await this.repository.findAccessRecord(actor.id, projectId);
    const access = resolveProjectAccess(actor, record);
    if (!access || isHiddenFromActor(access)) {
      throw hiddenProjectNotFound();
    }
    if (!canPerformProjectAction(access, action)) throw projectActionForbidden();
    return access;
  }

  async requireReadable(actor: ProjectAccessActor, projectId: string): Promise<ProjectAccess> {
    return this.require(actor, projectId, "read");
  }

  async requireCreative(actor: ProjectAccessActor, projectId: string): Promise<ProjectAccess> {
    return this.require(actor, projectId, "create");
  }

  async requireOwner(actor: ProjectAccessActor, projectId: string): Promise<ProjectAccess> {
    return this.require(actor, projectId, "manage_members");
  }

  async requireCostReadable(actor: ProjectAccessActor, projectId: string): Promise<ProjectAccess> {
    return this.require(actor, projectId, "view_costs");
  }

  /**
   * Batch form for read projections. Hidden projects are omitted rather than
   * rejected so callers can filter every relation edge before computing
   * counts, cursors or next actions. The policy remains centralized here.
   */
  async filterReadableProjectIds(
    actor: ProjectAccessActor,
    projectIds: Iterable<string>,
  ): Promise<Set<string>> {
    const ids = [...new Set(projectIds)];
    if (ids.length === 0) return new Set();
    const records = this.repository.findAccessRecords
      ? await this.repository.findAccessRecords(actor.id, ids)
      : (await Promise.all(ids.map((id) => this.repository.findAccessRecord(actor.id, id))))
        .filter((record): record is ProjectAccessRecord => record !== null);
    return new Set(records.flatMap((record) => {
      const access = resolveProjectAccess(actor, record);
      return access && !isHiddenFromActor(access) && canPerformProjectAction(access, "read")
        ? [record.projectId]
        : [];
    }));
  }
}

/**
 * Pure policy functions are exported to make every caller and test use the
 * exact same matrix. `projects.owner_user_id` is treated as an owner fallback
 * during the forward migration, while project_members remains the normal
 * source after migration 016 has populated it.
 */
export function resolveProjectAccess(
  actor: ProjectAccessActor,
  record: ProjectAccessRecord | null,
): ProjectAccess | null {
  if (!record) return null;
  const platformRole = platformRoleOrMember(actor.role);
  const membershipRole = record.membershipRole
    ?? (record.ownerUserId === actor.id ? "owner" : null);
  return {
    projectId: record.projectId,
    actorId: actor.id,
    platformRole,
    membershipRole,
    isPlatformObserver: platformRole === "admin" || platformRole === "operator",
  };
}

export function canPerformProjectAction(access: ProjectAccess, action: ProjectAccessAction): boolean {
  if (access.platformRole === "admin") return true;
  if (access.platformRole === "operator") return action === "read" || action === "view_costs";

  switch (action) {
    case "read":
      return access.membershipRole !== null;
    case "create":
    case "view_costs":
      return access.membershipRole === "owner" || access.membershipRole === "editor";
    case "manage_members":
    case "manage_review_policy":
    case "delete":
      return access.membershipRole === "owner";
  }
}

export function canReadProjectCosts(actor: ProjectAccessActor): boolean {
  return canReadGlobalCosts(actor.role);
}

export function membershipCanCreate(role: ProjectMembershipRole | null): boolean {
  return role === "owner" || role === "editor";
}

/**
 * Members without a project membership cannot learn whether a project exists.
 * Platform admin/operator are deliberately exempt: they have global read
 * visibility, so denied writes must be represented as 403 instead.
 */
function isHiddenFromActor(access: ProjectAccess): boolean {
  return access.platformRole === "member" && access.membershipRole === null;
}

function hiddenProjectNotFound(): NotFoundError {
  return new NotFoundError("项目不存在或你没有访问权限");
}

function projectActionForbidden(): ForbiddenError {
  return new ForbiddenError("你没有在该项目中执行此操作的权限");
}
