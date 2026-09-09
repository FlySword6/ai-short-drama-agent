import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  episodes,
  generationAttempts,
  generationRequests,
  mediaResults,
  projects,
  seedanceAssetRegistrations,
  shots,
} from "../../db/schema.js";
import { canViewAsset } from "../assets/access.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import {
  initialMediaReviewStatus,
  isMediaReviewCleared,
  recordAutoAcceptedAction,
  resolveMediaReviewStrategies,
  type MediaReviewStrategies,
} from "../reviews/mediaPolicy.js";
import {
  resolveEffectiveShotMedia,
  type EffectiveMediaSelection,
} from "./effectiveSelection.js";

export interface ShotMediaRecord {
  media: typeof mediaResults.$inferSelect;
  attemptNo: number | null;
  attemptStatus: string | null;
  attemptCreatedAt: Date | null;
  provider: string | null;
  model: string | null;
  /** #164 G10:「已入资产库」标记——本产物经 seedance-registration 登记出的资产媒体 id;
      未登记=null。origin=asset_media 的条目本身就来自素材库,不回填(界面按 origin 区分)。 */
  registeredAssetMediaId: string | null;
}

export interface SelectedShotMedia {
  shotId: string;
  mediaKind: "image" | "video";
  selectedMediaResultId: string;
}

export interface RegisteredShotImage {
  shotId: string;
  mediaKind: "image" | "video";
  /** The registered media_results row, whether or not it became primary. */
  mediaResultId: string;
  /** Null when the product awaits review under a pending_review policy and no primary was set. */
  selectedMediaResultId: string | null;
  reviewStatus: string;
  sourceAssetMediaId: string;
  created: boolean;
}

interface ShotAccess {
  shot: typeof shots.$inferSelect;
  projectId: string;
  ownerUserId: string;
}

interface MediaCandidate {
  media: typeof mediaResults.$inferSelect;
  attemptRequestId: string | null;
  attemptStatus: string | null;
  requestProjectId: string | null;
  requestShotId: string | null;
}

export class ShotMediaRepository {
  constructor(
    private readonly db: Database,
    private readonly access = ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
  ) {}

  async list(actor: ProjectAccessActor, shotId: string): Promise<{
    effectiveImage: EffectiveMediaSelection | null;
    effectiveVideo: EffectiveMediaSelection | null;
    items: ShotMediaRecord[];
  }> {
    const access = await this.requireShotAccess(actor, shotId, "read");
    const rows = await this.db.select({
      media: mediaResults,
      attemptNo: generationAttempts.attemptNo,
      attemptStatus: generationAttempts.status,
      attemptCreatedAt: generationAttempts.createdAt,
      provider: generationAttempts.provider,
      model: generationAttempts.model,
      requestProjectId: generationRequests.projectId,
      requestShotId: generationRequests.shotId,
      /* #164 G10:入库登记链——产物→资产媒体(seedance_asset_registrations.source_media_result_id
         有唯一部分索引,leftJoin 至多一行),供「已入资产库」标记与定稿标记并存展示。 */
      registeredAssetMediaId: seedanceAssetRegistrations.assetMediaId,
    }).from(mediaResults)
      .leftJoin(generationAttempts, and(
        eq(mediaResults.attemptId, generationAttempts.id),
        eq(mediaResults.requestId, generationAttempts.requestId),
      ))
      .leftJoin(generationRequests, eq(mediaResults.requestId, generationRequests.id))
      .leftJoin(seedanceAssetRegistrations, eq(seedanceAssetRegistrations.sourceMediaResultId, mediaResults.id))
      .where(and(
        eq(mediaResults.shotId, shotId),
        isNull(mediaResults.deletedAt),
      ))
      .orderBy(asc(mediaResults.mediaKind), desc(mediaResults.createdAt), asc(mediaResults.resultIndex));

    const items = rows.flatMap((row): ShotMediaRecord[] => {
      if (row.media.originKind === "asset_media") {
        return row.media.sourceAssetMediaId ? [{
          media: row.media,
          attemptNo: null,
          attemptStatus: null,
          attemptCreatedAt: null,
          provider: null,
          model: null,
          registeredAssetMediaId: null,
        }] : [];
      }
      if (
        row.media.originKind !== "generation"
        || row.requestProjectId !== access.projectId
        || row.requestShotId !== shotId
        || row.attemptStatus !== "succeeded"
        || row.media.persistenceStatus !== "persisted"
      ) return [];
      return [{
        media: row.media,
        attemptNo: row.attemptNo,
        attemptStatus: row.attemptStatus,
        attemptCreatedAt: row.attemptCreatedAt,
        provider: row.provider,
        model: row.model,
        registeredAssetMediaId: row.registeredAssetMediaId ?? null,
      }];
    });
    const strategies = await resolveMediaReviewStrategies(this.db, access.projectId);
    const effective = resolveEffectiveShotMedia({
      imageId: access.shot.selectedImageResultId,
      videoId: access.shot.selectedVideoResultId,
    }, items.map((item) => ({
      id: item.media.id,
      mediaKind: item.media.mediaKind,
      originKind: item.media.originKind,
      persistenceStatus: item.media.persistenceStatus,
      reviewStatus: item.media.reviewStatus,
      attemptStatus: item.attemptStatus,
      batchId: item.media.attemptId,
      batchCreatedAt: item.attemptCreatedAt,
      resultIndex: item.media.resultIndex,
    })), strategies);
    return {
      effectiveImage: effective.image,
      effectiveVideo: effective.video,
      items,
    };
  }

