import type { ProjectAccessActor } from "../project-access/types.js";

export const reviewMediaKinds = ["image", "video", "audio"] as const;
export type ReviewMediaKind = (typeof reviewMediaKinds)[number];

/**
 * HTTP routes pass the authenticated user, while legacy in-process callers
 * may still pass only an id. A bare id deliberately behaves as a normal
 * member, never as an administrator.
 */
export type ReviewActor = string | ProjectAccessActor;

export const reviewDefaultStrategies = ["automatic", "pending_review"] as const;
export type ReviewDefaultStrategy = (typeof reviewDefaultStrategies)[number];

export const assetReviewStatuses = [
  "automatic_review",
  "pending_review",
  "approved",
  "rejected",
] as const;
export type AssetReviewStatus = (typeof assetReviewStatuses)[number];

export const assetReviewActions = ["submitted", "approved", "rejected"] as const;
export type AssetReviewAction = (typeof assetReviewActions)[number];

export interface ProjectReviewPolicy {
  /** null/version=0 means the safe pending-review default is not persisted yet. */
  id: string | null;
  projectId: string;
  mediaKind: ReviewMediaKind;
  defaultStrategy: ReviewDefaultStrategy;
  /** A project member who may decide assets of this media kind; null means owner/admin only. */
  reviewerUserId: string | null;
  updatedByUserId: string | null;
  version: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface PutProjectReviewPolicyInput {
  mediaKind: ReviewMediaKind;
  defaultStrategy: ReviewDefaultStrategy;
  /** Omitted keeps the current assignee; null explicitly clears it. */
  reviewerUserId?: string | null;
  expectedVersion: number;
}

export interface AssetReviewItem {
  assetId: string;
  status: AssetReviewStatus;
  changed: boolean;
  reason: "submitted" | "already_pending_review" | "already_approved" | "already_rejected";
  latestAction?: AssetReviewActionRecord;
}

export interface AssetReviewActionRecord {
  id: string;
  /** Global procurement-library approvals are auditable without a project. */
  projectId: string | null;
  assetId: string;
  action: AssetReviewAction;
  fromStatus: AssetReviewStatus;
  toStatus: AssetReviewStatus;
  reviewerUserId: string;
  reviewerDisplayName: string | null;
  /** Snapshot of the policy assignee when this audit action was created. */
  assignedReviewerUserId: string | null;
  rejectionReason: string | null;
  createdAt: Date;
}

export interface ReviewDecisionInput {
  action: "approve" | "reject";
  rejectionReason?: string;
}
