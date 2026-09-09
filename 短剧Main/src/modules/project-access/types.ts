import type { PlatformRole } from "../auth/types.js";

export const PROJECT_MEMBERSHIP_ROLES = ["owner", "editor", "viewer"] as const;

export type ProjectMembershipRole = typeof PROJECT_MEMBERSHIP_ROLES[number];

export type ProjectAccessAction =
  | "read"
  | "create"
  | "manage_members"
  | "manage_review_policy"
  | "view_costs"
  | "delete";

export interface ProjectAccessActor {
  id: string;
  role?: PlatformRole;
}

export interface ProjectMembership {
  projectId: string;
  userId: string;
  role: ProjectMembershipRole;
}

export interface ProjectAccessRecord {
  projectId: string;
  ownerUserId: string;
  membershipRole: ProjectMembershipRole | null;
}

export interface ProjectAccess {
  projectId: string;
  actorId: string;
  platformRole: PlatformRole;
  membershipRole: ProjectMembershipRole | null;
  /** Admin/operator can discover a project without becoming project members. */
  isPlatformObserver: boolean;
}
