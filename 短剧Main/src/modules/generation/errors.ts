import { AppError, publicStoredMessage } from "../../shared/errors.js";

export type GenerationErrorCode =
  | "INVALID_GENERATION_REQUEST"
  | "control_asset_invalid_usage"
  | "shot_final_image_reference_unavailable"
  | "sample_mode_batch_only"
  | "sample_mode_video_only"
  | "GENERATION_NOT_FOUND"
  | "GENERATION_NOTIFICATION_NOT_FOUND"
  | "GENERATION_STATE_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "GENERATION_BUDGET_EXCEEDED"
  | "GENERATION_QUOTE_NOT_FOUND"
  | "GENERATION_QUOTE_UNCONFIRMED"
  | "GENERATION_QUOTE_EXPIRED"
  | "GENERATION_QUOTE_CONFLICT"
  | "GENERATION_QUOTE_SOURCE_MISMATCH"
  | "GENERATION_QUOTE_CONTEXT_MISMATCH"
  | "GENERATION_QUOTE_INVALID_SNAPSHOT"
  | "GENERATION_BATCH_AUTHORIZATION_NOT_FOUND"
  | "GENERATION_CAPABILITY_UNAVAILABLE"
  | "PROVIDER_COMPANY_ACCOUNT_NOT_ENABLED"
  | "quote_stale"
  | "PROVIDER_REJECTED"
  | "PROVIDER_TASK_FAILED"
  | "SUBMISSION_OUTCOME_UNKNOWN";

export class GenerationError extends AppError {
  constructor(
    override readonly code: GenerationErrorCode,
    message: string,
    override readonly statusCode: number,
    override readonly retryable = false,
    override readonly details: unknown | null = null,
  ) {
    super(
      statusCode,
      code,
      message,
      retryable,
      details,
      publicGenerationErrorMessage(code, message),
    );
    this.name = "GenerationError";
  }
}

const generationErrorFallbacks: Record<GenerationErrorCode, string> = {
  INVALID_GENERATION_REQUEST: "生成设置不符合要求，请检查后重试。",
  control_asset_invalid_usage: "参考素材不能用于本次生成，请重新选择。",
  shot_final_image_reference_unavailable: "本镜定稿图还不能作为视频参考。请先将它转为参考资产后再生成，系统不会忽略定稿图改按纯文字生成。",
  sample_mode_batch_only: "样片模式只能用于批量生成，请改用批量入口。",
  sample_mode_video_only: "样片模式只支持视频生成，请改为成片模式或选择视频项。",
  GENERATION_NOT_FOUND: "生成任务不存在或你没有访问权限。",
  GENERATION_NOTIFICATION_NOT_FOUND: "生成提醒不存在或你没有访问权限。",
  GENERATION_STATE_CONFLICT: "生成任务状态已经变化，请刷新后重试。",
  IDEMPOTENCY_CONFLICT: "这次生成请求与已有记录冲突，请刷新后重新提交。",
  GENERATION_BUDGET_EXCEEDED: "当前预算不足，未创建生成任务；请调整档位或补充余额后重试。",
  GENERATION_QUOTE_NOT_FOUND: "生成费用报价单不存在，请重新估价。",
  GENERATION_QUOTE_UNCONFIRMED: "请先确认生成费用报价，再提交生成任务。",
  GENERATION_QUOTE_EXPIRED: "生成费用报价已过期，请重新估价。",
  GENERATION_QUOTE_CONFLICT: "生成费用报价已经变化，请重新估价并确认。",
  GENERATION_QUOTE_SOURCE_MISMATCH: "这张报价不能在当前入口使用，请从当前页面重新估价。",
  GENERATION_QUOTE_CONTEXT_MISMATCH: "这张报价与当前项目或分镜不一致，请重新估价。",
  GENERATION_QUOTE_INVALID_SNAPSHOT: "生成费用报价信息不完整或已经变化，请重新估价。",
  GENERATION_BATCH_AUTHORIZATION_NOT_FOUND: "批量生成授权不存在或你没有访问权限。",
  GENERATION_CAPABILITY_UNAVAILABLE: "所选生成档位暂时不可用，请重新选择或稍后再试。",
  PROVIDER_COMPANY_ACCOUNT_NOT_ENABLED: "该供应商未开通公司账户",
  quote_stale: "生成单价或费用已经变化，请重新估价并确认。",
  PROVIDER_REJECTED: "生成服务拒绝了本次请求，请调整提示词或参考素材后重试。",
  PROVIDER_TASK_FAILED: "生成服务未能完成本次任务，请稍后重试。",
  SUBMISSION_OUTCOME_UNKNOWN: "生成请求结果暂时无法确认，请稍后查看任务状态，避免重复提交。",
};

const alwaysProjectGenerationMessage = new Set<GenerationErrorCode>([
  "GENERATION_CAPABILITY_UNAVAILABLE",
  "PROVIDER_REJECTED",
  "PROVIDER_TASK_FAILED",
  "SUBMISSION_OUTCOME_UNKNOWN",
]);

function publicGenerationErrorMessage(code: GenerationErrorCode, message: string): string {
  const fallback = generationErrorFallbacks[code];
  if (alwaysProjectGenerationMessage.has(code)) return fallback;

  const projected = publicStoredMessage(message, fallback)
    .replace(/\bSeedance\b/giu, "生成服务")
    .replace(/\bCreateAsset\b/giu, "素材登记")
    .replace(/asset:\/\/[^\s，。；]*/giu, "已登记素材")
    .replace(/\bsupplement_prompt\b/giu, "补充提示词")
    .replace(/\bprompt\b/giu, "提示词")
    .replace(/\bdurationSeconds\b/gu, "时长");
  if (containsInternalGenerationMarker(projected)) {
    return fallback;
  }
  return projected;
}

function containsInternalGenerationMarker(message: string): boolean {
  return /(?:https?:\/\/|[a-z][a-z0-9]*_[a-z0-9_.]*|ARK|MINIMAX|SEEDANCE|SEED[_.-]?AUDIO|OPENSPEECH|CREATEASSET|PROVIDER|API[_.-]?(?:KEY|HOST)|ENDPOINT|TOKEN|APP[_.-]?ID|MODEL|BASE[_.-]?RESP|STATUS[_.-]?CODE)/iu
    .test(message);
}

export type ProviderFailureOutcome = "rejected" | "unknown" | "query_failed";
export type ProviderOperation = "submit" | "query" | "submit_image" | "submit_video" | "submit_audio" | "query_video" | "query_audio";

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly operation: ProviderOperation,
    readonly outcome: ProviderFailureOutcome,
    readonly retryable: boolean,
    readonly providerCode?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/**
 * A worker may finish an external operation after its short task lease was
 * reclaimed. Its late database writes must be ignored rather than overwrite
 * the newer worker's state or terminal outcome.
 */
export class GenerationAttemptLeaseLostError extends Error {
  constructor(readonly attemptId: string) {
    super("Generation attempt lease is no longer owned by this worker");
    this.name = "GenerationAttemptLeaseLostError";
  }
}

export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  return error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
}
