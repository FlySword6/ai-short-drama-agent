import { DIRECTOR_SOURCE_PROJECT_ID } from "./directorManifestImport.js";
import { isAssetImageMediaKind } from "./assetImageKinds.js";
import {
  directorPreviewBinding,
  hasDirectorPreviewIntent,
} from "./directorPreviewBinding.js";
import { isAssetMediaRenditionStoragePath } from "./mediaDisplay.js";
import type {
  AssetMediaHealthIssue,
  AssetMediaHealthView,
  AssetRepairBundle,
  AssetRepairMediaSnapshot,
} from "./mediaRepairTypes.js";

const renditionFailureCodes = new Set(["source_object_missing", "source_object_unreadable"]);

export function diagnoseAssetMedia(
  bundle: AssetRepairBundle,
  checkedAt = new Date(),
): AssetMediaHealthView {
  const issues: AssetMediaHealthIssue[] = [];
  const variants = new Map(bundle.variants.filter((item) => !item.deletedAt).map((item) => [item.id, item]));
  const activeMedia = bundle.media.filter((item) => !item.deletedAt);
  const invalidPreviewIds = new Set<string>();
  for (const candidate of activeMedia) {
    if (
      isAssetImageMediaKind(candidate.mediaKind)
      && hasDirectorPreviewIntent(candidate.metadata)
      && !activeMedia.some((source) =>
        source.mediaKind === "model_3d"
        && isBoundModelPreview(source, candidate, variants)
      )
    ) {
      invalidPreviewIds.add(candidate.id);
    }
  }
  if (activeMedia.length === 0) {
    issues.push(issue(
      "asset_media_missing",
      null,
      null,
      "这件资产还没有任何媒体文件，需先补齐来源。",
      false,
      true,
    ));
  }
  const renditionsByMedia = new Map<string, typeof bundle.renditions>();
  for (const rendition of bundle.renditions) {
    const values = renditionsByMedia.get(rendition.assetMediaId) ?? [];
    values.push(rendition);
    renditionsByMedia.set(rendition.assetMediaId, values);
  }

  for (const media of activeMedia) {
    const variant = media.assetVariantId ? variants.get(media.assetVariantId) : undefined;
    if (!media.assetEntityId && !media.assetVariantId) {
      issues.push(issue("media_unbound", media.id, null, "这份素材没有归属资产，需人工确认后再修复。", false, true));
    }
    if (media.assetVariantId && !variant) {
      issues.push(issue("media_variant_missing", media.id, null, "这份素材关联的资产版本已不存在，需人工确认归属。", false, true));
    }
    if (media.assetEntityId && variant && variant.assetEntityId !== media.assetEntityId) {
      issues.push(issue(
        "media_entity_variant_mismatch",
        media.id,
        null,
        "这份素材的资产与版本归属不一致，后端不会猜测覆盖。",
        false,
        true,
      ));
    }
    if (!media.storageBucket || !media.storagePath) {
      issues.push(issue(
        "source_locator_missing",
        media.id,
        null,
        "这份素材缺少可验证的存储位置，需补齐来源后再修复。",
        false,
        true,
      ));
    }

    if (isAssetImageMediaKind(media.mediaKind)) {
      if (!hasCompleteImageFacts(media)) {
        issues.push(issue(
          "image_metadata_missing",
          media.id,
          null,
          "图片尺寸、格式或内容指纹不完整，可由后端读取原文件后补齐。",
          true,
          false,
        ));
      }
      const renditions = renditionsByMedia.get(media.id) ?? [];
      for (const kind of ["thumbnail", "detail"] as const) {
        const rendition = renditions.find((item) => item.renditionKind === kind);
        if (!rendition) {
          issues.push(issue(
            kind === "thumbnail" ? "image_thumbnail_missing" : "image_detail_missing",
            media.id,
            kind,
            kind === "thumbnail"
              ? "列表缩略图尚未核验，后端可自动生成展示变体。"
              : "详情展示图尚未核验，后端可自动生成展示变体。",
            true,
            false,
          ));
          continue;
        }
        if (rendition.status === "failed") {
          const code = renditionFailureCodes.has(rendition.errorCode ?? "")
            ? rendition.errorCode as "source_object_missing" | "source_object_unreadable"
            : "rendition_failed";
          issues.push(issue(
            code,
            media.id,
            kind,
            code === "source_object_missing"
              ? "原文件在存储中不存在，不能生成展示图。"
              : code === "source_object_unreadable"
                ? "原文件暂时无法读取，修复任务已停止。"
                : "展示图生成失败，可重新发起安全修复。",
            code === "rendition_failed",
            code !== "rendition_failed",
          ));
        } else if (rendition.status === "stale" || !isCompleteHealthyRendition(media, rendition)) {
          issues.push(issue(
            "rendition_stale",
            media.id,
            kind,
            "展示图与当前原文件版本不一致，可由后端重新核验。",
            true,
            false,
          ));
        } else if (rendition.status !== "healthy") {
          issues.push(issue(
            kind === "thumbnail" ? "image_thumbnail_missing" : "image_detail_missing",
            media.id,
            kind,
            "展示图尚未就绪，可由后端继续安全修复。",
            true,
            false,
          ));
        }
      }
    }

    if (media.mediaKind === "model_3d") {
      const preview = activeMedia.find((candidate) =>
        isAssetImageMediaKind(candidate.mediaKind)
        && isBoundModelPreview(media, candidate, variants)
      );
      if (!preview) {
        issues.push(issue(
          "model_preview_missing",
          media.id,
          "thumbnail",
          "3D 素材还没有渲染预览图，需先完成离屏渲染清单。",
          false,
          true,
        ));
      }
    }
  }

  if (
    bundle.asset.sourceProjectId === DIRECTOR_SOURCE_PROJECT_ID
    && !hasChineseVisualDescription(bundle.asset.metadata)
  ) {
    issues.push(issue(
      "director_chinese_description_missing",
      null,
      null,
      "这件导演资产还没有经确认的中文视觉描述，中文检索信息不完整。",
      false,
      true,
    ));
  }

  const affectedMedia = new Set(issues.flatMap((item) => item.mediaId ? [item.mediaId] : []));
  const status = bundle.activeRepairTaskId
    ? "repairing"
    : issues.some((item) => item.blocker)
      ? "broken"
      : issues.length
        ? "degraded"
        : "healthy";
  return {
    assetId: bundle.asset.id,
    status,
    activeRepairTaskId: bundle.activeRepairTaskId,
    issues,
    mediaCount: activeMedia.length,
    healthyMediaCount: activeMedia.filter((item) => !affectedMedia.has(item.id) && !invalidPreviewIds.has(item.id)).length,
    checkedAt,
  };
}

