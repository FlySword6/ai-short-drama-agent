/* ============================================================
   demo-delivery.ts — K2U 幕四彩排:连播与交付清单的离线内容生成器(v2 重落)

   为什么存在:审计 D-14/D-18/D-19 指出 demo 下三处回放是空态、连播页脚交付清单
   永远渲染不出来、三处导出入口只弹「离线演示不会下载真实文件」。本文件从真源
   派生连播清单与交付清单内容——不另写一份媒体表。

   v2 与旧 K2U 的差别(换 K2A 真源线,旧分支 feature/v011-k2-demo-act4 作废):
   - 真源 = demo.ts 的 demoShotMedia(K2A 表,id 族 demo-image-N/demo-video-N,
     review_status=accepted/needs_review/rejected);旧 K2P 的 demo-shot-media-N
     id 族与「已选中持久化主版本」静态口径一并作废;
   - 交付闸门与 demo-review-delivery 同一口径:视频主版本须 accepted(先审后交)。
     审核队列会话里的裁决会真影响连播与这份清单(拒绝主版本 → 该镜退出连播、
     缺口记 video_not_accepted),队列/交付/连播/导出预览四处说同一件事。

   合同口径(与后端 src/modules/delivery/manifest.ts 一致,不发明字段):
   - items 形状 = DeliverableItem(wire snake_case);
   - JSON 文本形状 = deliverables?partial=true 的 wire(version/generated_at/
     project/episode/estimated_cost_fen/estimated_cost_notice/items/partial/gaps);
   - CSV 列 = manifestToCsv 同款 15 列,转义规则一致;
   - 缺口原因只用后端枚举(DeliveryGapReason),本 fixture 只会出现
     missing_video_primary(#6 没有视频主版本);会话里拒绝主版本会出现
     video_not_accepted。

   诚实边界:
   - 视频地址是 public/demo-media 的本地占位小样(4 秒可播),不是 TOS 成片;
   - 内容只在内存生成,界面给预览/复制,不落盘。
   ============================================================ */
import { demoEpisodes, demoProjects, demoShotMedia, demoShots } from "./demo";
import { demoDeliveryGaps, demoReadyVideoIds } from "./demo-review-delivery";
import type { DeliveryGap } from "./review-delivery";
import type { DeliverableItem, EpisodePlayback } from "./types";

/** demo 清单的 generated_at 固定——内容可复算、测试可断言,不代表真实交付时间。 */
const DEMO_GENERATED_AT = "2026-07-23T09:30:00.000Z";
const DEMO_COST_NOTICE = "离线示例 · 预估消耗，非云平台实际账单";
/** 占位估价(分):与 dashboard demo 消耗同量级,只用于清单合计演示。 */
const DEMO_IMAGE_COST_FEN = 260;
const DEMO_VIDEO_COST_FEN = 1480;
/** 占位小样统一 4 秒(public/demo-media/ep1-shot-N.mp4 实测时长)。 */
const DEMO_VIDEO_DURATION_SECONDS = 4;

/** 空连播:无可交付主版本的集(克隆集/未知集)如实为空,与旧 EMPTY_PLAYBACK 同语义。 */
export const EMPTY_DEMO_PLAYBACK: EpisodePlayback = {
  version: "v0.1",
  generated_at: "",
  project: { id: "", name: "" },
  episode: { id: "", no: 0 },
  estimated_cost_fen: 0,
  estimated_cost_notice: DEMO_COST_NOTICE,
  items: [],
  playback: [],
};

interface DemoManifestParts {
  projectId: string;
  projectName: string;
  episodeId: string;
  episodeNo: number;
  items: DeliverableItem[];
  gaps: DeliveryGap[];
}

