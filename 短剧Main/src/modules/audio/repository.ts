import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetReviewActions,
  assetVariants,
  audioVersions,
  generationAttempts,
  generationRequests,
  mediaResults,
  projectAssetRefs,
} from "../../db/schema.js";
import { ConflictError } from "../../shared/errors.js";
import type {
  AudioExtractionSourceRepository,
  AudioLockTarget,
  AudioVersion,
  AudioVersionRepository,
  CreateAudioCandidateInput,
} from "./types.js";

/** PostgreSQL adapter for lifecycle facts; generation owns its media persistence separately. */
export class DrizzleAudioVersionRepository implements AudioVersionRepository, AudioExtractionSourceRepository {
  constructor(private readonly db: Database) {}

  async createCandidate(input: CreateAudioCandidateInput, at: Date): Promise<AudioVersion> {
    const [row] = await this.db.insert(audioVersions).values({
      id: input.id,
      projectId: input.projectId,
      generationRequestId: input.generationRequestId,
      mediaResultId: input.mediaResultId,
      status: "candidate",
      subtitleJson: input.subtitleJson,
      complianceMetadata: input.complianceMetadata,
      createdByUserId: input.createdByUserId,
      createdAt: at,
      updatedAt: at,
    }).onConflictDoNothing({ target: audioVersions.mediaResultId }).returning();
    // Worker persistence is retryable after TOS succeeds. A duplicate means
    // the prior attempt already established the one formal candidate version.
    if (row) return toAudioVersion(row);
    const existing = await this.findByMediaResultId(input.mediaResultId);
    if (existing) return existing;
    throw new Error("audio candidate insert conflicted but no existing version was readable");
  }

  async findByMediaResultId(mediaResultId: string): Promise<AudioVersion | undefined> {
    const [row] = await this.db.select({ version: audioVersions }).from(audioVersions)
      .innerJoin(mediaResults, eq(mediaResults.id, audioVersions.mediaResultId))
      .innerJoin(generationAttempts, eq(generationAttempts.id, mediaResults.attemptId))
      .where(and(
        eq(audioVersions.mediaResultId, mediaResultId),
        eq(mediaResults.persistenceStatus, "persisted"),
        isNull(mediaResults.deletedAt),
        eq(generationAttempts.status, "succeeded"),
      )).limit(1);
    return row ? toAudioVersion(row.version) : undefined;
  }

  async update(version: AudioVersion): Promise<AudioVersion> {
    const [row] = await this.db.update(audioVersions).set({
      status: version.status,
      selectedByUserId: version.selectedByUserId ?? null,
      selectedAt: version.selectedAt ?? null,
      discardedByUserId: version.discardedByUserId ?? null,
      discardedAt: version.discardedAt ?? null,
      lockedAssetEntityId: version.lockedAssetEntityId ?? null,
      lockedAssetMediaId: version.lockedAssetMediaId ?? null,
      projectAssetRefId: version.projectAssetRefId ?? null,
      lockedAt: version.lockedAt ?? null,
      updatedAt: version.updatedAt,
    }).where(and(
      eq(audioVersions.id, version.id),
      // Select and discard are mutually exclusive transitions out of the
      // candidate state. Keep this predicate in the write itself: the service
      // read is only for a clear fast-path error and cannot be the authority
      // under concurrent requests.
      eq(audioVersions.status, "candidate"),
      sql`EXISTS (
        SELECT 1
        FROM ${mediaResults}
        INNER JOIN ${generationAttempts}
          ON ${generationAttempts.id} = ${mediaResults.attemptId}
        WHERE ${mediaResults.id} = ${audioVersions.mediaResultId}
          AND ${mediaResults.persistenceStatus} = 'persisted'
          AND ${mediaResults.deletedAt} IS NULL
          AND ${generationAttempts.status} = 'succeeded'
      )`,
    )).returning();
    if (!row) throw new ConflictError("修改音频没成：状态已变化，请刷新后再试。", "audio_version_state_conflict");
    return toAudioVersion(row);
  }

  async lockSelectedAfterApprovedAssetReview(
    version: AudioVersion,
    target: AudioLockTarget,
    at: Date,
  ): Promise<AudioVersion> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [current] = await tx.select().from(audioVersions)
        .where(eq(audioVersions.id, version.id))
        .limit(1)
        .for("update");
      if (!current) throw new ConflictError("锁定音频没成：找不到这个音频，请刷新后再试。", "audio_version_not_found");
      if (current.status !== "selected") {
        throw new ConflictError("锁定音频没成：请先选中这条音频，再试一次。", "audio_version_not_selected");
      }
      await assertApprovedSoundAssetLock(tx, toAudioVersion(current), target);
      const [updated] = await tx.update(audioVersions).set({
        status: "locked",
        lockedAssetEntityId: target.lockedAssetEntityId,
        lockedAssetMediaId: target.lockedAssetMediaId,
        projectAssetRefId: target.projectAssetRefId,
        lockedAt: at,
        updatedAt: at,
      }).where(and(
        eq(audioVersions.id, current.id),
        eq(audioVersions.status, "selected"),
      )).returning();
      if (!updated) throw new ConflictError("锁定音频没成：状态已变化，请刷新后再试。", "audio_version_state_conflict");
      return toAudioVersion(updated);
    });
  }

  async findProjectIdForExtractableVideo(mediaResultId: string): Promise<string | undefined> {
    const [row] = await this.db.select({ projectId: generationRequests.projectId })
      .from(mediaResults)
      .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
      .innerJoin(generationAttempts, eq(generationAttempts.id, mediaResults.attemptId))
      .where(and(
        eq(mediaResults.id, mediaResultId),
        eq(mediaResults.mediaKind, "video"),
        eq(mediaResults.persistenceStatus, "persisted"),
        isNull(mediaResults.deletedAt),
        eq(generationAttempts.status, "succeeded"),
      ))
      .limit(1);
    return row?.projectId;
  }
}

