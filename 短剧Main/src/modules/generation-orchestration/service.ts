import { COMPANY_PROVIDER_NOT_ENABLED_MESSAGE } from "../../shared/companyProviderPolicy.js";
import { AppError, ConflictError } from "../../shared/errors.js";
import { normalizeV01Parameters, V01GenerationContractError } from "../generation/v01Contract.js";
import type {
  GenerationMediaKind,
  GenerationParameters,
} from "../generation/types.js";
import { generationParameterGroups } from "./parameterGroups.js";
import type {
  GenerationConfirmationTurn,
  GenerationInputMode,
  GenerationIntentClarification,
  GenerationIntentOperation,
  GenerationOperationCard,
  GenerationOperationExecutor,
  GenerationOperationReceipt,
  GenerationOrchestrationMode,
  GenerationOrchestrationSession,
  GenerationOrchestrationStore,
  GenerationQuoteAdapter,
  GenerationTierCatalog,
  GenerationTurnContext,
  GenerationTurnResult,
  GenerationIntentInterpreter,
  GenerationOrchestrationTier,
  GenerationTurnContextAuthorizer,
  GenerationVoiceResolver,
  TrustedSelectedAudioSource,
  StoredGenerationOperation,
} from "./types.js";

export interface GenerationOrchestrationServiceOptions {
  mode: GenerationOrchestrationMode;
  store: GenerationOrchestrationStore;
  interpreter: GenerationIntentInterpreter;
  catalog: GenerationTierCatalog;
  quoteAdapters: {
    mock: GenerationQuoteAdapter;
    real: GenerationQuoteAdapter;
  };
  executors: {
    mock: GenerationOperationExecutor;
    real: GenerationOperationExecutor;
  };
  contextAuthorizer: GenerationTurnContextAuthorizer;
  voiceResolver: GenerationVoiceResolver;
  now?: () => Date;
}

export class GenerationOrchestrationService {
  private readonly now: () => Date;
  private readonly pendingConfirmations = new Map<string, Promise<GenerationOperationReceipt>>();

