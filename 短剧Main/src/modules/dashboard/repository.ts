import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  costEntries,
  episodes,
  generationRequests,
  mediaResults,
  projectMembers,
  pricingRules,
  projects,
  shots,
  users,
} from "../../db/schema.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "../../shared/errors.js";
import { isInferredExperimentalPricingRule } from "../../shared/pricingRuleProvenance.js";
import { platformRoleOrMember, type PlatformRole } from "../auth/types.js";
import { generationPricingLockKey } from "../generation/cost.js";
import { currentAttempts } from "../generation/currentAttempts.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import { COST_READABLE_MEMBER_ROLES } from "../consumption-records/repository.js";
import {
  buildProjectCostSummary,
  type ProjectCostRow,
  type ProjectCostSummary,
} from "./projectCosts.js";
import type { DashboardCostRow } from "./summary.js";

export const COST_LEDGER_NOTICE = "已记账积分，来源于成本账本" as const;

/**
 * 交付清单仍展示其自身的预估消耗，不属于 `cost_entries` 账本。
 *
 * 保留这个旧导出给交付域和历史调用方，避免它们误把“预估消耗”与看板的
 * “已记账积分”混为同一口径。新看板代码必须使用 `COST_LEDGER_NOTICE`。
 */
export const ESTIMATED_COST_NOTICE = "预估消耗，非云平台实际账单" as const;

export interface DashboardDataCounts {
  projects: number;
  assets: number;
  episodes: number;
  shots: number;
  images: number;
  videos: number;
  succeeded: number;
  failed: number;
}

export interface ProjectCostDetails {
  projectId: string;
  projectName: string;
  notice: typeof COST_LEDGER_NOTICE;
  estimatedCostFen: number;
  actualCostFen: null;
  summary: ProjectCostSummary;
  entries: ProjectCostRow[];
}

/**
 * `ProjectCostRow` is deliberately the public project-cost shape.  The
 * dashboard summary additionally needs project labels while it groups the
 * same ledger rows, so keep those join-only fields private to this
 * repository.  They never carry another cost value.
 */
interface LedgerCostRow extends ProjectCostRow {
  projectId: string | null;
  projectName: string | null;
}

export interface UnitPriceInput {
  provider: string;
  model: string;
  mediaKind: "image" | "video";
  billingUnit: string;
  unitPriceFen: number;
  currency: string;
  source?: string;
  effectiveFrom?: Date;
  metadata?: Record<string, unknown>;
}

export interface UnitPriceRecord extends UnitPriceInput {
  id: string;
  active: boolean;
  source: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardRepository {
  getDataCounts(actorId: string): Promise<DashboardDataCounts>;
  listCostRows(actorId: string): Promise<DashboardCostRow[]>;
  getProjectCosts(actorId: string, projectId: string): Promise<ProjectCostDetails>;
  listUnitPrices(): Promise<UnitPriceRecord[]>;
  replaceUnitPrice(actorId: string, input: UnitPriceInput): Promise<UnitPriceRecord>;
}

export type DashboardProjectVisibilityScope = "all_projects" | "project_memberships";

/**
 * The dashboard's SQL needs the same broad read boundary as ProjectAccess:
 * admins and operators can inspect every project; ordinary members can only
 * inspect projects where they have a project_members row.  This is separate
 * from cost visibility: a viewer can see production progress, but not ledger
 * values.
 */
export function dashboardProjectVisibilityScope(role: PlatformRole): DashboardProjectVisibilityScope {
  return role === "member" ? "project_memberships" : "all_projects";
}

/**
 * SQL projection of ProjectAccessService.requireReadable for a dashboard
 * collection query. A global dashboard cannot call the per-project service
 * once per row, so it uses the same authoritative membership relation in a
 * correlated query. We deliberately do not fall back to owner_user_id here:
 * migration 016 backfills every historical owner into project_members, and
 * the member table is the visibility truth after that migration.
 */
export function dashboardReadableProjectCondition(
  actor: { id: string; role: PlatformRole },
): SQL {
  if (dashboardProjectVisibilityScope(actor.role) === "all_projects") {
    return isNull(projects.deletedAt);
  }
  return and(
    isNull(projects.deletedAt),
    exists(sql`
      SELECT 1
      FROM ${projectMembers}
      WHERE ${projectMembers.projectId} = ${projects.id}
        AND ${projectMembers.userId} = ${actor.id}
    `),
  )!;
}

export class DrizzleDashboardRepository implements DashboardRepository {
  constructor(private readonly db: Database) {}

