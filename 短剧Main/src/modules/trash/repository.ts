import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/client.js";
import {
  agentSessions,
  assetEntities,
  assetMedia,
  assetVariants,
  episodes,
  episodeScriptVersions,
  generationRequests,
  mediaResults,
  projectAssetRefs,
  projects,
  scenes,
  scriptBreakdownRuns,
  shots,
  storyboardImports,
  trashPurgeAttempts,
} from "../../db/schema.js";
import { buildAssetVectorDeletionIds } from "../../domain/assets/vectorKeys.js";
import { MilvusVectorStore } from "../../integrations/milvusVectorStore.js";
import { TosStorage } from "../../integrations/tosStorage.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type {
  TrashDeletionCheck,
  TrashItem,
  TrashItemKind,
  TrashRepository,
  TrashPurgeAttemptInput,
} from "./service.js";

const PURGE_PLAN_METADATA_KEY = "_trash_purge";

export interface TrashExternalCleaner {
  deleteStoragePath(storagePath: string): Promise<void>;
  deleteVectorIds(ids: string[]): Promise<void>;
}

export class DefaultTrashExternalCleaner implements TrashExternalCleaner {
  constructor(
    private readonly storage = new TosStorage(),
    private readonly vectors = new MilvusVectorStore(),
  ) {}

  deleteStoragePath(storagePath: string): Promise<void> {
    return this.storage.deleteObject(storagePath);
  }

  deleteVectorIds(ids: string[]): Promise<void> {
    return this.vectors.deleteByIds(ids);
  }
}

export class DrizzleTrashRepository implements TrashRepository {
  constructor(
    private readonly db: Database,
    private readonly cleaner: TrashExternalCleaner = new DefaultTrashExternalCleaner(),
  ) {}

