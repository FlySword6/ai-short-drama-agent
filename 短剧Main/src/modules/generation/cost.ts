import type { GenerationMediaKind, GenerationProductionMode, NormalizedGenerationInput } from "./types.js";
import { settings } from "../../config/env.js";
import { assessTierPricingRule, type TierPricingGuardContext } from "./tierPricingGuard.js";
import {
  normalizeV01Parameters,
  requiresV01LegacyVideoPriceFloor,
  V01_LEGACY_NO_INPUT_VIDEO_TIER_ID,
  V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND,
} from "./v01Contract.js";

export type BillingUnit = "request" | "image" | "second" | "ten_thousand_characters";

/** Serializes price replacement with quote creation and paid quote consumption. */
export const generationPricingLockKey = 1_724_017;

export interface GenerationPricingRule {
  id: string;
  provider: string;
  model: string;
  mediaKind: GenerationMediaKind;
  billingUnit: BillingUnit;
  unitPriceFen: number;
  metadata: Record<string, unknown>;
  /** Explicit price-rule assertion required when a request carries video input. */
  supportsInputVideo?: boolean;
}

export interface CostEstimate {
  tierId: string;
  pricingRuleId: string;
  provider: string;
  model: string;
  mediaKind: GenerationMediaKind;
  billingUnit: BillingUnit;
  unitPriceFen: number;
  billableUnits: number;
  estimatedCostFen: number;
  fullEstimatedCostFen: number;
  productionMode: GenerationProductionMode;
  priceMultiplierBps: 6_000 | 10_000;
  discountNumerator: number;
  discountDenominator: number;
  currency: "CNY";
  pricingBasis?: GenerationPricingBasis;
}

export interface GenerationPricingBasis {
  contractVersion:
    | "v0.1-ark-fixed"
    | "v0.2-audio-original-duration"
    | "v0.3-audio-characters"
    | "v0.4-provider-tier";
  method:
    | "configured_per_image"
    | "conservative_per_second"
    | "configured_per_10k_characters";
  fixedParameters: Record<string, string | number | boolean>;
  noInputVideo?: true;
  inputVideoReferenceCount?: number;
  estimatedTokens?: number;
  providerYuanPerMillionTokens?: number;
}