  async setPrimary(actor: ProjectAccessActor, shotId: string, mediaId: string): Promise<SelectedShotMedia> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const access = await lockShotAccess(db, actor, shotId, "create");
      const candidate = await loadMediaCandidate(db, mediaId);
      const strategies = await resolveMediaReviewStrategies(db, access.projectId);
      return selectPrimary(db, access, candidate, strategies);
    });
  }

  async registerAssetMediaAsPrimary(
    actor: ProjectAccessActor,
    shotId: string,
    assetMediaId: string,
  ): Promise<RegisteredShotImage> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const access = await lockShotAccess(db, actor, shotId, "create");
      const strategies = await resolveMediaReviewStrategies(db, access.projectId);
      const initialStatus = initialMediaReviewStatus(strategies.image);
      let created = false;
      let mediaId: string;

      const registered = await findRegisteredAssetMedia(db, shotId, assetMediaId);
      if (registered) {
        mediaId = registered.id;
      } else {
        const sourceMedia = await requireVisibleAssetMedia(db, actor.id, assetMediaId);
        const now = new Date();
        const id = randomUUID();
        const inserted = (await db.insert(mediaResults).values({
          id,
          requestId: null,
          attemptId: null,
          shotId,
          originKind: "asset_media",
          sourceAssetMediaId: sourceMedia.id,
          registeredByUserId: actor.id,
          mediaKind: "image",
          resultIndex: 0,
          providerResultKey: null,
          providerUrl: null,
          providerUrlExpiresAt: null,
          persistenceStatus: "persisted",
          storageBucket: sourceMedia.storageBucket,
          storagePath: sourceMedia.storagePath,
          storageUrl: sourceMedia.storageUrl,
          sha256: sourceMedia.sha256,
          mimeType: imageMimeType(sourceMedia.format),
          widthPx: sourceMedia.widthPx,
          heightPx: sourceMedia.heightPx,
          durationSeconds: null,
          reviewStatus: initialStatus,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          deletedByUserId: null,
        }).onConflictDoNothing().returning({ id: mediaResults.id }))[0];
        if (inserted) {
          mediaId = inserted.id;
          created = true;
          if (initialStatus === "accepted") {
            await recordAutoAcceptedAction(db, { projectId: access.projectId, mediaResultId: mediaId, createdAt: now });
          }
        } else {
          const concurrent = await findRegisteredAssetMedia(db, shotId, assetMediaId);
          if (!concurrent) throw new Error("Failed to resolve concurrent shot media registration");
          mediaId = concurrent.id;
        }
      }

      const candidate = await loadMediaCandidate(db, mediaId);
      if (candidate.media.mediaKind !== "image") {
        throw new ConflictError("只能登记图片为分镜主图", "shot_primary_requires_image");
      }
      if (!isMediaReviewCleared(candidate.media.reviewStatus, strategies.image)) {
        // The product is registered and visible in the review queue; a pending
        // review policy just forbids promoting it to primary before a decision.
        return {
          shotId: access.shot.id,
          mediaKind: "image",
          mediaResultId: candidate.media.id,
          selectedMediaResultId: null,
          reviewStatus: candidate.media.reviewStatus,
          sourceAssetMediaId: assetMediaId,
          created,
        };
      }
      const selected = await selectPrimary(db, access, candidate, strategies);
      return {
        shotId: selected.shotId,
        mediaKind: selected.mediaKind,
        mediaResultId: candidate.media.id,
        selectedMediaResultId: selected.selectedMediaResultId,
        reviewStatus: candidate.media.reviewStatus,
        sourceAssetMediaId: assetMediaId,
        created,
      };
    });
  }

  /** v1.4(迁移 065):给视频版本打标签与备注,写入 `media_results.metadata.shot_version.label` / `.note`。
      仅视频可打标签;版本序号本身按 created_at 升序由 service 计算,不入库。 */
  async setVersionLabel(
    actor: ProjectAccessActor,
    shotId: string,
    mediaId: string,
    label: string | null,
    note: string | null,
  ): Promise<{ shotId: string; mediaKind: "image" | "video"; mediaResultId: string }> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const access = await lockShotAccess(db, actor, shotId, "create");
      const candidate = await loadMediaCandidate(db, mediaId);
      if (candidate.media.mediaKind !== "video") {
        throw new ConflictError("只能给视频版本打标签", "shot_version_label_requires_video");
      }
      const metadata = candidate.media.metadata ?? {};
      await db.update(mediaResults).set({
        metadata: {
          ...metadata,
          shot_version: { ...(metadata.shot_version ?? {}), label, note },
        },
        updatedAt: new Date(),
      }).where(eq(mediaResults.id, mediaId));
      return { shotId: access.shot.id, mediaKind: "video", mediaResultId: mediaId };
    });
  }

  /** 删除视频版本(软删 `deleted_at` + `deleted_by_user_id`,回收站可恢复,R1 合规)。
      当前版不能直接删——先换成别的版本;仅视频可删(版本模型只覆盖视频)。 */
  async deleteMedia(
    actor: ProjectAccessActor,
    shotId: string,
    mediaId: string,
    now = new Date(),
  ): Promise<{ shotId: string; mediaKind: "video"; mediaResultId: string }> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const access = await lockShotAccess(db, actor, shotId, "create");
      const candidate = await loadMediaCandidate(db, mediaId);
      if (candidate.media.shotId !== access.shot.id) {
        throw new ConflictError("媒体不属于当前分镜", "shot_media_mismatch");
      }
      if (candidate.media.mediaKind !== "video") {
        throw new ConflictError("只能删除视频版本", "shot_version_delete_requires_video");
      }
      if (access.shot.selectedVideoResultId === mediaId) {
        throw new ConflictError("当前版不能删除，请先换成其他版本", "shot_current_version_not_deletable");
      }
      await db.update(mediaResults).set({
        deletedAt: now,
        deletedByUserId: actor.id,
        updatedAt: now,
      }).where(eq(mediaResults.id, mediaId));
      return { shotId: access.shot.id, mediaKind: "video", mediaResultId: mediaId };
    });
  }

  private async requireShotAccess(
    actor: ProjectAccessActor,
    shotId: string,
    action: ProjectAccessAction,
  ): Promise<ShotAccess> {
    return requireShotAccess(this.db, actor, shotId, action, this.access);
  }
}

