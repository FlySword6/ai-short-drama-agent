import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq, inArray, isNull, max, or } from "drizzle-orm";
import sharp from "sharp";
import type { Database } from "../../db/client.js";
import {
  assetMedia,
  assetVariants,
  mediaProvenanceSubjects,
  type AssetMediaRow,
} from "../../db/schema.js";
import { TosStorage, type StoredObject } from "../../integrations/tosStorage.js";
import { BadRequestError } from "../../shared/errors.js";
import { safeFileName } from "../../shared/files.js";
import { toAssetMediaData } from "./catalog.js";
import {
  lockAndRequireManageableAsset,
  requireManageableAsset,
} from "./manageableAsset.js";

export const ASSET_MEDIA_MAX_PIXELS = 25_000_000;
/** 图片单文件上限(10MB,multipart 全局限额之上再按 media_kind 分层收紧)。 */
export const ASSET_MEDIA_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 音频单文件上限(20MB;multipart 全局限额与之一致,音频不再二次收紧)。 */
export const ASSET_MEDIA_MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const supportedImageFormats = new Map<string, { extension: string; contentType: string }>([
  ["jpeg", { extension: "jpg", contentType: "image/jpeg" }],
  ["png", { extension: "png", contentType: "image/png" }],
  ["webp", { extension: "webp", contentType: "image/webp" }],
  ["gif", { extension: "gif", contentType: "image/gif" }],
  ["avif", { extension: "avif", contentType: "image/avif" }],
  ["tiff", { extension: "tiff", contentType: "image/tiff" }],
  ["bmp", { extension: "bmp", contentType: "image/bmp" }],
]);

export interface UploadedImageInfo {
  format: string;
  extension: string;
  contentType: string;
  width: number;
  height: number;
}

export interface UploadedAudioInfo {
  format: string;
  extension: string;
  contentType: string;
}

/** 音频格式白名单:按文件头魔数识别(不信任扩展名/声明类型)。 */
const supportedAudioFormats: ReadonlyArray<{
  format: string;
  extension: string;
  contentType: string;
  matches: (content: Buffer) => boolean;
}> = [
  {
    format: "flac",
    extension: "flac",
    contentType: "audio/flac",
    matches: (content) => content.subarray(0, 4).toString("ascii") === "fLaC",
  },
  {
    format: "ogg",
    extension: "ogg",
    contentType: "audio/ogg",
    matches: (content) => content.subarray(0, 4).toString("ascii") === "OggS",
  },
  {
    format: "wav",
    extension: "wav",
    contentType: "audio/wav",
    matches: (content) => content.subarray(0, 4).toString("ascii") === "RIFF"
      && content.subarray(8, 12).toString("ascii") === "WAVE",
  },
  // AAC:ADTS 同步字 0xFFF(12 位,严格子集)——必须排在 MP3 之前,否则被 MP3 的
  // 11 位同步字(0xFFE)宽松匹配抢先命中。
  {
    format: "aac",
    extension: "aac",
    contentType: "audio/aac",
    matches: (content) => content.length >= 2 && content[0] === 0xFF && (content[1]! & 0xF6) === 0xF0,
  },
  // MP3:ID3 标签头,或 MPEG 帧同步字(0xFF 0xEx)
  {
    format: "mp3",
    extension: "mp3",
    contentType: "audio/mpeg",
    matches: (content) => content.subarray(0, 3).toString("ascii") === "ID3"
      || (content.length >= 2 && content[0] === 0xFF && (content[1]! & 0xE0) === 0xE0),
  },
];

/** 上传产物的统一检测结果:图片带像素、音频只带格式(无宽高概念)。 */
export type UploadedMediaInfo =
  | { kind: "image"; format: string; extension: string; contentType: string; width: number; height: number }
  | { kind: "audio"; format: string; extension: string; contentType: string };

