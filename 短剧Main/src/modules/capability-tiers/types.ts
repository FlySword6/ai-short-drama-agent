export type CapabilityTierMediaType = "image" | "video" | "audio";
export type CapabilityTierStatus = "active" | "experimental" | "retired";
export type CapabilityTierPriceUnit = "per_image" | "per_second" | "per_10k_characters";

/**
 * Provider-neutral billing combination. The production workbench renders the
 * individual parameter options projected from these rows; after selection the
 * client sends the matching tier ID so quote and accounting stay deterministic.
 */
export interface GenerationCapabilityTier {
  tierId: string;
  mediaType: CapabilityTierMediaType;
  displayName: string;
  providerLabel: string;
  modelLabel: string;
  isDefault: boolean;
  availability:
    | "available"
    | "dev_smoke_only"
    | "billing_unverified"
    | "pricing_unverified"
    | "parameter_matrix_unverified"
    | "provider_not_enabled"
    | "product_decision_pending";
  availabilityReason: string;
  capabilities: string[];
  officialPriceSource?: string;
  params: Record<string, string | number | boolean>;
  price: {
    unit: CapabilityTierPriceUnit;
    points: number;
  };
  status: CapabilityTierStatus;
}

/** Minimal pricing-rule projection required by the capability-tier reader. */
export interface ActivePricingRuleRecord {
  id: string;
  provider?: string;
  model: string;
  mediaKind: CapabilityTierMediaType;
  billingUnit: string;
  unitPriceFen: number;
  metadata: Record<string, unknown>;
  effectiveFrom: Date;
  /** Older in-memory test doubles omit this; absence means current/active. */
  active?: boolean;
}

export interface CapabilityTierRepository {
  listCurrentPricingRules(mediaType: CapabilityTierMediaType, at: Date): Promise<ActivePricingRuleRecord[]>;
}
