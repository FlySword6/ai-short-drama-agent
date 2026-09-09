import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetMediaRenditions,
  assetMediaRepairActions,
  assetMediaRepairBlockers,
  assetMediaRepairTasks,
  assetVariants,
} from "../../db/schema.js";
import {
  ConflictError,
  ForbiddenError,
  isPostgresUniqueViolation,
  NotFoundError,
} from "../../shared/errors.js";
import { canViewAsset, type AssetAccessRecord } from "./access.js";
import { assetImageMediaKindSql } from "./assetImageKinds.js";
import {
  approvedAssetMediaOwnershipSql,
  assetMediaOwnerIdSql,
} from "./assetMediaVisibility.js";
import type {
  AssetMediaRepairActionInput,
  AssetMediaRepairActionMutation,
  AssetMediaRepairRepositoryPort,
  AssetMediaRepairRenditionUpsert,
  AssetMediaRepairActor,
  AssetRepairBundle,
  AssetRepairMediaSnapshot,
  ClaimedAssetMediaRepairTask,
} from "./mediaRepairTypes.js";

const activeTaskStatuses = ["queued", "processing"] as const;
const CLAIM_LEASE_MS = 5 * 60_000;

export class PostgresAssetMediaRepairRepository implements AssetMediaRepairRepositoryPort {
  constructor(private readonly db: Database) {}

  async loadVisibleBundle(actor: AssetMediaRepairActor, assetId: string): Promise<AssetRepairBundle> {
    const asset = await this.asset(assetId);
    if (!canViewAsset(accessRecord(asset), actor.id, false, actor.role === "admin")) {
      throw new ForbiddenError("无权查看该资产");
    }
    return this.loadBundle(asset);
  }

  async loadRepairBundle(assetId: string): Promise<AssetRepairBundle> {
    return this.loadBundle(await this.asset(assetId));
  }

  async requireRepairPermission(actor: AssetMediaRepairActor, assetId: string): Promise<void> {
    const asset = await this.asset(assetId);
    if (asset.visibility === "common") {
      if (actor.role !== "admin") {
        throw new ForbiddenError("只有管理员可以修复通用资产");
      }
      return;
    }
    if (asset.visibility !== "personal" || asset.ownerUserId !== actor.id) {
      throw new ForbiddenError("无权修复该资产");
    }
  }

  async requireVisibleMedia(
    actor: AssetMediaRepairActor,
    assetId: string,
    mediaId: string,
  ): Promise<AssetRepairMediaSnapshot> {
    const bundle = await this.loadVisibleBundle(actor, assetId);
    const media = bundle.media.find((item) => item.id === mediaId && !item.deletedAt);
    if (!media || !isLegalBundleMediaForAsset(bundle, media)) {
      throw new NotFoundError("资产媒体不存在或不可下载");
    }
    return media;
  }

