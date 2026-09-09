import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  mediaProvenanceSubjects,
  type AssetEntityRow,
} from "../../db/schema.js";
import type { JsonObject } from "../../domain/assets/types.js";
import type {
  AudioAssetCategory,
  AudioAssetMetadata,
  AudioSourceFormat,
  CreatedAudioAsset,
} from "./types.js";

export interface CreateAudioAssetInput {
  actorId: string;
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  name: string;
  description: string | null;
  category: AudioAssetCategory;
  audioMetadata: AudioAssetMetadata;
  styleTags: string[];
  vectorText: string;
  audio: {
    storageBucket: string;
    storagePath: string;
    storageUrl: string | null;
    originalFileName: string;
    contentType: string;
    contentLength: number | null;
    format: AudioSourceFormat;
    sha256: string | null;
  };
}

export interface CreatedAudioAssetRecord extends CreatedAudioAsset {
  asset: AssetEntityRow;
}

export class AudioAssetIngestRepository {
  constructor(private readonly db: Database) {}

  async createAudioAsset(input: CreateAudioAssetInput): Promise<CreatedAudioAssetRecord> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const assetId = randomUUID();
      const mediaId = randomUUID();
      const audioAssetMetadata = buildPersistedAudioMetadata(input);
      const [asset] = await transaction.insert(assetEntities).values({
        id: assetId,
        sourceProjectId: input.sourceProjectId,
        sourceProjectName: input.sourceProjectName,
        ownerUserId: input.actorId,
        visibility: "personal",
        assetKind: "audio",
        role: null,
        usageMode: null,
        name: input.name,
        displayName: input.name,
        intro: input.description,
        appearance: input.vectorText,
        ageValue: null,
        gender: null,
        heightCm: null,
        hairDescription: null,
        outfitDescription: null,
        category: input.category,
        styleTags: input.styleTags,
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        sourceFileUrl: input.audio.storageUrl,
        metadata: buildAssetEntityMetadata(input, audioAssetMetadata),
        createdAt: now,
        updatedAt: now,
        useCount: 0,
        deletedAt: null,
        deletedByUserId: null,
      }).returning();
      if (!asset) throw new Error("Failed to create audio asset");

      await transaction.insert(assetMedia).values({
        id: mediaId,
        assetEntityId: assetId,
        assetVariantId: null,
        mediaKind: "audio",
        viewAngle: "reference",
        title: input.name,
        description: input.description,
        storageBucket: input.audio.storageBucket,
        storagePath: input.audio.storagePath,
        storageUrl: input.audio.storageUrl,
        widthPx: null,
        heightPx: null,
        format: input.audio.format,
        sha256: input.audio.sha256,
        isPrimary: true,
        approved: true,
        sortOrder: 100,
        metadata: {
          source: "audio_asset_ingest",
          original_file_name: input.audio.originalFileName,
          content_type: input.audio.contentType,
          content_length: input.audio.contentLength,
          audio_asset: audioAssetMetadata,
          vector_text: input.vectorText,
        },
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      });
      await transaction.insert(mediaProvenanceSubjects).values({
        assetMediaId: mediaId,
        mediaResultId: null,
        sourceChannel: "external_upload",
        sourceGenerationAttemptId: null,
        providerAssetId: null,
        observedAt: now,
      });
      return {
        assetId,
        mediaId,
        storageBucket: input.audio.storageBucket,
        storagePath: input.audio.storagePath,
        storageUrl: input.audio.storageUrl,
        asset,
      };
    });
  }
}

export function audioAssetClassification(category: AudioAssetCategory): {
  assetKind: "audio";
  category: AudioAssetCategory;
  role: null;
  usageMode: null;
} {
  return {
    assetKind: "audio",
    category,
    role: null,
    usageMode: null,
  };
}

export function audioMediaFormatFromFile(fileName: string, contentType: string): AudioSourceFormat | null {
  const extension = path.extname(fileName).replace(/^\./, "").trim().toLowerCase();
  if (extension === "wav" || extension === "mp3" || extension === "ogg" || extension === "opus") return extension;
  const normalized = contentType.trim().toLowerCase();
  if (normalized === "audio/wav" || normalized === "audio/x-wav" || normalized === "audio/wave") return "wav";
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") return "mp3";
  if (normalized === "audio/opus") return "opus";
  if (normalized === "audio/ogg" || normalized === "application/ogg") return "ogg";
  return null;
}

function buildAssetEntityMetadata(
  input: CreateAudioAssetInput,
  audioAssetMetadata: JsonObject,
): JsonObject {
  return {
    asset_type: "audio",
    asset_subtype: input.audioMetadata.kind === "voice" ? "voice_sample" : "background_music",
    audio_asset: audioAssetMetadata,
    source_kind: "audio_asset_ingest",
    source_file_stub: input.audio.originalFileName,
    source_file_sha256: input.audio.sha256 ?? "",
    confidence_score: 1,
    review_state: "approved",
    public_storage_state: "quarantined",
    ingest: {
      source_kind: "audio_asset_ingest",
      source_file_stub: input.audio.originalFileName,
      source_file_sha256: input.audio.sha256 ?? "",
      location: {},
      confidence_score: 1,
      review_state: "approved",
      public_storage_state: "quarantined",
      extraction_method: "manual_audio_asset_ingest",
    },
    provenance: {
      derived_from: [{ ref_type: "source", ref_id: input.audio.originalFileName }],
    },
    license_state: "unknown",
    aigc_label: {
      has_label: false,
      label_type: "",
      standard_ref: "pending_manual_review",
    },
  };
}

function buildPersistedAudioMetadata(input: CreateAudioAssetInput): JsonObject {
  return {
    ...(input.audioMetadata as unknown as JsonObject),
    source: "audio_asset_ingest",
    source_file_name: input.audio.originalFileName,
    content_type: input.audio.contentType,
    content_length: input.audio.contentLength,
    source_audio: {
      storage_bucket: input.audio.storageBucket,
      storage_path: input.audio.storagePath,
      storage_url: input.audio.storageUrl,
      format: input.audio.format,
      sha256: input.audio.sha256,
    },
  };
}
