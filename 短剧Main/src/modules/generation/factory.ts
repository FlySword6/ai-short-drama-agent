import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Database } from "../../db/client.js";
import { settings } from "../../config/env.js";
import { TosStorage } from "../../integrations/tosStorage.js";
import {
  COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
  isCompanyProviderAllowed,
  normalizeCompanyProviderAllowlist,
} from "../../shared/companyProviderPolicy.js";
import { AppError } from "../../shared/errors.js";
import { assertGenerationPilotCreditAccess } from "../account-credits/generationAccess.js";
import { GenerationError } from "./errors.js";
import { AigcMetadataLabeler } from "./aigcLabeler.js";
import { ArkGenerationProvider } from "./provider/arkGenerationProvider.js";
import {
  AsyncImageGatewayProvider,
  isApprovedAsyncImageGatewayBaseUrl,
} from "./provider/asyncImageGatewayProvider.js";
import {
  isApprovedOpenAiCompatibleBaseUrl,
  OpenAiCompatibleImageProvider,
} from "./provider/openAiCompatibleImageProvider.js";
import { OpenspeechTtsProvider, isApprovedOpenspeechTtsUrl } from "./provider/openspeechTtsProvider.js";
import { isApprovedSeedAudioUrl, SeedAudioProvider } from "./provider/seedAudioProvider.js";
import {
  HappyHorseGenerationProvider,
  isApprovedHappyHorseBaseUrl,
} from "./provider/happyhorseGenerationProvider.js";
import {
  ModelProviderRegistry,
  type GenerationProviderId,
} from "./provider/modelProviderRegistry.js";
import { PostgresGenerationRepository } from "./repository.js";
import { GenerationService } from "./service.js";
import type { GenerationServiceOptions } from "./service.js";
import type { NormalizedGenerationInput } from "./types.js";
import {
  NANOBANANA_2_MODEL,
  NANOBANANA_LITE_MODEL,
  SUCHUANG_GPT_IMAGE_2_MODEL,
} from "./v01Contract.js";

export function createGenerationRepository(db: Database): PostgresGenerationRepository {
  return new PostgresGenerationRepository(
    db,
    settings.generationWorkerPollIntervalMs,
    settings.allowPaidGeneration,
    requireGenerationRequestConfigured,
    undefined,
    (transaction, actorId) => assertGenerationPilotCreditAccess(transaction, actorId, {
      enabled: settings.generationPilotCreditGateEnabled,
    }),
  );
}

export function createGenerationService(
  repository: PostgresGenerationRepository,
  options: { costAlertLogger?: GenerationServiceOptions["costAlertLogger"] } = {},
): GenerationService {
  const tos = new TosStorage();
  return new GenerationService({
    repository,
    provider: createGenerationProviderRegistry(),
    storage: {
      uploadBytes: async (input) => tos.uploadBytes(input.content, input.storagePath, input.contentType),
    },
    aigcLabeler: new AigcMetadataLabeler(),
    budgetLimitFen: effectivePaidBudgetFen(),
    costAlertLogger: options.costAlertLogger,
  });
}

/**
 * The public capability list and the paid-task path share one fail-closed
 * registry. Product capability names are stable; actual provider model IDs
 * only enter here through deployment configuration.
 */
