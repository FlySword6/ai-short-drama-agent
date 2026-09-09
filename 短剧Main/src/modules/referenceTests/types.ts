export const referenceTestMediaKinds = ["image", "video"] as const;
export type ReferenceTestMediaKind = (typeof referenceTestMediaKinds)[number];

export const referenceTestModes = ["direct_reference", "material_to_prompt"] as const;
export type ReferenceTestMode = (typeof referenceTestModes)[number];

export interface ReferenceTest {
  id: string;
  projectId: string;
  name: string;
  mediaKind: ReferenceTestMediaKind;
  mode: ReferenceTestMode;
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  referenceMediaIds: string[];
  createdByUserId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceTestResult {
  id: string;
  referenceTestId: string;
  generationRequestId: string;
  mediaResultId: string;
  mediaKind: ReferenceTestMediaKind;
  mode: ReferenceTestMode;
  modelKey: string;
  parameters: Record<string, unknown>;
  createdByUserId: string;
  createdAt: string;
}

export interface ReferenceTestResultMediaSummary {
  storageUrl: string | null;
  persistenceStatus: string | null;
  mimeType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
}

/** Project-level result feed used by board 07's “全部测试批次”. */
export interface ProjectReferenceTestResult extends ReferenceTestResult {
  referenceTestName: string;
  mediaResult: ReferenceTestResultMediaSummary | null;
}

export interface ReferenceTestInput {
  name: string;
  mediaKind: ReferenceTestMediaKind;
  mode: ReferenceTestMode;
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  referenceMediaIds: string[];
}

export interface AttachReferenceTestResultInput {
  generationRequestId: string;
  mediaResultId: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  hasNext: boolean;
}
