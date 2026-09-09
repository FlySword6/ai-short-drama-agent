export type VolcAssetType = "Image" | "Video" | "Audio";
/** CreateAsset submission is restricted to image and primary-variant audio. */
export type CreateableVolcAssetType = "Image" | "Audio";
export type VolcAssetStatus =
  | "Active"
  | "Processing"
  | "Failed"
  | "Removed"
  | "Revoked"
  | "Unavailable";
export type VolcListAssetStatus = Extract<VolcAssetStatus, "Active" | "Processing" | "Failed">;

export const VOLC_ASSET_REGISTRY_FAILURE_CODES = [
  "ASSET_REGISTRY_INVALID_REQUEST",
  "ASSET_REGISTRY_ACCESS_DENIED",
  "ASSET_REGISTRY_RATE_LIMITED",
  "ASSET_REGISTRY_NOT_FOUND",
  "ASSET_REGISTRY_REJECTED",
  "ASSET_REGISTRY_UNAVAILABLE",
  "ASSET_REGISTRY_INVALID_RESPONSE",
  "ASSET_REGISTRY_IDENTITY_MISMATCH",
  "ASSET_REGISTRY_QUERY_LIMIT_REACHED",
  "ASSET_REGISTRY_PROCESSING_FAILED",
  "ASSET_REGISTRY_SUBMISSION_OUTCOME_UNKNOWN",
  "ASSET_REGISTRY_BINDING_UNVERIFIED",
  "ASSET_REGISTRY_AUTHORIZATION_EXPIRED",
  "ASSET_REGISTRY_VERIFICATION_STALE",
  "ASSET_REGISTRY_FAILED",
] as const;

export type VolcAssetRegistryFailureCode =
  typeof VOLC_ASSET_REGISTRY_FAILURE_CODES[number];

export const VOLC_ASSET_GROUP_FAILURE_CODES = [
  "ASSET_GROUP_INVALID_REQUEST",
  "ASSET_GROUP_ACCESS_DENIED",
  "ASSET_GROUP_RATE_LIMITED",
  "ASSET_GROUP_REJECTED",
  "ASSET_GROUP_UNAVAILABLE",
  "ASSET_GROUP_INVALID_RESPONSE",
  "ASSET_GROUP_OUTCOME_UNKNOWN",
  "ASSET_GROUP_FAILED",
] as const;

export type VolcAssetGroupFailureCode =
  typeof VOLC_ASSET_GROUP_FAILURE_CODES[number];

export type PublicVolcAssetFailureCode =
  | VolcAssetRegistryFailureCode
  | VolcAssetGroupFailureCode;

export interface CreateVolcAssetGroupResult {
  groupId: string;
  requestId: string | null;
  httpStatus: number;
}

export interface CreateVolcAssetResult {
  assetId: string;
  requestId: string | null;
  httpStatus: number;
  errorCode: null;
  errorMessage: null;
}

export interface VolcAssetListItem {
  assetId: string;
  name: string;
  groupId: string;
  assetType: VolcAssetType;
  status: VolcListAssetStatus;
  errorCode: VolcAssetRegistryFailureCode | null;
  errorMessage: string | null;
  projectName: string;
  createTime: string;
  updateTime: string;
  lastInferenceTime: string | null;
}

export interface ListVolcAssetsResult {
  items: VolcAssetListItem[];
  totalCount: number;
  pageNumber: number;
  pageSize: number;
  requestId: string | null;
  httpStatus: number;
}

export interface VolcAssetRegistryFailure {
  errorCode: VolcAssetRegistryFailureCode;
  errorMessage: string;
  requestId: string | null;
  httpStatus: number | null;
}

/**
 * Provider-neutral failure contract. Only the integration adapter decides
 * whether a supplier error means a write outcome is unknown.
 */
export class VolcAssetRegistryOperationError extends Error {
  constructor(
    readonly failure: VolcAssetRegistryFailure,
    readonly outcomeUnknown: boolean,
  ) {
    super(failure.errorMessage);
    this.name = "VolcAssetRegistryOperationError";
  }
}

