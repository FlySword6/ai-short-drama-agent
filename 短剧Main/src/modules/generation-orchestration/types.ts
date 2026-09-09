import type { GenerationPricingRule } from "../generation/cost.js";
import type {
  GenerationMediaKind,
  GenerationParameters,
  GenerationQuoteView,
  GenerationReferenceSnapshot,
  GenerationView,
  ProviderGenerationRequest,
} from "../generation/types.js";

export type GenerationOrchestrationMode = "mock" | "real" | "disabled";
export type GenerationOperationType = "generate" | "edit";
export type GenerationInputMode =
  | "text_to_image"
  | "image_to_image"
  | "text_to_video"
  | "image_to_video"
  | "video_to_video"
  | "text_to_audio";

export interface SelectedGenerationAsset {
  assetEntityId: string;
  mediaId: string;
  mediaKind: GenerationMediaKind;
}

export interface GenerationTurnContext {
  projectId: string;
  episodeId?: string;
  sceneId?: string;
  shotId?: string;
  selectedAsset?: SelectedGenerationAsset;
  referenceMediaIds: string[];
}

export interface GenerationIntentOperation {
  decision: "operation";
  operationType: GenerationOperationType;
  mediaKind: GenerationMediaKind;
  prompt: string;
  requestedTierId?: string;
  requestedVoiceGender?: "male" | "female";
  requestedParameters: GenerationParameters;
}

export interface GenerationIntentClarification {
  decision: "clarification";
  code:
    | "media_kind_required"
    | "edit_target_required"
    | "edit_target_mismatch"
    | "audio_edit_not_supported"
    | "trusted_script_required"
    | "registered_male_speaker_required"
    | "registered_female_speaker_required"
    | "tier_not_priced"
    | "request_ambiguous";
  question: string;
  choices?: Array<{ value: string; label: string }>;
}

export type GenerationIntentDecision =
  | GenerationIntentOperation
  | GenerationIntentClarification;

export interface GenerationIntentInterpreterInput {
  message: string;
  context: GenerationTurnContext;
  tiers: GenerationOrchestrationTier[];
  actorId: string;
}

export interface GenerationIntentInterpreter {
  interpret(input: GenerationIntentInterpreterInput): Promise<GenerationIntentDecision>;
}

export interface GenerationOrchestrationTier {
  tierId: string;
  mediaKind: GenerationMediaKind;
  providerAccount: string;
  providerLabel: string;
  modelLabel: string;
  displayName: string;
  isDefault: boolean;
  model: string;
  quantity: number;
  parameters: GenerationParameters;
  pricingRule: GenerationPricingRule;
}

export interface GenerationParameterControl {
  key: string;
  label: string;
  value: string | number | boolean | null;
  defaultValue: string | number | boolean | null;
  availability:
    | "adjustable"
    | "fixed_by_tier"
    | "frozen_context"
    | "not_priced"
    | "not_supported";
  requiresRequote: boolean;
  options?: Array<string | number | boolean>;
  range?: { min: number; max: number; step?: number };
  note?: string;
}

export interface GenerationParameterGroup {
  key: "visual" | "motion" | "audio" | "cost";
  label: string;
  controls: GenerationParameterControl[];
}

export interface GenerationOperationTarget {
  placement: "attach_to_shot" | "project_asset" | "replace_asset_variant";
  assetEntityId?: string;
  shotId?: string;
}

export interface GenerationOperationQuote {
  mode: "mock" | "real";
  generationQuoteId: string | null;
  estimatedCostFen: number;
  currency: "CNY";
  billingUnit: string;
  billableUnits: number;
  expiresAt: Date | null;
  notice: string;
}

export interface StoredGenerationOperation {
  schemaVersion: "v0.4.0";
  executionMode: "mock" | "real";
  operationType: GenerationOperationType;
  inputMode: GenerationInputMode;
  mediaKind: GenerationMediaKind;
  prompt: string;
  context: GenerationTurnContext;
  target: GenerationOperationTarget;
  referenceMediaIds: string[];
  referenceMedia: Array<{
    mediaId: string;
    kind: GenerationMediaKind;
    role?: string;
  }>;
  selectedMediaId?: string;
  tier: {
    tierId: string;
    displayName: string;
    providerLabel: string;
    modelLabel: string;
  };
  defaults: GenerationParameters;
  parameterGroups: GenerationParameterGroup[];
  quote: GenerationOperationQuote;
  createdAt: Date;
}

export interface GenerationOperationCard {
  operationId: string;
  operationType: GenerationOperationType;
  inputMode: GenerationInputMode;
  mediaKind: GenerationMediaKind;
  prompt: string;
  context: {
    projectId: string;
    episodeId?: string;
    sceneId?: string;
    shotId?: string;
  };
  target: GenerationOperationTarget;
  references: {
    selectedMediaId?: string;
    mediaIds: string[];
  };
  tier: StoredGenerationOperation["tier"];
  defaults: GenerationParameters;
  parameterGroups: GenerationParameterGroup[];
  quote: GenerationOperationQuote;
  requote: {
    method: "POST";
    endpoint: string;
    label: "重新报价";
  };
  confirmation: {
    required: true;
    method: "POST";
    endpoint: string;
    label: "确认并生成";
  };
}

export interface GenerationClarificationTurn {
  turnId: string;
  status: "clarification_required";
  assistantMessage: string;
  clarification: Omit<GenerationIntentClarification, "decision">;
}

