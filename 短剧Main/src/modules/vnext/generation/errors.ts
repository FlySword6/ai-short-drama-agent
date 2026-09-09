import { AppError } from "../../../shared/errors.js";

export type VnextGenerationErrorCode =
  | "VNEXT_GENERATION_NOT_FOUND"
  | "VNEXT_GENERATION_TASK_CONFLICT"
  | "VNEXT_GENERATION_CAPABILITY_UNAVAILABLE"
  | "VNEXT_GENERATION_PROVIDER_NOT_CONFIGURED"
  | "VNEXT_GENERATION_ATTEMPT_LEASE_LOST"
  | "VNEXT_GENERATION_ALREADY_TERMINAL"
  | "VNEXT_GENERATION_IDEMPOTENCY_CONFLICT";

export class VnextGenerationError extends AppError {
  constructor(
    override readonly code: VnextGenerationErrorCode,
    message: string,
    override readonly statusCode: number,
    override readonly retryable = false,
  ) {
    super(statusCode, code, message, retryable);
    this.name = "VnextGenerationError";
  }
}

export class VnextAttemptLeaseLostError extends VnextGenerationError {
  constructor(attemptId: string) {
    super(
      "VNEXT_GENERATION_ATTEMPT_LEASE_LOST",
      `Worker lease for attempt ${attemptId} was lost; another worker may have taken over`,
      409,
      false,
    );
  }
}

export class VnextProviderRequestError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly outcome: "rejected" | "unknown" | "query_failed",
    readonly retryable: boolean,
    readonly providerCode?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "VnextProviderRequestError";
  }
}
