import { normalisePublicFieldDetails } from "./fieldLabels.js";

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details: unknown | null;
}

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details: unknown | null = null,
    readonly displayMessage?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details: unknown | null = null) {
    super(400, "invalid_request", message, false, details);
    this.name = "BadRequestError";
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string, details: unknown | null = null) {
    super(413, "payload_too_large", message, false, details);
    this.name = "PayloadTooLargeError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "请先登录") {
    super(401, "unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "没有权限执行此操作") {
    super(403, "forbidden", message);
    this.name = "ForbiddenError";
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message: string, details: unknown | null = null) {
    super(422, "unprocessable_entity", message, false, details);
    this.name = "UnprocessableEntityError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "资源不存在") {
    super(404, "not_found", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict", details: unknown | null = null) {
    super(409, code, message, false, details);
    this.name = "ConflictError";
  }
}

export class ExternalServiceError extends AppError {
  constructor(
    readonly service: string,
    readonly internalMessage: string,
  ) {
    super(502, "external_service_error", `${service}: ${internalMessage}`, true);
    this.name = "ExternalServiceError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function errorBody(error: unknown): ErrorBody {
  const businessError = knownDatabaseBusinessError(error);
  if (businessError) return errorBody(businessError);
  if (error instanceof ExternalServiceError) {
    return {
      code: error.code,
      message: externalServicePublicMessage(error.service),
      retryable: error.retryable,
      details: null,
    };
  }
  if (error instanceof AppError) {
    const details = publicAppErrorDetails(error);
    const message = isPublicReferenceReviewDetails(details)
      ? details.display_message
      : error.displayMessage ?? error.message;
    return {
      code: error.code,
      message,
      retryable: error.retryable,
      details,
    };
  }
  if (isPublicErrorLike(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: null,
    };
  }
  // 数据库层不可用(连不上/认证失败/库或 schema 缺失)与真正的内部缺陷分层:
  // 用户文案保持不变(不泄露内部细节),区别只在 code 与服务端日志,便于运维定位。
  if (isDatabaseUnavailableError(error)) {
    return {
      code: "db_unavailable",
      message: "服务暂时不可用，请稍后重试",
      retryable: true,
      details: null,
    };
  }
  return {
    code: "internal_error",
    message: "服务暂时不可用，请稍后重试",
    retryable: true,
    details: null,
  };
}

function publicAppErrorDetails(error: AppError): unknown | null {
  if (error.code === "invalid_request") {
    return normalisePublicFieldDetails(error.details);
  }
  if (error.code === "control_asset_invalid_usage" || error.code === "unprocessable_entity") {
    const reviewDetails = publicReferenceReviewDetails(error.details);
    if (reviewDetails) return reviewDetails;
  }
  if (
    error.code === "scene_version_conflict"
    || error.code === "command_validation_failed"
    || error.code === "deliverable_not_ready"
    || error.code === "playback_not_ready"
    || error.code === "media_review_not_accepted"
  ) {
    return error.details;
  }
  return null;
}

/**
 * Only project the explicitly versioned review-gate fields. Other 422 details
 * stay private, so making this one rejection directly renderable does not turn
 * every validation error into an internal-data disclosure.
 */
function publicReferenceReviewDetails(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const details = value as Record<string, unknown>;
  if (
    details.kind !== "reference_asset_review_required"
    || typeof details.asset_entity_id !== "string"
    || typeof details.asset_name !== "string"
    || typeof details.review_status !== "string"
    || (details.destination !== "参考控制包" && details.destination !== "付费生成")
  ) {
    return null;
  }
  const assetName = publicReferenceAssetName(details.asset_name);
  const reviewStatusLabel = publicReferenceReviewStatusLabel(details.review_status);
  const displayMessage = `资产《${assetName}》尚未通过审核（当前：${reviewStatusLabel}），不能用于${details.destination}，请先完成通用资产审核`;
  return {
    kind: details.kind,
    asset_entity_id: details.asset_entity_id,
    ...(typeof details.asset_media_id === "string" ? { asset_media_id: details.asset_media_id } : {}),
    asset_name: assetName,
    review_status: details.review_status,
    review_status_label: reviewStatusLabel,
    destination: details.destination,
    display_message: displayMessage,
  };
}

function isPublicReferenceReviewDetails(
  value: unknown,
): value is Record<string, string> & { display_message: string } {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === "reference_asset_review_required"
    && typeof (value as Record<string, unknown>).display_message === "string",
  );
}

function publicReferenceAssetName(value: string): string {
  const normalized = value.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[《》]/gu, "")
    .trim()
    .slice(0, 128);
  if (
    !normalized
    || /https?:\/\/|(?:api[_.-]?key|token|secret|password|endpoint)/iu.test(normalized)
  ) {
    return "该资产";
  }
  return normalized;
}

function publicReferenceReviewStatusLabel(status: string): string {
  switch (status) {
    case "automatic_review":
      return "自动审核中";
    case "pending_review":
      return "待审核";
    case "rejected":
      return "已拒绝";
    case "approved":
      return "已通过";
    default:
      return "状态异常";
  }
}

/**
 * Convert a caught runtime failure to user copy while leaving the raw Error
 * available to the caller for server-side logging.
 */
export function publicMessage(error: unknown, fallback: string): string {
  const businessError = knownDatabaseBusinessError(error);
  if (businessError) return businessError.message;
  if (error instanceof ExternalServiceError) return externalServicePublicMessage(error.service);
  if (error instanceof AppError) {
    return publicStoredMessage(error.displayMessage ?? error.message, fallback);
  }
  return fallback;
}

