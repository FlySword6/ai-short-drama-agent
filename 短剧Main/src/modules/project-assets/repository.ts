import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  projectAssetRefs,
  projects,
} from "../../db/schema.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { canReferenceAsset } from "../assets/access.js";

export type ProjectAssetReferenceRow = typeof projectAssetRefs.$inferSelect;

export interface AddProjectAssetReferenceInput {
  assetEntityId: string;
  assetVariantId?: string | null;
  assetMediaId?: string | null;
}

export class ProjectAssetRepository {
  constructor(private readonly db: Database) {}

  /**
   * `authorizedProjectId` is an internal route capability issued by
   * ProjectAccessService after it has applied the member matrix. Keeping it
   * optional preserves the old owner-only boundary for direct callers such
   * as CLI compatibility paths.
   */
  async list(
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): Promise<ProjectAssetReferenceRow[]> {
    await this.assertProjectAccess(actorId, projectId, authorizedProjectId);
    return this.db.select().from(projectAssetRefs).where(and(
      eq(projectAssetRefs.projectId, projectId),
      isNull(projectAssetRefs.deletedAt),
    )).orderBy(asc(projectAssetRefs.createdAt));
  }

  async add(
    actorId: string,
    projectId: string,
    input: AddProjectAssetReferenceInput,
    authorizedProjectId?: string,
  ): Promise<ProjectAssetReferenceRow> {
    return this.db.transaction(async (tx) => {
      const projectRows = await tx.select().from(projects).where(and(
        eq(projects.id, projectId),
        isNull(projects.deletedAt),
      )).limit(1);
      const project = projectRows[0];
      if (!project) throw new NotFoundError("项目不存在");
      this.assertAuthorizedProject(project.ownerUserId, actorId, projectId, authorizedProjectId);
      await lockProjectAssetNamespace(tx as unknown as Database, projectId);

      const entityRows = await tx.select().from(assetEntities)
        .where(eq(assetEntities.id, input.assetEntityId))
        .for("update")
        .limit(1);
      const entity = entityRows[0];
      if (!entity) throw new NotFoundError("资产不存在");
      if (entity.visibility !== "personal" && entity.visibility !== "common") {
        throw new ConflictError("资产使用范围设置异常，请联系管理员处理", "invalid_asset_visibility");
      }
      if (entity.deletedAt) throw new ConflictError("资产已在回收站中", "asset_in_trash");
      if (!canReferenceAsset({
        id: entity.id,
        ownerUserId: entity.ownerUserId,
        visibility: entity.visibility,
        status: entity.status,
        deletedAt: entity.deletedAt,
      }, actorId)) {
        throw new ForbiddenError("无权引用该资产");
      }

      let variant: typeof assetVariants.$inferSelect | null = null;
      if (input.assetVariantId) {
        const variantRows = await tx.select().from(assetVariants)
          .where(eq(assetVariants.id, input.assetVariantId)).limit(1);
        variant = variantRows[0] ?? null;
        if (!variant) throw new NotFoundError("资产版本不存在");
        assertUsableVariant(variant, entity.id);
      }

      let media: typeof assetMedia.$inferSelect | null = null;
      if (input.assetMediaId) {
        const mediaRows = await tx.select().from(assetMedia)
          .where(eq(assetMedia.id, input.assetMediaId)).limit(1);
        media = mediaRows[0] ?? null;
        if (!media) throw new NotFoundError("素材不存在");
        if (media.deletedAt) throw new ConflictError("素材已在回收站中", "asset_media_in_trash");

        if (media.assetEntityId && media.assetEntityId !== entity.id) {
          throw new ConflictError("素材不属于所选资产", "asset_media_mismatch");
        }
        if (media.assetVariantId) {
          if (variant && variant.id !== media.assetVariantId) {
            throw new ConflictError("素材不属于所选版本", "asset_media_variant_mismatch");
          }
          if (!variant) {
            const mediaVariantRows = await tx.select().from(assetVariants)
              .where(eq(assetVariants.id, media.assetVariantId)).limit(1);
            variant = mediaVariantRows[0] ?? null;
            if (!variant) throw new ConflictError("素材关联的资产版本不存在", "asset_media_variant_missing");
            assertUsableVariant(variant, entity.id);
          }
        }
        if (!media.assetEntityId && !media.assetVariantId) {
          throw new ConflictError("素材缺少可验证的归属信息，请联系管理员处理", "asset_media_unbound");
        }
      }

      const effectiveVariantId = variant?.id ?? null;
      const effectiveMediaId = media?.id ?? null;
      const sameNameRows = await tx.select({
        reference: projectAssetRefs,
        assetEntityId: assetEntities.id,
      }).from(projectAssetRefs)
        .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
        .where(and(
          eq(projectAssetRefs.projectId, projectId),
          isNull(projectAssetRefs.deletedAt),
          isNull(assetEntities.deletedAt),
          eq(assetEntities.assetKind, entity.assetKind),
          eq(assetEntities.name, entity.name),
        ))
        .for("update");
      const conflictingName = sameNameRows.find((row) => row.assetEntityId !== entity.id);
      if (conflictingName) {
        throw new ConflictError(
          `项目里已经有同类同名资产“${entity.name}”，请直接使用已有资产`,
          "project_asset_name_conflict",
          { asset_kind: entity.assetKind, name: entity.name },
        );
      }
      const existing = sameNameRows.find((row) => row.assetEntityId === entity.id)?.reference;
      if (existing) {
        assertSameLockedVersion(existing, effectiveVariantId, effectiveMediaId);
        return existing;
      }

      const now = new Date();
      const rows = await tx.insert(projectAssetRefs).values({
        id: crypto.randomUUID(),
        projectId,
        assetEntityId: entity.id,
        assetVariantId: effectiveVariantId,
        assetMediaId: effectiveMediaId,
        versionSnapshot: buildVersionSnapshot(now, entity, variant, media),
        createdByUserId: actorId,
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      }).onConflictDoNothing().returning();
      const created = rows[0];
      if (created) {
        // 采用次数是累计代理指标；只在首次建立活跃项目引用时 +1。
        // 删除引用不回减，幂等重放和并发冲突也不重复累加。
        await tx.update(assetEntities).set({
          useCount: sql`${assetEntities.useCount} + 1`,
        }).where(eq(assetEntities.id, entity.id));
        return created;
      }

      // A concurrent request may have inserted the same active reference.
      const concurrentRows = await tx.select().from(projectAssetRefs).where(and(
        eq(projectAssetRefs.projectId, projectId),
        eq(projectAssetRefs.assetEntityId, entity.id),
        isNull(projectAssetRefs.deletedAt),
      )).limit(1);
      const concurrent = concurrentRows[0];
      if (!concurrent) throw new Error("Failed to create project asset reference");
      assertSameLockedVersion(concurrent, effectiveVariantId, effectiveMediaId);
      return concurrent;
    });
  }