  async getDataCounts(actorId: string): Promise<DashboardDataCounts> {
    const actor = await this.requireActor(actorId);
    const current = currentAttempts(this.db);
    const readableProjects = dashboardReadableProjectCondition(actor);
    const [projectRows, assetRows, episodeRows, shotRows, mediaRows, attemptRows] = await Promise.all([
      this.db.select({ id: projects.id }).from(projects)
        .where(readableProjects),
      this.db.select({ id: assetEntities.id }).from(assetEntities)
        .where(and(
          isNull(assetEntities.deletedAt),
          or(eq(assetEntities.visibility, "common"), eq(assetEntities.ownerUserId, actor.id)),
        )),
      this.db.select({ id: episodes.id }).from(episodes)
        .innerJoin(projects, eq(projects.id, episodes.projectId))
        .where(and(readableProjects, isNull(episodes.deletedAt))),
      this.db.select({ id: shots.id }).from(shots)
        .innerJoin(episodes, eq(episodes.id, shots.episodeId))
        .innerJoin(projects, eq(projects.id, episodes.projectId))
        .where(and(
          readableProjects,
          isNull(episodes.deletedAt),
          isNull(shots.deletedAt),
        )),
      this.db.select({ mediaKind: mediaResults.mediaKind }).from(mediaResults)
        .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
        .innerJoin(projects, eq(projects.id, generationRequests.projectId))
        .where(and(readableProjects, isNull(mediaResults.deletedAt))),
      this.db.select({ status: current.status }).from(generationRequests)
        .innerJoin(current, eq(current.requestId, generationRequests.id))
        .innerJoin(projects, eq(projects.id, generationRequests.projectId))
        .where(readableProjects),
    ]);
    return {
      projects: projectRows.length,
      assets: assetRows.length,
      episodes: episodeRows.length,
      shots: shotRows.length,
      images: mediaRows.filter((row) => row.mediaKind === "image").length,
      videos: mediaRows.filter((row) => row.mediaKind === "video").length,
      succeeded: attemptRows.filter((row) => row.status === "succeeded").length,
      failed: attemptRows.filter((row) => row.status === "failed").length,
    };
  }

  async listCostRows(actorId: string): Promise<DashboardCostRow[]> {
    const actor = await this.requireActor(actorId);
    const rows = await this.readVisibleCostRows(actor);
    return rows.map((row) => ({
      projectId: row.projectId ?? "unassigned",
      projectName: row.projectName ?? "未归属项目",
      userId: row.userId,
      userName: row.userName,
      kind: row.kind,
      chargedPoints: row.chargedPoints,
      isUnpriced: row.isUnpriced,
      createdAt: row.createdAt,
    }));
  }

  async getProjectCosts(actorId: string, projectId: string): Promise<ProjectCostDetails> {
    const actor = await this.requireActor(actorId);
    await ProjectAccessService.fromDatabase(new ProjectAccessRepository(this.db))
      .requireCostReadable({ id: actor.id, role: actor.role }, projectId);
    const [project] = await this.db.select().from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).limit(1);
    if (!project) throw new Error("已通过项目权限校验的项目未能读取");

    const rows = await this.readVisibleCostRows(actor, projectId);
    const summary = buildProjectCostSummary(rows);
    return {
      projectId: project.id,
      projectName: project.name,
      notice: COST_LEDGER_NOTICE,
      estimatedCostFen: summary.totals.chargedPoints,
      actualCostFen: null,
      summary,
      entries: rows,
    };
  }

  private async requireActor(actorId: string): Promise<{ id: string; role: PlatformRole }> {
    const [actor] = await this.db.select({ id: users.id, role: users.role }).from(users)
      .where(and(eq(users.id, actorId), eq(users.active, true))).limit(1);
    if (!actor) throw new UnauthorizedError("登录已失效，请重新登录");
    return { id: actor.id, role: platformRoleOrMember(actor.role) };
  }

