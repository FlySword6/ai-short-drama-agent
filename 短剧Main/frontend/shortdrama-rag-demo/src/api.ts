import type {
  AgentMessage,
  AgentStreamEvent,
  AudioIngestCategory,
  AudioIngestSubmission,
  Asset,
  AssetListInput,
  AssetReviewAction,
  Candidate,
  GrillCheckResult,
  AssetReviewActionRecord,
  AssetReviewItem,
  AssetReviewStatus,
  AssetReviewSubmitReason,
  AssetSearchPage,
  AssetSearchResult,
  AssetUploadNotificationList,
  AssetUploadTask,
  AssetUploadTaskList,
  BatchEstimateItem,
  BatchEstimateItemInput,
  BatchEstimateResult,
  BatchConfirmResult,
  BatchSubmitInput,
  BatchSubmitResult,
  DashboardSummary,
  Episode,
  EpisodePlayback,
  GenerationDefaultStrategy,
  GenerationMediaKind,
  GenerationAttemptNotificationList,
  GenerationInFlight,
  FailedGenerationTask,
  GenerationTask,
  GenerationQuote,
  GenerationSubmissionInput,
  IngestedAsset,
  JsonAssetIngestItem,
  JsonRecord,
  ListData,
  MediaVersion,
  Page,
  Project,
  ProjectAssetRef,
  ProjectReferenceTestResult,
  ProjectReviewPolicy,
  PutGenerationDefaultInput,
  PromptTemplate,
  PromptTemplateInput,
  ProjectStyle,
  ProjectStyleInput,
  ReferenceTest,
  ReferenceTestInput,
  ReferenceTestMediaKind,
  ReferenceTestMode,
  ReviewDecision,
  ReviewDefaultStrategy,
  ReviewMediaKind,
  Shot,
  ShotAssetRef,
  StoryboardImportRecord,
  TopicRadarHot,
  TrashItem,
  User,
  VideoIngestSubmission,
  PrecheckResult,
  SceneConsumptionSummary,
} from "./types";
import type { Scene, EpisodeProductionStatus } from "./types";
import {
  accountCreditAdjustmentFromUnknown,
  accountCreditSummaryFromUnknown,
  adminUserAccountFromUnknown,
  capabilitiesFromUnknown,
  costPageFromUnknown,
  directoryUserFromUnknown,
  inviteCodeFromUnknown,
  inviteTierFromUnknown,
  memberFromUnknown,
  selfRegistrationPolicyFromUnknown,
  teamFromUnknown,
  userGroupFromUnknown,
  type AccountCreditAdjustment,
  type AccountCreditSummary,
  type AdminUserAccount,
  type Capabilities,
  type CostAggregatePage,
  type InviteCode,
  type InviteTier,
  type ProjectCostGroupBy,
  type ProjectMember,
  type SelfRegistrationCreditPolicy,
  type TeamRecord,
  type UserDirectoryRecord,
  type UserGroupRecord,
} from "./operations";
import { generationQuoteFromUnknown, isRecord } from "./generation-quotes";
import { projectGenerationConfigToWire, type ProjectGenerationConfig } from "./project-config";
import { classifyUnauthorized, readSessionExpiry, readSessionToken, writeSessionExpiry, writeSessionToken } from "./auth-token";
import {
  deliveryRecordFromUnknown,
  deliveryRecordPageFromUnknown,
  gatedManifestFromUnknown,
  mediaReviewActionFromUnknown,
  mediaReviewDecisionOutcomeFromUnknown,
  mediaReviewQueuePageFromUnknown,
  type DeliveryRecord,
  type DeliveryRecordPage,
  type GatedManifest,
  type MediaReviewActionRecord,
  type MediaReviewDecisionBody,
  type MediaReviewDecisionOutcome,
  type MediaReviewQueuePage,
  type MediaReviewStatus,
} from "./review-delivery";
import {
  commandPaletteCopyFromUnknown,
  commandPaletteGroupsFromUnknown,
  commandPaletteSearchFromUnknown,
  type CommandPaletteCopy,
  type CommandPaletteGroup,
  type CommandPaletteSearchResults,
} from "./command-palette";
import {
  configEntriesFromUnknown,
  configEntryFromUnknown,
  releaseHistoryFromEntry,
  releaseSectionFromEntry,
  type ConfigEntry,
  type ConfigEntryKind,
  type ConfigEntryStatus,
  type ReleaseHistoryEntry,
  type ReleaseSection,
} from "./release-plan";
import { mapAgentStreamFrame } from "./agent-stream";
import type { LaneVocabularyApiEntry } from "./lane-vocabulary";
import { track, trackGenerationResult } from "./telemetry";
import { newId } from "./uuid";
import { storyboardImportFromUnknown } from "./storyboard";
import { normalisePublicFieldDetails } from "../../../src/shared/fieldLabels";

interface ErrorEnvelope {
  ok?: false;
  error?: string | {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: unknown;
  };
  detail?: string | Array<{ msg?: string }>;
  issues?: Array<{ message?: string; msg?: string }>;
}

interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(message: string, options: { status?: number; code?: string; retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "request_failed";
    this.retryable = options.retryable ?? (this.status === 0 || this.status >= 500);
    this.details = options.details ?? null;
  }
}

const API_PREFIX = "/api/v1";
const NETWORK_ERROR_MESSAGE = "无法连接服务，请确认后端已启动";

export const UNAUTHORIZED_EVENT = "shortdrama:unauthorized";

/** 统一处理业务请求的 401：清除失效会话，并通知 App 原地发起重登恢复。 */
export function handleUnauthorizedResponse(status: number, path: string): void {
  if (status !== 401 || path.startsWith("/auth/login") || path.startsWith("/auth/register")) return;
  const reason = classifyUnauthorized(readSessionExpiry());
  writeSessionToken(null);
  writeSessionExpiry(null);
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { reason } }));
  }
}

/** F14：新建项目成功 → 壳层重拉/并入权限（capabilities 只在登录时拉一次，不通知则新项目角色判定为空）。 */
export const CAPABILITIES_REFRESH_EVENT = "shortdrama:capabilities-refresh";

function queryString(values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : "";
}

export function assetListPath(input: AssetListInput): string {
  return `/assets${queryString({
    scope: input.scope,
    project_id: input.scope === "project" ? input.projectId : undefined,
    query: input.query,
    asset_kind: input.assetKind,
    status: input.status,
    tag: input.tag,
    /* browse v1(R130):新参数直达后端;tags 为 CSV(同维度 OR),与旧 tag 单值并存 */
    tags: input.tags,
    category: input.category,
    media: input.media,
    source: input.source,
    gender: input.gender,
    age_band: input.ageBand,
    sort: input.sort,
    page: input.page,
    page_size: input.pageSize,
  })}`;
}

async function parseFailure(response: Response): Promise<ApiClientError> {
  let body: ErrorEnvelope | null = null;
  try {
    body = await response.json() as ErrorEnvelope;
  } catch {
    return new ApiClientError("请求没成：服务没有返回可读结果，请稍后重试。", { status: response.status });
  }
  if (typeof body.error === "object" && body.error) {
    return new ApiClientError(body.error.message || "请求失败", {
      status: response.status,
      code: body.error.code,
      retryable: body.error.retryable,
      details: publicClientErrorDetails(body.error.code, body.error.details),
    });
  }
  if (typeof body.error === "string") {
    return new ApiClientError("请求没成：请检查填写内容后重试。", { status: response.status });
  }
  if (Array.isArray(body.issues)) {
    return new ApiClientError("请求没能处理：请检查标出的填写内容后重试。", {
      status: response.status,
      code: "invalid_request",
      details: normalisePublicFieldDetails(body.issues),
    });
  }
  if (typeof body.detail === "string") {
    return new ApiClientError("请求没成：请检查填写内容后重试。", { status: response.status });
  }
  if (Array.isArray(body.detail)) {
    return new ApiClientError("请求没能处理：请检查标出的填写内容后重试。", {
      status: response.status,
      code: "invalid_request",
      details: normalisePublicFieldDetails(body.detail),
    });
  }
  return new ApiClientError("请求没成：服务没有返回可读结果，请稍后重试。", { status: response.status });
}

function publicClientErrorDetails(code: string | undefined, details: unknown): unknown | null {
  if (code === "invalid_request") return normalisePublicFieldDetails(details);
  if (
    code === "scene_version_conflict"
    || code === "command_validation_failed"
    || code === "deliverable_not_ready"
    || code === "playback_not_ready"
    || code === "media_review_not_accepted"
  ) {
    return details ?? null;
  }
  return null;
}

function normaliseList<T>(value: unknown): ListData<T> {
  if (Array.isArray(value)) return { items: value as T[], count: value.length };
  if (value && typeof value === "object") {
    const record = value as {
      items?: unknown;
      count?: unknown;
      page?: unknown;
      page_size?: unknown;
      has_more?: unknown;
      kind_counts?: unknown;
      filtered_count?: unknown;
    };
    const items = Array.isArray(record.items) ? record.items as T[] : [];
    const kindCounts = isRecord(record.kind_counts)
      ? Object.fromEntries(
        Object.entries(record.kind_counts)
          .filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      )
      : undefined;
    return {
      items,
      count: typeof record.count === "number" ? record.count : items.length,
      ...(typeof record.filtered_count === "number"
        ? { filteredCount: record.filtered_count }
        : {}),
      ...(typeof record.page === "number" ? { page: record.page } : {}),
      ...(typeof record.page_size === "number" ? { pageSize: record.page_size } : {}),
      ...(typeof record.has_more === "boolean" ? { hasMore: record.has_more } : {}),
      ...(kindCounts ? { kindCounts } : {}),
    };
  }
  return { items: [], count: 0 };
}

function normaliseMappedList<T>(value: unknown, mapper: (item: unknown) => T): ListData<T> {
  const list = normaliseList<unknown>(value);
  return { ...list, items: list.items.map(mapper) };
}

function firstValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalJsonRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value as JsonRecord : undefined;
}

function requiredResponseId(record: Record<string, unknown>, label: string, ...keys: string[]): string {
  const id = optionalString(firstValue(record, ...keys));
  if (!id) throw new ApiClientError(`${label}响应缺少编号`, { code: "invalid_response" });
  return id;
}

function requiredResponseString(record: Record<string, unknown>, label: string, field: string, ...keys: string[]): string {
  const value = optionalString(firstValue(record, field, ...keys));
  if (!value) throw new ApiClientError(`${label}响应缺少 ${field}`, { code: "invalid_response" });
  return value;
}

export function mediaVersionFromUnknown(value: unknown): MediaVersion {
  if (!isRecord(value)) throw new ApiClientError("资产媒体响应格式不正确", { code: "invalid_response" });
  const downloadUrl = optionalString(firstValue(value, "download_url", "downloadUrl"));
  return {
    id: requiredResponseId(value, "资产媒体", "id"),
    asset_entity_id: optionalString(firstValue(value, "asset_entity_id", "assetEntityId")),
    asset_variant_id: optionalString(firstValue(value, "asset_variant_id", "assetVariantId")),
    media_kind: optionalString(firstValue(value, "media_kind", "mediaKind")),
    format: optionalString(value.format),
    title: optionalString(value.title),
    description: optionalString(value.description),
    // Authenticated same-origin download is the safe playable fallback when
    // the API deliberately withholds the backing object-store URL.
    storage_url: optionalString(firstValue(value, "storage_url", "storageUrl")) ?? downloadUrl,
    source_file_url: optionalString(firstValue(value, "source_file_url", "sourceFileUrl")),
    thumbnail_url: optionalString(firstValue(value, "thumbnail_url", "thumbnailUrl")),
    download_url: downloadUrl,
    /* 裁决 9：usage_mode（reference/first_frame/last_frame）后端数据已在 wire 上,映射层补读。 */
    usage_mode: optionalString(firstValue(value, "usage_mode", "usageMode")),
    is_primary: optionalBoolean(firstValue(value, "is_primary", "isPrimary")),
    duration_seconds: optionalNumber(firstValue(value, "duration_seconds", "durationSeconds")) ?? null,
    /* K2-A：产物审核状态（后端 shot-media toShotMedia 已输出；版本弹窗据此拦 rejected 设主）。 */
    review_status: optionalString(firstValue(value, "review_status", "reviewStatus")),
    status: optionalString(value.status),
    created_at: optionalString(firstValue(value, "created_at", "createdAt")),
    /* v1.4（065/Lite 界面重做）：视频版本号/标签/备注同层透出（metadata.shot_version.*）。 */
    version_no: optionalNumber(firstValue(value, "version_no", "versionNo")),
    version_label: optionalString(firstValue(value, "version_label", "versionLabel")),
    version_note: optionalString(firstValue(value, "version_note", "versionNote")),
    /* v1.6.4:预览版身份(后端 shot-media toShotMedia 透传 metadata.preview)。 */
    preview: optionalBoolean(firstValue(value, "preview")) ?? null,
    metadata: optionalJsonRecord(value.metadata),
  };
}

function videoIngestSubmissionFromUnknown(value: unknown): VideoIngestSubmission {
  if (!isRecord(value)) throw new ApiClientError("视频入库响应格式不正确", { code: "invalid_response" });
  const status = optionalString(value.status);
  if (status !== "queued" && status !== "processing" && status !== "succeeded" && status !== "failed") {
    throw new ApiClientError("视频入库响应状态不正确", { code: "invalid_response" });
  }
  return {
    assetId: requiredResponseId(value, "视频入库", "asset_id", "assetId"),
    mediaId: requiredResponseId(value, "视频入库", "media_id", "mediaId"),
    taskId: requiredResponseId(value, "视频入库", "task_id", "taskId"),
    status,
    storageBucket: optionalString(firstValue(value, "storage_bucket", "storageBucket")),
    storagePath: optionalString(firstValue(value, "storage_path", "storagePath")),
    storageUrl: optionalString(firstValue(value, "storage_url", "storageUrl")) ?? null,
  };
}

function audioIngestSubmissionFromUnknown(value: unknown): AudioIngestSubmission {
  if (!isRecord(value)) throw new ApiClientError("音频入库响应格式不正确", { code: "invalid_response" });
  return {
    assetId: requiredResponseId(value, "音频入库", "asset_id", "assetId"),
    mediaId: requiredResponseId(value, "音频入库", "media_id", "mediaId"),
    storageBucket: requiredResponseString(value, "音频入库", "storage_bucket", "storageBucket"),
    storagePath: requiredResponseString(value, "音频入库", "storage_path", "storagePath"),
    storageUrl: optionalString(firstValue(value, "storage_url", "storageUrl")) ?? null,
  };
}

function appendTrimmedFormValue(form: FormData, key: string, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) form.append(key, trimmed);
}

function appendTrimmedFormList(form: FormData, key: string, values: readonly string[] | undefined): void {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (normalized.length > 0) form.append(key, normalized.join(","));
}

/* ---------- #164 镜头产物条目(定稿选用)与火山素材登记 ---------- */

/** shot-media wire 条目:定稿(is_primary/selection_source)、来源、地址、审核与持久化状态。
    与资产域 MediaVersion 分型:此处 is_primary=镜头定稿指针,不是资产主图。 */
export interface ShotMediaItem {
  id: string;
  shot_id: string | null;
  media_kind: string;
  persistence_status: string | null;
  review_status: string | null;
  origin_label: string | null;
  storage_url: string | null;
  download_url: string | null;
  mime_type: string | null;
  width_px: number | null;
  height_px: number | null;
  duration_seconds: number | null;
  is_primary: boolean;
  /** manual=人挑过的定稿;latest_default=系统默认最新一版;null=历史版本(§10.3 要分得开)。 */
  selection_source: "manual" | "latest_default" | null;
  /** 「已入资产库」标记(§10.2 与定稿独立):本产物登记出的资产媒体 id;未登记=null。 */
  registered_asset_media_id: string | null;
  /** 供应商结果键：候选图='image-<i>'、视频任务副产物图行='last-frame-<i>'；素材库选用=null。 */
  provider_result_key: string | null;
  created_at: string | null;
}

export function shotMediaItemFromUnknown(value: unknown): ShotMediaItem {
  if (!isRecord(value)) throw new ApiClientError("镜头产物响应格式不正确", { code: "invalid_response" });
  const selectionSource = optionalString(firstValue(value, "selection_source", "selectionSource"));
  return {
    id: requiredResponseId(value, "镜头产物", "id"),
    shot_id: optionalString(firstValue(value, "shot_id", "shotId")) ?? null,
    media_kind: optionalString(firstValue(value, "media_kind", "mediaKind")) ?? "",
    persistence_status: optionalString(firstValue(value, "persistence_status", "persistenceStatus")) ?? null,
    review_status: optionalString(firstValue(value, "review_status", "reviewStatus")) ?? null,
    origin_label: optionalString(firstValue(value, "origin_label", "originLabel")) ?? null,
    storage_url: optionalString(firstValue(value, "storage_url", "storageUrl")) ?? null,
    download_url: optionalString(firstValue(value, "download_url", "downloadUrl")) ?? null,
    mime_type: optionalString(firstValue(value, "mime_type", "mimeType")) ?? null,
    width_px: optionalNumber(firstValue(value, "width_px", "widthPx")) ?? null,
    height_px: optionalNumber(firstValue(value, "height_px", "heightPx")) ?? null,
    duration_seconds: optionalNumber(firstValue(value, "duration_seconds", "durationSeconds")) ?? null,
    is_primary: optionalBoolean(firstValue(value, "is_primary", "isPrimary")) ?? false,
    selection_source: selectionSource === "manual" || selectionSource === "latest_default" ? selectionSource : null,
    registered_asset_media_id: optionalString(firstValue(value, "registered_asset_media_id", "registeredAssetMediaId")) ?? null,
    provider_result_key: optionalString(firstValue(value, "provider_result_key", "providerResultKey")) ?? null,
    created_at: optionalString(firstValue(value, "created_at", "createdAt")) ?? null,
  };
}

/** 火山可信素材登记视图(seedance-registration 路由 wire)。 */
export interface MediaResultRegistration {
  id: string;
  asset_media_id: string;
  source_media_result_id: string | null;
  remote_asset_id: string | null;
  status: string;
  latest_error: { code: string; message: string } | null;
}

function mediaResultRegistrationFromUnknown(value: unknown): MediaResultRegistration | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const assetMediaId = optionalString(firstValue(value, "asset_media_id", "assetMediaId"));
  if (!id || !assetMediaId) return null;
  const latestError = isRecord(value.latest_error) ? value.latest_error : null;
  return {
    id,
    asset_media_id: assetMediaId,
    source_media_result_id: optionalString(firstValue(value, "source_media_result_id", "sourceMediaResultId")) ?? null,
    remote_asset_id: optionalString(firstValue(value, "remote_asset_id", "remoteAssetId")) ?? null,
    status: optionalString(value.status) ?? "",
    latest_error: latestError
      ? { code: optionalString(latestError.code) ?? "", message: optionalString(latestError.message) ?? "" }
      : null,
  };
}

export function assetFromUnknown(value: unknown): Asset {
  if (!isRecord(value)) throw new ApiClientError("资产响应格式不正确", { code: "invalid_response" });
  const metadata = optionalJsonRecord(value.metadata);
  /* 个人/通用资产的主图兜底：后端把主图写在 metadata.primaryImage（catalog.ts），
     经 success() 递归 snake 后 wire 上是 metadata.primary_image——camel 旧读法恒空。
     兜底是尽力而为:存量库的旧格式 primary_image 只有 url 没有 id,缺 id 时放弃兜底
     而不是抛错(混检召回存量资产时曾致单条炸整页,S13 真栈复核发现)。 */
  const primaryFromMetadata = metadata ? firstValue(metadata, "primary_image", "primaryImage") : undefined;
  const usablePrimaryFallback = isRecord(primaryFromMetadata)
    && Boolean(optionalString(primaryFromMetadata.id))
    ? primaryFromMetadata
    : undefined;
  const selectedMediaValue = firstValue(value, "selected_media", "selectedMedia");
  const currentMediaValue = firstValue(value, "current_media", "currentMedia") ?? usablePrimaryFallback;
  const selectedMedia = isRecord(selectedMediaValue) ? mediaVersionFromUnknown(selectedMediaValue) : undefined;
  const currentMedia = isRecord(currentMediaValue) ? mediaVersionFromUnknown(currentMediaValue) : undefined;
  const styleTags = firstValue(value, "style_tags", "styleTags");
  const imageStatus = firstValue(value, "image_status", "imageStatus");
  return {
    id: requiredResponseId(value, "资产", "id", "source_id", "sourceId"),
    source_id: optionalString(firstValue(value, "source_id", "sourceId")),
    asset_kind: optionalString(firstValue(value, "asset_kind", "assetKind")),
    role: optionalString(value.role),
    name: optionalString(value.name),
    display_name: optionalString(firstValue(value, "display_name", "displayName")),
    parent_entity_name: optionalString(firstValue(value, "parent_entity_name", "parentEntityName")),
    intro: optionalString(value.intro),
    appearance: optionalString(value.appearance),
    description: optionalString(value.description),
    usage_context: optionalString(firstValue(value, "usage_context", "usageContext")),
    visual_prompt: optionalString(firstValue(value, "visual_prompt", "visualPrompt")),
    source_file_url: optionalString(firstValue(value, "source_file_url", "sourceFileUrl")),
    storage_url: optionalString(firstValue(value, "storage_url", "storageUrl")) ?? currentMedia?.storage_url,
    thumbnail_url: optionalString(firstValue(value, "thumbnail_url", "thumbnailUrl")) ?? currentMedia?.thumbnail_url ?? currentMedia?.storage_url,
    image_status: imageStatus === "missing"
      || imageStatus === "unreadable"
      || imageStatus === "repairable"
      || imageStatus === "ready"
      ? imageStatus
      : undefined,
    scope: optionalString(value.scope),
    status: optionalString(value.status),
    reuse_scope: optionalString(firstValue(value, "reuse_scope", "reuseScope")),
    style_tags: Array.isArray(styleTags) ? styleTags.filter((item): item is string => typeof item === "string") : undefined,
    category: optionalString(value.category),
    gender: optionalString(value.gender),
    age_value: optionalNumber(firstValue(value, "age_value", "ageValue")),
    use_count: optionalNumber(firstValue(value, "use_count", "useCount")),
    score: optionalNumber(value.score),
    project_id: optionalString(firstValue(value, "project_id", "projectId")),
    project_reference_id: optionalString(firstValue(value, "project_reference_id", "projectReferenceId")),
    selected_variant_id: optionalString(firstValue(value, "selected_variant_id", "selectedVariantId")),
    selected_media_id: optionalString(firstValue(value, "selected_media_id", "selectedMediaId")),
    selected_media: selectedMedia,
    current_media: currentMedia,
    version_snapshot: optionalJsonRecord(firstValue(value, "version_snapshot", "versionSnapshot")),
    referenced_at: optionalString(firstValue(value, "referenced_at", "referencedAt")),
    updated_at: optionalString(firstValue(value, "updated_at", "updatedAt")),
    metadata,
  };
}

