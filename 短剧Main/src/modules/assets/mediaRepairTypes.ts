import type { PlatformRole } from "../auth/types.js";

export type AssetMediaHealthStatus = "healthy" | "degraded" | "broken" | "repairing";
export type AssetMediaRepairTaskStatus = "queued" | "processing" | "succeeded" | "partial" | "failed";
export type AssetMediaRepairTrigger = "manual" | "self_heal" | "batch";
export type AssetMediaRenditionKind = "thumbnail" | "detail";
export type AssetMediaRenditionStatus = "pending" | "healthy" | "failed" | "stale";

export type AssetMediaIssueCode =
  | "asset_media_missing"
  | "media_unbound"
  | "media_variant_missing"
  | "media_entity_variant_mismatch"
  | "source_locator_missing"
  | "source_object_missing"
  | "source_object_unreadable"
  | "image_metadata_missing"
  | "image_thumbnail_missing"
  | "image_detail_missing"
  | "rendition_stale"
  | "rendition_failed"
  | "model_preview_missing"
  | "director_chinese_description_missing";

export interface AssetMediaRepairActor {
  id: string;
  role?: PlatformRole;
}

export interface AssetRepairAssetSnapshot {
  id: string;
  ownerUserId: string | null;
  visibility: string;
  status: string;
  sourceProjectId: string | null;
  intro: string | null;
  metadata: Record<string, unknown>;
  deletedAt: Date | null;
}

export interface AssetRepairVariantSnapshot {
  id: string;
  assetEntityId: string;
  deletedAt: Date | null;
}

export interface AssetRepairMediaSnapshot {
  id: string;
  assetEntityId: string | null;
  assetVariantId: string | null;
  mediaKind: string;
  title: string | null;
  description: string | null;
  storageBucket: string | null;
  storagePath: string | null;
  widthPx: number | null;
  heightPx: number | null;
  format: string | null;
  sha256: string | null;
  approved: boolean | null;
  metadata: Record<string, unknown>;
  deletedAt: Date | null;
}

export interface AssetRepairRenditionSnapshot {
  id: string;
  assetMediaId: string;
  renditionKind: AssetMediaRenditionKind;
  strategy: "tos_process" | "stored_object";
  status: AssetMediaRenditionStatus;
  processSpec: string | null;
  storageBucket: string | null;
  storagePath: string | null;
  storageUrl: string | null;
  sourceSha256: string | null;
  widthPx: number | null;
  heightPx: number | null;
  format: string | null;
  sha256: string | null;
  errorCode: string | null;
  checkedAt: Date | null;
}

export interface AssetRepairBundle {
  asset: AssetRepairAssetSnapshot;
  variants: AssetRepairVariantSnapshot[];
  media: AssetRepairMediaSnapshot[];
  renditions: AssetRepairRenditionSnapshot[];
  activeRepairTaskId: string | null;
}

export interface AssetMediaHealthIssue {
  code: AssetMediaIssueCode;
  mediaId: string | null;
  renditionKind: AssetMediaRenditionKind | null;
  displayReason: string;
  autoRepairable: boolean;
  blocker: boolean;
}

export interface AssetMediaHealthView {
  assetId: string;
  status: AssetMediaHealthStatus;
  activeRepairTaskId: string | null;
  issues: AssetMediaHealthIssue[];
  mediaCount: number;
  healthyMediaCount: number;
  checkedAt: Date;
}

export interface CreateAssetMediaRepairInput {
  actor: AssetMediaRepairActor;
  assetId: string;
  clientIdempotencyKey: string;
  mediaIds?: string[];
  mode: "safe";
  trigger?: AssetMediaRepairTrigger;
}

export interface AssetMediaRepairTaskView {
  id: string;
  assetId: string;
  requestedByUserId: string | null;
  clientIdempotencyKey: string | null;
  requestHash: string;
  mode: "safe";
  trigger: AssetMediaRepairTrigger;
  mediaIds: string[] | null;
  status: AssetMediaRepairTaskStatus;
  diagnosis: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
  idempotentReplay: boolean;
}

export interface ClaimedAssetMediaRepairTask extends Omit<AssetMediaRepairTaskView, "idempotentReplay"> {
  /** Present only while a worker owns the processing lease; never expose it from HTTP views. */
  claimToken?: string | null;
  leaseExpiresAt?: Date | null;
}