export interface AssetMediaUploadInput {
  actorId: string;
  assetId: string;
  fileName: string;
  declaredContentType?: string | null;
  content: Buffer;
  title?: string;
  description?: string;
  isPrimary?: boolean;
  assetVariantId?: string;
  /** 显式声明媒体类型(multipart media_kind 字段),不靠 MIME 推断;缺省按图片。 */
  mediaKind?: "image" | "audio";
}

export interface PersistUploadedAssetMediaInput {
  actorId: string;
  assetId: string;
  mediaId: string;
  originalFileName: string;
  declaredContentType?: string | null;
  title: string;
  description?: string;
  isPrimary: boolean;
  sha256: string;
  media: UploadedMediaInfo;
  stored: StoredObject;
  assetVariantId?: string;
}

export interface AssetMediaUploadRepositoryPort {
  assertManageable(actorId: string, assetId: string): Promise<void>;
  persistUploadedMedia(input: PersistUploadedAssetMediaInput): Promise<AssetMediaRow>;
}

export interface AssetObjectStoragePort {
  uploadBytes(content: Buffer, storagePath: string, contentType: string): Promise<StoredObject>;
  deleteObject(storagePath: string): Promise<void>;
}

export interface AssetMediaUploadDependencies {
  repository?: AssetMediaUploadRepositoryPort;
  storage?: AssetObjectStoragePort;
  inspectImage?: (content: Buffer) => Promise<UploadedImageInfo>;
  inspectAudio?: (content: Buffer) => Promise<UploadedAudioInfo>;
  createMediaId?: () => string;
  /**
   * 2026-08-19 触发模型:is_primary=true 上传在 persist 成功后后台自动登记火山
   * 素材(完整版上传主图共用同一钩子)。fire-and-forget,失败由登记服务持久化到
   * 登记行,前端展示并人工重试;未注入保持纯人工登记。
   */
  registerPrimary?: (input: {
    actorId: string;
    assetId: string;
    mediaId: string;
  }) => Promise<void> | void;
}

export class AssetMediaUploadService {
  private readonly repository: AssetMediaUploadRepositoryPort;
  private readonly storage: AssetObjectStoragePort;
  private readonly inspectImage: (content: Buffer) => Promise<UploadedImageInfo>;
  private readonly inspectAudio: (content: Buffer) => Promise<UploadedAudioInfo>;
  private readonly createMediaId: () => string;
  private readonly registerPrimary: ((input: {
    actorId: string;
    assetId: string;
    mediaId: string;
  }) => Promise<void> | void) | null;

  constructor(db: Database, dependencies: AssetMediaUploadDependencies = {}) {
    this.repository = dependencies.repository ?? new DrizzleAssetMediaUploadRepository(db);
    this.storage = dependencies.storage ?? new TosStorage();
    this.inspectImage = dependencies.inspectImage ?? inspectUploadedImage;
    this.inspectAudio = dependencies.inspectAudio ?? inspectUploadedAudio;
    this.createMediaId = dependencies.createMediaId ?? randomUUID;
    this.registerPrimary = dependencies.registerPrimary ?? null;
  }

  async assertManageable(actorId: string, assetId: string): Promise<void> {
    await this.repository.assertManageable(actorId, assetId);
  }

