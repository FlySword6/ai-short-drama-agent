import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { projects, promptTemplates } from "../../../db/schema.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { PromptTemplate, PromptTemplateInput, PromptTemplateMediaKind } from "./types.js";

type PromptTemplateRow = typeof promptTemplates.$inferSelect;

/** PostgreSQL 是模板库的唯一正式事实来源（Lite 项目级提示词模板库 §4.3）。 */
export class PromptTemplateRepository {
  constructor(private readonly db: Database) {}

  async listForActor(
    actorId: string,
    projectId: string,
    mediaKind?: PromptTemplateMediaKind,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate[]> {
    await assertProjectOwnerUnlessRouteVerified(this.db, actorId, projectId, authorizedProjectId);
    const rows = await this.db.select().from(promptTemplates)
      .where(and(
        eq(promptTemplates.projectId, projectId),
        isNull(promptTemplates.deletedAt),
        mediaKind === undefined ? undefined : eq(promptTemplates.mediaKind, mediaKind),
      ))
      .orderBy(asc(promptTemplates.createdAt));
    return rows.map(toPromptTemplate);
  }

  async getForActor(
    actorId: string,
    projectId: string,
    templateId: string,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate> {
    await assertProjectOwnerUnlessRouteVerified(this.db, actorId, projectId, authorizedProjectId);
    const rows = await this.db.select().from(promptTemplates).where(and(
      eq(promptTemplates.id, templateId),
      eq(promptTemplates.projectId, projectId),
      isNull(promptTemplates.deletedAt),
    )).limit(1);
    if (!rows[0]) throw new NotFoundError("模板不存在或已删除");
    return toPromptTemplate(rows[0]);
  }

  async createForActor(
    actorId: string,
    projectId: string,
    input: PromptTemplateInput,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate> {
    return this.db.transaction(async (tx) => {
      await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
      const now = new Date();
      const written = await tx.insert(promptTemplates).values({
        id: crypto.randomUUID(),
        projectId,
        mediaKind: input.mediaKind,
        name: input.name,
        content: input.content,
        createdByUserId: actorId,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({
        target: [promptTemplates.projectId, promptTemplates.mediaKind, promptTemplates.name],
        where: isNull(promptTemplates.deletedAt),
      }).returning();
      if (written[0]) return toPromptTemplate(written[0]);
      throw new ConflictError(
        "同名模板已存在，换个名字或先删掉旧模板再试",
        "prompt_template_name_conflict",
      );
    });
  }

  async updateForActor(
    actorId: string,
    projectId: string,
    templateId: string,
    input: PromptTemplateInput,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate> {
    return this.db.transaction(async (tx) => {
      await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
      const conflict = await tx.select({ id: promptTemplates.id }).from(promptTemplates).where(and(
        eq(promptTemplates.projectId, projectId),
        eq(promptTemplates.mediaKind, input.mediaKind),
        eq(promptTemplates.name, input.name),
        isNull(promptTemplates.deletedAt),
        ne(promptTemplates.id, templateId),
      )).limit(1);
      if (conflict[0]) {
        throw new ConflictError(
          "同名模板已存在，换个名字再试",
          "prompt_template_name_conflict",
        );
      }
      const now = new Date();
      const written = await tx.update(promptTemplates).set({
        mediaKind: input.mediaKind,
        name: input.name,
        content: input.content,
        updatedAt: now,
      }).where(and(
        eq(promptTemplates.id, templateId),
        eq(promptTemplates.projectId, projectId),
        isNull(promptTemplates.deletedAt),
      )).returning();
      if (!written[0]) throw new NotFoundError("模板不存在或已删除");
      return toPromptTemplate(written[0]);
    });
  }

  /** 软删（R1 禁硬删）：仅置 deleted_at + deleted_by_user_id；同名字可复用。 */
  async softDeleteForActor(
    actorId: string,
    projectId: string,
    templateId: string,
    authorizedProjectId?: string,
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
      const now = new Date();
      const written = await tx.update(promptTemplates).set({
        deletedAt: now,
        deletedByUserId: actorId,
        updatedAt: now,
      }).where(and(
        eq(promptTemplates.id, templateId),
        eq(promptTemplates.projectId, projectId),
        isNull(promptTemplates.deletedAt),
      )).returning({ id: promptTemplates.id });
      if (!written[0]) throw new NotFoundError("模板不存在或已删除");
    });
  }
}

/**
 * 与 generation defaults 同款项目作用域校验：HTTP 路由经 ProjectAccessService
 * 拿到 authorizedProjectId 后走「项目成员即通过」；遗留直连调用方保留 owner-only。
 */
async function assertProjectOwnerUnlessRouteVerified(
  db: Database,
  actorId: string,
  projectId: string,
  authorizedProjectId?: string,
): Promise<void> {
  if (authorizedProjectId !== undefined) {
    if (authorizedProjectId !== projectId) throw new NotFoundError("项目不存在");
    return;
  }
  await assertProjectOwner(db, actorId, projectId);
}

async function assertProjectOwner(db: Database, actorId: string, projectId: string): Promise<void> {
  const rows = await db.select({ ownerUserId: projects.ownerUserId }).from(projects).where(and(
    eq(projects.id, projectId),
    isNull(projects.deletedAt),
  )).limit(1);
  const project = rows[0];
  if (!project) throw new NotFoundError("项目不存在");
  if (project.ownerUserId !== actorId) throw new ForbiddenError();
}

function toPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    projectId: row.projectId,
    mediaKind: row.mediaKind as PromptTemplateMediaKind,
    name: row.name,
    content: row.content,
    createdByUserId: row.createdByUserId,
    deletedByUserId: row.deletedByUserId,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 读取生成默认策略参数里的引用 id（无引用/格式异常 → null）。 */
export function promptTemplateIdOf(parameters: Record<string, unknown>): string | null {
  const value = parameters?.prompt_template_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