async function lockShotAccess(
  db: Database,
  actor: ProjectAccessActor,
  shotId: string,
  action: ProjectAccessAction,
): Promise<ShotAccess> {
  await db.execute(sql`SELECT id FROM ${shots} WHERE id = ${shotId} FOR UPDATE`);
  return requireShotAccess(
    db,
    actor,
    shotId,
    action,
    ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
  );
}

async function requireShotAccess(
  db: Database,
  actor: ProjectAccessActor,
  shotId: string,
  action: ProjectAccessAction,
  accessService: ProjectAccessService,
): Promise<ShotAccess> {
  const rows = await db.select({
    shot: shots,
    projectId: episodes.projectId,
    ownerUserId: projects.ownerUserId,
  }).from(shots)
    .innerJoin(episodes, eq(shots.episodeId, episodes.id))
    .innerJoin(projects, eq(episodes.projectId, projects.id))
    .where(and(
      eq(shots.id, shotId),
      isNull(shots.deletedAt),
      isNull(episodes.deletedAt),
      isNull(projects.deletedAt),
    ))
    .limit(1);
  const access = rows[0];
  if (!access) throw new NotFoundError("分镜不存在或你没有访问权限");
  await accessService.require(actor, access.projectId, action);
  return access;
}

async function loadMediaCandidate(db: Database, mediaId: string): Promise<MediaCandidate> {
  const rows = await db.select({
    media: mediaResults,
    attemptRequestId: generationAttempts.requestId,
    attemptStatus: generationAttempts.status,
    requestProjectId: generationRequests.projectId,
    requestShotId: generationRequests.shotId,
  }).from(mediaResults)
    .leftJoin(generationAttempts, eq(mediaResults.attemptId, generationAttempts.id))
    .leftJoin(generationRequests, eq(mediaResults.requestId, generationRequests.id))
    .where(and(eq(mediaResults.id, mediaId), isNull(mediaResults.deletedAt)))
    .limit(1);
  const candidate = rows[0];
  if (!candidate) throw new NotFoundError("分镜媒体不存在");
  return candidate;
}