function itemFor(input: {
  projectId: string;
  projectName: string;
  episodeId: string;
  episodeNo: number;
  shotId: string;
  shotCode: string;
  shotSortOrder: number;
  mediaId: string;
  mediaKind: "image" | "video";
  storageUrl: string;
}): DeliverableItem {
  const kind = input.mediaKind;
  return {
    project_id: input.projectId,
    project_name: input.projectName,
    episode_id: input.episodeId,
    episode_no: input.episodeNo,
    shot_id: input.shotId,
    shot_code: input.shotCode,
    shot_sort_order: input.shotSortOrder,
    media_id: input.mediaId,
    media_kind: kind,
    storage_url: input.storageUrl,
    storage_path: `demo-offline/ep1/shot-${input.shotCode}.${kind === "video" ? "mp4" : "svg"}`,
    mime_type: kind === "video" ? "video/mp4" : "image/svg+xml",
    duration_seconds: kind === "video" ? DEMO_VIDEO_DURATION_SECONDS : null,
    generation_request_id: `demo-gen-req-${input.shotCode}-${kind}`,
    generation_attempt_id: `demo-gen-attempt-${input.shotCode}-${kind}`,
    provider: "offline-demo",
    model: "离线示例模型",
    parameters: {},
    estimated_cost_fen: kind === "video" ? DEMO_VIDEO_COST_FEN : DEMO_IMAGE_COST_FEN,
  };
}

/** 从 K2A 真源派生清单部件:可交付镜(视频主版本过审,口径=demo-review-delivery
    会话仓)出 items,缺口镜逐镜列出(同一会话仓,拒绝主版本会话内生效)。 */
