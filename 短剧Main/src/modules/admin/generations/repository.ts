import { and, asc, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { generationRequests, projects, users } from "../../../db/schema.js";
import { currentAttempts, type CurrentAttempts } from "../../generation/currentAttempts.js";
import {
  ADMIN_GENERATION_STATUSES,
  type AdminGenerationDailyCost,
  type AdminGenerationFailureReasonCount,
  type AdminGenerationListFilter,
  type AdminGenerationListItem,
  type AdminGenerationListResult,
  type AdminGenerationStats,
  type AdminGenerationStatusCount,
  type GenerationMediaKind,
  type GenerationStatus,
} from "./types.js";

const DEFAULT_STATS_WINDOW_DAYS = 30;
const FAILURE_REASON_TOP_N = 5;

export interface AdminGenerationsRepository {
  list(filter: AdminGenerationListFilter): Promise<AdminGenerationListResult>;
  stats(windowDays?: number): Promise<AdminGenerationStats>;
}

export class DrizzleAdminGenerationsRepository implements AdminGenerationsRepository {
  constructor(private readonly db: Database) {}

  async list(filter: AdminGenerationListFilter): Promise<AdminGenerationListResult> {
    const current = currentAttempts(this.db);
    const where = this.listConditions(current, filter);

    const rows = await this.db
      .select({
        requestId: generationRequests.id,
        projectId: generationRequests.projectId,
        projectName: projects.name,
        userId: generationRequests.userId,
        username: users.username,
        mediaKind: generationRequests.mediaKind,
        status: current.status,
        phase: current.phase,
        attemptNo: current.attemptNo,
        model: current.model,
        estimatedCostFen: current.estimatedCostFen,
        failureReason: current.errorMessage,
        providerTaskId: current.providerTaskId,
        createdAt: generationRequests.createdAt,
        updatedAt: current.updatedAt,
      })
      .from(generationRequests)
      .innerJoin(current, eq(current.requestId, generationRequests.id))
      .innerJoin(projects, eq(projects.id, generationRequests.projectId))
      .innerJoin(users, eq(users.id, generationRequests.userId))
      .where(where)
      // Stable order: never rely on incidental database order for a list endpoint.
      .orderBy(desc(generationRequests.createdAt), desc(generationRequests.id))
      .limit(filter.limit)
      .offset(filter.offset);

    const totalRows = await this.db
      .select({ total: sql<number>`count(*)::integer` })
      .from(generationRequests)
      .innerJoin(current, eq(current.requestId, generationRequests.id))
      .where(where);

    return {
      items: rows.map((row): AdminGenerationListItem => ({
        ...row,
        mediaKind: asMediaKind(row.mediaKind),
        status: asStatus(row.status),
      })),
      total: Number(totalRows[0]?.total ?? 0),
      limit: filter.limit,
      offset: filter.offset,
    };
  }

  async stats(windowDays: number = DEFAULT_STATS_WINDOW_DAYS): Promise<AdminGenerationStats> {
    const current = currentAttempts(this.db);

    const statusRows = await this.db
      .select({ status: current.status, count: sql<number>`count(*)::integer` })
      .from(generationRequests)
      .innerJoin(current, eq(current.requestId, generationRequests.id))
      .groupBy(current.status);
    const countByStatus = new Map(statusRows.map((row) => [row.status, Number(row.count)]));

    const failureRows = await this.db
      .select({ failureReason: current.errorMessage, count: sql<number>`count(*)::integer` })
      .from(generationRequests)
      .innerJoin(current, eq(current.requestId, generationRequests.id))
      .where(and(eq(current.status, "failed"), isNotNull(current.errorMessage)))
      .groupBy(current.errorMessage)
      .orderBy(desc(sql`count(*)`), asc(current.errorMessage))
      .limit(FAILURE_REASON_TOP_N);

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    // Bucketed in UTC to match the `date.toISOString().slice(0, 10)` convention
    // the dashboard module already uses for its own by-day cost breakdown.
    const dayExpr = sql<string>`to_char(${current.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const dailyCostRows = await this.db
      .select({
        date: dayExpr,
        estimatedCostFen: sql<number>`coalesce(sum(${current.estimatedCostFen}), 0)::integer`,
      })
      .from(current)
      .where(gte(current.createdAt, since))
      .groupBy(dayExpr)
      .orderBy(dayExpr);

    return {
      byStatus: ADMIN_GENERATION_STATUSES.map((status): AdminGenerationStatusCount => ({
        status,
        count: countByStatus.get(status) ?? 0,
      })),
      topFailureReasons: failureRows.flatMap((row): AdminGenerationFailureReasonCount[] => (
        row.failureReason ? [{ failureReason: row.failureReason, count: Number(row.count) }] : []
      )),
      dailyCostFen: dailyCostRows.map((row): AdminGenerationDailyCost => ({
        date: row.date,
        estimatedCostFen: Number(row.estimatedCostFen),
      })),
      windowDays,
    };
  }

  private listConditions(
    current: CurrentAttempts,
    filter: AdminGenerationListFilter,
  ) {
    const conditions = [
      filter.status ? eq(current.status, filter.status) : undefined,
      filter.mediaKind ? eq(generationRequests.mediaKind, filter.mediaKind) : undefined,
      filter.createdFrom ? gte(generationRequests.createdAt, filter.createdFrom) : undefined,
      filter.createdTo ? lte(generationRequests.createdAt, filter.createdTo) : undefined,
    ].filter((condition) => condition !== undefined);
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

}

function asMediaKind(value: string): GenerationMediaKind {
  return value === "video" ? "video" : "image";
}

function asStatus(value: string): GenerationStatus {
  if ((ADMIN_GENERATION_STATUSES as readonly string[]).includes(value)) return value as GenerationStatus;
  throw new Error(`Unknown generation status: ${value}`);
}
