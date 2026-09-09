import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../shared/errors.js";
import type { MediaReviewStore, NormalizedMediaDecision } from "./mediaRepository.js";
import { MediaReviewService } from "./mediaService.js";
import type {
  MediaReviewActor,
  MediaReviewDecisionOutcome,
  MediaReviewQueuePage,
  MediaReviewQueueQuery,
  MediaReviewStatus,
} from "./mediaTypes.js";

const actorId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
const mediaA = "11111111-1111-4111-8111-111111111111";
const mediaB = "55555555-5555-4555-8555-555555555555";

class MemoryMediaReviewStore implements MediaReviewStore {
  statuses = new Map<string, MediaReviewStatus>([[mediaA, "needs_review"], [mediaB, "needs_review"]]);
  decided: NormalizedMediaDecision[] = [];

  async listQueue(_actor: MediaReviewActor, _projectId: string, query: MediaReviewQueueQuery): Promise<MediaReviewQueuePage> {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }

  async decide(
    _actor: MediaReviewActor,
    _projectId: string,
    decisions: NormalizedMediaDecision[],
  ): Promise<MediaReviewDecisionOutcome[]> {
    this.decided.push(...decisions);
    return decisions.map((decision) => {
      const current = this.statuses.get(decision.mediaResultId);
      if (!current) throw new AppError(404, "not_found", "不存在");
      if (current === decision.action) {
        return {
          mediaResultId: decision.mediaResultId,
          status: current,
          changed: false,
          reason: current === "accepted" ? "already_accepted" : "already_rejected",
        } as MediaReviewDecisionOutcome;
      }
      if (current !== "needs_review") {
        throw new AppError(409, "media_review_state_conflict", "产物审核已完成");
      }
      this.statuses.set(decision.mediaResultId, decision.action);
      return {
        mediaResultId: decision.mediaResultId,
        status: decision.action,
        changed: true,
        reason: decision.action === "accepted" ? "accepted" : "rejected",
      };
    });
  }

  async listActions(): Promise<never[]> {
    return [];
  }
}

test("整集批量通过:一次裁决多条产物并落 accepted", async () => {
  const store = new MemoryMediaReviewStore();
  const service = new MediaReviewService(store);
  const outcomes = await service.decide(actorId, projectId, [
    { mediaResultId: mediaA, action: "approve" },
    { mediaResultId: mediaB, action: "approve" },
  ]);
  assert.deepEqual(outcomes.map((outcome) => [outcome.mediaResultId, outcome.status, outcome.changed]), [
    [mediaA, "accepted", true],
    [mediaB, "accepted", true],
  ]);
  assert.equal(store.statuses.get(mediaA), "accepted");
});

test("逐镜拒绝必须给理由,缺失时 422 且不触碰任何产物", async () => {
  const store = new MemoryMediaReviewStore();
  const service = new MediaReviewService(store);
  await assert.rejects(
    () => service.decide(actorId, projectId, [
      { mediaResultId: mediaA, action: "approve" },
      { mediaResultId: mediaB, action: "reject" },
    ]),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  );
  assert.equal(store.decided.length, 0);
  assert.equal(store.statuses.get(mediaA), "needs_review");
});

test("通过时夹带拒绝理由同样 422", async () => {
  const service = new MediaReviewService(new MemoryMediaReviewStore());
  await assert.rejects(
    () => service.decide(actorId, projectId, [
      { mediaResultId: mediaA, action: "approve", rejectionReason: "多写了理由" },
    ]),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  );
});

test("空批量 400，重复产物使用业务文案且不泄露字段名", async () => {
  const service = new MediaReviewService(new MemoryMediaReviewStore());
  await assert.rejects(
    () => service.decide(actorId, projectId, []),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
  await assert.rejects(
    () => service.decide(actorId, projectId, [
      { mediaResultId: mediaA, action: "approve" },
      { mediaResultId: mediaA, action: "reject", rejectionReason: "重复" },
    ]),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 400
      && error.message === "批量裁决的产物不能重复"
      && !error.message.includes("media_result_id")
      && error.details === null,
  );
});

test("已完成审核的产物不可反向裁决；同标靶裁决幂等返回 already_*", async () => {
  const store = new MemoryMediaReviewStore();
  const service = new MediaReviewService(store);
  await service.decide(actorId, projectId, [{ mediaResultId: mediaA, action: "reject", rejectionReason: "画面穿帮" }]);
  await assert.rejects(
    () => service.decide(actorId, projectId, [{ mediaResultId: mediaA, action: "approve" }]),
    (error: unknown) => error instanceof AppError && error.code === "media_review_state_conflict",
  );
  const again = await service.decide(actorId, projectId, [
    { mediaResultId: mediaA, action: "reject", rejectionReason: "画面穿帮" },
  ]);
  assert.deepEqual(again[0], {
    mediaResultId: mediaA,
    status: "rejected",
    changed: false,
    reason: "already_rejected",
  });
});
