import { capabilityTiersFromPricingRules } from "./repository.js";
import type {
  CapabilityTierMediaType,
  CapabilityTierPriceUnit,
  CapabilityTierStatus,
  CapabilityTierRepository,
  GenerationCapabilityTier,
} from "./types.js";

type ParameterValue = string | number | boolean;

export interface GenerationParameterOption {
  key: string;
  values: Array<{
    value: ParameterValue;
    availability: GenerationCapabilityTier["availability"];
    availabilityReason: string;
    selectable: boolean;
  }>;
}

export interface GenerationParameterModel {
  modelLabel: string;
  providerLabel: string;
  mediaType: CapabilityTierMediaType;
  anchorTierId: string | null;
  selectable: boolean;
  availability: GenerationCapabilityTier["availability"];
  availabilityReason: string;
  parameterOptions: GenerationParameterOption[];
  combinations: Array<{
    tierId: string;
    params: Record<string, ParameterValue>;
    price: { unit: CapabilityTierPriceUnit; points: number };
    status: CapabilityTierStatus;
    availability: GenerationCapabilityTier["availability"];
    availabilityReason: string;
    selectable: boolean;
  }>;
}

export class CapabilityTierService {
  constructor(private readonly repository: CapabilityTierRepository) {}

  async listCatalog(mediaType: CapabilityTierMediaType, at = new Date()): Promise<GenerationCapabilityTier[]> {
    return capabilityTiersFromPricingRules(await this.repository.listCurrentPricingRules(mediaType, at));
  }

  /** Compatibility for existing callers that subsequently select an active tier. */
  async listActive(mediaType: CapabilityTierMediaType, at = new Date()): Promise<GenerationCapabilityTier[]> {
    return (await this.listCatalog(mediaType, at)).filter((tier) => tier.status === "active");
  }
}

const HIDDEN_PARAMETER_KEYS = new Set([
  "watermark",
  "aigc_metadata_enabled",
  "aigc_watermark_enabled",
]);
const PARAMETER_ORDER = [
  "aspect_ratio",
  "resolution",
  "duration_seconds",
  "quantity",
  "generate_audio",
  "sequential_image_generation",
  "original_duration_seconds",
  "format",
  "sample_rate",
  "speech_rate",
  "loudness_rate",
  "pitch_rate",
];

/** Project billing combinations into independently selectable user parameters. */
export function generationParameterModels(
  tiers: readonly GenerationCapabilityTier[],
): GenerationParameterModel[] {
  const groups = new Map<string, GenerationCapabilityTier[]>();
  for (const tier of tiers) {
    const key = `${tier.mediaType}\u0000${tier.providerLabel}\u0000${tier.modelLabel}`;
    const group = groups.get(key) ?? [];
    group.push(tier);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const active = group.filter((tier) => tier.status === "active");
    const representative = active.find((tier) => tier.isDefault) ?? active[0] ?? group[0]!;
    const parameterKeys = [...new Set(group.flatMap((tier) => Object.keys(tier.params)))]
      .filter((key) => !HIDDEN_PARAMETER_KEYS.has(key))
      .sort(compareParameterKeys);
    return {
      modelLabel: representative.modelLabel,
      providerLabel: representative.providerLabel,
      mediaType: representative.mediaType,
      anchorTierId: representative.status === "active" ? representative.tierId : null,
      selectable: active.length > 0,
      availability: representative.availability,
      availabilityReason: representative.availabilityReason,
      parameterOptions: parameterKeys.map((key) => ({
        key,
        values: parameterValues(group, key),
      })),
      combinations: group.map((tier) => ({
        tierId: tier.tierId,
        params: { ...tier.params },
        price: { ...tier.price },
        status: tier.status,
        availability: tier.availability,
        availabilityReason: tier.availabilityReason,
        selectable: tier.status === "active",
      })),
    };
  });
}

function parameterValues(
  tiers: readonly GenerationCapabilityTier[],
  key: string,
): GenerationParameterOption["values"] {
  const values = new Map<string, GenerationCapabilityTier[]>();
  for (const tier of tiers) {
    const value = tier.params[key];
    if (value === undefined) continue;
    const group = values.get(JSON.stringify(value)) ?? [];
    group.push(tier);
    values.set(JSON.stringify(value), group);
  }
  return [...values.values()].map((group) => {
    const active = group.find((tier) => tier.status === "active");
    const representative = active ?? group[0]!;
    return {
      value: representative.params[key]!,
      availability: representative.availability,
      availabilityReason: representative.availabilityReason,
      selectable: Boolean(active),
    };
  });
}

function compareParameterKeys(left: string, right: string): number {
  const leftIndex = PARAMETER_ORDER.indexOf(left);
  const rightIndex = PARAMETER_ORDER.indexOf(right);
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
  if (leftIndex === -1) return 1;
  if (rightIndex === -1) return -1;
  return leftIndex - rightIndex;
}
