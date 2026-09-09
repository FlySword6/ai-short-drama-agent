import type { ProjectAccessActor } from "../project-access/types.js";
import type { ReviewMediaKind } from "./types.js";
import type { MediaSelectionSource } from "../shot-media/effectiveSelection.js";

/** Media-product lifecycle: needs_review -> accepted | rejected, both terminal. */
export const mediaReviewStatuses = ["needs_review", "accepted", "rejected"] as const;
export type MediaReviewStatus = (typeof mediaReviewStatuses)[number];

export const mediaReviewActions = ["accepted", "rejected", "auto_accepted"] as const;
export type MediaReviewAction = (typeof mediaReviewActions)[number];

export type MediaReviewActor = string | ProjectAccessActor;

export interface MediaReviewQueueQuery {
  status: MediaReviewStatus;
  episodeId?: string;
  page: number;
  pageSize: number;
}

export interface MediaReviewQueueItem {
  mediaResultId: string;
  shotId: string;
  shotCode: string;
  episodeId: string;
  episodeNo: number;
  mediaKind: ReviewMediaKind;
  originKind: string;
  reviewStatus: MediaReviewStatus;
  persistenceStatus: string;
  storageUrl: string | null;
  mimeType: string | null;
  durationSeconds: number | null;
  isPrimary: boolean;
  selectionSource: MediaSelectionSource | null;
  createdAt: Date;
}

export interface MediaReviewQueuePage {
  items: MediaReviewQueueItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MediaReviewDecisionInput {
  mediaResultId: string;
  action: "approve" | "reject";
  rejectionReason?: string;
}

export interface MediaReviewDecisionOutcome {
  mediaResultId: string;
  status: MediaReviewStatus;
  changed: boolean;
  reason: "accepted" | "rejected" | "already_accepted" | "already_rejected";
}

export interface MediaReviewActionRecord {
  id: string;
  projectId: string;
  mediaResultId: string;
  action: MediaReviewAction;
  fromStatus: MediaReviewStatus;
  toStatus: MediaReviewStatus;
  /** Null only for the system auto_accepted action. */
  reviewerUserId: string | null;
  reviewerDisplayName: string | null;
  assignedReviewerUserId: string | null;
  rejectionReason: string | null;
  createdAt: Date;
}
