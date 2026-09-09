import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  deliveryRecords,
  episodes,
  generationAttempts,
  generationRequests,
  mediaResults,
  projects,
  shots,
} from "../../db/schema.js";
import { NotFoundError } from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { resolveMediaReviewStrategies, type MediaReviewStrategies } from "../reviews/mediaPolicy.js";
import { resolveEffectiveShotMedia } from "../shot-media/effectiveSelection.js";
import type { GatedDeliverableMedia } from "./manifest.js";

export interface EpisodeDeliverySource {
  projectId: string;
  projectName: string;
  episodeId: string;
  episodeNo: number;
  reviewStrategies: MediaReviewStrategies;
  shots: Array<{
    id: string;
    shotCode: string;
    sortOrder: number;
    selectedImageResultId: string | null;
    selectedVideoResultId: string | null;
  }>;
  media: GatedDeliverableMedia[];
}

export interface ProtectedMediaDownload {
  mediaId: string;
  storageUrl: string;
  storagePath: string;
  mimeType: string | null;
}

export interface DeliveryRecord {
  id: string;
  projectId: string;
  episodeId: string;
  manifestHash: string;
  mediaResultIds: string[];
  partial: boolean;
  missingShotCodes: string[];
  purpose: string | null;
  deliveredByUserId: string;
  createdAt: Date;
}

export interface DeliveryRecordPage {
  items: DeliveryRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NewDeliveryRecord {
  episodeId: string;
  manifestHash: string;
  mediaResultIds: string[];
  partial: boolean;
  missingShotCodes: string[];
  purpose: string | null;
}

export interface DeliveryRepository {
  loadEpisode(actor: ProjectAccessActor, episodeId: string): Promise<EpisodeDeliverySource>;
  getDownload(actor: ProjectAccessActor, mediaId: string): Promise<ProtectedMediaDownload>;
  insertDeliveryRecord(actor: ProjectAccessActor, input: NewDeliveryRecord): Promise<DeliveryRecord>;
  listDeliveryRecords(
    actor: ProjectAccessActor,
    episodeId: string,
    page: number,
    pageSize: number,
  ): Promise<DeliveryRecordPage>;
}

export class DrizzleDeliveryRepository implements DeliveryRepository {
  constructor(
    private readonly db: Database,
    private readonly access = ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
  ) {}