async function selectPrimary(
  db: Database,
  access: ShotAccess,
  candidate: MediaCandidate,
  strategies: MediaReviewStrategies,
): Promise<SelectedShotMedia> {
  const { media } = candidate;
  if (media.shotId !== access.shot.id) {
    throw new ConflictError("媒体不属于当前分镜", "shot_media_mismatch");
  }
  if (media.mediaKind !== "image" && media.mediaKind !== "video") {
    throw new ConflictError("媒体类型不支持设为主版本", "unsupported_media_kind");
  }
  if (media.originKind === "generation") {
    if (
      !media.requestId
      || !media.attemptId
      || !media.providerResultKey
      || candidate.attemptRequestId !== media.requestId
      || candidate.requestShotId !== access.shot.id
      || candidate.requestProjectId !== access.projectId
    ) {
      throw new ConflictError("媒体不属于当前分镜", "shot_media_mismatch");
    }
    if (candidate.attemptStatus !== "succeeded") {
      throw new ConflictError("只能选择生成成功的媒体", "generation_not_succeeded");
    }
  } else if (media.originKind === "asset_media") {
    if (!media.sourceAssetMediaId || !media.registeredByUserId || media.mediaKind !== "image") {
      throw new ConflictError("资产媒体登记不完整", "asset_media_registration_invalid");
    }
  } else {
    throw new ConflictError("媒体来源类型不受支持", "unsupported_media_origin");
  }
  requirePersistedMedia(media);
  const mediaKind = media.mediaKind as "image" | "video";
  if (!isMediaReviewCleared(media.reviewStatus, strategies[mediaKind])) {
    throw new ConflictError(
      "产物尚未通过审核，不能设为主版本",
      "media_review_not_accepted",
      { media_result_id: media.id, review_status: media.reviewStatus },
    );
  }

  const current = media.mediaKind === "image"
    ? access.shot.selectedImageResultId
    : access.shot.selectedVideoResultId;
  if (current === media.id) {
    return {
      shotId: access.shot.id,
      mediaKind: media.mediaKind,
      selectedMediaResultId: media.id,
    };
  }

  const selectedAt = new Date();
  if (media.mediaKind === "image") {
    await db.update(shots).set({
      selectedImageResultId: media.id,
      updatedAt: selectedAt,
    }).where(eq(shots.id, access.shot.id));
  } else {
    await db.update(shots).set({
      selectedVideoResultId: media.id,
      updatedAt: selectedAt,
    }).where(eq(shots.id, access.shot.id));
  }

  return {
    shotId: access.shot.id,
    mediaKind: media.mediaKind,
    selectedMediaResultId: media.id,
  };
}

