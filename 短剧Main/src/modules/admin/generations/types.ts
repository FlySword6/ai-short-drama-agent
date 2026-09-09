import type { GenerationMediaKind, GenerationStatus } from "../../generation/types.js";

export type { GenerationMediaKind, GenerationStatus };

/**
 * Every status the current (highest attempt_no) attempt of a generation
 * request can be in. Kept in one place so the route layer, the repository
 * and the tests all enumerate the exact same set.
 */
export const ADMIN_GENERATION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly GenerationStatus[];

export interface AdminGenerationListFilter {
  status?: GenerationStatus;
  mediaKind?: GenerationMediaKind;
  /** Inclusive lower bound on generation_requests.created_at. */
  createdFrom?: Date;
  /** Inclusive upper bound on generation_requests.created_at. */
  createdTo?: Date;
  /** Already validated to be within [1, 100] by the route layer. */
  limit: number;
  offset: number;
}

/**
 * One row per generation task (= one generation_requests row), projected
 * from its current attempt (the attempt with the highest attempt_no). A
 * task that has been retried therefore appears once, reflecting its latest
 * outcome rather than every historical attempt.
 */
export interface AdminGenerationListItem {
  requestId: string;
  projectId: string;
  projectName: string;
  userId: string;
  username: string;
  mediaKind: GenerationMediaKind;
  status: GenerationStatus;
  phase: string;
  attemptNo: number;
  model: string;
  estimatedCostFen: number;
  failureReason: string | null;
  providerTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminGenerationListResult {
  items: AdminGenerationListItem[];
  /** Total rows matching the filter, independent of limit/offset. */
  total: number;
  limit: number;
  offset: number;
}

export interface AdminGenerationStatusCount {
  status: GenerationStatus;
  count: number;
}

export interface AdminGenerationFailureReasonCount {
  failureReason: string;
  count: number;
}

export interface AdminGenerationDailyCost {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  estimatedCostFen: number;
}

export interface AdminGenerationStats {
  /** Counts of current task status, one entry per ADMIN_GENERATION_STATUSES value (0 if none). */
  byStatus: AdminGenerationStatusCount[];
  /** Top failure reasons among tasks whose current attempt is "failed", highest count first. */
  topFailureReasons: AdminGenerationFailureReasonCount[];
  /** estimated_cost_fen summed across every attempt (including retries) created in the window, one entry per day that has activity. */
  dailyCostFen: AdminGenerationDailyCost[];
  windowDays: number;
}