  async remove(
    actorId: string,
    projectId: string,
    referenceId: string,
    authorizedProjectId?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const projectRows = await tx.select().from(projects).where(and(
        eq(projects.id, projectId),
        isNull(projects.deletedAt),
      )).limit(1);
      const project = projectRows[0];
      if (!project) throw new NotFoundError("项目不存在");
      this.assertAuthorizedProject(project.ownerUserId, actorId, projectId, authorizedProjectId);

      const referenceRows = await tx.select().from(projectAssetRefs).where(and(
        eq(projectAssetRefs.id, referenceId),
        eq(projectAssetRefs.projectId, projectId),
        isNull(projectAssetRefs.deletedAt),
      )).limit(1);
      if (!referenceRows[0]) throw new NotFoundError("项目资产引用不存在");

      await tx.update(projectAssetRefs).set({
        deletedAt: new Date(),
        deletedByUserId: actorId,
      }).where(and(
        eq(projectAssetRefs.id, referenceId),
        eq(projectAssetRefs.projectId, projectId),
        isNull(projectAssetRefs.deletedAt),
      ));
    });
  }

  private async assertProjectAccess(
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): Promise<void> {
    const rows = await this.db.select({ ownerUserId: projects.ownerUserId }).from(projects).where(and(
      eq(projects.id, projectId),
      isNull(projects.deletedAt),
    )).limit(1);
    const project = rows[0];
    if (!project) throw new NotFoundError("项目不存在");
    this.assertAuthorizedProject(project.ownerUserId, actorId, projectId, authorizedProjectId);
  }

  private assertAuthorizedProject(
    ownerUserId: string,
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): void {
    if (authorizedProjectId !== undefined) {
      // A route capability must match exactly. Do not silently fall back to
      // ownership: that would turn a stale/wrong route scope into an access
      // bypass.
      if (authorizedProjectId !== projectId) {
        throw new NotFoundError("项目不存在或你没有访问权限");
      }
      return;
    }
    if (ownerUserId !== actorId) throw new ForbiddenError();
  }
}