export interface AssetMediaRepairActionInput {
  taskId: string;
  claimToken: string;
  assetMediaId: string;
  action: "diagnose" | "create_rendition" | "refresh_rendition" | "refresh_metadata" | "register_object" | "mark_blocked";
  status: "succeeded" | "skipped" | "blocked" | "failed";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export type AssetMediaRepairActionMutation = Omit<
  AssetMediaRepairActionInput,
  "taskId" | "claimToken"
>;

export interface AssetMediaRepairRenditionUpsert {
  assetMediaId: string;
  renditionKind: AssetMediaRenditionKind;
  strategy: "tos_process" | "stored_object";
  status: AssetMediaRenditionStatus;
  processSpec: string | null;
  storageBucket: string | null;
  storagePath: string | null;
  storageUrl: string | null;
  sourceSha256: string | null;
  widthPx: number | null;
  heightPx: number | null;
  format: string | null;
  sha256: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  checkedAt: Date;
}

export interface AssetMediaRepairRepositoryPort {
  loadVisibleBundle(actor: AssetMediaRepairActor, assetId: string): Promise<AssetRepairBundle>;
  loadRepairBundle(assetId: string): Promise<AssetRepairBundle>;
  requireRepairPermission(actor: AssetMediaRepairActor, assetId: string): Promise<void>;
  requireVisibleMedia(
    actor: AssetMediaRepairActor,
    assetId: string,
    mediaId: string,
  ): Promise<AssetRepairMediaSnapshot>;
  createOrReuseTask(input: {
    assetId: string;
    requestedByUserId: string;
    clientIdempotencyKey: string;
    requestHash: string;
    mode: "safe";
    trigger: AssetMediaRepairTrigger;
    mediaIds: string[] | null;
    diagnosis: Record<string, unknown>;
  }): Promise<{ task: ClaimedAssetMediaRepairTask; created: boolean }>;
  getTaskForActor(
    actor: AssetMediaRepairActor,
    assetId: string,
    taskId: string,
  ): Promise<ClaimedAssetMediaRepairTask | null>;
  claimNextQueued(): Promise<ClaimedAssetMediaRepairTask | null>;
  heartbeatClaim(taskId: string, claimToken: string): Promise<boolean>;
  requeueInterrupted(): Promise<number>;
  enqueueSelfHealCandidates(limit: number): Promise<number>;
  updateMediaFactsAndAppendAction(
    taskId: string,
    claimToken: string,
    mediaId: string,
    patch: {
      widthPx: number;
      heightPx: number;
      format: string;
      sha256: string;
      metadata: Record<string, unknown>;
    },
    action: AssetMediaRepairActionMutation,
  ): Promise<void>;
  upsertRenditionsAndAppendAction(
    taskId: string,
    claimToken: string,
    inputs: readonly AssetMediaRepairRenditionUpsert[],
    action: AssetMediaRepairActionMutation,
  ): Promise<void>;
  appendAction(input: AssetMediaRepairActionInput): Promise<void>;
  completeTask(
    taskId: string,
    claimToken: string,
    input: {
      status: "succeeded" | "partial" | "failed";
      diagnosis: Record<string, unknown>;
      result: Record<string, unknown>;
      errorCode: string | null;
      errorMessage: string | null;
      finishedAt: Date;
    },
  ): Promise<void>;
  failTask(
    taskId: string,
    claimToken: string,
    input: { errorCode: string; errorMessage: string; finishedAt: Date },
  ): Promise<void>;
}

export interface AssetMediaStoragePort {
  uploadBytes(
    content: Buffer,
    storagePath: string,
    contentType: string,
  ): Promise<{ bucket: string; storagePath: string; storageUrl: string }>;
  headObject(
    storagePath: string,
    bucket?: string,
  ): Promise<{
    contentLength: number;
    contentType: string | null;
    etag: string | null;
    lastModified: string | null;
  }>;
  readObjectBytes(
    storagePath: string,
    options: { bucket?: string; maxBytes: number; process?: string },
  ): Promise<Buffer>;
  createDownloadUrl(
    storagePath: string,
    options?: { bucket?: string; expiresSeconds?: number; fileName?: string },
  ): Promise<{ url: string; expiresAt: Date }> | { url: string; expiresAt: Date };
}
