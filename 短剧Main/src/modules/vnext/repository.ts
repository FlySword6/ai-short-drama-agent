import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { GraphDocument, VnextActorKind } from "./types.js";

export type VnextProjectRow = {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export type VnextDocumentRow = {
  revision: number;
  document: GraphDocument;
  updated_at: Date;
  created_by_kind: VnextActorKind | null;
  created_by_user_id: string | null;
}

export type VnextRevisionRow = {
  revision: number;
  created_by_user_id: string;
  created_by_kind: VnextActorKind;
  created_at: Date;
}

export type VnextTelemetryEventRow = {
  id: string;
  userId: string;
  requestId: string;
  projectId: string;
  taskId: string;
  eventType: string;
  provider?: string;
  model?: string;
  capabilitySnapshotVersion?: string;
  paidConfirmation?: boolean;
  queueLatencyMs?: number;
  providerLatencyMs?: number;
  providerCostFen?: number;
  resultStatus?: string;
  retryReason?: string;
}

export type VnextAssistantSessionContextRow = {
  session_id: string;
  project_id: string;
  user_id: string;
}

/** vNext 数据访问层:所有 SQL 只出现在这里,领域规则在 service.ts。 */
export class VnextProjectRepository {
  constructor(private readonly db: Database) {}

  async listProjects(input: {
    userId: string;
    limit: number;
    cursor?: { updatedAt: Date; id: string };
  }): Promise<VnextProjectRow[]> {
    const cursor = input.cursor;
    const result = await this.db.execute<VnextProjectRow>(sql`
      SELECT p.id, p.name, p.created_at, p.updated_at
      FROM vnext.projects p
      JOIN vnext.project_members m ON m.project_id = p.id
      WHERE m.user_id = ${input.userId}::uuid
        ${cursor
          ? sql`AND (p.updated_at, p.id) < (${cursor.updatedAt}, ${cursor.id}::uuid)`
          : sql``}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT ${input.limit + 1}`);
    return result.rows;
  }

  async createProject(input: { id: string; ownerUserId: string; name: string }): Promise<VnextProjectRow | undefined> {
    const result = await this.db.execute<VnextProjectRow>(sql`
      WITH created AS (
        INSERT INTO vnext.projects (id, owner_user_id, name)
        VALUES (${input.id}::uuid, ${input.ownerUserId}::uuid, ${input.name})
        RETURNING id, name, created_at, updated_at
      ), membership AS (
        INSERT INTO vnext.project_members (project_id, user_id, role)
        VALUES (${input.id}::uuid, ${input.ownerUserId}::uuid, 'owner')
      )
      SELECT id, name, created_at, updated_at FROM created`);
    return result.rows[0];
  }

  async findProject(projectId: string): Promise<VnextProjectRow | undefined> {
    const result = await this.db.execute<VnextProjectRow>(sql`
      SELECT id, name, created_at, updated_at FROM vnext.projects WHERE id = ${projectId}::uuid`);
    return result.rows[0];
  }

  async findMemberRole(projectId: string, userId: string): Promise<string | undefined> {
    const result = await this.db.execute<{ role: string }>(sql`
      SELECT role FROM vnext.project_members
      WHERE project_id = ${projectId}::uuid AND user_id = ${userId}::uuid`);
    return result.rows[0]?.role;
  }

  async bindAssistantSession(input: { sessionId: string; projectId: string; userId: string }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO vnext.agent_session_contexts (session_id, project_id, user_id)
      VALUES (${input.sessionId}::uuid, ${input.projectId}::uuid, ${input.userId}::uuid)`);
  }

  async findAssistantSessionContext(
    sessionId: string,
    userId: string,
  ): Promise<VnextAssistantSessionContextRow | undefined> {
    const result = await this.db.execute<VnextAssistantSessionContextRow>(sql`
      SELECT session_id, project_id, user_id
      FROM vnext.agent_session_contexts
      WHERE session_id = ${sessionId}::uuid AND user_id = ${userId}::uuid`);
    return result.rows[0];
  }

  async findDocument(projectId: string): Promise<VnextDocumentRow | undefined> {
    const result = await this.db.execute<VnextDocumentRow>(sql`
      SELECT d.revision, d.document, d.updated_at, r.created_by_kind, r.created_by_user_id
      FROM vnext.graph_documents d
      LEFT JOIN vnext.graph_revisions r
        ON r.project_id = d.project_id AND r.revision = d.revision
      WHERE d.project_id = ${projectId}::uuid`);
    return result.rows[0];
  }

  /**
   * 乐观修订 CAS 写入:只有 expectedRevision 与当前事实一致才落库。
   * 显式事务内三步:首次写入(expected=0)走 INSERT,否则走行锁 UPDATE(RRC 下被并发
   * 提交阻塞后会按最新版本重估 WHERE,只可能恰好一个并发写获胜);随后同事务补
   * graph_revisions 历史并触碰项目更新时间。返回 undefined = 修订冲突,由服务层翻译 409。
   */
  async writeDocumentRevision(input: {
    projectId: string;
    expectedRevision: number;
    document: GraphDocument;
    actorUserId: string;
    actorKind: VnextActorKind;
  }): Promise<VnextDocumentRow | undefined> {
    return this.db.transaction(async (tx) => {
      const payload = JSON.stringify(input.document);
      const inserted = input.expectedRevision === 0
        ? await tx.execute<VnextDocumentRow>(sql`
            INSERT INTO vnext.graph_documents (project_id, revision, document, updated_at)
            SELECT ${input.projectId}::uuid, 1, ${payload}::jsonb, now()
            WHERE NOT EXISTS (SELECT 1 FROM vnext.graph_documents WHERE project_id = ${input.projectId}::uuid)
            ON CONFLICT (project_id) DO NOTHING
            RETURNING revision, document, updated_at`)
        : { rows: [] as VnextDocumentRow[] };
      const written = inserted.rows[0] ?? (await tx.execute<VnextDocumentRow>(sql`
        UPDATE vnext.graph_documents
        SET revision = revision + 1, document = ${payload}::jsonb, updated_at = now()
        WHERE project_id = ${input.projectId}::uuid AND revision = ${input.expectedRevision}
        RETURNING revision, document, updated_at`)).rows[0];
      if (!written) return undefined;
      await tx.execute(sql`
        INSERT INTO vnext.graph_revisions (project_id, revision, document, created_by_user_id, created_by_kind)
        VALUES (${input.projectId}::uuid, ${written.revision}, ${payload}::jsonb, ${input.actorUserId}::uuid, ${input.actorKind})`);
      await tx.execute(sql`
        UPDATE vnext.projects SET updated_at = now() WHERE id = ${input.projectId}::uuid`);
      return {
        revision: written.revision,
        document: written.document,
        updated_at: written.updated_at,
        created_by_kind: input.actorKind,
        created_by_user_id: input.actorUserId,
      };
    });
  }

  async listRevisions(projectId: string, limit: number): Promise<VnextRevisionRow[]> {
    const result = await this.db.execute<VnextRevisionRow>(sql`
      SELECT revision, created_by_user_id, created_by_kind, created_at
      FROM vnext.graph_revisions
      WHERE project_id = ${projectId}::uuid
      ORDER BY revision DESC
      LIMIT ${limit}`);
    return result.rows;
  }

  async insertTelemetryEvent(event: VnextTelemetryEventRow): Promise<void> {
    await this.db.execute(sql`INSERT INTO vnext.generation_telemetry_events (
      id, user_id, request_id, project_id, task_id, event_type, provider, model,
      capability_snapshot_version, paid_confirmation, queue_latency_ms, provider_latency_ms,
      provider_cost_fen, result_status, retry_reason
    ) VALUES (
      ${event.id}::uuid, ${event.userId}::uuid, ${event.requestId}, ${event.projectId}::uuid,
      ${event.taskId}::uuid, ${event.eventType}, ${event.provider ?? null}, ${event.model ?? null},
      ${event.capabilitySnapshotVersion ?? null}, ${event.paidConfirmation ?? null}, ${event.queueLatencyMs ?? null},
      ${event.providerLatencyMs ?? null}, ${event.providerCostFen ?? null}, ${event.resultStatus ?? null}, ${event.retryReason ?? null}
    )`);
  }
}