  async upload(input: AssetMediaUploadInput): Promise<Record<string, unknown>> {
    if (!input.content.length) {
      throw new BadRequestError(input.mediaKind === "audio" ? "上传音频不能为空" : "上传图片不能为空");
    }

    // Check access before any external write. The repository checks it again in
    // the insert transaction in case ownership changes while the upload runs.
    await this.assertManageable(input.actorId, input.assetId);
    const media: UploadedMediaInfo = input.mediaKind === "audio"
      ? { kind: "audio", ...(await this.inspectAudio(input.content)) }
      : { kind: "image", ...(await this.inspectImage(input.content)) };
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const mediaId = this.createMediaId();
    const storagePath = buildAssetMediaStoragePath(input.assetId, mediaId, sha256, media.extension);
    const stored = await this.storage.uploadBytes(input.content, storagePath, media.contentType);

    let row: AssetMediaRow;
    try {
      row = await this.repository.persistUploadedMedia({
        actorId: input.actorId,
        assetId: input.assetId,
        mediaId,
        originalFileName: safeFileName(input.fileName).slice(0, 512),
        declaredContentType: input.declaredContentType,
        title: normaliseTitle(input.title, input.fileName, media.kind === "image" ? "上传图片" : "上传音频"),
        description: input.description,
        isPrimary: input.isPrimary ?? false,
        sha256,
        media,
        stored,
        ...(input.assetVariantId ? { assetVariantId: input.assetVariantId } : {}),
      });
    } catch (error) {
      // The object has no valid database owner if persistence fails. Cleanup is
      // best effort and must not hide the database error that explains failure.
      await this.storage.deleteObject(stored.storagePath).catch(() => undefined);
      throw error;
    }
    // 触发模型(2026-08-19):is_primary=true 上传 persist 成功后后台自动登记火山
    // 素材(上传只允许图片/音频,天然在 CreateAsset 契约内)。fire-and-forget,
    // 失败已由登记服务持久化到登记行,不阻塞上传响应。
    if (input.isPrimary && this.registerPrimary) {
      const pending = this.registerPrimary({ actorId: input.actorId, assetId: input.assetId, mediaId });
      if (pending instanceof Promise) {
        void pending.catch(() => undefined);
      }
    }
    return toAssetMediaData(row, input.assetId);
  }
}

export class DrizzleAssetMediaUploadRepository implements AssetMediaUploadRepositoryPort {
  constructor(private readonly db: Database) {}

  async assertManageable(actorId: string, assetId: string): Promise<void> {
    await requireManageableAsset(this.db, actorId, assetId);
  }

  async persistUploadedMedia(input: PersistUploadedAssetMediaInput): Promise<AssetMediaRow> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;

      // Serialise version and primary changes per asset. This prevents two
      // simultaneous uploads from both believing they became the primary.
      await lockAndRequireManageableAsset(db, input.actorId, input.assetId);

      const variantIds = (await db.select({ id: assetVariants.id }).from(assetVariants).where(and(
        eq(assetVariants.assetEntityId, input.assetId),
        isNull(assetVariants.deletedAt),
      ))).map((row) => row.id);
      const belongs = mediaBelongsToAsset(input.assetId, variantIds);
      const [sortRow] = await db.select({ value: max(assetMedia.sortOrder) }).from(assetMedia).where(and(
        isNull(assetMedia.deletedAt),
        belongs,
      ));

      if (input.isPrimary) {
        await db.update(assetMedia).set({ isPrimary: false }).where(and(
          isNull(assetMedia.deletedAt),
          belongs,
        ));
      }

      const [created] = await db.insert(assetMedia).values({
        id: input.mediaId,
        assetEntityId: input.assetId,
        assetVariantId: input.assetVariantId ?? null,
        mediaKind: input.media.kind,
        viewAngle: input.media.kind === "image" ? "unknown" : null,
        title: input.title,
        description: input.description ?? null,
        storageBucket: input.stored.bucket,
        storagePath: input.stored.storagePath,
        storageUrl: input.stored.storageUrl,
        widthPx: input.media.kind === "image" ? input.media.width : null,
        heightPx: input.media.kind === "image" ? input.media.height : null,
        format: input.media.format,
        sha256: input.sha256,
        isPrimary: input.isPrimary,
        approved: true,
        sortOrder: (sortRow?.value ?? -1) + 1,
        metadata: {
          source: "asset_media_upload",
          original_file_name: input.originalFileName,
          declared_content_type: input.declaredContentType ?? null,
          detected_content_type: input.media.contentType,
        },
        createdAt: new Date(),
        deletedAt: null,
        deletedByUserId: null,
      }).returning();
      if (!created) throw new Error("资产媒体版本保存失败");
      // Direct uploads are never allowed to self-declare first-party origin.
      // The source subject is written in the same server transaction as the
      // local media row, and future model descendants inherit this edge.
      await db.insert(mediaProvenanceSubjects).values({
        assetMediaId: created.id,
        mediaResultId: null,
        sourceChannel: "external_upload",
        sourceGenerationAttemptId: null,
        providerAssetId: null,
        observedAt: new Date(),
      }).onConflictDoNothing();
      return created;
    });
  }
}

