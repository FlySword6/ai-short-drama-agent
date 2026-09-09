/**
 * vNext generation task and attempt types.
 *
 * One task is created per human-confirmed pending intent.  One attempt is
 * appended per execution run.  Automatic paid retries are prohibited:
 * the worker only claims attempts in non-terminal, non-submitting states.
 */

import type { ControlPackageReference } from "../control-packages/types.js";

// ─── Task ────────────────────────────────────────────────────────────────────

export type VnextGenerationTaskStatus = "created" | "running" | "succeeded" | "failed";

export interface VnextGenerationTask {
  id: string;
  projectId: string;
  actorId: string;
  intentId: string;
  clientIdempotencyKey: string;
  controlPackageId: string;
  controlPackageVersion: number;
  references: ControlPackageReference[];
  provider: string;
  model: string;
  prompt: string;
  noBgm: boolean;
  parameters: Record<string, unknown>;
  estimatedCostFen: number;
  status: VnextGenerationTaskStatus;
  createdAt: string;
}

// ─── Attempt ─────────────────────────────────────────────────────────────────

export type VnextAttemptStatus =
  | "created"
  | "submitting"
  | "provider_queued"
  | "provider_running"
  | "provider_succeeded"
  | "copying_to_tos"
  | "succeeded"
  | "failed"
  | "unknown_outcome";

export interface VnextTosMediaItem {
  providerResultKey: string;
  storageBucket: string;
  objectKey: string;
  storageUrl: string;
  mimeType: string;
  sha256: string;
  durationSeconds?: number;
  copiedAt: string;
}

export interface VnextProviderResultSnapshot {
  status: "succeeded" | "failed";
  rawStatus: string;
  providerTaskId: string;
  /** URL(s) returned directly by the provider for download. */
  mediaUrls: string[];
  errorCode?: string;
  errorMessage?: string;
  actualModelId?: string;
  durationSeconds?: number;
}

export interface VnextGenerationAttempt {
  id: string;
  taskId: string;
  attemptNo: number;
  status: VnextAttemptStatus;
  providerTaskId: string | null;
  providerRawStatus: string | null;
  providerResult: VnextProviderResultSnapshot | null;
  tosMedia: VnextTosMediaItem[];
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  actualCostFen: number | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export interface VnextGenerationTaskView {
  task: VnextGenerationTask;
  /** Most recent attempt; null only before the first claim. */
  latestAttempt: VnextGenerationAttemptView | null;
}

export interface VnextGenerationAttemptView {
  id: string;
  attemptNo: number;
  status: VnextAttemptStatus;
  providerTaskId: string | null;
  tosMedia: VnextTosMediaItem[];
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Recovery context ────────────────────────────────────────────────────────

/**
 * Minimal context handed to the worker for a single recoverable execution.
 * The task supplies fixed config; the attempt supplies mutable progress.
 */
export interface VnextRecoverableAttemptContext {
  task: VnextGenerationTask;
  attempt: VnextGenerationAttempt;
}
