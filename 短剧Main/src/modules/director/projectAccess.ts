import type { Database } from "../../db/client.js";
import { platformRoleOrMember } from "../auth/types.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type {
  ProjectAccess,
  ProjectAccessAction,
  ProjectAccessActor,
} from "../project-access/types.js";

/**
 * Director routes accept the complete authenticated user.  Keeping this
 * adapter tiny avoids a second, raw-SQL ownership policy in the 3D module.
 * A bare id survives only for old in-process callers and always means an
 * ordinary member; it can never accidentally gain an admin/operator grant.
 */
export type DirectorActor = string | ProjectAccessActor;

export interface DirectorProjectAccessPort {
  require(
    actor: ProjectAccessActor,
    projectId: string,
    action: ProjectAccessAction,
  ): Promise<ProjectAccess>;
}

export function createDirectorProjectAccess(db: Database): DirectorProjectAccessPort {
  return ProjectAccessService.fromDatabase(new ProjectAccessRepository(db));
}

export function toDirectorActor(input: DirectorActor): ProjectAccessActor {
  if (typeof input === "string") return { id: input, role: "member" };
  return { id: input.id, role: platformRoleOrMember(input.role) };
}