  async list(actorId: string): Promise<TrashItem[]> {
    const [projectRows, assetRows] = await Promise.all([
      this.db.select({
        id: projects.id,
        name: projects.name,
        ownerUserId: projects.ownerUserId,
        deletedAt: projects.deletedAt,
      }).from(projects).where(and(eq(projects.ownerUserId, actorId), isNotNull(projects.deletedAt))),
      this.db.select({
        id: assetEntities.id,
        name: assetEntities.name,
        ownerUserId: assetEntities.ownerUserId,
        deletedAt: assetEntities.deletedAt,
      }).from(assetEntities).where(and(
        eq(assetEntities.ownerUserId, actorId),
        ne(assetEntities.visibility, "common"),
        isNotNull(assetEntities.deletedAt),
      )),
    ]);
    return [
      ...projectRows.flatMap((row): TrashItem[] => row.deletedAt ? [{
        id: row.id,
        kind: "project",
        ownerUserId: row.ownerUserId,
        name: row.name,
        deletedAt: row.deletedAt,
      }] : []),
      ...assetRows.flatMap((row): TrashItem[] => row.ownerUserId && row.deletedAt ? [{
        id: row.id,
        kind: "asset",
        ownerUserId: row.ownerUserId,
        name: row.name,
        deletedAt: row.deletedAt,
      }] : []),
    ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
  }

  async retentionCandidates(cutoff: Date, after?: Pick<TrashItem, "deletedAt" | "id" | "kind">, limit = 50): Promise<TrashItem[]> {
    const projectCursor = after ? sql`and (deleted_at, id, 'project'::text) > (${after.deletedAt}, ${after.id}::uuid, ${after.kind})` : sql``;
    const assetCursor = after ? sql`and (deleted_at, id, 'asset'::text) > (${after.deletedAt}, ${after.id}::uuid, ${after.kind})` : sql``;
    const result = await this.db.execute(sql`
      select id, name, owner_user_id, deleted_at, 'project'::text as kind from ${projects}
      where deleted_at is not null and deleted_at <= ${cutoff} ${projectCursor}
      union all
      select id, name, owner_user_id, deleted_at, 'asset'::text as kind from ${assetEntities}
      where deleted_at is not null and deleted_at <= ${cutoff} and visibility <> 'common' and owner_user_id is not null ${assetCursor}
      order by deleted_at asc, id asc, kind asc limit ${limit}
    `);
    return (result.rows as Array<{ id: string; name: string; owner_user_id: string; deleted_at: Date; kind: "project" | "asset" }>)
      .map((row) => ({ id: row.id, name: row.name, ownerUserId: row.owner_user_id, deletedAt: new Date(row.deleted_at), kind: row.kind }));
  }

  async tryAcquireRetentionLock(): Promise<boolean> {
    const result = await this.db.execute(sql`select pg_try_advisory_lock(hashtext('trash-retention-worker')) as locked`);
    return Boolean((result.rows[0] as { locked?: boolean } | undefined)?.locked);
  }

  async releaseRetentionLock(): Promise<void> {
    await this.db.execute(sql`select pg_advisory_unlock(hashtext('trash-retention-worker'))`);
  }

  async beginPurgeAttempt(input: TrashPurgeAttemptInput): Promise<string> {
    const id = randomUUID();
    await this.db.insert(trashPurgeAttempts).values({
      id, source: input.source, targetKind: input.targetKind, targetId: input.targetId,
      ownerUserId: input.ownerUserId, actorUserId: input.actorUserId,
      status: "started", retentionDays: input.retentionDays, deletedAtSnapshot: input.deletedAtSnapshot,
      blockers: [], errorCode: null, startedAt: new Date(), completedAt: null,
    });
    return id;
  }

  async completePurgeAttempt(id: string, input: { status: "blocked" | "failed" | "deleted"; blockers?: string[]; errorCode?: string }): Promise<void> {
    if (!id) return;
    await this.db.update(trashPurgeAttempts).set({ status: input.status, blockers: input.blockers ?? [], errorCode: input.errorCode ?? null, completedAt: new Date() })
      .where(eq(trashPurgeAttempts.id, id));
  }

  async get(kind: TrashItemKind, id: string): Promise<TrashItem | undefined> {
    assertSupportedKind(kind);
    if (kind === "project") {
      const [row] = await this.db.select({
        id: projects.id,
        name: projects.name,
        ownerUserId: projects.ownerUserId,
        deletedAt: projects.deletedAt,
      }).from(projects).where(and(eq(projects.id, id), isNotNull(projects.deletedAt))).limit(1);
      return row?.deletedAt ? {
        id: row.id,
        kind,
        ownerUserId: row.ownerUserId,
        name: row.name,
        deletedAt: row.deletedAt,
      } : undefined;
    }
    const [row] = await this.db.select({
      id: assetEntities.id,
      name: assetEntities.name,
      ownerUserId: assetEntities.ownerUserId,
      deletedAt: assetEntities.deletedAt,
      visibility: assetEntities.visibility,
      status: assetEntities.status,
    }).from(assetEntities).where(and(eq(assetEntities.id, id), isNotNull(assetEntities.deletedAt))).limit(1);
    if (!row?.ownerUserId || !row.deletedAt || row.visibility === "common") return undefined;
    return { id: row.id, kind, ownerUserId: row.ownerUserId, name: row.name, deletedAt: row.deletedAt };
  }

  async restore(kind: TrashItemKind, id: string, actorId: string): Promise<TrashItem> {
    assertSupportedKind(kind);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`trash:${kind}:${id}`}))`);
      const table = kind === "project" ? projects : assetEntities;
      await tx.execute(sql`select id from ${table} where id = ${id} for update`);
      if (kind === "project") {
        const [current] = await tx.select({ name: projects.name, ownerUserId: projects.ownerUserId, deletedAt: projects.deletedAt })
          .from(projects).where(eq(projects.id, id)).limit(1);
        if (!current?.deletedAt || current.ownerUserId !== actorId) throw new NotFoundError("回收站项目不存在");
        const imports = await tx.select({ confirmationResult: storyboardImports.confirmationResult }).from(storyboardImports).where(eq(storyboardImports.projectId, id));
        if (imports.some((row) => purgeStoragePath(row.confirmationResult ?? {}))) throw new ConflictError("项目已开始清理外部对象，只能重试永久删除", "project_purge_in_progress");
        const [duplicate] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.ownerUserId, actorId), isNull(projects.deletedAt), sql`lower(${projects.name}) = lower(${current.name})`)).limit(1);
        if (duplicate) throw new ConflictError("已有同名项目，请先改名后再恢复", "restore_name_conflict");
        const [restored] = await tx.update(projects).set({ deletedAt: null, deletedByUserId: null, updatedAt: new Date() })
          .where(and(eq(projects.id, id), eq(projects.ownerUserId, actorId), isNotNull(projects.deletedAt))).returning();
        if (!restored) throw new NotFoundError("回收站项目不存在");
        return { id, kind, ownerUserId: restored.ownerUserId, name: restored.name, deletedAt: current.deletedAt };
      }
      const [current] = await tx.select({ name: assetEntities.name, ownerUserId: assetEntities.ownerUserId, deletedAt: assetEntities.deletedAt, status: assetEntities.status })
        .from(assetEntities).where(eq(assetEntities.id, id)).limit(1);
      if (!current?.deletedAt || !current.ownerUserId || current.ownerUserId !== actorId) throw new NotFoundError("回收站项目不存在");
      if (current.status === "purging") throw new ConflictError("资产已开始清理外部对象，只能重试永久删除", "asset_purge_in_progress");
      const [duplicate] = await tx.select({ id: assetEntities.id }).from(assetEntities).where(and(eq(assetEntities.ownerUserId, actorId), isNull(assetEntities.deletedAt), sql`lower(${assetEntities.name}) = lower(${current.name})`)).limit(1);
      if (duplicate) throw new ConflictError("已有同名个人资产，请先改名后再恢复", "restore_name_conflict");
      const [restored] = await tx.update(assetEntities).set({ deletedAt: null, deletedByUserId: null, updatedAt: new Date() })
        .where(and(eq(assetEntities.id, id), eq(assetEntities.ownerUserId, actorId), ne(assetEntities.visibility, "common"), ne(assetEntities.status, "purging"), isNotNull(assetEntities.deletedAt))).returning();
      if (!restored || !restored.ownerUserId) throw new NotFoundError("回收站项目不存在");
      return { id, kind, ownerUserId: restored.ownerUserId, name: restored.name, deletedAt: current.deletedAt };
    });
  }

  async checkPermanentDeletion(kind: TrashItemKind, id: string): Promise<TrashDeletionCheck> {
    assertSupportedKind(kind);
    if (kind === "project") return this.checkProjectDeletion(id);
    return this.checkAssetDeletion(id);
  }

  async preparePermanentDeletion(
    kind: TrashItemKind,
    id: string,
    _actorId: string,
    retention?: { cutoff: Date; expectedDeletedAt: Date; expectedOwnerUserId: string },
  ): Promise<TrashDeletionCheck> {
    assertSupportedKind(kind);
    if (kind === "project") return this.prepareProjectPermanentDeletion(id, retention);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`trash:asset:${id}`}))`);
      await tx.execute(sql`select id from ${assetEntities} where id = ${id} for update`);
      const check = await checkAssetDeletionWith(tx as Database, id);
      if (check.blockers.length) return check;
      if (retention) {
        const [current] = await tx.select({ deletedAt: assetEntities.deletedAt, ownerUserId: assetEntities.ownerUserId })
          .from(assetEntities).where(eq(assetEntities.id, id)).limit(1);
        if (!current?.deletedAt || current.ownerUserId !== retention.expectedOwnerUserId
          || current.deletedAt.getTime() !== retention.expectedDeletedAt.getTime() || current.deletedAt > retention.cutoff) {
          return { blockers: ["资产回收站状态已变化"] };
        }
      }
      const [row] = await tx.select({
        status: assetEntities.status,
        metadata: assetEntities.metadata,
      }).from(assetEntities).where(eq(assetEntities.id, id)).limit(1);
      if (!row) return { blockers: ["资产不存在"] };
      const variantRows = await tx.select({ id: assetVariants.id }).from(assetVariants)
        .where(eq(assetVariants.assetEntityId, id));
      const mediaCondition = assetMediaOwnershipCondition(id, variantRows.map((variant) => variant.id));
      const mediaRows = await tx.select({
        id: assetMedia.id,
        storagePath: assetMedia.storagePath,
        metadata: assetMedia.metadata,
      }).from(assetMedia).where(mediaCondition);

      // Detach the rows in PostgreSQL before any irreversible object delete.
      // The old path is retained on the already-deleted/purging row so a
      // failed cleanup can be retried without a new table or migration.
      for (const media of mediaRows) {
        if (!media.storagePath) continue;
        await tx.update(assetMedia).set({
          storageBucket: null,
          storagePath: null,
          storageUrl: null,
          metadata: withPurgeStoragePath(media.metadata, media.storagePath),
        }).where(eq(assetMedia.id, media.id));
      }

      await tx.update(assetEntities).set({
        status: "purging",
        metadata: {
          ...row.metadata,
          purge_state: "external_cleanup_pending",
          purge_started_at: typeof row.metadata.purge_started_at === "string"
            ? row.metadata.purge_started_at
            : new Date().toISOString(),
          purge_previous_status: typeof row.metadata.purge_previous_status === "string"
            ? row.metadata.purge_previous_status
            : row.status,
        },
        updatedAt: new Date(),
      }).where(eq(assetEntities.id, id));
      return check;
    });
  }

  async deleteExternalObjects(kind: TrashItemKind, id: string): Promise<void> {
    assertSupportedKind(kind);
    const cleanup = kind === "project"
      ? await this.projectExternalCleanupPlan(id)
      : await this.assetExternalCleanupPlan(id);

    for (const path of cleanup.storagePaths) {
      // This check intentionally spans every PostgreSQL column that can hold a
      // TOS object key. A soft-deleted row still counts because it can be
      // restored later.
      if (!await storagePathIsReferenced(this.db, path)) {
        await this.cleaner.deleteStoragePath(path);
      }
    }
    if (cleanup.vectorIds.length) await this.cleaner.deleteVectorIds(cleanup.vectorIds);
  }

  async hardDelete(kind: TrashItemKind, id: string, attemptId?: string): Promise<void> {
    assertSupportedKind(kind);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`trash:${kind}:${id}`}))`);
      const check = kind === "project"
        ? await checkProjectDeletionWith(tx as Database, id)
        : await checkAssetDeletionWith(tx as Database, id);
      if (check.blockers.length) {
        throw new ConflictError(`暂时不能永久删除：${check.blockers.join("；")}`, "trash_item_referenced");
      }
      if (kind === "asset") {
        const [asset] = await tx.select({ status: assetEntities.status }).from(assetEntities)
          .where(eq(assetEntities.id, id)).limit(1);
        if (asset?.status !== "purging") {
          throw new ConflictError("这项资产还不能彻底删除，请稍后再试。", "asset_purge_not_prepared");
        }
        const variantRows = await tx.select({ id: assetVariants.id }).from(assetVariants)
          .where(eq(assetVariants.assetEntityId, id));
        await tx.delete(projectAssetRefs).where(and(
          eq(projectAssetRefs.assetEntityId, id),
          isNotNull(projectAssetRefs.deletedAt),
        ));
        await tx.delete(assetMedia).where(assetMediaOwnershipCondition(
          id,
          variantRows.map((variant) => variant.id),
        ));
        await tx.delete(assetVariants).where(eq(assetVariants.assetEntityId, id));
        const deleted = await tx.delete(assetEntities).where(and(eq(assetEntities.id, id), isNotNull(assetEntities.deletedAt))).returning({ id: assetEntities.id });
        if (!deleted.length) throw new NotFoundError("回收站资产不存在");
        await markAttemptDeleted(tx as Database, attemptId);
        return;
      }

      const unpreparedImports = await tx.select({ id: storyboardImports.id }).from(storyboardImports)
        .where(and(
          eq(storyboardImports.projectId, id),
          isNotNull(storyboardImports.sourceStoragePath),
        )).limit(1);
      if (unpreparedImports.length) {
        throw new ConflictError("这个项目还不能彻底删除，请稍后再试。", "project_purge_not_prepared");
      }
      const episodeRows = await tx.select({ id: episodes.id }).from(episodes).where(eq(episodes.projectId, id));
      const episodeIds = episodeRows.map((row) => row.id);
      const shotRows = episodeIds.length
        ? await tx.select({ id: shots.id }).from(shots).where(inArray(shots.episodeId, episodeIds))
        : [];
      const shotIds = shotRows.map((row) => row.id);
      await tx.delete(agentSessions).where(or(
        eq(agentSessions.projectId, id),
        ...(shotIds.length ? [inArray(agentSessions.shotId, shotIds)] : []),
      ));
      await tx.delete(projectAssetRefs).where(eq(projectAssetRefs.projectId, id));
      await tx.delete(storyboardImports).where(eq(storyboardImports.projectId, id));
      if (episodeIds.length) {
        await tx.delete(shots).where(inArray(shots.episodeId, episodeIds));
        await tx.delete(scenes).where(inArray(scenes.episodeId, episodeIds));
        await tx.delete(scriptBreakdownRuns).where(inArray(scriptBreakdownRuns.episodeId, episodeIds));
        await tx.delete(episodeScriptVersions).where(inArray(episodeScriptVersions.episodeId, episodeIds));
        await tx.delete(episodes).where(inArray(episodes.id, episodeIds));
      }
      const deleted = await tx.delete(projects).where(and(eq(projects.id, id), isNotNull(projects.deletedAt))).returning({ id: projects.id });
      if (!deleted.length) throw new NotFoundError("回收站项目不存在");
      await markAttemptDeleted(tx as Database, attemptId);
    });
  }

  private checkProjectDeletion(id: string) {
    return checkProjectDeletionWith(this.db, id);
  }

  private checkAssetDeletion(id: string) {
    return checkAssetDeletionWith(this.db, id);
  }

  private async prepareProjectPermanentDeletion(id: string, retention?: { cutoff: Date; expectedDeletedAt: Date; expectedOwnerUserId: string }): Promise<TrashDeletionCheck> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`trash:project:${id}`}))`);
      await tx.execute(sql`select id from ${projects} where id = ${id} for update`);
      const check = await checkProjectDeletionWith(tx as Database, id);
      if (check.blockers.length) return check;
      if (retention) {
        const [current] = await tx.select({ deletedAt: projects.deletedAt, ownerUserId: projects.ownerUserId })
          .from(projects).where(eq(projects.id, id)).limit(1);
        if (!current?.deletedAt || current.ownerUserId !== retention.expectedOwnerUserId
          || current.deletedAt.getTime() !== retention.expectedDeletedAt.getTime() || current.deletedAt > retention.cutoff) {
          return { blockers: ["项目回收站状态已变化"] };
        }
      }

      const imports = await tx.select({
        id: storyboardImports.id,
        sourceStoragePath: storyboardImports.sourceStoragePath,
        confirmationResult: storyboardImports.confirmationResult,
      }).from(storyboardImports).where(eq(storyboardImports.projectId, id));
      for (const importRow of imports) {
        if (!importRow.sourceStoragePath) continue;
        await tx.update(storyboardImports).set({
          sourceStoragePath: null,
          confirmationResult: withPurgeStoragePath(
            importRow.confirmationResult ?? {},
            importRow.sourceStoragePath,
          ),
          updatedAt: new Date(),
        }).where(eq(storyboardImports.id, importRow.id));
      }
      return check;
    });
  }

  private async assetExternalCleanupPlan(id: string): Promise<ExternalCleanupPlan> {
    const variants = await this.db.select({ id: assetVariants.id }).from(assetVariants)
      .where(eq(assetVariants.assetEntityId, id));
    const mediaRows = await this.db.select({ metadata: assetMedia.metadata }).from(assetMedia)
      .where(assetMediaOwnershipCondition(id, variants.map((variant) => variant.id)));
    return {
      storagePaths: uniqueStrings(mediaRows.map((row) => purgeStoragePath(row.metadata))),
      vectorIds: uniqueStrings([
        ...buildAssetVectorDeletionIds("asset_entities", id),
        ...variants.flatMap((variant) => buildAssetVectorDeletionIds("asset_variants", variant.id)),
      ]),
    };
  }

  private async projectExternalCleanupPlan(id: string): Promise<ExternalCleanupPlan> {
    const imports = await this.db.select({
      confirmationResult: storyboardImports.confirmationResult,
    }).from(storyboardImports).where(eq(storyboardImports.projectId, id));
    return {
      storagePaths: uniqueStrings(imports.map((row) => purgeStoragePath(row.confirmationResult ?? {}))),
      vectorIds: [],
    };
  }
}

