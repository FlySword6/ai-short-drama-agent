import { randomUUID } from "node:crypto";
import type { Database } from "../../db/client.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { VnextProjectRepository, type VnextProjectRow } from "./repository.js";
import type {
  GenerationTelemetryEvent,
  GraphDocument,
  VnextActorKind,
  VnextGraphDocument,
  VnextProject,
  VnextRevisionSummary,
} from "./types.js";

export type {
  GenerationTelemetryEvent,
  GraphDocument,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  VnextActorKind,
  VnextGraphDocument,
  VnextLastWrite,
  VnextProject,
  VnextRevisionSummary,
} from "./types.js";

export interface VnextProjectPage {
  items: VnextProject[];
  nextCursor: string | null;
}

export class VnextProjectService {
  private readonly repository: VnextProjectRepository;

  constructor(db: Database) {
    this.repository = new VnextProjectRepository(db);
  }

  /** 稳定排序 (updated_at, id) 的 keyset 分页;cursor 只认本服务编码的格式。 */
  async listProjects(actor: ProjectAccessActor, input: { limit?: number; cursor?: string } = {}): Promise<VnextProjectPage> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const cursor = input.cursor ? decodeProjectCursor(input.cursor) : undefined;
    const rows = await this.repository.listProjects({ userId: actor.id, limit, cursor });
    const items = rows.slice(0, limit).map(toProject);
    const last = items.length === limit ? items[items.length - 1] : undefined;
    return { items, nextCursor: rows.length > limit && last ? encodeProjectCursor(last) : null };
  }

  async createProject(actor: ProjectAccessActor, name: string): Promise<VnextProject> {
    const row = await this.repository.createProject({ id: randomUUID(), ownerUserId: actor.id, name: name.trim() });
    if (!row) throw new Error("vNext project creation did not return a project");
    return toProject(row);
  }

  async getProject(actor: ProjectAccessActor, projectId: string): Promise<VnextProject> {
    await this.requireAccess(actor, projectId, "read");
    const row = await this.repository.findProject(projectId);
    if (!row) throw new NotFoundError("vNext 项目不存在或你没有访问权限");
    return toProject(row);
  }

  async bindAssistantSession(
    actor: ProjectAccessActor,
    sessionId: string,
    projectId: string,
  ): Promise<void> {
    await this.requireAccess(actor, projectId, "read");
    await this.repository.bindAssistantSession({ sessionId, projectId, userId: actor.id });
  }

  async resolveAssistantProject(
    actor: ProjectAccessActor,
    sessionId: string,
  ): Promise<string | null> {
    const context = await this.repository.findAssistantSessionContext(sessionId, actor.id);
    if (!context) return null;
    await this.requireAccess(actor, context.project_id, "read");
    return context.project_id;
  }

  async getDocument(actor: ProjectAccessActor, projectId: string): Promise<VnextGraphDocument> {
    await this.requireAccess(actor, projectId, "read");
    const row = await this.repository.findDocument(projectId);
    if (!row) {
      return {
        projectId,
        revision: 0,
        document: { schemaVersion: 1, nodes: [], edges: [] },
        updatedAt: new Date(0),
        lastWrite: null,
      };
    }
    return {
      projectId,
      revision: row.revision,
      document: row.document,
      updatedAt: toDate(row.updated_at),
      lastWrite: row.created_by_kind ? { kind: row.created_by_kind, userId: row.created_by_user_id, at: toDate(row.updated_at) } : null,
    };
  }

  /** 修订历史是「Agent 状态」的唯一事实源:界面与 Agent 走同一服务写入。 */
  async listRevisions(actor: ProjectAccessActor, projectId: string, limit = 20): Promise<VnextRevisionSummary[]> {
    await this.requireAccess(actor, projectId, "read");
    const capped = Math.min(Math.max(limit, 1), 100);
    const rows = await this.repository.listRevisions(projectId, capped);
    return rows.map((row) => ({
      revision: row.revision,
      createdByUserId: row.created_by_user_id,
      createdByKind: row.created_by_kind,
      createdAt: toDate(row.created_at),
    }));
  }

  async replaceDocument(input: {
    actor: ProjectAccessActor;
    projectId: string;
    expectedRevision: number;
    document: GraphDocument;
    actorKind: VnextActorKind;
  }): Promise<VnextGraphDocument> {
    await this.requireAccess(input.actor, input.projectId, "write");
    validateDocument(input.document);
    const row = await this.repository.writeDocumentRevision({
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      document: input.document,
      actorUserId: input.actor.id,
      actorKind: input.actorKind,
    });
    if (!row) {
      // 按仓库错误约定与合同文档:409 错误体不带 details;调用方经 GET 重读真实 revision 再合并重放。
      throw new ConflictError("画布已被其他人更新，请刷新后再保存", "vnext_revision_conflict");
    }
    return {
      projectId: input.projectId,
      revision: row.revision,
      document: row.document,
      updatedAt: toDate(row.updated_at),
      lastWrite: { kind: input.actorKind, userId: input.actor.id, at: toDate(row.updated_at) },
    };
  }

  async recordGenerationTelemetry(actor: ProjectAccessActor, event: GenerationTelemetryEvent): Promise<void> {
    await this.requireAccess(actor, event.projectId, "write");
    await this.repository.insertTelemetryEvent(event);
  }

  private async requireAccess(actor: ProjectAccessActor, projectId: string, action: "read" | "write"): Promise<void> {
    const role = await this.repository.findMemberRole(projectId, actor.id);
    if (!role) throw new NotFoundError("vNext 项目不存在或你没有访问权限");
    if (action === "write" && role === "viewer") throw new ForbiddenError("你没有在这个 vNext 项目中保存画布的权限");
  }
}

