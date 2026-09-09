import type { FormalShotPlanFacts, ShotPlanDraft } from "../shot-plan/types.js";

export type ScriptSourceKind = "paste" | "upload";
export type ScriptParseStatus = "queued" | "running" | "draft" | "partial_failure" | "failed" | "confirmed";
export type ScriptParseStage = "queued" | "reading" | "structuring" | "validating" | "ready" | "failed" | "confirmed";
export type ScriptParseErrorCode =
  | "script_partial_failure"
  | "script_model_unavailable"
  | "script_parse_timeout"
  | "script_schema_validation_failed";

export interface ScriptParseError {
  code: ScriptParseErrorCode;
  message: string;
  retryable: boolean;
}

export interface ScriptParseRun {
  id: string;
  projectId: string;
  sourceId: string;
  status: ScriptParseStatus;
  progress: number;
  currentStage: ScriptParseStage;
  draft: ShotPlanDraft | null;
  error: ScriptParseError | null;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
}

export interface ScriptWorkbenchState {
  run: ScriptParseRun | null;
  formalFacts: FormalShotPlanFacts | null;
}

export interface ScriptDraftProviderResult {
  draft: unknown;
  partialFailure?: string;
}

export interface ScriptDraftProviderInput {
  scriptContent: string;
  actorId: string;
  runId: string;
}

export interface ScriptDraftProvider {
  analyze(input: ScriptDraftProviderInput): Promise<ScriptDraftProviderResult>;
}

export class ScriptProviderUnavailableError extends Error {
  constructor(message = "Script draft model is unavailable") {
    super(message);
    this.name = "ScriptProviderUnavailableError";
  }
}

export class ScriptProviderTimeoutError extends Error {
  constructor(message = "Script draft model timed out") {
    super(message);
    this.name = "ScriptProviderTimeoutError";
  }
}

export class ScriptProviderPartialError extends Error {
  constructor(
    message: string,
    readonly draft: unknown,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ScriptProviderPartialError";
  }
}
