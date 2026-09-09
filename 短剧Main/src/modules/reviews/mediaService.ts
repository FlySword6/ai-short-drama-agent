import { BadRequestError, UnprocessableEntityError } from "../../shared/errors.js";
import type { MediaReviewStore, NormalizedMediaDecision } from "./mediaRepository.js";
import type {
  MediaReviewActor,
  MediaReviewActionRecord,
  MediaReviewDecisionInput,
  MediaReviewDecisionOutcome,
  MediaReviewQueuePage,
  MediaReviewQueueQuery,
} from "./mediaTypes.js";

/**
 * Product review adjudication. Non-generative by design: it cannot quote,
 * submit, retry, or invoke a provider; it only moves review_status and writes
 * audit actions.
 */
export class MediaReviewService {
  constructor(private readonly store: MediaReviewStore) {}

  listQueue(actor: MediaReviewActor, projectId: string, query: MediaReviewQueueQuery): Promise<MediaReviewQueuePage> {
    return this.store.listQueue(actor, projectId, query);
  }

  async decide(
    actor: MediaReviewActor,
    projectId: string,
    inputs: MediaReviewDecisionInput[],
  ): Promise<MediaReviewDecisionOutcome[]> {
    if (inputs.length === 0) throw new BadRequestError("至少选择一条产物裁决");
    const seen = new Set<string>();
    const normalized: NormalizedMediaDecision[] = [];
    for (const input of inputs) {
      if (seen.has(input.mediaResultId)) {
        throw new BadRequestError("批量裁决的产物不能重复");
      }
      seen.add(input.mediaResultId);
      if (input.action === "reject") {
        const reason = input.rejectionReason?.trim();
        if (!reason) throw new UnprocessableEntityError("拒绝产物时必须填写拒绝理由");
        normalized.push({ mediaResultId: input.mediaResultId, action: "rejected", rejectionReason: reason });
        continue;
      }
      if (input.rejectionReason !== undefined) {
        throw new UnprocessableEntityError("通过产物时不能填写拒绝理由");
      }
      normalized.push({ mediaResultId: input.mediaResultId, action: "accepted" });
    }
    return this.store.decide(actor, projectId, normalized);
  }

  listActions(actor: MediaReviewActor, projectId: string, mediaResultId: string): Promise<MediaReviewActionRecord[]> {
    return this.store.listActions(actor, projectId, mediaResultId);
  }
}
