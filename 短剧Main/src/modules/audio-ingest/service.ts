import { createHash } from "node:crypto";
import path from "node:path";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { TosStorage } from "../../integrations/tosStorage.js";
import { AssetEntityRepository } from "../../repositories/assetEntityRepository.js";
import { AssetSourceProjectRepository } from "../../repositories/assetSourceProjectRepository.js";
import { VectorSyncService } from "../../services/vectorSyncService.js";
import { BadRequestError } from "../../shared/errors.js";
import { safePathPart } from "../../shared/files.js";
import {
  buildAudioAssetVectorText,
  buildAudioStyleTags,
  normalizeAudioMetadataForCategory,
} from "./metadata.js";
import { AudioAssetIngestRepository } from "./repository.js";
import type {
  AudioAssetCategory,
  AudioAssetMetadata,
  AudioSourceFormat,
  CreatedAudioAsset,
  SubmitAudioAssetInput,
  SubmitUploadedAudioAssetInput,
} from "./types.js";

export interface AudioIngestServiceDependencies {
  repository?: AudioAssetIngestRepository;
  sourceProjects?: Pick<AssetSourceProjectRepository, "getOrCreate">;
  storage?: Pick<TosStorage, "headObject" | "uploadBytes">;
  vectorSync?: Pick<VectorSyncService, "syncEntity">;
  entityRepository?: Pick<AssetEntityRepository, "toData">;
}

export class AudioIngestService {
  private readonly repository: AudioAssetIngestRepository;
  private readonly sourceProjects: Pick<AssetSourceProjectRepository, "getOrCreate">;
  private readonly storage: Pick<TosStorage, "headObject" | "uploadBytes">;
  private readonly vectorSync: Pick<VectorSyncService, "syncEntity">;
  private readonly entities: Pick<AssetEntityRepository, "toData">;

  constructor(db: Database, dependencies: AudioIngestServiceDependencies = {}) {
    this.repository = dependencies.repository ?? new AudioAssetIngestRepository(db);
    this.sourceProjects = dependencies.sourceProjects ?? new AssetSourceProjectRepository(db);
    this.storage = dependencies.storage ?? new TosStorage();
    this.vectorSync = dependencies.vectorSync ?? new VectorSyncService();
    this.entities = dependencies.entityRepository ?? new AssetEntityRepository(db);
  }

  async submit(input: SubmitAudioAssetInput): Promise<CreatedAudioAsset> {
    const audio = normalizeAudioInput(input);
    const head = await this.storage.headObject(audio.storagePath, audio.storageBucket);
    const contentType = audio.contentType || head.contentType || contentTypeForFormat(audio.format);
    assertAudioContent(audio.originalFileName, contentType);
    return this.createAudioAsset({
      ...input,
      audioMetadata: normalizeAudioMetadataForCategory(input.category, input.audioMetadata),
      audio: { ...audio, contentType, contentLength: head.contentLength, sha256: null },
    });
  }

  async submitUploadedFile(input: SubmitUploadedAudioAssetInput): Promise<CreatedAudioAsset> {
    const fileName = input.file.fileName.trim();
    const contentType = input.file.contentType.trim() || "application/octet-stream";
    if (!fileName) throw new BadRequestError("音频原始文件名不能为空");
    if (!input.file.content.length) throw new BadRequestError("音频文件不能为空");
    const format = assertAudioContent(fileName, contentType);

    const sha256 = createHash("sha256").update(input.file.content).digest("hex");
    const stored = await this.storage.uploadBytes(
      input.file.content,
      audioStoragePath({ fileName, contentType, sha256 }),
      contentType,
    );
    return this.createAudioAsset({
      ...input,
      audioMetadata: normalizeAudioMetadataForCategory(input.category, input.audioMetadata),
      audio: {
        storageBucket: stored.bucket,
        storagePath: stored.storagePath,
        storageUrl: stored.storageUrl,
        originalFileName: fileName,
        contentType,
        contentLength: input.file.content.length,
        format,
        sha256,
      },
    });
  }