/**
 * A lock may only point at an independently reviewed sound asset that is an
 * exact TOS/sha copy of this audio candidate. This reuses asset review rather
 * than letting a client manufacture a `reviewAccepted` flag or relabel an
 * unrelated approved asset as the generated sound.
 */
async function assertApprovedSoundAssetLock(
  db: Database,
  version: AudioVersion,
  target: AudioLockTarget,
): Promise<void> {
  const [source] = await db.select({
    projectId: generationRequests.projectId,
    mediaKind: mediaResults.mediaKind,
    persistenceStatus: mediaResults.persistenceStatus,
    attemptStatus: generationAttempts.status,
    storageBucket: mediaResults.storageBucket,
    storagePath: mediaResults.storagePath,
    sha256: mediaResults.sha256,
  }).from(mediaResults)
    .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
    .innerJoin(generationAttempts, eq(generationAttempts.id, mediaResults.attemptId))
    .where(and(
      eq(mediaResults.id, version.mediaResultId),
      isNull(mediaResults.deletedAt),
    ))
    .limit(1);
  if (!source
    || source.projectId !== version.projectId
    || source.mediaKind !== "audio"
    || source.persistenceStatus !== "persisted"
    || source.attemptStatus !== "succeeded"
    || !source.storageBucket
    || !source.storagePath
    || !source.sha256) {
    throw new ConflictError("锁定音频没成：来源素材不完整或已变化，请刷新后再试。", "audio_lock_source_invalid");
  }

  const [asset] = await db.select({ id: assetEntities.id, status: assetEntities.status })
    .from(assetEntities)
    .where(and(
      eq(assetEntities.id, target.lockedAssetEntityId),
      isNull(assetEntities.deletedAt),
    ))
    .limit(1);
  if (!asset || asset.status !== "approved") {
    throw new ConflictError("锁定音频没成：关联声音素材还没通过审核，请先完成审核。", "audio_lock_requires_review");
  }

  const [media] = await db.select({
    id: assetMedia.id,
    assetEntityId: assetMedia.assetEntityId,
    assetVariantId: assetMedia.assetVariantId,
    variantAssetEntityId: assetVariants.assetEntityId,
    mediaKind: assetMedia.mediaKind,
    storageBucket: assetMedia.storageBucket,
    storagePath: assetMedia.storagePath,
    sha256: assetMedia.sha256,
  }).from(assetMedia)
    .leftJoin(assetVariants, eq(assetVariants.id, assetMedia.assetVariantId))
    .where(and(
      eq(assetMedia.id, target.lockedAssetMediaId),
      isNull(assetMedia.deletedAt),
    ))
    .limit(1);
  if (!media
    || media.mediaKind !== "audio"
    || (media.assetEntityId !== asset.id && media.variantAssetEntityId !== asset.id)
    || media.storageBucket !== source.storageBucket
    || media.storagePath !== source.storagePath
    || media.sha256 !== source.sha256) {
    throw new ConflictError("锁定音频没成：关联声音素材已变化，请重新选择后再试。", "audio_lock_asset_media_mismatch");
  }

  const [reference] = await db.select({ id: projectAssetRefs.id })
    .from(projectAssetRefs)
    .where(and(
      eq(projectAssetRefs.id, target.projectAssetRefId),
      eq(projectAssetRefs.projectId, version.projectId),
      eq(projectAssetRefs.assetEntityId, asset.id),
      eq(projectAssetRefs.assetMediaId, media.id),
      isNull(projectAssetRefs.deletedAt),
    ))
    .limit(1);
  if (!reference) {
    throw new ConflictError("锁定音频没成：关联声音素材不在当前项目中，请重新选择。", "audio_lock_project_ref_mismatch");
  }

  const [approval] = await db.select({ id: assetReviewActions.id })
    .from(assetReviewActions)
    .where(and(
      eq(assetReviewActions.projectId, version.projectId),
      eq(assetReviewActions.assetEntityId, asset.id),
      eq(assetReviewActions.action, "approved"),
      eq(assetReviewActions.toStatus, "approved"),
      isNotNull(assetReviewActions.reviewerUserId),
    ))
    .limit(1);
  if (!approval) {
    throw new ConflictError("锁定音频没成：关联声音素材还没通过审核，请先完成审核。", "audio_lock_requires_review");
  }
}

function toAudioVersion(row: typeof audioVersions.$inferSelect): AudioVersion {
  return {
    id: row.id,
    projectId: row.projectId,
    generationRequestId: row.generationRequestId ?? undefined,
    mediaResultId: row.mediaResultId,
    status: row.status as AudioVersion["status"],
    subtitleJson: row.subtitleJson ?? undefined,
    complianceMetadata: row.complianceMetadata,
    createdByUserId: row.createdByUserId,
    selectedByUserId: row.selectedByUserId ?? undefined,
    selectedAt: row.selectedAt ?? undefined,
    discardedByUserId: row.discardedByUserId ?? undefined,
    discardedAt: row.discardedAt ?? undefined,
    lockedAssetEntityId: row.lockedAssetEntityId ?? undefined,
    lockedAssetMediaId: row.lockedAssetMediaId ?? undefined,
    projectAssetRefId: row.projectAssetRefId ?? undefined,
    lockedAt: row.lockedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
