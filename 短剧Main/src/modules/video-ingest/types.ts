import type { JsonObject } from "../../domain/assets/types.js";

export type VideoIngestTaskStatus = "queued" | "processing" | "succeeded" | "failed";

export type VideoReferenceSubtype =
  | "action_reference"
  | "camera_motion_reference"
  | "scene_atmosphere_reference"
  | "finished_style_reference"
  | "other";

export interface VideoTimelineSegment {
  start: number;
  end: number;
  description: string;
}

export interface NormalizedVideoUnderstanding {
  summary: string;
  video_subtype: VideoReferenceSubtype;
  scene: string;
  characters: string[];
  actions: string[];
  camera_motion: string[];
  visual_style: string[];
  audio_cues: string[];
  timeline: VideoTimelineSegment[];
  tags: string[];
}

export interface VideoIngestTaskView {
  id: string;
  status: VideoIngestTaskStatus;
  assetEntityId: string;
  assetMediaId: string;
  operatorTaskId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface SubmitVideoIngestInput {
  actorId: string;
  sourceProjectName?: string | null;
  name: string;
  description?: string | null;
  video: {
    storageBucket?: string | null;
    storagePath: string;
    storageUrl?: string | null;
    originalFileName: string;
    contentType: string;
  };
  cover?: {
    storageBucket?: string | null;
    storagePath: string;
    contentType: string;
  } | null;
}

export interface SubmittedVideoIngest {
  assetId: string;
  mediaId: string;
  taskId: string;
  status: VideoIngestTaskStatus;
}

export interface SubmitUploadedVideoIngestInput {
  actorId: string;
  sourceProjectName?: string | null;
  name: string;
  description?: string | null;
  file: {
    fileName: string;
    contentType: string;
    content: Buffer;
  };
}

export interface SubmittedUploadedVideoIngest extends SubmittedVideoIngest {
  storageBucket: string;
  storagePath: string;
  storageUrl: string | null;
}

export type JsonRecord = JsonObject;