export interface GenerationProviderRegistryConfiguration {
  companyProviderAllowlist?: readonly string[];
  arkApiKey?: string;
  arkBaseUrl?: string;
  arkImageModel?: string;
  arkVideoModel?: string;
  /** Seedance 2.5 专用接入点 ep id；缺省时 2.5 能力保持 unavailable（fail-closed）。 */
  arkVideoModel25?: string;
  minimaxApiKey?: string;
  minimaxBaseUrl?: string;
  minimaxImageModels?: string;
  minimaxVideoModels?: string;
  minimaxAudioModels?: string;
  minimaxAudioVoiceId?: string;
  newapiGenerationEnabled?: boolean;
  newapiBaseUrl?: string;
  newapiApprovedBaseUrlSha256?: string;
  newapiApiKey?: string;
  newapiGptImageModels?: string;
  newapiGeminiImageModels?: string;
  suchuangGenerationEnabled?: boolean;
  suchuangBaseUrl?: string;
  suchuangApiKey?: string;
  /** Deployment-selected model ID; product code must never invent a TTS model ID. */
  openspeechTtsModel?: string;
  /** Verified openspeech TTS submit URL; absence keeps the audio capability unavailable. */
  openspeechTtsEndpoint?: string;
  /** 语音控制台 access token,与 appid 成对;鉴权头是 `Bearer;${token}`(分号)。 */
  openspeechTtsToken?: string;
  /** 语音控制台 appid。 */
  openspeechTtsAppId?: string;
  /** 控制台分配的 cluster;缺省由 provider 按官方文档使用 volcano_tts。 */
  openspeechTtsCluster?: string;
  /** Optional deployment-owned exact host allowlist; environment defaults to the official openspeech host only. */
  openspeechTtsAllowedHosts?: readonly string[];
  /** Seed Audio v3 single-header API key contract. Any v3 field opts out of legacy fallback. */
  seedAudioModel?: string;
  seedAudioEndpoint?: string;
  seedAudioApiKey?: string;
  /** 阿里云百炼 HappyHorse 参考生视频:三键缺一即 unconfigured(fail-closed)。 */
  happyhorseApiKey?: string;
  happyhorseBaseUrl?: string;
  happyhorseModel?: string;
}