  private async createAudioAsset(input: NormalizedAudioAssetInput): Promise<CreatedAudioAsset> {
    const name = input.name.trim();
    if (!name) throw new BadRequestError("音频素材名称不能为空");
    const description = input.description?.trim() || null;
    const sourceProjectName = input.sourceProjectName?.trim() || null;
    const sourceProject = sourceProjectName
      ? await this.sourceProjects.getOrCreate({
          name: sourceProjectName,
          code: `audio_api_${createHash("sha256").update(sourceProjectName).digest("hex").slice(0, 12)}`,
          description: "audio asset ingest",
          projectType: "audio_upload",
          metadata: { ingest_api: "asset-ingest/audio" },
        })
      : null;
    const metadata = normalizeAudioMetadataForCategory(input.category, input.audioMetadata);
    const created = await this.repository.createAudioAsset({
      actorId: input.actorId,
      sourceProjectId: sourceProject?.id ?? null,
      sourceProjectName: sourceProject?.name ?? null,
      name,
      description,
      category: input.category,
      audioMetadata: metadata,
      styleTags: buildAudioStyleTags(input.category, metadata),
      vectorText: buildAudioAssetVectorText({ name, description, category: input.category, metadata }),
      audio: input.audio,
    });
    await this.vectorSync.syncEntity(this.entities.toData(created.asset)).catch((error: unknown) => {
      console.error("[audio-ingest] vector sync failed", error);
    });
    return {
      assetId: created.assetId,
      mediaId: created.mediaId,
      storageBucket: created.storageBucket,
      storagePath: created.storagePath,
      storageUrl: created.storageUrl,
    };
  }
}

interface NormalizedAudioInput {
  storageBucket: string;
  storagePath: string;
  storageUrl: string | null;
  originalFileName: string;
  contentType: string;
  format: AudioSourceFormat;
}

interface NormalizedAudioAssetInput {
  actorId: string;
  sourceProjectName?: string | null;
  name: string;
  description?: string | null;
  category: AudioAssetCategory;
  audioMetadata: AudioAssetMetadata;
  audio: NormalizedAudioInput & {
    contentLength: number | null;
    sha256: string | null;
  };
}

function normalizeAudioInput(input: SubmitAudioAssetInput): NormalizedAudioInput {
  const storagePath = input.audio.storagePath.trim();
  if (!storagePath) throw new BadRequestError("音频 TOS 路径不能为空");
  const storageBucket = input.audio.storageBucket?.trim() || settings.tosBucket;
  if (!storageBucket) throw new BadRequestError("音频 TOS bucket 不能为空");
  const originalFileName = input.audio.originalFileName.trim();
  if (!originalFileName) throw new BadRequestError("音频原始文件名不能为空");
  if (!input.name.trim()) throw new BadRequestError("音频素材名称不能为空");
  return {
    storageBucket,
    storagePath,
    storageUrl: input.audio.storageUrl ?? null,
    originalFileName,
    contentType: input.audio.contentType.trim(),
    format: assertAudioContent(originalFileName, input.audio.contentType),
  };
}

export function assertAudioContent(fileName: string, contentType: string): AudioSourceFormat {
  const extension = path.extname(fileName).toLowerCase();
  const normalizedContentType = contentType.trim().toLowerCase();

  // Hard reject unsupported extensions (m4a/aac/flac/pcm/wma/etc).
  if (extension === ".wav" || extension === ".mp3" || extension === ".ogg" || extension === ".opus") {
    // Extension is allowed — now validate MIME matches.
    const expectedMime = mimeForExtension(extension);
    if (expectedMime && !normalizedContentType.startsWith(expectedMime.replace("/*", "/"))) {
      // Cross-disguise: check if the MIME belongs to any allowed type.
      const mimeFormat = formatForMime(normalizedContentType);
      if (!mimeFormat || mimeFormat !== extension.replace(".", "")) {
        throw new BadRequestError(`音频文件扩展名 ${extension} 与 MIME 类型 ${contentType} 不匹配`);
      }
    }
    return extension.replace(".", "") as AudioSourceFormat;
  }

  // Extension not recognised — try MIME-based fallback.
  const mimeFormat = formatForMime(normalizedContentType);
  if (mimeFormat) return mimeFormat;

  throw new BadRequestError("音频入库只支持 wav/mp3/ogg/opus（不支持 m4a/aac/flac/pcm）");
}

function mimeForExtension(extension: string): string | null {
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".opus") return "audio/opus";
  return null;
}

function formatForMime(contentType: string): AudioSourceFormat | null {
  if (contentType === "audio/wav" || contentType === "audio/x-wav" || contentType === "audio/wave") return "wav";
  if (contentType === "audio/mpeg" || contentType === "audio/mp3") return "mp3";
  if (contentType === "audio/opus") return "opus";
  if (contentType === "audio/ogg" || contentType === "application/ogg") return "ogg";
  return null;
}

function audioStoragePath(input: {
  fileName: string;
  contentType: string;
  sha256: string;
}): string {
  const extension = path.extname(input.fileName).toLowerCase() || `.${assertAudioContent(input.fileName, input.contentType)}`;
  const stem = safePathPart(path.basename(input.fileName, path.extname(input.fileName)));
  return [
    "asset-audio",
    `${input.sha256.slice(0, 12)}_${stem}${extension}`,
  ].join("/");
}

function contentTypeForFormat(format: AudioSourceFormat): string {
  if (format === "wav") return "audio/wav";
  if (format === "ogg") return "audio/ogg";
  if (format === "opus") return "audio/opus";
  return "audio/mpeg";
}
