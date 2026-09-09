import type { JsonObject } from "../../domain/assets/types.js";

export type AudioSourceFormat = "wav" | "mp3" | "ogg" | "opus";

export const AUDIO_INGEST_CATEGORIES = ["音色", "背景音乐"] as const;
export type AudioAssetCategory = (typeof AUDIO_INGEST_CATEGORIES)[number];

export type AudioIngestCategory = AudioAssetCategory;

export type AudioAssetMetadata =
  | {
      kind: "voice";
      voice_traits: string[];
      speaking_style: string | null;
    }
  | {
      kind: "background_music";
      music_traits: string[];
      tempo: string | null;
      usage_scene: string | null;
    };

export interface SubmitAudioAssetInput {
  actorId: string;
  sourceProjectName?: string | null;
  name: string;
  description?: string | null;
  category: AudioAssetCategory;
  audioMetadata: AudioAssetMetadata;
  audio: {
    storageBucket?: string | null;
    storagePath: string;
    storageUrl?: string | null;
    originalFileName: string;
    contentType: string;
  };
}

export interface SubmitUploadedAudioAssetInput {
  actorId: string;
  sourceProjectName?: string | null;
  name: string;
  description?: string | null;
  category: AudioAssetCategory;
  audioMetadata: AudioAssetMetadata;
  file: {
    fileName: string;
    contentType: string;
    content: Buffer;
  };
}

export interface CreatedAudioAsset {
  assetId: string;
  mediaId: string;
  storageBucket: string;
  storagePath: string;
  storageUrl: string | null;
}

export type JsonRecord = JsonObject;
