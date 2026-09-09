import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  episodes,
  generationAttempts,
  mediaResults,
  mediaReviewActions,
  shots,
  users,
} from "../../db/schema.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { platformRoleOrMember } from "../auth/types.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccess, ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import type { ReviewMediaKind } from "./types.js";
import { canDecideProjectReview, reviewerForMediaKind } from "./repository.js";
import type {
  MediaReviewActor,
  MediaReviewActionRecord,
  MediaReviewDecisionOutcome,
  MediaReviewQueueItem,
  MediaReviewQueuePage,
  MediaReviewQueueQuery,
  MediaReviewStatus,
} from "./mediaTypes.js";
import { EffectiveShotMediaRepository } from "../shot-media/effectiveSelectionRepository.js";

export interface NormalizedMediaDecision {
  mediaResultId: string;
  action: "accepted" | "rejected";
  rejectionReason?: string;
}

export interface MediaReviewStore {
  listQueue(actor: MediaReviewActor, projectId: string, query: MediaReviewQueueQuery): Promise<MediaReviewQueuePage>;
  decide(
    actor: MediaReviewActor,
    projectId: string,
    decisions: NormalizedMediaDecision[],
  ): Promise<MediaReviewDecisionOutcome[]>;
  listActions(actor: MediaReviewActor, projectId: string, mediaResultId: string): Promise<MediaReviewActionRecord[]>;
}

interface LockedMediaRow {
  id: string;
  shotId: string | null;
  mediaKind: string;
  reviewStatus: string;
}

/**
 * Product review reuses the asset-review skeleton (project_review_policies,
 * reviewer assignment, owner/admin/reviewer authorization) instead of
 * inventing a parallel review truth.
 */
export class PostgresMediaReviewRepository implements MediaReviewStore {
  constructor(private readonly db: Database) {}

