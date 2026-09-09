import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type { Database } from "../../../db/client.js";
import { TosStorage, type StoredObject } from "../../../integrations/tosStorage.js";
import { BadRequestError } from "../../../shared/errors.js";
import { safeFileName } from "../../../shared/files.js";
import {
  createDirectorProjectAccess,
  toDirectorActor,
  type DirectorActor,
  type DirectorProjectAccessPort,
} from "../projectAccess.js";
import { createPgDirectorDb } from "../scene/repository.js";
import {
  PgDirectorCaptureRepository,
  type DirectorCapturePlacement,
  type PersistDirectorCaptureResult,
  type PersistDirectorCaptureInput,
} from "./repository.js";

export const DIRECTOR_CAPTURE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DIRECTOR_CAPTURE_MAX_DIMENSION_PX = 4096;

export interface DirectorCaptureImageInfo {
  format: string;
  contentType: string;
  width: number;
  height: number;
}

export interface DirectorCaptureUploadInput {
  actor: DirectorActor;
  projectId: string;
  fileName: string;
  declaredContentType?: string | null;
  content: Buffer;
  placement?: DirectorCapturePlacement;
  title?: string;
}

export interface DirectorCaptureRepositoryPort {
  assertPlacement(projectId: string, placement: DirectorCapturePlacement): Promise<void>;
  persistCapture(input: PersistDirectorCaptureInput): Promise<PersistDirectorCaptureResult>;
}

export interface DirectorCaptureStoragePort {
  uploadBytes(content: Buffer, storagePath: string, contentType: string): Promise<StoredObject>;
  deleteObject(storagePath: string): Promise<void>;
}

export interface DirectorCaptureServiceDependencies {
  repository?: DirectorCaptureRepositoryPort;
  projectAccess?: DirectorProjectAccessPort;
  storage?: DirectorCaptureStoragePort;
  inspectImage?: (content: Buffer) => Promise<DirectorCaptureImageInfo>;
  createIds?: () => { assetEntityId: string; assetMediaId: string };
}

export class DirectorCaptureService {
  private readonly repository: DirectorCaptureRepositoryPort;
  private readonly projectAccess: DirectorProjectAccessPort;
  private readonly storage: DirectorCaptureStoragePort;
  private readonly inspectImage: (content: Buffer) => Promise<DirectorCaptureImageInfo>;
  private readonly createIds: () => { assetEntityId: string; assetMediaId: string };

  constructor(db: Database, dependencies: DirectorCaptureServiceDependencies = {}) {
    this.repository = dependencies.repository ?? new PgDirectorCaptureRepository(createPgDirectorDb(db));
    this.projectAccess = dependencies.projectAccess ?? createDirectorProjectAccess(db);
    this.storage = dependencies.storage ?? new TosStorage();
    this.inspectImage = dependencies.inspectImage ?? inspectDirectorCapturePng;
    this.createIds = dependencies.createIds
      ?? (() => ({ assetEntityId: randomUUID(), assetMediaId: randomUUID() }));
  }

  async assertProjectCreateAccess(actorInput: DirectorActor, projectId: string): Promise<void> {
    await this.projectAccess.require(toDirectorActor(actorInput), projectId, "create");
  }

