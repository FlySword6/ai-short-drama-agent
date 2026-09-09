import { createHash } from "node:crypto";

export interface DeliverableMediaInput {
  projectId: string;
  projectName: string;
  episodeId: string;
  episodeNo: number;
  shotId: string;
  shotCode: string;
  shotSortOrder: number;
  mediaId: string;
  mediaKind: "image" | "video";
  originKind: "generation" | "asset_media";
  sourceAssetMediaId: string | null;
  storageUrl: string;
  storagePath: string;
  mimeType: string | null;
  durationSeconds: number | null;
  generationRequestId: string | null;
  generationAttemptId: string | null;
  provider: string | null;
  model: string | null;
  parameters: Record<string, unknown>;
  estimatedCostFen: number;
}

/** Repository rows carry the review fact the gate needs; the manifest never exposes it. */
export interface GatedDeliverableMedia extends DeliverableMediaInput {
  reviewStatus: string;
}

export interface DeliveryGap {
  shotId: string;
  shotCode: string;
  reason: "missing_video_primary" | "invalid_image_primary" | "video_not_accepted" | "image_not_accepted";
}

export interface DeliverableManifest {
  version: "v0.1";
  generatedAt: string;
  project: { id: string; name: string };
  episode: { id: string; no: number };
  estimatedCostFen: number;
  estimatedCostNotice: "预估消耗，非云平台实际账单";
  items: DeliverableMediaInput[];
}

export function buildDeliverableManifest(
  source: DeliverableMediaInput[],
  generatedAt = new Date(),
): DeliverableManifest {
  if (!source.length) throw new Error("当前集没有可交付的主版本媒体");
  const first = source[0];
  if (!first) throw new Error("当前集没有可交付的主版本媒体");
  const items = [...source]
    .filter((item) => item.storageUrl && item.storagePath)
    .sort((a, b) => a.shotSortOrder - b.shotSortOrder || a.mediaKind.localeCompare(b.mediaKind));
  if (!items.length) throw new Error("主版本媒体尚未持久化到 TOS");
  if (items.some((item) => item.projectId !== first.projectId || item.episodeId !== first.episodeId)) {
    throw new Error("交付清单不能混入其他项目或集的媒体");
  }
  return {
    version: "v0.1",
    generatedAt: generatedAt.toISOString(),
    project: { id: first.projectId, name: first.projectName },
    episode: { id: first.episodeId, no: first.episodeNo },
    estimatedCostFen: items.reduce((sum, item) => sum + item.estimatedCostFen, 0),
    estimatedCostNotice: "预估消耗，非云平台实际账单",
    items,
  };
}

export function buildPlaybackList(manifest: DeliverableManifest): DeliverableMediaInput[] {
  return manifest.items
    .filter((item) => item.mediaKind === "video")
    .sort((a, b) => a.shotSortOrder - b.shotSortOrder);
}

/**
 * Content hash of a manifest snapshot: volatile fields (generatedAt, notices,
 * cost annotations) are excluded so two deliveries of unchanged content hash
 * identically and stay comparable in delivery history.
 */
export function hashDeliverableManifest(manifest: DeliverableManifest): string {
  const canonical = {
    project_id: manifest.project.id,
    episode_id: manifest.episode.id,
    items: [...manifest.items]
      .sort((a, b) => a.shotSortOrder - b.shotSortOrder || a.mediaKind.localeCompare(b.mediaKind))
      .map((item) => ({
        shot_code: item.shotCode,
        media_kind: item.mediaKind,
        media_id: item.mediaId,
        storage_path: item.storagePath,
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function manifestToCsv(manifest: DeliverableManifest): string {
  const header = [
    "project_id",
    "project_name",
    "episode_no",
    "shot_code",
    "media_kind",
    "media_id",
    "origin_kind",
    "source_asset_media_id",
    "storage_url",
    "storage_path",
    "provider",
    "model",
    "generation_request_id",
    "generation_attempt_id",
    "estimated_cost_fen",
  ];
  const rows = manifest.items.map((item) => [
    item.projectId,
    item.projectName,
    item.episodeNo,
    item.shotCode,
    item.mediaKind,
    item.mediaId,
    item.originKind,
    item.sourceAssetMediaId,
    item.storageUrl,
    item.storagePath,
    item.provider,
    item.model,
    item.generationRequestId,
    item.generationAttemptId,
    item.estimatedCostFen,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