function manifestParts(episodeId: string): DemoManifestParts | null {
  const episode = demoEpisodes.find((item) => item.id === episodeId);
  if (!episode) return null;
  const project = demoProjects.find((item) => item.id === episode.project_id);
  const readyVideoIds = new Set(demoReadyVideoIds(episodeId));
  const shots = demoShots
    .filter((shot) => shot.episode_id === episodeId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const items: DeliverableItem[] = [];
  for (const shot of shots) {
    const media = demoShotMedia[shot.id] ?? [];
    const video = media.find((item) => item.media_kind === "video" && item.is_primary && item.persistence_status === "persisted" && item.id === shot.selected_video_result_id && readyVideoIds.has(item.id) && Boolean(item.storage_url));
    if (!video?.storage_url) continue; /* 缺口镜:由 demoDeliveryGaps 逐镜列出,不进 items */
    const image = media.find((item) => item.media_kind === "image" && item.is_primary && item.persistence_status === "persisted" && item.id === shot.selected_image_result_id && Boolean(item.storage_url));
    const base = {
      projectId: episode.project_id,
      projectName: project?.name ?? "离线示例项目",
      episodeId: episode.id,
      episodeNo: episode.episode_no,
      shotId: shot.id,
      shotCode: shot.shot_no,
      shotSortOrder: shot.sort_order ?? 0,
    };
    /* 与后端 buildDeliverableManifest 同序:shotSortOrder 后 mediaKind(image 在 video 前)。 */
    if (image?.storage_url) items.push(itemFor({ ...base, mediaId: image.id, mediaKind: "image", storageUrl: image.storage_url }));
    items.push(itemFor({ ...base, mediaId: video.id, mediaKind: "video", storageUrl: video.storage_url }));
  }
  return { projectId: episode.project_id, projectName: project?.name ?? "离线示例项目", episodeId: episode.id, episodeNo: episode.episode_no, items, gaps: demoDeliveryGaps(episodeId) };
}

/** 连播数据:与 GET /episodes/:id/playback 同形状(manifest + 视频主版本顺序表)。 */
export function demoEpisodePlayback(episodeId: string): EpisodePlayback {
  const parts = manifestParts(episodeId);
  if (!parts) return EMPTY_DEMO_PLAYBACK;
  const manifest = {
    version: "v0.1" as const,
    generated_at: DEMO_GENERATED_AT,
    project: { id: parts.projectId, name: parts.projectName },
    episode: { id: parts.episodeId, no: parts.episodeNo },
    estimated_cost_fen: parts.items.reduce((sum, item) => sum + item.estimated_cost_fen, 0),
    estimated_cost_notice: DEMO_COST_NOTICE,
    items: parts.items,
  };
  return { ...manifest, playback: parts.items.filter((item) => item.media_kind === "video") };
}

/* ---------- CSV:与后端 manifestToCsv 同款 15 列与转义 ---------- */

const CSV_HEADER = [
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

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function demoManifestToCsv(items: readonly DeliverableItem[]): string {
  const rows = items.map((item) => [
    item.project_id,
    item.project_name,
    item.episode_no,
    item.shot_code,
    item.media_kind,
    item.media_id,
    "generation",
    "",
    item.storage_url,
    item.storage_path,
    item.provider,
    item.model,
    item.generation_request_id,
    item.generation_attempt_id,
    item.estimated_cost_fen,
  ]);
  return [CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

/* ---------- 导出预览(D-19):内存生成 JSON/CSV 文本,界面展示/复制,不落盘 ---------- */

export interface DemoDeliveryPreview {
  episodeId: string;
  episodeNo: number;
  projectName: string;
  /** deliverables?partial=true wire 形状的 JSON 文本(含 partial/gaps)。 */
  jsonText: string;
  /** 与后端 deliverables.csv 同列的 CSV 文本。 */
  csvText: string;
  itemCount: number;
  imageCount: number;
  videoCount: number;
  estimatedCostFen: number;
  gaps: DeliveryGap[];
}

/** 生成导出预览内容;整集没有可交付主版本时返回 null(对应真栈 409 的人话态)。 */
export function buildDemoDeliveryPreview(episodeId: string): DemoDeliveryPreview | null {
  const parts = manifestParts(episodeId);
  if (!parts || parts.items.length === 0) return null;
  const estimatedCostFen = parts.items.reduce((sum, item) => sum + item.estimated_cost_fen, 0);
  const manifestWire = {
    version: "v0.1",
    generated_at: DEMO_GENERATED_AT,
    project: { id: parts.projectId, name: parts.projectName },
    episode: { id: parts.episodeId, no: parts.episodeNo },
    estimated_cost_fen: estimatedCostFen,
    estimated_cost_notice: DEMO_COST_NOTICE,
    items: parts.items,
    /* 本集有缺口镜(#6),真栈非 partial 交付会被 409 拦下;demo 展示的是 partial 口径。
       gaps 在 wire 上是 snake_case(与后端 DeliveryGap wire 一致)。 */
    partial: parts.gaps.length > 0,
    gaps: parts.gaps.map((gap) => ({ shot_id: gap.shotId, shot_code: gap.shotCode, reason: gap.reason })),
  };
  return {
    episodeId: parts.episodeId,
    episodeNo: parts.episodeNo,
    projectName: parts.projectName,
    jsonText: JSON.stringify(manifestWire, null, 2),
    csvText: demoManifestToCsv(parts.items),
    itemCount: parts.items.length,
    imageCount: parts.items.filter((item) => item.media_kind === "image").length,
    videoCount: parts.items.filter((item) => item.media_kind === "video").length,
    estimatedCostFen,
    gaps: parts.gaps,
  };
}

/** 缺口人话(逐镜列出,与后端 reason 一一对应;本 fixture 只会出现缺视频/未过审两种)。 */
export function demoDeliveryGapText(gap: DeliveryGap): string {
  if (gap.reason === "missing_video_primary") return `#${gap.shotCode} 还没有视频主版本`;
  if (gap.reason === "video_not_accepted") return `#${gap.shotCode} 视频主版本未过审`;
  if (gap.reason === "image_not_accepted") return `#${gap.shotCode} 图片主版本未过审`;
  return `#${gap.shotCode} 图片主版本不可用`;
}
