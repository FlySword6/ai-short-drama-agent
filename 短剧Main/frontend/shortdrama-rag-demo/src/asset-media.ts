import type { MediaVersion, ProjectAssetRef } from "./types";
import { readSessionToken } from "./auth-token";

/* S11-5：与后端 ASSET_MEDIA_MAX_FILE_BYTES 统一（原 100MB 会被后端实际拒收）。 */
export const MAX_ASSET_IMAGE_BYTES = 10 * 1024 * 1024;

const supportedExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff", "bmp"]);
const supportedContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/tiff",
  "image/bmp",
  "image/x-ms-bmp",
]);

export function assetImageValidationError(file: Pick<File, "name" | "size" | "type">): string {
  if (file.size <= 0) return "图片文件不能为空";
  if (file.size > MAX_ASSET_IMAGE_BYTES) return "图片不能超过 10 MB";
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!supportedContentTypes.has(file.type.toLowerCase()) && !supportedExtensions.has(extension)) {
    return "请选择 JPG、PNG、WebP、GIF、AVIF、TIFF 或 BMP 图片";
  }
  return "";
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

export function selectReferenceMediaVersion(versions: MediaVersion[]): MediaVersion | null {
  const usable = versions.filter((version) => {
    const kind = version.media_kind?.toLowerCase() ?? "image";
    return Boolean(version.id && version.storage_url)
      && !kind.includes("video")
      && !kind.includes("audio");
  });
  return usable.find((version) => version.is_primary) ?? usable[0] ?? null;
}

/** 取项目资产引用对应的媒体版本（用于格式判定）。 */
export function refMediaVersion(ref: ProjectAssetRef): MediaVersion | null {
  return ref.version_snapshot?.media ?? ref.asset?.current_media ?? null;
}

/**
 * 生成参考图资格（W5 联调合同）：只有图片类媒体可被 @ 引用（i2v 首帧/参考图）。
 * 3D 素模（format=glb / media_kind=model_3d）的引用场景是导演台，不参与生成引用。
 * 无 format 元数据的老数据按 media_kind 判断；两者都缺省视为图片（历史图片资产未标注）。
 */
export function isImageReferenceMedia(media: MediaVersion | null | undefined): boolean {
  if (!media) return false;
  const format = media.format?.trim().toLowerCase() ?? "";
  if (format) return supportedExtensions.has(format);
  const kind = media.media_kind?.trim().toLowerCase() ?? "";
  if (!kind) return true;
  return !kind.includes("video") && !kind.includes("audio") && !kind.includes("model") && !kind.includes("3d");
}

/**
 * 项目资产引用是否可作为生成参考图。
 * 媒体对象缺失时放行（旧数据无快照；加入项目时服务端已要求图片版本）。
 */
export function refIsImageReference(ref: ProjectAssetRef): boolean {
  const media = refMediaVersion(ref);
  if (!media) return true;
  return isImageReferenceMedia(media);
}

/**
 * S46 C-0 裂图修复：URL 能否进 <img>。
 * 尾缀命中支持图片格式才放行；无尾缀（签名直链）放行——历史图片资产多为无尾缀 URL，
 * 拦它们会让有图资产回归；非图片尾缀（glb/mp4…）拦下，调用方走类型图标占位。
 * 判据与 isImageReferenceMedia 的 format 分支同源（同一个 supportedExtensions）。
 */
export function isDisplayableImageUrl(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? "";
  const match = /\.([a-z0-9]+)$/i.exec(path);
  const extension = match?.[1];
  if (!extension) return true;
  return supportedExtensions.has(extension.toLowerCase());
}

/**
 * S46 C-0：资产主媒体（selected 优先，否则 current）不是图片时，其 URL 不得作缩略图。
 * 媒体信息缺失时放行（老数据无快照，维持原取 URL 行为）。
 */
export function assetMediaIsNonImage(asset: { selected_media?: MediaVersion | null; current_media?: MediaVersion | null }): boolean {
  const media = asset.selected_media ?? asset.current_media;
  return Boolean(media) && !isImageReferenceMedia(media);
}

/**
 * 生成同源代理的候选地址。调用方只应在浏览器直读失败后使用它；
 * 桶地址的唯一真源在后端运行时配置，前端不复制桶名或域名。
 */
export function mediaFetchUrl(url: string): string {
  try {
    const candidate = new URL(url);
    if (candidate.protocol === "http:" || candidate.protocol === "https:") {
      return `/api/v1/media/tos-images?url=${encodeURIComponent(candidate.toString())}`;
    }
  } catch {
    // 非绝对地址沿用原值，让调用方按原有业务错误处理。
  }
  return url;
}

/**
 * 先保留浏览器原有的直读能力。只有浏览器因跨域策略读不到像素时，才回落到
 * 登录保护的本站代理；历史 CDN 和数据湖外链不会被误送给仅允许 TOS 的后端。
 */
export async function fetchReadableImage(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (directError) {
    const target = mediaFetchUrl(url);
    if (target === url) throw directError;
    return fetchAuthenticatedMediaProxy(target, init);
  }
}

function fetchAuthenticatedMediaProxy(target: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = readSessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(target, { ...init, headers });
}
