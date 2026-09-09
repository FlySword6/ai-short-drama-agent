import type { ControlPackageReference } from "../control-packages/types.js";

export type VnextProviderReference = {
  referenceVersionId: string;
  kind: "image" | "video";
  url: string;
  durationSeconds?: number;
};

export interface VnextGenerationReferenceResolver {
  resolve(projectId: string, references: ControlPackageReference[]): Promise<VnextProviderReference[]>;
}
