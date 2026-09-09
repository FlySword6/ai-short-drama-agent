import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  generationAttempts,
  generationRequests,
  mediaResults,
} from "../../db/schema.js";
import { resolveMediaReviewStrategies } from "../reviews/mediaPolicy.js";
import {
  resolveEffectiveShotMedia,
  type EffectiveShotMedia,
} from "./effectiveSelection.js";

export interface ShotSelectionInput {
  id: string;
  selectedImageResultId: string | null;
  selectedVideoResultId: string | null;
}

export interface EffectiveShotMediaStore {
  resolve(projectId: string, shots: readonly ShotSelectionInput[]): Promise<Map<string, EffectiveShotMedia>>;
}

/**
 * Read projection for consumers outside the shot-media list. Manual pointers
 * remain the write truth; null pointers are projected to the latest eligible
 * generation batch without writing a synthetic human decision.
 */
export class EffectiveShotMediaRepository implements EffectiveShotMediaStore {
  constructor(private readonly db: Database) {}

  async resolve(
    projectId: string,
    shotRows: readonly ShotSelectionInput[],
  ): Promise<Map<string, EffectiveShotMedia>> {
    if (shotRows.length === 0) return new Map();
    const shotIds = [...new Set(shotRows.map((shot) => shot.id))];
    const [strategies, rows] = await Promise.all([
      resolveMediaReviewStrategies(this.db, projectId),
      this.db.select({
        id: mediaResults.id,
        shotId: mediaResults.shotId,
        mediaKind: mediaResults.mediaKind,
        originKind: mediaResults.originKind,
        persistenceStatus: mediaResults.persistenceStatus,
        reviewStatus: mediaResults.reviewStatus,
        resultIndex: mediaResults.resultIndex,
        mediaRequestId: mediaResults.requestId,
        mediaAttemptId: mediaResults.attemptId,
        requestId: generationRequests.id,
        requestProjectId: generationRequests.projectId,
        requestShotId: generationRequests.shotId,
        attemptId: generationAttempts.id,
        attemptRequestId: generationAttempts.requestId,
        attemptStatus: generationAttempts.status,
        attemptCreatedAt: generationAttempts.createdAt,
      }).from(mediaResults)
        .leftJoin(generationAttempts, and(
          eq(generationAttempts.id, mediaResults.attemptId),
          eq(generationAttempts.requestId, mediaResults.requestId),
        ))
        .leftJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
        .where(and(
          inArray(mediaResults.shotId, shotIds),
          isNull(mediaResults.deletedAt),
        )),
    ]);
    const candidatesByShot = new Map<string, typeof rows>();
    for (const row of rows) {
      if (
        !row.shotId
        || row.originKind !== "generation"
        || row.mediaRequestId === null
        || row.mediaAttemptId === null
        || row.requestId !== row.mediaRequestId
        || row.attemptId !== row.mediaAttemptId
        || row.attemptRequestId !== row.mediaRequestId
        || row.requestProjectId !== projectId
        || row.requestShotId !== row.shotId
      ) continue;
      const candidates = candidatesByShot.get(row.shotId) ?? [];
      candidates.push(row);
      candidatesByShot.set(row.shotId, candidates);
    }

    return new Map(shotRows.map((shot) => [
      shot.id,
      resolveEffectiveShotMedia({
        imageId: shot.selectedImageResultId,
        videoId: shot.selectedVideoResultId,
      }, (candidatesByShot.get(shot.id) ?? []).map((candidate) => ({
        id: candidate.id,
        mediaKind: candidate.mediaKind,
        originKind: candidate.originKind,
        persistenceStatus: candidate.persistenceStatus,
        reviewStatus: candidate.reviewStatus,
        attemptStatus: candidate.attemptStatus,
        batchId: candidate.attemptId,
        batchCreatedAt: candidate.attemptCreatedAt,
        resultIndex: candidate.resultIndex,
      })), strategies),
    ]));
  }
}
