import { AppError, ConflictError } from "../../shared/errors.js";
import {
  requireAudioGenerationConfigured,
  type AudioGenerationConfiguration,
} from "../generation/factory.js";
import type {
  AudioExtractionPort,
  AudioVersion,
  AudioVersionRepository,
  AudioLockTarget,
  CreateAudioCandidateInput,
} from "./types.js";

export class AudioVersionService {
  constructor(private readonly repository: AudioVersionRepository, private readonly now: () => Date = () => new Date()) {}

  createCandidate(input: CreateAudioCandidateInput): Promise<AudioVersion> {
    return this.repository.createCandidate(input, this.now());
  }

  get(mediaResultId: string): Promise<AudioVersion | undefined> {
    return this.repository.findByMediaResultId(mediaResultId);
  }

  /**
   * The repository joins the existing asset-review truth in the same
   * transaction. Callers cannot supply a boolean or manufacture approval.
   */
  async lock(mediaResultId: string, lock: AudioLockTarget): Promise<AudioVersion> {
    const version = await this.require(mediaResultId);
    if (version.status !== "selected") throw new ConflictError("锁定音频没成：请先选中这条音频，再试一次。", "audio_version_not_selected");
    if (!lock.lockedAssetEntityId || !lock.lockedAssetMediaId || !lock.projectAssetRefId) {
      throw new AppError(409, "audio_lock_requires_asset_refs", "锁定音频没成：关联素材信息不完整，请重新选择后再试。");
    }
    const at = this.now();
    return this.repository.lockSelectedAfterApprovedAssetReview(version, lock, at);
  }

  async discard(mediaResultId: string, actorId: string): Promise<AudioVersion> {
    const version = await this.require(mediaResultId);
    // A concurrent control-package selection is rejected by the conditional
    // repository write rather than being overwritten by this stale read.
    if (version.status !== "candidate") throw new ConflictError("废弃音频没成：这条音频已不在待选状态，请刷新后再试。", "audio_version_not_discardable");
    const at = this.now();
    return this.repository.update({ ...version, status: "discarded", discardedByUserId: actorId, discardedAt: at, updatedAt: at });
  }

  private async require(mediaResultId: string): Promise<AudioVersion> {
    const version = await this.repository.findByMediaResultId(mediaResultId);
    if (!version) throw new AppError(404, "audio_version_not_found", "查看音频没成：找不到这个音频，请刷新后再试。");
    return version;
  }
}

/** Explicit fail-closed placeholder until Fable/DC approves a real extraction integration. */
export class DisabledAudioExtractionPort implements AudioExtractionPort {
  async extract(): Promise<never> {
    throw new AppError(501, "audio_extract_not_configured", "提取音轨没成：功能暂未准备好，请联系管理员处理。");
  }
}

export function requireTtsModel(config: AudioGenerationConfiguration): string {
  return requireAudioGenerationConfigured(config);
}