  async createOrReuseTask(input: {
    assetId: string;
    requestedByUserId: string;
    clientIdempotencyKey: string;
    requestHash: string;
    mode: "safe";
    trigger: "manual" | "self_heal" | "batch";
    mediaIds: string[] | null;
    diagnosis: Record<string, unknown>;
  }): Promise<{ task: ClaimedAssetMediaRepairTask; created: boolean }> {
    const now = new Date();
    try {
      const row = (await this.db.insert(assetMediaRepairTasks).values({
        id: randomUUID(),
        assetEntityId: input.assetId,
        requestedByUserId: input.requestedByUserId,
        clientIdempotencyKey: input.clientIdempotencyKey,
        requestHash: input.requestHash,
        mode: input.mode,
        trigger: input.trigger,
        mediaIds: input.mediaIds ?? [],
        status: "queued",
        diagnosis: input.diagnosis,
        result: {},
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      }).returning())[0];
      if (!row) throw new Error("资产媒体修复任务写入后未能读取");
      return { task: taskView(row), created: true };
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) throw error;
      const byKey = (await this.db.select().from(assetMediaRepairTasks).where(and(
        eq(assetMediaRepairTasks.requestedByUserId, input.requestedByUserId),
        eq(assetMediaRepairTasks.clientIdempotencyKey, input.clientIdempotencyKey),
      )).limit(1))[0];
      if (byKey) {
        if (byKey.assetEntityId !== input.assetId || byKey.requestHash !== input.requestHash) {
          throw new ConflictError(
            "这个提交标识已经用于另一份修复请求，请重新提交",
            "idempotency_key_conflict",
          );
        }
        return { task: taskView(byKey), created: false };
      }
      throw new ConflictError(
        "这件资产已有修复任务在进行，请等待完成后再提交",
        "asset_media_repair_in_progress",
      );
    }
  }

  async getTaskForActor(
    actor: AssetMediaRepairActor,
    assetId: string,
    taskId: string,
  ): Promise<ClaimedAssetMediaRepairTask | null> {
    const bundle = await this.loadVisibleBundle(actor, assetId);
    const row = (await this.db.select().from(assetMediaRepairTasks).where(and(
      eq(assetMediaRepairTasks.id, taskId),
      eq(assetMediaRepairTasks.assetEntityId, bundle.asset.id),
    )).limit(1))[0];
    if (!row) return null;
    if (bundle.asset.visibility === "common" && actor.role !== "admin" && row.requestedByUserId !== actor.id) {
      return null;
    }
    return taskView(row);
  }

  async claimNextQueued(): Promise<ClaimedAssetMediaRepairTask | null> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const row = (await transaction.select().from(assetMediaRepairTasks)
        .where(or(
          eq(assetMediaRepairTasks.status, "queued"),
          and(
            eq(assetMediaRepairTasks.status, "processing"),
            sql`${assetMediaRepairTasks.leaseExpiresAt} < ${now}`,
          ),
        ))
        .orderBy(asc(assetMediaRepairTasks.createdAt), asc(assetMediaRepairTasks.id))
        .limit(1)
        .for("update", { skipLocked: true }))[0];
      if (!row) return null;
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
      const updated = (await transaction.update(assetMediaRepairTasks).set({
        status: "processing",
        startedAt: now,
        claimToken,
        leaseExpiresAt,
        updatedAt: now,
      }).where(and(
        eq(assetMediaRepairTasks.id, row.id),
        or(
          eq(assetMediaRepairTasks.status, "queued"),
          and(
            eq(assetMediaRepairTasks.status, "processing"),
            sql`${assetMediaRepairTasks.leaseExpiresAt} < ${now}`,
          ),
        ),
      )).returning())[0];
      if (!updated) return null;
      return taskView(updated);
    });
  }

  async requeueInterrupted(): Promise<number> {
    const rows = await this.db.update(assetMediaRepairTasks).set({
      status: "queued",
      startedAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(assetMediaRepairTasks.status, "processing"),
      sql`${assetMediaRepairTasks.leaseExpiresAt} < now()`,
    )).returning({ id: assetMediaRepairTasks.id });
    return rows.length;
  }

  async enqueueSelfHealCandidates(limit: number): Promise<number> {
    const rows = await this.db.select({ id: assetEntities.id }).from(assetEntities).where(and(
      isNull(assetEntities.deletedAt),
      sql`exists (
        select 1
        from ${assetMedia} candidate
        left join ${assetVariants} variant
          on variant.id = candidate.asset_variant_id
          and variant.deleted_at is null
        where candidate.deleted_at is null
          and ${approvedAssetMediaOwnershipSql({
            mediaEntityId: sql`candidate.asset_entity_id`,
            mediaVariantId: sql`candidate.asset_variant_id`,
            mediaApproved: sql`candidate.approved`,
            variantId: sql`variant.id`,
            variantEntityId: sql`variant.asset_entity_id`,
          })}
          and ${assetMediaOwnerIdSql(
            sql`candidate.asset_entity_id`,
            sql`candidate.asset_variant_id`,
            sql`variant.asset_entity_id`,
          )} = ${assetEntities.id}
          and ${assetImageMediaKindSql(sql`candidate.media_kind`)}
          and candidate.storage_bucket is not null
          and candidate.storage_path is not null
          and (
            candidate.width_px is null
            or candidate.height_px is null
            or candidate.format is null
            or candidate.sha256 is null
            or (
              select count(*)
              from ${assetMediaRenditions} rendition
              where rendition.asset_media_id = candidate.id
                and rendition.rendition_kind in ('thumbnail', 'detail')
                and rendition.status = 'healthy'
                and rendition.strategy = 'stored_object'
                and rendition.storage_bucket is not null
                and rendition.storage_path ~ '^asset-renditions/v1/[0-9a-f]{2}/[0-9a-f]{64}[.]webp$'
                and rendition.storage_url is null
                and rendition.source_sha256 = candidate.sha256
                and rendition.checked_at is not null
                and lower(rendition.format) = 'webp'
                and rendition.sha256 ~ '^[0-9a-f]{64}$'
                and (
                  (rendition.rendition_kind = 'thumbnail'
                    and rendition.width_px = 320 and rendition.height_px = 180)
                  or
                  (rendition.rendition_kind = 'detail'
                    and rendition.width_px between 1 and 1280
                    and rendition.height_px between 1 and 720)
                )
            ) < 2
          )
      )`,
      sql`not exists (
        select 1
        from ${assetMediaRepairTasks} active_task
        where active_task.asset_entity_id = ${assetEntities.id}
          and active_task.status in ('queued', 'processing')
      )`,
      sql`not exists (
        select 1
        from ${assetMediaRepairBlockers} blocker
        where blocker.asset_entity_id = ${assetEntities.id}
          and blocker.retry_after > now()
          and blocker.state_fingerprint = md5(concat_ws(':',
            ${assetEntities.updatedAt}::text,
            coalesce((
              select string_agg(concat_ws('|', candidate.id::text, candidate.created_at::text,
                candidate.deleted_at::text, candidate.storage_bucket, candidate.storage_path,
                candidate.width_px::text, candidate.height_px::text, candidate.format, candidate.sha256,
                candidate.metadata::text),
                ',' order by candidate.id)
              from ${assetMedia} candidate
              where candidate.asset_entity_id = ${assetEntities.id}
                or exists (
                  select 1 from ${assetVariants} variant
                  where variant.id = candidate.asset_variant_id
                    and variant.asset_entity_id = ${assetEntities.id}
                )
            ), '')
          ))
      )`,
    )).orderBy(asc(assetEntities.updatedAt), asc(assetEntities.id)).limit(limit);

    let enqueued = 0;
    for (const row of rows) {
      const now = new Date();
      try {
        await this.db.insert(assetMediaRepairTasks).values({
          id: randomUUID(),
          assetEntityId: row.id,
          requestedByUserId: null,
          clientIdempotencyKey: null,
          requestHash: selfHealRequestHash(row.id),
          mode: "safe",
          trigger: "self_heal",
          mediaIds: [],
          status: "queued",
          claimToken: null,
          leaseExpiresAt: null,
          diagnosis: { source: "bounded_self_heal_scan", version: 1 },
          result: {},
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
        });
        enqueued += 1;
      } catch (error) {
        if (!isPostgresUniqueViolation(error)) throw error;
      }
    }
    return enqueued;
  }

  async updateMediaFactsAndAppendAction(
    taskId: string,
    claimToken: string,
    mediaId: string,
    patch: {
      widthPx: number;
      heightPx: number;
      format: string;
      sha256: string;
      metadata: Record<string, unknown>;
    },
    action: AssetMediaRepairActionMutation,
  ): Promise<void> {
    if (action.assetMediaId !== mediaId || action.action !== "refresh_metadata") {
      throw new Error("媒体事实与审计动作不匹配");
    }
    await this.withOwnedClaim(taskId, claimToken, async (transaction) => {
      const updated = await transaction.update(assetMedia).set(patch).where(and(
        eq(assetMedia.id, mediaId),
        isNull(assetMedia.deletedAt),
      )).returning({ id: assetMedia.id });
      if (updated.length !== 1) throw new Error("待修媒体不存在或已删除");
      await this.insertAction(transaction, taskId, action);
    });
  }

  async upsertRenditionsAndAppendAction(
    taskId: string,
    claimToken: string,
    inputs: readonly AssetMediaRepairRenditionUpsert[],
    action: AssetMediaRepairActionMutation,
  ): Promise<void> {
    if (
      inputs.length === 0
      || inputs.some((input) => input.assetMediaId !== action.assetMediaId)
    ) {
      throw new Error("展示变体事实与审计动作不匹配");
    }
    await this.withOwnedClaim(taskId, claimToken, async (transaction) => {
      const now = new Date();
      for (const input of inputs) {
        await transaction.insert(assetMediaRenditions).values({
          id: randomUUID(),
          ...input,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [assetMediaRenditions.assetMediaId, assetMediaRenditions.renditionKind],
          set: {
            strategy: input.strategy,
            status: input.status,
            processSpec: input.processSpec,
            storageBucket: input.storageBucket,
            storagePath: input.storagePath,
            storageUrl: input.storageUrl,
            sourceSha256: input.sourceSha256,
            widthPx: input.widthPx,
            heightPx: input.heightPx,
            format: input.format,
            sha256: input.sha256,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            checkedAt: input.checkedAt,
            updatedAt: now,
          },
        });
      }
      await this.insertAction(transaction, taskId, action, now);
    });
  }

  async appendAction(input: AssetMediaRepairActionInput): Promise<void> {
    await this.withOwnedClaim(input.taskId, input.claimToken, async (transaction) => {
      const { taskId, claimToken: _claimToken, ...action } = input;
      await this.insertAction(transaction, taskId, action);
    });
  }

  async completeTask(
    taskId: string,
    claimToken: string,
    input: {
      status: "succeeded" | "partial" | "failed";
      diagnosis: Record<string, unknown>;
      result: Record<string, unknown>;
      errorCode: string | null;
      errorMessage: string | null;
      finishedAt: Date;
    },
  ): Promise<void> {
    await this.finishOwnedClaim(taskId, claimToken, {
      ...input,
      updatedAt: input.finishedAt,
    });
  }

  async failTask(
    taskId: string,
    claimToken: string,
    input: { errorCode: string; errorMessage: string; finishedAt: Date },
  ): Promise<void> {
    await this.finishOwnedClaim(taskId, claimToken, {
      status: "failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    });
  }

  async heartbeatClaim(taskId: string, claimToken: string): Promise<boolean> {
    const now = new Date();
    const rows = await this.db.update(assetMediaRepairTasks).set({
      leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      updatedAt: now,
    }).where(and(
      eq(assetMediaRepairTasks.id, taskId),
      eq(assetMediaRepairTasks.status, "processing"),
      eq(assetMediaRepairTasks.claimToken, claimToken),
      sql`${assetMediaRepairTasks.leaseExpiresAt} > ${now}`,
    )).returning({ id: assetMediaRepairTasks.id });
    return rows.length === 1;
  }

  private async finishOwnedClaim(
    taskId: string,
    claimToken: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date();
    const rows = await this.db.update(assetMediaRepairTasks).set({
      ...patch,
      claimToken: null,
      leaseExpiresAt: null,
    }).where(and(
      eq(assetMediaRepairTasks.id, taskId),
      eq(assetMediaRepairTasks.status, "processing"),
      eq(assetMediaRepairTasks.claimToken, claimToken),
      sql`${assetMediaRepairTasks.leaseExpiresAt} > ${now}`,
    )).returning({ id: assetMediaRepairTasks.id });
    if (rows.length !== 1) throw claimLost();
  }

  private async insertAction(
    transaction: Database,
    taskId: string,
    action: AssetMediaRepairActionMutation,
    createdAt = new Date(),
  ): Promise<void> {
    await transaction.insert(assetMediaRepairActions).values({
      id: randomUUID(),
      taskId,
      ...action,
      errorCode: action.errorCode ?? null,
      errorMessage: action.errorMessage ?? null,
      createdAt,
    });
    if (action.action === "mark_blocked" && action.status === "blocked" && action.errorCode) {
      await transaction.execute(sql`
        insert into ${assetMediaRepairBlockers} (
          asset_entity_id, state_fingerprint, error_code, error_message,
          blocked_at, retry_after, updated_at
        )
        select task.asset_entity_id,
          md5(concat_ws(':', asset.updated_at::text, coalesce((
            select string_agg(concat_ws('|', candidate.id::text, candidate.created_at::text,
              candidate.deleted_at::text, candidate.storage_bucket, candidate.storage_path,
              candidate.width_px::text, candidate.height_px::text, candidate.format, candidate.sha256,
              candidate.metadata::text),
              ',' order by candidate.id)
            from ${assetMedia} candidate where candidate.asset_entity_id = task.asset_entity_id
              or exists (
                select 1 from ${assetVariants} variant
                where variant.id = candidate.asset_variant_id
                  and variant.asset_entity_id = task.asset_entity_id
              )
          ), ''))),
          ${action.errorCode}, ${action.errorMessage ?? null},
          now(), now() + interval '24 hours', now()
        from ${assetMediaRepairTasks} task
        join ${assetEntities} asset on asset.id = task.asset_entity_id
        where task.id = ${taskId}
        on conflict (asset_entity_id) do update set
          state_fingerprint = excluded.state_fingerprint,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          blocked_at = excluded.blocked_at,
          retry_after = excluded.retry_after,
          updated_at = excluded.updated_at
      `);
    }
  }

  private async withOwnedClaim<T>(
    taskId: string,
    claimToken: string,
    action: (transaction: Database) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const claimed = (await transaction.select({ id: assetMediaRepairTasks.id })
        .from(assetMediaRepairTasks)
        .where(and(
          eq(assetMediaRepairTasks.id, taskId),
          eq(assetMediaRepairTasks.status, "processing"),
          eq(assetMediaRepairTasks.claimToken, claimToken),
          sql`${assetMediaRepairTasks.leaseExpiresAt} > ${now}`,
        ))
        .limit(1)
        .for("update"))[0];
      if (!claimed) throw claimLost();
      return action(transaction as unknown as Database);
    });
  }

  private async asset(assetId: string) {
    const row = (await this.db.select().from(assetEntities)
      .where(eq(assetEntities.id, assetId)).limit(1))[0];
    if (!row || row.deletedAt) throw new NotFoundError("资产不存在");
    return row;
  }

  private async loadBundle(asset: Awaited<ReturnType<PostgresAssetMediaRepairRepository["asset"]>>): Promise<AssetRepairBundle> {
    const variants = await this.db.select().from(assetVariants).where(and(
      eq(assetVariants.assetEntityId, asset.id),
      isNull(assetVariants.deletedAt),
    ));
    const media = await this.db.select().from(assetMedia).where(and(
      isNull(assetMedia.deletedAt),
      or(
        eq(assetMedia.assetEntityId, asset.id),
        ...(variants.length ? [inArray(assetMedia.assetVariantId, variants.map((item) => item.id))] : []),
      ),
    )).orderBy(asc(assetMedia.createdAt), asc(assetMedia.id));
    const renditions = media.length
      ? await this.db.select().from(assetMediaRenditions).where(
          inArray(assetMediaRenditions.assetMediaId, media.map((item) => item.id)),
        )
      : [];
    const activeTask = (await this.db.select({ id: assetMediaRepairTasks.id })
      .from(assetMediaRepairTasks)
      .where(and(
        eq(assetMediaRepairTasks.assetEntityId, asset.id),
        inArray(assetMediaRepairTasks.status, [...activeTaskStatuses]),
      ))
      .limit(1))[0];
    return {
      asset: {
        id: asset.id,
        ownerUserId: asset.ownerUserId,
        visibility: asset.visibility,
        status: asset.status,
        sourceProjectId: asset.sourceProjectId,
        intro: asset.intro,
        metadata: asset.metadata,
        deletedAt: asset.deletedAt,
      },
      variants: variants.map((item) => ({
        id: item.id,
        assetEntityId: item.assetEntityId,
        deletedAt: item.deletedAt,
      })),
      media: media.map((item) => ({
        id: item.id,
        assetEntityId: item.assetEntityId,
        assetVariantId: item.assetVariantId,
        mediaKind: item.mediaKind,
        title: item.title,
        description: item.description,
        storageBucket: item.storageBucket,
        storagePath: item.storagePath,
        widthPx: item.widthPx,
        heightPx: item.heightPx,
        format: item.format,
        sha256: item.sha256,
        approved: item.approved,
        metadata: item.metadata,
        deletedAt: item.deletedAt,
      })),
      renditions: renditions.map((item) => ({
        id: item.id,
        assetMediaId: item.assetMediaId,
        renditionKind: item.renditionKind as "thumbnail" | "detail",
        strategy: item.strategy as "tos_process" | "stored_object",
        status: item.status as "pending" | "healthy" | "failed" | "stale",
        processSpec: item.processSpec,
        storageBucket: item.storageBucket,
        storagePath: item.storagePath,
        storageUrl: item.storageUrl,
        sourceSha256: item.sourceSha256,
        widthPx: item.widthPx,
        heightPx: item.heightPx,
        format: item.format,
        sha256: item.sha256,
        errorCode: item.errorCode,
        checkedAt: item.checkedAt,
      })),
      activeRepairTaskId: activeTask?.id ?? null,
    };
  }
}

