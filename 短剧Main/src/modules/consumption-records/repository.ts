import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  costEntries,
  generationRequests,
  projectMembers,
  projects,
  shots,
  users,
} from "../../db/schema.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { platformRoleOrMember, type PlatformRole } from "../auth/types.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import {
  CONSUMPTION_COST_ENTRIES_COMPATIBILITY_GAPS,
  type ConsumptionRecord,
  type ConsumptionRecordFilter,
  type ConsumptionRecordPage,
  type ConsumptionTaskType,
  type SceneConsumptionBreakdownItem,
  type SceneConsumptionSummary,
} from "./types.js";

export interface ConsumptionRecordsRepository {
  list(actorId: string, filter: ConsumptionRecordFilter): Promise<ConsumptionRecordPage>;
  getSceneConsumptionSummary(actorId: string, projectId: string, sceneId: string): Promise<SceneConsumptionSummary>;
}

interface LedgerRecordRow {
  entryId: string;
  kind: string;
  model: string;
  chargedPoints: number;
  isUnpriced: boolean;
  createdAt: Date;
  sourceTable: string;
  sourceId: string;
  projectName: string | null;
}

interface Actor {
  id: string;
  role: PlatformRole;
}

/**
 * This is the SQL representation of ProjectAccess `view_costs` for a normal
 * member. Keep it deliberately narrow: a viewer can open a project but must
 * never see its spend in a project view, the global ledger, or a dashboard
 * aggregation. Platform admin/operator visibility is handled separately.
 */
export const COST_READABLE_MEMBER_ROLES = ["owner", "editor"] as const;

export function isCostReadableMemberRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "editor";
}

/**
 * The legacy consumption endpoints now read the one `cost_entries` view.
 *
 * This deliberately does not join generation attempts, agent messages, or
 * quotes to reconstruct media type / prompts / actual bills.  Those fields
 * are not present in the cost ledger and returning them would create a second
 * accounting interpretation.  The response names the resulting gaps.
 */
export class DrizzleConsumptionRecordsRepository implements ConsumptionRecordsRepository {
  constructor(private readonly db: Database) {}

  async list(actorId: string, filter: ConsumptionRecordFilter): Promise<ConsumptionRecordPage> {
    const actor = await this.requireActor(actorId);
    if (filter.projectId) {
      await ProjectAccessService.fromDatabase(new ProjectAccessRepository(this.db))
        .requireCostReadable({ id: actor.id, role: actor.role }, filter.projectId);
    }

    const [records, total] = await Promise.all([
      this.readPage(actor, filter),
      this.countRows(actor, filter),
    ]);

    return {
      records,
      total,
      page: filter.page,
      pageSize: filter.pageSize,
      compatibilityGaps: CONSUMPTION_COST_ENTRIES_COMPATIBILITY_GAPS,
    };
  }

  async getSceneConsumptionSummary(
    actorId: string,
    projectId: string,
    sceneId: string,
  ): Promise<SceneConsumptionSummary> {
    const actor = await this.requireActor(actorId);
    await ProjectAccessService.fromDatabase(new ProjectAccessRepository(this.db))
      .requireCostReadable({ id: actor.id, role: actor.role }, projectId);

    // cost_entries (视图) → generation_requests (shot_id) → shots (scene_id)
    // 只统计 source_table = 'generation_requests' 的行,因为该视图是 UNION 多来源的。
    const rows = await this.db.select({
      kind: costEntries.kind,
      model: costEntries.model,
      totalPoints: sql<number>`coalesce(sum(${costEntries.chargedPoints}), 0)`.as("total_points"),
      requestCount: count(costEntries.entryId).as("request_count"),
    })
      .from(costEntries)
      .innerJoin(generationRequests,
        and(
          eq(costEntries.sourceId, generationRequests.id),
          eq(costEntries.sourceTable, "generation_requests"),
        ),
      )
      .innerJoin(shots, eq(generationRequests.shotId, shots.id))
      .where(and(
        eq(costEntries.projectId, projectId),
        eq(shots.sceneId, sceneId),
        isNull(shots.deletedAt),
      ))
      .groupBy(costEntries.kind, costEntries.model);

    const breakdownByKind: SceneConsumptionBreakdownItem[] = rows.map((row) => ({
      kind: row.kind,
      model: row.model,
      chargedPoints: Number(row.totalPoints ?? 0),
      requestCount: Number(row.requestCount ?? 0),
    }));

    const totalCostPoints = breakdownByKind.reduce((sum, item) => sum + item.chargedPoints, 0);
    const requestCount = breakdownByKind.reduce((sum, item) => sum + item.requestCount, 0);

    return { totalCostPoints, requestCount, breakdownByKind };
  }

