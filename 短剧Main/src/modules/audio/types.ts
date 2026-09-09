/** Server-side only dimensions from the sound-workshop R7 prompt contract. */
export interface AudioPromptDimensions {
  voiceReference?: string;
  performanceEmotion?: string;
  paceAndPauses?: string;
  languageAndAccent?: string;
  vocalDistance?: string;
  continuity?: string;
}

export interface CompiledAudioPrompt {
  version: "sound-workshop-v1";
  prompt: string;
  dimensions: Required<AudioPromptDimensions>;
}

export interface VoiceCatalogVoice {
  id: string;
  displayName: string;
  language?: string;
  category?: string;
  gender?: string;
  age?: string;
  description?: string;
  /**
   * Pre-rendered audition clip (static URL). Absent means the voice has not
   * been rendered yet — the client disables the audition button rather than
   * offering a click that does nothing. Never produced by this catalog call.
   */
  auditionUrl?: string;
}

export interface VoiceCatalogFilter {
  language?: string;
  category?: string;
  gender?: string;
  age?: string;
  query?: string;
}

/** Provider port is intentionally read-only. Preview is a paid generation, never this catalog call. */
export interface VoiceCatalogProvider {
  listVoices(): Promise<readonly VoiceCatalogVoice[]>;
}

export type AudioVersionStatus = "candidate" | "selected" | "locked" | "discarded";

export interface AudioVersion {
  id: string;
  projectId: string;
  generationRequestId?: string;
  mediaResultId: string;
  status: AudioVersionStatus;
  subtitleJson?: unknown;
  complianceMetadata: Record<string, unknown>;
  createdByUserId: string;
  selectedByUserId?: string;
  selectedAt?: Date;
  discardedByUserId?: string;
  discardedAt?: Date;
  lockedAssetEntityId?: string;
  lockedAssetMediaId?: string;
  projectAssetRefId?: string;
  lockedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAudioCandidateInput {
  id: string;
  projectId: string;
  generationRequestId?: string;
  mediaResultId: string;
  subtitleJson?: unknown;
  complianceMetadata: Record<string, unknown>;
  createdByUserId: string;
}

export interface AudioVersionRepository {
  createCandidate(input: CreateAudioCandidateInput, at: Date): Promise<AudioVersion>;
  findByMediaResultId(mediaResultId: string): Promise<AudioVersion | undefined>;
  update(version: AudioVersion): Promise<AudioVersion>;
  /**
   * Atomically proves the reviewed sound asset, its exact TOS media, and its
   * live project reference before recording the irreversible lock state.
   */
  lockSelectedAfterApprovedAssetReview(
    version: AudioVersion,
    target: AudioLockTarget,
    at: Date,
  ): Promise<AudioVersion>;
}

/** A lock is only meaningful once the approved audio has all asset references. */
export interface AudioLockTarget {
  lockedAssetEntityId: string;
  lockedAssetMediaId: string;
  projectAssetRefId: string;
}

export interface AudioExtractionPort {
  extract(input: { projectId: string; sourceMediaResultId: string; actorId: string }): Promise<never>;
}

/** Source ownership is checked before any extraction adapter is invoked. */
export interface AudioExtractionSourceRepository {
  findProjectIdForExtractableVideo(mediaResultId: string): Promise<string | undefined>;
}