  async loadEpisode(actor: ProjectAccessActor, episodeId: string): Promise<EpisodeDeliverySource> {
    const [episode] = await this.db
      .select({
        episodeId: episodes.id,
        episodeNo: episodes.episodeNo,
        projectId: projects.id,
        projectName: projects.name,
      })
      .from(episodes)
      .innerJoin(projects, eq(projects.id, episodes.projectId))
      .where(and(eq(episodes.id, episodeId), isNull(episodes.deletedAt), isNull(projects.deletedAt)))
      .limit(1);
    if (!episode) throw new NotFoundError("分集不存在");
    await this.access.require(actor, episode.projectId, "read");
    const reviewStrategies = await resolveMediaReviewStrategies(this.db, episode.projectId);

    const shotRows = await this.db
      .select({
        id: shots.id,
        shotCode: shots.shotCode,
        sortOrder: shots.sortOrder,
        selectedImageResultId: shots.selectedImageResultId,
        selectedVideoResultId: shots.selectedVideoResultId,
      })
      .from(shots)
      .where(and(eq(shots.episodeId, episodeId), isNull(shots.deletedAt)))
      .orderBy(asc(shots.sortOrder), asc(shots.shotCode));

    const media = shotRows.length
      ? await this.db.select({
          projectId: projects.id,
          projectName: projects.name,
          episodeId: episodes.id,
          episodeNo: episodes.episodeNo,
          shotId: shots.id,
          shotCode: shots.shotCode,
          shotSortOrder: shots.sortOrder,
          mediaId: mediaResults.id,
          mediaKind: mediaResults.mediaKind,
          originKind: mediaResults.originKind,
          sourceAssetMediaId: mediaResults.sourceAssetMediaId,
          registeredByUserId: mediaResults.registeredByUserId,
          storageUrl: mediaResults.storageUrl,
          storagePath: mediaResults.storagePath,
          mimeType: mediaResults.mimeType,
          durationSeconds: mediaResults.durationSeconds,
          mediaRequestId: mediaResults.requestId,
          mediaAttemptId: mediaResults.attemptId,
          generationRequestId: generationRequests.id,
          generationRequestProjectId: generationRequests.projectId,
          generationRequestShotId: generationRequests.shotId,
          generationAttemptId: generationAttempts.id,
          generationAttemptRequestId: generationAttempts.requestId,
          generationAttemptStatus: generationAttempts.status,
          generationAttemptCreatedAt: generationAttempts.createdAt,
          persistenceStatus: mediaResults.persistenceStatus,
          resultIndex: mediaResults.resultIndex,
          provider: generationAttempts.provider,
          model: generationAttempts.model,
          parameters: generationAttempts.parameters,
          estimatedCostFen: generationAttempts.estimatedCostFen,
          reviewStatus: mediaResults.reviewStatus,
        })
        .from(mediaResults)
        .leftJoin(generationAttempts, and(
          eq(generationAttempts.id, mediaResults.attemptId),
          eq(generationAttempts.requestId, mediaResults.requestId),
        ))
        .leftJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
        .innerJoin(shots, eq(shots.id, mediaResults.shotId))
        .innerJoin(episodes, eq(episodes.id, shots.episodeId))
        .innerJoin(projects, eq(projects.id, episodes.projectId))
        .where(and(
          eq(episodes.id, episodeId),
          eq(mediaResults.persistenceStatus, "persisted"),
          isNull(mediaResults.deletedAt),
          isNull(shots.deletedAt),
          isNull(episodes.deletedAt),
          isNull(projects.deletedAt),
        ))
      : [];

    const validGeneration = (row: typeof media[number]) => row.originKind === "generation"
      && row.mediaRequestId !== null
      && row.mediaAttemptId !== null
      && row.generationRequestId === row.mediaRequestId
      && row.generationAttemptId === row.mediaAttemptId
      && row.generationAttemptRequestId === row.mediaRequestId
      && row.generationAttemptStatus === "succeeded"
      && row.generationRequestProjectId === row.projectId
      && row.generationRequestShotId === row.shotId;
    const generationCandidatesByShot = new Map<string, typeof media>();
    for (const row of media) {
      if (!validGeneration(row)) continue;
      const candidates = generationCandidatesByShot.get(row.shotId) ?? [];
      candidates.push(row);
      generationCandidatesByShot.set(row.shotId, candidates);
    }
    const effectiveShots = shotRows.map((shot) => {
      const effective = resolveEffectiveShotMedia({
        imageId: shot.selectedImageResultId,
        videoId: shot.selectedVideoResultId,
      }, (generationCandidatesByShot.get(shot.id) ?? []).map((row) => ({
        id: row.mediaId,
        mediaKind: row.mediaKind,
        originKind: row.originKind,
        persistenceStatus: row.persistenceStatus,
        reviewStatus: row.reviewStatus,
        attemptStatus: row.generationAttemptStatus,
        batchId: row.generationAttemptId,
        batchCreatedAt: row.generationAttemptCreatedAt,
        resultIndex: row.resultIndex,
      })), reviewStrategies);
      return {
        ...shot,
        selectedImageResultId: effective.image?.id ?? null,
        selectedVideoResultId: effective.video?.id ?? null,
      };
    });
    const effectiveIds = new Set(effectiveShots.flatMap((shot) => [
      shot.selectedImageResultId,
      shot.selectedVideoResultId,
    ]).filter((value): value is string => Boolean(value)));

    return {
      projectId: episode.projectId,
      projectName: episode.projectName,
      episodeId: episode.episodeId,
      episodeNo: episode.episodeNo,
      reviewStrategies,
      shots: effectiveShots,
      media: media.flatMap((row): GatedDeliverableMedia[] => {
        if (!effectiveIds.has(row.mediaId)) return [];
        const generated = validGeneration(row);
        const validAssetRegistration = row.originKind === "asset_media"
          && row.sourceAssetMediaId !== null
          && row.registeredByUserId !== null
          && row.mediaRequestId === null
          && row.mediaAttemptId === null;
        if (
          (row.mediaKind !== "image" && row.mediaKind !== "video")
          || !row.storageUrl
          || !row.storagePath
          || row.episodeId !== episodeId
          || row.projectId !== episode.projectId
          || (!generated && !validAssetRegistration)
        ) return [];
        const originKind = generated ? "generation" as const : "asset_media" as const;
        return [{
          projectId: row.projectId,
          projectName: row.projectName,
          episodeId: row.episodeId,
          episodeNo: row.episodeNo,
          shotId: row.shotId,
          shotCode: row.shotCode,
          shotSortOrder: row.shotSortOrder,
          mediaId: row.mediaId,
          mediaKind: row.mediaKind,
          originKind,
          sourceAssetMediaId: row.sourceAssetMediaId,
          storageUrl: row.storageUrl,
          storagePath: row.storagePath,
          mimeType: row.mimeType,
          durationSeconds: row.durationSeconds,
          generationRequestId: generated ? row.generationRequestId : null,
          generationAttemptId: generated ? row.generationAttemptId : null,
          provider: generated ? row.provider : null,
          model: generated ? row.model : null,
          parameters: generated ? row.parameters ?? {} : {
            source_asset_media_id: row.sourceAssetMediaId,
          },
          estimatedCostFen: generated ? row.estimatedCostFen ?? 0 : 0,
          reviewStatus: row.reviewStatus,
        }];
      }),
    };
  }

  async insertDeliveryRecord(actor: ProjectAccessActor, input: NewDeliveryRecord): Promise<DeliveryRecord> {
    const episode = await this.requireEpisodeAccess(actor, input.episodeId);
    const created = await this.db.insert(deliveryRecords).values({
      id: crypto.randomUUID(),
      projectId: episode.projectId,
      episodeId: episode.episodeId,
      manifestHash: input.manifestHash,
      mediaResultIds: input.mediaResultIds,
      partial: input.partial,
      missingShotCodes: input.missingShotCodes,
      purpose: input.purpose,
      deliveredByUserId: actor.id,
      createdAt: new Date(),
    }).returning();
    const row = created[0];
    if (!row) throw new Error("交付记录未能写入");
    return toDeliveryRecord(row);
  }