const CURSOR_SEPARATOR = "|";

function encodeProjectCursor(project: VnextProject): string {
  return Buffer.from(`${project.updatedAt.toISOString()}${CURSOR_SEPARATOR}${project.id}`, "utf8").toString("base64url");
}

function decodeProjectCursor(cursor: string): { updatedAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(CURSOR_SEPARATOR);
  const updatedAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator <= 0 || Number.isNaN(updatedAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw new BadRequestError("分页游标无效，请从第一页重新加载");
  }
  return { updatedAt, id };
}

function toProject(row: VnextProjectRow): VnextProject {
  return { id: row.id, name: row.name, createdAt: toDate(row.created_at), updatedAt: toDate(row.updated_at) };
}

/** drizzle `db.execute` 的 raw 行里 timestamptz 可能是字符串;领域事实一律规范化为 Date。 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function validateDocument(document: GraphDocument): void {
  if (
    document.schemaVersion !== 1
    || document.nodes.length > 1000
    || document.edges.length > 2000
  ) {
    throw new BadRequestError("GraphDocument 不符合 vNext 画布合同");
  }
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    if (
      !UUID_PATTERN.test(node.id)
      || nodeIds.has(node.id)
      || !GRAPH_NODE_KINDS.has(node.kind)
      || node.label !== node.label.trim()
      || node.label.length < 1
      || node.label.length > 240
      || !Number.isFinite(node.position.x)
      || !Number.isFinite(node.position.y)
      || (node.data !== undefined && Object.values(node.data).some((value) => (
        (value !== null && !["string", "number", "boolean"].includes(typeof value))
        || (typeof value === "number" && !Number.isFinite(value))
      )))
    ) {
      throw new BadRequestError("GraphDocument 包含非法节点");
    }
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (
      !UUID_PATTERN.test(edge.id)
      || edgeIds.has(edge.id)
      || !UUID_PATTERN.test(edge.source)
      || !UUID_PATTERN.test(edge.target)
      || !nodeIds.has(edge.source)
      || !nodeIds.has(edge.target)
      || (edge.label !== undefined && (
        edge.label !== edge.label.trim()
        || edge.label.length < 1
        || edge.label.length > 240
      ))
    ) {
      throw new BadRequestError("GraphDocument 包含非法边");
    }
    edgeIds.add(edge.id);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRAPH_NODE_KINDS = new Set(["scene", "asset", "task", "note"]);