async function markAttemptDeleted(db: Database, attemptId: string | undefined): Promise<void> {
  if (!attemptId) return;
  await db.update(trashPurgeAttempts).set({ status: "deleted", blockers: [], errorCode: null, completedAt: new Date() })
    .where(eq(trashPurgeAttempts.id, attemptId));
}

async function checkProjectDeletionWith(db: Database, id: string): Promise<TrashDeletionCheck> {
  // This helper also runs inside a transaction, where one PostgreSQL client
  // must not execute concurrent queries.
  const requests = await db.select({ id: generationRequests.id }).from(generationRequests)
    .where(eq(generationRequests.projectId, id)).limit(1);
  const project = await db.select({ id: projects.id, deletedAt: projects.deletedAt }).from(projects)
    .where(eq(projects.id, id)).limit(1);
  const blockers: string[] = [];
  if (!project[0]?.deletedAt) blockers.push("项目不在回收站中");
  if (requests.length) blockers.push("项目存在生成和费用历史");
  return { blockers };
}

async function checkAssetDeletionWith(db: Database, id: string): Promise<TrashDeletionCheck> {
  // Keep these sequential because this helper is reused inside a transaction.
  const refs = await db.select({ id: projectAssetRefs.id }).from(projectAssetRefs)
    .where(and(eq(projectAssetRefs.assetEntityId, id), isNull(projectAssetRefs.deletedAt))).limit(1);
  const requests = await db.select({
    id: generationRequests.id,
    targetAssetEntityId: generationRequests.targetAssetEntityId,
    referenceMediaIds: generationRequests.referenceMediaIds,
    referenceAssetSnapshots: generationRequests.referenceAssetSnapshots,
  }).from(generationRequests);
  const variantRows = await db.select({ id: assetVariants.id }).from(assetVariants)
    .where(eq(assetVariants.assetEntityId, id));
  const mediaRows = await db.select({ id: assetMedia.id }).from(assetMedia)
    .where(assetMediaOwnershipCondition(id, variantRows.map((variant) => variant.id)));
  const registeredResults = mediaRows.length
    ? await db.select({ id: mediaResults.id }).from(mediaResults)
      .where(inArray(mediaResults.sourceAssetMediaId, mediaRows.map((row) => row.id))).limit(1)
    : [];
  const asset = await db.select({ id: assetEntities.id, deletedAt: assetEntities.deletedAt, visibility: assetEntities.visibility })
    .from(assetEntities).where(eq(assetEntities.id, id)).limit(1);
  const mediaIds = new Set(mediaRows.map((row) => row.id));
  const relatedRequest = requests.some((request) => request.targetAssetEntityId === id
    || request.referenceMediaIds.some((mediaId) => mediaIds.has(mediaId))
    || JSON.stringify(request.referenceAssetSnapshots).includes(id));
  const blockers: string[] = [];
  if (!asset[0]?.deletedAt) blockers.push("资产不在回收站中");
  if (asset[0]?.visibility === "common") blockers.push("通用资产不能在个人回收站永久删除");
  if (refs.length) blockers.push("资产存在项目引用记录");
  if (relatedRequest) blockers.push("资产存在生成或费用历史");
  if (registeredResults.length) blockers.push("资产媒体已登记为项目分镜结果");
  return { blockers };
}