  async listDeliveryRecords(
    actor: ProjectAccessActor,
    episodeId: string,
    page: number,
    pageSize: number,
  ): Promise<DeliveryRecordPage> {
    const episode = await this.requireEpisodeAccess(actor, episodeId);
    const where = and(
      eq(deliveryRecords.projectId, episode.projectId),
      eq(deliveryRecords.episodeId, episode.episodeId),
    );
    const [items, totals] = await Promise.all([
      this.db.select().from(deliveryRecords)
        .where(where)
        .orderBy(desc(deliveryRecords.createdAt), desc(deliveryRecords.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(deliveryRecords).where(where),
    ]);
    return {
      items: items.map(toDeliveryRecord),
      total: Number(totals[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  private async requireEpisodeAccess(
    actor: ProjectAccessActor,
    episodeId: string,
  ): Promise<{ projectId: string; episodeId: string }> {
    const [episode] = await this.db
      .select({ episodeId: episodes.id, projectId: projects.id })
      .from(episodes)
      .innerJoin(projects, eq(projects.id, episodes.projectId))
      .where(and(eq(episodes.id, episodeId), isNull(episodes.deletedAt), isNull(projects.deletedAt)))
      .limit(1);
    if (!episode) throw new NotFoundError("分集不存在");
    await this.access.require(actor, episode.projectId, "read");
    return episode;
  }

  async getDownload(actor: ProjectAccessActor, mediaId: string): Promise<ProtectedMediaDownload> {
    const [media] = await this.db
      .select({
        mediaId: mediaResults.id,
        originKind: mediaResults.originKind,
        requestId: mediaResults.requestId,
        attemptId: mediaResults.attemptId,
        shotId: mediaResults.shotId,
        sourceAssetMediaId: mediaResults.sourceAssetMediaId,
        registeredByUserId: mediaResults.registeredByUserId,
        storageUrl: mediaResults.storageUrl,
        storagePath: mediaResults.storagePath,
        mimeType: mediaResults.mimeType,
      })
      .from(mediaResults)
      .where(and(
        eq(mediaResults.id, mediaId),
        eq(mediaResults.persistenceStatus, "persisted"),
        isNull(mediaResults.deletedAt),
      ))
      .limit(1);
    if (!media) throw new NotFoundError("媒体不存在或尚未持久化");

    const projectId = media.originKind === "asset_media"
      && media.shotId
      && media.sourceAssetMediaId
      && media.registeredByUserId
      && media.requestId === null
      && media.attemptId === null
      ? await this.projectForShot(media.shotId)
      : media.originKind === "generation"
        && media.requestId
        && media.attemptId
        ? await this.projectForGenerationMedia(media.requestId, media.attemptId, media.shotId)
        : null;
    if (!projectId) throw new NotFoundError("媒体不属于有效项目");
    await this.access.require(actor, projectId, "read");
    if (!media.storageUrl || !media.storagePath) throw new NotFoundError("媒体尚未持久化");
    return {
      mediaId: media.mediaId,
      storageUrl: media.storageUrl,
      storagePath: media.storagePath,
      mimeType: media.mimeType,
    };
  }

  private async projectForShot(shotId: string): Promise<string | null> {
    const [row] = await this.db.select({ projectId: projects.id })
      .from(shots)
      .innerJoin(episodes, eq(episodes.id, shots.episodeId))
      .innerJoin(projects, eq(projects.id, episodes.projectId))
      .where(and(
        eq(shots.id, shotId),
        isNull(shots.deletedAt),
        isNull(episodes.deletedAt),
        isNull(projects.deletedAt),
      ))
      .limit(1);
    return row?.projectId ?? null;
  }

  private async projectForGenerationMedia(
    requestId: string,
    attemptId: string,
    shotId: string | null,
  ): Promise<string | null> {
    const [row] = await this.db.select({ projectId: projects.id })
      .from(generationRequests)
      .innerJoin(generationAttempts, and(
        eq(generationAttempts.id, attemptId),
        eq(generationAttempts.requestId, generationRequests.id),
      ))
      .innerJoin(projects, eq(projects.id, generationRequests.projectId))
      .where(and(
        eq(generationRequests.id, requestId),
        eq(generationAttempts.status, "succeeded"),
        ...(shotId ? [eq(generationRequests.shotId, shotId)] : []),
        isNull(projects.deletedAt),
      ))
      .limit(1);
    return row?.projectId ?? null;
  }
}

function toDeliveryRecord(row: typeof deliveryRecords.$inferSelect): DeliveryRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    episodeId: row.episodeId,
    manifestHash: row.manifestHash,
    mediaResultIds: row.mediaResultIds,
    partial: row.partial,
    missingShotCodes: row.missingShotCodes,
    purpose: row.purpose,
    deliveredByUserId: row.deliveredByUserId,
    createdAt: row.createdAt,
  };
}
