import type { StoryboardExcelRow } from "../../services/storyboard/types.js";
import type { ProjectAccessActor } from "../project-access/types.js";

export interface StoryboardPreviewIssue {
  level: "warning" | "error";
  code: string;
  message: string;
  sourceRow: number;
}

export interface StoryboardPreviewShot {
  sourceSheet: string;
  sourceRow: number;
  episodeNo: number;
  sceneName: string;
  shotCode: string;
  sortOrder: number;
  screenDescription: string | null;
  cameraMovement: string | null;
  shotSizeAngle: string | null;
  dialogue: string | null;
  soundEffect: string | null;
  referenceImageNote: string | null;
  storyboardImageNote: string | null;
  rawFields: Record<string, string>;
}

export interface StoryboardPreview {
  rows: StoryboardPreviewShot[];
  issues: StoryboardPreviewIssue[];
  episodeCount: number;
  sceneCount: number;
  shotCount: number;
  canConfirm: boolean;
}

export interface StoryboardImportRecord {
  id: string;
  projectId: string;
  uploadedBy: string;
  fileName: string;
  status: "previewed" | "confirmed" | "rejected";
  preview: StoryboardPreview;
  confirmationResult: Record<string, unknown> | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

export interface StoryboardImportRepository {
  createPreview(input: {
    projectId: string;
    uploadedBy: string;
    fileName: string;
    preview: StoryboardPreview;
  }): Promise<StoryboardImportRecord>;
  getById(id: string): Promise<StoryboardImportRecord | undefined>;
  confirm(input: {
    importId: string;
    projectId: string;
    actor: ProjectAccessActor;
    rows: StoryboardPreviewShot[];
  }): Promise<StoryboardImportRecord>;
}

export interface StoryboardParser {
  parse(buffer: Buffer): Promise<StoryboardExcelRow[]>;
}
