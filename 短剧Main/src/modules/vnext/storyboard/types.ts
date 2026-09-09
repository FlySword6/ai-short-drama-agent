export type StoryboardBoardSource = "shot_plan" | "redraw";

export interface StoryboardImageRequest {
  projectId: string;
  cellId: string;
  actorId: string;
  idempotencyKey: string;
  prompt: string;
  source: Record<string, unknown>;
  paidConfirmation: true;
}

export interface StoryboardImageResult {
  mediaUrl: string;
  mediaSha256: string;
  provider: string;
  model: string;
  billingReceiptId: string;
}

/** Production image boundary. Implementations must not silently synthesize media. */
export interface StoryboardImageAdapter {
  generate(request: StoryboardImageRequest): Promise<StoryboardImageResult>;
}

export interface StoryboardCellVersion {
  id: string;
  cellId: string;
  version: number;
  prompt: string;
  source: Record<string, unknown>;
  mediaUrl: string;
  mediaSha256: string;
  provider: string;
  model: string;
  billingReceiptId: string;
  createdAt: Date;
}

export interface StoryboardCell {
  id: string;
  shotId: string;
  position: number;
  version: StoryboardCellVersion;
}

export interface StoryboardBoard {
  id: string;
  projectId: string;
  confirmationId: string;
  version: number;
  sourceKind: StoryboardBoardSource;
  baseBoardId: string | null;
  redrawnCellId: string | null;
  redrawnCellVersionId: string | null;
  cells: StoryboardCell[];
  createdAt: Date;
}

export interface StoryboardWorkbenchState {
  board: StoryboardBoard | null;
}