  private async requireActor(actorId: string): Promise<Actor> {
    const [actor] = await this.db.select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.id, actorId), eq(users.active, true)))
      .limit(1);
    if (!actor) throw new UnauthorizedError("登录已失效，请重新登录");
    return { id: actor.id, role: platformRoleOrMember(actor.role) };
  }

  private async readPage(actor: Actor, filter: ConsumptionRecordFilter): Promise<ConsumptionRecord[]> {
    const fields = {
      entryId: costEntries.entryId,
      kind: costEntries.kind,
      model: costEntries.model,
      chargedPoints: costEntries.chargedPoints,
      isUnpriced: costEntries.isUnpriced,
      createdAt: costEntries.createdAt,
      sourceTable: costEntries.sourceTable,
      sourceId: costEntries.sourceId,
      projectName: projects.name,
    };
    const offset = (filter.page - 1) * filter.pageSize;
    const rows = actor.role === "member"
      ? await this.db.select(fields)
        .from(costEntries)
        .innerJoin(projects, eq(projects.id, costEntries.projectId))
        .innerJoin(projectMembers, and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, actor.id),
          inArray(projectMembers.role, COST_READABLE_MEMBER_ROLES),
        ))
        .where(and(
          isNull(projects.deletedAt),
          ...memberFilterConditions(filter),
        ))
        .orderBy(desc(costEntries.createdAt), desc(costEntries.entryId))
        .limit(filter.pageSize)
        .offset(offset)
      : await this.db.select(fields)
        .from(costEntries)
        .leftJoin(projects, eq(projects.id, costEntries.projectId))
        .where(and(
          or(isNull(projects.deletedAt), isNull(projects.id)),
          ...observerFilterConditions(filter),
        ))
        .orderBy(desc(costEntries.createdAt), desc(costEntries.entryId))
        .limit(filter.pageSize)
        .offset(offset);

    return rows.flatMap(toRecord);
  }

  private async countRows(actor: Actor, filter: ConsumptionRecordFilter): Promise<number> {
    const [row] = actor.role === "member"
      ? await this.db.select({ total: count(costEntries.entryId) })
        .from(costEntries)
        .innerJoin(projects, eq(projects.id, costEntries.projectId))
        .innerJoin(projectMembers, and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, actor.id),
          inArray(projectMembers.role, COST_READABLE_MEMBER_ROLES),
        ))
        .where(and(
          isNull(projects.deletedAt),
          ...memberFilterConditions(filter),
        ))
      : await this.db.select({ total: count(costEntries.entryId) })
        .from(costEntries)
        .leftJoin(projects, eq(projects.id, costEntries.projectId))
        .where(and(
          or(isNull(projects.deletedAt), isNull(projects.id)),
          ...observerFilterConditions(filter),
        ));
    return Number(row?.total ?? 0);
  }
}

function memberFilterConditions(filter: ConsumptionRecordFilter) {
  return ledgerFilterConditions(filter);
}

function observerFilterConditions(filter: ConsumptionRecordFilter) {
  return ledgerFilterConditions(filter);
}

/** Every condition applies directly to a column of the cost_entries view. */
function ledgerFilterConditions(filter: ConsumptionRecordFilter) {
  return [
    filter.projectId ? eq(costEntries.projectId, filter.projectId) : undefined,
    filter.from ? gte(costEntries.createdAt, filter.from) : undefined,
    filter.to ? lte(costEntries.createdAt, filter.to) : undefined,
    filter.model ? eq(costEntries.model, filter.model) : undefined,
    filter.taskType === "generation" ? eq(costEntries.kind, "generation") : undefined,
    filter.taskType === "ai_assist" ? eq(costEntries.kind, "ai_call") : undefined,
  ];
}

function toRecord(row: LedgerRecordRow): ConsumptionRecord[] {
  const taskType = toTaskType(row.kind);
  if (!taskType || !row.entryId || !row.sourceId || !row.sourceTable || !row.model || !row.createdAt) return [];
  const points = Number(row.chargedPoints);
  if (!Number.isSafeInteger(points) || points < 0) return [];
  return [{
    createdAt: row.createdAt,
    taskType,
    modelDisplayName: row.model,
    episodeNo: null,
    promptExcerpt: null,
    taskId: row.sourceId,
    points,
    projectName: row.projectName,
    sourceTable: row.sourceTable,
    sourceId: row.sourceId,
    isUnpriced: row.isUnpriced,
  }];
}

function toTaskType(kind: string): ConsumptionTaskType | null {
  if (kind === "generation") return "generation";
  if (kind === "ai_call") return "ai_assist";
  return null;
}