  async upload(input: DirectorCaptureUploadInput): Promise<Record<string, unknown>> {
    if (!input.content.length) throw new BadRequestError("上传截图不能为空");
    if (input.declaredContentType && input.declaredContentType !== "image/png") {
      throw new BadRequestError("上传截图没成：文件格式不支持，请更换截图。");
    }
    if (input.content.length > DIRECTOR_CAPTURE_MAX_FILE_BYTES) {
      throw new BadRequestError("上传截图没成：文件不能超过 10 兆。");
    }

    const image = await this.inspectImage(input.content);

    // 写对象存储前先做全部权限与归属校验。项目访问一律复用
    // ProjectAccessService；上传失败不会留下未授权 TOS 对象。
    const actor = toDirectorActor(input.actor);
    await this.assertProjectCreateAccess(actor, input.projectId);
    const placement = input.placement ?? {};
    await this.repository.assertPlacement(input.projectId, placement);

    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const ids = this.createIds();
    const storagePath = buildDirectorCaptureStoragePath(input.projectId, ids.assetMediaId, sha256);
    const stored = await this.storage.uploadBytes(input.content, storagePath, image.contentType);

    const title = normaliseTitle(input.title, input.fileName);
    try {
      const persisted = await this.repository.persistCapture({
        actorId: actor.id,
        projectId: input.projectId,
        assetEntityId: ids.assetEntityId,
        assetMediaId: ids.assetMediaId,
        title,
        originalFileName: safeFileName(input.fileName).slice(0, 512),
        declaredContentType: input.declaredContentType,
        sha256,
        image,
        stored,
        placement,
      });
      return {
        assetEntityId: persisted.assetEntityId,
        assetMediaId: persisted.assetMediaId,
        projectAssetRefId: persisted.projectAssetRefId,
        projectId: input.projectId,
        episodeId: placement.episodeId ?? null,
        sceneId: placement.sceneId ?? null,
        shotId: placement.shotId ?? null,
        title,
        status: "approved",
        approved: true,
        storageBucket: stored.bucket,
        storagePath: stored.storagePath,
        storageUrl: stored.storageUrl,
        widthPx: image.width,
        heightPx: image.height,
        sha256,
      };
    } catch (error) {
      // 补偿：DB 事务失败时必须删掉刚上传的 TOS 对象，孤儿对象不允许残留。
      // 清理失败不覆盖原始的 DB 错误。
      await this.storage.deleteObject(stored.storagePath).catch(() => undefined);
      throw error;
    }
  }
}

/** PNG 实解码校验：sharp 读元数据 + stats() 强制解码像素，尺寸双边上限。 */
export async function inspectDirectorCapturePng(content: Buffer): Promise<DirectorCaptureImageInfo> {
  if (!content.length) throw new BadRequestError("上传截图不能为空");
  try {
    const image = sharp(content, {
      failOn: "error",
      limitInputPixels: DIRECTOR_CAPTURE_MAX_DIMENSION_PX * DIRECTOR_CAPTURE_MAX_DIMENSION_PX,
    });
    const metadata = await image.metadata();
    if (metadata.format !== "png") {
      throw new BadRequestError("上传截图没成：文件格式不支持，请更换截图。");
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) throw new BadRequestError("截图尺寸不可读");
    if (width > DIRECTOR_CAPTURE_MAX_DIMENSION_PX || height > DIRECTOR_CAPTURE_MAX_DIMENSION_PX) {
      throw new BadRequestError(`截图宽高不能超过 ${DIRECTOR_CAPTURE_MAX_DIMENSION_PX} 像素`);
    }
    await image.stats();
    return { format: "png", contentType: "image/png", width, height };
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    if (error instanceof Error && /exceeds pixel limit/i.test(error.message)) {
      throw new BadRequestError(`截图宽高不能超过 ${DIRECTOR_CAPTURE_MAX_DIMENSION_PX} 像素`);
    }
    throw new BadRequestError("上传截图没成：文件不是有效图片或已经损坏。");
  }
}

export function buildDirectorCaptureStoragePath(projectId: string, mediaId: string, sha256: string): string {
  const safeProjectId = assertUuidPathPart(projectId, "projectId");
  const safeMediaId = assertUuidPathPart(mediaId, "mediaId");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("sha256 is invalid");
  return path.posix.join("prod", "director", safeProjectId, "captures", `${safeMediaId}_${sha256.slice(0, 16)}.png`);
}

function normaliseTitle(title: string | undefined, fileName: string): string {
  const explicit = title?.trim();
  if (explicit) return explicit.slice(0, 128);
  const base = path.parse(safeFileName(fileName)).name.trim();
  return (base || "导演台截图").slice(0, 128);
}

function assertUuidPathPart(value: string, label: string): string {
  const normalised = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalised)) {
    throw new Error(`${label} is not a UUID`);
  }
  return normalised;
}