function projectAssetRefFromUnknown(value: unknown): ProjectAssetRef {
  if (!isRecord(value)) throw new ApiClientError("项目资产响应格式不正确", { code: "invalid_response" });
  const snapshotValue = firstValue(value, "version_snapshot", "versionSnapshot");
  const snapshot = isRecord(snapshotValue) ? snapshotValue : undefined;
  const entityValue = snapshot?.entity;
  const mediaValue = snapshot?.media;
  const media = isRecord(mediaValue) ? mediaVersionFromUnknown(mediaValue) : undefined;
  const directAsset = isRecord(value.asset) ? assetFromUnknown(value.asset) : undefined;
  const snapshotAsset = isRecord(entityValue) ? assetFromUnknown(entityValue) : undefined;
  const sourceAsset = directAsset ?? snapshotAsset;
  const asset = sourceAsset ? {
    ...sourceAsset,
    storage_url: sourceAsset.storage_url ?? media?.storage_url,
    thumbnail_url: sourceAsset.thumbnail_url ?? media?.thumbnail_url ?? media?.storage_url,
    current_media: sourceAsset.current_media ?? media,
  } : undefined;
  return {
    id: requiredResponseId(value, "项目资产", "id", "project_reference_id", "projectReferenceId"),
    project_id: optionalString(firstValue(value, "project_id", "projectId")),
    asset_id: optionalString(firstValue(value, "asset_id", "assetId")),
    asset_entity_id: optionalString(firstValue(value, "asset_entity_id", "assetEntityId")),
    asset_media_id: optionalString(firstValue(value, "asset_media_id", "assetMediaId", "selected_media_id", "selectedMediaId")),
    asset,
    snapshot: snapshotAsset,
    version_snapshot: snapshot ? { entity: snapshotAsset, media } : undefined,
    created_at: optionalString(firstValue(value, "created_at", "createdAt")),
  };
}

/* ---------- reviews / reference-tests 键名归一（S9-7 死字段审计 P0-1） ----------
 * 后端 success() 对一切响应递归 toSnakeCaseJson（仓根 src/http/response.ts），
 * wire 上全 snake_case；两域前端类型是 camelCase，以下 mapper 是唯一归一入口。
 * 输出恒为前端 camel 类型，组件零改动。 */

/** 裁决 12：JSON 入库响应键名归一（wire snake_case → 前端 camel IngestedAsset）。 */
export function ingestedAssetFromUnknown(value: unknown): IngestedAsset {
  if (!isRecord(value)) throw new ApiClientError("入库资产响应格式不正确", { code: "invalid_response" });
  return {
    id: requiredResponseId(value, "入库资产", "id"),
    assetKind: optionalString(firstValue(value, "asset_kind", "assetKind")) ?? "",
    name: optionalString(value.name) ?? "",
    displayName: optionalString(firstValue(value, "display_name", "displayName")) ?? null,
    sourceFileUrl: optionalString(firstValue(value, "source_file_url", "sourceFileUrl")) ?? null,
  };
}

function mediaKindOrImage<T extends string>(value: unknown): T {
  return (value === "video" ? "video" : "image") as T;
}

function reviewStatusOrPending(value: unknown): AssetReviewStatus {
  const status = optionalString(value);
  if (status === "automatic_review" || status === "approved" || status === "rejected") return status;
  return "pending_review";
}

export function reviewPolicyFromUnknown(value: unknown): ProjectReviewPolicy {
  if (!isRecord(value)) throw new ApiClientError("审核策略响应格式不正确", { code: "invalid_response" });
  return {
    id: optionalString(value.id) ?? null,
    projectId: optionalString(firstValue(value, "project_id", "projectId")) ?? "",
    mediaKind: mediaKindOrImage<ReviewMediaKind>(firstValue(value, "media_kind", "mediaKind")),
    /* 安全默认 = 待审（effectiveStrategy 同款口径），wire 缺/未知值不虚构自动过审。 */
    defaultStrategy: (firstValue(value, "default_strategy", "defaultStrategy") === "automatic" ? "automatic" : "pending_review") as ReviewDefaultStrategy,
    /* #187 就地审核：裁决权限镜像判定要用指定审核人（后端 toPolicy wire 本有 reviewer_user_id）。 */
    reviewerUserId: optionalString(firstValue(value, "reviewer_user_id", "reviewerUserId")) ?? null,
    updatedByUserId: optionalString(firstValue(value, "updated_by_user_id", "updatedByUserId")) ?? null,
    version: optionalNumber(value.version) ?? 0,
    createdAt: optionalString(firstValue(value, "created_at", "createdAt")) ?? null,
    updatedAt: optionalString(firstValue(value, "updated_at", "updatedAt")) ?? null,
  };
}

export function reviewActionFromUnknown(value: unknown): AssetReviewActionRecord {
  if (!isRecord(value)) throw new ApiClientError("审核轨迹响应格式不正确", { code: "invalid_response" });
  const action = optionalString(value.action);
  return {
    id: requiredResponseId(value, "审核轨迹", "id"),
    projectId: optionalString(firstValue(value, "project_id", "projectId")) ?? null,
    assetId: optionalString(firstValue(value, "asset_id", "assetId")) ?? "",
    action: (action === "approved" || action === "rejected" ? action : "submitted") as AssetReviewAction,
    fromStatus: reviewStatusOrPending(firstValue(value, "from_status", "fromStatus")),
    toStatus: reviewStatusOrPending(firstValue(value, "to_status", "toStatus")),
    reviewerUserId: optionalString(firstValue(value, "reviewer_user_id", "reviewerUserId")) ?? "",
    reviewerDisplayName: optionalString(firstValue(value, "reviewer_display_name", "reviewerDisplayName")) ?? null,
    rejectionReason: optionalString(firstValue(value, "rejection_reason", "rejectionReason")) ?? null,
    /* createdAt 缺失时给空串（sortTrailRecords 直接 localeCompare，undefined 会崩页）。 */
    createdAt: optionalString(firstValue(value, "created_at", "createdAt")) ?? "",
  };
}

export function reviewItemFromUnknown(value: unknown): AssetReviewItem {
  if (!isRecord(value)) throw new ApiClientError("审核结果响应格式不正确", { code: "invalid_response" });
  const latestAction = firstValue(value, "latest_action", "latestAction");
  const reason = optionalString(value.reason);
  return {
    assetId: optionalString(firstValue(value, "asset_id", "assetId")) ?? "",
    status: reviewStatusOrPending(value.status),
    changed: optionalBoolean(value.changed) ?? false,
    reason: (reason === "already_pending_review" || reason === "already_approved" || reason === "already_rejected" ? reason : "submitted") as AssetReviewSubmitReason,
    latestAction: isRecord(latestAction) ? reviewActionFromUnknown(latestAction) : undefined,
  };
}

function referenceTestModeFromUnknown(value: unknown): ReferenceTestMode {
  return value === "material_to_prompt" ? "material_to_prompt" : "direct_reference";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function referenceTestFromUnknown(value: unknown): ReferenceTest {
  if (!isRecord(value)) throw new ApiClientError("参考测试响应格式不正确", { code: "invalid_response" });
  return {
    id: requiredResponseId(value, "参考测试", "id"),
    projectId: optionalString(firstValue(value, "project_id", "projectId")) ?? "",
    name: optionalString(value.name) ?? "",
    mediaKind: mediaKindOrImage<ReferenceTestMediaKind>(firstValue(value, "media_kind", "mediaKind")),
    mode: referenceTestModeFromUnknown(value.mode),
    modelKey: optionalString(firstValue(value, "model_key", "modelKey")) ?? "",
    prompt: optionalString(value.prompt) ?? "",
    parameters: optionalJsonRecord(value.parameters) ?? {},
    referenceMediaIds: stringArray(firstValue(value, "reference_media_ids", "referenceMediaIds")),
    createdByUserId: optionalString(firstValue(value, "created_by_user_id", "createdByUserId")) ?? "",
    version: optionalNumber(value.version) ?? 0,
    createdAt: optionalString(firstValue(value, "created_at", "createdAt")) ?? "",
    updatedAt: optionalString(firstValue(value, "updated_at", "updatedAt")) ?? "",
  };
}

export function projectReferenceTestResultFromUnknown(value: unknown): ProjectReferenceTestResult {
  if (!isRecord(value)) throw new ApiClientError("测试结果响应格式不正确", { code: "invalid_response" });
  const media = firstValue(value, "media_result", "mediaResult");
  return {
    id: requiredResponseId(value, "测试结果", "id"),
    referenceTestId: optionalString(firstValue(value, "reference_test_id", "referenceTestId")) ?? "",
    referenceTestName: optionalString(firstValue(value, "reference_test_name", "referenceTestName")) ?? "",
    generationRequestId: optionalString(firstValue(value, "generation_request_id", "generationRequestId")) ?? "",
    mediaResultId: optionalString(firstValue(value, "media_result_id", "mediaResultId")) ?? "",
    mediaKind: mediaKindOrImage<ReferenceTestMediaKind>(firstValue(value, "media_kind", "mediaKind")),
    mode: referenceTestModeFromUnknown(value.mode),
    modelKey: optionalString(firstValue(value, "model_key", "modelKey")) ?? "",
    parameters: optionalJsonRecord(value.parameters) ?? {},
    createdByUserId: optionalString(firstValue(value, "created_by_user_id", "createdByUserId")) ?? "",
    createdAt: optionalString(firstValue(value, "created_at", "createdAt")) ?? "",
    mediaResult: isRecord(media) ? {
      storageUrl: optionalString(firstValue(media, "storage_url", "storageUrl")) ?? null,
      persistenceStatus: optionalString(firstValue(media, "persistence_status", "persistenceStatus")) ?? null,
      mimeType: optionalString(firstValue(media, "mime_type", "mimeType")) ?? null,
      widthPx: optionalNumber(firstValue(media, "width_px", "widthPx")) ?? null,
      heightPx: optionalNumber(firstValue(media, "height_px", "heightPx")) ?? null,
      durationSeconds: optionalNumber(firstValue(media, "duration_seconds", "durationSeconds")) ?? null,
    } : null,
  };
}

/** 分页信封归一：wire {items, page, page_size, has_next} → 前端 Page<T>。 */
export function pageFromUnknown<T>(value: unknown, mapper: (item: unknown) => T): Page<T> {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.items) ? record.items.map(mapper) : [];
  return {
    items,
    page: optionalNumber(record.page) ?? 1,
    pageSize: optionalNumber(firstValue(record, "page_size", "pageSize")) ?? items.length,
    /* has_next 缺失时按 false 收敛——不虚构「还有更多」。 */
    hasNext: optionalBoolean(firstValue(record, "has_next", "hasNext")) ?? false,
  };
}

/* ---------- 能力档与 tier_id 全链（合同 v0.3.0 §3：estimate/confirm/submit 必须带 tier_id,不一致 422） ---------- */

/** 选题雷达条目类型透出(页面只消费条目形状,不读快照全型也在 types.ts)。 */
export type { TopicRadarItem } from "./types";

/** 带档提交输入：估价/创建请求体必须含 tier_id（档是原子的,档外组合界面不给选）。 */
export type TieredGenerationSubmissionInput = GenerationSubmissionInput & { tier_id: string };
/** 批量估价行：同 generationInputShape + item_id + tier_id。 */
export type TieredBatchEstimateItemInput = BatchEstimateItemInput & { tier_id: string };

/** 报价视图：后端 quoteData 含 tier_id（GenerationQuote 类型未列,这里补齐透传,确认卡据此显示档位）。 */
export type GenerationQuoteWithTier = GenerationQuote & { tier_id?: string | null };

/** 简单估价入参（simpleEstimateSchema）：无项目上下文,只看价不创建报价。 */
export interface SimpleEstimateInput {
  media_kind: GenerationMediaKind;
  tier_id: string;
  parameters: JsonRecord;
  quantity: number;
}

/** 简单估价返回（CostEstimate snake + notice + generation_quote_id=null）；不创建报价,不可确认。
    多模型接缝:不再读 provider/model(后端不外发);media_kind 三态直通(音频不再错并成图片)。 */
export interface SimpleEstimate {
  tier_id: string;
  pricing_rule_id?: string;
  media_kind: GenerationMediaKind;
  billing_unit?: "request" | "image" | "second" | "ten_thousand_characters";
  unit_price_fen?: number;
  billable_units?: number;
  estimated_cost_fen: number;
  currency: "CNY";
  notice?: string;
  generation_quote_id: null;
}

function simpleEstimateFromUnknown(value: unknown): SimpleEstimate {
  if (!isRecord(value)) throw new ApiClientError("估价响应格式不正确", { code: "invalid_response" });
  const estimatedCostFen = optionalNumber(value.estimated_cost_fen);
  if (estimatedCostFen === undefined) throw new ApiClientError("估价响应缺少费用", { code: "invalid_response" });
  const billingUnit = optionalString(value.billing_unit);
  return {
    tier_id: optionalString(value.tier_id) ?? "",
    pricing_rule_id: optionalString(value.pricing_rule_id),
    media_kind: value.media_kind === "video" ? "video" : value.media_kind === "audio" ? "audio" : "image",
    billing_unit: billingUnit === "image" || billingUnit === "second" || billingUnit === "ten_thousand_characters" ? billingUnit : billingUnit === "request" ? "request" : undefined,
    unit_price_fen: optionalNumber(value.unit_price_fen),
    billable_units: optionalNumber(value.billable_units),
    estimated_cost_fen: estimatedCostFen,
    currency: "CNY",
    notice: optionalString(value.notice),
    generation_quote_id: null,
  };
}

/* ---------- AI 审计日志（GET /api/v1/projects/:project_id/ai-audit-logs,assistant/routes.ts） ----------
 * wire 全 snake_case（success() 递归）,经 mapper 归一为 camel;分页 {items,page,page_size,total,has_more}。 */