export interface VolcAssetRegistryPort {
  createAssetGroup(input: {
    name: string;
    description: string;
    groupType: "AIGC";
    projectName: string;
  }): Promise<CreateVolcAssetGroupResult>;
  createAsset(input: {
    groupId: string;
    url: string;
    assetType: CreateableVolcAssetType;
    projectName: string;
    name: string;
  }): Promise<CreateVolcAssetResult>;
  listAssets(input: {
    groupIds: string[];
    groupType?: "AIGC";
    statuses?: VolcListAssetStatus[];
    name?: string;
    pageNumber?: number;
    pageSize?: number;
    sortBy?: "CreateTime";
    sortOrder?: "Desc";
    projectName: string;
  }): Promise<ListVolcAssetsResult>;
}

const REGISTRY_FAILURE_CODE_SET = new Set<string>(VOLC_ASSET_REGISTRY_FAILURE_CODES);
const GROUP_FAILURE_CODE_SET = new Set<string>(VOLC_ASSET_GROUP_FAILURE_CODES);

export function isVolcAssetRegistryFailureCode(
  value: string | null | undefined,
): value is VolcAssetRegistryFailureCode {
  return typeof value === "string" && REGISTRY_FAILURE_CODE_SET.has(value);
}

export function isVolcAssetGroupFailureCode(
  value: string | null | undefined,
): value is VolcAssetGroupFailureCode {
  return typeof value === "string" && GROUP_FAILURE_CODE_SET.has(value);
}

/**
 * Public and persistence boundaries must never return a provider-native code.
 * Legacy rows are intentionally projected into the new stable categories.
 */
export function publicVolcAssetFailureCode(value: string): PublicVolcAssetFailureCode {
  if (isVolcAssetRegistryFailureCode(value) || isVolcAssetGroupFailureCode(value)) {
    return value;
  }

  const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (normalized.includes("ASSET_GROUP")) {
    if (normalized.includes("OUTCOME_UNKNOWN")) return "ASSET_GROUP_OUTCOME_UNKNOWN";
    if (normalized.includes("ACCESS_DENIED")) return "ASSET_GROUP_ACCESS_DENIED";
    if (normalized.includes("RATE_LIMIT") || normalized.includes("THROTTL")) {
      return "ASSET_GROUP_RATE_LIMITED";
    }
    if (normalized.includes("INVALID_RESPONSE") || normalized.includes("MISSING_")) {
      return "ASSET_GROUP_INVALID_RESPONSE";
    }
    if (normalized.includes("INVALID")) return "ASSET_GROUP_INVALID_REQUEST";
    if (normalized.includes("UNAVAILABLE") || normalized.includes("REQUEST_FAILED")) {
      return "ASSET_GROUP_UNAVAILABLE";
    }
    return "ASSET_GROUP_FAILED";
  }

  if (normalized.includes("SUBMISSION_OUTCOME_UNKNOWN")) {
    return "ASSET_REGISTRY_SUBMISSION_OUTCOME_UNKNOWN";
  }
  if (normalized.includes("BINDING_UNVERIFIED")) return "ASSET_REGISTRY_BINDING_UNVERIFIED";
  if (normalized.includes("AUTHORIZATION_EXPIRED")) {
    return "ASSET_REGISTRY_AUTHORIZATION_EXPIRED";
  }
  if (normalized.includes("VERIFICATION_STALE")) return "ASSET_REGISTRY_VERIFICATION_STALE";
  if (normalized.includes("ACCESSDENIED") || normalized.includes("ACCESS_DENIED")) {
    return "ASSET_REGISTRY_ACCESS_DENIED";
  }
  if (normalized.includes("RATE_LIMIT") || normalized.includes("THROTTL")) {
    return "ASSET_REGISTRY_RATE_LIMITED";
  }
  if (normalized.includes("NOT_FOUND") || normalized.includes("NOTFOUND")) {
    return "ASSET_REGISTRY_NOT_FOUND";
  }
  if (normalized.includes("LIST_LIMIT") || normalized.includes("QUERY_LIMIT")) {
    return "ASSET_REGISTRY_QUERY_LIMIT_REACHED";
  }
  if (normalized.includes("IDENTITY_MISMATCH")) return "ASSET_REGISTRY_IDENTITY_MISMATCH";
  if (
    normalized.includes("INVALID_RESPONSE")
    || normalized.includes("INVALID_ARK_RESPONSE")
    || normalized.includes("MISSING_ASSET_ID")
    || normalized.includes("INVALID_ASSET_LIST")
  ) {
    return "ASSET_REGISTRY_INVALID_RESPONSE";
  }
  if (
    normalized.includes("INVALID_PARAMETER")
    || normalized.includes("INVALIDPARAMETER")
    || normalized.includes("INVALID_REQUEST")
    || normalized.includes("INVALIDREQUEST")
    || normalized.includes("INVALID_ASSET_REGISTRY_INPUT")
  ) {
    return "ASSET_REGISTRY_INVALID_REQUEST";
  }
  if (normalized.includes("UNAVAILABLE") || normalized.includes("REQUEST_FAILED")) {
    return "ASSET_REGISTRY_UNAVAILABLE";
  }
  return "ASSET_REGISTRY_FAILED";
}

