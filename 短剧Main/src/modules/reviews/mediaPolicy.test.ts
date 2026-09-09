import assert from "node:assert/strict";
import test from "node:test";
import {
  initialMediaReviewStatus,
  isMediaReviewCleared,
  resolveMediaReviewStrategies,
} from "./mediaPolicy.js";

test("产物审核门禁谓词:accepted 恒放行,rejected 恒拦截", () => {
  assert.equal(isMediaReviewCleared("accepted", "pending_review"), true);
  assert.equal(isMediaReviewCleared("accepted", "automatic"), true);
  assert.equal(isMediaReviewCleared("rejected", "automatic"), false);
  assert.equal(isMediaReviewCleared("rejected", "pending_review"), false);
});

test("needs_review 只在 automatic 策略下视同通过", () => {
  assert.equal(isMediaReviewCleared("needs_review", "automatic"), true);
  assert.equal(isMediaReviewCleared("needs_review", "pending_review"), false);
});

test("产物落库初始审核态由策略决定", () => {
  assert.equal(initialMediaReviewStatus("automatic"), "accepted");
  assert.equal(initialMediaReviewStatus("pending_review"), "needs_review");
});

test("音频临时选用沿用产品审核的 automatic 缺省，候选边界由 audio_versions 承担", async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  } as never;
  const strategies = await resolveMediaReviewStrategies(db, "project-id");
  assert.equal(strategies.image, "automatic");
  assert.equal(strategies.video, "automatic");
  assert.equal(strategies.audio, "automatic");
});
