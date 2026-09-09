import {
  COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
  isCompanyProviderAllowed,
  normalizeCompanyProviderAllowlist,
  type CompanyProviderAccountId,
} from "../../../shared/companyProviderPolicy.js";
import { ProviderRequestError } from "../errors.js";
import type { GenerationProvider } from "../ports.js";
import type {
  GenerationMediaKind,
  ProviderGenerationRequest,
  ProviderResultSnapshot,
  ProviderSubmission,
} from "../types.js";

/** Product names are stable; the vendor's actual model ID is deployment configuration. */
export type GenerationCapabilityId =
  | "gpt-image-2"
  | "nanobanana-2"
  | "nanobanana-lite"
  | "gemini-image"
  | "seedream-5-pro"
  | "seedance-2-0"
  | "seedance-2-5"
  | "minimax-image"
  | "minimax-video-h3"
  | "minimax-voice"
  | "voice-synthesis"
  /** @deprecated Configuration-only alias retained for existing deployments. */
  | "seed-audio-1-0"
  | "happyhorse-1-1";

export type GenerationProviderId =
  | "ark"
  | "minimax"
  | "newapi"
  | "suchuang"
  | "openai"
  | "google"
  | "happyhorse"
  | "openspeech";
export type CapabilityAvailability = "available" | "unconfigured";

export interface GenerationCapability {
  id: GenerationCapabilityId;
  displayName: string;
  mediaKind: GenerationMediaKind;
  availability: CapabilityAvailability;
  /** Only present after a deployment explicitly supplies a real provider model ID. */
  actualModelId?: string;
  providerId?: GenerationProviderId;
  unavailableReason?: string;
}

export interface ConfiguredCapability {
  id: GenerationCapabilityId;
  /** This value must come from a verified provider configuration, never a product-name guess. */
  actualModelId?: string;
  /**
   * Multiple explicitly configured provider IDs may share one product
   * capability.  The public catalogue deliberately continues to show the
   * stable product name rather than leaking a vendor ID.
   */
  actualModelIds?: readonly string[];
  providerId?: GenerationProviderId;
}

export interface ModelProviderRegistryOptions {
  adapters?: Partial<Record<GenerationProviderId, GenerationProvider>>;
  capabilities?: ConfiguredCapability[];
  companyProviderAllowlist?: readonly string[];
}

type PrimaryGenerationCapabilityId = Exclude<GenerationCapabilityId, "seed-audio-1-0">;

const CATALOG: Readonly<Record<PrimaryGenerationCapabilityId, Omit<GenerationCapability, "availability" | "actualModelId" | "providerId" | "unavailableReason">>> = {
  "gpt-image-2": { id: "gpt-image-2", displayName: "GPT Image 2", mediaKind: "image" },
  "nanobanana-2": { id: "nanobanana-2", displayName: "NanoBanana 2", mediaKind: "image" },
  "nanobanana-lite": { id: "nanobanana-lite", displayName: "NanoBanana Lite", mediaKind: "image" },
  "gemini-image": { id: "gemini-image", displayName: "Gemini 图像", mediaKind: "image" },
  "seedream-5-pro": { id: "seedream-5-pro", displayName: "Seedream 5 Pro", mediaKind: "image" },
  "seedance-2-0": { id: "seedance-2-0", displayName: "Seedance 2.0", mediaKind: "video" },
  "seedance-2-5": { id: "seedance-2-5", displayName: "Seedance 2.5", mediaKind: "video" },
  "minimax-image": { id: "minimax-image", displayName: "MiniMax 图像", mediaKind: "image" },
  "minimax-video-h3": { id: "minimax-video-h3", displayName: "MiniMax H3 视频", mediaKind: "video" },
  "minimax-voice": { id: "minimax-voice", displayName: "MiniMax 语音", mediaKind: "audio" },
  "voice-synthesis": { id: "voice-synthesis", displayName: "声音生成", mediaKind: "audio" },
  "happyhorse-1-1": { id: "happyhorse-1-1", displayName: "HappyHorse 1.1", mediaKind: "video" },
};

const CAPABILITY_ALIASES: Readonly<Partial<Record<GenerationCapabilityId, PrimaryGenerationCapabilityId>>> = {
  "seed-audio-1-0": "voice-synthesis",
};

/**
 * Routes only explicitly configured model IDs.  There are intentionally no
 * guessed URLs or model IDs for OpenAI, Gemini, or HappyHorse here.
 */
export class ModelProviderRegistry implements GenerationProvider {
  private readonly capabilitiesByModel = new Map<string, GenerationCapability>();
  private readonly capabilities: GenerationCapability[];
  private readonly companyProviderAllowlist: ReadonlySet<CompanyProviderAccountId>;

