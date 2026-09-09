import type { PublicVolcAssetFailureCode } from "../assets/volcAssetRegistry.js";

/**
 * S42 upload submission queue views. The asset_upload_tasks row is the queue,
 * the waiting-period value and the terminal notification fact at once — the
 * same contract shape as S29 generation attempts, not a second one.
 */
export type AssetUploadTaskStatus = "queued" | "processing" | "succeeded" | "failed";
export type AssetUploadRegistrationStatus =
  | "pending"
  | "submitting"
  | "processing"
  | "active"
  | "unavailable"
  | "failed"
  | "unknown";

export interface AssetUploadRegistrationResultView {
  id: string | null;
  status: AssetUploadRegistrationStatus;
  remoteAssetId: string | null;
  lastVerifiedAt: Date | null;
  freshUntil: Date | null;
  canUseAsSeedanceReference: boolean;
  nextAction: "refresh" | "register" | "verify" | null;
  errorCode: PublicVolcAssetFailureCode | null;
  errorMessage: string | null;
}

export interface AssetUploadResultView {
  asset: {
    id: string;
    mediaId: string | null;
    scope: "personal";
    status: "approved";
  } | null;
  seedanceRegistration: AssetUploadRegistrationResultView | null;
}

export interface AssetUploadTaskView {
  id: string;
  status: AssetUploadTaskStatus;
  originalFileName: string;
  assetKindHint: string | null;
  assetKind: string | null;
  factorType: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Position inside the yet-to-start queue; a processing task has no honest position. */
  queuePosition: number | null;
  estimatedDurationSeconds: number | null;
  estimatedDurationSampleCount: number;
  result: AssetUploadResultView | null;
  error: { code: string | null; message: string } | null;
}

export interface AssetUploadNotificationView {
  id: string;
  status: "succeeded" | "failed";
  originalFileName: string;
  resultAssetEntityId: string | null;
  resultAssetMediaId: string | null;
  resultAssetName: string | null;
  seedanceRegistration: AssetUploadRegistrationResultView | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}
