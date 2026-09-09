import { ConflictError } from "../../shared/errors.js";
import { platformRoleOrMember } from "../auth/types.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { isMediaReviewCleared, type MediaReviewStrategies } from "../reviews/mediaPolicy.js";
import {
  buildDeliverableManifest,
  buildPlaybackList,
  hashDeliverableManifest,
  type DeliverableManifest,
  type DeliveryGap,
  type GatedDeliverableMedia,
} from "./manifest.js";
import type {
  DeliveryRecord,
  DeliveryRecordPage,
  DeliveryRepository,
  EpisodeDeliverySource,
  ProtectedMediaDownload,
} from "./repository.js";

export type DeliveryActor = string | ProjectAccessActor;

export interface GatedManifest extends DeliverableManifest {
  partial: boolean;
  gaps: DeliveryGap[];
}

export class DeliveryService {
  constructor(private readonly repository: DeliveryRepository) {}

  async getManifest(
    actorInput: DeliveryActor,
    episodeId: string,
    options: { partial?: boolean } = {},
    now = new Date(),
  ): Promise<GatedManifest> {
    const source = await this.repository.loadEpisode(toActor(actorInput), episodeId);
    return buildGatedManifest(source, options.partial === true, now);
  }

  async getPlayback(
    actorInput: DeliveryActor,
    episodeId: string,
    options: { partial?: boolean } = {},
  ): Promise<GatedManifest & { playback: DeliverableManifest["items"] }> {
    const manifest = await this.getManifest(actorInput, episodeId, options);
    const playback = buildPlaybackList(manifest);
    if (!playback.length) {
      throw new ConflictError(
        "这集还没有可播放的成片，请先选定通过审核的视频。",
        "playback_not_ready",
        { gaps: manifest.gaps },
      );
    }
    return { ...manifest, playback };
  }

  /**
   * A delivery record is the fact "this episode was exported, in this exact
   * version, by this person". The manifest is recomputed server-side; callers
   * never supply media ids themselves.
   */
  async createDeliveryRecord(
    actorInput: DeliveryActor,
    episodeId: string,
    input: { purpose?: string | null; partial?: boolean } = {},
    now = new Date(),
  ): Promise<DeliveryRecord> {
    const actor = toActor(actorInput);
    const source = await this.repository.loadEpisode(actor, episodeId);
    const manifest = buildGatedManifest(source, input.partial === true, now);
    return this.repository.insertDeliveryRecord(actor, {
      episodeId,
      manifestHash: hashDeliverableManifest(manifest),
      mediaResultIds: manifest.items.map((item) => item.mediaId),
      partial: manifest.partial,
      missingShotCodes: manifest.gaps.map((gap) => gap.shotCode),
      purpose: input.purpose ?? null,
    });
  }

  listDeliveryRecords(
    actorInput: DeliveryActor,
    episodeId: string,
    page: number,
    pageSize: number,
  ): Promise<DeliveryRecordPage> {
    return this.repository.listDeliveryRecords(toActor(actorInput), episodeId, page, pageSize);
  }

  getDownload(actorInput: DeliveryActor, mediaId: string): Promise<ProtectedMediaDownload> {
    return this.repository.getDownload(toActor(actorInput), mediaId);
  }
}

/**
 * The delivery gate: only primary media that is review-cleared (accepted, or
 * needs_review under an automatic project policy) may enter a manifest.
 * Default mode rejects the whole request and names the offending shots;
 * partial mode delivers the ready shots and lists the gaps explicitly —
 * nothing is ever silently dropped.
 */
export function buildGatedManifest(
  source: EpisodeDeliverySource,
  partial: boolean,
  now: Date,
): GatedManifest {
  if (!source.shots.length) throw new ConflictError("当前分集还没有分镜", "deliverable_not_ready");
  const mediaById = new Map(source.media.map((item) => [item.mediaId, item]));
  const gaps: DeliveryGap[] = [];
  const readyMedia: GatedDeliverableMedia[] = [];

  for (const shot of source.shots) {
    const gap = shotDeliveryGap(shot, mediaById, source.reviewStrategies);
    if (gap) {
      gaps.push(gap);
      continue;
    }
    const selectedVideo = mediaById.get(shot.selectedVideoResultId!);
    const selectedImage = shot.selectedImageResultId ? mediaById.get(shot.selectedImageResultId) : undefined;
    if (selectedImage) readyMedia.push(selectedImage);
    if (selectedVideo) readyMedia.push(selectedVideo);
  }

  if (gaps.length && !partial) {
    throw new ConflictError(
      "这集暂时不能交付：有分镜还没选定通过审核的视频，补齐后再试。",
      "deliverable_not_ready",
      {
        missing_video_shots: gaps
          .filter((gap) => gap.reason === "missing_video_primary")
          .map((gap) => ({ shot_id: gap.shotId, shot_code: gap.shotCode })),
        review_blocked_shots: gaps
          .filter((gap) => gap.reason === "video_not_accepted" || gap.reason === "image_not_accepted")
          .map((gap) => ({ shot_id: gap.shotId, shot_code: gap.shotCode, reason: gap.reason })),
        gaps,
      },
    );
  }
  if (!readyMedia.length) {
    throw new ConflictError(
      "这集还没有可交付的素材，请先完成视频并通过审核。",
      "deliverable_not_ready",
      { gaps },
    );
  }

  const selectedIds = new Set(readyMedia.map((item) => item.mediaId));
  const manifest = buildDeliverableManifest(
    source.media.filter((item) => selectedIds.has(item.mediaId)),
    now,
  );
  return { ...manifest, partial, gaps };
}

function shotDeliveryGap(
  shot: EpisodeDeliverySource["shots"][number],
  mediaById: Map<string, GatedDeliverableMedia>,
  strategies: MediaReviewStrategies,
): DeliveryGap | null {
  const selectedVideo = shot.selectedVideoResultId ? mediaById.get(shot.selectedVideoResultId) : undefined;
  if (!selectedVideo || selectedVideo.shotId !== shot.id || selectedVideo.mediaKind !== "video") {
    return { shotId: shot.id, shotCode: shot.shotCode, reason: "missing_video_primary" };
  }
  if (!isMediaReviewCleared(selectedVideo.reviewStatus, strategies.video)) {
    return { shotId: shot.id, shotCode: shot.shotCode, reason: "video_not_accepted" };
  }
  if (shot.selectedImageResultId) {
    const selectedImage = mediaById.get(shot.selectedImageResultId);
    if (!selectedImage || selectedImage.shotId !== shot.id || selectedImage.mediaKind !== "image") {
      return { shotId: shot.id, shotCode: shot.shotCode, reason: "invalid_image_primary" };
    }
    if (!isMediaReviewCleared(selectedImage.reviewStatus, strategies.image)) {
      return { shotId: shot.id, shotCode: shot.shotCode, reason: "image_not_accepted" };
    }
  }
  return null;
}

function toActor(input: DeliveryActor): ProjectAccessActor {
  return typeof input === "string" ? { id: input, role: "member" } : {
    id: input.id,
    role: platformRoleOrMember(input.role),
  };
}
