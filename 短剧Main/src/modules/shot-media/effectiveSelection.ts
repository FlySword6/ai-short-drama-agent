import { isMediaReviewCleared, type MediaReviewStrategies } from "../reviews/mediaPolicy.js";

export type MediaSelectionSource = "manual" | "latest_default";

export interface EffectiveMediaCandidate {
  id: string;
  mediaKind: string;
  originKind: string;
  persistenceStatus: string;
  reviewStatus: string;
  attemptStatus: string | null;
  batchId: string | null;
  batchCreatedAt: Date | null;
  resultIndex: number;
}

export interface EffectiveMediaSelection {
  id: string;
  source: MediaSelectionSource;
}

export interface EffectiveShotMedia {
  image: EffectiveMediaSelection | null;
  video: EffectiveMediaSelection | null;
}

/**
 * `shots.selected_*` 只记录人明确选过的版本。指针为空时，读取侧使用最新
 * 一批成功生成的第一个可用结果；因此系统默认与人工选择无需新增数据库字段。
 */
export function resolveEffectiveShotMedia(
  explicit: { imageId: string | null; videoId: string | null },
  candidates: EffectiveMediaCandidate[],
  strategies: MediaReviewStrategies,
): EffectiveShotMedia {
  return {
    image: resolveKind("image", explicit.imageId, candidates, strategies),
    video: resolveKind("video", explicit.videoId, candidates, strategies),
  };
}

function resolveKind(
  kind: "image" | "video",
  explicitId: string | null,
  candidates: EffectiveMediaCandidate[],
  strategies: MediaReviewStrategies,
): EffectiveMediaSelection | null {
  if (explicitId) return { id: explicitId, source: "manual" };
  const latest = candidates
    .filter((candidate) =>
      candidate.mediaKind === kind
      && candidate.originKind === "generation"
      && candidate.persistenceStatus === "persisted"
      && candidate.attemptStatus === "succeeded"
      && candidate.batchId !== null
      && candidate.batchCreatedAt !== null
      && isMediaReviewCleared(candidate.reviewStatus, strategies[kind]))
    .sort(compareNewestBatch)[0];
  return latest ? { id: latest.id, source: "latest_default" } : null;
}

function compareNewestBatch(left: EffectiveMediaCandidate, right: EffectiveMediaCandidate): number {
  const byBatchTime = right.batchCreatedAt!.getTime() - left.batchCreatedAt!.getTime();
  if (byBatchTime !== 0) return byBatchTime;
  if (left.batchId !== right.batchId) return right.batchId!.localeCompare(left.batchId!);
  const byResultIndex = left.resultIndex - right.resultIndex;
  return byResultIndex !== 0 ? byResultIndex : left.id.localeCompare(right.id);
}
