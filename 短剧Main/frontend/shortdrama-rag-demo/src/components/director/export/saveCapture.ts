/**
 * 3D 导演台 · 导出产物保存到资产库（纯 TS，不 import React）
 *
 * P0 衔接流管线：renderStaticExport(kind) 渲出 PNG Blob（机位截图/分镜宫格/深度图）
 * → saveBlobToLibrary 走 FormData POST /api/v1/projects/:projectId/director/captures
 * （不手设 content-type，浏览器自动带 multipart 边界；鉴权 Bearer 由 api.ts 附带）。
 * 后端同事务创建 asset_entity + asset_media + project_asset_refs——
 * 「存资产库 + 自动引入当前项目」一步完成，归参考清单由 onExported 宿主路径负责。
 *
 * 后端契约（captures/service.ts）：仅 file + title 两个字段（part 上限 5），仅收 PNG，
 * 201 返回 { assetEntityId, assetMediaId, title, storageUrl, ... }。
 *
 * V0.1.1 移植适配：旧仓走 /api/director/captures 同源 cookie + sceneSnapshot 字段；
 * 新后端字段收口为 file/title，场景留痕改由 PUT scene 的版本记录承担。
 */
import { postDirectorCapture } from "../api";
import { renderCameraShot } from "./captureShot";
import { renderCameraGrid } from "./exportGrid";
import { renderDepthMap } from "./depthMap";

/** 可入资产库的静态导出种类（运镜小样是 WebM 视频，captures 端点仅收 PNG，不走本管线） */
export type StaticExportKind = "shot" | "grid" | "depth";

export type SaveCameraShotResult =
  | { ok: true; assetId: string; assetMediaId?: string; title: string; previewUrl: string }
  | { ok: false; error: string };

/** 静态导出渲染产物：PNG Blob + 资产库标题 + 可选缩略图（归组条目用） */
export interface RenderedStaticExport {
  blob: Blob;
  title: string;
  thumbUrl: string | null;
}

/**
 * 按种类渲染静态导出产物（不触发下载、不 POST）：
 * shot=活动机位截图；grid=全部机位 2 列宫格；depth=活动机位深度图（近亮远暗）。
 * 运行时未就绪/机位无效 → null（各 render 内部已 console.warn）。
 */
export async function renderStaticExport(kind: StaticExportKind): Promise<RenderedStaticExport | null> {
  if (kind === "shot") {
    const shot = await renderCameraShot();
    return shot ? { blob: shot.blob, title: `导演台-${shot.meta.cameraName}`, thumbUrl: null } : null;
  }
  if (kind === "grid") {
    const grid = await renderCameraGrid();
    return grid ? { blob: grid.blob, title: "导演台-分镜宫格", thumbUrl: null } : null;
  }
  const depth = await renderDepthMap();
  return depth
    ? { blob: depth.blob, title: `导演台-${depth.meta.cameraName}-深度图`, thumbUrl: depth.thumbUrl }
    : null;
}

/** 通用入口：PNG Blob 直接入资产库（宫格/深度图等不走 renderCameraShot 的导出复用） */
export async function saveBlobToLibrary(
  projectId: string,
  blob: Blob,
  title: string,
): Promise<SaveCameraShotResult> {
  const formData = new FormData();
  const fileName = title.endsWith(".png") ? title : `${title}.png`;
  formData.set("file", blob, fileName);
  formData.set("title", title);

  try {
    const data = await postDirectorCapture(projectId, formData);
    return {
      ok: true,
      assetId: data.assetEntityId,
      assetMediaId: data.assetMediaId,
      title: data.title,
      previewUrl: data.storageUrl,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "保存失败，请稍后重试" };
  }
}

/** 渲染当前机位截图并入资产库（renderCameraShot + saveBlobToLibrary 的便捷组合） */
export async function saveCameraShotToLibrary(
  projectId: string,
  cameraId?: string,
): Promise<SaveCameraShotResult> {
  const shot = await renderCameraShot(cameraId);
  if (!shot) {
    return { ok: false, error: "渲染运行时未就绪或机位无效" };
  }
  return saveBlobToLibrary(projectId, shot.blob, `导演台-${shot.meta.cameraName}`);
}
