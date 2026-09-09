import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { settings } from "../../config/env.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessAction } from "../project-access/types.js";
import { PROJECT_PRODUCTION_ROLES } from "./types.js";
import type {
  AdminCostGroupBy,
  Capabilities,
  CostAggregatePage,
  CostAggregateRow,
  CostFilter,
  CurrentActor,
  ListFilter,
  OperationList,
  OperationsActor,
  OperationsStore,
  PlatformRole,
  ProjectCostGroupBy,
  ProjectMembership,
  ProjectOperationsPatch,
  ProjectOperationsRecord,
  ProjectProductionRole,
  ProjectRole,
  ReviewStrategy,
  TeamRecord,
  UserDirectoryRecord,
  UserGroupRecord,
} from "./types.js";

type SqlResult<T> = { rows: T[] };

interface ActorRow {
  id: string;
  username: string;
  display_name: string;
  role: string | null;
}

interface ProjectMemberRow {
  project_id: string;
  user_id: string;
  username: string;
  display_name: string;
  platform_role: string | null;
  project_role: string;
  production_roles: string[] | null;
  added_by_user_id: string | null;
  created_at: Date | string;
}

interface UserDirectoryRow {
  id: string;
  username: string;
  display_name: string;
  role: string | null;
  active: boolean;
  created_at: Date | string;
}

interface TeamRow {
  id: string;
  name: string;
  parent_team_id: string | null;
  member_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  total: number | string;
}

interface UserGroupRow {
  id: string;
  name: string;
  member_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  total: number | string;
}

interface ProjectOperationsRow {
  id: string;
  owner_user_id: string;
  team_id: string | null;
  genre: string | null;
}

interface ReviewPolicyRow {
  media_kind: string;
  default_strategy: string;
  reviewer_user_id: string | null;
}

interface CostRow {
  key: string;
  label: string;
  charged_points: number | string | null;
  unpriced_count: number | string | null;
  entry_count: number | string | null;
  total: number | string | null;
}

const users = table("users");
const projects = table("projects");
const projectMembers = table("project_members");
const projectMemberProductionRoles = table("project_member_production_roles");
const teams = table("teams");
const teamMembers = table("team_members");
const userGroups = table("user_groups");
const userGroupMembers = table("user_group_members");
const projectReviewPolicies = table("project_review_policies");
const costEntries = table("cost_entries");
const operationActions = table("admin_operation_actions");

/**
 * PostgreSQL is the operational source of truth. This repository intentionally
 * uses schema-qualified SQL: migration 016 and the shared Drizzle schema are
 * owned by the integration workstream, while this module remains independently
 * testable and cannot accidentally bind to a connection search_path.
 */
export class OperationsRepository implements OperationsStore {
  constructor(private readonly db: Database) {}

  async getCurrentActor(userId: string): Promise<CurrentActor | undefined> {
    const rows = await query<ActorRow>(this.db, sql`
      SELECT id, username, display_name, role
      FROM ${users}
      WHERE id = ${userId} AND active = TRUE
      LIMIT 1
    `);
    const row = rows[0];
    return row ? toActor(row) : undefined;
  }

  async getCapabilities(userId: string, allowMemberCreateProject: boolean): Promise<Capabilities> {
    const actor = await requireActor(this.db, userId);
    const rows = await query<{
      project_id: string;
      role: string;
      production_roles: string[] | null;
    }>(this.db, sql`
      SELECT pm.project_id, pm.role,
        ARRAY(
          SELECT production.role
          FROM ${projectMemberProductionRoles} production
          WHERE production.project_id = pm.project_id
            AND production.user_id = pm.user_id
          ORDER BY CASE production.role
            WHEN 'director' THEN 0
            WHEN 'art' THEN 1
            WHEN 'screenwriter' THEN 2
            WHEN 'coordinator' THEN 3
            WHEN 'reviewer' THEN 4
            ELSE 5
          END
        ) AS production_roles
      FROM ${projectMembers} pm
      INNER JOIN ${projects} p ON p.id = pm.project_id
      WHERE pm.user_id = ${userId} AND p.deleted_at IS NULL
      ORDER BY pm.project_id ASC
    `);
    return {
      platformRole: actor.role,
      allowMemberCreateProject,
      projectRoles: rows.flatMap((row) => isProjectRole(row.role)
        ? [{
            projectId: row.project_id,
            role: row.role,
            productionRoles: toProjectProductionRoles(row.production_roles),
          }]
        : []),
      permissions: platformPermissions(actor.role, allowMemberCreateProject),
    };
  }

  async listProjectMembers(actor: OperationsActor, projectId: string): Promise<ProjectMembership[]> {
    await assertProjectMemberManager(this.db, actor.userId, projectId);
    return readProjectMembers(this.db, projectId);
  }

  async addProjectMember(
    actor: OperationsActor,
    projectId: string,
    input: {
      userId: string;
      role: ProjectRole;
      productionRoles?: ProjectProductionRole[];
    },
  ): Promise<ProjectMembership> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await lockProject(db, projectId);
      await assertProjectMemberManager(db, actor.userId, projectId);
      await assertUserExists(db, input.userId);
      const previous = await readProjectMember(db, projectId, input.userId);