  /**
   * Every numeric cost comes directly from cost_entries. Project/user joins
   * provide labels and membership scope only; they never reconstruct cost.
   */
  private async readVisibleCostRows(
    actor: { id: string; role: PlatformRole },
    projectId?: string,
  ): Promise<LedgerCostRow[]> {
    const projectCondition = projectId ? eq(costEntries.projectId, projectId) : undefined;
    const commonConditions = [
      projectCondition,
      or(isNull(projects.deletedAt), isNull(projects.id)),
    ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);

    const fields = {
      entryId: costEntries.entryId,
      sourceTable: costEntries.sourceTable,
      sourceId: costEntries.sourceId,
      kind: costEntries.kind,
      userId: costEntries.userId,
      userName: users.displayName,
      model: costEntries.model,
      chargedPoints: costEntries.chargedPoints,
      isUnpriced: costEntries.isUnpriced,
      createdAt: costEntries.createdAt,
      projectId: projects.id,
      projectName: projects.name,
    };

    const rows = actor.role === "member"
      ? await this.db.select(fields)
        .from(costEntries)
        .innerJoin(projects, eq(projects.id, costEntries.projectId))
        .innerJoin(projectMembers, and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, actor.id),
          inArray(projectMembers.role, COST_READABLE_MEMBER_ROLES),
        ))
        .leftJoin(users, eq(users.id, costEntries.userId))
        .where(and(isNull(projects.deletedAt), ...(projectId ? [eq(costEntries.projectId, projectId)] : [])))
        .orderBy(desc(costEntries.createdAt), desc(costEntries.entryId))
      : await this.db.select(fields)
        .from(costEntries)
        .leftJoin(projects, eq(projects.id, costEntries.projectId))
        .leftJoin(users, eq(users.id, costEntries.userId))
        .where(and(...commonConditions))
        .orderBy(desc(costEntries.createdAt), desc(costEntries.entryId));

    return rows.flatMap((row): LedgerCostRow[] => {
      if ((row.kind !== "generation" && row.kind !== "ai_call") || !row.entryId || !row.sourceId || !row.userId || !row.model || !row.createdAt) {
        return [];
      }
      return [{
        entryId: row.entryId,
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        kind: row.kind,
        userId: row.userId,
        userName: row.userName ?? "未归属用户",
        model: row.model,
        chargedPoints: row.chargedPoints,
        isUnpriced: row.isUnpriced,
        createdAt: row.createdAt,
        projectId: row.projectId,
        projectName: row.projectName,
      }];
    });
  }

  async listUnitPrices(): Promise<UnitPriceRecord[]> {
    const rows = await this.db.select().from(pricingRules)
      .where(eq(pricingRules.active, true))
      .orderBy(asc(pricingRules.mediaKind), asc(pricingRules.provider), asc(pricingRules.model));
    return rows.flatMap((row): UnitPriceRecord[] => isMediaKind(row.mediaKind) && isPublicUnitPriceRecord(row)
      ? [{ ...row, mediaKind: row.mediaKind }]
      : []);
  }

  async replaceUnitPrice(actorId: string, input: UnitPriceInput): Promise<UnitPriceRecord> {
    if (!Number.isSafeInteger(input.unitPriceFen) || input.unitPriceFen <= 0 || input.unitPriceFen > 2_147_483_647) {
      throw new BadRequestError("单价必须是大于 0 的整数分");
    }
    if ((input.mediaKind === "image" && input.billingUnit !== "image")
      || (input.mediaKind === "video" && input.billingUnit !== "second")) {
      throw new BadRequestError("图片单价必须按张计费，视频单价必须按秒计费");
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${generationPricingLockKey})`);
      const key = JSON.stringify([input.provider, input.model, input.mediaKind, input.billingUnit]);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
      const now = new Date();
      const effectiveFrom = input.effectiveFrom ?? now;
      const activeRows = await tx.select({ effectiveFrom: pricingRules.effectiveFrom }).from(pricingRules).where(and(
        eq(pricingRules.provider, input.provider),
        eq(pricingRules.model, input.model),
        eq(pricingRules.mediaKind, input.mediaKind),
        eq(pricingRules.billingUnit, input.billingUnit),
        eq(pricingRules.active, true),
      ));
      if (activeRows.some((row) => effectiveFrom.getTime() <= row.effectiveFrom.getTime())) {
        throw new ConflictError("新单价的生效时间必须晚于当前单价", "unit_price_effective_time_conflict");
      }
      await tx.update(pricingRules).set({
        active: false,
        effectiveTo: effectiveFrom,
        updatedAt: now,
      }).where(and(
        eq(pricingRules.provider, input.provider),
        eq(pricingRules.model, input.model),
        eq(pricingRules.mediaKind, input.mediaKind),
        eq(pricingRules.billingUnit, input.billingUnit),
        eq(pricingRules.active, true),
      ));
      const source = input.source?.trim() || `manual:user:${actorId}`;
      const metadata = { ...(input.metadata ?? {}), updated_by_user_id: actorId };
      const [created] = await tx.insert(pricingRules).values({
        id: randomUUID(),
        provider: input.provider,
        model: input.model,
        mediaKind: input.mediaKind,
        billingUnit: input.billingUnit,
        unitPriceFen: input.unitPriceFen,
        currency: input.currency,
        source,
        active: true,
        effectiveFrom,
        effectiveTo: null,
        metadata,
        createdAt: now,
        updatedAt: now,
      }).returning();
      if (!created) throw new Error("单价保存失败");
      if (!isMediaKind(created.mediaKind)) throw new Error("单价媒体类型不正确");
      return { ...created, mediaKind: created.mediaKind };
    });
  }
}

/** The member-readable global price endpoint must not expose S58 research candidates as current prices. */
export function isPublicUnitPriceRecord(
  row: { metadata: Record<string, unknown> },
): boolean {
  return !isInferredExperimentalPricingRule(row.metadata);
}

function isMediaKind(value: string): value is "image" | "video" {
  return value === "image" || value === "video";
}