function requirePersistedMedia(media: typeof mediaResults.$inferSelect): void {
  if (
    media.persistenceStatus !== "persisted"
    || !media.storageBucket?.trim()
    || !media.storagePath?.trim()
    || !media.storageUrl?.trim()
  ) {
    throw new ConflictError("这段素材还没保存好，请稍后再选", "media_not_persisted");
  }
}

async function findRegisteredAssetMedia(db: Database, shotId: string, assetMediaId: string) {
  return (await db.select({ id: mediaResults.id }).from(mediaResults).where(and(
    eq(mediaResults.shotId, shotId),
    eq(mediaResults.originKind, "asset_media"),
    eq(mediaResults.sourceAssetMediaId, assetMediaId),
    isNull(mediaResults.deletedAt),
  )).limit(1))[0];
}

async function requireVisibleAssetMedia(
  db: Database,
  actorId: string,
  assetMediaId: string,
): Promise<typeof assetMedia.$inferSelect> {
  const source = (await db.select().from(assetMedia).where(and(
    eq(assetMedia.id, assetMediaId),
    isNull(assetMedia.deletedAt),
  )).limit(1))[0];
  if (!source) throw new NotFoundError("资产媒体不存在");

  let assetId = source.assetEntityId;
  if (!assetId && source.assetVariantId) {
    const variant = (await db.select({
      assetEntityId: assetVariants.assetEntityId,
    }).from(assetVariants).where(and(
      eq(assetVariants.id, source.assetVariantId),
      isNull(assetVariants.deletedAt),
    )).limit(1))[0];
    assetId = variant?.assetEntityId ?? null;
  }
  if (!assetId) {
    throw new ConflictError("资产媒体未绑定有效资产", "asset_media_unbound");
  }
  const asset = (await db.select().from(assetEntities).where(and(
    eq(assetEntities.id, assetId),
    isNull(assetEntities.deletedAt),
  )).limit(1))[0];
  if (!asset) throw new NotFoundError("资产不存在或已在回收站");
  if (asset.visibility !== "personal" && asset.visibility !== "common") {
    throw new ForbiddenError("这份素材暂时不能用于分镜，请换一份再试。");
  }
  if (!canViewAsset({
    id: asset.id,
    ownerUserId: asset.ownerUserId,
    visibility: asset.visibility,
    status: asset.status,
    deletedAt: asset.deletedAt,
  }, actorId)) {
    throw new ForbiddenError("无权使用该资产媒体");
  }
  if (source.mediaKind !== "image") {
    throw new ConflictError("只能把图片资产登记为分镜图", "asset_media_not_image");
  }
  if (
    !source.storageBucket?.trim()
    || !source.storagePath?.trim()
    || !source.storageUrl?.trim()
  ) {
    throw new ConflictError("这张素材还没保存好，请稍后再用", "asset_media_not_persisted");
  }
  return source;
}

function imageMimeType(format: string | null): string {
  const normalized = format?.trim().toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "tif" || normalized === "tiff") return "image/tiff";
  if (normalized && /^[a-z0-9.+-]+$/.test(normalized)) return `image/${normalized}`;
  return "application/octet-stream";
}
