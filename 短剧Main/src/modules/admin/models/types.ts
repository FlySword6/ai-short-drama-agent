import type { GenerationCapabilityId, GenerationProviderId } from "../../generation/provider/modelProviderRegistry.js";

/**
 * The admin read model must represent every generation capability, including
 * audio.  The write route remains deliberately closed for audio until the
 * required paid smoke and pricing verification have been approved.
 */
export type AdminMediaKind = "image" | "video" | "audio";
export type AdminBillingUnit = "image" | "second";
export type ModelConfigurationStatus = "configured" | "unconfigured";

export interface PricingRuleRecord {
  id: string;
  provider: string;
  model: string;
  mediaKind: string;
  billingUnit: string;
  unitPriceFen: number;
  currency: string;
  source: string;
  active: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PricingRulePage {
  items: PricingRuleRecord[];
  total: number;
}

export interface ReplacePricingRuleInput {
  provider: string;
  model: string;
  mediaKind: AdminMediaKind;
  billingUnit: AdminBillingUnit;
  unitPriceFen: number;
  currency: "CNY";
  /** Null means the caller observed that no active rule exists. */
  expectedActiveRuleId: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface AdminModelView {
  id: GenerationCapabilityId;
  displayName: string;
  mediaKind: AdminMediaKind;
  configurationStatus: ModelConfigurationStatus;
  providerId?: GenerationProviderId;
  actualModelId?: string;
  unavailableReason?: string;
  currentPrice: PricingRuleRecord | null;
}