export function createGenerationProviderRegistry(
  configuration: GenerationProviderRegistryConfiguration = settings,
): ModelProviderRegistry {
  const apiKey = configuration.arkApiKey?.trim();
  const ark = apiKey ? new ArkGenerationProvider({
    apiKey,
    baseUrl: configuration.arkBaseUrl ?? "https://ark.cn-beijing.volces.com/api/v3",
  }) : undefined;
  // FABLE-016: MiniMax belongs to a private account. Keep the adapter and
  // catalog artifacts in source, but no runtime configuration may register a
  // direct provider. Future company traffic must use the reviewed newapi path.
  const newapiGptImageModels = configuredExactNewapiAlias(
    configuration.newapiGptImageModels,
    "gpt-image-2",
    "NEWAPI_GPT_IMAGE_MODELS",
  );
  const newapiGeminiImageModels = configuredExactNewapiAlias(
    configuration.newapiGeminiImageModels,
    "gemini-3.1-pro-image",
    "NEWAPI_GEMINI_IMAGE_MODELS",
  );
  const approvedNewapiModels = [...newapiGptImageModels, ...newapiGeminiImageModels];
  const newapiApiKey = configuration.newapiApiKey?.trim();
  const newapiBaseUrl = configuration.newapiBaseUrl?.trim();
  const newapi = configuration.newapiGenerationEnabled === true
    && newapiApiKey
    && newapiBaseUrl
    && isApprovedOpenAiCompatibleBaseUrl(
      newapiBaseUrl,
      configuration.newapiApprovedBaseUrlSha256,
    )
      ? new OpenAiCompatibleImageProvider({
        apiKey: newapiApiKey,
        baseUrl: newapiBaseUrl,
        approvedBaseUrlSha256: configuration.newapiApprovedBaseUrlSha256!,
        approvedModelIds: approvedNewapiModels,
      })
      : undefined;
  const suchuangSelected = configuration.suchuangGenerationEnabled === true;
  const suchuangApiKey = configuration.suchuangApiKey?.trim();
  const suchuangBaseUrl = configuration.suchuangBaseUrl?.trim();
  const suchuang = suchuangSelected
    && suchuangApiKey
    && suchuangBaseUrl
    && isApprovedAsyncImageGatewayBaseUrl(suchuangBaseUrl)
      ? new AsyncImageGatewayProvider({
          apiKey: suchuangApiKey,
          baseUrl: suchuangBaseUrl,
        })
      : undefined;
  // TTS 凭据独立于 Ark 图片/视频 API key:语音控制台的 appid + access token。
  const openspeechToken = configuration.openspeechTtsToken?.trim();
  const seedAudioApiKey = configuration.seedAudioApiKey?.trim();
  const openspeech = seedAudioApiKey
    ? new SeedAudioProvider({
        apiKey: seedAudioApiKey,
        endpoint: configuration.seedAudioEndpoint,
        allowedHosts: configuration.openspeechTtsAllowedHosts,
      })
    : openspeechToken
      ? new OpenspeechTtsProvider({
          token: openspeechToken,
          appId: configuration.openspeechTtsAppId?.trim() ?? "",
          endpoint: configuration.openspeechTtsEndpoint,
          cluster: configuration.openspeechTtsCluster,
          allowedHosts: configuration.openspeechTtsAllowedHosts,
        })
      : undefined;
  const happyhorseApiKey = configuration.happyhorseApiKey?.trim();
  const happyhorseBaseUrl = configuration.happyhorseBaseUrl?.trim();
  const happyhorse = happyhorseApiKey
    && happyhorseBaseUrl
    && configuration.happyhorseModel?.trim()
    && isApprovedHappyHorseBaseUrl(happyhorseBaseUrl)
      ? new HappyHorseGenerationProvider({
          apiKey: happyhorseApiKey,
          baseUrl: happyhorseBaseUrl,
        })
      : undefined;
  const openspeechAudioModel = selectedOpenspeechAudioModel(configuration);
  return new ModelProviderRegistry({
    companyProviderAllowlist: configuration.companyProviderAllowlist,
    adapters: {
      ...(ark ? { ark } : {}),
      ...(newapi ? { newapi } : {}),
      ...(suchuang ? { suchuang } : {}),
      ...(openspeech ? { openspeech } : {}),
      ...(happyhorse ? { happyhorse } : {}),
    },
    // These are the existing deployment-selected model IDs. Other vendors
    // remain fail-closed until their verified adapter and ID are supplied.
    capabilities: [
      {
        id: "gpt-image-2",
        providerId: suchuangSelected ? "suchuang" : "newapi",
        actualModelIds: suchuangSelected
          ? [SUCHUANG_GPT_IMAGE_2_MODEL]
          : newapiGptImageModels,
      },
      {
        id: "nanobanana-2",
        providerId: "suchuang",
        actualModelIds: suchuangSelected ? [NANOBANANA_2_MODEL] : [],
      },
      {
        id: "nanobanana-lite",
        providerId: "suchuang",
        actualModelIds: suchuangSelected ? [NANOBANANA_LITE_MODEL] : [],
      },
      {
        id: "gemini-image",
        providerId: "newapi",
        actualModelIds: newapiGeminiImageModels,
      },
      {
        id: "seedream-5-pro",
        providerId: "ark",
        actualModelIds: configuredArkModelIds(configuration.arkImageModel),
      },
      {
        id: "seedance-2-0",
        providerId: "ark",
        actualModelIds: configuredArkModelIds(configuration.arkVideoModel),
      },
      {
        id: "seedance-2-5",
        providerId: "ark",
        actualModelId: configuration.arkVideoModel25,
      },
      {
        id: "minimax-image",
        providerId: "minimax",
        actualModelIds: configuredModelIds(configuration.minimaxImageModels),
      },
      {
        id: "minimax-video-h3",
        providerId: "minimax",
        actualModelIds: configuredModelIds(configuration.minimaxVideoModels),
      },
      {
        id: "minimax-voice",
        providerId: "minimax",
        actualModelIds: configuredModelIds(configuration.minimaxAudioModels),
      },
      {
        id: "voice-synthesis",
        providerId: "openspeech",
        // 与 Ark/MiniMax 同款口径：一个配置字段可登记多个实际模型 ID。
        // 部署当前同时投放 seed-audio-1.0 与 seed-audio-1.0-multilingual
        // 两套 active 档，缺任一都会让对应档位报 GENERATION_CAPABILITY_UNAVAILABLE。
        actualModelIds: openspeechAudioGenerationConfigured(configuration)
          ? configuredModelIds(openspeechAudioModel)
          : [],
      },
      {
        id: "happyhorse-1-1",
        providerId: "happyhorse",
        actualModelId: configuration.happyhorseModel,
      },
    ],
  });
}

