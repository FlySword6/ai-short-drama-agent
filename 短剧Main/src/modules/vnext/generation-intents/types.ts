import type { ControlPackage } from "../control-packages/types.js";

export interface PendingGenerationIntent {
  id: string;
  projectId: string;
  actorId: string;
  clientIdempotencyKey: string;
  controlPackageId: string;
  controlPackageVersion: number;
  references: ControlPackage["references"];
  finalPrompt: string;
  model: string;
  parameters: Record<string, unknown>;
  noBgm: boolean;
  estimatedCostFen: number;
  status: "pending_confirmation";
  createdAt: string;
}

export interface PendingIntentWorkbench {
  pendingIntent: PendingGenerationIntent | null;
}