export interface GenerationConfirmationTurn {
  turnId: string;
  status: "confirmation_required";
  assistantMessage: string;
  operationCard: GenerationOperationCard;
}

export type GenerationTurnResult =
  | GenerationClarificationTurn
  | GenerationConfirmationTurn;

export interface GenerationOperationReceipt {
  operationId: string;
  status: "queued" | "succeeded";
  executionMode: "mock" | "real";
  generationRequestId: string | null;
  attemptId: string;
  target: GenerationOperationTarget;
  artifact: {
    mediaKind: GenerationMediaKind;
    storageState: "simulated" | "persisted" | "pending";
    storageUrl: string | null;
  };
  ledger: {
    estimatedCostFen: number;
    chargedCostFen: number | null;
    pointsSpent: number | null;
    currency: "CNY";
  };
  timeline: Array<{
    state: "accepted" | "running" | "succeeded";
    offsetMs: number;
  }>;
  message: string;
}

export interface GenerationOrchestrationSession {
  id: string;
  userId: string;
  projectId: string | null;
  shotId: string | null;
}

export interface GenerationOrchestrationStore {
  getSession(actorId: string, sessionId: string): Promise<GenerationOrchestrationSession>;
  appendUserTurn(sessionId: string, content: string): Promise<void>;
  saveClarification(
    sessionId: string,
    clarification: GenerationIntentClarification,
  ): Promise<string>;
  saveOperation(sessionId: string, operation: StoredGenerationOperation): Promise<string>;
  getOperation(
    actorId: string,
    sessionId: string,
    operationId: string,
  ): Promise<StoredGenerationOperation>;
  findReceipt(
    actorId: string,
    sessionId: string,
    operationId: string,
  ): Promise<GenerationOperationReceipt | null>;
  saveReceipt(
    sessionId: string,
    receipt: GenerationOperationReceipt,
  ): Promise<GenerationOperationReceipt>;
}

export interface TrustedSelectedAudioSource {
  prompt: string;
  parameters: GenerationParameters;
}

export interface AuthorizedGenerationTurnContext {
  context: GenerationTurnContext;
  selectedAudioSource?: TrustedSelectedAudioSource;
}

/**
 * Shared mock/real authorization boundary. It verifies creative access,
 * project hierarchy and selected-asset identity before interpretation,
 * quoting or confirmation.
 */
export interface GenerationTurnContextAuthorizer {
  authorize(
    actorId: string,
    context: GenerationTurnContext,
    mediaKind?: GenerationMediaKind,
  ): Promise<AuthorizedGenerationTurnContext>;
}

export interface GenerationVoiceResolver {
  resolveByGender(
    gender: "male" | "female",
  ): Promise<{ speakerId: string; displayName: string } | null>;
  resolveSpeakerId(speakerId: string): Promise<string | null>;
  listSpeakerIds(): Promise<string[]>;
}

export interface PrepareGenerationQuoteInput {
  actorId: string;
  sessionId: string;
  context: GenerationTurnContext;
  operationType: GenerationOperationType;
  mediaKind: GenerationMediaKind;
  prompt: string;
  tier: GenerationOrchestrationTier;
  parameters: GenerationParameters;
  referenceMediaIds: string[];
  selectedAsset?: SelectedGenerationAsset;
}

export interface PreparedGenerationQuote {
  quote: GenerationOperationQuote;
  referenceSnapshots: GenerationReferenceSnapshot[];
  selectedAsset?: SelectedGenerationAsset;
}

export interface GenerationQuoteAdapter {
  readonly mode: "mock" | "real";
  prepare(input: PrepareGenerationQuoteInput): Promise<PreparedGenerationQuote>;
}

export interface ExecuteGenerationOperationInput {
  actorId: string;
  session: GenerationOrchestrationSession;
  operationId: string;
  operation: StoredGenerationOperation;
}

export interface GenerationOperationExecutor {
  readonly mode: "mock" | "real";
  execute(input: ExecuteGenerationOperationInput): Promise<GenerationOperationReceipt>;
}

export interface GenerationTierCatalog {
  list(mediaKind: GenerationMediaKind): Promise<GenerationOrchestrationTier[]>;
}

export interface GenerationReferenceResolver {
  resolve(
    actorId: string,
    mediaKind: GenerationMediaKind,
    mediaIds: string[],
  ): Promise<GenerationReferenceSnapshot[]>;
  resolveSelectedAsset(
    selectedAsset: SelectedGenerationAsset,
    resolvedReference: GenerationReferenceSnapshot,
  ): Promise<SelectedGenerationAsset>;
}

export interface MockProviderReplica {
  createRequest(operation: StoredGenerationOperation): ProviderGenerationRequest;
  execute(request: ProviderGenerationRequest): Promise<{
    attemptId: string;
    artifactKind: GenerationMediaKind;
    timeline: GenerationOperationReceipt["timeline"];
  }>;
}

export type RealGenerationSubmit = (
  actorId: string,
  session: GenerationOrchestrationSession,
  quoteId: string,
  authorizedProjectId: string,
) => Promise<GenerationView>;

export type RealQuoteCreator = (
  input: PrepareGenerationQuoteInput,
  references: GenerationReferenceSnapshot[],
) => Promise<GenerationQuoteView>;