/** AI 审计日志条目（仅暴露审计元数据，不含工具输入、输出或错误原文）。 */
export interface AiAuditLogEntry {
  id: string;
  sessionId: string;
  userId: string;
  userName: string;
  projectId: string;
  shotId: string | null;
  role: string;
  content: string;
  toolName: string | null;
  status: string | null;
  provider: string | null;
  model: string | null;
  usage: unknown;
  providerCostUsdMicros: number | null;
  pointsSpent: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AiAuditLogPage {
  items: AiAuditLogEntry[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/* ---------- Lite 界面模式（wire 类型；与后端 lite 模块 SubmitLiteScriptResult 对齐） ---------- */

/** Lite 剧本提交回执（wire snake_case；outcome：created=本次新建 run，existing=同幂等键重放命中既有 run）。 */
export interface LiteSubmitScriptResult {
  episode_id: string;
  run_id: string;
  outcome: "created" | "existing";
}

/** Lite 资产实体化回执（wire snake_case；资产项键名实读 lite/routes.test.ts:412/447——
    assetKind 经 success() 递归 toSnakeCaseJson 后是 asset_kind）。 */
export interface LiteMaterializeAssetsResult {
  created: number;
  existed: number;
  assets: Array<{ asset_entity_id: string; asset_kind: string; name: string; outcome: "created" | "existing" }>;
}

/** Lite 资产候选产物项（wire snake_case，按 created_at 倒序；实读 lite/routes.test.ts:525-533）。 */
export interface LiteAssetMediaItem {
  id: string;
  media_kind: string;
  storage_url: string | null;
  persistence_status: string;
  review_status: string;
  generation_request_id: string | null;
  width_px: number | null;
  height_px: number | null;
  created_at: string;
}

/** Lite 参考资产项（wire snake_case 冻结合同；实读 lite/routes.test.ts:634-664——
    只含本项目 seedance 登记 active 的资产，每资产取最新一条登记；
    asset_media_id 是登记提升出的 asset_media 行 id，生视频 references 只认这个 id）。 */
export interface LiteReferenceAssetItem {
  asset_entity_id: string;
  name: string;
  /** asset_entities.asset_kind 原值透传（character/scene/prop…）。 */
  kind: string;
  asset_media_id: string;
  storage_url: string | null;
  /** 登记行的 updated_at（ISO 串）。 */
  registered_at: string;
}

/** 防御解析：缺 id 的坏行整行丢弃（不凑数、不并假值），好行不受连坐。 */
function liteReferenceAssetItemFromUnknown(value: unknown): LiteReferenceAssetItem | null {
  if (!isRecord(value)) return null;
  const assetEntityId = optionalString(value.asset_entity_id);
  const assetMediaId = optionalString(value.asset_media_id);
  if (!assetEntityId || !assetMediaId) return null;
  return {
    asset_entity_id: assetEntityId,
    name: optionalString(value.name) ?? "",
    kind: optionalString(value.kind) ?? "",
    asset_media_id: assetMediaId,
    storage_url: optionalString(value.storage_url) ?? null,
    registered_at: optionalString(value.registered_at) ?? "",
  };
}

/* ---------- Lite 素材页资产 CRUD（wire snake_case；与后端 lite/routes.ts 四条新路由对齐） ---------- */

/** tab 聚合计数项。 */
export interface LiteAssetTabCount {
  kind: string;
  count: number;
}

/** 素材列表页单行（wire snake_case）。列表卡展示名称 + 一句话描述 + 主图，其余状态字段供详情页判断。 */
export interface LiteAssetListItem {
  asset_entity_id: string;
  name: string;
  intro: string | null;
  asset_kind: string;
  /** v0.9：音频五类分类（角色声音/旁白/音效/环境声/其他）；非音频恒 null。 */
  audio_kind: string | null;
  primary_media_url: string | null;
  has_media: boolean;
  has_primary: boolean;
  has_pending_generation: boolean;
  last_modified_at: string;
}

/** 素材列表页响应。 */
export interface LiteAssetListResult {
  items: LiteAssetListItem[];
  tab_counts: LiteAssetTabCount[];
}

/** 广场生成记录行（wire snake_case，与后端 plaza_records 列表投影一致）。 */
export interface PlazaRecord {
  id: string;
  generation_request_id: string;
  media_kind: string;
  prompt: string;
  tier_id?: string | null;
  parameters: Record<string, unknown>;
  reference_manifest: Array<{ media_id?: string | null; kind?: string; role?: string }>;
  status: string;
  display_reason?: string | null;
  estimated_cost_fen?: number | null;
  media_results: Array<{ id: string; media_kind: string; storage_url?: string | null }>;
  created_at?: string | null;
  updated_at?: string | null;
}

/** 资产详情（wire snake_case）。 */
export interface LiteAssetDetail {
  asset_entity_id: string;
  name: string;
  intro: string | null;
  asset_kind: string;
  /** v0.9：音频五类分类；非音频恒 null。 */
  audio_kind: string | null;
  note: string | null;
  has_media: boolean;
  has_primary: boolean;
  has_pending_generation: boolean;
  last_modified_at: string;
  modified_by_user_id: string | null;
  gender: string | null;
  age_value: number | null;
  appearance: string | null;
  hair_description: string | null;
  outfit_description: string | null;
  height_cm: number | null;
  metadata_lite: Record<string, unknown> | null;
}

/** 资产变体（wire snake_case）。 */
export interface LiteAssetVariant {
  variant_id: string;
  variant_kind: string;
  display_name: string;
  is_primary: boolean;
  /** 变体首图（后端按 asset_media image 主图优先解析）；无图 = null。 */
  image_url?: string | null;
}

/** 版本图素材轨的一行（wire snake_case）。 */
export interface LiteAssetVersionTrackItem {
  asset_media_id: string | null;
  media_result_id: string | null;
  storage_url: string | null;
  is_primary: boolean;
  source: "upload" | "ai";
  width_px: number | null;
  height_px: number | null;
  /** 媒体类型（audio 资产用音频轨渲染，非图片不套 <img>）；上传=asset_media.media_kind，生成=media_results.media_kind。 */
  media_kind: string | null;
  /** 媒体格式：上传=asset_media.format，生成=media_results.mime_type。 */
  format: string | null;
  created_at: string;
  variant_id: string | null;
}

/** 关联分镜的一行（wire snake_case；flat 形状，含稳定 usage_id 与匹配证据，旧分组格式由后端归一）。 */
export interface LiteAssetUsageEntry {
  usage_id: string;
  variant_id: string | null;
  shot_id: string | null;
  episode_id: string | null;
  episode_no: number | null;
  shot_no: number | null;
  scene_name: string | null;
  shot_label: string;
  status: "bound" | "pending";
  matched_by: "manual" | "exact_name" | "ai_auto";
  evidence: { scene_names: string[]; line_indices: number[]; source_text_snippets: string[] };
}

/** 批量关联分镜的单条：shot_id 与 (episode_no + shot_no) 至少一种；variant_id 可选(不传=资产级关联)。 */
export interface LiteAddUsageItem {
  shot_id?: string;
  episode_no?: number;
  shot_no?: number;
  scene_name?: string;
  variant_id?: string;
}

/** 批量关联分镜的结果：added=解析到 shot 落 bound；pending=未解析到 shot 待绑定(不报错)。 */
export interface LiteAddUsagesResult { added: number; pending: number }

/** 防御解析 evidence 块：非对象或字段非数组一律空数组兜底。 */
function liteUsageEvidenceFromUnknown(value: unknown): { scene_names: string[]; line_indices: number[]; source_text_snippets: string[] } {
  if (!isRecord(value)) return { scene_names: [], line_indices: [], source_text_snippets: [] };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
  return {
    scene_names: strings(value.scene_names),
    line_indices: numbers(value.line_indices),
    source_text_snippets: strings(value.source_text_snippets),
  };
}

/** v1.6 变体匹配建议条目（wire snake_case，防御解析；问题八 8.9 合同）。 */
export interface LiteMatchSuggestItem {
  episode_no: number;
  shot_no: number;
  scene_name: string | null;
  shot_id: string;
  reason: string;
  /** 该镜已关联同资产其它变体时标注其变体名（勾选则并存，八.2 去重表）。 */
  conflict_variant_name: string | null;
}

/** 变体匹配建议响应：items 已校验（幻觉镜号服务端已丢弃）；truncated=超过 50 条上限。 */
export interface LiteMatchSuggestResult {
  items: LiteMatchSuggestItem[];
  truncated: boolean;
}

/** 防御解析单条建议：字段缺失/类型错一律丢弃该条（与 liteUsageEvidenceFromUnknown 同口径）。 */
function liteMatchSuggestItemFromUnknown(value: unknown): LiteMatchSuggestItem | null {
  if (!isRecord(value)) return null;
  const episodeNo = value.episode_no;
  const shotNo = value.shot_no;
  const shotId = value.shot_id;
  if (typeof episodeNo !== "number" || typeof shotNo !== "number" || typeof shotId !== "string") return null;
  return {
    episode_no: episodeNo,
    shot_no: shotNo,
    scene_name: typeof value.scene_name === "string" ? value.scene_name : null,
    shot_id: shotId,
    reason: typeof value.reason === "string" ? value.reason : "",
    conflict_variant_name: typeof value.conflict_variant_name === "string" ? value.conflict_variant_name : null,
  };
}

/** 防御解析列表项：缺 asset_entity_id 或 name 的坏行整行丢弃。 */
function liteAssetListItemFromUnknown(value: unknown): LiteAssetListItem | null {
  if (!isRecord(value)) return null;
  const assetEntityId = optionalString(value.asset_entity_id);
  const name = optionalString(value.name);
  if (!assetEntityId || !name) return null;
  return {
    asset_entity_id: assetEntityId,
    name,
    intro: isRecord(value) && typeof value.intro === "string" ? value.intro : null,
    asset_kind: optionalString(value.asset_kind) ?? "",
    audio_kind: optionalString(value.audio_kind) ?? null,
    primary_media_url: optionalString(value.primary_media_url) ?? null,
    has_media: isRecord(value) && value.has_media === true,
    has_primary: isRecord(value) && value.has_primary === true,
    has_pending_generation: isRecord(value) && value.has_pending_generation === true,
    last_modified_at: optionalString(value.last_modified_at) ?? "",
  };
}

/* ---------- seedance 素材登记（wire 类型；与后端 seedance-assets 模块 routes.ts toResponse 对齐） ---------- */

/** 登记状态全量取值（seedance-assets/types.ts:12-19）：pending/submitting=本地提交在飞，
    processing=远端入库中，active=可用于生成；failed=远端明确失败（可人工重试），
    unknown=提交结果不明、unavailable=授权/核验过期（两者只能由人工再次触发登记来收敛）。 */
export type SeedanceRegistrationStatus =
  | "pending"
  | "submitting"
  | "processing"
  | "active"
  | "failed"
  | "unknown"
  | "unavailable";

/** 素材登记视图（wire snake_case；asset_media_id 是登记提升出的 asset_media 行 id——
    生视频 references 的 media_id 只认它，media_results.id 直传必 400）。 */
export interface SeedanceRegistration {
  id: string;
  asset_media_id: string;
  source_media_result_id: string | null;
  remote_asset_id: string | null;
  status: SeedanceRegistrationStatus;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  authorization_expires_at: string | null;
  last_verified_at: string | null;
  latest_error: { code: string; message: string } | null;
}

function aiAuditLogFromUnknown(value: unknown): AiAuditLogEntry {
  if (!isRecord(value)) throw new ApiClientError("AI 审计日志响应格式不正确", { code: "invalid_response" });
  return {
    id: requiredResponseId(value, "AI 审计日志", "id"),
    sessionId: optionalString(firstValue(value, "session_id", "sessionId")) ?? "",
    userId: optionalString(firstValue(value, "user_id", "userId")) ?? "",
    userName: optionalString(firstValue(value, "user_name", "userName")) ?? "",
    projectId: optionalString(firstValue(value, "project_id", "projectId")) ?? "",
    shotId: optionalString(firstValue(value, "shot_id", "shotId")) ?? null,
    role: optionalString(value.role) ?? "",
    content: optionalString(value.content) ?? "",
    toolName: optionalString(firstValue(value, "tool_name", "toolName")) ?? null,
    status: optionalString(value.status) ?? null,
    provider: optionalString(value.provider) ?? null,
    model: optionalString(value.model) ?? null,
    usage: value.usage ?? null,
    providerCostUsdMicros: optionalNumber(firstValue(value, "provider_cost_usd_micros", "providerCostUsdMicros")) ?? null,
    pointsSpent: optionalNumber(firstValue(value, "points_spent", "pointsSpent")) ?? null,
    durationMs: optionalNumber(firstValue(value, "duration_ms", "durationMs")) ?? null,
    createdAt: optionalString(firstValue(value, "created_at", "createdAt")) ?? "",
  };
}

/** 后端 grill 端点返回 snake_case（success() 递归转换），前端类型用 camelCase；此处归一。 */
function normaliseGrillResult(raw: unknown): GrillCheckResult {
  const value = isRecord(raw) ? raw : {};
  const action = optionalString(value.action);
  const targetField = optionalString(firstValue(value, "target_field", "targetField")) ?? "";
  switch (action) {
    case "execute":
      return { action: "execute" };
    case "clarify":
      return { action: "clarify", question: optionalString(value.question) ?? "", targetField };
    case "offer_candidates": {
      const rawCandidates = firstValue(value, "candidates", "offer_candidates");
      const candidates: Candidate[] = Array.isArray(rawCandidates)
        ? rawCandidates.filter(isRecord).map((c) => ({
          label: optionalString(c.label) ?? "",
          description: optionalString(c.description) ?? "",
          value: optionalString(c.value) ?? "",
        }))
        : [];
      return { action: "offer_candidates", candidates, targetField };
    }
    case "pending_confirmation": {
      const rawCollected = firstValue(value, "collected_fields", "collectedFields");
      const collectedFields = Array.isArray(rawCollected)
        ? rawCollected.filter((v): v is string => typeof v === "string")
        : [];
      return {
        action: "pending_confirmation",
        summary: optionalString(value.summary) ?? "",
        collectedFields,
      };
    }
    default:
      return { action: "execute" };
  }
}

class ApiClient {
  getToken(): string | null {
    return readSessionToken();
  }

  setToken(token: string | null): void {
    writeSessionToken(token);
    if (!token) writeSessionExpiry(null);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    const token = this.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${API_PREFIX}${path}`, { ...init, headers });
    } catch {
      throw new ApiClientError(NETWORK_ERROR_MESSAGE, { code: "network_error", retryable: true });
    }
    if (!response.ok) {
      const failure = await parseFailure(response);
      this.handleUnauthorized(response.status, path);
      throw failure;
    }
    if (response.status === 204) return undefined as T;
    const body = await response.json() as SuccessEnvelope<T> | T;
    if (body && typeof body === "object" && "ok" in body && (body as SuccessEnvelope<T>).ok === true) {
      return (body as SuccessEnvelope<T>).data;
    }
    return body as T;
  }

  /** 登录标识=邮箱或遗留 Day-0 账号名（后端同一查找，issue #26 合同：新调用方优先 email 键）。 */
  async login(identifier: string, password: string): Promise<{ token: string; expires_at: string; user: User }> {
    const body = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier) ? { email: identifier, password } : { username: identifier, password };
    const result = await this.request<{ token: string; expires_at: string; user: User }>("/auth/login", { method: "POST", body: JSON.stringify(body) });
    /* 「登录成功」埋点要带登录态上报(events 端点 requireCurrentUser)——先存 token 再报;
       调用方随后的 setToken 幂等无害。未存即报=401 静默丢,事件永远落不了库。
       到期时间随存(F04):401 时据此分「过期/被顶下线」两种话术。 */
    this.setToken(result.token);
    writeSessionExpiry(result.expires_at);
    track("login");
    return result;
  }

  /** 企业微信入口能力只认服务端 status，构建期开关不参与决定。 */
  async wecomStatus(): Promise<{ enabled: boolean }> {
    return this.request("/auth/wecom/status");
  }

  /** 一次性 result 只在内存中交换；成功后复用现有 Bearer session 存储与到期语义。 */
  async exchangeWecomResult(resultToken: string): Promise<{ token: string; expires_at: string; user: User }> {
    const result = await this.request<{ token: string; expires_at: string; user: User }>("/auth/wecom/exchange", {
      method: "POST",
      body: JSON.stringify({ result: resultToken }),
    });
    this.setToken(result.token);
    writeSessionExpiry(result.expires_at);
    track("login");
    return result;
  }

  /** S57/S65：邮箱验证码。仅 dev_log 模式可投递；未接邮件通道的部署形态后端返回 503 email_delivery_unavailable（调用方给人话）。 */
  async requestEmailVerificationCode(email: string): Promise<{ email: string; expires_at: string; delivery: string }> {
    return this.request("/auth/email-verification-codes", { method: "POST", body: JSON.stringify({ email }) });
  }

  /** 邮箱+验证码注册（issue #26 合同）：邀请码必填——内部试点只认固定码，缺码/错码后端 422 拒绝；成功后自动登录。 */
  async register(input: { email: string; password: string; verificationCode: string; invitationCode: string; displayName?: string }): Promise<{ token: string; expires_at: string; user: User }> {
    await this.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        verification_code: input.verificationCode,
        invitation_code: input.invitationCode,
        ...(input.displayName ? { display_name: input.displayName } : {}),
      }),
    });
    return this.login(input.email, input.password);
  }

  async me(): Promise<User> {
    return this.request("/auth/me");
  }

  /** 红线 R2：界面模式是服务端状态（users.ui_mode 唯一事实源），本人改自己；前端禁 localStorage/URL 存模式。 */
  async patchMyUiMode(mode: "lite" | "full"): Promise<User> {
    return this.request("/auth/me/ui-mode", { method: "PATCH", body: JSON.stringify({ ui_mode: mode }) });
  }

  async logout(): Promise<void> {
    await this.request("/auth/logout", { method: "POST" });
    this.setToken(null);
  }

  async projects(): Promise<ListData<Project>> {
    return normaliseList<Project>(await this.request("/projects"));
  }

  /** 选题雷达当前榜单(契约 docs/contracts/v0.2.0/topic-radar.md;
     前端只读归一化结果,看不到上游/密钥/原始响应)。 */
  async topicRadarHot(): Promise<TopicRadarHot> {
    return this.request("/topic-radar/hot");
  }

  async createProject(input: Pick<Project, "name" | "description">): Promise<Project> {
    const project = await this.request<Project>("/projects", { method: "POST", body: JSON.stringify(input) });
    track("project_create", { project_id: project.id });
    /* F14：建项目成功即知会壳层刷新权限（创建者=负责人本地先并入,同时重拉真源）,
       新项目首进 tab 集合一次定死,不许先少后多。 */
    if (typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent(CAPABILITIES_REFRESH_EVENT, { detail: { projectId: project.id } }));
    }
    return project;
  }

  async project(projectId: string): Promise<Project> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  }

  async assets(input: AssetListInput): Promise<ListData<Asset>> {
    return normaliseMappedList(await this.request(assetListPath(input)), assetFromUnknown);
  }

  /**
   * 语义检索。响应含 mode 时透传（hybrid=混合检索 / structured_fallback=已降级基础检索）；
   * 后端尚未提供 mode 字段时返回 undefined，页面不显示降级提示（不虚构状态）。
   */
  async semanticSearch(query: string, limit = 20): Promise<AssetSearchResult> {
    const raw = await this.request<unknown>("/asset-search/semantic", {
      method: "POST",
      body: JSON.stringify({ query, limit }),
    });
    const list = normaliseMappedList(raw, assetFromUnknown);
    const record = isRecord(raw) ? raw : {};
    const mode = record.mode === "hybrid" || record.mode === "structured_fallback" ? record.mode : undefined;
    const degradedReason = typeof record.degraded_reason === "string" ? record.degraded_reason : undefined;
    track("asset_search", { mode: mode ?? "unknown", count: list.count });
    return { ...list, mode, degraded_reason: degradedReason };
  }

  /** S17-A2：AI 按描述起草提示词（POST /ai/prompt-draft；AI 网关未开启时后端 503，调用方给人话）。
      返回结构化 { autoPrompt, promptText }：autoPrompt = 服务端 AI 提示词原文（不含 supplement 追加段），
      promptText = 服务端合成的完整文本（AI 原文 + supplement 追加）。覆盖语义取 autoPrompt，
      补全语义取 promptText。mediaKind 决定服务端注入项目默认风格/生成模板的媒介分支与成文文案
      （生图/生视频）。model_key/supplement/creative_context 为可选透传,接口形状不动。 */
  async draftPrompt(input: { mediaKind: "image" | "video" | "audio"; name?: string; description: string; selectedAssetIds?: string[]; modelKey?: string; supplement?: string; projectId?: string }): Promise<{ autoPrompt: string; promptText: string }> {
    const body = JSON.stringify({
      media_kind: input.mediaKind,
      description: input.description,
      ...(input.name ? { name: input.name } : {}),
      selected_assets: (input.selectedAssetIds ?? []).map((id) => ({ asset_id: id })),
      ...(input.modelKey ? { model_key: input.modelKey } : {}),
      ...(input.supplement !== undefined ? { supplement: input.supplement } : {}),
      ...(input.projectId ? { context: { project_id: input.projectId } } : {}),
    });
    // 诊断日志：打印点击「✨ AI 优化提示词」/「AI 生成」时发送的请求体与后端返回。
    console.log(`[draftPrompt] request body:\n${body}`);
    const raw = (await this.request("/ai/prompt-draft", {
      method: "POST",
      body,
    })) as { auto_prompt?: unknown; prompt_text?: unknown; draft?: unknown };
    const promptText = typeof raw.prompt_text === "string"
      ? raw.prompt_text
      : (typeof raw.draft === "string" ? raw.draft : "");
    const autoPrompt = typeof raw.auto_prompt === "string" ? raw.auto_prompt : promptText;
    if (promptText) {
      console.log(`[draftPrompt] response prompt_text:\n${promptText}`);
    }
    return { autoPrompt, promptText };
  }

  /** GENDOMAIN/V-13:AI 提示词模型目录(GET /ai/prompt-models;quality/fast 两档,带 defaultKey)。
      服务端回 snake_case(display_name/is_default/default_key),这里翻一次。 */
  async listPromptModels(): Promise<{ items: { key: string; displayName: string; description?: string; available: boolean; isDefault?: boolean }[]; defaultKey?: string }> {
    const raw = (await this.request("/ai/prompt-models")) as { items?: unknown; default_key?: unknown };
    const items = Array.isArray(raw.items)
      ? (raw.items as Record<string, unknown>[]).map((item) => ({
          key: String(item.key ?? ""),
          displayName: String(item.display_name ?? item.key ?? ""),
          description: typeof item.description === "string" ? item.description : undefined,
          available: item.available !== false,
          isDefault: item.is_default === true,
        }))
      : [];
    return { items, defaultKey: typeof raw.default_key === "string" ? raw.default_key : undefined };
  }

  /** GENDOMAIN/V-13:AI 提示词中英互译(POST /ai/prompt-translate;返回合成文本 prompt_text)。 */
  async translatePrompt(input: { auto: string; supplement?: string; targetLanguage: "zh" | "en"; modelKey?: string; projectId?: string }): Promise<string> {
    const raw = (await this.request("/ai/prompt-translate", {
      method: "POST",
      body: JSON.stringify({
        prompt: { auto: input.auto, supplement: input.supplement ?? "" },
        target_language: input.targetLanguage,
        ...(input.modelKey ? { model_key: input.modelKey } : {}),
        ...(input.projectId ? { context: { project_id: input.projectId } } : {}),
      }),
    })) as { prompt_text?: unknown };
    return typeof raw.prompt_text === "string" ? raw.prompt_text : "";
  }
  /**
   * S13：混合资产检索（POST /api/v1/asset-search，仓根 src/modules/assets/routes.ts:305 已上线）。
   * 词法+语义已在服务端 RRF 融合——前端没有也不需要「模式」概念；响应 { items, page, page_size, has_more }
   * （diagnostics 仅供支持排查，不上界面）。分页接真：page/page_size 直达接口，前端切片退役。
   */
  async assetSearch(query: string, input: {
    scope?: "personal" | "common";
    projectId?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<AssetSearchPage> {
    const raw = (await this.request("/asset-search", {
      method: "POST",
      body: JSON.stringify({
        query,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.projectId ? { project_id: input.projectId } : {}),
        page: input.page ?? 1,
        page_size: input.pageSize ?? 20,
      }),
    })) as Record<string, unknown>;
    const list = normaliseMappedList(raw, assetFromUnknown);
    const record = isRecord(raw) ? raw : {};
    track("asset_search", { mode: "hybrid", count: list.count, page: input.page ?? 1 });
    return {
      items: list.items,
      count: list.count,
      page: typeof record.page === "number" ? record.page : (input.page ?? 1),
      pageSize: typeof record.page_size === "number" ? record.page_size : (input.pageSize ?? 20),
      hasMore: record.has_more === true,
    };
  }

  async uploadAsset(file: File, input: { sourceProjectName?: string; assetKindHint?: string } = {}): Promise<ListData<Asset>> {
    const form = new FormData();
    form.append("file", file);
    if (input.sourceProjectName) form.append("source_project_name", input.sourceProjectName);
    if (input.assetKindHint) form.append("asset_kind_hint", input.assetKindHint);
    const result = await this.request<unknown>("/asset-ingest/upload", { method: "POST", body: form });
    const list = normaliseMappedList(result, assetFromUnknown);
    track("asset_import", { channel: "upload", count: list.count });
    return list;
  }

  /* ---------- S42: 图片上传异步队列(提交即 202,进度/终态走站内提醒,关窗不丢任务) ---------- */

  async submitAssetUploadTask(file: File, input: { assetKindHint?: string } = {}): Promise<AssetUploadTask> {
    const form = new FormData();
    form.append("file", file);
    if (input.assetKindHint) form.append("asset_kind_hint", input.assetKindHint);
    const task = await this.request<AssetUploadTask>("/asset-upload-tasks", { method: "POST", body: form });
    track("asset_upload_submit", { file_name: file.name });
    return task;
  }

  async uploadVideoAsset(file: File, input: {
    name?: string;
    description?: string;
    sourceProjectName?: string;
  } = {}): Promise<VideoIngestSubmission> {
    const name = input.name?.trim() || file.name.replace(/\.[^.]+$/, "").trim() || file.name;
    const form = new FormData();
    form.append("file", file);
    form.append("name", name);
    if (input.description?.trim()) form.append("description", input.description.trim());
    if (input.sourceProjectName?.trim()) form.append("source_project_name", input.sourceProjectName.trim());
    const result = await this.request<unknown>("/asset-ingest/videos/upload", { method: "POST", body: form });
    const submission = videoIngestSubmissionFromUnknown(result);
    track("asset_import", { channel: "video_upload", task_id: submission.taskId });
    return submission;
  }

  async uploadAudioAsset(file: File, input: {
    name?: string;
    description?: string;
    category: AudioIngestCategory;
    sourceProjectName?: string;
    voiceTraits?: readonly string[];
    speakingStyle?: string;
    musicTraits?: readonly string[];
    tempo?: string;
    usageScene?: string;
  }): Promise<AudioIngestSubmission> {
    const name = input.name?.trim() || file.name.replace(/\.[^.]+$/, "").trim() || file.name;
    const form = new FormData();
    form.append("file", file);
    form.append("name", name);
    form.append("category", input.category);
    appendTrimmedFormValue(form, "description", input.description);
    appendTrimmedFormValue(form, "source_project_name", input.sourceProjectName);
    if (input.category === "音色") {
      appendTrimmedFormList(form, "voice_traits", input.voiceTraits);
      appendTrimmedFormValue(form, "speaking_style", input.speakingStyle);
    } else {
      appendTrimmedFormList(form, "music_traits", input.musicTraits);
      appendTrimmedFormValue(form, "tempo", input.tempo);
      appendTrimmedFormValue(form, "usage_scene", input.usageScene);
    }
    const result = await this.request<unknown>("/asset-ingest/audio/upload", { method: "POST", body: form });
    const submission = audioIngestSubmissionFromUnknown(result);
    track("asset_import", { channel: "audio_upload", asset_id: submission.assetId, media_id: submission.mediaId });
    return submission;
  }

  /** 当前用户的活跃(queued/processing)上传任务;服务端不回终态(终态走提醒)。 */
  async assetUploadTasks(): Promise<AssetUploadTaskList> {
    return this.request("/asset-upload-tasks");
  }

  /** 服务端生成在途(冻结信封,status 单轴,等待最久优先;批次二队列换源真源)。 */
  async generationsInFlight(input: { page?: number; pageSize?: number } = {}): Promise<{ items: GenerationInFlight[]; total: number }> {
    const raw = (await this.request(`/generations/in-flight${queryString({ page: input.page, page_size: input.pageSize ?? 50 })}`)) as Record<string, unknown>;
    const items = Array.isArray(raw.items) ? (raw.items as GenerationInFlight[]) : [];
    const total = typeof raw.total === "number" ? raw.total : items.length;
    return { items, total };
  }

  /** 失败生成任务只读列表(P-10 失败区真源;合同 sol-failed-tasks-shape-20260803:
      每 request 只回最新 attempt 仍 failed 的行,重试后自动移出;ack 独立不丢行)。 */
  async generationsFailed(input: { page?: number; pageSize?: number } = {}): Promise<{ items: FailedGenerationTask[]; total: number }> {
    const raw = (await this.request(`/generations/failed${queryString({ page: input.page, page_size: input.pageSize ?? 24 })}`)) as Record<string, unknown>;
    const items = Array.isArray(raw.items) ? (raw.items as FailedGenerationTask[]) : [];
    const total = typeof raw.total === "number" ? raw.total : items.length;
    return { items, total };
  }

  async assetUploadNotifications(limit = 20): Promise<AssetUploadNotificationList> {
    return this.request(`/asset-upload-notifications${queryString({ limit })}`);
  }

  async acknowledgeAssetUploadNotification(notificationId: string): Promise<void> {
    await this.request(`/asset-upload-notifications/${encodeURIComponent(notificationId)}/acknowledge`, {
      method: "POST",
    });
  }

  async asset(assetId: string): Promise<Asset> {
    return assetFromUnknown(await this.request(`/assets/${encodeURIComponent(assetId)}`));
  }

  async deleteAsset(assetId: string): Promise<void> {
    await this.request(`/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  }

  async assetVersions(assetId: string): Promise<ListData<MediaVersion>> {
    return normaliseMappedList(await this.request(`/assets/${encodeURIComponent(assetId)}/versions`), mediaVersionFromUnknown);
  }

  async uploadAssetMedia(
    assetId: string,
    file: File,
    input: { title?: string; description?: string; isPrimary?: boolean; assetVariantId?: string; mediaKind?: "image" | "audio" } = {},
  ): Promise<MediaVersion> {
    const form = new FormData();
    form.append("file", file);
    form.append("media_kind", input.mediaKind ?? "image");
    form.append("is_primary", input.isPrimary ? "true" : "false");
    if (input.title?.trim()) form.append("title", input.title.trim());
    if (input.description?.trim()) form.append("description", input.description.trim());
    if (input.assetVariantId) form.append("asset_variant_id", input.assetVariantId);
    return mediaVersionFromUnknown(await this.request(`/assets/${encodeURIComponent(assetId)}/media`, { method: "POST", body: form }));
  }

  /** 创建资产变体（复用 assets 模块已有 API）。返回 { id, name }。 */
  async createAssetVariant(assetId: string, input: { name: string; description?: string; variant_kind?: string; is_primary?: boolean }): Promise<{ id: string; name: string }> {
    const body: Record<string, string | boolean> = { name: input.name };
    if (input.description) body.description = input.description;
    if (input.variant_kind) body.variant_kind = input.variant_kind;
    if (input.is_primary !== undefined) body.is_primary = input.is_primary;
    const res = await this.request(
      `/assets/${encodeURIComponent(assetId)}/variants`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!isRecord(res)) throw new Error("创建变体失败：返回格式异常");
    return {
      id: optionalString(res.id) ?? "",
      name: optionalString(res.name) ?? input.name,
    };
  }

  /** S11-5：资产 PATCH（后端 updateAssetSchema 含 role/usage_mode；上传弹窗「资产职责」与
      Lite 首帧登记后的 usage_mode=first_frame 标记都走这里）。 */
  async updateAsset(assetId: string, input: { role?: string | null; usage_mode?: "reference" | "first_frame" | "last_frame" | null }): Promise<Asset> {
    return assetFromUnknown(await this.request(`/assets/${encodeURIComponent(assetId)}`, { method: "PATCH", body: JSON.stringify(input) }));
  }

  /* ---------- 运营底座（合同 v0.2.0/operations-foundation；后端 src/modules/operations/routes.ts） ---------- */

  /** S12-1：入口显隐唯一真源。 */
  async meCapabilities(): Promise<Capabilities> {
    return capabilitiesFromUnknown(await this.request("/me/capabilities"));
  }

  /* 项目成员（owner/admin；合同 CRUD /projects/:id/members） */
  async projectMembers(projectId: string): Promise<ProjectMember[]> {
    const raw = (await this.request(`/projects/${encodeURIComponent(projectId)}/members`)) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(memberFromUnknown);
  }
  async addProjectMember(projectId: string, input: { userId: string; role: string }): Promise<ProjectMember> {
    const raw = (await this.request(`/projects/${encodeURIComponent(projectId)}/members`, {
      method: "POST",
      body: JSON.stringify({ user_id: input.userId, role: input.role }),
    })) as { item?: unknown };
    return memberFromUnknown(raw.item);
  }
  async updateProjectMember(projectId: string, userId: string, input: { role: string }): Promise<ProjectMember> {
    const raw = (await this.request(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role: input.role }),
    })) as { item?: unknown };
    return memberFromUnknown(raw.item);
  }
  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  /** S12-5：后台成本（operator/admin，group_by=project|team|user|model；CSV 另行 text 拉取）。 */
  async adminCostAggregate(groupBy: "project" | "team" | "user" | "model"): Promise<CostAggregatePage> {
    return costPageFromUnknown(await this.request(`/admin/costs?group_by=${groupBy}`));
  }
  /** 后台成本 CSV 导出（同源接口 format=csv；前端不自己拼 CSV）。 */
  async adminCostsCsvBlob(groupBy: "project" | "team" | "user" | "model"): Promise<Blob> {
    const headers = new Headers();
    const token = this.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${API_PREFIX}/admin/costs?group_by=${groupBy}&format=csv`, { headers });
    if (!response.ok) throw new ApiClientError("CSV 导出失败，请稍后重试", { status: response.status });
    return response.blob();
  }

  /* 团队（admin） */
  async adminTeams(): Promise<TeamRecord[]> {
    const raw = (await this.request("/admin/teams")) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(teamFromUnknown);
  }
  async createTeam(input: { name: string; parentTeamId?: string | null }): Promise<TeamRecord> {
    const raw = (await this.request("/admin/teams", { method: "POST", body: JSON.stringify({ name: input.name, parent_team_id: input.parentTeamId ?? null }) })) as { item?: unknown };
    return teamFromUnknown(raw.item);
  }
  async updateTeam(teamId: string, input: { name?: string; parentTeamId?: string | null }): Promise<TeamRecord> {
    const raw = (await this.request(`/admin/teams/${encodeURIComponent(teamId)}`, { method: "PATCH", body: JSON.stringify({ name: input.name, parent_team_id: input.parentTeamId }) })) as { item?: unknown };
    return teamFromUnknown(raw.item);
  }
  async deleteTeam(teamId: string): Promise<void> {
    await this.request(`/admin/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
  }
  async teamMembers(teamId: string): Promise<UserDirectoryRecord[]> {
    const raw = (await this.request(`/admin/teams/${encodeURIComponent(teamId)}/members`)) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(directoryUserFromUnknown);
  }
  async addTeamMember(teamId: string, userId: string): Promise<void> {
    await this.request(`/admin/teams/${encodeURIComponent(teamId)}/members`, { method: "POST", body: JSON.stringify({ user_id: userId }) });
  }
  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.request(`/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  /* 用户分组（admin） */
  async adminUserGroups(): Promise<UserGroupRecord[]> {
    const raw = (await this.request("/admin/user-groups")) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(userGroupFromUnknown);
  }
  async createUserGroup(input: { name: string }): Promise<UserGroupRecord> {
    const raw = (await this.request("/admin/user-groups", { method: "POST", body: JSON.stringify({ name: input.name }) })) as { item?: unknown };
    return userGroupFromUnknown(raw.item);
  }
  async updateUserGroup(groupId: string, input: { name?: string }): Promise<UserGroupRecord> {
    const raw = (await this.request(`/admin/user-groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: JSON.stringify(input) })) as { item?: unknown };
    return userGroupFromUnknown(raw.item);
  }
  async deleteUserGroup(groupId: string): Promise<void> {
    await this.request(`/admin/user-groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
  }
  async userGroupMembers(groupId: string): Promise<UserDirectoryRecord[]> {
    const raw = (await this.request(`/admin/user-groups/${encodeURIComponent(groupId)}/members`)) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(directoryUserFromUnknown);
  }
  async addUserGroupMember(groupId: string, userId: string): Promise<void> {
    await this.request(`/admin/user-groups/${encodeURIComponent(groupId)}/members`, { method: "POST", body: JSON.stringify({ user_id: userId }) });
  }
  async removeUserGroupMember(groupId: string, userId: string): Promise<void> {
    await this.request(`/admin/user-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  /** S12-3：项目运营字段 PATCH（genre/审核策略/审核人；后端 updateProjectSchema + operations patch）。 */
  async patchProjectOperations(projectId: string, input: {
    name?: string;
    description?: string;
    genre?: string | null;
    reviewPolicies?: Partial<Record<"image" | "video", { defaultStrategy: string; reviewerUserId?: string | null }>>;
  }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.genre !== undefined) body.genre = input.genre;
    if (input.reviewPolicies) {
      const rp: Record<string, unknown> = {};
      for (const kind of ["image", "video"] as const) {
        const policy = input.reviewPolicies[kind];
        if (policy) rp[kind] = { default_strategy: policy.defaultStrategy, reviewer_user_id: policy.reviewerUserId ?? null };
      }
      body.review_policies = rp;
    }
    await this.request(`/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  /* ---------- #151 项目级生成配置（合同 docs/design/prd-v2/project.md §二/§四） ---------- */

  /** 保存项目级生成默认值（画幅/双清晰度/双风格/双提示词模板）。
      字段形状=后端 generationConfigSchema 认的 generation_config 嵌套结构（#177 前发平铺被整体拒绝）。 */
  async updateProjectGenerationConfig(projectId: string, config: ProjectGenerationConfig): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(projectGenerationConfigToWire(config)),
    });
  }

  /** 平台默认提示词模板（图片/视频各一套，只读；docs/design/prd-v2/lite-model-defaults.md §4.3
      系统默认 = 代码常量，由后端 /generation/default-prompt-templates 只读暴露）。 */
  async defaultPromptTemplates(): Promise<{ image: string; video: string }> {
    const raw = (await this.request("/generation/default-prompt-templates")) as { image?: unknown; video?: unknown };
    return {
      image: typeof raw.image === "string" ? raw.image : "",
      video: typeof raw.video === "string" ? raw.video : "",
    };
  }

  /** S12-2 辅助：按用户名解析用户（admin/operator 目录；普通 owner 无目录接口——缺口如实展示）。 */
  async adminUsers(): Promise<UserDirectoryRecord[]> {
    const raw = (await this.request("/admin/users")) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(directoryUserFromUnknown);
  }

  /* ---------- #152 后台用户管理（合同 docs/design/prd-v2/admin.md §4） ---------- */

  /** 管理视角的用户列表：带邮箱与积分账户。 */
  async adminUserAccounts(): Promise<AdminUserAccount[]> {
    const raw = (await this.request("/admin/users")) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(adminUserAccountFromUnknown);
  }

  /** 新增用户：初始密码只在这一次响应里回来，界面只显示一次。 */
  async adminCreateUser(input: { username: string; displayName?: string; role?: "admin" | "operator" | "member" }): Promise<{ user: AdminUserAccount; initialPassword: string }> {
    const raw = (await this.request("/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username: input.username,
        ...(input.displayName ? { display_name: input.displayName } : {}),
        ...(input.role ? { role: input.role } : {}),
      }),
    })) as { user?: unknown; initial_password?: unknown };
    return {
      user: adminUserAccountFromUnknown(raw.user),
      initialPassword: typeof raw.initial_password === "string" ? raw.initial_password : "",
    };
  }

  /** 改角色：admin/operator/member；最后一个启用中的管理员后端会拒绝降级。 */
  async adminUpdateUserRole(userId: string, role: "admin" | "operator" | "member"): Promise<AdminUserAccount> {
    const raw = (await this.request(`/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    })) as { user?: unknown };
    return adminUserAccountFromUnknown(raw.user);
  }

  /** 停用：可逆（不是删除）；后端会吊销他的全部登录会话。 */
  async adminDisableUser(userId: string): Promise<{ user: AdminUserAccount; changed: boolean; revokedSessionCount: number }> {
    const raw = (await this.request(`/admin/users/${encodeURIComponent(userId)}/disable`, { method: "POST" })) as {
      user?: unknown;
      changed?: unknown;
      revoked_session_count?: unknown;
    };
    return {
      user: adminUserAccountFromUnknown(raw.user),
      changed: raw.changed === true,
      revokedSessionCount: typeof raw.revoked_session_count === "number" ? raw.revoked_session_count : 0,
    };
  }

  /** 重置密码：临时密码只在这一次响应里回来；他的旧登录会话全部被吊销。 */
  async adminResetUserPassword(userId: string): Promise<{ user: AdminUserAccount; changed: boolean; revokedSessionCount: number; temporaryPassword: string }> {
    const raw = (await this.request(`/admin/users/${encodeURIComponent(userId)}/reset-password`, { method: "POST" })) as {
      user?: unknown;
      changed?: unknown;
      revoked_session_count?: unknown;
      temporary_password?: unknown;
    };
    return {
      user: adminUserAccountFromUnknown(raw.user),
      changed: raw.changed === true,
      revokedSessionCount: typeof raw.revoked_session_count === "number" ? raw.revoked_session_count : 0,
      temporaryPassword: typeof raw.temporary_password === "string" ? raw.temporary_password : "",
    };
  }

  /** S17-A1：用户目录搜索（GET /users/directory，任何登录用户可用；成员/审核人选人走这里）。 */
  async searchUserDirectory(query: string): Promise<UserDirectoryRecord[]> {
    const raw = (await this.request(`/users/directory?q=${encodeURIComponent(query.trim())}`)) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(directoryUserFromUnknown);
  }

  /* ---------- S65 账户积分与邀请码（合同 v0.2.0/self-registration-and-account-credits） ---------- */

  /** 我的余额与日额度（登录即可读）。 */
  async accountCreditsMe(): Promise<AccountCreditSummary> {
    return accountCreditSummaryFromUnknown(await this.request("/account-credits/me"));
  }

  async adminInviteTiers(): Promise<InviteTier[]> {
    const raw = (await this.request("/admin/invite-tiers")) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(inviteTierFromUnknown);
  }

  async createInviteTier(input: { code: string; name: string; grantPoints: number; dailyLimitPoints: number }): Promise<InviteTier> {
    const raw = (await this.request("/admin/invite-tiers", {
      method: "POST",
      body: JSON.stringify({ code: input.code, name: input.name, grant_points: input.grantPoints, daily_limit_points: input.dailyLimitPoints }),
    })) as { item?: unknown };
    return inviteTierFromUnknown(raw.item);
  }

  async updateInviteTier(tierId: string, input: { name?: string; grantPoints?: number; dailyLimitPoints?: number; active?: boolean }): Promise<InviteTier> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.grantPoints !== undefined) body.grant_points = input.grantPoints;
    if (input.dailyLimitPoints !== undefined) body.daily_limit_points = input.dailyLimitPoints;
    if (input.active !== undefined) body.active = input.active;
    const raw = (await this.request(`/admin/invite-tiers/${encodeURIComponent(tierId)}`, { method: "PATCH", body: JSON.stringify(body) })) as { item?: unknown };
    return inviteTierFromUnknown(raw.item);
  }

  /** 删除=停用（后端口径），已发出的码不受影响。 */
  async deactivateInviteTier(tierId: string): Promise<void> {
    await this.request(`/admin/invite-tiers/${encodeURIComponent(tierId)}`, { method: "DELETE" });
  }

  async adminInviteCodes(): Promise<InviteCode[]> {
    const raw = (await this.request("/admin/invite-codes")) as { items?: unknown[] };
    return (Array.isArray(raw.items) ? raw.items : []).map(inviteCodeFromUnknown);
  }

  /** 明文邀请码只在创建响应出现一次——调用方必须就地交接，之后只能看到掩码前缀。 */
  async createInviteCode(input: { tierId: string; maxRedemptions?: number; expiresAt?: string | null }): Promise<{ inviteCode: InviteCode; plaintextCode: string }> {
    const body: Record<string, unknown> = { tier_id: input.tierId };
    if (input.maxRedemptions !== undefined) body.max_redemptions = input.maxRedemptions;
    if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
    const raw = (await this.request("/admin/invite-codes", { method: "POST", body: JSON.stringify(body) })) as { invite_code?: unknown; plaintext_code?: unknown };
    return { inviteCode: inviteCodeFromUnknown(raw.invite_code), plaintextCode: typeof raw.plaintext_code === "string" ? raw.plaintext_code : "" };
  }

  /** 停用=撤销（后端口径），已核销的注册不回滚。 */
  async deactivateInviteCode(codeId: string): Promise<void> {
    await this.request(`/admin/invite-codes/${encodeURIComponent(codeId)}`, { method: "DELETE" });
  }

  async selfRegistrationPolicy(): Promise<SelfRegistrationCreditPolicy> {
    const raw = (await this.request("/admin/account-credit-policies/self-registration")) as { policy?: unknown };
    return selfRegistrationPolicyFromUnknown(raw.policy);
  }

  /** 只影响之后创建的账户；既有账户日额度不回写（合同 §1）。 */
  async updateSelfRegistrationPolicy(dailyLimitPoints: number): Promise<SelfRegistrationCreditPolicy> {
    const raw = (await this.request("/admin/account-credit-policies/self-registration", {
      method: "PATCH",
      body: JSON.stringify({ daily_limit_points: dailyLimitPoints }),
    })) as { policy?: unknown };
    return selfRegistrationPolicyFromUnknown(raw.policy);
  }

  /** 人工调账：正数充值、负数扣减；后端拒绝余额变负，原因必填并写台账+审计。 */
  async adjustAccountCredits(userId: string, input: { amountPoints: number; reason: string }): Promise<AccountCreditAdjustment> {
    const raw = (await this.request(`/admin/users/${encodeURIComponent(userId)}/account-credits/adjust`, {
      method: "POST",
      body: JSON.stringify({ amount_points: input.amountPoints, reason: input.reason }),
    })) as { adjustment?: unknown };
    return accountCreditAdjustmentFromUnknown(raw.adjustment);
  }

  /** 登录已失效（401）时清除本地登录态，并通知 App 层处理。登录/注册本身的 401 属于密码错误，不触发。
      detail.reason 分「过期/被顶下线」（本地到期时间还在未来却 401 = 会话被提前吊销），
      App 层原地弹重登小窗，页面与用户未提交的内容原地不动（F01/F02/F04）。 */
  private handleUnauthorized(status: number, path: string): void {
    handleUnauthorizedResponse(status, path);
  }

  async setAssetPrimary(assetId: string, mediaId: string): Promise<MediaVersion> {
    return mediaVersionFromUnknown(await this.request(`/assets/${encodeURIComponent(assetId)}/media/${encodeURIComponent(mediaId)}/set-primary`, { method: "POST" }));
  }

  async projectAssets(projectId: string): Promise<ListData<ProjectAssetRef>> {
    return normaliseMappedList(await this.request(`/projects/${encodeURIComponent(projectId)}/assets`), projectAssetRefFromUnknown);
  }

  async addProjectAsset(projectId: string, assetId: string, assetMediaId?: string): Promise<ProjectAssetRef> {
    /* S17-B：后端引用接受无媒体（asset_media_id 可空，实证 201——空资产建档后可直接回家进项目）；
       旧「必须选图片版本」是前端基于过期假设的人工拦截。生成参考的无图护栏在引用选择器侧，不受影响。 */
    return projectAssetRefFromUnknown(await this.request(`/projects/${encodeURIComponent(projectId)}/assets`, {
      method: "POST",
      body: JSON.stringify({
        asset_entity_id: assetId,
        ...(assetMediaId?.trim() ? { asset_media_id: assetMediaId } : {}),
      }),
    }));
  }

  /** 把资产移出项目（撤销"加入项目"）：只解除引用，不删除资产本体。 */
  async removeProjectAsset(projectId: string, refId: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(refId)}`, { method: "DELETE" });
  }

  async episodes(projectId: string): Promise<ListData<Episode>> {
    return normaliseList<Episode>(await this.request(`/projects/${encodeURIComponent(projectId)}/episodes`));
  }

  async createEpisode(projectId: string, input: { title: string; episode_no?: number }): Promise<Episode> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/episodes`, {
      method: "POST",
      body: JSON.stringify({ episode_no: input.episode_no ?? 1, name: input.title }),
    });
  }

  /** 软删集（DELETE /episodes/:id，production routes 已存在；R1 特许的项目内可逆操作）。 */
  async deleteEpisode(episodeId: string): Promise<void> {
    await this.request(`/episodes/${encodeURIComponent(episodeId)}`, { method: "DELETE" });
  }

  /** S11-3：集内场景真数据（GET /episodes/:id/scenes，仓根 production/routes.ts:124 已在册）。
   *  原「api 层暂无 scenes 查询」硬编码「未分场」兜底退役——场景真实存在，真没有才显示「未分场」。 */
  async episodeScenes(episodeId: string): Promise<ListData<Scene>> {
    return normaliseList<Scene>(await this.request(`/episodes/${encodeURIComponent(episodeId)}/scenes`));
  }

  /** 建场（POST /episodes/:id/scenes，仓根 production/routes.ts:215-224 已在册，前端此前未接）。
   *  生产页手动加分镜时若本集还没有场需要先建一场兜底——没有场的分镜在按场分组的场卡视图里进不了任何卡片。 */
  async createScene(episodeId: string, input: { scene_no: number; name?: string | null; description?: string | null; sort_order?: number }): Promise<Scene> {
    return this.request(`/episodes/${encodeURIComponent(episodeId)}/scenes`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** 块 1 集视图:集级生产状态投影(GET /episodes/:id/production-status,sol SOL-P02B-BACKEND-DONE)。
   *  七态 not_broken_down/broken_down/preparing/ready/generating/has_media/delivered;
   *  场级带 shot_summary/control_package_summary(x/N)/attempt_summary(queue_position)/cover_media。 */
  async episodeProductionStatus(episodeId: string): Promise<EpisodeProductionStatus> {
    return this.request(`/episodes/${encodeURIComponent(episodeId)}/production-status`);
  }

  async shots(episodeId: string): Promise<ListData<Shot>> {
    return normaliseList<Shot>(await this.request(`/episodes/${encodeURIComponent(episodeId)}/shots`));
  }

  async createShot(episodeId: string, input: Partial<Shot>): Promise<Shot> {
    return this.request(`/episodes/${encodeURIComponent(episodeId)}/shots`, { method: "POST", body: JSON.stringify(input) });
  }

  async shot(shotId: string): Promise<Shot> {
    return this.request(`/shots/${encodeURIComponent(shotId)}`);
  }

  async updateShot(shotId: string, input: Partial<Pick<Shot, "title" | "scene_id" | "script_text" | "breakdown_elements" | "director_prompt" | "image_prompt" | "video_prompt" | "duration_seconds" | "metadata">>): Promise<Shot> {
    return this.request(`/shots/${encodeURIComponent(shotId)}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  /** v1.4（065）：集级概要失焦保存（PATCH /episodes/:id 放开 synopsis）；
   *  sort_order：制作页左栏拖动排序（lite-ui-rework R2-13）。 */
  async updateEpisode(episodeId: string, input: { synopsis?: string | null; name?: string | null; sort_order?: number }): Promise<Episode> {
    return this.request(`/episodes/${encodeURIComponent(episodeId)}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  /** v1.4（065）：分镜-资产引用 CRUD（production 新增端点，读写 shot_asset_refs）。 */
  async shotAssetRefs(shotId: string): Promise<ListData<ShotAssetRef>> {
    return normaliseList<ShotAssetRef>(await this.request(`/shots/${encodeURIComponent(shotId)}/asset-refs`));
  }

  async createShotAssetRef(
    shotId: string,
    input: {
      asset_entity_id: string;
      asset_variant_id?: string | null;
      asset_media_id?: string | null;
      usage_mode?: "reference" | "first_frame" | "last_frame" | null;
      enabled?: boolean;
      sort_order?: number;
    },
  ): Promise<ShotAssetRef> {
    return this.request(`/shots/${encodeURIComponent(shotId)}/asset-refs`, { method: "POST", body: JSON.stringify(input) });
  }

  async updateShotAssetRef(
    shotId: string,
    refId: string,
    input: {
      asset_variant_id?: string | null;
      asset_media_id?: string | null;
      usage_mode?: "reference" | "first_frame" | "last_frame" | null;
      enabled?: boolean;
      sort_order?: number;
    },
  ): Promise<ShotAssetRef> {
    return this.request(`/shots/${encodeURIComponent(shotId)}/asset-refs/${encodeURIComponent(refId)}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  async deleteShotAssetRef(shotId: string, refId: string): Promise<void> {
    await this.request(`/shots/${encodeURIComponent(shotId)}/asset-refs/${encodeURIComponent(refId)}`, { method: "DELETE" });
  }

  /** v1.4（065）：视频版本标签与备注（PATCH /shots/:id/media/:mediaId/version-label）。 */
  async setVersionLabel(shotId: string, mediaId: string, versionLabel: string | null, versionNote: string | null = null): Promise<{ shot_id: string; media_kind: string; media_result_id: string; version_label: string | null; version_note: string | null }> {
    return this.request(`/shots/${encodeURIComponent(shotId)}/media/${encodeURIComponent(mediaId)}/version-label`, {
      method: "PATCH",
      body: JSON.stringify({ version_label: versionLabel, version_note: versionNote }),
    });
  }

  /** Lite 界面重做 §4.3.2：删除视频版本（软删；当前版需先换）。
      返回被删版本 id；前端据此从本地版本列表移除。 */
  async deleteShotMedia(shotId: string, mediaId: string): Promise<{ shot_id: string; media_kind: string; media_result_id: string }> {
    return this.request(`/shots/${encodeURIComponent(shotId)}/media/${encodeURIComponent(mediaId)}`, { method: "DELETE" });
  }

  async shotMedia(shotId: string): Promise<ListData<MediaVersion>> {
    return normaliseList<MediaVersion>(await this.request(`/shots/${encodeURIComponent(shotId)}/media`));
  }

  /** #164 结果页:镜头产物全字段条目(定稿语义 PRD 生产章 §十),与 MediaVersion 分型不混用。 */
  async shotMediaItems(shotId: string): Promise<ListData<ShotMediaItem>> {
    const list = normaliseList<unknown>(await this.request(`/shots/${encodeURIComponent(shotId)}/media`));
    return { ...list, items: list.items.map(shotMediaItemFromUnknown) };
  }

  /** #164 定稿图 → 火山可信素材登记查询;未登记返回 null(404 是人话口径,不算错误)。 */
  async mediaResultRegistration(mediaResultId: string): Promise<MediaResultRegistration | null> {
    try {
      const raw = await this.request(`/media-results/${encodeURIComponent(mediaResultId)}/seedance-registration`);
      const registration = isRecord(raw) ? raw.registration : null;
      return mediaResultRegistrationFromUnknown(registration);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) return null;
      throw error;
    }
  }

  /** #164 存进资产库(服务端素材登记流):一次调用=建资产+挂图+火山登记,
      产物可追溯(source_media_result_id),登记成功即可当视频参考。 */
  async registerMediaResultAsset(mediaResultId: string): Promise<MediaResultRegistration> {
    const raw = await this.request(`/media-results/${encodeURIComponent(mediaResultId)}/seedance-registration`, { method: "POST" });
    const registration = isRecord(raw) ? raw.registration : null;
    const parsed = mediaResultRegistrationFromUnknown(registration);
    if (!parsed) throw new ApiClientError("素材登记响应格式不正确", { code: "invalid_response" });
    return parsed;
  }

  async setShotPrimary(shotId: string, mediaId: string): Promise<{ shot_id: string; media_kind: string; selected_media_result_id: string }> {
    return this.request(`/shots/${encodeURIComponent(shotId)}/media/${encodeURIComponent(mediaId)}/set-primary`, { method: "POST" });
  }

  async episodePlayback(episodeId: string): Promise<EpisodePlayback> {
    return this.request(`/episodes/${encodeURIComponent(episodeId)}/playback`);
  }

  async episodeDeliverables(episodeId: string, partial = false): Promise<GatedManifest> {
    return gatedManifestFromUnknown(await this.request(`/episodes/${encodeURIComponent(episodeId)}/deliverables${partial ? "?partial=true" : ""}`));
  }

  async downloadEpisodeJson(episodeId: string, partial = false): Promise<void> {
    const manifest = await this.episodeDeliverables(episodeId, partial);
    this.saveBlob(
      new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json;charset=utf-8" }),
      `episode-${manifest.episode.no}-deliverables.json`,
    );
  }

  async downloadEpisodeCsv(episodeId: string, partial = false): Promise<void> {
    await this.download(`/episodes/${encodeURIComponent(episodeId)}/deliverables.csv${partial ? "?partial=true" : ""}`, `episode-${episodeId}-deliverables.csv`);
  }

  async downloadMedia(mediaId: string): Promise<void> {
    await this.download(`/media/${encodeURIComponent(mediaId)}/download`, `media-${mediaId}`);
  }

  async dashboardSummary(): Promise<DashboardSummary> {
    return this.request("/dashboard/summary");
  }

  async projectCosts(projectId: string, groupBy: ProjectCostGroupBy): Promise<CostAggregatePage> {
    return costPageFromUnknown(
      await this.request(`/projects/${encodeURIComponent(projectId)}/costs${queryString({ group_by: groupBy, page_size: 100 })}`),
    );
  }

  /** 模型槽位真数据（GET /api/v1/admin/models，管理员接口；非管理员 403 由调用方回落）。
      多模型接缝:mediaKind 三态直通,音频不再错并成图片。 */
  async adminModels(): Promise<Array<{ id: string; displayName: string; mediaKind: "image" | "video" | "audio"; configurationStatus: "configured" | "unconfigured" }>> {
    const raw = await this.request("/admin/models");
    const items = Array.isArray((raw as { items?: unknown[] }).items) ? (raw as { items: Array<Record<string, unknown>> }).items : [];
    return items.map((item) => {
      const kind = item.mediaKind ?? item.media_kind;
      return {
        id: String(item.id ?? ""),
        displayName: String(item.displayName ?? item.display_name ?? "未命名模型"),
        mediaKind: kind === "video" ? "video" as const : kind === "audio" ? "audio" as const : "image" as const,
        configurationStatus: (item.configurationStatus ?? item.configuration_status) === "configured" ? "configured" as const : "unconfigured" as const,
      };
    });
  }

  /** 配置槽位与 AI 网关开关（GET /api/v1/admin/config-status，登录即可读；
      模型显示名仅管理员返回,成员只见 configured 布尔——S46-A 能力状态条的「模型/开关」维数据源）。 */
  async configStatus(): Promise<{ slots: Array<{ key: string; configured: boolean; modelDisplayName: string | null }>; aiGatewayEnabled: boolean | null }> {
    const raw = await this.request("/admin/config-status") as Record<string, unknown>;
    const slots = Array.isArray(raw.slots) ? raw.slots : [];
    const gateway = (raw.ai_gateway ?? raw.aiGateway ?? {}) as Record<string, unknown>;
    return {
      slots: slots.map((item) => {
        const slot = (item ?? {}) as Record<string, unknown>;
        return {
          key: String(slot.key ?? ""),
          configured: slot.configured === true,
          modelDisplayName: typeof (slot.model_display_name ?? slot.modelDisplayName) === "string"
            ? String(slot.model_display_name ?? slot.modelDisplayName)
            : null,
        };
      }),
      // 旧后端无此字段：判 unknown（状态条显示读取失败重试）,不误报「未开启」。
      aiGatewayEnabled: typeof gateway.enabled === "boolean" ? gateway.enabled : null,
    };
  }

  /** 版本计划与预告（S23：内容入库后的登录可读面）。两段并行读,脏行丢弃;
      读不到时抛错由调用方如实降级,不回退任何写死内容。 */
  async releasePlan(): Promise<{ sections: ReleaseSection[]; history: ReleaseHistoryEntry[] }> {
    const [sectionsRaw, historyRaw] = await Promise.all([
      this.request("/config-entries?kind=release_section"),
      this.request("/config-entries?kind=release_history_entry"),
    ]);
    return {
      sections: configEntriesFromUnknown(sectionsRaw)
        .map((entry) => releaseSectionFromEntry(entry))
        .filter((section): section is ReleaseSection => section !== null),
      history: configEntriesFromUnknown(historyRaw)
        .map((entry) => releaseHistoryFromEntry(entry))
        .filter((entry): entry is ReleaseHistoryEntry => entry !== null),
    };
  }

  /** 管理后台配置项列表(含草稿/归档;仅管理员,403 由调用方给人话)。 */
  async adminConfigEntries(kind: ConfigEntryKind): Promise<ConfigEntry[]> {
    const raw = await this.request(`/admin/config-entries${queryString({ kind })}`);
    return configEntriesFromUnknown(raw);
  }

  /* ---------- ⌘K 命令面板(S30):指令分组与文案走 config_entries ---------- */

  /** 指令分组与面板文案。两段并行读、各自窄归一;任一段失败整体抛错,
      调用方区分「指令没了」与「文案兜底」(copy 读不到时这里给 null,
      由组件落 DEFAULT 文案,与 lane-vocabulary 先例一致)。 */
  async commandPaletteConfig(): Promise<{ groups: CommandPaletteGroup[]; copy: CommandPaletteCopy | null }> {
    const [groupsRaw, copyRaw] = await Promise.all([
      this.request("/config-entries?kind=command_palette_group"),
      this.request("/config-entries?kind=command_palette_copy"),
    ]);
    return {
      groups: commandPaletteGroupsFromUnknown(groupsRaw),
      copy: commandPaletteCopyFromUnknown(copyRaw),
    };
  }

  /** 五组内容搜索(服务端已按项目成员关系过滤,前端只做形状归一)。 */
  async commandPaletteSearch(query: string): Promise<CommandPaletteSearchResults> {
    const raw = await this.request(`/command-palette/search${queryString({ q: query })}`);
    return commandPaletteSearchFromUnknown(raw);
  }

  async createConfigEntry(input: { kind: ConfigEntryKind; entry_key: string; status?: ConfigEntryStatus; sort?: number; payload: unknown }): Promise<ConfigEntry> {
    const raw = await this.request("/admin/config-entries", { method: "POST", body: JSON.stringify(input) });
    const entry = configEntryFromUnknown((raw as { entry?: unknown }).entry);
    if (!entry) throw new ApiClientError("保存后回读格式不正确", { code: "invalid_response" });
    return entry;
  }

  async updateConfigEntry(id: string, patch: { kind: ConfigEntryKind; entry_key?: string; status?: ConfigEntryStatus; sort?: number; payload?: unknown }): Promise<ConfigEntry> {
    const raw = await this.request(`/admin/config-entries/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) });
    const entry = configEntryFromUnknown((raw as { entry?: unknown }).entry);
    if (!entry) throw new ApiClientError("保存后回读格式不正确", { code: "invalid_response" });
    return entry;
  }

  async deleteConfigEntry(id: string): Promise<void> {
    await this.request(`/admin/config-entries/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /* ---------- 创作词表（S24 接线；登录可读,失败抛错由调用方人话降级） ---------- */

  /** 体裁建议：active 词条按 sort 排的 id 数组。 */
  async vocabularyGenres(): Promise<string[]> {
    const raw = await this.request("/vocabulary/genres");
    const items = Array.isArray((raw as { genres?: unknown[] }).genres) ? (raw as { genres: Array<Record<string, unknown>> }).genres : [];
    return items
      .filter((item) => item.active !== false)
      .map((item) => ({ id: String(item.id ?? "").trim(), sort: Number(item.sort ?? 0) || 0 }))
      .filter((item) => item.id.length > 0)
      .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
      .map((item) => item.id);
  }

  /** 用户自定义体裁写入共享建议词表（幂等：已存在服务端回 200,同样算成功）。 */
  async addVocabularyGenre(id: string): Promise<void> {
    await this.request("/vocabulary/genres", { method: "POST", body: JSON.stringify({ id }) });
  }

  /** 参考栏词表（S24-C）：服务端词条驼峰归一后透出,呈现覆盖层合并在 lane-vocabulary。 */
  async vocabularyReferenceLanes(): Promise<LaneVocabularyApiEntry[]> {
    const raw = await this.request("/vocabulary/reference-lanes");
    const items = Array.isArray((raw as { lanes?: unknown[] }).lanes) ? (raw as { lanes: Array<Record<string, unknown>> }).lanes : [];
    return items.map((item) => ({
      id: String(item.id ?? ""),
      displayName: String(item.display_name ?? item.displayName ?? ""),
      domain: String(item.domain ?? ""),
      pickKind: typeof (item.pick_kind ?? item.pickKind) === "string" ? String(item.pick_kind ?? item.pickKind) : null,
      sort: Number(item.sort ?? 0) || 0,
      active: item.active !== false,
      recommended: (Array.isArray(item.recommended) ? item.recommended : []).flatMap((rec) => {
        if (!isRecord(rec)) return [];
        const key = typeof rec.key === "string" ? rec.key : "";
        const label = typeof rec.label === "string" ? rec.label : "";
        if (!key || !label) return [];
        return [{ key, label, required: rec.required === true }];
      }),
    })).filter((item) => item.id.length > 0 && item.displayName.length > 0);
  }

  /** 模型能力档（合同 v0.3.0 §3；接口已上线——裁决 4：调用方不得再对 404/501 静默回落本地档）。
      includeFrozen=true 时连冻结档一起返回（带中文未开通原因），用于 #151 配置选项的置灰展示。 */
  async capabilityTiers(mediaType: "image" | "video" | "audio", includeFrozen = false): Promise<Array<Record<string, unknown>>> {
    const raw = await this.request(`/generation/capability-tiers${queryString({ media_type: mediaType, ...(includeFrozen ? { include_frozen: "true" } : {}) })}`);
    return Array.isArray((raw as { tiers?: unknown[] }).tiers) ? (raw as { tiers: Array<Record<string, unknown>> }).tiers : [];
  }

  /** 消耗逐笔明细（合同附录三）。筛选与分页全量透传服务端；
      后端 page_size 上限 100（modules/consumption-records/routes.ts zod max），超了直接 400，不得拉全量。 */
  async consumptionRecords(projectId: string, params: { from?: string; to?: string; task_type?: string; model?: string; page?: number; page_size?: number } = {}): Promise<{ records: Array<Record<string, unknown>>; total: number; page: number; page_size: number }> {
    const raw = await this.request(`/projects/${encodeURIComponent(projectId)}/consumption/records${queryString(params)}`);
    const records = Array.isArray((raw as { records?: unknown[] }).records) ? (raw as { records: Array<Record<string, unknown>> }).records : [];
    return {
      records,
      total: Number((raw as { total?: unknown }).total ?? records.length) || 0,
      page: Math.max(1, Number((raw as { page?: unknown }).page ?? params.page ?? 1) || 1),
      page_size: Math.max(1, Number((raw as { page_size?: unknown }).page_size ?? params.page_size ?? 20) || 20),
    };
  }

  async trash(kind?: "project" | "asset"): Promise<ListData<TrashItem>> {
    return normaliseList<TrashItem>(await this.request(`/trash${queryString({ kind })}`));
  }

  async restoreTrash(kind: TrashItem["kind"], id: string): Promise<TrashItem> {
    const result = await this.request<{ restored: true; item: TrashItem }>(`/trash/${kind}/${encodeURIComponent(id)}/restore`, { method: "POST" });
    return result.item;
  }

  async permanentlyDeleteTrash(kind: TrashItem["kind"], id: string): Promise<void> {
    await this.request(`/trash/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async previewStoryboard(projectId: string, file: File): Promise<StoryboardImportRecord> {
    const form = new FormData();
    form.append("file", file);
    const value = await this.request<unknown>(`/projects/${encodeURIComponent(projectId)}/storyboard-imports/preview`, { method: "POST", body: form });
    const record = storyboardImportFromUnknown(value);
    if (!record) throw new ApiClientError("服务返回的分镜预览格式无法识别", { code: "invalid_storyboard_preview" });
    return record;
  }

  async confirmStoryboard(importId: string): Promise<StoryboardImportRecord> {
    const value = await this.request<unknown>(`/storyboard-imports/${encodeURIComponent(importId)}/confirm`, { method: "POST" });
    const record = storyboardImportFromUnknown(value);
    if (!record) throw new ApiClientError("服务返回的导入结果格式无法识别", { code: "invalid_storyboard_confirm" });
    return record;
  }

  async quoteGeneration(input: TieredGenerationSubmissionInput): Promise<GenerationQuoteWithTier> {
    return this.request("/generations/estimate", {
      method: "POST",
      body: JSON.stringify({ ...input, action: "submit", source: "web" }),
    });
  }

  /**
   * 简单估价（simpleEstimateSchema，无项目上下文）：body 只带 media_kind/tier_id/parameters/quantity,
   * 不触发 fullEstimateKeys 分支；只看不创建报价（generation_quote_id 恒 null,不可确认/提交）。
   * 适用：无分镜/项目目标上下文的估价预览（如参考测试页运行前看价）。
   */
  async simpleEstimate(input: SimpleEstimateInput): Promise<SimpleEstimate> {
    return simpleEstimateFromUnknown(await this.request("/generations/estimate", {
      method: "POST",
      body: JSON.stringify(input),
    }));
  }

  async quoteGenerationRetry(requestId: string): Promise<GenerationQuoteWithTier> {
    return this.request("/generations/estimate", {
      method: "POST",
      body: JSON.stringify({ action: "retry", source: "web", original_request_id: requestId }),
    });
  }

  async confirmGenerationQuote(quoteId: string): Promise<GenerationQuoteWithTier> {
    const quote = await this.request<GenerationQuoteWithTier>(`/generation-quotes/${encodeURIComponent(quoteId)}/confirm`, { method: "POST" });
    track("generation_confirm", { quote_id: quoteId });
    return quote;
  }

  async submitAssistantGenerationQuote(sessionId: string, quoteId: string): Promise<GenerationTask> {
    const task = await this.request<GenerationTask>(`/agent/sessions/${encodeURIComponent(sessionId)}/generation-quotes/${encodeURIComponent(quoteId)}/submit`, {
      method: "POST",
    });
    track("generation_submit", { source: "assistant", request_id: task.generation_request_id });
    return task;
  }

  async createGeneration(input: TieredGenerationSubmissionInput, quoteId: string, autoConfirm?: boolean): Promise<GenerationTask> {
    const task = await this.request<GenerationTask>("/generations", {
      method: "POST",
      body: JSON.stringify({ ...input, generation_quote_id: quoteId, ...(autoConfirm ? { auto_confirm: true } : {}) }),
    });
    track("generation_submit", { media_kind: input.media_kind, project_id: input.project_id, request_id: task.generation_request_id });
    return task;
  }

  /** 项目生成任务列表(批次二 P-04 段落版本条数据源;GET /projects/:id/generations,仓根 routes.ts:487)。 */
  async projectGenerations(projectId: string): Promise<ListData<GenerationTask>> {
    return normaliseList<GenerationTask>(await this.request(`/projects/${encodeURIComponent(projectId)}/generations`));
  }

  async generation(requestId: string): Promise<GenerationTask> {
    const task = await this.request<GenerationTask>(`/generations/${encodeURIComponent(requestId)}`);
    // 终态去重上报（轮询会多次命中 succeeded/failed，telemetry 内按 request_id 只报一次）
    trackGenerationResult(requestId, task.status);
    return task;
  }

  async generationAttemptNotifications(limit = 20): Promise<GenerationAttemptNotificationList> {
    return this.request(`/generation-attempt-notifications${queryString({ limit })}`);
  }

  async acknowledgeGenerationAttemptNotification(notificationId: string): Promise<void> {
    await this.request(`/generation-attempt-notifications/${encodeURIComponent(notificationId)}/acknowledge`, {
      method: "POST",
    });
  }

  async retryGeneration(requestId: string, quoteId: string, clientIdempotencyKey: string, autoConfirm?: boolean): Promise<GenerationTask> {
    const task = await this.request<GenerationTask>(`/generations/${encodeURIComponent(requestId)}/retry`, {
      method: "POST",
      body: JSON.stringify({
        generation_quote_id: quoteId,
        client_idempotency_key: clientIdempotencyKey,
        ...(autoConfirm ? { auto_confirm: true } : {}),
      }),
    });
    track("generation_submit", { retry_of: requestId, request_id: task.generation_request_id });
    return task;
  }

  async batchEstimate(items: TieredBatchEstimateItemInput[]): Promise<BatchEstimateResult> {
    const raw = await this.request("/generations/batch-estimate", {
      method: "POST",
      body: JSON.stringify({ items }),
    }) as Omit<BatchEstimateResult, "items"> & { items: Array<Record<string, unknown>> };
    /* #164:wire 的逐项句柄是 snake_case item_id(服务端统一序列化),前端类型是 itemId;
       在此一次性归一——不归一时清单行查不到报价(红「不可行」假象),确认请求 item_id 也会丢。 */
    return {
      ...raw,
      items: (raw.items ?? []).map((item) => ({
        ...(item as unknown as BatchEstimateItem),
        itemId: (typeof item.itemId === "string" ? item.itemId : item.item_id) as string,
      })),
    };
  }

  /** 一次人工确认：由服务端冻结并校验本次报价清单。 */
  async batchConfirm(input: BatchSubmitInput): Promise<BatchConfirmResult> {
    return this.request("/generations/batch-confirm", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** 仅提交已确认的授权；报价清单不会在这一步由浏览器重传。 */
  async submitGenerationBatch(authorizationId: string): Promise<BatchSubmitResult> {
    return this.request(`/generation-batches/${encodeURIComponent(authorizationId)}/submit`, {
      method: "POST",
    });
  }

  async generationDefaults(projectId: string): Promise<ListData<GenerationDefaultStrategy>> {
    return normaliseList<GenerationDefaultStrategy>(
      await this.request(`/projects/${encodeURIComponent(projectId)}/generation-defaults`),
    );
  }

  async generationDefault(projectId: string, mediaKind: GenerationMediaKind): Promise<GenerationDefaultStrategy> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/generation-defaults/${encodeURIComponent(mediaKind)}`);
  }

  async putGenerationDefault(projectId: string, mediaKind: GenerationMediaKind, input: PutGenerationDefaultInput): Promise<GenerationDefaultStrategy> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/generation-defaults/${encodeURIComponent(mediaKind)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  /* ---------- Lite 提示词模板库（docs/design/prd-v2/lite-model-defaults.md §4.3） ---------- */

  async promptTemplates(projectId: string, mediaKind?: GenerationMediaKind): Promise<ListData<PromptTemplate>> {
    const query = mediaKind ? `?media_kind=${encodeURIComponent(mediaKind)}` : "";
    return normaliseList<PromptTemplate>(
      await this.request(`/projects/${encodeURIComponent(projectId)}/prompt-templates${query}`),
    );
  }

  async createPromptTemplate(projectId: string, input: PromptTemplateInput): Promise<PromptTemplate> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/prompt-templates`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updatePromptTemplate(projectId: string, templateId: string, input: PromptTemplateInput): Promise<PromptTemplate> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/prompt-templates/${encodeURIComponent(templateId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async deletePromptTemplate(projectId: string, templateId: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}/prompt-templates/${encodeURIComponent(templateId)}`, {
      method: "DELETE",
    });
  }

  /* ---------- Lite 项目风格库（docs/design/prd-v2/lite-config-tabs-and-style.md §4.4） ---------- */

  async projectStyles(projectId: string, mediaKind?: GenerationMediaKind): Promise<ListData<ProjectStyle>> {
    const query = mediaKind ? `?media_kind=${encodeURIComponent(mediaKind)}` : "";
    return normaliseList<ProjectStyle>(
      await this.request(`/projects/${encodeURIComponent(projectId)}/project-styles${query}`),
    );
  }

  async createProjectStyle(projectId: string, input: ProjectStyleInput): Promise<ProjectStyle> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/project-styles`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateProjectStyle(projectId: string, styleId: string, input: ProjectStyleInput): Promise<ProjectStyle> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/project-styles/${encodeURIComponent(styleId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async deleteProjectStyle(projectId: string, styleId: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}/project-styles/${encodeURIComponent(styleId)}`, {
      method: "DELETE",
    });
  }

  /** 设/换默认（D1 2026-08-17 修订：可逆）——旧默认同事务让位；并发冲突 409 可重试。 */
  async setDefaultProjectStyle(projectId: string, styleId: string): Promise<ProjectStyle> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/project-styles/${encodeURIComponent(styleId)}/default`, {
      method: "PUT",
    });
  }

  /** 取消默认（D1：默认可为空）：镜像清空，回「无默认」空态（幂等）。 */
  async clearDefaultProjectStyle(projectId: string, styleId: string): Promise<ProjectStyle> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/project-styles/${encodeURIComponent(styleId)}/default`, {
      method: "DELETE",
    });
  }

  /* ---------- 资产审核域（reviews） ----------
   * wire 全 snake_case（后端 success() 递归 toSnakeCaseJson），统一经 mapper 归一为前端 camel 类型；
   * 请求体按后端 zod 合同用 snake_case。
   * 409（版本冲突/终态冲突）由 ApiClientError.code 透出，页面走板14 冲突态。 */

  async reviewPolicies(projectId: string): Promise<ListData<ProjectReviewPolicy>> {
    return normaliseMappedList(
      await this.request(`/projects/${encodeURIComponent(projectId)}/review-policies`),
      reviewPolicyFromUnknown,
    );
  }

  async putReviewPolicy(projectId: string, mediaKind: ReviewMediaKind, input: { default_strategy: "automatic" | "pending_review"; expected_version: number }): Promise<ProjectReviewPolicy> {
    return reviewPolicyFromUnknown(await this.request(`/projects/${encodeURIComponent(projectId)}/review-policies/${encodeURIComponent(mediaKind)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }));
  }

  /** 批量提审：最多 50 件，逐项返回 changed/reason（已是终态的资产不会重复流转）。 */
  async submitAssetReviews(projectId: string, assetIds: string[]): Promise<ListData<AssetReviewItem>> {
    return normaliseMappedList(await this.request(`/projects/${encodeURIComponent(projectId)}/reviews/submit`, {
      method: "POST",
      body: JSON.stringify({ asset_ids: assetIds }),
    }), reviewItemFromUnknown);
  }

  /** 审核人裁决：通过或拒绝（拒绝必须带理由）。 */
  async decideAssetReview(projectId: string, assetId: string, input: ReviewDecision): Promise<AssetReviewItem> {
    return reviewItemFromUnknown(await this.request(`/projects/${encodeURIComponent(projectId)}/reviews/assets/${encodeURIComponent(assetId)}/decision`, {
      method: "POST",
      body: JSON.stringify(input),
    }));
  }

  /** 审核轨迹：谁、何时、从哪态到哪态、理由。 */
  async assetReviewActions(projectId: string, assetId: string): Promise<ListData<AssetReviewActionRecord>> {
    return normaliseMappedList(
      await this.request(`/projects/${encodeURIComponent(projectId)}/reviews/assets/${encodeURIComponent(assetId)}/actions`),
      reviewActionFromUnknown,
    );
  }

  /* ---------- 产物审核域（media-reviews，K2-A 幕四步 15） ----------
   * 审的是生成产物（图片/视频），与上面的资产审核（角色/场景资产）是两个对象。
   * wire snake_case，经 review-delivery.ts 的 mapper 归一为 camel；
   * 拒绝无理由后端 422（mediaService），客户端先用 rejectionReasonError 拦；
   * 403=不是该项目审核人，404=项目不存在或非成员。 */

  /** 待审队列：按集过滤 + 服务端分页（status 缺省 needs_review）。 */
  async mediaReviewQueue(projectId: string, input: { status?: MediaReviewStatus; episodeId?: string; page?: number; pageSize?: number } = {}): Promise<MediaReviewQueuePage> {
    return mediaReviewQueuePageFromUnknown(await this.request(`/projects/${encodeURIComponent(projectId)}/media-reviews${queryString({
      status: input.status ?? "needs_review",
      episode_id: input.episodeId,
      page: input.page ?? 1,
      page_size: input.pageSize ?? 20,
    })}`));
  }

  /** 批量裁决：1..200 条、id 不可重复；逐项返回 changed/reason（已是终态不重复流转）。 */
  async decideMediaReviews(projectId: string, decisions: MediaReviewDecisionBody[]): Promise<ListData<MediaReviewDecisionOutcome>> {
    return normaliseMappedList(await this.request(`/projects/${encodeURIComponent(projectId)}/media-reviews/decisions`, {
      method: "POST",
      body: JSON.stringify({ decisions }),
    }), mediaReviewDecisionOutcomeFromUnknown);
  }

  /** 单条产物的审核轨迹（拒绝理由、打回人、时间都在这里）。 */
  async mediaReviewActions(projectId: string, mediaResultId: string): Promise<ListData<MediaReviewActionRecord>> {
    return normaliseMappedList(
      await this.request(`/projects/${encodeURIComponent(projectId)}/media-reviews/${encodeURIComponent(mediaResultId)}/actions`),
      mediaReviewActionFromUnknown,
    );
  }

  /* ---------- 交付域（deliveries，K2-A 幕四步 16/17） ----------
   * partial=true 时 deliverables 带 gaps（未交齐镜头）而不是整体 409；
   * POST 落账由服务端重算清单快照，前端不传任何媒体 id；
   * 409 deliverable_not_ready=有镜头未交齐（非 partial）或没有可交付主版本。 */

  /** 交付落账：返回内容指纹/范围/未交齐镜号快照。 */
  async createEpisodeDelivery(episodeId: string, input: { purpose?: string | null; partial?: boolean } = {}): Promise<DeliveryRecord> {
    return deliveryRecordFromUnknown(await this.request(`/episodes/${encodeURIComponent(episodeId)}/deliveries`, {
      method: "POST",
      body: JSON.stringify({ purpose: input.purpose ?? null, partial: input.partial === true }),
    }));
  }

  /** 按集交付历史（服务端分页）。 */
  async episodeDeliveries(episodeId: string, page = 1, pageSize = 20): Promise<DeliveryRecordPage> {
    return deliveryRecordPageFromUnknown(await this.request(`/episodes/${encodeURIComponent(episodeId)}/deliveries${queryString({ page, page_size: pageSize })}`));
  }

  /* ---------- 参考测试域（reference-tests，板07） ----------
   * wire 全 snake_case，经 mapper 归一为前端 camel 类型（同 reviews 域口径）；
   * 测试记录只保存配置；结果挂在正常生成链已持久化的产物上，本域不创建付费任务。 */

  async createReferenceTest(projectId: string, input: ReferenceTestInput): Promise<ReferenceTest> {
    return referenceTestFromUnknown(await this.request(`/projects/${encodeURIComponent(projectId)}/reference-tests`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        media_kind: input.mediaKind,
        mode: input.mode,
        model_key: input.modelKey,
        prompt: input.prompt,
        parameters: input.parameters,
        reference_media_ids: input.referenceMediaIds,
      }),
    }));
  }

  async referenceTests(projectId: string, page = 1, pageSize = 20, mediaKind?: ReferenceTestMediaKind): Promise<Page<ReferenceTest>> {
    return pageFromUnknown(
      await this.request(`/projects/${encodeURIComponent(projectId)}/reference-tests${queryString({ page, page_size: pageSize, media_kind: mediaKind })}`),
      referenceTestFromUnknown,
    );
  }

  /** 项目级结果流（板07「全部测试批次」）。 */
  async projectReferenceTestResults(projectId: string, page = 1, pageSize = 20, mediaKind?: ReferenceTestMediaKind): Promise<Page<ProjectReferenceTestResult>> {
    return pageFromUnknown(
      await this.request(`/projects/${encodeURIComponent(projectId)}/reference-test-results${queryString({ page, page_size: pageSize, media_kind: mediaKind })}`),
      projectReferenceTestResultFromUnknown,
    );
  }

  async updateReferenceTest(projectId: string, testId: string, input: ReferenceTestInput, expectedVersion: number): Promise<ReferenceTest> {
    return referenceTestFromUnknown(await this.request(`/projects/${encodeURIComponent(projectId)}/reference-tests/${encodeURIComponent(testId)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: input.name,
        media_kind: input.mediaKind,
        mode: input.mode,
        model_key: input.modelKey,
        prompt: input.prompt,
        parameters: input.parameters,
        reference_media_ids: input.referenceMediaIds,
        expected_version: expectedVersion,
      }),
    }));
  }

  async deleteReferenceTest(projectId: string, testId: string, expectedVersion: number): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}/reference-tests/${encodeURIComponent(testId)}`, {
      method: "DELETE",
      body: JSON.stringify({ expected_version: expectedVersion }),
    });
  }

  /** 把已持久化的生成产物挂为测试结果（产物必须来自正常生成链）。 */
  async attachReferenceTestResult(projectId: string, testId: string, input: { generation_request_id: string; media_result_id: string }): Promise<ProjectReferenceTestResult> {
    return projectReferenceTestResultFromUnknown(await this.request(`/projects/${encodeURIComponent(projectId)}/reference-tests/${encodeURIComponent(testId)}/results`, {
      method: "POST",
      body: JSON.stringify(input),
    }));
  }

  async referenceTestResults(projectId: string, testId: string, page = 1, pageSize = 20): Promise<Page<ProjectReferenceTestResult>> {
    return pageFromUnknown(
      await this.request(`/projects/${encodeURIComponent(projectId)}/reference-tests/${encodeURIComponent(testId)}/results${queryString({ page, page_size: pageSize })}`),
      projectReferenceTestResultFromUnknown,
    );
  }

  /** 人工把某条测试结果设为后续生产默认策略（乐观锁；返回新的默认策略）。 */
  async setReferenceTestResultDefault(projectId: string, testId: string, resultId: string, expectedVersion: number): Promise<GenerationDefaultStrategy> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/reference-tests/${encodeURIComponent(testId)}/results/${encodeURIComponent(resultId)}/set-default`, {
      method: "POST",
      body: JSON.stringify({ expected_version: expectedVersion }),
    });
  }

  /* ---------- JSON 资产入库（生成产物一键入资产库，W5-1） ---------- */

  /**
   * 登记资产实体；媒体文件另走 uploadAssetMedia 挂图。
   * 裁决 12：后端 success() 对响应递归 toSnakeCaseJson——serializeEntity 的
   * assetKind/displayName/sourceFileUrl 在 wire 上是 asset_kind/display_name/source_file_url,
   * 与其他域同法经 ingestedAssetFromUnknown 归一为前端 camel 类型（旧注释「响应 camelCase」是错的）。
   */
  async ingestJsonAssets(assets: JsonAssetIngestItem[], source: { source_project_id?: string; source_project_name?: string } = {}): Promise<ListData<IngestedAsset>> {
    const list = normaliseMappedList(await this.request("/asset-ingest/json/assets", {
      method: "POST",
      body: JSON.stringify({ ...source, assets }),
    }), ingestedAssetFromUnknown);
    track("asset_import", { channel: "json_ingest", count: list.count });
    return list;
  }

  /**
   * 导入通用资产为个人资产（W5.5-4）。
   * S11-1：路径对齐后端真合同 POST /assets/import-personal（body 带 asset_id，
   * 仓根 src/modules/assets/routes.ts:170-184；旧 /assets/:id/import-personal 是
   * 前端按 REST 惯例的暂定路径，后端从未注册，点了必 404——「说了但做不到」修复）。
   * 404/501 时页面仍降级为人话提示，不假装成功。
   */
  async importAssetToPersonal(assetId: string): Promise<Asset> {
    const asset = assetFromUnknown(await this.request("/assets/import-personal", {
      method: "POST",
      body: JSON.stringify({ asset_id: assetId }),
    }));
    track("asset_import", { channel: "import_personal" });
    return asset;
  }

  async createAgentSession(context: { project_id?: string; episode_id?: string; shot_id?: string }): Promise<{ session_id: string }> {
    return this.request("/agent/sessions", { method: "POST", body: JSON.stringify(context) });
  }

  async agentMessages(sessionId: string): Promise<ListData<AgentMessage>> {
    return normaliseList<AgentMessage>(await this.request(`/agent/sessions/${encodeURIComponent(sessionId)}/messages`));
  }

  /** Grill Engine 信息充分性预检（registration profile 引导收集偏好字段）。 */
  async grillCheck(sessionId: string, input: { taskType: "registration"; intent: string; projectId?: string }): Promise<GrillCheckResult> {
    const raw = await this.request<Record<string, unknown>>(`/agent/sessions/${encodeURIComponent(sessionId)}/grill-check`, {
      method: "POST",
      body: JSON.stringify({ taskType: input.taskType, intent: input.intent, projectId: input.projectId }),
    });
    return normaliseGrillResult(raw);
  }

  /** Grill Engine 吸收用户对反问的回答，返回提取结果与下一步动作。 */
  async grillAbsorb(sessionId: string, input: { taskType: "registration"; answer: string; targetField: string; projectId?: string }): Promise<{ extracted: string | null; nextAction: GrillCheckResult }> {
    const raw = await this.request<Record<string, unknown>>(`/agent/sessions/${encodeURIComponent(sessionId)}/grill-absorb`, {
      method: "POST",
      body: JSON.stringify({ taskType: input.taskType, answer: input.answer, targetField: input.targetField, projectId: input.projectId }),
    });
    const record = isRecord(raw) ? raw : {};
    const extracted = typeof record.extracted === "string" ? record.extracted : null;
    const nextAction = normaliseGrillResult(record.next_action ?? record.nextAction);
    return { extracted, nextAction };
  }

  /** 项目 AI 审计日志（assistant/routes.ts；分页 {items,page,page_size,total,has_more},snake wire 归一 camel）。 */
  async aiAuditLogs(projectId: string, params: { page?: number; page_size?: number } = {}): Promise<AiAuditLogPage> {
    const raw = await this.request(`/projects/${encodeURIComponent(projectId)}/ai-audit-logs${queryString({ page: params.page, page_size: params.page_size })}`);
    const record = isRecord(raw) ? raw : {};
    const items = Array.isArray(record.items) ? record.items.map(aiAuditLogFromUnknown) : [];
    const total = optionalNumber(record.total) ?? items.length;
    const page = optionalNumber(record.page) ?? params.page ?? 1;
    const pageSize = optionalNumber(firstValue(record, "page_size", "pageSize")) ?? params.page_size ?? 50;
    return {
      items,
      page,
      pageSize,
      total,
      /* has_more 缺失时按 total 推导；推不出则 false——不虚构「还有更多」。 */
      hasMore: optionalBoolean(firstValue(record, "has_more", "hasMore")) ?? page * pageSize < total,
    };
  }

  async streamAgentMessage(sessionId: string, content: string, onEvent: (event: AgentStreamEvent) => void): Promise<void> {
    const headers = new Headers({ "Content-Type": "application/json", Accept: "text/event-stream" });
    const token = this.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(`${API_PREFIX}/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content }),
      });
    } catch {
      throw new ApiClientError("无法连接助手，请确认后端已启动", { code: "network_error", retryable: true });
    }
    if (!response.ok) {
      const failure = await parseFailure(response);
      this.handleUnauthorized(response.status, "/agent");
      throw failure;
    }
    if (!response.body) throw new ApiClientError("助手没有返回消息流", { code: "empty_stream", retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") {
          completed = true;
          continue;
        }
        let value: unknown;
        try {
          value = JSON.parse(data) as unknown;
        } catch {
          throw new ApiClientError("助手返回了无法识别的消息", { code: "assistant_stream_invalid", retryable: true });
        }
        if (!isRecord(value)) continue;
        if (value.type === "error") {
          throw new ApiClientError(typeof value.message === "string" ? value.message : "助手回复失败", { code: "assistant_error", retryable: true });
        }
        if (value.type === "generation_quote") {
          const quote = generationQuoteFromUnknown(value, { source: "assistant", action: "submit" });
          if (quote) onEvent({ type: "generation_quote", quote });
          continue;
        }
        // W6-D：旧流与新 runtime（thinking 段 / tool_call_* / toolCalls 数组）统一归一
        for (const event of mapAgentStreamFrame(value)) {
          onEvent(event);
        }
      }
    }
    if (!completed) {
      throw new ApiClientError("助手连接提前中断，请重试", { code: "assistant_stream_interrupted", retryable: true });
    }
  }

  /** 带登录态的 GET 取流式响应（下载与 Lite 图片渲染共用；只认 Authorization 头，见 http/authenticate.ts）。 */
  private async fetchAuthorized(path: string): Promise<Response> {
    const headers = new Headers();
    const token = this.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(`${API_PREFIX}${path}`, { headers });
    } catch {
      throw new ApiClientError("无法连接下载服务，请确认后端已启动", { code: "network_error", retryable: true });
    }
    if (!response.ok) {
      const failure = await parseFailure(response);
      this.handleUnauthorized(response.status, path);
      throw failure;
    }
    return response;
  }

  /** 站内媒体字节（#184：Lite 图片组件经它渲染 /api/v1/media/:id/download——
      <img> 裸引用带不上登录态，组件拿到 Blob 后转 objectURL；只认 media_results 行 id）。 */
  async fetchMediaBlob(mediaId: string): Promise<Blob> {
    const response = await this.fetchAuthorized(`/media/${encodeURIComponent(mediaId)}/download`);
    return response.blob();
  }

  async assetMediaPreviewUrl(assetId: string, mediaId: string): Promise<string> {
    const result = await this.request<unknown>(
      `/assets/${encodeURIComponent(assetId)}/media/${encodeURIComponent(mediaId)}/preview-url`,
      { method: "POST" },
    );
    if (!isRecord(result)) throw new ApiClientError("视频预览地址响应格式不正确", { code: "invalid_response" });
    const url = optionalString(result.url);
    if (!url) throw new ApiClientError("视频预览地址为空，请稍后重试", { code: "invalid_response", retryable: true });
    return url;
  }

  private async download(path: string, fallbackName: string): Promise<void> {
    const response = await this.fetchAuthorized(path);
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
    const fileName = encodedName ? decodeURIComponent(encodedName) : quotedName || fallbackName;
    this.saveBlob(blob, fileName);
  }

  private saveBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  /* ---------- S20 剧本拆解：版本管理 + 运行生命周期（确认采用前不落正式分镜） ---------- */

  async createScriptVersion(episodeId: string, input: { title?: string; scriptText: string }): Promise<ScriptVersion> {
    const raw = await this.request<unknown>(`/episodes/${encodeURIComponent(episodeId)}/script-versions`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title?.trim() ? input.title.trim() : null,
        script_text: input.scriptText,
        client_idempotency_key: newId(),
      }),
    });
    const record = isRecord(raw) && isRecord(raw.version) ? raw.version : raw;
    return scriptVersionFromUnknown(record);
  }

  async scriptVersions(episodeId: string): Promise<ListData<ScriptVersion>> {
    return normaliseMappedList(await this.request(`/episodes/${encodeURIComponent(episodeId)}/script-versions`), scriptVersionFromUnknown);
  }

  async createScriptBreakdown(episodeId: string, input: { scriptVersionId: string; targetDurationSec?: number | null }): Promise<ScriptBreakdownRunDetail> {
    const raw = await this.request<unknown>(`/episodes/${encodeURIComponent(episodeId)}/script-breakdowns`, {
      method: "POST",
      body: JSON.stringify({
        script_version_id: input.scriptVersionId,
        target_duration_sec: input.targetDurationSec ?? null,
        client_idempotency_key: newId(),
      }),
    });
    return scriptBreakdownRunDetailFromUnknown(raw);
  }

  async scriptBreakdowns(episodeId: string): Promise<ListData<ScriptBreakdownRun>> {
    return normaliseMappedList(await this.request(`/episodes/${encodeURIComponent(episodeId)}/script-breakdowns`), scriptBreakdownRunFromUnknown);
  }

  async scriptBreakdown(runId: string): Promise<ScriptBreakdownRunDetail> {
    return scriptBreakdownRunDetailFromUnknown(await this.request(`/script-breakdowns/${encodeURIComponent(runId)}`));
  }

  async resumeScriptBreakdown(runId: string): Promise<ScriptBreakdownRunDetail> {
    return scriptBreakdownRunDetailFromUnknown(await this.request(`/script-breakdowns/${encodeURIComponent(runId)}/resume`, { method: "POST" }));
  }

  async confirmScriptBreakdown(runId: string): Promise<ScriptBreakdownConfirmResult> {
    return scriptBreakdownConfirmFromUnknown(await this.request(`/script-breakdowns/${encodeURIComponent(runId)}/confirm`, { method: "POST" }));
  }

  async discardScriptBreakdown(runId: string): Promise<ScriptBreakdownRun> {
    const raw = await this.request<unknown>(`/script-breakdowns/${encodeURIComponent(runId)}/discard`, { method: "POST" });
    const record = isRecord(raw) && isRecord(raw.run) ? raw.run : raw;
    return scriptBreakdownRunFromUnknown(record);
  }

  /* ---------- Lite 界面模式窄口（与完整版同库同事实源，编排在后端 lite 模块） ---------- */

  /** Lite 剧本提交一站完成：找或建容器集（episode_no=1）→ 建剧本版本 → 建解析 run。
      幂等键由调用方生成、提交前落 sessionStorage（计划 §5.2③：超时先按键查状态再决定重发）；
      两段式确认不省——run 草稿须人工 confirm/discard（scriptBreakdown/confirmScriptBreakdown/discardScriptBreakdown）。 */
  async liteSubmitScript(projectId: string, input: { episode_id: string; raw_text: string; client_idempotency_key: string; auto_confirm?: boolean }): Promise<LiteSubmitScriptResult> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/lite/script`, { method: "POST", body: JSON.stringify(input) });
  }

  /** Lite 剧本文本提取：上传 .txt/.md/.docx，后端提取纯文本（不落库、不解析），前端填进粘贴框。
      60000 字上限在 service 层强制；文件大小 5MB 在 route 层强制。 */
  async liteExtractScriptText(projectId: string, file: File): Promise<{ text: string; char_count: number; source_format: string }> {
    const form = new FormData();
    form.append("file", file);
    return this.request(`/projects/${encodeURIComponent(projectId)}/lite/script/extract-text`, { method: "POST", body: form });
  }

  /** Lite 整部剧本导入：上传一个大文件（.txt/.md/.docx/.pdf），后端按「第N集」标题自动拆分。
      覆盖语义：导入会替换项目现有的全部集（旧集软删、新集按文件内容重建），replaced 为被覆盖的集数。
      逐集建 episode + 剧本版本；是否解析由用户在具体集里显式触发。600000 字上限在 service 层强制。 */
  async liteImportBulkScript(projectId: string, file: File): Promise<{ episodes: Array<{ episode_id: string; episode_no: number; script_version_id: string }>; replaced: number }> {
    const form = new FormData();
    form.append("file", file);
    return this.request(`/projects/${encodeURIComponent(projectId)}/lite/script/import-bulk`, { method: "POST", body: form });
  }

  /** Lite 资产实体化：把当前集最新 confirmed 拆解 run 的资产候选幂等落成项目资产（无请求体；
      重复调用不重复建行，故回 200 而非 201）。项目还没确认过解析 → 409
      lite_breakdown_not_confirmed（lite/service.ts），调用方引导去剧本页。 */
  async liteMaterializeAssets(projectId: string, episodeId: string): Promise<LiteMaterializeAssetsResult> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/lite/assets/materialize?episode_id=${encodeURIComponent(episodeId)}`, { method: "POST" });
  }

  /** Lite 资产候选产物列表：目标资产在本项目内的生成产物（media_results 内连
      generation_requests.target_asset_entity_id，倒序）。 */
  async liteAssetMedia(projectId: string, assetEntityId: string): Promise<{ items: LiteAssetMediaItem[] }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/media`);
  }

  /** Lite 参考资产清单：本项目内 seedance 登记 active 的资产（每资产取最新一条登记），
      供生视频 references（usage_mode=reference）勾选；清单为空/读取失败时页面退后不显示勾选区。 */
  async liteReferenceAssets(projectId: string): Promise<{ items: LiteReferenceAssetItem[] }> {
    const data = await this.request<{ items?: unknown }>(`/projects/${encodeURIComponent(projectId)}/lite/reference-assets`);
    const rawItems = isRecord(data) && Array.isArray(data.items) ? data.items : [];
    return { items: rawItems.map(liteReferenceAssetItemFromUnknown).filter((item): item is LiteReferenceAssetItem => item !== null) };
  }

  /** Lite 素材列表：按项目（+可选 kind）列资产，附 tab 聚合计数。 */
  async liteListAssets(projectId: string, kind?: string): Promise<LiteAssetListResult> {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    const data = await this.request<{ items?: unknown; tab_counts?: unknown }>(
      `/projects/${encodeURIComponent(projectId)}/lite/assets${query}`,
    );
    const rawItems = isRecord(data) && Array.isArray(data.items) ? data.items : [];
    const rawTabs = isRecord(data) && Array.isArray(data.tab_counts) ? data.tab_counts : [];
    return {
      items: rawItems.map(liteAssetListItemFromUnknown).filter((item): item is LiteAssetListItem => item !== null),
      tab_counts: rawTabs.filter(isRecord).map((tab) => ({
        kind: optionalString(tab.kind) ?? "",
        count: typeof tab.count === "number" ? tab.count : 0,
      })),
    };
  }

  /** Lite 资产详情：正式列 + metadata.lite 投影。 */
  async liteGetAsset(projectId: string, assetEntityId: string): Promise<LiteAssetDetail> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}`);
  }

  /** Lite 手动新建资产：不关联 script_breakdown_runs，metadata.lite.usages 初始空。
      响应含服务端自动建的第一个变体 id(恒存在,无需为空兜底)。 */
  async liteCreateAsset(
    projectId: string,
    input: { name: string; asset_kind: string; intro?: string; note?: string },
  ): Promise<{ asset_entity_id: string; first_variant_id: string }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/lite/assets`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Lite 更新资产：只改 name/intro/metadata.lite.note，保留 metadata 其他命名空间。 */
  async liteUpdateAsset(
    projectId: string,
    assetEntityId: string,
    patch: { name?: string; intro?: string | null; note?: string | null },
  ): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** 资产变体列表。 */
  async liteListAssetVariants(projectId: string, assetEntityId: string): Promise<LiteAssetVariant[]> {
    const data = (await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/variants`,
    )) as { items?: unknown };
    if (!isRecord(data) || !Array.isArray(data.items)) return [];
    return data.items.filter(isRecord).map((v) => ({
      variant_id: optionalString(v.variant_id) ?? "",
      variant_kind: optionalString(v.variant_kind) ?? "",
      display_name: optionalString(v.display_name) ?? "",
      is_primary: v.is_primary === true,
      image_url: optionalString(v.image_url),
    }));
  }

  /** 版本图素材轨。 */
  async liteListVersionTrack(projectId: string, assetEntityId: string): Promise<LiteAssetVersionTrackItem[]> {
    const data = (await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/version-track`,
    )) as { items?: unknown };
    if (!isRecord(data) || !Array.isArray(data.items)) return [];
    return data.items.filter(isRecord).map((v) => ({
      asset_media_id: optionalString(v.asset_media_id) ?? null,
      media_result_id: optionalString(v.media_result_id) ?? null,
      storage_url: optionalString(v.storage_url) ?? null,
      is_primary: v.is_primary === true,
      source: v.source === "upload" ? "upload" : "ai",
      width_px: typeof v.width_px === "number" ? v.width_px : null,
      height_px: typeof v.height_px === "number" ? v.height_px : null,
      media_kind: optionalString(v.media_kind) ?? null,
      format: optionalString(v.format) ?? null,
      created_at: optionalString(v.created_at) ?? new Date(0).toISOString(),
      variant_id: optionalString(v.variant_id) ?? null,
    }));
  }

  /* ---------- 创作广场（项目维度独立台账，后端 migrations/073 plaza_records） ---------- */

  /** 广场生成记录（只含广场自己发起的生成；右栏列表/回显唯一真源）。 */
  async plazaRecords(projectId: string): Promise<PlazaRecord[]> {
    const data = (await this.request(`/projects/${encodeURIComponent(projectId)}/plaza/records`)) as { items?: unknown };
    if (!isRecord(data) || !Array.isArray(data.items)) return [];
    return data.items.filter(isRecord).map((item) => ({
      id: optionalString(item.id) ?? "",
      generation_request_id: optionalString(item.generation_request_id) ?? "",
      media_kind: optionalString(item.media_kind) ?? "image",
      prompt: optionalString(item.prompt) ?? "",
      tier_id: optionalString(item.tier_id),
      parameters: isRecord(item.parameters) ? item.parameters as Record<string, unknown> : {},
      reference_manifest: Array.isArray(item.reference_manifest)
        ? (item.reference_manifest as Array<Record<string, unknown>>).map((ref) => ({
            media_id: optionalString(ref.media_id) ?? null,
            kind: optionalString(ref.kind),
            role: optionalString(ref.role),
          }))
        : [],
      status: optionalString(item.status) ?? "pending",
      display_reason: optionalString(item.display_reason),
      estimated_cost_fen: typeof item.estimated_cost_fen === "number" ? item.estimated_cost_fen : null,
      media_results: Array.isArray(item.media_results)
        ? (item.media_results as Array<Record<string, unknown>>).map((media) => ({
            id: optionalString(media.id) ?? "",
            media_kind: optionalString(media.media_kind) ?? "image",
            storage_url: optionalString(media.storage_url),
          }))
        : [],
      created_at: optionalString(item.created_at),
      updated_at: optionalString(item.updated_at),
    }));
  }

  /** 广场生成：后端走主链 quote→auto-confirm→create 并落 plaza_records。 */
  async plazaGenerate(projectId: string, input: {
    mediaKind: "image" | "video";
    tierId: string;
    prompt: string;
    referenceMediaIds: string[];
    parameters: Record<string, unknown>;
    quantity: number;
  }): Promise<{ generation_request_id: string; plaza_record_id: string }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/plaza/generate`, {
      method: "POST",
      body: JSON.stringify({
        media_kind: input.mediaKind,
        tier_id: input.tierId,
        prompt: input.prompt,
        ...(input.referenceMediaIds.length
          ? { references: input.referenceMediaIds.map((mediaId) => ({ media_id: mediaId, usage_mode: "reference" })) }
          : {}),
        parameters: input.parameters,
        quantity: input.quantity,
        client_idempotency_key: `plaza-${projectId}-${input.mediaKind}-${newId()}`,
      }),
    });
  }

  /** 广场上传（图片/音频）：建项目资产+挂主媒体，上传件即可被引用。 */
  async plazaUpload(projectId: string, file: File): Promise<{ asset_entity_id: string; asset_variant_id: string; media_kind: string }> {
    const form = new FormData();
    form.append("file", file);
    return this.request(`/projects/${encodeURIComponent(projectId)}/plaza/uploads`, { method: "POST", body: form });
  }

  /** 设主图（原子翻转，409 时后端返回人话「主图已被他人更改」）。
      上传图传 asset_media_id；生成图传 media_result_id（后端物化后翻转），严格二选一。
      2026-08-19 触发模型：翻转成功即「成为主变体」，后端后台自动登记火山素材（fire-and-forget），
      登记状态由 asset-media 探针轮询展示，失败可点重试。 */
  async liteSetPrimaryMedia(projectId: string, assetEntityId: string, assetMediaId?: string, mediaResultId?: string): Promise<void> {
    const body = mediaResultId ? { media_result_id: mediaResultId } : { asset_media_id: assetMediaId };
    await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/primary-media`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
  }

  /** 关联分镜列表；variantId 可选过滤(bound+pending 都按变体过滤,省略=全部)。 */
  async liteListAssetUsages(projectId: string, assetEntityId: string, variantId?: string): Promise<LiteAssetUsageEntry[]> {
    const query = variantId ? `?variant_id=${encodeURIComponent(variantId)}` : "";
    const data = (await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/usages${query}`,
    )) as { items?: unknown };
    if (!isRecord(data) || !Array.isArray(data.items)) return [];
    return data.items
      .filter(isRecord)
      .map((v): LiteAssetUsageEntry | null => {
        // 缺 usage_id 的坏行整行丢弃(删除/稳定 ID 都依赖它)
        const usageId = optionalString(v.usage_id);
        if (!usageId) return null;
        return {
          usage_id: usageId,
          variant_id: optionalString(v.variant_id) ?? null,
          shot_id: optionalString(v.shot_id) ?? null,
          episode_id: optionalString(v.episode_id) ?? null,
          episode_no: typeof v.episode_no === "number" ? v.episode_no : null,
          shot_no: typeof v.shot_no === "number" ? v.shot_no : null,
          scene_name: optionalString(v.scene_name) ?? null,
          shot_label: optionalString(v.shot_label) ?? "",
          status: v.status === "pending" ? "pending" : "bound",
          matched_by: v.matched_by === "exact_name" ? "exact_name" : v.matched_by === "ai_auto" ? "ai_auto" : "manual",
          evidence: liteUsageEvidenceFromUnknown(v.evidence),
        };
      })
      .filter((item): item is LiteAssetUsageEntry => item !== null);
  }

  /** 批量添加关联分镜(兼容传单条目数组)；返回 { added, pending }。 */
  async liteAddShotUsages(projectId: string, assetEntityId: string, items: LiteAddUsageItem[]): Promise<LiteAddUsagesResult> {
    const data = (await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/usages`,
      { method: "POST", body: JSON.stringify({ items }) },
    )) as { added?: unknown; pending?: unknown };
    return {
      added: isRecord(data) && typeof data.added === "number" ? data.added : 0,
      pending: isRecord(data) && typeof data.pending === "number" ? data.pending : 0,
    };
  }

  /** 移除关联分镜：DELETE /usages/:usage_id(旧 shot_id 路径废弃,前端用列表返回的 usage_id 调)。 */
  async liteRemoveShotUsage(projectId: string, assetEntityId: string, usageId: string): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/usages/${encodeURIComponent(usageId)}`,
      { method: "DELETE" },
    );
  }

  /** v1.5.1（八.10.4）分镜侧删除自动引用：移除 (asset_entity_id, variant_id) 的 exact_name 快照
      并落 removedAutoRefs 抑制名单，backfill 重跑不复活。分镜详情「移除」auto 项的唯一出口。 */
  async liteRemoveShotAutoRef(projectId: string, shotId: string, assetEntityId: string, variantId: string): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/shots/${encodeURIComponent(shotId)}/auto-refs/${encodeURIComponent(assetEntityId)}/${encodeURIComponent(variantId)}`,
      { method: "DELETE" },
    );
  }

  /** v1.6 变体匹配建议（✨ 匹配剧集）：只返回建议，不写任何表（八.2）。 */
  async liteMatchVariantUsages(
    projectId: string,
    assetEntityId: string,
    variantId: string,
  ): Promise<LiteMatchSuggestResult> {
    const data = (await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/variants/${encodeURIComponent(variantId)}/match-suggest`,
      { method: "POST" },
    )) as unknown;
    if (!isRecord(data)) return { items: [], truncated: false };
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const items = rawItems
      .map(liteMatchSuggestItemFromUnknown)
      .filter((item): item is LiteMatchSuggestItem => item !== null);
    return { items, truncated: data.truncated === true };
  }

  /** 删变体(软删)：连带其下 asset_media、清掉引用该变体的 usage 关联,必要时晋升新主变体。 */
  /** v1.9 十.1 删资产(软删,级联变体/媒体/本项目引用/shot 快照)。 */
  async liteDeleteAsset(projectId: string, assetEntityId: string): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}`,
      { method: "DELETE" },
    );
  }

  async liteDeleteAssetVariant(projectId: string, assetEntityId: string, variantId: string): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/variants/${encodeURIComponent(variantId)}`,
      { method: "DELETE" },
    );
  }

  /** 删媒体(软删)：mediaId 可为 asset_media.id(上传图)或 media_results.id(AI 生成图),双 ID 空间。 */
  async liteDeleteAssetMedia(projectId: string, assetEntityId: string, mediaId: string): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(projectId)}/lite/assets/${encodeURIComponent(assetEntityId)}/media/${encodeURIComponent(mediaId)}`,
      { method: "DELETE" },
    );
  }

  /* ---------- seedance 素材登记窄口（后端 seedance-assets 模块；登记是火山控制面调用，
     不是付费生成任务。触发模型（2026-08-19 裁定）：唯一自动触发 = 媒体成为主变体——设主图/主音频
     翻转或 is_primary=true 上传后由后端后台任务 fire-and-forget，本文件不做任何自动登记；
     media-results 三件套是用户明示点击的登记/重试入口，asset-media 三件套供主变体状态轮询与
     失败重试。） ---------- */

  /** 查某生成产物的登记现状；未登记归一为 null——后端此时 404「该生成产物尚未登记为火山可信素材」
      （seedance-assets/repository.ts:209），registration 为 null 的防御分支同口径处理。 */
  async getSeedanceRegistration(mediaResultId: string): Promise<SeedanceRegistration | null> {
    try {
      const data = (await this.request(`/media-results/${encodeURIComponent(mediaResultId)}/seedance-registration`)) as { registration?: SeedanceRegistration | null };
      return data.registration ?? null;
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 404) return null;
      throw reason;
    }
  }

  /** 登记（用户点「登记素材」的唯一入口）：同一事务提升出 asset_entity + asset_media，再向火山
      CreateAsset；重复登记同一产物服务端复用/刷新既有行，不重复建行（service.ts createOrRefresh）。 */
  async registerSeedanceAsset(mediaResultId: string): Promise<SeedanceRegistration> {
    const data = (await this.request(`/media-results/${encodeURIComponent(mediaResultId)}/seedance-registration`, { method: "POST" })) as { registration: SeedanceRegistration };
    return data.registration;
  }

  /** 拉一次远端 GetAsset 刷新状态。仅 processing 有意义：尚无 remote_asset_id 时后端 400
      「素材登记尚未提交到火山」（service.ts:129-131），调用方按状态分路，别对 pending/submitting 调。 */
  async refreshSeedanceRegistration(mediaResultId: string): Promise<SeedanceRegistration> {
    const data = (await this.request(`/media-results/${encodeURIComponent(mediaResultId)}/seedance-registration/refresh`, { method: "POST" })) as { registration: SeedanceRegistration };
    return data.registration;
  }

  /* ---------- asset_media 键三件套（主变体自动登记的 probe 与失败重试；路由
     /assets/:asset_id/media/:media_id/seedance-registration[/refresh]，与 media-results
     三件套同口径：404 归一 null、register 服务端幂等复用既有行、refresh 仅 processing 有意义） ---------- */

  /** 查某 asset_media（主变体）的登记现状；未登记归一为 null。 */
  async getAssetMediaSeedanceRegistration(assetId: string, mediaId: string): Promise<SeedanceRegistration | null> {
    try {
      const data = (await this.request(`/assets/${encodeURIComponent(assetId)}/media/${encodeURIComponent(mediaId)}/seedance-registration`)) as { registration?: SeedanceRegistration | null };
      return data.registration ?? null;
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 404) return null;
      throw reason;
    }
  }

  /** 登记/重试主变体（设主图失败后的「重试登记」入口）：服务端幂等复用/刷新既有行。 */
  async registerAssetMediaSeedance(assetId: string, mediaId: string): Promise<SeedanceRegistration> {
    const data = (await this.request(`/assets/${encodeURIComponent(assetId)}/media/${encodeURIComponent(mediaId)}/seedance-registration`, { method: "POST" })) as { registration: SeedanceRegistration };
    return data.registration;
  }

  /** 拉一次远端 GetAsset 刷新主变体登记状态（仅 processing 有意义，同 media-results 口径）。 */
  async refreshAssetMediaSeedance(assetId: string, mediaId: string): Promise<SeedanceRegistration> {
    const data = (await this.request(`/assets/${encodeURIComponent(assetId)}/media/${encodeURIComponent(mediaId)}/seedance-registration/refresh`, { method: "POST" })) as { registration: SeedanceRegistration };
    return data.registration;
  }

  /* ---------- Phase 3: 提示词预检 + 场景消耗汇总 ---------- */

  async precheckGeneration(input: {
    project_id: string;
    scene_id?: string;
    shot_id?: string;
    tier_id: string;
    media_kind: "image" | "video" | "audio";
    parameters: Record<string, string | number | boolean>;
    reference_media_ids?: string[];
    reference_lane_count?: number;
    quantity?: number;
  }): Promise<PrecheckResult> {
    const raw = await this.request<unknown>(`/generations/precheck`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return raw as PrecheckResult;
  }

  async getSceneConsumptionSummary(projectId: string, sceneId: string): Promise<SceneConsumptionSummary> {
    const raw = await this.request<unknown>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/consumption-summary`,
      { method: "GET" },
    );
    return raw as SceneConsumptionSummary;
  }
}