  async listQueue(
    actorInput: MediaReviewActor,
    projectId: string,
    query: MediaReviewQueueQuery,
  ): Promise<MediaReviewQueuePage> {
    await this.requireProjectAction(this.db, actorInput, projectId, "read");
    const filters = [
      eq(episodes.projectId, projectId),
      isNull(episodes.deletedAt),
      isNull(shots.deletedAt),
      isNull(mediaResults.deletedAt),
      eq(mediaResults.reviewStatus, query.status),
      eq(mediaResults.persistenceStatus, "persisted"),
      eq(generationAttempts.status, "succeeded"),
      ...(query.episodeId ? [eq(shots.episodeId, query.episodeId)] : []),
    ];
    const where = and(...filters);
    const [items, totals] = await Promise.all([
      this.db.select({
        mediaResultId: mediaResults.id,
        shotId: shots.id,
        shotCode: shots.shotCode,
        selectedImageResultId: shots.selectedImageResultId,
        selectedVideoResultId: shots.selectedVideoResultId,
        episodeId: episodes.id,
        episodeNo: episodes.episodeNo,
        mediaKind: mediaResults.mediaKind,
        originKind: mediaResults.originKind,
        reviewStatus: mediaResults.reviewStatus,
        persistenceStatus: mediaResults.persistenceStatus,
        storageUrl: mediaResults.storageUrl,
        mimeType: mediaResults.mimeType,
        durationSeconds: mediaResults.durationSeconds,
        createdAt: mediaResults.createdAt,
      }).from(mediaResults)
        .innerJoin(generationAttempts, eq(generationAttempts.id, mediaResults.attemptId))
        .innerJoin(shots, eq(shots.id, mediaResults.shotId))
        .innerJoin(episodes, eq(episodes.id, shots.episodeId))
        .where(where)
        .orderBy(desc(mediaResults.createdAt), desc(mediaResults.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ total: count() }).from(mediaResults)
        .innerJoin(generationAttempts, eq(generationAttempts.id, mediaResults.attemptId))
        .innerJoin(shots, eq(shots.id, mediaResults.shotId))
        .innerJoin(episodes, eq(episodes.id, shots.episodeId))
        .where(where),
    ]);
    const effective = await new EffectiveShotMediaRepository(this.db).resolve(projectId, [
      ...new Map(items.map((item) => [item.shotId, {
        id: item.shotId,
        selectedImageResultId: item.selectedImageResultId,
        selectedVideoResultId: item.selectedVideoResultId,
      }])).values(),
    ]);

    return {
      items: items.map((row): MediaReviewQueueItem => {
        const shotSelection = effective.get(row.shotId);
        const selection = row.mediaKind === "image" ? shotSelection?.image : shotSelection?.video;
        return {
          mediaResultId: row.mediaResultId,
          shotId: row.shotId,
          shotCode: row.shotCode,
          episodeId: row.episodeId,
          episodeNo: row.episodeNo,
          mediaKind: asReviewMediaKind(row.mediaKind, row.mediaResultId),
          originKind: row.originKind,
          reviewStatus: row.reviewStatus as MediaReviewStatus,
          persistenceStatus: row.persistenceStatus,
          storageUrl: row.storageUrl,
          mimeType: row.mimeType,
          durationSeconds: row.durationSeconds,
          isPrimary: selection?.id === row.mediaResultId,
          selectionSource: selection?.id === row.mediaResultId ? selection.source : null,
          createdAt: row.createdAt,
        };
      }),
      total: Number(totals[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async decide(
    actorInput: MediaReviewActor,
    projectId: string,
    decisions: NormalizedMediaDecision[],
  ): Promise<MediaReviewDecisionOutcome[]> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const actor = toActor(actorInput);
      const access = await this.requireProjectAction(tx, actor, projectId, "read");
      const locked = await lockProjectMedia(tx, projectId, decisions.map((decision) => decision.mediaResultId));
      const byId = new Map(locked.map((row) => [row.id, row]));
      const assignees = new Map<ReviewMediaKind, string | null>();
      const now = new Date();
      const outcomes: MediaReviewDecisionOutcome[] = [];

      for (const decision of decisions) {
        const media = byId.get(decision.mediaResultId);
        if (!media) throw new NotFoundError("项目中不存在该产物");
        const mediaKind = asReviewMediaKind(media.mediaKind, media.id);
        const assignedReviewerUserId = await reviewerForMediaKind(tx, projectId, mediaKind, assignees);
        if (!canDecideProjectReview(access, actor.id, assignedReviewerUserId)) {
          throw new ForbiddenError("你没有在该项目中执行审核决定的权限");
        }
        const current = assertMediaReviewStatus(media.reviewStatus, media.id);
        const target = decision.action;
        if (current === target) {
          outcomes.push({
            mediaResultId: media.id,
            status: current,
            changed: false,
            reason: target === "accepted" ? "already_accepted" : "already_rejected",
          });
          continue;
        }
        if (current !== "needs_review") {
          throw mediaReviewStateConflict(media.id, current);
        }
        const updated = await tx.update(mediaResults).set({
          reviewStatus: target,
          updatedAt: now,
        }).where(and(eq(mediaResults.id, media.id), eq(mediaResults.reviewStatus, current)))
          .returning({ id: mediaResults.id });
        if (!updated[0]) throw mediaReviewStateConflict(media.id, current);
        const inserted = await tx.insert(mediaReviewActions).values({
          id: crypto.randomUUID(),
          projectId,
          mediaResultId: media.id,
          action: target,
          fromStatus: current,
          toStatus: target,
          reviewerUserId: actor.id,
          assignedReviewerUserId,
          rejectionReason: decision.rejectionReason ?? null,
          createdAt: now,
        }).returning({ id: mediaReviewActions.id });
        if (!inserted[0]) throw new Error("审核动作未能写入");
        outcomes.push({
          mediaResultId: media.id,
          status: target,
          changed: true,
          reason: target === "accepted" ? "accepted" : "rejected",
        });
      }
      return outcomes;
    });
  }

  async listActions(
    actorInput: MediaReviewActor,
    projectId: string,
    mediaResultId: string,
  ): Promise<MediaReviewActionRecord[]> {
    await this.requireProjectAction(this.db, actorInput, projectId, "read");
    const owned = await this.db.select({ id: mediaResults.id }).from(mediaResults)
      .innerJoin(generationAttempts, eq(generationAttempts.id, mediaResults.attemptId))
      .innerJoin(shots, eq(shots.id, mediaResults.shotId))
      .innerJoin(episodes, eq(episodes.id, shots.episodeId))
      .where(and(
        eq(mediaResults.id, mediaResultId),
        eq(episodes.projectId, projectId),
        isNull(mediaResults.deletedAt),
        eq(generationAttempts.status, "succeeded"),
      ))
      .limit(1);
    if (!owned[0]) throw new NotFoundError("项目中不存在该产物");
    const rows = await this.db.select({
      action: mediaReviewActions,
      reviewerDisplayName: users.displayName,
    }).from(mediaReviewActions)
      .leftJoin(users, eq(users.id, mediaReviewActions.reviewerUserId))
      .where(and(
        eq(mediaReviewActions.projectId, projectId),
        eq(mediaReviewActions.mediaResultId, mediaResultId),
      ))
      .orderBy(desc(mediaReviewActions.createdAt), desc(mediaReviewActions.id));
    return rows.map((row): MediaReviewActionRecord => ({
      id: row.action.id,
      projectId: row.action.projectId,
      mediaResultId: row.action.mediaResultId,
      action: row.action.action as MediaReviewActionRecord["action"],
      fromStatus: row.action.fromStatus as MediaReviewStatus,
      toStatus: row.action.toStatus as MediaReviewStatus,
      reviewerUserId: row.action.reviewerUserId,
      reviewerDisplayName: row.reviewerDisplayName,
      assignedReviewerUserId: row.action.assignedReviewerUserId,
      rejectionReason: row.action.rejectionReason,
      createdAt: row.action.createdAt,
    }));
  }

  private async requireProjectAction(
    db: Database,
    actorInput: MediaReviewActor,
    projectId: string,
    action: ProjectAccessAction,
  ): Promise<ProjectAccess> {
    return ProjectAccessService.fromDatabase(new ProjectAccessRepository(db))
      .require(toActor(actorInput), projectId, action);
  }
}

async function lockProjectMedia(db: Database, projectId: string, mediaIds: string[]): Promise<LockedMediaRow[]> {
  if (mediaIds.length === 0) return [];
  const values = sql.join(mediaIds.map((mediaId) => sql`${mediaId}`), sql`, `);
  const result = await db.execute(sql`
    SELECT m.id, m.shot_id AS "shotId", m.media_kind AS "mediaKind", m.review_status AS "reviewStatus"
    FROM ${mediaResults} m
    INNER JOIN ${generationAttempts} ga ON ga.id = m.attempt_id
    INNER JOIN ${shots} s ON s.id = m.shot_id AND s.deleted_at IS NULL
    INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
    WHERE e.project_id = ${projectId}
      AND m.deleted_at IS NULL
      AND m.persistence_status = 'persisted'
      AND ga.status = 'succeeded'
      AND m.id IN (${values})
    ORDER BY m.id
    FOR UPDATE OF m
  `) as unknown as { rows: LockedMediaRow[] };
  return result.rows;
}

function toActor(input: MediaReviewActor): ProjectAccessActor {
  if (typeof input === "string") return { id: input, role: "member" };
  return { id: input.id, role: platformRoleOrMember(input.role) };
}

function assertMediaReviewStatus(status: string, _mediaResultId: string): MediaReviewStatus {
  if (status === "needs_review" || status === "accepted" || status === "rejected") return status;
  throw new ConflictError(
    "产物不在可审核状态，不能进行审核操作",
    "media_review_invalid_state",
  );
}

/** Do not silently coerce a new media kind into image review policy. */
function asReviewMediaKind(mediaKind: string, _mediaResultId: string): ReviewMediaKind {
  if (mediaKind === "image" || mediaKind === "video" || mediaKind === "audio") return mediaKind;
  throw new ConflictError(
    "产物媒体类型未配置审核策略，不能按其他类型处理",
    "media_review_unknown_media_kind",
  );
}

function mediaReviewStateConflict(_mediaResultId: string, _expectedStatus: MediaReviewStatus): ConflictError {
  return new ConflictError(
    "产物审核已完成或已被其他操作更新，请刷新后重试",
    "media_review_state_conflict",
  );
}
