import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { projects, projectStyles } from "../../../db/schema.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  isPostgresUniqueViolation,
} from "../../../shared/errors.js";
import { PROJECT_STYLE_CONTENT_MAX, type ProjectStyle, type ProjectStyleInput, type ProjectStyleMediaKind } from "./types.js";

type ProjectStyleRow = typeof projectStyles.$inferSelect;

/**
 * 镜像写：默认风格内容同步到 projects.style* 列（null = 清空，回「无默认」的注入语义）。
 * 生成期 resolveProjectGenerationConfig 读同一列（§4.6，生成链路零改动）。
 */
async function writeStyleMirror(
  db: Database,
  projectId: string,
  mediaKind: ProjectStyleMediaKind,
  content: string | null,
): Promise<void> {
  await db.update(projects).set(
    mediaKind === "image" ? { imageStyleDescription: content } : { videoStyleDescription: content },
  ).where(eq(projects.id, projectId));
}

/** PostgreSQL 是风格库的唯一正式事实来源（Lite 配置页风格库 §4.4）。 */
export class ProjectStyleRepository {
  constructor(private readonly db: Database) {}

  async listForActor(
    actorId: string,
    projectId: string,
    mediaKind?: ProjectStyleMediaKind,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle[]> {
    await assertProjectOwnerUnlessRouteVerified(this.db, actorId, projectId, authorizedProjectId);
    const rows = await this.db.select().from(projectStyles)
      .where(and(
        eq(projectStyles.projectId, projectId),
        isNull(projectStyles.deletedAt),
        mediaKind === undefined ? undefined : eq(projectStyles.mediaKind, mediaKind),
      ))
      .orderBy(asc(projectStyles.createdAt));
    return rows.map(toProjectStyle);
  }

  async createForActor(
    actorId: string,
    projectId: string,
    input: ProjectStyleInput,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle> {
    return this.db.transaction(async (tx) => {
      await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
      const now = new Date();
      const written = await tx.insert(projectStyles).values({
        id: crypto.randomUUID(),
        projectId,
        mediaKind: input.mediaKind,
        name: input.name,
        content: input.content,
        createdByUserId: actorId,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({
        target: [projectStyles.projectId, projectStyles.mediaKind, projectStyles.name],
        where: isNull(projectStyles.deletedAt),
      }).returning();
      if (written[0]) return toProjectStyle(written[0]);
      throw new ConflictError(
        "同名风格已存在，换个名字或先删掉旧风格再试",
        "project_style_name_conflict",
      );
    });
  }

  async updateForActor(
    actorId: string,
    projectId: string,
    styleId: string,
    input: ProjectStyleInput,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle> {
    return this.db.transaction(async (tx) => {
      await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
      const target = await tx.select({ id: projectStyles.id, mediaKind: projectStyles.mediaKind })
        .from(projectStyles).where(and(
          eq(projectStyles.id, styleId),
          eq(projectStyles.projectId, projectId),
          isNull(projectStyles.deletedAt),
        )).limit(1);
      if (!target[0]) throw new NotFoundError("风格不存在或已删除");
      const conflict = await tx.select({ id: projectStyles.id }).from(projectStyles).where(and(
        eq(projectStyles.projectId, projectId),
        eq(projectStyles.mediaKind, input.mediaKind),
        eq(projectStyles.name, input.name),
        isNull(projectStyles.deletedAt),
        ne(projectStyles.id, styleId),
      )).limit(1);
      if (conflict[0]) {
        throw new ConflictError("同名风格已存在，换个名字再试", "project_style_name_conflict");
      }
      const now = new Date();
      const written = await tx.update(projectStyles).set({
        mediaKind: input.mediaKind,
        name: input.name,
        content: input.content,
        updatedAt: now,
      }).where(and(
        eq(projectStyles.id, styleId),
        eq(projectStyles.projectId, projectId),
        isNull(projectStyles.deletedAt),
      )).returning();
      if (!written[0]) throw new NotFoundError("风格不存在或已删除");
      // D1（2026-08-17 修订）：默认行可编辑；编辑保存同事务同步镜像列，保持
      // 「默认行内容 = 镜像列 = 生成实际注入」三点一线（§4.7）。
      if (written[0].isDefault) {
        const kindChanged = written[0].mediaKind !== target[0].mediaKind;
        if (kindChanged) {
          // 默认行换媒介（直连 API 才可能；Lite 表单不提供）：新媒介现有默认让位、
          // 旧媒介镜像清空——默认随行走，全程可逆。
          await tx.update(projectStyles).set({ isDefault: false, updatedAt: now }).where(and(
            eq(projectStyles.projectId, projectId),
            eq(projectStyles.mediaKind, written[0].mediaKind),
            ne(projectStyles.id, styleId),
            eq(projectStyles.isDefault, true),
            isNull(projectStyles.deletedAt),
          ));
          await writeStyleMirror(tx as Database, projectId, target[0].mediaKind as ProjectStyleMediaKind, null);
        }
        await writeStyleMirror(tx as Database, projectId, written[0].mediaKind as ProjectStyleMediaKind, written[0].content);
      }
      return toProjectStyle(written[0]);
    });
  }

  /** 软删（R1 禁硬删）：仅置 deleted_at + deleted_by_user_id；同名字可复用。
      D1 修订：默认行可删；删除默认行同事务清镜像列（默认随行消失，回「无默认」空态）。 */
  async softDeleteForActor(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
      const target = await tx.select({ id: projectStyles.id, isDefault: projectStyles.isDefault })
        .from(projectStyles).where(and(
          eq(projectStyles.id, styleId),
          eq(projectStyles.projectId, projectId),
          isNull(projectStyles.deletedAt),
        )).limit(1);
      if (!target[0]) throw new NotFoundError("风格不存在或已删除");
      const now = new Date();
      const written = await tx.update(projectStyles).set({
        deletedAt: now,
        deletedByUserId: actorId,
        updatedAt: now,
      }).where(and(
        eq(projectStyles.id, styleId),
        eq(projectStyles.projectId, projectId),
        isNull(projectStyles.deletedAt),
      )).returning({ id: projectStyles.id, isDefault: projectStyles.isDefault, mediaKind: projectStyles.mediaKind });
      if (!written[0]) throw new NotFoundError("风格不存在或已删除");
      if (written[0].isDefault) {
        await writeStyleMirror(tx as Database, projectId, written[0].mediaKind as ProjectStyleMediaKind, null);
      }
    });
  }

  /** 设/换默认（可逆，D1 2026-08-17 修订）：同事务旧默认让位 + 目标行置位 + 镜像更新。
      并发换设由 project_styles_one_default_key 唯一索引兜底 → 409 可重试（并发保护，非锁定语义）。 */
  async setDefaultForActor(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle> {
    try {
      return await this.db.transaction(async (tx) => {
        await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
        const target = await tx.select().from(projectStyles).where(and(
          eq(projectStyles.id, styleId),
          eq(projectStyles.projectId, projectId),
          isNull(projectStyles.deletedAt),
        )).limit(1);
        if (!target[0]) throw new NotFoundError("风格不存在或已删除");
        if (target[0].isDefault) return toProjectStyle(target[0]);
        const now = new Date();
        // 换设让位：该媒介现有默认行（若有）同事务置 false。
        await tx.update(projectStyles).set({ isDefault: false, updatedAt: now }).where(and(
          eq(projectStyles.projectId, projectId),
          eq(projectStyles.mediaKind, target[0].mediaKind),
          ne(projectStyles.id, styleId),
          eq(projectStyles.isDefault, true),
          isNull(projectStyles.deletedAt),
        ));
        const written = await tx.update(projectStyles).set({
          isDefault: true,
          updatedAt: now,
        }).where(and(
          eq(projectStyles.id, styleId),
          eq(projectStyles.projectId, projectId),
          isNull(projectStyles.deletedAt),
        )).returning();
        if (!written[0]) throw new NotFoundError("风格不存在或已删除");
        await writeStyleMirror(tx as Database, projectId, written[0].mediaKind as ProjectStyleMediaKind, written[0].content);
        return toProjectStyle(written[0]);
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictError("默认风格设置冲突（另一处同时在改默认），请重试", "project_style_default_conflict");
      }
      throw error;
    }
  }

  /** 取消默认（可逆）：is_default 置 false + 镜像清空，回「无默认」空态（该媒介生成不再注入风格）。 */
  async unsetDefaultForActor(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle> {
    return this.db.transaction(async (tx) => {
      await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
      const target = await tx.select().from(projectStyles).where(and(
        eq(projectStyles.id, styleId),
        eq(projectStyles.projectId, projectId),
        isNull(projectStyles.deletedAt),
      )).limit(1);
      if (!target[0]) throw new NotFoundError("风格不存在或已删除");
      if (!target[0].isDefault) return toProjectStyle(target[0]);
      const now = new Date();
      const written = await tx.update(projectStyles).set({
        isDefault: false,
        updatedAt: now,
      }).where(and(
        eq(projectStyles.id, styleId),
        eq(projectStyles.projectId, projectId),
        isNull(projectStyles.deletedAt),
      )).returning();
      if (!written[0]) throw new NotFoundError("风格不存在或已删除");
      await writeStyleMirror(tx as Database, projectId, written[0].mediaKind as ProjectStyleMediaKind, null);
      return toProjectStyle(written[0]);
    });
  }

  /**
   * D2 同步（§4.7 定稿＝同步，2026-08-17 修订二）：完整版 generation_config PATCH 直写
   * projects.style* 列后调用——将该媒介默认行与镜像列对齐：镜像非空（1-5000 字）→ 行 content
   * 跟随镜像；镜像为空/超长 → 行取消默认（超长值进不了行 CHECK，取消默认保留镜像注入语义，
   * 不自作主张截断）。无默认行时不动（完整版直写列，行为不变）。
   */
  async alignDefaultRowsWithMirror(
    projectId: string,
    mediaKinds: readonly ProjectStyleMediaKind[],
  ): Promise<void> {
    if (mediaKinds.length === 0) return;
    await this.db.transaction(async (tx) => {
      const projectRows = await tx.select({
        image: projects.imageStyleDescription,
        video: projects.videoStyleDescription,
      }).from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!projectRows[0]) return;
      const now = new Date();
      for (const kind of mediaKinds) {
        const rows = await tx.select({ id: projectStyles.id }).from(projectStyles).where(and(
          eq(projectStyles.projectId, projectId),
          eq(projectStyles.mediaKind, kind),
          eq(projectStyles.isDefault, true),
          isNull(projectStyles.deletedAt),
        )).limit(1);
        if (!rows[0]) continue;
        const trimmed = (kind === "image" ? projectRows[0].image : projectRows[0].video)?.trim() ?? "";
        if (trimmed.length >= 1 && trimmed.length <= PROJECT_STYLE_CONTENT_MAX) {
          await tx.update(projectStyles).set({ content: trimmed, updatedAt: now }).where(and(
            eq(projectStyles.id, rows[0].id),
            isNull(projectStyles.deletedAt),
          ));
        } else {
          await tx.update(projectStyles).set({ isDefault: false, updatedAt: now }).where(and(
            eq(projectStyles.id, rows[0].id),
            isNull(projectStyles.deletedAt),
          ));
        }
      }
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

function toProjectStyle(row: ProjectStyleRow): ProjectStyle {
  return {
    id: row.id,
    projectId: row.projectId,
    mediaKind: row.mediaKind as ProjectStyleMediaKind,
    name: row.name,
    content: row.content,
    isDefault: row.isDefault,
    createdByUserId: row.createdByUserId,
    deletedByUserId: row.deletedByUserId,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