      if (input.role === "owner") {
        await transferProjectOwner(db, actor, projectId, input.userId);
      } else {
        await assertNotCurrentOwner(db, projectId, input.userId, input.role);
        const now = new Date();
        await db.execute(sql`
          INSERT INTO ${projectMembers} (project_id, user_id, role, added_by_user_id, created_at)
          VALUES (${projectId}, ${input.userId}, ${input.role}, ${actor.userId}, ${now})
          ON CONFLICT (project_id, user_id) DO UPDATE
          SET role = EXCLUDED.role, added_by_user_id = EXCLUDED.added_by_user_id
        `);
      }
      const productionRolesChanged = input.productionRoles === undefined
        ? false
        : await replaceProjectProductionRoles(
            db,
            actor.userId,
            projectId,
            input.userId,
            input.productionRoles,
          );
      const member = await readProjectMember(db, projectId, input.userId);
      if (!member) throw new Error("项目成员写入后未能读取");
      if (input.role !== "owner") {
        await writeOperationAudit(db, actor, {
          action: "project_member_added",
          targetType: "project_member",
          targetId: projectId,
          metadata: {
            project_id: projectId,
            user_id: input.userId,
            previous_role: previous?.projectRole ?? null,
            role: member.projectRole,
            production_roles: member.productionRoles,
          },
        });
        if (productionRolesChanged) {
          await writeProductionRolesAudit(
            db,
            actor,
            projectId,
            input.userId,
            previous?.productionRoles ?? [],
            member.productionRoles,
          );
        }
      } else if (productionRolesChanged) {
        await writeProductionRolesAudit(
          db,
          actor,
          projectId,
          input.userId,
          previous?.productionRoles ?? [],
          member.productionRoles,
        );
      }
      return member;
    });
  }

  async updateProjectMember(
    actor: OperationsActor,
    projectId: string,
    userId: string,
    input: {
      role?: ProjectRole;
      productionRoles?: ProjectProductionRole[];
    },
  ): Promise<ProjectMembership> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await lockProject(db, projectId);
      await assertProjectMemberManager(db, actor.userId, projectId);
      const current = await readProjectMember(db, projectId, userId);
      if (!current) throw new NotFoundError("项目成员不存在");
      if (input.role !== undefined) {
        if (input.role === "owner") {
          await transferProjectOwner(db, actor, projectId, userId);
        } else {
          await assertNotCurrentOwner(db, projectId, userId, input.role);
          await db.execute(sql`
            UPDATE ${projectMembers}
            SET role = ${input.role}, added_by_user_id = ${actor.userId}
            WHERE project_id = ${projectId} AND user_id = ${userId}
          `);
          await writeOperationAudit(db, actor, {
            action: "project_member_role_changed",
            targetType: "project_member",
            targetId: projectId,
            metadata: {
              project_id: projectId,
              user_id: userId,
              from_role: current.projectRole,
              to_role: input.role,
            },
          });
        }
      }
      if (input.productionRoles !== undefined) {
        const changed = await replaceProjectProductionRoles(
          db,
          actor.userId,
          projectId,
          userId,
          input.productionRoles,
        );
        if (changed) {
          await writeProductionRolesAudit(
            db,
            actor,
            projectId,
            userId,
            current.productionRoles,
            normalizeProjectProductionRoles(input.productionRoles),
          );
        }
      }
      const member = await readProjectMember(db, projectId, userId);
      if (!member) throw new Error("项目成员更新后未能读取");
      return member;
    });
  }

  async removeProjectMember(actor: OperationsActor, projectId: string, userId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await lockProject(db, projectId);
      await assertProjectMemberManager(db, actor.userId, projectId);
      const project = await readProject(db, projectId);
      if (!project) throw new NotFoundError("项目不存在");
      if (project.owner_user_id === userId) {
        throw new ConflictError("不能移除项目负责人；请先通过成员角色变更指定新负责人", "project_owner_required");
      }
      const current = await readProjectMember(db, projectId, userId);
      if (!current) throw new NotFoundError("项目成员不存在");
      const deleted = await query<{ user_id: string }>(db, sql`
        DELETE FROM ${projectMembers}
        WHERE project_id = ${projectId} AND user_id = ${userId}
        RETURNING user_id
      `);
      if (!deleted[0]) throw new ConflictError("成员已经发生变化，请刷新后重试");
      await writeOperationAudit(db, actor, {
        action: "project_member_removed",
        targetType: "project_member",
        targetId: projectId,
        metadata: {
          project_id: projectId,
          user_id: userId,
          project_role: current.projectRole,
          production_roles: current.productionRoles,
        },
      });
    });
  }

  async listTeams(actor: OperationsActor, filter: ListFilter): Promise<OperationList<TeamRecord>> {
    await assertAdmin(this.db, actor.userId);
    const queryText = normalizedSearch(filter.query);
    const offset = (filter.page - 1) * filter.pageSize;
    const rows = await query<TeamRow>(this.db, sql`
      WITH grouped AS (
        SELECT
          t.id, t.name, t.parent_team_id, t.created_at, t.updated_at,
          count(tm.user_id)::integer AS member_count
        FROM ${teams} t
        LEFT JOIN ${teamMembers} tm ON tm.team_id = t.id
        WHERE (${queryText}::text IS NULL OR t.name ILIKE '%' || ${queryText} || '%')
        GROUP BY t.id, t.name, t.parent_team_id, t.created_at, t.updated_at
      ), numbered AS (
        SELECT grouped.*, count(*) OVER()::integer AS total FROM grouped
      )
      SELECT * FROM numbered
      ORDER BY parent_team_id NULLS FIRST, name ASC, id ASC
      LIMIT ${filter.pageSize} OFFSET ${offset}
    `);
    return {
      items: rows.map(toTeam),
      total: numberValue(rows[0]?.total),
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }

  async createTeam(actor: OperationsActor, input: { name: string; parentTeamId?: string | null }): Promise<TeamRecord> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      await assertParentTeamAllowed(db, input.parentTeamId ?? null, null);
      const now = new Date();
      const id = randomUUID();
      const rows = await query<TeamRow>(db, sql`
        INSERT INTO ${teams} (id, name, parent_team_id, created_at, updated_at)
        VALUES (${id}, ${input.name}, ${input.parentTeamId ?? null}, ${now}, ${now})
        RETURNING id, name, parent_team_id, 0::integer AS member_count, created_at, updated_at, 1::integer AS total
      `);
      const team = rows[0];
      if (!team) throw new Error("团队创建失败");
      await writeOperationAudit(db, actor, {
        action: "team_created",
        targetType: "team",
        targetId: id,
        metadata: { name: input.name, parent_team_id: input.parentTeamId ?? null },
      });
      return toTeam(team);
    });
  }

  async updateTeam(
    actor: OperationsActor,
    teamId: string,
    input: { name?: string; parentTeamId?: string | null },
  ): Promise<TeamRecord> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const current = await lockTeam(db, teamId);
      if (!current) throw new NotFoundError("团队不存在");
      if (input.parentTeamId !== undefined) await assertParentTeamAllowed(db, input.parentTeamId, teamId);
      const now = new Date();
      const rows = await query<TeamRow>(db, sql`
        UPDATE ${teams}
        SET name = ${input.name ?? current.name},
            parent_team_id = ${input.parentTeamId === undefined ? current.parent_team_id : input.parentTeamId},
            updated_at = ${now}
        WHERE id = ${teamId}
        RETURNING id, name, parent_team_id,
          (SELECT count(*)::integer FROM ${teamMembers} tm WHERE tm.team_id = ${teamId}) AS member_count,
          created_at, updated_at, 1::integer AS total
      `);
      const team = rows[0];
      if (!team) throw new Error("团队更新失败");
      await writeOperationAudit(db, actor, {
        action: "team_updated",
        targetType: "team",
        targetId: teamId,
        metadata: { name: team.name, parent_team_id: team.parent_team_id },
      });
      return toTeam(team);
    });
  }

  async deleteTeam(actor: OperationsActor, teamId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const current = await lockTeam(db, teamId);
      if (!current) throw new NotFoundError("团队不存在");
      const dependencies = await query<{ child_count: number | string; member_count: number | string; project_count: number | string }>(db, sql`
        SELECT
          (SELECT count(*) FROM ${teams} WHERE parent_team_id = ${teamId}) AS child_count,
          (SELECT count(*) FROM ${teamMembers} WHERE team_id = ${teamId}) AS member_count,
          (SELECT count(*) FROM ${projects} WHERE team_id = ${teamId} AND deleted_at IS NULL) AS project_count
      `);
      const dependency = dependencies[0];
      if (dependency && [dependency.child_count, dependency.member_count, dependency.project_count]
        .some((value) => numberValue(value) > 0)) {
        throw new ConflictError("团队仍有关联子团队、成员或项目，不能删除", "team_in_use");
      }
      await db.execute(sql`DELETE FROM ${teams} WHERE id = ${teamId}`);
      await writeOperationAudit(db, actor, {
        action: "team_deleted",
        targetType: "team",
        targetId: teamId,
        metadata: { name: current.name },
      });
    });
  }

  async listTeamMembers(actor: OperationsActor, teamId: string): Promise<UserDirectoryRecord[]> {
    await assertAdmin(this.db, actor.userId);
    await assertTeamExists(this.db, teamId);
    const rows = await query<UserDirectoryRow>(this.db, sql`
      SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at
      FROM ${teamMembers} tm
      INNER JOIN ${users} u ON u.id = tm.user_id
      WHERE tm.team_id = ${teamId}
      ORDER BY u.display_name ASC, u.username ASC
    `);
    return rows.map(toUserDirectory);
  }

  async addTeamMember(actor: OperationsActor, teamId: string, userId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      await assertTeamExists(db, teamId);
      await assertUserExists(db, userId);
      await db.execute(sql`
        INSERT INTO ${teamMembers} (team_id, user_id, created_at)
        VALUES (${teamId}, ${userId}, ${new Date()})
        ON CONFLICT (team_id, user_id) DO NOTHING
      `);
      await writeOperationAudit(db, actor, {
        action: "team_member_added",
        targetType: "team_member",
        targetId: teamId,
        metadata: { team_id: teamId, user_id: userId },
      });
    });
  }

  async removeTeamMember(actor: OperationsActor, teamId: string, userId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const rows = await query<{ user_id: string }>(db, sql`
        DELETE FROM ${teamMembers}
        WHERE team_id = ${teamId} AND user_id = ${userId}
        RETURNING user_id
      `);
      if (!rows[0]) throw new NotFoundError("团队成员不存在");
      await writeOperationAudit(db, actor, {
        action: "team_member_removed",
        targetType: "team_member",
        targetId: teamId,
        metadata: { team_id: teamId, user_id: userId },
      });
    });
  }

  async listUserGroups(actor: OperationsActor, filter: ListFilter): Promise<OperationList<UserGroupRecord>> {
    await assertAdmin(this.db, actor.userId);
    const queryText = normalizedSearch(filter.query);
    const offset = (filter.page - 1) * filter.pageSize;
    const rows = await query<UserGroupRow>(this.db, sql`
      WITH grouped AS (
        SELECT g.id, g.name, g.created_at, g.updated_at, count(gm.user_id)::integer AS member_count
        FROM ${userGroups} g
        LEFT JOIN ${userGroupMembers} gm ON gm.user_group_id = g.id
        WHERE (${queryText}::text IS NULL OR g.name ILIKE '%' || ${queryText} || '%')
        GROUP BY g.id, g.name, g.created_at, g.updated_at
      ), numbered AS (
        SELECT grouped.*, count(*) OVER()::integer AS total FROM grouped
      )
      SELECT * FROM numbered
      ORDER BY name ASC, id ASC
      LIMIT ${filter.pageSize} OFFSET ${offset}
    `);
    return {
      items: rows.map(toUserGroup),
      total: numberValue(rows[0]?.total),
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }

  async createUserGroup(actor: OperationsActor, input: { name: string }): Promise<UserGroupRecord> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const now = new Date();
      const id = randomUUID();
      const rows = await query<UserGroupRow>(db, sql`
        INSERT INTO ${userGroups} (id, name, created_at, updated_at)
        VALUES (${id}, ${input.name}, ${now}, ${now})
        RETURNING id, name, 0::integer AS member_count, created_at, updated_at, 1::integer AS total
      `);
      const group = rows[0];
      if (!group) throw new Error("用户分组创建失败");
      await writeOperationAudit(db, actor, {
        action: "user_group_created",
        targetType: "user_group",
        targetId: id,
        metadata: { name: input.name },
      });
      return toUserGroup(group);
    });
  }

  async updateUserGroup(actor: OperationsActor, groupId: string, input: { name: string }): Promise<UserGroupRecord> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const rows = await query<UserGroupRow>(db, sql`
        UPDATE ${userGroups}
        SET name = ${input.name}, updated_at = ${new Date()}
        WHERE id = ${groupId}
        RETURNING id, name,
          (SELECT count(*)::integer FROM ${userGroupMembers} gm WHERE gm.user_group_id = ${groupId}) AS member_count,
          created_at, updated_at, 1::integer AS total
      `);
      const group = rows[0];
      if (!group) throw new NotFoundError("用户分组不存在");
      await writeOperationAudit(db, actor, {
        action: "user_group_updated",
        targetType: "user_group",
        targetId: groupId,
        metadata: { name: group.name },
      });
      return toUserGroup(group);
    });
  }

  async deleteUserGroup(actor: OperationsActor, groupId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const rows = await query<{ id: string; name: string }>(db, sql`
        DELETE FROM ${userGroups}
        WHERE id = ${groupId}
        RETURNING id, name
      `);
      const group = rows[0];
      if (!group) throw new NotFoundError("用户分组不存在");
      await writeOperationAudit(db, actor, {
        action: "user_group_deleted",
        targetType: "user_group",
        targetId: groupId,
        metadata: { name: group.name },
      });
    });
  }

  async listUserGroupMembers(actor: OperationsActor, groupId: string): Promise<UserDirectoryRecord[]> {
    await assertAdmin(this.db, actor.userId);
    await assertUserGroupExists(this.db, groupId);
    const rows = await query<UserDirectoryRow>(this.db, sql`
      SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at
      FROM ${userGroupMembers} gm
      INNER JOIN ${users} u ON u.id = gm.user_id
      WHERE gm.user_group_id = ${groupId}
      ORDER BY u.display_name ASC, u.username ASC
    `);
    return rows.map(toUserDirectory);
  }

  async addUserGroupMember(actor: OperationsActor, groupId: string, userId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      await assertUserGroupExists(db, groupId);
      await assertUserExists(db, userId);
      await db.execute(sql`
        INSERT INTO ${userGroupMembers} (user_group_id, user_id, created_at)
        VALUES (${groupId}, ${userId}, ${new Date()})
        ON CONFLICT (user_group_id, user_id) DO NOTHING
      `);
      await writeOperationAudit(db, actor, {
        action: "user_group_member_added",
        targetType: "user_group_member",
        targetId: groupId,
        metadata: { user_group_id: groupId, user_id: userId },
      });
    });
  }

  async removeUserGroupMember(actor: OperationsActor, groupId: string, userId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const rows = await query<{ user_id: string }>(db, sql`
        DELETE FROM ${userGroupMembers}
        WHERE user_group_id = ${groupId} AND user_id = ${userId}
        RETURNING user_id
      `);
      if (!rows[0]) throw new NotFoundError("用户分组成员不存在");
      await writeOperationAudit(db, actor, {
        action: "user_group_member_removed",
        targetType: "user_group_member",
        targetId: groupId,
        metadata: { user_group_id: groupId, user_id: userId },
      });
    });
  }

  async getProjectCosts(
    actor: OperationsActor,
    projectId: string,
    groupBy: ProjectCostGroupBy,
    filter: CostFilter,
  ): Promise<CostAggregatePage> {
    await assertProjectCostVisible(this.db, actor.userId, projectId);
    return aggregateCosts(this.db, groupBy, filter, sql`ce.project_id = ${projectId}`);
  }

  async getAdminCosts(
    actor: OperationsActor,
    groupBy: AdminCostGroupBy,
    filter: CostFilter,
  ): Promise<CostAggregatePage> {
    await assertOperatorOrAdmin(this.db, actor.userId);
    return aggregateCosts(this.db, groupBy, filter, sql`TRUE`);
  }

  async patchProjectOperations(
    actor: OperationsActor,
    projectId: string,
    patch: ProjectOperationsPatch,
  ): Promise<ProjectOperationsRecord> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await lockProject(db, projectId);
      await assertProjectAction(db, actor.userId, projectId, "manage_review_policy");
      const project = await readProject(db, projectId);
      if (!project) throw new NotFoundError("项目不存在");
      const now = new Date();

      if (patch.genre !== undefined) {
        await db.execute(sql`
          UPDATE ${projects}
          SET genre = ${patch.genre}, updated_at = ${now}
          WHERE id = ${projectId}
        `);
      }

      for (const [mediaKind, requested] of Object.entries(patch.reviewPolicies ?? {})) {
        if ((mediaKind !== "image" && mediaKind !== "video") || !requested) continue;
        if (requested.reviewerUserId !== undefined && requested.reviewerUserId !== null) {
          await assertProjectMemberExists(db, projectId, requested.reviewerUserId);
        }
        const current = (await query<ReviewPolicyRow>(db, sql`
          SELECT media_kind, default_strategy, reviewer_user_id
          FROM ${projectReviewPolicies}
          WHERE project_id = ${projectId} AND media_kind = ${mediaKind}
          FOR UPDATE
        `))[0];
        const defaultStrategy = requested.defaultStrategy ?? toReviewStrategy(current?.default_strategy) ?? "pending_review";
        const reviewerUserId = requested.reviewerUserId === undefined
          ? current?.reviewer_user_id ?? null
          : requested.reviewerUserId;
        await db.execute(sql`
          INSERT INTO ${projectReviewPolicies}
            (id, project_id, media_kind, default_strategy, reviewer_user_id, updated_by_user_id, version, created_at, updated_at)
          VALUES (${randomUUID()}, ${projectId}, ${mediaKind}, ${defaultStrategy}, ${reviewerUserId}, ${actor.userId}, 1, ${now}, ${now})
          ON CONFLICT (project_id, media_kind) DO UPDATE
          SET default_strategy = EXCLUDED.default_strategy,
              reviewer_user_id = EXCLUDED.reviewer_user_id,
              updated_by_user_id = EXCLUDED.updated_by_user_id,
              version = "project_review_policies".version + 1,
              updated_at = EXCLUDED.updated_at
        `);
      }

      const updated = await readProjectOperations(db, projectId);
      if (!updated) throw new Error("项目运营设置更新后未能读取");
      await writeOperationAudit(db, actor, {
        action: "project_operations_updated",
        targetType: "project",
        targetId: projectId,
        metadata: {
          genre: updated.genre,
          review_policies: updated.reviewPolicies.map((policy) => ({
            media_kind: policy.mediaKind,
            default_strategy: policy.defaultStrategy,
            reviewer_user_id: policy.reviewerUserId,
          })),
        },
      });
      return updated;
    });
  }
}

