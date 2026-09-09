import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { pricingRules } from "../../db/schema.js";
import {
  arkTierPriceDefinition,
  assessTierPricingRule,
  isRetiredGenerationTier,
} from "../generation/tierPricingGuard.js";
import type { TierPricingGuardContext } from "../generation/tierPricingGuard.js";
import type {
  ActivePricingRuleRecord,
  CapabilityTierMediaType,
  CapabilityTierRepository,
  GenerationCapabilityTier,
} from "./types.js";

const scalarParameter = z.union([z.string(), z.number().finite(), z.boolean()]);
const tierMetadataSchema = z.object({
  capability_tier: z.object({
    tier_id: z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9-]*$/),
    params: z.record(z.string().min(1).max(64), scalarParameter),
    status: z.enum(["active", "experimental", "retired"]),
    display_name: z.string().trim().min(1).max(160).optional(),
    provider_label: z.string().trim().min(1).max(80).optional(),
    model_label: z.string().trim().min(1).max(160).optional(),
    is_default: z.boolean().optional(),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
    official_price_source: z.string().trim().url().max(2_048).optional(),
  }).strict(),
}).passthrough();

/**
 * Reads the current price rows. Tier configuration deliberately lives in
 * pricing_rules.metadata.capability_tier, so price, status and parameters do
 * not drift into a second table or environment-only registry.
 */
export class DrizzleCapabilityTierRepository implements CapabilityTierRepository {
  constructor(private readonly db: Database) {}

  async listCurrentPricingRules(
    mediaType: CapabilityTierMediaType,
    at: Date,
  ): Promise<ActivePricingRuleRecord[]> {
    const rows = await this.db.select({
      id: pricingRules.id,
      provider: pricingRules.provider,
      model: pricingRules.model,
      mediaKind: pricingRules.mediaKind,
      billingUnit: pricingRules.billingUnit,
      unitPriceFen: pricingRules.unitPriceFen,
      metadata: pricingRules.metadata,
      effectiveFrom: pricingRules.effectiveFrom,
      active: pricingRules.active,
    }).from(pricingRules).where(and(
      eq(pricingRules.mediaKind, mediaType),
      lte(pricingRules.effectiveFrom, at),
      or(isNull(pricingRules.effectiveTo), gt(pricingRules.effectiveTo, at)),
    )).orderBy(desc(pricingRules.effectiveFrom), desc(pricingRules.id));

    return rows.map((row) => ({
      ...row,
      mediaKind: row.mediaKind as CapabilityTierMediaType,
    }));
  }
}

/**
 * Projects one current pricing rule into its public tier. Invalid or inactive
 * metadata is intentionally invisible rather than being guessed from a model
 * name. Administrators must explicitly register a tier in the price rule.
 */