export async function lockProjectAssetNamespace(db: Database, projectId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"project-assets:" + projectId}))`);
}

function assertUsableVariant(
  variant: typeof assetVariants.$inferSelect,
  entityId: string,
): void {
  if (variant.assetEntityId !== entityId) {
    throw new ConflictError("资产版本不属于所选资产", "asset_variant_mismatch");
  }
  if (variant.deletedAt) {
    throw new ConflictError("资产版本已在回收站中", "asset_variant_in_trash");
  }
}

function assertSameLockedVersion(
  reference: ProjectAssetReferenceRow,
  variantId: string | null,
  mediaId: string | null,
): void {
  if (reference.assetVariantId !== variantId || reference.assetMediaId !== mediaId) {
    throw new ConflictError(
      "项目已引用该资产的其他版本，请先移除原引用",
      "project_asset_version_conflict",
    );
  }
}

export function buildVersionSnapshot(
  capturedAt: Date,
  entity: typeof assetEntities.$inferSelect,
  variant: typeof assetVariants.$inferSelect | null,
  media: typeof assetMedia.$inferSelect | null,
): Record<string, unknown> {
  return {
    captured_at: capturedAt.toISOString(),
    entity: {
      id: entity.id,
      source_project_id: entity.sourceProjectId,
      source_project_name: entity.sourceProjectName,
      owner_user_id: entity.ownerUserId,
      visibility: entity.visibility,
      asset_kind: entity.assetKind,
      name: entity.name,
      display_name: entity.displayName,
      intro: entity.intro,
      appearance: entity.appearance,
      category: entity.category,
      style_tags: entity.styleTags,
      reuse_scope: entity.reuseScope,
      status: entity.status,
      source_file_url: entity.sourceFileUrl,
      metadata: entity.metadata,
      updated_at: entity.updatedAt.toISOString(),
    },
    variant: variant ? {
      id: variant.id,
      variant_kind: variant.variantKind,
      name: variant.name,
      description: variant.description,
      usage_context: variant.usageContext,
      visual_prompt: variant.visualPrompt,
      approved: variant.approved,
      status: variant.status,
      is_primary: variant.isPrimary,
      source_file_url: variant.sourceFileUrl,
      source_text: variant.sourceText,
      metadata: variant.metadata,
      updated_at: variant.updatedAt?.toISOString() ?? null,
    } : null,
    media: media ? {
      id: media.id,
      media_kind: media.mediaKind,
      view_angle: media.viewAngle,
      title: media.title,
      description: media.description,
      storage_bucket: media.storageBucket,
      storage_path: media.storagePath,
      storage_url: media.storageUrl,
      width_px: media.widthPx,
      height_px: media.heightPx,
      format: media.format,
      sha256: media.sha256,
      is_primary: media.isPrimary,
      approved: media.approved,
      metadata: media.metadata,
    } : null,
  };
}