interface ExternalCleanupPlan {
  storagePaths: string[];
  vectorIds: string[];
}

function assetMediaOwnershipCondition(assetEntityId: string, variantIds: string[]) {
  return variantIds.length
    ? or(
      eq(assetMedia.assetEntityId, assetEntityId),
      inArray(assetMedia.assetVariantId, variantIds),
    )
    : eq(assetMedia.assetEntityId, assetEntityId);
}

function withPurgeStoragePath(
  metadata: Record<string, unknown>,
  storagePath: string,
): Record<string, unknown> {
  return {
    ...metadata,
    [PURGE_PLAN_METADATA_KEY]: { storage_path: storagePath },
  };
}

function purgeStoragePath(metadata: Record<string, unknown>): string | null {
  const plan = metadata[PURGE_PLAN_METADATA_KEY];
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return null;
  const storagePath = (plan as Record<string, unknown>).storage_path;
  return typeof storagePath === "string" && storagePath.trim() ? storagePath.trim() : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function storagePathIsReferenced(db: Database, storagePath: string): Promise<boolean> {
  const assetReference = await db.select({ id: assetMedia.id }).from(assetMedia)
    .where(eq(assetMedia.storagePath, storagePath)).limit(1);
  if (assetReference.length) return true;
  const resultReference = await db.select({ id: mediaResults.id }).from(mediaResults)
    .where(eq(mediaResults.storagePath, storagePath)).limit(1);
  if (resultReference.length) return true;
  const importReference = await db.select({ id: storyboardImports.id }).from(storyboardImports)
    .where(eq(storyboardImports.sourceStoragePath, storagePath)).limit(1);
  return importReference.length > 0;
}

function assertSupportedKind(kind: TrashItemKind): asserts kind is "project" | "asset" {
  if (kind !== "project" && kind !== "asset") {
    throw new ConflictError("回收站目前只支持项目和个人资产。", "trash_kind_not_supported");
  }
}