export const api = new ApiClient();

/* ---------- S20 剧本拆解：类型与防御解析（与后端 toRunResponse/toConfirmResponse 对齐） ---------- */

export type ScriptBreakdownRunStatus = "queued" | "running" | "draft" | "failed" | "confirmed" | "discarded" | "superseded";
export type ScriptBreakdownStageStatus = "pending" | "running" | "succeeded" | "failed";
export type ScriptBreakdownValidationStatus = "pass" | "pass_with_warnings" | "failed";

export interface ScriptVersion {
  id: string;
  episodeId: string;
  versionNo: number;
  title: string | null;
  scriptSha256: string;
  source: string;
  createdAt: string;
  /* P-06「左剧本原文」:后端 toScriptVersionResponse 加字段后即亮(加性);
     未落地前为 null,左栏如实空态(缺口已报 Fable 路由 sol,/tmp 急件 0640)。 */
  scriptText?: string | null;
}

export interface ScriptBreakdownValidationIssue {
  code: string;
  message: string;
  path: string | null;
}

export interface ScriptBreakdownUnmatchedAsset {
  kind: string;
  name: string;
  shotCandidateIds: string[];
}

export interface ScriptBreakdownDuplicateCoverage {
  lineIndex: number;
  shotCandidateIds: string[];
}