export function volcAssetRegistryFailureMessage(
  code: VolcAssetRegistryFailureCode,
): string {
  switch (code) {
    case "ASSET_REGISTRY_INVALID_REQUEST":
      return "素材注册请求不符合火山素材库合同";
    case "ASSET_REGISTRY_ACCESS_DENIED":
      return "火山素材库拒绝访问，请核对账号权限";
    case "ASSET_REGISTRY_RATE_LIMITED":
      return "火山素材库请求过于频繁，请稍后重试";
    case "ASSET_REGISTRY_NOT_FOUND":
      return "火山素材库中未找到目标素材";
    case "ASSET_REGISTRY_REJECTED":
      return "火山素材库拒绝了本次操作";
    case "ASSET_REGISTRY_UNAVAILABLE":
      return "火山素材注册服务暂时不可用";
    case "ASSET_REGISTRY_INVALID_RESPONSE":
      return "火山素材注册服务返回了无法确认的结果";
    case "ASSET_REGISTRY_IDENTITY_MISMATCH":
      return "火山素材回读身份与本地映射不一致";
    case "ASSET_REGISTRY_QUERY_LIMIT_REACHED":
      return "火山素材列表超过受控查询上限，请缩小范围后人工复核";
    case "ASSET_REGISTRY_PROCESSING_FAILED":
      return "火山素材处理失败，请人工复核后再操作";
    case "ASSET_REGISTRY_SUBMISSION_OUTCOME_UNKNOWN":
      return "火山素材登记结果不明确，系统不会自动重复登记";
    case "ASSET_REGISTRY_BINDING_UNVERIFIED":
      return "火山既有素材绑定尚未完成远端核验";
    case "ASSET_REGISTRY_AUTHORIZATION_EXPIRED":
      return "火山素材授权已到期，必须人工刷新核验";
    case "ASSET_REGISTRY_VERIFICATION_STALE":
      return "火山素材远端核验已过期，必须人工刷新核验";
    case "ASSET_REGISTRY_FAILED":
      return "火山素材登记未完成，请查看受控服务日志";
  }
}

/**
 * Public views derive their message from the stable failure category instead
 * of replaying a stored/provider message. This also makes legacy rows safe to
 * expose after their provider-native code has been normalized.
 */
export function publicVolcAssetFailureMessage(
  code: PublicVolcAssetFailureCode,
): string {
  if (isVolcAssetRegistryFailureCode(code)) {
    return volcAssetRegistryFailureMessage(code);
  }
  switch (code) {
    case "ASSET_GROUP_INVALID_REQUEST":
      return "素材组创建请求不符合火山素材库合同";
    case "ASSET_GROUP_ACCESS_DENIED":
      return "火山素材库拒绝素材组操作，请核对账号权限";
    case "ASSET_GROUP_RATE_LIMITED":
      return "火山素材组请求过于频繁，请稍后重试";
    case "ASSET_GROUP_REJECTED":
      return "火山素材库拒绝了本次素材组操作";
    case "ASSET_GROUP_UNAVAILABLE":
      return "火山素材组服务暂时不可用";
    case "ASSET_GROUP_INVALID_RESPONSE":
      return "火山素材组服务返回了无法确认的结果";
    case "ASSET_GROUP_OUTCOME_UNKNOWN":
      return "火山素材组创建结果不明确，系统不会自动重复创建";
    case "ASSET_GROUP_FAILED":
      return "火山素材组操作未完成，请查看受控服务日志";
  }
}