/** Download authorization is fail-closed: a bundle may contain legacy or
 * malformed rows, but an original object can only leave through its current
 * asset owner and an active, consistent variant binding. */
export function isLegalBundleMediaForAsset(
  bundle: AssetRepairBundle,
  media: AssetRepairMediaSnapshot,
): boolean {
  if (media.deletedAt || media.approved !== true) return false;
  const variant = media.assetVariantId
    ? bundle.variants.find((item) => item.id === media.assetVariantId && !item.deletedAt)
    : undefined;
  if (media.assetVariantId && !variant) return false;
  if (media.assetEntityId && media.assetEntityId !== bundle.asset.id) return false;
  if (variant && variant.assetEntityId !== bundle.asset.id) return false;
  if (media.assetEntityId && variant && media.assetEntityId !== variant.assetEntityId) return false;
  return media.assetEntityId === bundle.asset.id || variant?.assetEntityId === bundle.asset.id;
}

function taskView(row: typeof assetMediaRepairTasks.$inferSelect): ClaimedAssetMediaRepairTask {
  if (
    row.mode !== "safe"
    || !["manual", "self_heal", "batch"].includes(row.trigger)
    || !["queued", "processing", "succeeded", "partial", "failed"].includes(row.status)
  ) {
    throw new Error("资产媒体修复任务状态无效");
  }
  return {
    id: row.id,
    assetId: row.assetEntityId,
    requestedByUserId: row.requestedByUserId,
    clientIdempotencyKey: row.clientIdempotencyKey,
    requestHash: row.requestHash,
    mode: "safe",
    trigger: row.trigger as ClaimedAssetMediaRepairTask["trigger"],
    mediaIds: Array.isArray(row.mediaIds) && row.mediaIds.length
      ? row.mediaIds.filter((item): item is string => typeof item === "string")
      : null,
    status: row.status as ClaimedAssetMediaRepairTask["status"],
    diagnosis: record(row.diagnosis),
    result: ["succeeded", "partial", "failed"].includes(row.status) ? record(row.result) : null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
    claimToken: row.claimToken,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

function accessRecord(asset: typeof assetEntities.$inferSelect): AssetAccessRecord {
  if (asset.visibility !== "personal" && asset.visibility !== "common") {
    throw new ForbiddenError("资产权限信息异常");
  }
  return {
    id: asset.id,
    ownerUserId: asset.ownerUserId,
    visibility: asset.visibility,
    status: asset.status,
    deletedAt: asset.deletedAt,
  };
}

function selfHealRequestHash(assetId: string): string {
  return createHash("sha256").update(`asset-media-self-heal:v1:${assetId}`).digest("hex");
}

function claimLost(): ConflictError {
  return new ConflictError(
    "这次修复任务已由另一工作进程接手，当前处理已安全停止",
    "asset_media_repair_claim_lost",
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
