import type { Database } from "../../db/client.js";
import { ShotMediaRepository, type ShotMediaRecord } from "./repository.js";
import { platformRoleOrMember } from "../auth/types.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import type { MediaSelectionSource } from "./effectiveSelection.js";

export type ShotMediaActor = string | ProjectAccessActor;

export class ShotMediaService {
  private readonly repository: ShotMediaRepository;

  constructor(db: Database, repository = new ShotMediaRepository(db)) {
    this.repository = repository;
  }

  async list(actorInput: ShotMediaActor, shotId: string) {
    const result = await this.repository.list(toActor(actorInput), shotId);
    // 版本号口径(v1.4):同一分镜 video 类媒体按 created_at 升序的序号(1..n),
    // 与列表展示顺序无关;图片无版本号。
    const versionNoByMediaId = new Map<string, number>();
    result.items
      .filter((item) => item.media.mediaKind === "video")
      .sort((a, b) => a.media.createdAt.getTime() - b.media.createdAt.getTime())
      .forEach((item, index) => versionNoByMediaId.set(item.media.id, index + 1));
    return result.items.map((item) => {
      const selectionSource = item.media.id === result.effectiveImage?.id
        ? result.effectiveImage.source
        : item.media.id === result.effectiveVideo?.id
          ? result.effectiveVideo.source
          : null;
      return toShotMedia(item, selectionSource, versionNoByMediaId.get(item.media.id) ?? null);
    });
  }

  async setVersionLabel(
    actorInput: ShotMediaActor,
    shotId: string,
    mediaId: string,
    label: string | null,
    note: string | null,
  ) {
    const updated = await this.repository.setVersionLabel(toActor(actorInput), shotId, mediaId, label, note);
    return {
      shot_id: updated.shotId,
      media_kind: updated.mediaKind,
      media_result_id: updated.mediaResultId,
      version_label: label,
      version_note: note,
    };
  }

  async deleteMedia(actorInput: ShotMediaActor, shotId: string, mediaId: string) {
    const deleted = await this.repository.deleteMedia(toActor(actorInput), shotId, mediaId);
    return {
      shot_id: deleted.shotId,
      media_kind: deleted.mediaKind,
      media_result_id: deleted.mediaResultId,
    };
  }

  async setPrimary(actorInput: ShotMediaActor, shotId: string, mediaId: string) {
    const selected = await this.repository.setPrimary(toActor(actorInput), shotId, mediaId);
    return {
      shot_id: selected.shotId,
      media_kind: selected.mediaKind,
      selected_media_result_id: selected.selectedMediaResultId,
    };
  }

  async registerAssetMediaAsPrimary(actorInput: ShotMediaActor, shotId: string, assetMediaId: string) {
    const selected = await this.repository.registerAssetMediaAsPrimary(toActor(actorInput), shotId, assetMediaId);
    return {
      shot_id: selected.shotId,
      media_kind: selected.mediaKind,
      media_result_id: selected.mediaResultId,
      selected_media_result_id: selected.selectedMediaResultId,
      review_status: selected.reviewStatus,
      source_asset_media_id: selected.sourceAssetMediaId,
      origin_label: "从素材库选用",
      created: selected.created,
    };
  }
}

function toActor(input: ShotMediaActor): ProjectAccessActor {
  return typeof input === "string" ? { id: input, role: "member" } : {
    id: input.id,
    role: platformRoleOrMember(input.role),
  };
}

function toShotMedia(record: ShotMediaRecord, selectionSource: MediaSelectionSource | null, versionNo: number | null) {
  const { media } = record;
  return {
    id: media.id,
    shot_id: media.shotId,
    media_kind: media.mediaKind,
    /* v1.4:版本号 = 同分镜 video 按 created_at 升序序号;版本标签存 metadata.shot_version.label。 */
    version_no: versionNo,
    version_label: media.metadata?.shot_version?.label ?? null,
    /* v1.4(界面重做 §4.3.2):版本备注与标签同层,存 metadata.shot_version.note。 */
    version_note: media.metadata?.shot_version?.note ?? null,
    /* happyhorse 预览集成 §2.2:预览档身份标记透传(metadata.preview),历史行无键=正式视频。 */
    preview: media.metadata?.preview === true,
    /* v1.4:版本回溯(决策 6)——每版经 generation_request_id 拉提示词/模型/参数/参考图;
       origin=asset_media 的素材库选用条目无请求,为 null。 */
    generation_request_id: media.requestId ?? null,
    persistence_status: media.persistenceStatus,
    review_status: media.reviewStatus,
    origin_label: media.originKind === "asset_media" ? "从素材库选用" : "本镜头生成",
    /* #164 结果页缩略图/播放直显:与 generationData.media_results 同源的存储地址,
       曝光面不超出既有任务详情接口;下载仍走需鉴权的 download_url。 */
    storage_url: media.storageUrl ?? null,
    download_url: `/api/v1/media/${media.id}/download`,
    mime_type: media.mimeType,
    width_px: media.widthPx,
    height_px: media.heightPx,
    duration_seconds: media.durationSeconds,
    /* 供应商结果键:视频任务附带的尾帧行='last-frame-<i>'(arkGenerationProvider),
       候选图='image-<i>';Lite 延长链据此区分尾帧图与候选图。素材库选用条目=null。 */
    provider_result_key: media.providerResultKey ?? null,
    is_primary: selectionSource !== null,
    selection_source: selectionSource,
    /* #164 G10:「定稿」与「已入资产库」是两个独立标记(§10.2),同一下发各行其是。 */
    registered_asset_media_id: record.registeredAssetMediaId ?? null,
    created_at: media.createdAt.toISOString(),
    updated_at: media.updatedAt.toISOString(),
  };
}