export function configuredGenerationModel(mediaKind: "image" | "video" | "audio"): string | undefined {
  return configuredGenerationModelFrom(settings, mediaKind);
}

/** The request path and worker share the same effective paid-work budget. */
export interface GenerationBudgetConfiguration {
  paidGenerationBudgetFen?: number;
  paidGenerationReviewThresholdFen?: number;
}

export function effectivePaidBudgetFen(
  configuration: GenerationBudgetConfiguration = settings,
): number {
  const budget = configuration.paidGenerationBudgetFen;
  const reviewThreshold = configuration.paidGenerationReviewThresholdFen;
  if (typeof budget !== "number" || typeof reviewThreshold !== "number"
    || !Number.isFinite(budget) || !Number.isFinite(reviewThreshold)) return 0;
  return Math.max(0, Math.min(budget, reviewThreshold));
}

export interface GenerationWorkerDependencies extends GenerationProviderRegistryConfiguration, GenerationBudgetConfiguration {
  tosBucket?: string;
  tosEndpoint?: string;
  tosAccessKey?: string;
  tosSecretKey?: string;
  tosPublicBaseUrl?: string;
  /** Test-only seam; production probes the local labeling runtime. */
  aigcLabelingRuntimeReady?: () => boolean;
}

export interface GenerationSubmissionReadiness extends GenerationWorkerDependencies {
  allowPaidGeneration: boolean;
}
/**
 * Historical paid attempts may run only while feature authorization, a
 * positive effective budget, and all execution dependencies are available.
 */
export function generationExecutionEnabled(
  configuration: GenerationSubmissionReadiness = settings,
): boolean {
  return configuration.allowPaidGeneration === true
    && effectivePaidBudgetFen(configuration) > 0
    && workerDependenciesReady(configuration);
}

export interface AudioGenerationConfiguration {
  companyProviderAllowlist?: readonly string[];
  minimaxApiKey?: string;
  minimaxBaseUrl?: string;
  minimaxAudioModels?: string;
  arkApiKey?: string;
  arkImageModel?: string;
  arkVideoModel?: string;
  openspeechTtsModel?: string;
  openspeechTtsEndpoint?: string;
  openspeechTtsToken?: string;
  openspeechTtsAppId?: string;
  openspeechTtsAllowedHosts?: readonly string[];
  seedAudioModel?: string;
  seedAudioEndpoint?: string;
  seedAudioApiKey?: string;
}

/**
 * Audio may not infer either model IDs or endpoint URLs.  This is
 * intentionally independent from paid-worker readiness so an estimate can
 * explain the missing audio contract without creating a quote or a task.
 */
export function requireAudioGenerationConfigured(
  configuration: AudioGenerationConfiguration = settings,
): string {
  if (!providerAccountAllowed("openspeech", configuration)) {
    throw companyAccountUnavailable();
  }
  if (seedAudioV3Selected(configuration)) {
    const model = configuration.seedAudioModel?.trim();
    if (!model) {
      throw audioCapabilityUnavailable("音频能力尚未配置 SEED_AUDIO_MODEL,未创建报价或任务");
    }
    if (!isApprovedSeedAudioUrl(
      configuration.seedAudioEndpoint ?? "",
      configuration.openspeechTtsAllowedHosts,
    )) {
      throw audioCapabilityUnavailable("音频能力尚未配置受信任的 SEED_AUDIO_ENDPOINT,未创建报价或任务");
    }
    if (!configuration.seedAudioApiKey?.trim()) {
      throw audioCapabilityUnavailable("音频能力尚未配置 SEED_AUDIO_API_KEY,未创建报价或任务");
    }
    return model;
  }
  const model = configuration.openspeechTtsModel?.trim();
  if (!model) {
    throw audioCapabilityUnavailable("音频能力尚未配置 OPENSPEECH_TTS_MODEL,未创建报价或任务");
  }
  if (!isApprovedOpenspeechTtsUrl(configuration.openspeechTtsEndpoint ?? "", configuration.openspeechTtsAllowedHosts)) {
    throw audioCapabilityUnavailable("音频能力尚未配置受信任的 OPENSPEECH_TTS_ENDPOINT,未创建报价或任务");
  }
  if (!configuration.openspeechTtsToken?.trim()) {
    throw audioCapabilityUnavailable("音频能力尚未配置 OPENSPEECH_TTS_TOKEN,未创建报价或任务");
  }
  if (!configuration.openspeechTtsAppId?.trim()) {
    throw audioCapabilityUnavailable("音频能力尚未配置 OPENSPEECH_TTS_APPID,未创建报价或任务");
  }
  return model;
}

