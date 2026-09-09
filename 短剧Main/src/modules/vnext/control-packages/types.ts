export interface ReferenceCapabilitySnapshot {
  version: string;
  capturedAt: string;
  capabilities: string[];
}

export interface ControlPackageReference {
  referenceId: string;
  referenceVersionId: string;
  label: string;
  reason: string;
  position: number;
  capabilitySnapshot: ReferenceCapabilitySnapshot;
}

export interface ModelAvailability {
  status: "available" | "unavailable";
  checkedAt: string;
  reason?: string;
}

export interface ControlPackageDraft {
  references: ControlPackageReference[];
  finalPrompt: string;
  model: string;
  parameters: Record<string, unknown>;
  noBgm: boolean;
  modelAvailability: ModelAvailability;
  estimatedCostFen: number;
}

export interface ControlPackage extends ControlPackageDraft {
  id: string;
  projectId: string;
  version: number;
  createdByUserId: string;
  createdAt: string;
}

export interface ControlPackageWorkbench {
  controlPackage: ControlPackage | null;
}
