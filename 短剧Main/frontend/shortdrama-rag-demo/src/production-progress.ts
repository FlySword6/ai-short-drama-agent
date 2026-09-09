import type { Episode, MediaVersion, Shot } from "./types";

export const PRODUCTION_STEPS = [
  { key: "storyboard", label: "导入剧本" },
  { key: "image", label: "生成图片" },
  { key: "video", label: "生成视频" },
  { key: "primary", label: "选主版本" },
  { key: "delivery", label: "连播交付" },
  /* K2-A(GP-26):交付是整个流程的终点,进度模型必须有「已交付」终态,
     否则走完交付 stepper 永远停在交付前一步,用户拿不到「交完了」的确认。 */
  { key: "delivered", label: "已交付" },
] as const;

export type ProductionStepKey = typeof PRODUCTION_STEPS[number]["key"];

export interface ProductionShotRecord {
  episode: Episode;
  shot: Shot;
  media: MediaVersion[];
}

export interface ProductionProgress {
  current: ProductionStepKey;
  currentIndex: number;
  episodeId?: string;
  shotId?: string;
  description: string;
  actionLabel: string;
}

export function inferProductionProgress(records: ProductionShotRecord[], deliveredEpisodeIds?: ReadonlySet<string>): ProductionProgress {
  if (records.length === 0) return progress("storyboard", undefined, undefined, "先导入一集剧本，系统才能建立生产任务。", "导入剧本");

  const missingImage = records.find((record) => !record.shot.selected_image_result_id && !hasPersistedMedia(record.media, "image"));
  if (missingImage) return progress("image", missingImage.episode.id, missingImage.shot.id, `素材 #${missingImage.shot.shot_no} 还没有可用图片。`, "去生成图片");

  const missingVideo = records.find((record) => !record.shot.selected_video_result_id && !hasPersistedMedia(record.media, "video"));
  if (missingVideo) return progress("video", missingVideo.episode.id, missingVideo.shot.id, `素材 #${missingVideo.shot.shot_no} 还没有可用视频。`, "去生成视频");

  const missingPrimary = records.find((record) => !record.shot.selected_video_result_id);
  if (missingPrimary) return progress("primary", missingPrimary.episode.id, missingPrimary.shot.id, `素材 #${missingPrimary.shot.shot_no} 需要选择视频主版本。`, "去选主版本");

  /* K2-A(GP-26):每集都有交付记录 = 已到「已交付」终态;
     任一集还没交付记录,保持「连播交付」为当前步(不说谎)。 */
  if (deliveredEpisodeIds && deliveredEpisodeIds.size > 0 && records.every((record) => deliveredEpisodeIds.has(record.episode.id))) {
    return progress("delivered", records[0]!.episode.id, undefined, "本集已交付，交付历史按集可查。", "查看交付历史");
  }

  return progress("delivery", records[0]!.episode.id, undefined, "本集已具备连播和交付条件。", "本集连播与交付");
}

function hasPersistedMedia(media: MediaVersion[], kind: "image" | "video"): boolean {
  return media.some((item) => item.media_kind === kind
    && item.persistence_status === "persisted"
    && Boolean(item.storage_url));
}

function progress(
  current: ProductionStepKey,
  episodeId: string | undefined,
  shotId: string | undefined,
  description: string,
  actionLabel: string,
): ProductionProgress {
  return {
    current,
    currentIndex: PRODUCTION_STEPS.findIndex((step) => step.key === current),
    episodeId,
    shotId,
    description,
    actionLabel,
  };
}
