import {
  AppError,
  errorBody,
  knownDatabaseBusinessError,
  type ErrorBody,
} from "../shared/errors.js";

export interface HttpErrorResponse {
  statusCode: number;
  body: ErrorBody;
}

/**
 * One public error boundary for the real app and module test harnesses.
 * Framework 4xx errors are never trusted as user copy because their messages
 * can contain HTTP codes, parser terms, paths, or raw field names.
 */
export function toHttpErrorResponse(error: unknown): HttpErrorResponse {
  const normalizedError = knownDatabaseBusinessError(error) ?? error;
  const statusCode = httpStatusCode(normalizedError);
  if (normalizedError instanceof AppError) {
    return { statusCode, body: errorBody(normalizedError) };
  }
  if (statusCode >= 400 && statusCode < 500) {
    return { statusCode, body: nonAppClientErrorBody(statusCode) };
  }
  return { statusCode, body: errorBody(normalizedError) };
}

function httpStatusCode(error: unknown): number {
  if (!error || typeof error !== "object") return 500;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : 500;
}

function nonAppClientErrorBody(statusCode: number): ErrorBody {
  switch (statusCode) {
    case 401:
      return body("unauthorized", "当前操作没成：请先登录。");
    case 403:
      return body("forbidden", "当前操作没成：这个账号没有所需权限。");
    case 404:
      return body("not_found", "内容没找到：可能已被删除，请刷新后重试。");
    case 408:
      return body("request_timeout", "请求没能及时完成：请重试。", true);
    case 409:
      return body("conflict", "操作没成：内容已经发生变化，请刷新后重试。");
    case 413:
      return body("payload_too_large", "上传没成：文件太大，请压缩后重试。");
    case 415:
      return body("unsupported_media_type", "上传没成：文件格式不支持，请更换文件后重试。");
    case 422:
      return body("unprocessable_entity", "请求没能处理：填写内容不符合要求，请检查后重试。");
    case 429:
      return body("too_many_requests", "操作没成：提交太频繁，请稍等一会儿再试。", true);
    default:
      return body("invalid_request", "请求没能处理：填写内容有误，请检查后重试。");
  }
}

function body(code: string, message: string, retryable = false): ErrorBody {
  return { code, message, retryable, details: null };
}
