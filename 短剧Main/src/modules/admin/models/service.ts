import type { GenerationCapability } from "../../generation/provider/modelProviderRegistry.js";
import { BadRequestError } from "../../../shared/errors.js";
import type { AdminModelRepository } from "./repository.js";
import type {
  AdminBillingUnit,
  AdminModelView,
  PricingRulePage,
  PricingRuleRecord,
  ReplacePricingRuleInput,
} from "./types.js";

export interface GenerationCapabilityRegistryView {
  listCapabilities(): readonly GenerationCapability[];
  capabilityForModel?(actualModelId: string): GenerationCapability | undefined;
}

export interface AdminModelServicePort {
  listModels(): Promise<AdminModelView[]>;
  listPricingRules(page: number, pageSize: number): Promise<PricingRulePage>;
  replacePricingRule(actorId: string, input: ReplacePricingRuleInput): Promise<PricingRuleRecord>;
}

export class AdminModelService implements AdminModelServicePort {
  constructor(
    private readonly repository: AdminModelRepository,
    private readonly registry: GenerationCapabilityRegistryView,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listModels(): Promise<AdminModelView[]> {
    const prices = await this.repository.listCurrentPricingRules(this.now());
    return this.registry.listCapabilities().map((capability) => {
      const currentPrice = capability.availability === "available"
        && capability.providerId
        && capability.actualModelId
        ? findCurrentPrice(
          prices,
          capability.providerId,
          capability.actualModelId,
          capability.mediaKind,
          defaultBillingUnit(capability.mediaKind),
        )
        : null;
      return {
        id: capability.id,
        displayName: capability.displayName,
        mediaKind: capability.mediaKind,
        configurationStatus: capability.availability === "available" ? "configured" : "unconfigured",
        ...(capability.providerId ? { providerId: capability.providerId } : {}),
        ...(capability.actualModelId ? { actualModelId: capability.actualModelId } : {}),
        ...(capability.unavailableReason ? { unavailableReason: capability.unavailableReason } : {}),
        currentPrice,
      };
    });
  }

  listPricingRules(page: number, pageSize: number): Promise<PricingRulePage> {
    return this.repository.listPricingRules(page, pageSize);
  }

  replacePricingRule(actorId: string, input: ReplacePricingRuleInput): Promise<PricingRuleRecord> {
    const capability = this.registry.capabilityForModel?.(input.model)
      ?? this.registry.listCapabilities().find((candidate) => (
        candidate.actualModelId === input.model
      ));
    if (capability?.availability !== "available"
      || !capability.providerId
      || capability.providerId !== input.provider
      || capability.mediaKind !== input.mediaKind) {
      throw new BadRequestError(
        "保存单价没成：供应商、模型和媒体类型必须与当前部署绑定完全一致。",
      );
    }
    return this.repository.replacePricingRule(actorId, input);
  }
}

function defaultBillingUnit(mediaKind: "image" | "video" | "audio"): AdminBillingUnit {
  return mediaKind === "image" ? "image" : "second";
}

function findCurrentPrice(
  prices: PricingRuleRecord[],
  provider: string,
  model: string,
  mediaKind: "image" | "video" | "audio",
  billingUnit: AdminBillingUnit,
): PricingRuleRecord | null {
  return prices.find((price) => price.provider === provider
    && price.model === model
    && price.mediaKind === mediaKind
    && price.billingUnit === billingUnit
    && !hasCapabilityTier(price.metadata)) ?? null;
}

function hasCapabilityTier(metadata: Record<string, unknown>): boolean {
  return typeof metadata.capability_tier === "object" && metadata.capability_tier !== null;
}