/**
 * Protect read paths from legacy task rows that may still contain a provider
 * error. Audit fields stay intact; display_reason uses this safe projection.
 */
export function publicStoredMessage(message: unknown, fallback: string): string {
  if (typeof message !== "string" || !message.trim()) return fallback;
  const cleaned = message.trim()
    .replace(/\bTOS\b/giu, "存储服务")
    .replace(/\bArk\b/giu, "生成服务")
    .replace(/远程\s*Pi|\bPi\b/giu, "AI 助手")
    .replace(/\bMilvus\b|\bEmbedding\b|向量模型/giu, "检索服务");
  if (!/[\u3400-\u9fff]/u.test(cleaned)) return fallback;
  if (/\b(?:HTTP|Provider|upstream|request|response|status|error|failed|failure|timeout)\b/iu.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function externalServicePublicMessage(service: string): string {
  const normalized = service.trim().toLowerCase();
  if (/tos|storage/u.test(normalized)) {
    return "素材没能保存：存储服务暂时没响应，请稍后重试。";
  }
  if (/milvus|embed|vector/u.test(normalized)) {
    return "素材检索没成：检索服务暂时没响应，请稍后重试。";
  }
  if (/vision/u.test(normalized)) {
    return "图片没能识别：图片理解服务暂时没响应，请稍后重试。";
  }
  if (/ark|doubao|generation|model/u.test(normalized)) {
    return "生成没成：生成服务暂时没响应，请稍后重试。";
  }
  return "这次处理没成：相关服务暂时没响应，请稍后重试。";
}

/**
 * Migration 034 owns the last, concurrent-safe credit check inside
 * PostgreSQL. Translate its deliberately stable SQLSTATE/message pairs at the
 * HTTP boundary so a race with another browser tab still gets the same human
 * error as the earlier estimate guard.
 */
export function knownDatabaseBusinessError(error: unknown): AppError | undefined {
  if (postgresErrorCode(error) !== "P0001") return undefined;
  const message = postgresErrorMessage(error);
  switch (message) {
    case "account_credit_insufficient":
      return new AppError(422, "account_credit_insufficient", "账户积分不足，请使用邀请码或联系管理员充值后再发起生成");
    case "account_credit_daily_limit_exceeded":
      return new AppError(422, "account_credit_daily_limit_exceeded", "今日账户额度已用完，请明天再试或联系管理员调整");
    case "account_credit_account_missing":
      return new AppError(503, "account_credit_unavailable", "账户积分信息尚未就绪，请稍后重试", true);
    case "account_credit_invalid_generation_quote":
      return new AppError(409, "account_credit_quote_invalid", "本次生成报价状态异常，请重新估价后再提交");
    case "account_credit_duplicate_generation_attempt":
      return new AppError(409, "account_credit_duplicate_generation_attempt", "该生成任务已经提交，无需再次扣费");
    case "asset_review_change_in_progress":
      return new ConflictError(
        "该资产正用于一笔已进入供应商提交中的生成任务，请待提交结果明确后再修改审核状态",
        "asset_review_change_in_progress",
      );
    default:
      return undefined;
  }
}

function isPublicErrorLike(error: unknown): error is {
  statusCode: number;
  code: string;
  message: string;
  retryable: boolean;
} {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return typeof value.statusCode === "number"
    && typeof value.code === "string"
    && typeof value.message === "string"
    && typeof value.retryable === "boolean";
}

export function isPostgresUniqueViolation(error: unknown): boolean {
  if (postgresErrorCode(error) === "23505") return true;
  const cause = typeof error === "object" && error !== null
    ? (error as { cause?: unknown }).cause
    : undefined;
  return postgresErrorCode(cause) === "23505";
}

export function isPostgresUndefinedTable(error: unknown): boolean {
  return postgresErrorCode(error) === "42P01";
}

export type DatabaseErrorKind =
  | "host_unreachable"
  | "auth_failed"
  | "database_or_schema_missing"
  | "unknown";

const networkErrorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
]);

/**
 * Classify PostgreSQL / node-postgres failures for operations. SQLSTATE class
 * 08 is the connection-exception family; 57P01–57P03 and 53300 mean the server
 * cannot accept (more) work right now; 28P01/28000 are authentication; 3D000
 * and 3F000 mean the configured database or schema does not exist.
 */
export function classifyDatabaseError(error: unknown): DatabaseErrorKind {
  const code = postgresErrorCode(error);
  if (!code) return "unknown";
  if (networkErrorCodes.has(code)) return "host_unreachable";
  if (code.startsWith("08")) return "host_unreachable";
  if (code === "57P01" || code === "57P02" || code === "57P03" || code === "53300") return "host_unreachable";
  if (code === "28P01" || code === "28000") return "auth_failed";
  if (code === "3D000" || code === "3F000") return "database_or_schema_missing";
  return "unknown";
}

/**
 * True when the failure means the application cannot reach or use its
 * database at all (as opposed to a business error or an internal defect).
 * Used to keep such failures out of the generic internal_error bucket.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  return classifyDatabaseError(error) !== "unknown";
}

function postgresErrorCode(error: unknown): string | undefined {
  return postgresError(error)?.code;
}

function postgresErrorMessage(error: unknown): string {
  return postgresError(error)?.message ?? "";
}

/**
 * Drizzle preserves node-postgres failures in `cause`. Follow only that narrow
 * chain and stop at the first SQLSTATE-bearing object; stable business-message
 * switches above still prevent arbitrary database copy from reaching clients.
 */
function postgresError(error: unknown): { code: string; message: string } | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof value.code === "string") {
      return {
        code: value.code,
        message: typeof value.message === "string" ? value.message : "",
      };
    }
    current = value.cause;
  }
  return undefined;
}
