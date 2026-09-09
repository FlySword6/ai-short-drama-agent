/**
 * vNext video segment version types.
 *
 * A version row is appended only from a succeeded generation attempt's TOS
 * media.  The original version is immutable: modify/extend grows the chain
 * with a new row referencing its origin; it never overwrites the origin's
 * media or metadata.  Automatic paid retries stay prohibited — a failed
 * change task leaves only failed attempt records and no version row.
 */

import type { ControlPackageDraft } from "../control-packages/types.js";
import type { VnextTosMediaItem } from "../generation/types.js";

// ─── Version ─────────────────────────────────────────────────────────────────

export type VnextVideoChangeType = "register" | "modify" | "extend";

export interface VnextVideoVersion {
  id: string;
  projectId: string;
  chainId: string;
  versionNo: number;
  changeType: VnextVideoChangeType;
  originVersionId: string | null;
  actorId: string;
  sourceTaskId: string;
  sourceAttemptId: string;
  controlPackageId: string;
  controlPackageVersion: number;
  provider: string;
  model: string;
  prompt: string;
  parameters: Record<string, unknown>;
  tosMedia: VnextTosMediaItem[];
  estimatedCostFen: number;
  actualCostFen: number | null;
  createdAt: string;
}

// ─── Change draft ────────────────────────────────────────────────────────────

export type VnextVideoChangeDraftType = Exclude<VnextVideoChangeType, "register">;

export interface VnextVideoChangeDraft {
  id: string;
  projectId: string;
  actorId: string;
  originVersionId: string;
  changeType: VnextVideoChangeDraftType;
  intentId: string;
  clientIdempotencyKey: string;
  createdAt: string;
}

/** Human-reviewed inputs for the modify/extend draft (seeded from the origin, edited on the page). */
export interface VnextVideoChangeDraftInput extends ControlPackageDraft {
  changeType: VnextVideoChangeDraftType;
  clientIdempotencyKey: string;
}