export async function inspectUploadedImage(content: Buffer): Promise<UploadedImageInfo> {
  if (!content.length) throw new BadRequestError("上传图片不能为空");
  if (content.length > ASSET_MEDIA_MAX_IMAGE_BYTES) {
    throw new BadRequestError("图片文件不能超过 10 兆");
  }
  try {
    const image = sharp(content, { failOn: "error", limitInputPixels: ASSET_MEDIA_MAX_PIXELS });
    const metadata = await image.metadata();
    const pixelCount = (metadata.width ?? 0) * (metadata.height ?? 0);
    if (pixelCount > ASSET_MEDIA_MAX_PIXELS) {
      throw new BadRequestError("图片像素不能超过 2500 万（约等于 4K 图片的 3 倍）");
    }
    // stats() forces libvips to decode image pixels instead of accepting only a
    // plausible header. SVG is intentionally not included in the format map.
    await image.stats();
    const format = metadata.format ? supportedImageFormats.get(metadata.format) : undefined;
    if (!format || !metadata.width || !metadata.height) {
      throw new BadRequestError("只支持可解码的常见图片文件");
    }
    return {
      format: metadata.format,
      extension: format.extension,
      contentType: format.contentType,
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    if (error instanceof Error && /exceeds pixel limit/i.test(error.message)) {
      throw new BadRequestError("图片像素不能超过 2500 万（约等于 4K 图片的 3 倍）");
    }
    throw new BadRequestError("文件不是有效图片或图片已损坏");
  }
}

export async function inspectUploadedAudio(content: Buffer): Promise<UploadedAudioInfo> {
  if (!content.length) throw new BadRequestError("上传音频不能为空");
  if (content.length > ASSET_MEDIA_MAX_AUDIO_BYTES) {
    throw new BadRequestError("音频文件不能超过 20 兆");
  }
  const match = supportedAudioFormats.find((candidate) => candidate.matches(content));
  if (!match) throw new BadRequestError("只支持常见音频文件(mp3/wav/ogg/aac/flac)");
  return {
    format: match.format,
    extension: match.extension,
    contentType: match.contentType,
  };
}

export function buildAssetMediaStoragePath(
  assetId: string,
  mediaId: string,
  sha256: string,
  extension: string,
): string {  const safeAssetId = assertUuidPathPart(assetId, "assetId");
  const safeMediaId = assertUuidPathPart(mediaId, "mediaId");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("sha256 is invalid");
  if (!/^[a-z0-9]+$/.test(extension)) throw new Error("image extension is invalid");
  return path.posix.join("prod", "asset", safeAssetId, "media", `${safeMediaId}_${sha256.slice(0, 16)}.${extension}`);
}

function mediaBelongsToAsset(assetId: string, variantIds: string[]) {
  return or(
    eq(assetMedia.assetEntityId, assetId),
    ...(variantIds.length ? [inArray(assetMedia.assetVariantId, variantIds)] : []),
  )!;
}

function normaliseTitle(title: string | undefined, fileName: string, fallback = "上传图片"): string {
  const explicit = title?.trim();
  if (explicit) return explicit.slice(0, 128);
  const base = path.parse(safeFileName(fileName)).name.trim();
  return (base || fallback).slice(0, 128);
}

function assertUuidPathPart(value: string, label: string): string {
  const normalised = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalised)) {
    throw new Error(`${label} is not a UUID`);
  }
  return normalised;
}
