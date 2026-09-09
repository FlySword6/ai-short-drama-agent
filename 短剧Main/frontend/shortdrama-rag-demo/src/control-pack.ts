/* ============================================================
   control-pack.ts — 提交参考集(控制包)纯逻辑
   块 2 自 workbench-page(镜级工作台,已归档)剪出成独立模块:
   场级工作台(segment-workbench-page)与测试直接从这里取,
   不再经由旧页文件中转。语义零改动,原 S9-17/K2K 注释原样保留。
   ============================================================ */
import { REFERENCE_LANES, type LaneItem, type LanesState, type ReferenceLaneId } from "./reference-lanes";
import { refIsImageReference } from "./asset-media";
import { assetName } from "./ui";
import type { Asset, ProjectAssetRef } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 资产引用背后的资产实体(引用可空处兜底占位)。 */
export function refAsset(ref: ProjectAssetRef): Asset {
  return ref.asset ?? ref.snapshot ?? ref.version_snapshot?.entity ?? { id: ref.asset_entity_id || ref.asset_id || ref.id, name: "未命名项目资产", asset_kind: "character" };
}

/* ============================================================
   S9-17：提交参考集取数源 = 工作台参考控制包（纯逻辑，供 s9-generation.test.ts 复用）
   语义铁律：已匹配资产=草稿与候选（只进候选池）；发给模型的参考=控制包成员
   （用户显式引用、按职责分组、图片视频混排），与参考车道 reference-lanes 同源。
   K-goal-04 条 4：确认抽屉退场，submitted 层直送 startGeneration payload，
   excluded 层上主界面（生成卡真相条 + 车道条目弱显徽标）。
   ============================================================ */

/** 提交参考项：控制包成员（mediaId = 提交给模型的引用 id；laneLabel = 职责分组名）。 */
export interface ControlPackReference {
  mediaId: string;
  name: string;
  url: string;
  isVideo: boolean;
  lane: ReferenceLaneId;
  laneLabel: string;
}

/** 资产条目 mediaId 解析（提交参考集口径）。 */
function refControlMediaId(ref: ProjectAssetRef): string | null {
  const media = ref.version_snapshot?.media ?? ref.asset?.current_media ?? null;
  return ref.asset_media_id ?? media?.id ?? null;
}

/** workshop 条目 id → 可提交的真实 mediaId（仅 `workshop:<uuid>` 形；demo/director/timbre 等占位 id 不是媒体引用）。 */
function workshopItemMediaId(itemId: string): string | null {
  if (!itemId.startsWith("workshop:")) return null;
  const mediaId = itemId.slice("workshop:".length);
  return UUID_PATTERN.test(mediaId) ? mediaId : null;
}

/** 不随本次生成提交的栏条目（K2K/GP-11+GP-16：逐项点名+原因，不许再无声消失）。 */
export interface ControlPackExclusion {
  /** 栏条目主键（`asset:<id>` / `workshop:<id>` / `note:<lane>`）。 */
  itemId: string;
  name: string;
  lane: ReferenceLaneId;
  laneLabel: string;
  /** 人话原因（为什么不随提交）。 */
  reason: string;
}

/** 控制包分层：随提交的参考集 + 不随提交的条目（各自逐项，抽屉所见=提交所发）。 */
export interface ControlPackPartition {
  submitted: ControlPackReference[];
  excluded: ControlPackExclusion[];
}

/** 不可作生成参考的媒体类型 → 人话原因（3D 素模/音频各有归属，其余兜底）。 */
function exclusionReasonForUnusableMedia(kind: string, format: string): string {
  if (kind.includes("3d") || kind.includes("model") || ["glb", "gltf"].includes(format)) return "3D 素模只进 3D 导演台，不进生成参考集";
  if (kind.includes("audio") || kind.includes("sound") || kind.includes("music") || ["mp3", "wav", "aac", "ogg", "flac", "m4a"].includes(format)) return "音频参考不进图片/视频生成参考集";
  return "这类媒体格式不作生成参考";
}