/**
 * Repository creation paths use this media-aware check before a quote can be
 * written or a confirmed quote can be consumed.  Keeping it at this boundary
 * covers direct submit, batch submit and retry without trusting route shape.
 */
export function requireGenerationRequestConfigured(
  request: Pick<NormalizedGenerationInput, "mediaKind" | "model"> & {
    parameters?: NormalizedGenerationInput["parameters"];
  },
  configurationOrExpectedProvider: GenerationProviderRegistryConfiguration | string = settings,
  expectedProvider?: string,
): GenerationProviderId {
  const configuration = typeof configurationOrExpectedProvider === "string"
    ? settings
    : configurationOrExpectedProvider;
  const requiredProvider = typeof configurationOrExpectedProvider === "string"
    ? configurationOrExpectedProvider
    : expectedProvider;
  const capability = createGenerationProviderRegistry(configuration)
    .capabilityForModel(request.model.trim());
  if (capability?.unavailableReason === COMPANY_PROVIDER_NOT_ENABLED_MESSAGE) {
    throw companyAccountUnavailable();
  }
  if (!capability || capability.availability !== "available") {
    throw audioCapabilityUnavailable("生成报价模型与当前配置模型不一致,未创建报价或任务");
  }
  if (capability.mediaKind !== request.mediaKind) {
    throw audioCapabilityUnavailable("生成报价模型与媒体类型不一致,未创建报价或任务");
  }
  if (!capability.providerId) {
    throw audioCapabilityUnavailable("生成报价模型缺少供应商绑定,未创建报价或任务");
  }
  if (requiredProvider !== undefined && capability.providerId !== requiredProvider.trim()) {
    throw audioCapabilityUnavailable("生成报价供应商与当前模型绑定不一致,未创建报价或任务");
  }
  // S49 implements the adjudicated MP3 ID3+XMP path. Refuse other audio
  // containers before a quote or paid provider call instead of discovering
  // after synthesis that the output cannot carry the required label.
  if (request.mediaKind === "audio"
    && request.parameters
    && request.parameters.format !== "mp3") {
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      "音频隐式标识当前仅支持 MP3，请把音频格式改为 MP3 后重试",
      422,
    );
  }
  return capability.providerId;
}

/**
 * Existing deployments keep one model ID.  A comma-separated setting is an
 * additive configuration form for the same two environment keys, avoiding a
 * second source of model truth while allowing a deployment to opt into more
 * than one verified Ark model.
 */
export function configuredArkModelIds(value: string | undefined): string[] {
  return configuredModelIds(value);
}

