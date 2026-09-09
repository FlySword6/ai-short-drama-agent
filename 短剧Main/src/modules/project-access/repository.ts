import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { projectMembers, projects } from "../../db/schema.js";
import type { ProjectAccessRecord, ProjectMembership } from "./types.js";

/**
 * PostgreSQL lookup for the two-level permission model. It only returns an
 * existing non-deleted project; the service deliberately turns every missing
 * or inaccessible result into the same 404 response.
 */
export class ProjectAccessRepository {
  constructor(private readonly db: Database) {}

  async findAccessRecord(actorId: string, projectId: string): Promise<ProjectAccessRecord | null> {
    const rows = await this.db.select({
      projectId: projects.id,
      ownerUserId: projects.ownerUserId,
      membershipRole: projectMembers.role,
    }).from(projects)
      .leftJoin(projectMembers, and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, actorId),
      ))
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      projectId: row.projectId,
      ownerUserId: row.ownerUserId,
      membershipRole: toMembershipRole(row.membershipRole),
    };
  }

  async findAccessRecords(actorId: string, projectIds: string[]): Promise<ProjectAccessRecord[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db.select({
      projectId: projects.id,
      ownerUserId: projects.ownerUserId,
      membershipRole: projectMembers.role,
    }).from(projects)
      .leftJoin(projectMembers, and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, actorId),
      ))
      .where(and(inArray(projects.id, projectIds), isNull(projects.deletedAt)));
    return rows.map((row) => ({
      projectId: row.projectId,
      ownerUserId: row.ownerUserId,
      membershipRole: toMembershipRole(row.membershipRole),
    }));
  }

  async listMemberships(projectId: string): Promise<ProjectMembership[]> {
    const rows = await this.db.select({
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      role: projectMembers.role,
    }).from(projectMembers).where(eq(projectMembers.projectId, projectId));
    return rows.flatMap((row) => {
      const role = toMembershipRole(row.role);
      return role ? [{ projectId: row.projectId, userId: row.userId, role }] : [];
    });
  }
}

function toMembershipRole(value: string | null): ProjectMembership["role"] | null {
  return value === "owner" || value === "editor" || value === "viewer" ? value : null;
}