export function capabilityTierFromPricingRule(
  rule: ActivePricingRuleRecord,
  // 跟 resolveTierFromPricingRule 同一条口径:缺省读部署配置,谁开通了公司账户
  // 是部署事实。允许调用方显式传入,是为了让测试能自己声明前提,
  // 不被运行环境有没有 .env 影响。
  guardContext: TierPricingGuardContext = { companyProviderAllowlist: settings.companyProviderAllowlist },
): GenerationCapabilityTier | null {
  const parsed = tierMetadataSchema.safeParse(rule.metadata);
  if (!parsed.success) return null;
  if (isRetiredGenerationTier(parsed.data.capability_tier.tier_id)) return null;

  const priceUnit = priceUnitFor(rule.mediaKind, rule.billingUnit);
  if (!priceUnit || !Number.isSafeInteger(rule.unitPriceFen) || rule.unitPriceFen < 0) return null;
  const assessment = assessTierPricingRule({
    provider: rule.provider ?? "",
    model: rule.model,
    mediaKind: rule.mediaKind,
    billingUnit: rule.billingUnit,
    unitPriceFen: rule.unitPriceFen,
    metadata: rule.metadata,
    active: rule.active ?? true,
  }, guardContext);
  const status = assessment.quoteable
    ? "active"
    : parsed.data.capability_tier.status === "retired" ? "retired" : "experimental";
  const officialPriceSource = parsed.data.capability_tier.official_price_source
    ?? arkTierPriceDefinition(parsed.data.capability_tier.tier_id)?.sourceUrl;

  return {
    tierId: parsed.data.capability_tier.tier_id,
    mediaType: rule.mediaKind,
    displayName: parsed.data.capability_tier.display_name
      ?? defaultTierDisplayName(rule, parsed.data.capability_tier.tier_id),
    providerLabel: parsed.data.capability_tier.provider_label
      ?? providerDisplayName(rule.provider ?? ""),
    modelLabel: parsed.data.capability_tier.model_label
      ?? defaultModelDisplayName(rule.model),
    isDefault: assessment.quoteable && (parsed.data.capability_tier.is_default ?? false),
    availability: assessment.code,
    availabilityReason: assessment.reason,
    capabilities: parsed.data.capability_tier.capabilities
      ? [...parsed.data.capability_tier.capabilities]
      : defaultCapabilities(rule.mediaKind, parsed.data.capability_tier.params),
    ...(officialPriceSource
      ? { officialPriceSource }
      : {}),
    params: { ...parsed.data.capability_tier.params },
    price: {
      unit: priceUnit,
      points: rule.unitPriceFen,
    },
    status,
  };
}

/** Deduplicate bad overlapping rows deterministically: newest row wins. */
export function capabilityTiersFromPricingRules(
  rules: readonly ActivePricingRuleRecord[],
): GenerationCapabilityTier[] {
  const seen = new Set<string>();
  const tiers: GenerationCapabilityTier[] = [];
  for (const rule of rules) {
    const tier = capabilityTierFromPricingRule(rule);
    if (!tier || seen.has(tier.tierId)) continue;
    seen.add(tier.tierId);
    tiers.push(tier);
  }
  const activeTiers = tiers.filter((tier) => tier.status === "active");
  if (activeTiers.length === 0) return tiers;
  const explicitDefault = activeTiers.findIndex((tier) => tier.isDefault);
  const defaultIndex = explicitDefault >= 0
    ? explicitDefault
    : activeTiers.reduce(
        (best, tier, index) => tier.price.points < activeTiers[best]!.price.points ? index : best,
        0,
      );
  const defaultTierId = activeTiers[defaultIndex]!.tierId;
  return tiers.map((tier) => ({
    ...tier,
    isDefault: tier.status === "active" && tier.tierId === defaultTierId,
  }));
}

function priceUnitFor(
  mediaType: CapabilityTierMediaType,
  billingUnit: string,
): "per_image" | "per_second" | "per_10k_characters" | null {
  if (mediaType === "image" && billingUnit === "image") return "per_image";
  if ((mediaType === "video" || mediaType === "audio") && billingUnit === "second") return "per_second";
  if (mediaType === "audio" && billingUnit === "ten_thousand_characters") {
    return "per_10k_characters";
  }
  return null;
}

function providerDisplayName(provider: string): string {
  switch (provider.trim().toLowerCase()) {
    case "ark":
      return "火山方舟";
    case "openspeech":
      return "火山语音";
    case "minimax":
      return "MiniMax";
    default:
      return "其他供应商";
  }
}

function defaultModelDisplayName(model: string): string {
  return model
    .replace(/^doubao-/u, "")
    .replace(/-\d{6}$/u, "")
    .replace(/[-_]+/gu, " ")
    .trim() || "模型";
}

function defaultTierDisplayName(rule: ActivePricingRuleRecord, tierId: string): string {
  const model = defaultModelDisplayName(rule.model);
  return model === "模型" ? tierId : model;
}

function defaultCapabilities(
  mediaType: CapabilityTierMediaType,
  params: Record<string, string | number | boolean>,
): string[] {
  return [...new Set([
    mediaType,
    ...Object.keys(params)
      .filter((key) => !["quantity", "watermark", "aigc_metadata_enabled", "aigc_watermark_enabled"].includes(key))
      .sort(),
  ])];
}