/**
 * 工作台参考控制包 → 提交参考集（S9-17 取数源修正；K2K 起分层返回）：
 * 遍历参考清单六组（REFERENCE_LANES 顺序）；资产条目解析 ref 拿 mediaId（沿用
 * 图片资格/视频格式判定口径），功能页归入的产出只收 `workshop:<uuid>` 形的真实媒体；
 * 机位文字描述不是媒体引用，不进参考集。按 mediaId 去重。
 * K2K（GP-11+GP-16）：进不了参考集的条目不再静默丢弃——逐项进 excluded 并带人话原因，
 * 哪类该提交哪类不该按仓内既有语义（媒体条目才进参考集）如实表达，提交 payload 不变。
 */
export function partitionControlPack(lanes: LanesState, refs: readonly ProjectAssetRef[]): ControlPackPartition {
  const refsById = new Map(refs.map((ref) => [ref.id, ref]));
  const seen = new Set<string>();
  const submitted: ControlPackReference[] = [];
  const excluded: ControlPackExclusion[] = [];
  const push = (option: ControlPackReference): void => {
    if (seen.has(option.mediaId)) return;
    seen.add(option.mediaId);
    submitted.push(option);
  };
  const drop = (item: LaneItem, lane: (typeof REFERENCE_LANES)[number], reason: string): void => {
    excluded.push({ itemId: item.id, name: item.name, lane: lane.id, laneLabel: lane.label, reason });
  };
  for (const lane of REFERENCE_LANES) {
    for (const item of lanes[lane.id] ?? []) {
      if (item.kind === "text") { drop(item, lane, "纯文字机位描述，不是媒体参考，不随本次生成提交"); continue; }
      if (item.origin === "asset") {
        const ref = item.refId ? refsById.get(item.refId) : undefined;
        if (!ref) { drop(item, lane, "资产引用已失效（不在本项目资产列表里），不随本次提交"); continue; }
        const mediaId = refControlMediaId(ref);
        if (!mediaId) { drop(item, lane, "资产还没有可提交的媒体版本，不随本次提交"); continue; }
        const media = ref.version_snapshot?.media ?? ref.asset?.current_media ?? null;
        const kind = (media?.media_kind ?? "").toLowerCase();
        const format = (media?.format ?? "").toLowerCase();
        const isVideo = kind.includes("video") || ["mp4", "mov", "webm"].includes(format);
        if (!isVideo && !refIsImageReference(ref)) { drop(item, lane, exclusionReasonForUnusableMedia(kind, format)); continue; }
        const asset = refAsset(ref);
        push({
          mediaId,
          name: assetName(asset),
          url: asset.thumbnail_url || asset.storage_url || "",
          isVideo,
          lane: lane.id,
          laneLabel: lane.label,
        });
      } else {
        const mediaId = workshopItemMediaId(item.id);
        if (!mediaId) { drop(item, lane, "占位条目（示例/音色参考等），不是真实媒体，不随本次提交"); continue; }
        push({ mediaId, name: item.name, url: item.thumbUrl ?? "", isVideo: item.kind === "video", lane: lane.id, laneLabel: lane.label });
      }
    }
  }
  return { submitted, excluded };
}

/** 提交参考集（= partitionControlPack 的 submitted 层；分层前的旧签名保留）。 */
export function controlPackReferences(lanes: LanesState, refs: readonly ProjectAssetRef[]): ControlPackReference[] {
  return partitionControlPack(lanes, refs).submitted;
}

/** 参考集按媒体类型分计（K2K/GP-17：提交点明示「参考图 N · 视频 M」）。 */
export function referenceMediaCounts(options: readonly ControlPackReference[]): { images: number; videos: number } {
  let images = 0;
  let videos = 0;
  for (const option of options) {
    if (option.isVideo) videos += 1;
    else images += 1;
  }
  return { images, videos };
}