export interface ScriptBreakdownValidation {
  status: ScriptBreakdownValidationStatus;
  issues: ScriptBreakdownValidationIssue[];
  unmatchedAssets: ScriptBreakdownUnmatchedAsset[];
  duplicateCoverage: ScriptBreakdownDuplicateCoverage[];
  shotCount: number;
  totalDurationSec: number;
}

export interface ScriptBreakdownSceneDivision {
  sceneIndex: number;
  name: string | null;
  summary: string;
  startLineIndex: number;
  endLineIndex: number;
}

export interface ScriptBreakdownAssetCandidate {
  candidateId: string;
  name: string;
  description: string | null;
  /** v0.9：音频候选五类分类（仅 audios 组有值，其余组缺省）。 */
  audioKind?: string | null;
}

export interface ScriptBreakdownPrelinkedAsset {
  assetEntityId: string;
  name: string;
  matchedBy: "exact_name";
}

export interface ScriptBreakdownCharacterCandidate extends ScriptBreakdownAssetCandidate {
  gender: string | null;
  ageValue: number | null;
  ageStage: "child" | "teen" | "adult" | "older" | "unknown" | null;
  appearance: string | null;
  personalityTags: string[];
  prelinkedAsset: ScriptBreakdownPrelinkedAsset | null;
}

