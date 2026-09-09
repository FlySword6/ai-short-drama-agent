import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  agentMessages,
  agentSessions,
  episodes,
  projects,
  shots,
  users,
} from "../../db/schema.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";

export type AssistantSessionRow = typeof agentSessions.$inferSelect;
export type AssistantMessageRow = typeof agentMessages.$inferSelect;
export type AssistantAuditStatus = "completed" | "failed" | "aborted";
export type AssistantAuditErrorCode =
  | "assistant_aborted"
  | "assistant_model_error"
  | "assistant_request_failed"
  | "assistant_tool_failed";

/** Project audit records are metadata, never conversation transcripts. */
export interface AssistantAuditLogRow {
  id: string;
  sessionId: string;
  role: string;
  toolName: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  usage: Record<string, unknown> | null;
  providerCostUsdMicros: number | null;
  pointsSpent: number | null;
  durationMs: number | null;
  errorCode: AssistantAuditErrorCode | null;
  createdAt: Date;
  userId: string;
  userName: string;
  projectId: string;
  shotId: string | null;
}

export class AssistantRepository {
  constructor(private readonly db: Database) {}

  async createSession(input: {
    actorId: string;
    authSessionId: string;
    agentType: string;
    userAgent: string | null;
    projectId?: string;
    episodeId?: string;
    shotId?: string;
    title?: string;
  }): Promise<AssistantSessionRow> {
    let projectId = input.projectId;
    if (input.projectId) await this.assertProjectOwner(input.actorId, input.projectId);

    if (input.shotId) {
      const access = (await this.db.select({
        shot: shots,
        episode: episodes,
        project: projects,
      }).from(shots)
        .innerJoin(episodes, eq(shots.episodeId, episodes.id))
        .innerJoin(projects, eq(episodes.projectId, projects.id))
        .where(and(
          eq(shots.id, input.shotId),
          isNull(shots.deletedAt),
          isNull(episodes.deletedAt),
          isNull(projects.deletedAt),
        )).limit(1))[0];
      if (!access) throw new NotFoundError("分镜不存在");
      if (access.project.ownerUserId !== input.actorId) throw new ForbiddenError();
      if (input.projectId && input.projectId !== access.project.id) {
        throw new ConflictError("分镜不属于当前项目", "assistant_context_mismatch");
      }
      if (input.episodeId && input.episodeId !== access.episode.id) {
        throw new ConflictError("分镜不属于当前集", "assistant_context_mismatch");
      }
      projectId = access.project.id;
    } else if (input.episodeId) {
      const access = (await this.db.select({ episode: episodes, project: projects })
        .from(episodes)
        .innerJoin(projects, eq(episodes.projectId, projects.id))
        .where(and(
          eq(episodes.id, input.episodeId),
          isNull(episodes.deletedAt),
          isNull(projects.deletedAt),
        )).limit(1))[0];
      if (!access) throw new NotFoundError("集不存在");
      if (access.project.ownerUserId !== input.actorId) throw new ForbiddenError();
      if (input.projectId && input.projectId !== access.project.id) {
        throw new ConflictError("集不属于当前项目", "assistant_context_mismatch");
      }
      projectId = access.project.id;
    }

    const now = new Date();
    const rows = await this.db.insert(agentSessions).values({
      id: crypto.randomUUID(),
      userId: input.actorId,
      authSessionId: input.authSessionId,
      agentType: input.agentType,
      userAgent: input.userAgent,
      projectId: projectId ?? null,
      shotId: input.shotId ?? null,
      title: input.title?.trim() || "小龙虾会话",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }).returning();
    const session = rows[0];
    if (!session) throw new Error("Failed to create assistant session");
    return session;
  }

  async getSession(actorId: string, sessionId: string): Promise<AssistantSessionRow> {
    const session = (await this.db.select().from(agentSessions).where(and(
      eq(agentSessions.id, sessionId),
      isNull(agentSessions.deletedAt),
    )).limit(1))[0];
    if (!session) throw new NotFoundError("助手会话不存在");
    if (session.userId !== actorId) throw new ForbiddenError();
    return session;
  }

  async updateClarificationState(
    sessionId: string,
    state: Record<string, unknown> | null,
  ): Promise<void> {
    // 合并而非覆盖：先读取当前状态，再深合并新状态
    if (state === null) {
      await this.db.update(agentSessions)
        .set({ clarificationState: null, updatedAt: new Date() })
        .where(eq(agentSessions.id, sessionId));
      return;
    }

    // 读取当前状态
    const [row] = await this.db.select({ clarificationState: agentSessions.clarificationState })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);