  constructor(private readonly options: ModelProviderRegistryOptions = {}) {
    this.companyProviderAllowlist = normalizeCompanyProviderAllowlist(
      options.companyProviderAllowlist,
    );
    const configured = new Map<PrimaryGenerationCapabilityId, ConfiguredCapability>();
    for (const item of options.capabilities ?? []) {
      configured.set(primaryCapabilityId(item.id), item);
    }
    this.capabilities = (Object.keys(CATALOG) as PrimaryGenerationCapabilityId[]).map((id) => {
      const item = configured.get(id);
      const catalog = CATALOG[id];
      const actualModelIds = configuredModelIds(item);
      const actualModelId = actualModelIds[0];
      if (!actualModelId || !item?.providerId) {
        return {
          ...catalog,
          availability: "unconfigured",
          unavailableReason: !actualModelId
            ? "实际模型 ID 尚未配置"
            : "供应商尚未配置",
        };
      }
      if (!isCompanyProviderAllowed(item.providerId, this.companyProviderAllowlist)) {
        const blockedCapability: GenerationCapability = {
          ...catalog,
          availability: "unconfigured",
          actualModelId,
          providerId: item.providerId,
          unavailableReason: COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
        };
        this.bindConfiguredModels(actualModelIds, blockedCapability);
        return {
          ...catalog,
          availability: "unconfigured",
          unavailableReason: COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
        };
      }
      const adapter = options.adapters?.[item.providerId];
      if (!adapter) {
        return {
          ...catalog,
          availability: "unconfigured",
          unavailableReason: "供应商适配器尚未配置",
        };
      }
      const capability: GenerationCapability = {
        ...catalog,
        availability: "available",
        actualModelId,
        providerId: item.providerId,
      };
      this.bindConfiguredModels(actualModelIds, capability);
      return capability;
    });
  }

  listCapabilities(): readonly GenerationCapability[] {
    return this.capabilities.map((item) => ({ ...item }));
  }

  capabilityForModel(actualModelId: string): GenerationCapability | undefined {
    return this.capabilitiesByModel.get(actualModelId.trim());
  }

  async submit(request: ProviderGenerationRequest, signal?: AbortSignal): Promise<ProviderSubmission> {
    const capability = this.requireCapability(request.model, request.mediaKind, "submit");
    assertSingleApprovedRequest(request);
    return this.requireAdapter(capability, "submit").submit(request, signal);
  }

  async query(
    providerTaskId: string,
    request?: Pick<ProviderGenerationRequest, "model" | "mediaKind">,
    signal?: AbortSignal,
  ): Promise<ProviderResultSnapshot> {
    if (!request) {
      throw unavailable("query", "无法在缺少原始模型的情况下查询供应商任务");
    }
    const capability = this.requireCapability(request.model, request.mediaKind, "query");
    return this.requireAdapter(capability, "query").query(providerTaskId, request, signal);
  }

  private requireCapability(
    model: string,
    mediaKind: GenerationMediaKind,
    operation: "submit" | "query",
  ): GenerationCapability {
    const capability = this.capabilityForModel(model);
    if (!capability) throw unavailable(operation, "模型未配置或不可用，不会发起供应商调用");
    if (capability.mediaKind !== mediaKind) throw unavailable(operation, "模型能力与生成媒体类型不匹配");
    if (capability.availability !== "available") {
      if (capability.unavailableReason === COMPANY_PROVIDER_NOT_ENABLED_MESSAGE) {
        throw companyAccountUnavailable(operation);
      }
      throw unavailable(operation, "模型未配置或不可用，不会发起供应商调用");
    }
    return capability;
  }

  private requireAdapter(capability: GenerationCapability, operation: "submit" | "query"): GenerationProvider {
    const adapter = capability.providerId ? this.options.adapters?.[capability.providerId] : undefined;
    if (!adapter) throw unavailable(operation, "供应商适配器未配置，不会发起供应商调用");
    return adapter;
  }

  private bindConfiguredModels(
    actualModelIds: readonly string[],
    capability: GenerationCapability,
  ): void {
    for (const configuredModelId of actualModelIds) {
      const existing = this.capabilitiesByModel.get(configuredModelId);
      if (existing) {
        throw new Error(
          `Duplicate generation model binding is not allowed (${existing.id}, ${capability.id})`,
        );
      }
      this.capabilitiesByModel.set(configuredModelId, capability);
    }
  }
}

function configuredModelIds(item: ConfiguredCapability | undefined): string[] {
  if (!item) return [];
  return [...new Set([
    item.actualModelId,
    ...(item.actualModelIds ?? []),
  ].flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []))];
}

function primaryCapabilityId(id: GenerationCapabilityId): PrimaryGenerationCapabilityId {
  return CAPABILITY_ALIASES[id] ?? id as PrimaryGenerationCapabilityId;
}

function unavailable(operation: "submit" | "query", message: string): ProviderRequestError {
  return new ProviderRequestError(message, operation, "rejected", false, "PROVIDER_NOT_CONFIGURED");
}

function companyAccountUnavailable(operation: "submit" | "query"): ProviderRequestError {
  return new ProviderRequestError(
    COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
    operation,
    "rejected",
    false,
    "PROVIDER_COMPANY_ACCOUNT_NOT_ENABLED",
  );
}

function assertSingleApprovedRequest(request: ProviderGenerationRequest): void {
  if (!request.prompt.trim()) {
    throw new ProviderRequestError("生成提示词不能为空", "submit", "rejected", false, "INVALID_PROVIDER_INPUT");
  }
  if (request.quantity !== 1) {
    throw new ProviderRequestError("一次人工点击只能创建一个生成任务", "submit", "rejected", false, "INVALID_PROVIDER_INPUT");
  }
}