async function aggregateCosts(
  db: Database,
  groupBy: ProjectCostGroupBy | AdminCostGroupBy,
  filter: CostFilter,
  scope: ReturnType<typeof sql>,
): Promise<CostAggregatePage> {
  const dimension = costDimension(groupBy);
  const offset = (filter.page - 1) * filter.pageSize;
  const rows = await query<CostRow>(db, sql`
    WITH filtered AS (
      SELECT ce.*, u.username AS user_username, u.display_name AS user_display_name,
        p.name AS project_name, t.name AS team_name
      FROM ${costEntries} ce
      LEFT JOIN ${users} u ON u.id = ce.user_id
      LEFT JOIN ${projects} p ON p.id = ce.project_id
      LEFT JOIN ${teams} t ON t.id = ce.team_id
      WHERE ${scope}
        AND (${filter.from ?? null}::timestamptz IS NULL OR ce.created_at >= ${filter.from ?? null})
        AND (${filter.to ?? null}::timestamptz IS NULL OR ce.created_at <= ${filter.to ?? null})
    ), grouped AS (
      SELECT
        ${dimension.key} AS key,
        ${dimension.label} AS label,
        COALESCE(SUM(COALESCE(charged_points, 0)), 0)::bigint AS charged_points,
        COUNT(*) FILTER (WHERE COALESCE(is_unpriced, FALSE))::integer AS unpriced_count,
        COUNT(*)::integer AS entry_count
      FROM filtered ce
      GROUP BY ${dimension.groupBy}
    ), numbered AS (
      SELECT grouped.*, count(*) OVER()::integer AS total FROM grouped
    )
    SELECT key, label, charged_points, unpriced_count, entry_count, total
    FROM numbered
    ORDER BY charged_points DESC, label ASC, key ASC
    LIMIT ${filter.pageSize} OFFSET ${offset}
  `);
  const totals = await query<Pick<CostRow, "charged_points" | "unpriced_count" | "entry_count">>(db, sql`
    SELECT
      COALESCE(SUM(COALESCE(ce.charged_points, 0)), 0)::bigint AS charged_points,
      COUNT(*) FILTER (WHERE COALESCE(ce.is_unpriced, FALSE))::integer AS unpriced_count,
      COUNT(*)::integer AS entry_count
    FROM ${costEntries} ce
    WHERE ${scope}
      AND (${filter.from ?? null}::timestamptz IS NULL OR ce.created_at >= ${filter.from ?? null})
      AND (${filter.to ?? null}::timestamptz IS NULL OR ce.created_at <= ${filter.to ?? null})
  `);
  return {
    groupBy,
    rows: rows.map(toCostRow),
    totals: {
      chargedPoints: numberValue(totals[0]?.charged_points),
      unpricedCount: numberValue(totals[0]?.unpriced_count),
      entryCount: numberValue(totals[0]?.entry_count),
    },
    total: numberValue(rows[0]?.total),
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

function costDimension(groupBy: ProjectCostGroupBy | AdminCostGroupBy): {
  key: ReturnType<typeof sql>;
  label: ReturnType<typeof sql>;
  groupBy: ReturnType<typeof sql>;
} {
  switch (groupBy) {
    case "member":
    case "user":
      return {
        key: sql`COALESCE(ce.user_id::text, 'unassigned')`,
        label: sql`COALESCE(ce.user_display_name, ce.user_username, '未归属')`,
        groupBy: sql`ce.user_id, ce.user_display_name, ce.user_username`,
      };
    case "model":
      return {
        key: sql`COALESCE(ce.model, 'unpriced')`,
        label: sql`COALESCE(ce.model, '未标记模型')`,
        groupBy: sql`ce.model`,
      };
    case "day":
      return {
        key: sql`to_char(timezone('UTC', ce.created_at), 'YYYY-MM-DD')`,
        label: sql`to_char(timezone('UTC', ce.created_at), 'YYYY-MM-DD')`,
        groupBy: sql`to_char(timezone('UTC', ce.created_at), 'YYYY-MM-DD')`,
      };
    case "project":
      return {
        key: sql`COALESCE(ce.project_id::text, 'unassigned')`,
        label: sql`COALESCE(ce.project_name, '未归属项目')`,
        groupBy: sql`ce.project_id, ce.project_name`,
      };
    case "team":
      return {
        key: sql`COALESCE(ce.team_id::text, 'unassigned')`,
        label: sql`COALESCE(ce.team_name, '未分配')`,
        groupBy: sql`ce.team_id, ce.team_name`,
      };
  }
}

async function readProjectOperations(db: Database, projectId: string): Promise<ProjectOperationsRecord | undefined> {
  const project = (await query<ProjectOperationsRow>(db, sql`
    SELECT id, owner_user_id, team_id, genre
    FROM ${projects}
    WHERE id = ${projectId} AND deleted_at IS NULL
    LIMIT 1
  `))[0];
  if (!project) return undefined;
  const policies = await query<ReviewPolicyRow>(db, sql`
    SELECT media_kind, default_strategy, reviewer_user_id
    FROM ${projectReviewPolicies}
    WHERE project_id = ${projectId}
    ORDER BY media_kind ASC
  `);
  return {
    id: project.id,
    ownerUserId: project.owner_user_id,
    teamId: project.team_id,
    genre: toProjectGenre(project.genre),
    reviewPolicies: policies.flatMap((row) => {
      const strategy = toReviewStrategy(row.default_strategy);
      if ((row.media_kind !== "image" && row.media_kind !== "video") || !strategy) return [];
      return [{ mediaKind: row.media_kind, defaultStrategy: strategy, reviewerUserId: row.reviewer_user_id }];
    }),
  };
}

async function readProject(db: Database, projectId: string): Promise<{ owner_user_id: string } | undefined> {
  return (await query<{ owner_user_id: string }>(db, sql`
    SELECT owner_user_id FROM ${projects} WHERE id = ${projectId} AND deleted_at IS NULL LIMIT 1
  `))[0];
}

async function readProjectMembers(db: Database, projectId: string): Promise<ProjectMembership[]> {
  const rows = await query<ProjectMemberRow>(db, sql`
    SELECT pm.project_id, pm.user_id, u.username, u.display_name, u.role AS platform_role,
      pm.role AS project_role, pm.added_by_user_id, pm.created_at,
      ARRAY(
        SELECT production.role
        FROM ${projectMemberProductionRoles} production
        WHERE production.project_id = pm.project_id
          AND production.user_id = pm.user_id
        ORDER BY CASE production.role
          WHEN 'director' THEN 0
          WHEN 'art' THEN 1
          WHEN 'screenwriter' THEN 2
          WHEN 'coordinator' THEN 3
          WHEN 'reviewer' THEN 4
          ELSE 5
        END
      ) AS production_roles
    FROM ${projectMembers} pm
    INNER JOIN ${users} u ON u.id = pm.user_id
    WHERE pm.project_id = ${projectId}
    ORDER BY CASE pm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.display_name ASC, u.username ASC
  `);
  return rows.flatMap(toProjectMember);
}

async function readProjectMember(db: Database, projectId: string, userId: string): Promise<ProjectMembership | undefined> {
  const rows = await query<ProjectMemberRow>(db, sql`
    SELECT pm.project_id, pm.user_id, u.username, u.display_name, u.role AS platform_role,
      pm.role AS project_role, pm.added_by_user_id, pm.created_at,
      ARRAY(
        SELECT production.role
        FROM ${projectMemberProductionRoles} production
        WHERE production.project_id = pm.project_id
          AND production.user_id = pm.user_id
        ORDER BY CASE production.role
          WHEN 'director' THEN 0
          WHEN 'art' THEN 1
          WHEN 'screenwriter' THEN 2
          WHEN 'coordinator' THEN 3
          WHEN 'reviewer' THEN 4
          ELSE 5
        END
      ) AS production_roles
    FROM ${projectMembers} pm
    INNER JOIN ${users} u ON u.id = pm.user_id
    WHERE pm.project_id = ${projectId} AND pm.user_id = ${userId}
    LIMIT 1
  `);
  return rows.flatMap(toProjectMember)[0];
}

async function replaceProjectProductionRoles(
  db: Database,
  actorUserId: string,
  projectId: string,
  userId: string,
  requestedRoles: readonly ProjectProductionRole[],
): Promise<boolean> {
  const roles = normalizeProjectProductionRoles(requestedRoles);
  const current = await query<{ role: string }>(db, sql`
    SELECT role
    FROM ${projectMemberProductionRoles}
    WHERE project_id = ${projectId} AND user_id = ${userId}
    ORDER BY CASE role
      WHEN 'director' THEN 0
      WHEN 'art' THEN 1
      WHEN 'screenwriter' THEN 2
      WHEN 'coordinator' THEN 3
      WHEN 'reviewer' THEN 4
      ELSE 5
    END
  `);
  const currentRoles = toProjectProductionRoles(current.map((row) => row.role));
  if (sameStringArray(currentRoles, roles)) return false;

  await db.execute(sql`
    DELETE FROM ${projectMemberProductionRoles}
    WHERE project_id = ${projectId} AND user_id = ${userId}
  `);
  const now = new Date();
  for (const role of roles) {
    await db.execute(sql`
      INSERT INTO ${projectMemberProductionRoles}
        (project_id, user_id, role, assigned_by_user_id, created_at)
      VALUES (${projectId}, ${userId}, ${role}, ${actorUserId}, ${now})
    `);
  }
  return true;
}

async function writeProductionRolesAudit(
  db: Database,
  actor: OperationsActor,
  projectId: string,
  userId: string,
  fromRoles: readonly ProjectProductionRole[],
  toRoles: readonly ProjectProductionRole[],
): Promise<void> {
  await writeOperationAudit(db, actor, {
    action: "project_member_production_roles_changed",
    targetType: "project_member",
    targetId: projectId,
    metadata: {
      project_id: projectId,
      user_id: userId,
      from_production_roles: fromRoles,
      to_production_roles: toRoles,
    },
  });
}

async function transferProjectOwner(db: Database, actor: OperationsActor, projectId: string, newOwnerUserId: string): Promise<void> {
  await assertUserExists(db, newOwnerUserId);
  const project = await readProject(db, projectId);
  if (!project) throw new NotFoundError("项目不存在");
  const now = new Date();
  await db.execute(sql`
    UPDATE ${projectMembers}
    SET role = 'editor', added_by_user_id = ${actor.userId}
    WHERE project_id = ${projectId} AND role = 'owner' AND user_id <> ${newOwnerUserId}
  `);
  await db.execute(sql`
    INSERT INTO ${projectMembers} (project_id, user_id, role, added_by_user_id, created_at)
    VALUES (${projectId}, ${newOwnerUserId}, 'owner', ${actor.userId}, ${now})
    ON CONFLICT (project_id, user_id) DO UPDATE
    SET role = 'owner', added_by_user_id = EXCLUDED.added_by_user_id
  `);
  await db.execute(sql`
    UPDATE ${projects}
    SET owner_user_id = ${newOwnerUserId}, updated_at = ${now}
    WHERE id = ${projectId}
  `);
  await writeOperationAudit(db, actor, {
    action: "project_owner_transferred",
    targetType: "project",
    targetId: projectId,
    metadata: { project_id: projectId, from_user_id: project.owner_user_id, to_user_id: newOwnerUserId },
  });
}

async function assertNotCurrentOwner(db: Database, projectId: string, userId: string, targetRole: ProjectRole): Promise<void> {
  const project = await readProject(db, projectId);
  if (!project) throw new NotFoundError("项目不存在");
  if (project.owner_user_id === userId && targetRole !== "owner") {
    throw new ConflictError("不能降级当前项目负责人；请先指定新负责人", "project_owner_required");
  }
}

async function assertProjectMemberManager(db: Database, actorId: string, projectId: string): Promise<void> {
  await assertProjectAction(db, actorId, projectId, "manage_members");
}

async function assertProjectCostVisible(db: Database, actorId: string, projectId: string): Promise<void> {
  await assertProjectAction(db, actorId, projectId, "view_costs");
}

/**
 * Keep operations on the exact same project-access matrix as generation,
 * reviews and the project routes. In particular, platform admin has global
 * project authority, operator can read/project-cost only, and a normal member
 * without a membership receives the deliberately indistinguishable 404.
 */
async function assertProjectAction(
  db: Database,
  actorId: string,
  projectId: string,
  action: ProjectAccessAction,
): Promise<void> {
  const actor = await requireActor(db, actorId);
  const access = ProjectAccessService.fromDatabase(new ProjectAccessRepository(db));
  await access.require({ id: actor.userId, role: actor.role }, projectId, action);
}

async function lockProject(db: Database, projectId: string): Promise<void> {
  const rows = await query<{ id: string }>(db, sql`
    SELECT id FROM ${projects} WHERE id = ${projectId} AND deleted_at IS NULL FOR UPDATE
  `);
  if (!rows[0]) throw new NotFoundError("项目不存在");
}

async function assertProjectMemberExists(db: Database, projectId: string, userId: string): Promise<void> {
  const rows = await query<{ user_id: string }>(db, sql`
    SELECT user_id FROM ${projectMembers}
    WHERE project_id = ${projectId} AND user_id = ${userId}
    LIMIT 1
  `);
  if (!rows[0]) throw new BadRequestError("指定审核人必须是当前项目成员");
}

async function assertAdmin(db: Database, userId: string): Promise<CurrentActor> {
  const actor = await requireActor(db, userId);
  if (actor.role !== "admin") throw new ForbiddenError("只有管理员可以管理团队和用户分组");
  return actor;
}

async function assertOperatorOrAdmin(db: Database, userId: string): Promise<CurrentActor> {
  const actor = await requireActor(db, userId);
  if (actor.role !== "admin" && actor.role !== "operator") {
    throw new ForbiddenError("只有管理员或运营账号可以查看全部成本");
  }
  return actor;
}

async function requireActor(db: Database, userId: string): Promise<CurrentActor> {
  const rows = await query<ActorRow>(db, sql`
    SELECT id, username, display_name, role FROM ${users}
    WHERE id = ${userId} AND active = TRUE
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) throw new UnauthorizedError("登录已失效，请重新登录");
  return toActor(row);
}

async function assertUserExists(db: Database, userId: string): Promise<void> {
  const rows = await query<{ id: string }>(db, sql`SELECT id FROM ${users} WHERE id = ${userId} LIMIT 1`);
  if (!rows[0]) throw new NotFoundError("用户不存在");
}

async function assertTeamExists(db: Database, teamId: string): Promise<void> {
  if (!await lockTeam(db, teamId)) throw new NotFoundError("团队不存在");
}

async function lockTeam(db: Database, teamId: string): Promise<{ id: string; name: string; parent_team_id: string | null } | undefined> {
  return (await query<{ id: string; name: string; parent_team_id: string | null }>(db, sql`
    SELECT id, name, parent_team_id FROM ${teams} WHERE id = ${teamId} FOR UPDATE
  `))[0];
}

async function assertParentTeamAllowed(db: Database, parentTeamId: string | null, childTeamId: string | null): Promise<void> {
  if (!parentTeamId) return;
  if (parentTeamId === childTeamId) throw new BadRequestError("团队不能以自己为上级团队");
  const rows = await query<{ id: string; parent_team_id: string | null }>(db, sql`
    SELECT id, parent_team_id FROM ${teams} WHERE id = ${parentTeamId} LIMIT 1
  `);
  const parent = rows[0];
  if (!parent) throw new NotFoundError("上级团队不存在");
  if (parent.parent_team_id !== null) throw new BadRequestError("团队层级最多两层，不能再向孙级挂接");
}

async function assertUserGroupExists(db: Database, groupId: string): Promise<void> {
  const rows = await query<{ id: string }>(db, sql`SELECT id FROM ${userGroups} WHERE id = ${groupId} LIMIT 1`);
  if (!rows[0]) throw new NotFoundError("用户分组不存在");
}

async function writeOperationAudit(
  db: Database,
  actor: OperationsActor,
  input: { action: string; targetType: string; targetId: string; metadata: Record<string, unknown> },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${operationActions}
      (id, actor_user_id, actor_session_id, action, target_type, target_id, metadata, created_at)
    VALUES (
      ${randomUUID()}, ${actor.userId}, ${actor.sessionId ?? null}, ${input.action},
      ${input.targetType}, ${input.targetId}, ${JSON.stringify(input.metadata)}::jsonb, ${new Date()}
    )
  `);
}

function table(name: string) {
  return sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier(name)}`;
}

async function query<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(statement) as unknown as SqlResult<T>).rows;
}

function toActor(row: ActorRow): CurrentActor {
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    role: toPlatformRole(row.role),
  };
}

function toProjectMember(row: ProjectMemberRow): ProjectMembership[] {
  if (!isProjectRole(row.project_role)) return [];
  return [{
    projectId: row.project_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    platformRole: toPlatformRole(row.platform_role),
    projectRole: row.project_role,
    productionRoles: toProjectProductionRoles(row.production_roles),
    addedByUserId: row.added_by_user_id,
    createdAt: dateValue(row.created_at),
  }];
}

function toTeam(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    parentTeamId: row.parent_team_id,
    memberCount: numberValue(row.member_count),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function toUserGroup(row: UserGroupRow): UserGroupRecord {
  return {
    id: row.id,
    name: row.name,
    memberCount: numberValue(row.member_count),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function toUserDirectory(row: UserDirectoryRow): UserDirectoryRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    platformRole: toPlatformRole(row.role),
    active: row.active,
    createdAt: dateValue(row.created_at),
  };
}

function toCostRow(row: CostRow): CostAggregateRow {
  return {
    key: row.key,
    label: row.label,
    chargedPoints: numberValue(row.charged_points),
    unpricedCount: numberValue(row.unpriced_count),
    entryCount: numberValue(row.entry_count),
  };
}

function toPlatformRole(value: string | null): PlatformRole {
  return value === "admin" || value === "operator" || value === "member" ? value : "member";
}

function toReviewStrategy(value: string | undefined): ReviewStrategy | undefined {
  return value === "automatic" || value === "pending_review" ? value : undefined;
}

function toProjectGenre(value: string | null): ProjectOperationsRecord["genre"] {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isProjectRole(value: string): value is ProjectRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

function isProjectProductionRole(value: string): value is ProjectProductionRole {
  return (PROJECT_PRODUCTION_ROLES as readonly string[]).includes(value);
}

function normalizeProjectProductionRoles(
  values: readonly ProjectProductionRole[],
): ProjectProductionRole[] {
  if (new Set(values).size !== values.length) {
    throw new BadRequestError("项目生产角色不能重复");
  }
  if (values.some((value) => !isProjectProductionRole(value))) {
    throw new BadRequestError("项目生产角色只允许导演、美术、编剧、统筹或审片");
  }
  return PROJECT_PRODUCTION_ROLES.filter((role) => values.includes(role));
}

function toProjectProductionRoles(values: readonly string[] | null): ProjectProductionRole[] {
  if (!values) return [];
  return PROJECT_PRODUCTION_ROLES.filter((role) => values.includes(role));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function platformPermissions(role: PlatformRole, allowMemberCreateProject: boolean): string[] {
  if (role === "admin") return ["admin", "project:create", "project:all", "cost:all", "team:manage", "group:manage"];
  if (role === "operator") return ["project:read_all", "cost:all", "cost:export"];
  return allowMemberCreateProject ? ["project:create"] : [];
}

function normalizedSearch(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