export function estimateGenerationCost(
  rule: GenerationPricingRule,
  input: Pick<NormalizedGenerationInput,
    "tierId" | "mediaKind" | "model" | "quantity" | "parameters" | "referenceAssetSnapshots"
  > & Partial<Pick<NormalizedGenerationInput, "productionMode" | "prompt">>,
  // 缺省读部署配置,跟档位解析、公共目录同一条口径。谁开通了公司账户是部署
  // 事实,不该由估价这一处自己另定一份默认名单——那会让「目录里能选中,
  // 一问价就说未开通」这种自相矛盾的状态出现在用户面前。
  guardContext: TierPricingGuardContext = { companyProviderAllowlist: settings.companyProviderAllowlist },
): CostEstimate {
  assertNonNegativeSafeInteger(rule.unitPriceFen, "unitPriceFen");
  assertPositiveSafeInteger(input.quantity, "quantity");
  if (rule.mediaKind !== input.mediaKind || rule.model !== input.model) {
    throw new Error("Pricing rule does not match the generation request");
  }
  const parameters = normalizeV01Parameters(input);
  const inputVideoReferenceCount = input.referenceAssetSnapshots
    .filter((reference) => reference.kind === "video").length;

  let billableUnits = input.quantity;
  if (rule.billingUnit === "request") billableUnits = 1;
  if (rule.billingUnit === "second") {
    const durationSeconds = input.mediaKind === "audio"
      ? parameters.originalDurationSeconds
      : parameters.durationSeconds;
    assertPositiveSafeInteger(durationSeconds, "durationSeconds");
    billableUnits = multiplySafeIntegers(durationSeconds, input.quantity, "billableUnits");
  }
  if (rule.billingUnit === "ten_thousand_characters") {
    if (input.mediaKind !== "audio") {
      throw new Error("Character billing is only available for audio generation");
    }
    const billableCharacters = minimaxBillableCharacters(input.prompt ?? "");
    assertPositiveSafeInteger(billableCharacters, "billableCharacters");
    billableUnits = multiplySafeIntegers(billableCharacters, input.quantity, "billableUnits");
  }

  if (input.mediaKind === "image" && rule.billingUnit !== "image") {
    throw new Error("V0.1 Seedream pricing must use the image billing unit");
  }
  if (hasCompleteTierMetadata(rule.metadata)) {
    const assessment = assessTierPricingRule({ ...rule, active: true }, guardContext);
    if (!assessment.quoteable) {
      throw new Error(`Tier pricing is unavailable: ${assessment.reason}`);
    }
  }
  if (input.mediaKind === "video") {
    if (!rule.provider.trim()) throw new Error("Video pricing provider is required");
    if (rule.billingUnit !== "second") {
      throw new Error("Video pricing must use the second billing unit");
    }
    if (requiresV01LegacyVideoPriceFloor(rule.metadata)
      && rule.unitPriceFen < V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND) {
      throw new Error(`V0.1 Seedance unit price must be at least ${V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND} fen per second`);
    }
    const tierId = readCapabilityTierId(rule.metadata);
    if (inputVideoReferenceCount > 0
      && (rule.supportsInputVideo !== true || tierId === V01_LEGACY_NO_INPUT_VIDEO_TIER_ID)) {
      throw new Error("当前单价未覆盖视频参考，暂不能创建报价");
    }
  }
  if (input.mediaKind === "audio"
    && rule.billingUnit !== "second"
    && rule.billingUnit !== "ten_thousand_characters") {
    throw new Error("Audio pricing must use seconds or ten-thousand-character billing");
  }

  const legacyArkPricing = rule.provider.trim().toLowerCase() === "ark";
  const pricingBasis: GenerationPricingBasis = input.mediaKind === "video"
    ? {
        contractVersion: legacyArkPricing ? "v0.1-ark-fixed" : "v0.4-provider-tier",
        method: "conservative_per_second",
        fixedParameters: {
          resolution: String(parameters.resolution),
          ratio: String(parameters.ratio),
          durationSeconds: Number(parameters.durationSeconds),
          watermark: false,
        },
        ...(inputVideoReferenceCount === 0 ? { noInputVideo: true } : {}),
        ...(inputVideoReferenceCount > 0 ? { inputVideoReferenceCount } : {}),
      }
    : input.mediaKind === "audio" && rule.billingUnit === "ten_thousand_characters"
      ? {
          contractVersion: "v0.3-audio-characters",
          method: "configured_per_10k_characters",
          fixedParameters: {
            billableCharacters: billableUnits,
            chineseCharacterWeight: 2,
            otherCharacterWeight: 1,
            format: String(parameters.format),
            aigcMetadataEnabled: true,
          },
        }
      : input.mediaKind === "audio"
      ? {
          contractVersion: "v0.2-audio-original-duration",
          method: "conservative_per_second",
          fixedParameters: {
            originalDurationSeconds: Number(parameters.originalDurationSeconds),
            format: String(parameters.format),
            enableSubtitle: true,
            aigcMetadataEnabled: true,
          },
        }
      : {
        contractVersion: legacyArkPricing ? "v0.1-ark-fixed" : "v0.4-provider-tier",
        method: "configured_per_image",
        fixedParameters: {
          size: String(parameters.size),
          quantity: 1,
          watermark: false,
          sequentialImageGeneration: "disabled",
        },
      };

  const fullEstimatedCostFen = rule.billingUnit === "ten_thousand_characters"
    ? ceilMultiplyDivide(rule.unitPriceFen, billableUnits, 10_000, "estimatedCostFen")
    : multiplySafeIntegers(rule.unitPriceFen, billableUnits, "estimatedCostFen");
  const productionMode = input.productionMode ?? "full";
  if (productionMode !== "full" && productionMode !== "sample") {
    throw new Error("productionMode must be full or sample");
  }
  if (productionMode === "sample" && input.mediaKind !== "video") {
    throw new Error("sample production mode is only available for video generation");
  }
  const discountNumerator = productionMode === "sample" ? 3 : 1;
  const discountDenominator = productionMode === "sample" ? 5 : 1;
  const priceMultiplierBps = productionMode === "sample" ? 6_000 : 10_000;
  const estimatedCostFen = productionMode === "sample"
    ? ceilMultiplyDivide(fullEstimatedCostFen, discountNumerator, discountDenominator, "estimatedCostFen")
    : fullEstimatedCostFen;

  return {
    tierId: input.tierId,
    pricingRuleId: rule.id,
    provider: rule.provider,
    model: rule.model,
    mediaKind: rule.mediaKind,
    billingUnit: rule.billingUnit,
    unitPriceFen: rule.unitPriceFen,
    billableUnits,
    estimatedCostFen,
    fullEstimatedCostFen,
    productionMode,
    priceMultiplierBps,
    discountNumerator,
    discountDenominator,
    currency: "CNY",
    pricingBasis,
  };
}

function hasCompleteTierMetadata(metadata: Record<string, unknown> | undefined): boolean {
  const tier = metadata?.capability_tier;
  return Boolean(
    tier
    && typeof tier === "object"
    && !Array.isArray(tier)
    && "status" in tier
    && "params" in tier,
  );
}

/** MiniMax bills one Han character as two units and every other Unicode scalar as one. */
export function minimaxBillableCharacters(text: string): number {
  let units = 0;
  for (const character of text) {
    units += /\p{Script=Han}/u.test(character) ? 2 : 1;
  }
  if (!Number.isSafeInteger(units)) throw new Error("billableCharacters exceeds the safe integer range");
  return units;
}

function readCapabilityTierId(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const capabilityTier = metadata.capability_tier;
  if (!capabilityTier || typeof capabilityTier !== "object") return undefined;
  const tierId = (capabilityTier as Record<string, unknown>).tier_id;
  return typeof tierId === "string" ? tierId : undefined;
}

/** The boundary is inclusive: spending exactly the approved budget is allowed. */
export function isWithinBudget(usedFen: number, estimatedCostFen: number, limitFen: number): boolean {
  assertNonNegativeSafeInteger(usedFen, "usedFen");
  assertNonNegativeSafeInteger(estimatedCostFen, "estimatedCostFen");
  assertNonNegativeSafeInteger(limitFen, "limitFen");
  return estimatedCostFen <= limitFen - usedFen;
}

function multiplySafeIntegers(left: number, right: number, field: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new Error(`${field} exceeds the safe integer range`);
  return result;
}

function ceilMultiplyDivide(value: number, numerator: number, denominator: number, field: string): number {
  const scaled = multiplySafeIntegers(value, numerator, field);
  const result = Math.ceil(scaled / denominator);
  if (!Number.isSafeInteger(result)) throw new Error(`${field} exceeds the safe integer range`);
  return result;
}

function assertPositiveSafeInteger(value: number | undefined, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}
