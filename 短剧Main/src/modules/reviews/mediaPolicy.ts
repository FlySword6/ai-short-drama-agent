import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { mediaReviewActions, projectReviewPolicies } from "../../db/schema.js";
import type { ReviewDefaultStrategy, ReviewMediaKind } from "./types.js";

/**
 * Effective per-media-kind review strategy for generated/registered products.
 *
 * The product domain reuses `project_review_policies` (contract: 策略沿用),
 * but its fail-default differs from the asset-review domain on purpose: a
 * missing row means `automatic`, so projects that never opted in keep today's
 * behaviour (products flow through), while an explicit `pending_review` row
 * turns the quality gate on for that media kind.
 */
export type MediaReviewStrategies = Record<ReviewMediaKind, ReviewDefaultStrategy>;

export async function resolveMediaReviewStrategies(
  db: Database,
  projectId: string,
): Promise<MediaReviewStrategies> {
  const rows = await db.select({
    mediaKind: projectReviewPolicies.mediaKind,
    defaultStrategy: projectReviewPolicies.defaultStrategy,
  }).from(projectReviewPolicies).where(eq(projectReviewPolicies.projectId, projectId));
  const stored = new Map(rows.map((row) => [row.mediaKind, row.defaultStrategy]));
  return {
    image: normalizeStrategy(stored.get("image")),
    video: normalizeStrategy(stored.get("video")),
    // Audio retains the product-review default: a selected temporary sound
    // input may be used in the current shot. Its separate audio_versions
    // candidate gate is enforced by the control-package module; this policy
    // must not turn that explicit selection flow into an implicit block.
    audio: normalizeStrategy(stored.get("audio")),
  };
}

function normalizeStrategy(value: string | undefined): ReviewDefaultStrategy {
  return value === "pending_review" ? "pending_review" : "automatic";
}

/**
 * The single gate predicate used by set-primary and delivery: a product is
 * review-cleared when a human accepted it, or when the project policy for its
 * media kind is `automatic` and nobody has rejected it.
 */
export function isMediaReviewCleared(
  reviewStatus: string,
  strategy: ReviewDefaultStrategy,
): boolean {
  if (reviewStatus === "accepted") return true;
  return reviewStatus === "needs_review" && strategy === "automatic";
}

/** Initial review status for a product persisted under the given strategy. */
export function initialMediaReviewStatus(strategy: ReviewDefaultStrategy): "accepted" | "needs_review" {
  return strategy === "automatic" ? "accepted" : "needs_review";
}

/**
 * Automatic pass is a real audited fact, not the absence of a block. The
 * partial unique index `media_review_actions_auto_once_idx` makes the insert
 * idempotent across persistence replays.
 */
export async function recordAutoAcceptedAction(
  db: Database,
  input: {
    projectId: string;
    mediaResultId: string;
    assignedReviewerUserId?: string | null;
    createdAt?: Date;
  },
): Promise<void> {
  await db.insert(mediaReviewActions).values({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    mediaResultId: input.mediaResultId,
    action: "auto_accepted",
    fromStatus: "needs_review",
    toStatus: "accepted",
    reviewerUserId: null,
    assignedReviewerUserId: input.assignedReviewerUserId ?? null,
    rejectionReason: null,
    createdAt: input.createdAt ?? new Date(),
  }).onConflictDoNothing();
}