  constructor(private readonly options: GenerationOrchestrationServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async createTurn(input: {
    actorId: string;
    sessionId: string;
    message: string;
    context: GenerationTurnContext;
  }): Promise<GenerationTurnResult> {
    this.assertEnabled();
    const session = await this.options.store.getSession(input.actorId, input.sessionId);
    const normalizedContext = normalizeContext(session, input.context);
    const authorization = await this.options.contextAuthorizer.authorize(
      input.actorId,
      normalizedContext,
    );
    const context = authorization.context;
    await this.options.store.appendUserTurn(session.id, input.message);

    const allTiers = (await Promise.all([
      this.options.catalog.list("image"),
      this.options.catalog.list("video"),
      this.options.catalog.list("audio"),
    ])).flat();
    const decision = await this.options.interpreter.interpret({
      message: input.message,
      context,
      tiers: allTiers,
      actorId: input.actorId,
    });
    if (decision.decision === "clarification") {
      return this.clarification(session.id, decision);
    }

    const contextBound = bindSelectedAudioRegeneration(decision, input.message, context);
    const enforced = enforceOperationContext(contextBound, context);
    if (enforced.decision === "clarification") {
      return this.clarification(session.id, enforced);
    }
    const audioPrepared = await prepareAudioOperation(
      enforced,
      authorization.selectedAudioSource,
      this.options.voiceResolver,
    );
    if (audioPrepared.decision === "clarification") {
      return this.clarification(session.id, audioPrepared);
    }
    return this.prepareOperationTurn({
      actorId: input.actorId,
      session,
      context,
      operation: audioPrepared,
      tiers: allTiers.filter((tier) => tier.mediaKind === audioPrepared.mediaKind),
    });
  }

  async requote(input: {
    actorId: string;
    sessionId: string;
    operationId: string;
    tierId?: string;
    requestedParameters: GenerationParameters;
  }): Promise<GenerationTurnResult> {
    this.assertEnabled();
    const existing = await this.options.store.findReceipt(
      input.actorId,
      input.sessionId,
      input.operationId,
    );
    if (existing) {
      throw new AppError(
        409,
        "generation_operation_already_confirmed",
        "这张操作卡已经确认执行，不能再改参数。请重新发起一次生成。",
      );
    }
    const session = await this.options.store.getSession(input.actorId, input.sessionId);
    const previous = await this.options.store.getOperation(
      input.actorId,
      input.sessionId,
      input.operationId,
    );
    const authorization = await this.options.contextAuthorizer.authorize(
      input.actorId,
      {
        ...previous.context,
        referenceMediaIds: previous.referenceMediaIds,
      },
      previous.mediaKind,
    );
    if (previous.executionMode === "real" && this.options.mode !== "real") {
      throw new AppError(
        403,
        "real_orchestration_disabled",
        "真实生成当前未开启，这张报价不会被改写或提交。请重新准备模拟操作。",
      );
    }
    const operation: GenerationIntentOperation = {
      decision: "operation",
      operationType: previous.operationType,
      mediaKind: previous.mediaKind,
      prompt: previous.prompt,
      requestedTierId: input.tierId ?? previous.tier.tierId,
      requestedParameters: requoteParameters(previous, input.tierId, input.requestedParameters),
    };
    const tiers = await this.options.catalog.list(previous.mediaKind);
    return this.prepareOperationTurn({
      actorId: input.actorId,
      session,
      context: authorization.context,
      operation,
      tiers,
      executionMode: previous.executionMode,
      referenceMediaIds: previous.referenceMediaIds,
    });
  }

  async confirm(input: {
    actorId: string;
    sessionId: string;
    operationId: string;
  }): Promise<GenerationOperationReceipt> {
    this.assertEnabled();
    const key = `${input.actorId}:${input.sessionId}:${input.operationId}`;
    const pending = this.pendingConfirmations.get(key);
    if (pending) return pending;
    const running = this.confirmOnce(input);
    this.pendingConfirmations.set(key, running);
    try {
      return await running;
    } finally {
      if (this.pendingConfirmations.get(key) === running) {
        this.pendingConfirmations.delete(key);
      }
    }
  }

  private async confirmOnce(input: {
    actorId: string;
    sessionId: string;
    operationId: string;
  }): Promise<GenerationOperationReceipt> {
    const existing = await this.options.store.findReceipt(
      input.actorId,
      input.sessionId,
      input.operationId,
    );
    if (existing) return existing;
    const session = await this.options.store.getSession(input.actorId, input.sessionId);
    const operation = await this.options.store.getOperation(
      input.actorId,
      input.sessionId,
      input.operationId,
    );
    await this.options.contextAuthorizer.authorize(
      input.actorId,
      {
        ...operation.context,
        referenceMediaIds: operation.referenceMediaIds,
      },
      operation.mediaKind,
    );
    if (operation.executionMode === "real" && this.options.mode !== "real") {
      throw new AppError(
        403,
        "real_orchestration_disabled",
        "真实生成当前未开启，这张报价不会被提交。请重新准备模拟操作。",
      );
    }
    // A mock operation remains mock even if the deployment later switches to
    // real. This is the key fence preventing a harmless preview from becoming
    // a paid task after configuration changes.
    const executor = operation.executionMode === "mock"
      ? this.options.executors.mock
      : this.options.executors.real;
    const receipt = await executor.execute({
      actorId: input.actorId,
      session,
      operationId: input.operationId,
      operation,
    });
    return this.options.store.saveReceipt(session.id, receipt);
  }

  private async clarification(
    sessionId: string,
    clarification: GenerationIntentClarification,
  ): Promise<GenerationTurnResult> {
    const turnId = await this.options.store.saveClarification(sessionId, clarification);
    return {
      turnId,
      status: "clarification_required",
      assistantMessage: clarification.question,
      clarification: {
        code: clarification.code,
        question: clarification.question,
        ...(clarification.choices ? { choices: clarification.choices } : {}),
      },
    };
  }

  private async prepareOperationTurn(input: {
    actorId: string;
    session: GenerationOrchestrationSession;
    context: GenerationTurnContext;
    operation: GenerationIntentOperation;
    tiers: GenerationOrchestrationTier[];
    executionMode?: "mock" | "real";
    referenceMediaIds?: string[];
  }): Promise<GenerationTurnResult> {
    const speakerValidated = await validateRegisteredSpeaker(
      input.operation,
      this.options.voiceResolver,
    );
    if (speakerValidated.decision === "clarification") {
      return this.clarification(input.session.id, speakerValidated);
    }
    const operation = speakerValidated;
    const selection = selectTier(operation, input.tiers);
    if ("decision" in selection) {
      return this.clarification(input.session.id, selection);
    }
    const referenceMediaIds = input.referenceMediaIds
      ? [...input.referenceMediaIds]
      : operationReferenceMediaIds(operation, input.context);
    const selectedAsset = input.context.selectedAsset
      && (
        operation.operationType === "edit"
        || referenceMediaIds.includes(input.context.selectedAsset.mediaId)
      )
      ? input.context.selectedAsset
      : undefined;
    const executionMode = input.executionMode
      ?? (this.options.mode === "real" ? "real" : "mock");
    const adapter = executionMode === "real"
      ? this.options.quoteAdapters.real
      : this.options.quoteAdapters.mock;
    let prepared;
    try {
      prepared = await adapter.prepare({
        actorId: input.actorId,
        sessionId: input.session.id,
        context: input.context,
        operationType: operation.operationType,
        mediaKind: operation.mediaKind,
        prompt: operation.prompt,
        tier: selection.tier,
        parameters: selection.parameters,
        referenceMediaIds,
        ...(selectedAsset ? { selectedAsset } : {}),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "tier_not_priced") {
        return this.clarification(input.session.id, tierClarification(input.tiers));
      }
      throw error;
    }

    const target = operationTarget(
      operation,
      input.context,
      prepared.selectedAsset,
    );
    const speakerIds = operation.mediaKind === "audio"
      ? await this.options.voiceResolver.listSpeakerIds()
      : [];
    const stored: StoredGenerationOperation = {
      schemaVersion: "v0.4.0",
      executionMode: adapter.mode,
      operationType: operation.operationType,
      inputMode: inputMode(operation, input.context),
      mediaKind: operation.mediaKind,
      prompt: operation.prompt,
      context: input.context,
      target,
      referenceMediaIds,
      referenceMedia: referenceMediaIds.map((mediaId, index) => {
        const snapshot = prepared.referenceSnapshots[index];
        return {
          mediaId,
          kind: snapshot?.kind
            ?? inferredReferenceKind(operation, input.context, mediaId),
          ...(snapshot?.role ? { role: snapshot.role } : {}),
        };
      }),
      ...(prepared.selectedAsset
        ? { selectedMediaId: prepared.selectedAsset.mediaId }
        : {}),
      tier: {
        tierId: selection.tier.tierId,
        displayName: selection.tier.displayName,
        providerLabel: selection.tier.providerLabel,
        modelLabel: selection.tier.modelLabel,
      },
      defaults: selection.parameters,
      parameterGroups: generationParameterGroups(
        selection.tier,
        selection.parameters,
        prepared.quote,
        prepared.referenceSnapshots,
        speakerIds,
      ),
      quote: prepared.quote,
      createdAt: this.now(),
    };
    const operationId = await this.options.store.saveOperation(input.session.id, stored);
    return {
      turnId: operationId,
      status: "confirmation_required",
      assistantMessage: operationSummary(stored),
      operationCard: operationCard(input.session.id, operationId, stored),
    };
  }

  private assertEnabled(): void {
    if (this.options.mode === "disabled") {
      throw new AppError(
        503,
        "generation_orchestration_disabled",
        "自然语言生成暂未开启，不会创建报价或任务。",
      );
    }
  }
}

function normalizeContext(
  session: GenerationOrchestrationSession,
  context: GenerationTurnContext,
): GenerationTurnContext {
  if (!session.projectId) {
    throw new AppError(422, "assistant_project_required", "请先在项目内打开 AI 助手，再准备生成操作。");
  }
  if (context.projectId !== session.projectId) {
    throw new ConflictError("当前项目与助手会话不一致，请刷新后重试", "assistant_context_mismatch");
  }
  if (session.shotId && context.shotId && context.shotId !== session.shotId) {
    throw new ConflictError("当前镜头与助手会话不一致，请刷新后重试", "assistant_context_mismatch");
  }
  return {
    projectId: context.projectId,
    ...(context.episodeId ? { episodeId: context.episodeId } : {}),
    ...(context.sceneId ? { sceneId: context.sceneId } : {}),
    ...(context.shotId ?? session.shotId
      ? { shotId: context.shotId ?? session.shotId! }
      : {}),
    ...(context.selectedAsset ? { selectedAsset: { ...context.selectedAsset } } : {}),
    referenceMediaIds: [...new Set(context.referenceMediaIds)],
  };
}

function enforceOperationContext(
  operation: GenerationIntentOperation,
  context: GenerationTurnContext,
): GenerationIntentOperation | GenerationIntentClarification {
  if (operation.operationType === "edit") {
    if (!context.selectedAsset) {
      return {
        decision: "clarification",
        code: "edit_target_required",
        question: `请先选中要修改的${mediaLabel(operation.mediaKind)}。`,
      };
    }
    if (context.selectedAsset.mediaKind !== operation.mediaKind) {
      return {
        decision: "clarification",
        code: "edit_target_mismatch",
        question: `当前选中的是${mediaLabel(context.selectedAsset.mediaKind)}，请改选要修改的${mediaLabel(operation.mediaKind)}。`,
      };
    }
  }
  return operation;
}

function bindSelectedAudioRegeneration(
  operation: GenerationIntentOperation,
  message: string,
  context: GenerationTurnContext,
): GenerationIntentOperation {
  if (
    context.selectedAsset?.mediaKind !== "audio"
    || !/再生成|重新生成|生成一遍/u.test(message)
    || !/配音|音频|声音|音色|男声|女声/u.test(message)
  ) {
    return operation;
  }
  const explicitGender = requestedVoiceGenderFromText(message);
  return {
    ...operation,
    operationType: "edit",
    mediaKind: "audio",
    ...(explicitGender
      ? { requestedVoiceGender: explicitGender }
      : operation.requestedVoiceGender
        ? { requestedVoiceGender: operation.requestedVoiceGender }
        : {}),
  };
}

function requestedVoiceGenderFromText(
  message: string,
): "male" | "female" | undefined {
  const normalized = message.normalize("NFKC");
  if (/男声|男性音色|男音/u.test(normalized)) return "male";
  if (/女声|女性音色|女音/u.test(normalized)) return "female";
  return undefined;
}

async function prepareAudioOperation(
  operation: GenerationIntentOperation,
  selectedSource: TrustedSelectedAudioSource | undefined,
  voices: GenerationVoiceResolver,
): Promise<GenerationIntentOperation | GenerationIntentClarification> {
  if (operation.mediaKind !== "audio") return operation;

  let prompt = operation.prompt;
  let parameters = { ...operation.requestedParameters };
  if (operation.operationType === "edit") {
    if (!selectedSource?.prompt.trim()) {
      return {
        decision: "clarification",
        code: "trusted_script_required",
        question: "找不到这段配音可追溯的原台词。请把要朗读的文字补充到指令里，再重新准备。",
      };
    }
    if (
      !Number.isSafeInteger(selectedSource.parameters.originalDurationSeconds)
      || Number(selectedSource.parameters.originalDurationSeconds) < 1
    ) {
      return {
        decision: "clarification",
        code: "tier_not_priced",
        question: "原配音缺少可追溯的计费时长，当前不能安全报价。请先修复媒体元数据后再生成。",
      };
    }
    prompt = selectedSource.prompt.trim();
    parameters = {
      ...audioCreativeParameters(selectedSource.parameters),
      ...parameters,
      ...trustedAudioBillingParameters(selectedSource.parameters),
      ...(!operation.requestedVoiceGender
        && typeof selectedSource.parameters.speakerId === "string"
        && selectedSource.parameters.speakerId.trim()
        ? { speakerId: selectedSource.parameters.speakerId.trim() }
        : {}),
    };
  }

  if (operation.requestedVoiceGender) {
    const voice = await voices.resolveByGender(operation.requestedVoiceGender);
    if (!voice) {
      const male = operation.requestedVoiceGender === "male";
      return {
        decision: "clarification",
        code: male
          ? "registered_male_speaker_required"
          : "registered_female_speaker_required",
        question: male
          ? "当前没有已登记且启用的男声音色，请先配置公司音色后再生成。"
          : "当前没有已登记且启用的女声音色，请先配置公司音色后再生成。",
      };
    }
    parameters.speakerId = voice.speakerId;
  } else if (
    operation.operationType === "edit"
    && typeof parameters.speakerId !== "string"
  ) {
    return {
      decision: "clarification",
      code: "request_ambiguous",
      question: "原配音没有可追溯的音色。请选择男声或女声后再生成。",
      choices: [
        { value: "male", label: "男声" },
        { value: "female", label: "女声" },
      ],
    };
  }

  return {
    ...operation,
    prompt,
    requestedParameters: parameters,
  };
}

function trustedAudioBillingParameters(
  parameters: GenerationParameters,
): GenerationParameters {
  return {
    originalDurationSeconds: Number(parameters.originalDurationSeconds),
    ...(parameters.format === "mp3"
      || parameters.format === "wav"
      || parameters.format === "pcm"
      ? { format: parameters.format }
      : {}),
    ...(typeof parameters.sampleRate === "number"
      ? { sampleRate: parameters.sampleRate }
      : {}),
  };
}

function audioCreativeParameters(parameters: GenerationParameters): GenerationParameters {
  return {
    ...(typeof parameters.speakerId === "string" && parameters.speakerId.trim()
      ? { speakerId: parameters.speakerId.trim() }
      : {}),
    ...(typeof parameters.speechRate === "number"
      ? { speechRate: parameters.speechRate }
      : {}),
    ...(typeof parameters.loudnessRate === "number"
      ? { loudnessRate: parameters.loudnessRate }
      : {}),
    ...(typeof parameters.pitchRate === "number"
      ? { pitchRate: parameters.pitchRate }
      : {}),
  };
}

async function validateRegisteredSpeaker(
  operation: GenerationIntentOperation,
  voices: GenerationVoiceResolver,
): Promise<GenerationIntentOperation | GenerationIntentClarification> {
  if (
    operation.mediaKind !== "audio"
    || typeof operation.requestedParameters.speakerId !== "string"
  ) {
    return operation;
  }
  const speakerId = await voices.resolveSpeakerId(operation.requestedParameters.speakerId);
  if (!speakerId) {
    return {
      decision: "clarification",
      code: "request_ambiguous",
      question: "所选音色未登记或已停用，请从公司音色列表重新选择。",
    };
  }
  return {
    ...operation,
    requestedParameters: {
      ...operation.requestedParameters,
      speakerId,
    },
  };
}

function requoteParameters(
  previous: StoredGenerationOperation,
  requestedTierId: string | undefined,
  requested: GenerationParameters,
): GenerationParameters {
  const switchingTier = requestedTierId !== undefined
    && requestedTierId !== previous.tier.tierId;
  return {
    ...(switchingTier
      ? audioCreativeParameters(previous.defaults)
      : previous.defaults),
    ...requested,
  };
}

function selectTier(
  operation: GenerationIntentOperation,
  tiers: GenerationOrchestrationTier[],
): { tier: GenerationOrchestrationTier; parameters: GenerationParameters }
  | GenerationIntentClarification {
  const candidates = tiers.flatMap((tier) => {
    if (operation.requestedTierId && tier.tierId !== operation.requestedTierId) return [];
    try {
      const parameters = normalizeV01Parameters({
        mediaKind: operation.mediaKind,
        model: tier.model,
        parameters: { ...tier.parameters, ...operation.requestedParameters },
        quantity: tier.quantity,
      });
      return fixedParametersMatch(operation.mediaKind, tier.parameters, parameters)
        ? [{ tier, parameters }]
        : [];
    } catch (error) {
      if (error instanceof V01GenerationContractError) return [];
      throw error;
    }
  });
  if (candidates.length === 0) return tierClarification(tiers);
  candidates.sort((left, right) => {
    if (left.tier.isDefault !== right.tier.isDefault) return left.tier.isDefault ? -1 : 1;
    const price = tierPriceScore(left.tier) - tierPriceScore(right.tier);
    return price || left.tier.tierId.localeCompare(right.tier.tierId);
  });
  return candidates[0]!;
}

function fixedParametersMatch(
  mediaKind: GenerationMediaKind,
  tier: GenerationParameters,
  candidate: GenerationParameters,
): boolean {
  const keys = mediaKind === "audio"
    ? ["originalDurationSeconds", "format", "sampleRate"]
    : Object.keys(tier);
  return keys.every((key) => scalarEqual(tier[key], candidate[key]));
}

function scalarEqual(left: unknown, right: unknown): boolean {
  return left === right;
}

function tierPriceScore(tier: GenerationOrchestrationTier): number {
  const duration = tier.mediaKind === "video"
    ? number(tier.parameters.durationSeconds, 1)
    : tier.mediaKind === "audio"
      ? number(tier.parameters.originalDurationSeconds, 1)
      : tier.quantity;
  return tier.pricingRule.unitPriceFen * duration;
}

function operationReferenceMediaIds(
  operation: GenerationIntentOperation,
  context: GenerationTurnContext,
): string[] {
  const ids = [...context.referenceMediaIds];
  const selected = context.selectedAsset;
  if (selected && (
    (operation.operationType === "edit" && operation.mediaKind !== "audio")
    || (operation.mediaKind === "video" && selected.mediaKind === "image")
  )) {
    ids.unshift(selected.mediaId);
  }
  return [...new Set(ids)];
}

function operationTarget(
  operation: GenerationIntentOperation,
  context: GenerationTurnContext,
  selectedAsset?: GenerationTurnContext["selectedAsset"],
): StoredGenerationOperation["target"] {
  if (operation.operationType === "edit" && selectedAsset) {
    return {
      placement: "replace_asset_variant",
      assetEntityId: selectedAsset.assetEntityId,
      ...(context.shotId ? { shotId: context.shotId } : {}),
    };
  }
  if (context.shotId) return { placement: "attach_to_shot", shotId: context.shotId };
  return { placement: "project_asset" };
}

function inputMode(
  operation: GenerationIntentOperation,
  context: GenerationTurnContext,
): GenerationInputMode {
  if (operation.mediaKind === "image") {
    return operation.operationType === "edit" ? "image_to_image" : "text_to_image";
  }
  if (operation.mediaKind === "audio") return "text_to_audio";
  if (operation.operationType === "edit") return "video_to_video";
  return context.selectedAsset?.mediaKind === "image" ? "image_to_video" : "text_to_video";
}

function inferredReferenceKind(
  operation: GenerationIntentOperation,
  context: GenerationTurnContext,
  mediaId: string,
): GenerationMediaKind {
  if (context.selectedAsset?.mediaId === mediaId) return context.selectedAsset.mediaKind;
  if (operation.mediaKind === "image") return "image";
  return "image";
}

function operationCard(
  sessionId: string,
  operationId: string,
  operation: StoredGenerationOperation,
): GenerationOperationCard {
  return {
    operationId,
    operationType: operation.operationType,
    inputMode: operation.inputMode,
    mediaKind: operation.mediaKind,
    prompt: operation.prompt,
    context: {
      projectId: operation.context.projectId,
      ...(operation.context.episodeId ? { episodeId: operation.context.episodeId } : {}),
      ...(operation.context.sceneId ? { sceneId: operation.context.sceneId } : {}),
      ...(operation.context.shotId ? { shotId: operation.context.shotId } : {}),
    },
    target: operation.target,
    references: {
      ...(operation.selectedMediaId
        ? { selectedMediaId: operation.selectedMediaId }
        : {}),
      mediaIds: [...operation.referenceMediaIds],
    },
    tier: operation.tier,
    defaults: publicGenerationParameters(operation.defaults),
    parameterGroups: operation.parameterGroups,
    quote: operation.quote,
    requote: {
      method: "POST",
      endpoint: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/operations/${operationId}/requote`,
      label: "重新报价",
    },
    confirmation: {
      required: true,
      method: "POST",
      endpoint: `/api/v1/agent/sessions/${sessionId}/generation-orchestration/operations/${operationId}/confirm`,
      label: "确认并生成",
    },
  };
}

function publicGenerationParameters(
  parameters: GenerationParameters,
): GenerationParameters {
  const allowed = [
    "size",
    "ratio",
    "durationSeconds",
    "resolution",
    "generateAudio",
    "sequentialImageGeneration",
    "originalDurationSeconds",
    "format",
    "sampleRate",
    "speechRate",
    "loudnessRate",
    "pitchRate",
    "speakerId",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => (
      parameters[key] === undefined ? [] : [[key, parameters[key]]]
    )),
  );
}

function operationSummary(operation: StoredGenerationOperation): string {
  const action = operation.operationType === "edit" ? "修改" : "生成";
  return `已按当前上下文准备${action}${mediaLabel(operation.mediaKind)}操作，请确认后执行。`;
}

function tierClarification(
  tiers: GenerationOrchestrationTier[],
): GenerationIntentClarification {
  return {
    decision: "clarification",
    code: "tier_not_priced",
    question: tiers.length === 0
      ? `${COMPANY_PROVIDER_NOT_ENABLED_MESSAGE}，当前没有可用且已核价的档位，暂时不能创建报价。`
      : "你要求的原生参数当前没有对应核价档位。请选择一个已核价档位后重新报价。",
    ...(tiers.length > 0
      ? {
          choices: tiers.slice(0, 8).map((tier) => ({
            value: tier.tierId,
            label: tier.displayName,
          })),
        }
      : {}),
  };
}

function mediaLabel(mediaKind: GenerationMediaKind): string {
  return mediaKind === "image" ? "图片" : mediaKind === "video" ? "视频" : "音频";
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export type {
  GenerationConfirmationTurn,
  GenerationOperationReceipt,
};