function isCompleteHealthyRendition(
  media: AssetRepairMediaSnapshot,
  rendition: AssetRepairBundle["renditions"][number],
): boolean {
  if (
    rendition.status !== "healthy"
    || rendition.strategy !== "stored_object"
    || !rendition.storageBucket
    || !isAssetMediaRenditionStoragePath(rendition.storagePath)
    || !rendition.checkedAt
    || !rendition.sourceSha256
    || !media.sha256
    || rendition.sourceSha256 !== media.sha256
    || rendition.format?.toLowerCase() !== "webp"
    || !rendition.sha256
    || !/^[0-9a-f]{64}$/u.test(rendition.sha256)
    || !rendition.widthPx
    || !rendition.heightPx
  ) return false;
  if (rendition.renditionKind === "thumbnail") {
    return rendition.widthPx === 320 && rendition.heightPx === 180;
  }
  return rendition.widthPx <= 1280 && rendition.heightPx <= 720;
}

export function isBoundModelPreview(
  source: AssetRepairMediaSnapshot,
  candidate: AssetRepairMediaSnapshot,
  activeVariants: ReadonlyMap<string, AssetRepairBundle["variants"][number]>,
): boolean {
  const sourceOwnerId = legalAssetOwnerId(source, activeVariants);
  const candidateOwnerId = legalAssetOwnerId(candidate, activeVariants);
  const binding = directorPreviewBinding(candidate.metadata);
  return source.deletedAt === null
    && candidate.deletedAt === null
    && source.approved === true
    && candidate.approved === true
    && sourceOwnerId !== null
    && sourceOwnerId === candidateOwnerId
    && source.assetVariantId === candidate.assetVariantId
    && binding?.sourceMediaId === source.id
    && typeof source.sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(source.sha256)
    && binding.sourceSha256 === source.sha256;
}

function legalAssetOwnerId(
  media: AssetRepairMediaSnapshot,
  activeVariants: ReadonlyMap<string, AssetRepairBundle["variants"][number]>,
): string | null {
  const variant = media.assetVariantId ? activeVariants.get(media.assetVariantId) : undefined;
  if (media.assetVariantId && !variant) return null;
  if (media.assetEntityId && variant && media.assetEntityId !== variant.assetEntityId) return null;
  return media.assetEntityId ?? variant?.assetEntityId ?? null;
}

function issue(
  code: AssetMediaHealthIssue["code"],
  mediaId: string | null,
  renditionKind: AssetMediaHealthIssue["renditionKind"],
  displayReason: string,
  autoRepairable: boolean,
  blocker: boolean,
): AssetMediaHealthIssue {
  return { code, mediaId, renditionKind, displayReason, autoRepairable, blocker };
}

function hasCompleteImageFacts(media: AssetRepairMediaSnapshot): boolean {
  return Boolean(
    media.widthPx
    && media.heightPx
    && media.widthPx > 0
    && media.heightPx > 0
    && media.format
    && media.sha256
    && /^[0-9a-f]{64}$/u.test(media.sha256),
  );
}

function hasChineseVisualDescription(metadata: Record<string, unknown>): boolean {
  const value = metadata.visual_description_zh;
  return typeof value === "string"
    && value.trim().length >= 8
    && /[\u3400-\u9fff]/u.test(value);
}