    const current = (row?.clarificationState as Record<string, unknown> | null) ?? {};
    // 浅合并：顶层 key 合并，ephemeralFields 单独深合并
    const merged: Record<string, unknown> = { ...current, ...state };
    if (state.ephemeralFields && typeof state.ephemeralFields === "object") {
      merged.ephemeralFields = {
        ...((current.ephemeralFields as Record<string, unknown> | undefined) ?? {}),
        ...(state.ephemeralFields as Record<string, unknown>),
      };
    }

    await this.db.update(agentSessions)
      .set({ clarificationState: merged, updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId));
  }

  async listMessages(actorId: string, sessionId: string): Promise<AssistantMessageRow[]> {
    await this.getSession(actorId, sessionId);
    return this.db.select().from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId))
      .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id));
  }

  async listProjectAuditLogs(input: {
    actorId: string;
    projectId: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: AssistantAuditLogRow[]; total: number }> {
    await this.assertProjectOwner(input.actorId, input.projectId);
    const where = and(
      eq(agentSessions.projectId, input.projectId),
      isNull(agentSessions.deletedAt),
    );
    const offset = (input.page - 1) * input.pageSize;
    const [items, totalRows] = await Promise.all([
      this.db.select({
        id: agentMessages.id,
        sessionId: agentMessages.sessionId,
        role: agentMessages.role,
        toolName: agentMessages.toolName,
        status: agentMessages.status,
        provider: agentMessages.provider,
        model: agentMessages.model,
        usage: agentMessages.usage,
        providerCostUsdMicros: agentMessages.providerCostUsdMicros,
        pointsSpent: agentMessages.pointsSpent,
        durationMs: agentMessages.durationMs,
        errorCode: agentMessages.errorSummary,
        createdAt: agentMessages.createdAt,
        userId: users.id,
        userName: users.displayName,
        projectId: agentSessions.projectId,
        shotId: agentSessions.shotId,
      }).from(agentMessages)
        .innerJoin(agentSessions, eq(agentSessions.id, agentMessages.sessionId))
        .innerJoin(users, eq(users.id, agentSessions.userId))
        .where(where)
        .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::integer` })
        .from(agentMessages)
        .innerJoin(agentSessions, eq(agentSessions.id, agentMessages.sessionId))
        .where(where),
    ]);
    return {
      items: items.flatMap((row): AssistantAuditLogRow[] => row.projectId ? [{
        ...row,
        errorCode: normalizeAuditErrorCode(row.errorCode),
        projectId: row.projectId,
      }] : []),
      total: Number(totalRows[0]?.total ?? 0),
    };
  }

  async appendMessage(input: {
    sessionId: string;
    role: "user" | "assistant" | "tool";
    content: string;
    toolName?: string;
    status?: AssistantAuditStatus;
    provider?: string;
    model?: string;
    usage?: Record<string, unknown>;
    providerCostUsdMicros?: number;
    pointsSpent?: number;
    durationMs?: number;
    errorCode?: AssistantAuditErrorCode;
  }): Promise<AssistantMessageRow> {
    const now = new Date();
    const rows = await this.db.insert(agentMessages).values({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content.slice(0, 100_000),
      toolName: input.toolName ?? null,
      toolArguments: null,
      toolResultSummary: null,
      status: input.status ?? "completed",
      provider: input.provider?.slice(0, 64) ?? null,
      model: input.model?.slice(0, 128) ?? null,
      usage: input.usage ?? null,
      providerCostUsdMicros: nonNegativeIntegerOrNull(input.providerCostUsdMicros),
      pointsSpent: nonNegativeIntegerOrNull(input.pointsSpent),
      durationMs: nonNegativeIntegerOrNull(input.durationMs),
      errorSummary: input.errorCode ?? null,
      createdAt: now,
    }).returning();
    await this.db.update(agentSessions).set({ updatedAt: now })
      .where(eq(agentSessions.id, input.sessionId));
    const message = rows[0];
    if (!message) throw new Error("Failed to save assistant message");
    return message;
  }

  private async assertProjectOwner(actorId: string, projectId: string): Promise<void> {
    const project = (await this.db.select().from(projects).where(and(
      eq(projects.id, projectId),
      isNull(projects.deletedAt),
    )).limit(1))[0];
    if (!project) throw new NotFoundError("项目不存在");
    if (project.ownerUserId !== actorId) throw new ForbiddenError();
  }
}

function nonNegativeIntegerOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeAuditErrorCode(value: string | null): AssistantAuditErrorCode | null {
  switch (value) {
    case "assistant_aborted":
    case "assistant_model_error":
    case "assistant_request_failed":
    case "assistant_tool_failed":
      return value;
    default:
      return null;
  }
}
