import type { Database } from "../../db/client.js";
import {
  companyProviderAccountForAdapter,
  isCompanyProviderAllowed,
  normalizeCompanyProviderAllowlist,
} from "../../shared/companyProviderPolicy.js";
import { createGenerationRepository } from "../generation/factory.js";
import type { GenerationMediaKind } from "../generation/types.js";
import type {
  GenerationOrchestrationTier,
  GenerationTierCatalog,
} from "./types.js";

export class DrizzleGenerationTierCatalog implements GenerationTierCatalog {
  constructor(
    private readonly db: Database,
    private readonly companyProviderAllowlist?: readonly string[],
  ) {}

  async list(mediaKind: GenerationMediaKind): Promise<GenerationOrchestrationTier[]> {
    const allowlist = normalizeCompanyProviderAllowlist(this.companyProviderAllowlist);
    const tiers = await createGenerationRepository(this.db).listActiveTiers(mediaKind);
    return tiers.flatMap((tier): GenerationOrchestrationTier[] => {
      if (!isCompanyProviderAllowed(tier.rule.provider, allowlist)) return [];
      const metadata = tierMetadata(tier.rule.metadata);
      const providerAccount = companyProviderAccountForAdapter(tier.rule.provider);
      if (!providerAccount) return [];
      return [{
        tierId: tier.tierId,
        mediaKind,
        providerAccount,
        providerLabel: metadata.providerLabel ?? providerLabel(tier.rule.provider),
        modelLabel: metadata.modelLabel ?? publicModelLabel(mediaKind),
        displayName: metadata.displayName ?? defaultTierLabel(mediaKind, tier.parameters),
        isDefault: metadata.isDefault ?? false,
        model: tier.rule.model,
        quantity: tier.quantity,
        parameters: { ...tier.parameters },
        pricingRule: tier.rule,
      }];
    });
  }
}

function tierMetadata(metadata: Record<string, unknown>): {
  displayName?: string;
  providerLabel?: string;
  modelLabel?: string;
  isDefault?: boolean;
} {
  const tier = record(metadata.capability_tier);
  if (!tier) return {};
  return {
    ...(text(tier.display_name) ? { displayName: text(tier.display_name)! } : {}),
    ...(text(tier.provider_label) ? { providerLabel: text(tier.provider_label)! } : {}),
    ...(text(tier.model_label) ? { modelLabel: text(tier.model_label)! } : {}),
    ...(typeof tier.is_default === "boolean" ? { isDefault: tier.is_default } : {}),
  };
}

function providerLabel(provider: string): string {
  return provider.trim().toLowerCase() === "openspeech" ? "火山引擎语音" : "火山方舟";
}

function publicModelLabel(mediaKind: GenerationMediaKind): string {
  if (mediaKind === "image") return "已核价图片模型";
  if (mediaKind === "video") return "已核价视频模型";
  return "已核价音频模型";
}

function defaultTierLabel(
  mediaKind: GenerationMediaKind,
  parameters: Record<string, unknown>,
): string {
  if (mediaKind === "image") {
    return `图片 ${String(parameters.size ?? parameters.resolution ?? "默认")}`;
  }
  if (mediaKind === "video") {
    return `视频 ${String(parameters.resolution ?? "默认")} · ${String(parameters.durationSeconds ?? "默认")}秒`;
  }
  return `音频 ${String(parameters.originalDurationSeconds ?? "默认")}秒`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