export interface ScriptBreakdownAssetCandidates {
  characters: ScriptBreakdownCharacterCandidate[];
  scenes: ScriptBreakdownAssetCandidate[];
  props: ScriptBreakdownAssetCandidate[];
  costumes: ScriptBreakdownAssetCandidate[];
  audios: ScriptBreakdownAssetCandidate[];
}

export interface ScriptBreakdownShotElements {
  subject: string | null;
  action: string | null;
  visual: string | null;
  cameraLanguage: string | null;
}

export interface ScriptBreakdownShotCandidate {
  candidateId: string;
  shotNo: number;
  sceneIndex: number;
  lineIndices: number[];
  elements: ScriptBreakdownShotElements | null;
  directorPrompt: string | null;
  imagePrompt: string | null;
  videoPrompt: string | null;
  durationSec: number;
  characterNames: string[];
  sceneNames: string[];
  propNames: string[];
  costumeNames: string[];
}

export interface ScriptBreakdownDraft {
  storySummary: string | null;
  sceneDivisions: ScriptBreakdownSceneDivision[];
  assetCandidates: ScriptBreakdownAssetCandidates;
  shotCandidates: ScriptBreakdownShotCandidate[];
}

export interface ScriptBreakdownStage {
  stageKey: string;
  stageOrder: number;
  status: ScriptBreakdownStageStatus;
  attemptCount: number;
  errorCode: string | null;
  displayReason?: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ScriptBreakdownRun {
  id: string;
  episodeId: string;
  scriptVersionId: string;
  status: ScriptBreakdownRunStatus;
  currentStage: string | null;
  modelName: string | null;
  promptVersion: string;
  targetDurationSec: number | null;
  errorCode: string | null;
  displayReason?: string | null;
  confirmedAt: string | null;
  discardedAt: string | null;
  supersededByRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptBreakdownRunDetail {
  run: ScriptBreakdownRun;
  draft: ScriptBreakdownDraft;
  validation: ScriptBreakdownValidation;
  stages: ScriptBreakdownStage[];
}

export interface ScriptBreakdownConfirmResult {
  runId: string;
  outcome: "confirmed" | "already_confirmed";
  sceneCount: number;
  shotCount: number;
  supersededRunIds: string[];
  unmatchedAssets: ScriptBreakdownUnmatchedAsset[];
}

const SCRIPT_BREAKDOWN_RUN_STATUSES: readonly string[] = ["queued", "running", "draft", "failed", "confirmed", "discarded", "superseded"];

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
}

export function scriptVersionFromUnknown(value: unknown): ScriptVersion {
  if (!isRecord(value)) throw new ApiClientError("剧本版本响应格式不正确", { code: "invalid_response" });
  return {
    id: requiredResponseId(value, "剧本版本", "id"),
    episodeId: optionalString(firstValue(value, "episodeId", "episode_id")) ?? "",
    versionNo: optionalNumber(firstValue(value, "versionNo", "version_no")) ?? 0,
    title: optionalString(value.title) ?? null,
    scriptSha256: optionalString(firstValue(value, "scriptSha256", "script_sha256")) ?? "",
    source: optionalString(value.source) ?? "manual",
    createdAt: optionalString(firstValue(value, "createdAt", "created_at")) ?? "",
    scriptText: optionalString(firstValue(value, "scriptText", "script_text")) ?? null,
  };
}

function runStatusFrom(value: unknown): ScriptBreakdownRunStatus {
  const status = optionalString(value);
  return SCRIPT_BREAKDOWN_RUN_STATUSES.includes(status ?? "") ? status as ScriptBreakdownRunStatus : "failed";
}

function validationIssueFromUnknown(value: unknown): ScriptBreakdownValidationIssue {
  const record = isRecord(value) ? value : {};
  return {
    code: optionalString(record.code) ?? "unknown",
    message: optionalString(record.message) ?? "",
    path: optionalString(record.path) ?? null,
  };
}

function unmatchedAssetFromUnknown(value: unknown): ScriptBreakdownUnmatchedAsset {
  const record = isRecord(value) ? value : {};
  return {
    kind: optionalString(record.kind) ?? "prop",
    name: optionalString(record.name) ?? "",
    shotCandidateIds: stringArray(firstValue(record, "shotCandidateIds", "shot_candidate_ids")),
  };
}

export function scriptBreakdownValidationFromUnknown(value: unknown): ScriptBreakdownValidation {
  const record = isRecord(value) ? value : {};
  const status = optionalString(record.status);
  const unmatched = firstValue(record, "unmatchedAssets", "unmatched_assets");
  const duplicates = firstValue(record, "duplicateCoverage", "duplicate_coverage");
  return {
    status: status === "pass" || status === "pass_with_warnings" || status === "failed" ? status : "pass",
    issues: Array.isArray(record.issues) ? record.issues.map(validationIssueFromUnknown) : [],
    unmatchedAssets: Array.isArray(unmatched) ? unmatched.map(unmatchedAssetFromUnknown) : [],
    duplicateCoverage: Array.isArray(duplicates)
      ? duplicates.map((item) => {
        const entry = isRecord(item) ? item : {};
        return {
          lineIndex: optionalNumber(firstValue(entry, "lineIndex", "line_index")) ?? 0,
          shotCandidateIds: stringArray(firstValue(entry, "shotCandidateIds", "shot_candidate_ids")),
        };
      })
      : [],
    shotCount: optionalNumber(firstValue(record, "shotCount", "shot_count")) ?? 0,
    totalDurationSec: optionalNumber(firstValue(record, "totalDurationSec", "total_duration_sec")) ?? 0,
  };
}

function sceneDivisionFromUnknown(value: unknown): ScriptBreakdownSceneDivision {
  const record = isRecord(value) ? value : {};
  return {
    sceneIndex: optionalNumber(firstValue(record, "sceneIndex", "scene_index")) ?? 0,
    name: optionalString(record.name) ?? null,
    summary: optionalString(record.summary) ?? "",
    startLineIndex: optionalNumber(firstValue(record, "startLineIndex", "start_line_index")) ?? 0,
    endLineIndex: optionalNumber(firstValue(record, "endLineIndex", "end_line_index")) ?? 0,
  };
}

function assetCandidateFromUnknown(value: unknown): ScriptBreakdownAssetCandidate {
  const record = isRecord(value) ? value : {};
  return {
    candidateId: optionalString(firstValue(record, "candidateId", "candidate_id")) ?? "",
    name: optionalString(record.name) ?? "",
    description: optionalString(record.description) ?? null,
  };
}

/** v0.9：音频候选多带五类分类(阶段① audio_kind)；其余组仍走 assetCandidateFromUnknown。 */
function audioCandidateFromUnknown(value: unknown): ScriptBreakdownAssetCandidate {
  const record = isRecord(value) ? value : {};
  return {
    ...assetCandidateFromUnknown(value),
    audioKind: optionalString(firstValue(record, "audioKind", "audio_kind")) ?? null,
  };
}

function characterCandidateFromUnknown(value: unknown): ScriptBreakdownCharacterCandidate {
  const base = assetCandidateFromUnknown(value);
  const record = isRecord(value) ? value : {};
  const ageStage = optionalString(firstValue(record, "ageStage", "age_stage"));
  const prelinkedValue = firstValue(record, "prelinkedAsset", "prelinked_asset");
  const prelinked = isRecord(prelinkedValue) ? prelinkedValue : null;
  return {
    ...base,
    gender: optionalString(record.gender) ?? null,
    ageValue: optionalNumber(firstValue(record, "ageValue", "age_value")) ?? null,
    ageStage: ageStage === "child" || ageStage === "teen" || ageStage === "adult"
      || ageStage === "older" || ageStage === "unknown" ? ageStage : null,
    appearance: optionalString(record.appearance) ?? null,
    personalityTags: stringArray(firstValue(record, "personalityTags", "personality_tags")),
    prelinkedAsset: prelinked
      && optionalString(firstValue(prelinked, "matchedBy", "matched_by")) === "exact_name"
      ? {
      assetEntityId: optionalString(firstValue(prelinked, "assetEntityId", "asset_entity_id")) ?? "",
      name: optionalString(prelinked.name) ?? "",
      matchedBy: "exact_name",
      }
      : null,
  };
}

function shotCandidateFromUnknown(value: unknown): ScriptBreakdownShotCandidate {
  const record = isRecord(value) ? value : {};
  const elementsValue = record.elements;
  const elements = isRecord(elementsValue) ? elementsValue : null;
  return {
    candidateId: optionalString(firstValue(record, "candidateId", "candidate_id")) ?? "",
    shotNo: optionalNumber(firstValue(record, "shotNo", "shot_no")) ?? 0,
    sceneIndex: optionalNumber(firstValue(record, "sceneIndex", "scene_index")) ?? 0,
    lineIndices: numberArray(firstValue(record, "lineIndices", "line_indices")),
    elements: elements ? {
      subject: optionalString(elements.subject) ?? null,
      action: optionalString(elements.action) ?? null,
      visual: optionalString(elements.visual) ?? null,
      cameraLanguage: optionalString(firstValue(elements, "cameraLanguage", "camera_language")) ?? null,
    } : null,
    directorPrompt: optionalString(firstValue(record, "directorPrompt", "director_prompt")) ?? null,
    imagePrompt: optionalString(firstValue(record, "imagePrompt", "image_prompt")) ?? null,
    videoPrompt: optionalString(firstValue(record, "videoPrompt", "video_prompt")) ?? null,
    durationSec: optionalNumber(firstValue(record, "durationSec", "duration_sec")) ?? 0,
    characterNames: stringArray(firstValue(record, "characterNames", "character_names")),
    sceneNames: stringArray(firstValue(record, "sceneNames", "scene_names")),
    propNames: stringArray(firstValue(record, "propNames", "prop_names")),
    costumeNames: stringArray(firstValue(record, "costumeNames", "costume_names")),
  };
}

export function scriptBreakdownDraftFromUnknown(value: unknown): ScriptBreakdownDraft {
  const record = isRecord(value) ? value : {};
  const candidatesValue = firstValue(record, "assetCandidates", "asset_candidates");
  const candidates = isRecord(candidatesValue) ? candidatesValue : {};
  const divisions = firstValue(record, "sceneDivisions", "scene_divisions");
  const shots = firstValue(record, "shotCandidates", "shot_candidates");
  return {
    storySummary: optionalString(firstValue(record, "storySummary", "story_summary")) ?? null,
    sceneDivisions: Array.isArray(divisions) ? divisions.map(sceneDivisionFromUnknown) : [],
    assetCandidates: {
      characters: Array.isArray(candidates.characters) ? candidates.characters.map(characterCandidateFromUnknown) : [],
      scenes: Array.isArray(candidates.scenes) ? candidates.scenes.map(assetCandidateFromUnknown) : [],
      props: Array.isArray(candidates.props) ? candidates.props.map(assetCandidateFromUnknown) : [],
      costumes: Array.isArray(candidates.costumes) ? candidates.costumes.map(assetCandidateFromUnknown) : [],
      audios: Array.isArray(candidates.audios) ? candidates.audios.map(audioCandidateFromUnknown) : [],
    },
    shotCandidates: Array.isArray(shots) ? shots.map(shotCandidateFromUnknown) : [],
  };
}

export function scriptBreakdownRunFromUnknown(value: unknown): ScriptBreakdownRun {
  if (!isRecord(value)) throw new ApiClientError("拆解运行响应格式不正确", { code: "invalid_response" });
  return {
    id: requiredResponseId(value, "拆解运行", "id"),
    episodeId: optionalString(firstValue(value, "episodeId", "episode_id")) ?? "",
    scriptVersionId: optionalString(firstValue(value, "scriptVersionId", "script_version_id")) ?? "",
    status: runStatusFrom(value.status),
    currentStage: optionalString(firstValue(value, "currentStage", "current_stage")) ?? null,
    modelName: optionalString(firstValue(value, "modelName", "model_name")) ?? null,
    promptVersion: optionalString(firstValue(value, "promptVersion", "prompt_version")) ?? "",
    targetDurationSec: optionalNumber(firstValue(value, "targetDurationSec", "target_duration_sec")) ?? null,
    errorCode: optionalString(firstValue(value, "errorCode", "error_code")) ?? null,
    displayReason: optionalString(firstValue(value, "displayReason", "display_reason")) ?? null,
    confirmedAt: optionalString(firstValue(value, "confirmedAt", "confirmed_at")) ?? null,
    discardedAt: optionalString(firstValue(value, "discardedAt", "discarded_at")) ?? null,
    supersededByRunId: optionalString(firstValue(value, "supersededByRunId", "superseded_by_run_id")) ?? null,
    createdAt: optionalString(firstValue(value, "createdAt", "created_at")) ?? "",
    updatedAt: optionalString(firstValue(value, "updatedAt", "updated_at")) ?? "",
  };
}

function stageFromUnknown(value: unknown): ScriptBreakdownStage {
  const record = isRecord(value) ? value : {};
  const status = optionalString(record.status);
  return {
    stageKey: optionalString(firstValue(record, "stageKey", "stage_key")) ?? "",
    stageOrder: optionalNumber(firstValue(record, "stageOrder", "stage_order")) ?? 0,
    status: status === "running" || status === "succeeded" || status === "failed" ? status : "pending",
    attemptCount: optionalNumber(firstValue(record, "attemptCount", "attempt_count")) ?? 0,
    errorCode: optionalString(firstValue(record, "errorCode", "error_code")) ?? null,
    displayReason: optionalString(firstValue(record, "displayReason", "display_reason")) ?? null,
    startedAt: optionalString(firstValue(record, "startedAt", "started_at")) ?? null,
    completedAt: optionalString(firstValue(record, "completedAt", "completed_at")) ?? null,
  };
}

export function scriptBreakdownRunDetailFromUnknown(value: unknown): ScriptBreakdownRunDetail {
  if (!isRecord(value)) throw new ApiClientError("拆解详情响应格式不正确", { code: "invalid_response" });
  const runValue = isRecord(value.run) ? value.run : value;
  const runRecord = runValue as Record<string, unknown>;
  return {
    run: scriptBreakdownRunFromUnknown(runValue),
    draft: scriptBreakdownDraftFromUnknown(runRecord.draft),
    validation: scriptBreakdownValidationFromUnknown(runRecord.validation),
    stages: Array.isArray(value.stages) ? value.stages.map(stageFromUnknown) : [],
  };
}

export function scriptBreakdownConfirmFromUnknown(value: unknown): ScriptBreakdownConfirmResult {
  if (!isRecord(value)) throw new ApiClientError("确认结果响应格式不正确", { code: "invalid_response" });
  return {
    runId: optionalString(firstValue(value, "runId", "run_id")) ?? "",
    outcome: value.outcome === "already_confirmed" ? "already_confirmed" : "confirmed",
    sceneCount: optionalNumber(firstValue(value, "sceneCount", "scene_count")) ?? 0,
    shotCount: optionalNumber(firstValue(value, "shotCount", "shot_count")) ?? 0,
    supersededRunIds: stringArray(firstValue(value, "supersededRunIds", "superseded_run_ids")),
    unmatchedAssets: (() => {
      const unmatched = firstValue(value, "unmatchedAssets", "unmatched_assets");
      return Array.isArray(unmatched) ? unmatched.map(unmatchedAssetFromUnknown) : [];
    })(),
  };
}