export function configuredModelIds(...values: Array<string | undefined>): string[] {
  return [...new Set(values.flatMap((value) => (
    (value ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  )))];
}

export function configuredGenerationModelFrom(
  configuration: GenerationProviderRegistryConfiguration,
  mediaKind: "image" | "video" | "audio",
): string | undefined {
  const arkReady = providerAccountAllowed("ark", configuration)
    && Boolean(configuration.arkApiKey?.trim());
  const newapiGptImageModels = configuredExactNewapiAlias(
    configuration.newapiGptImageModels,
    "gpt-image-2",
    "NEWAPI_GPT_IMAGE_MODELS",
  );
  const newapiGeminiImageModels = configuredExactNewapiAlias(
    configuration.newapiGeminiImageModels,
    "gemini-3.1-pro-image",
    "NEWAPI_GEMINI_IMAGE_MODELS",
  );
  const newapiReady = Boolean(
    providerAccountAllowed("newapi", configuration)
    && configuration.newapiGenerationEnabled === true
    && configuration.newapiApiKey?.trim()
    && configuration.newapiBaseUrl?.trim()
    && isApprovedOpenAiCompatibleBaseUrl(
      configuration.newapiBaseUrl,
      configuration.newapiApprovedBaseUrlSha256,
    ),
  );
  const suchuangReady = Boolean(
    providerAccountAllowed("suchuang", configuration)
    && configuration.suchuangGenerationEnabled === true
    && configuration.suchuangApiKey?.trim()
    && configuration.suchuangBaseUrl?.trim()
    && isApprovedAsyncImageGatewayBaseUrl(configuration.suchuangBaseUrl),
  );
  if (mediaKind === "image") {
    const arkModels = arkReady ? configuredModelIds(configuration.arkImageModel) : [];
    const cheapestArk = preferredConfiguredModel(arkModels, [
      "doubao-seedream-4-0-250828",
      "doubao-seedream-5-0-lite-260128",
      "doubao-seedream-5-0-260128",
      "doubao-seedream-5-0-pro-260628",
    ]);
    if (cheapestArk) return cheapestArk;
    if (suchuangReady) return NANOBANANA_LITE_MODEL;
    const newapiModels = newapiReady
      ? [...newapiGptImageModels, ...newapiGeminiImageModels]
      : [];
    const selectedNewapi = preferredConfiguredModel(newapiModels, [
      "gpt-image-2",
      "gemini-3.1-pro-image",
    ]);
    if (selectedNewapi) return selectedNewapi;
    return undefined;
  }
  if (mediaKind === "video") {
    const arkModels = arkReady ? configuredModelIds(configuration.arkVideoModel) : [];
    const cheapestArk = preferredConfiguredModel(arkModels, [
      "doubao-seedance-2-0-mini-260615",
      "doubao-seedance-2-0-fast-260128",
      "doubao-seedance-2-0-260128",
    ]);
    if (cheapestArk) return cheapestArk;
    return undefined;
  }
  return providerAccountAllowed("openspeech", configuration)
    && openspeechAudioGenerationConfigured(configuration)
    ? configuredModelIds(selectedOpenspeechAudioModel(configuration))[0]
    : undefined;
}

function configuredExactNewapiAlias(
  value: string | undefined,
  expected: "gpt-image-2" | "gemini-3.1-pro-image",
  settingName: string,
): string[] {
  const configured = configuredModelIds(value);
  if (configured.length === 0) return [];
  if (configured.length !== 1 || configured[0] !== expected) {
    throw new Error(`${settingName} 只允许精确 alias ${expected}`);
  }
  return [expected];
}

function openspeechAudioGenerationConfigured(configuration: AudioGenerationConfiguration): boolean {
  if (seedAudioV3Selected(configuration)) {
    return Boolean(
      configuration.seedAudioModel?.trim()
      && configuration.seedAudioApiKey?.trim()
      && isApprovedSeedAudioUrl(
        configuration.seedAudioEndpoint ?? "",
        configuration.openspeechTtsAllowedHosts,
      )
    );
  }
  return Boolean(
    configuration.openspeechTtsModel?.trim()
    && configuration.openspeechTtsToken?.trim()
    && configuration.openspeechTtsAppId?.trim()
    && isApprovedOpenspeechTtsUrl(
      configuration.openspeechTtsEndpoint ?? "",
      configuration.openspeechTtsAllowedHosts,
    ),
  );
}

function seedAudioV3Selected(configuration: AudioGenerationConfiguration): boolean {
  return Boolean(
    configuration.seedAudioModel?.trim()
    || configuration.seedAudioEndpoint?.trim()
    || configuration.seedAudioApiKey?.trim(),
  );
}

function selectedOpenspeechAudioModel(configuration: AudioGenerationConfiguration): string | undefined {
  return seedAudioV3Selected(configuration)
    ? configuration.seedAudioModel
    : configuration.openspeechTtsModel;
}

function preferredConfiguredModel(
  configured: readonly string[],
  preferences: readonly string[],
): string | undefined {
  for (const model of preferences) {
    if (configured.includes(model)) return model;
  }
  return configured[0];
}

function audioCapabilityUnavailable(message: string): GenerationError {
  return new GenerationError("GENERATION_CAPABILITY_UNAVAILABLE", message, 503, false);
}

function companyAccountUnavailable(): GenerationError {
  return new GenerationError(
    "PROVIDER_COMPANY_ACCOUNT_NOT_ENABLED",
    COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
    503,
    false,
  );
}

function providerAccountAllowed(
  providerId: GenerationProviderId,
  configuration: Pick<GenerationProviderRegistryConfiguration, "companyProviderAllowlist">,
): boolean {
  return isCompanyProviderAllowed(
    providerId,
    normalizeCompanyProviderAllowlist(configuration.companyProviderAllowlist),
  );
}

export function workerDependenciesReady(
  dependencies: GenerationWorkerDependencies = settings,
  mediaKind?: "image" | "video" | "audio",
): boolean {
  const availableCapabilities = createGenerationProviderRegistry(dependencies)
    .listCapabilities()
    .filter((capability) => capability.availability === "available");
  const providerReady = mediaKind
    ? availableCapabilities.some((capability) => capability.mediaKind === mediaKind)
    : availableCapabilities.length > 0;
  const labelingReady = dependencies.aigcLabelingRuntimeReady?.() ?? aigcLabelingRuntimeReady();
  return Boolean(
    providerReady
    && dependencies.tosBucket
    && dependencies.tosEndpoint
    && dependencies.tosAccessKey
    && dependencies.tosSecretKey
    && dependencies.tosPublicBaseUrl,
  ) && labelingReady;
}

/** Asset workers share the generation runtime's provider, TOS, and labeling readiness. */
export function assetWorkerExecutionEnabled(): boolean {
  return workerDependenciesReady(settings);
}

/** Paid work must not start when the platform writer cannot run locally. */
export function aigcLabelingRuntimeReady(): boolean {
  const configPath = path.resolve(process.cwd(), "assets/compliance/exiftool-tc260.config");
  try {
    accessSync(configPath, fsConstants.R_OK);
  } catch {
    return false;
  }
  const executablePath = resolveExecutable("exiftool");
  if (!executablePath) return false;
  try {
    accessSync(executablePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(command: string): string | undefined {
  if (command.includes(path.sep)) return path.resolve(command);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return undefined;
}

/**
 * Refuse to create a pending paid attempt unless the same dependencies needed
 * by the worker are already available. Otherwise a later restart could make a
 * previously accepted, stale attempt call the provider without a fresh click.
 */
export function requireGenerationSubmissionReady(
  dependencies: GenerationSubmissionReadiness = settings,
  mediaKind?: "image" | "video" | "audio",
): void {
  if (!dependencies.allowPaidGeneration) {
    throw new AppError(403, "paid_generation_disabled", "真实生成尚未开启,不会产生付费调用");
  }
  if (!workerDependenciesReady(dependencies, mediaKind)) {
    throw new AppError(
      503,
      "generation_service_unavailable",
      "生成服务尚未完整配置,任务没有提交,也不会产生付费调用",
      false,
    );
  }
  if (effectivePaidBudgetFen(dependencies) <= 0) {
    throw new AppError(403, "paid_generation_disabled", "生成额度为零,不会提交任务或产生付费调用");
  }
}
