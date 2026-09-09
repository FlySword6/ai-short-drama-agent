import {
  ARK_SEEDANCE_2_5_ENDPOINT_MODEL,
  ARK_SEEDANCE_2_FAST_MODEL,
  ARK_SEEDANCE_2_MINI_MODEL,
  ARK_SEEDANCE_2_MODEL,
  ARK_SEEDREAM_5_PRO_MODEL,
} from "./v01Contract.js";
import {
  isCompanyProviderAllowed,
  normalizeCompanyProviderAllowlist,
} from "../../shared/companyProviderPolicy.js";

export const ARK_TIER_PRICE_CATALOG_VERSION = "ark-2026-08-01";
export const ARK_OFFICIAL_PRICE_SOURCE_URL =
  "https://www.volcengine.com/docs/82379/1544106";
export const ARK_OFFICIAL_PRICE_SOURCE_CHECKED_AT =
  "2026-07-31T16:24:32.000Z";

export type TierAvailabilityCode =
  | "available"
  | "dev_smoke_only"
  | "billing_unverified"
  | "pricing_unverified"
  | "parameter_matrix_unverified"
  | "provider_not_enabled"
  | "product_decision_pending";

export interface TierAvailabilityAssessment {
  code: TierAvailabilityCode;
  reason: string;
  quoteable: boolean;
  expectedUnitPriceFen?: number;
  officialCostFenPerUnit?: number;
  priceCatalogVersion?: string;
}

export interface TierPricingRuleForGuard {
  provider: string;
  model: string;
  mediaKind: "image" | "video" | "audio";
  billingUnit: "request" | "image" | "second" | "ten_thousand_characters" | string;
  unitPriceFen: number;
  metadata: Record<string, unknown>;
  active?: boolean;
}

export interface TierPricingGuardContext {
  companyProviderAllowlist?: readonly string[];
  /**
   * Runtime quote/catalog paths must leave this false. Only a controlled
   * dev-target script that has already verified its database identity may
   * temporarily inspect an old dev-smoke row as quoteable.
   */
  allowDevSmoke?: boolean;
}

export interface ArkTierPriceDefinition {
  tierId: string;
  provider: "ark";
  model: string;
  mediaKind: "image" | "video";
  billingUnit: "image" | "second";
  status: "verified" | "pending_parameter_matrix";
  officialCostFenPerUnit?: number;
  platformUnitPriceFen?: number;
  sourceUrl: string;
  sourceCheckedAt: string;
  catalogVersion: string;
  priceFormula: string;
  requiredParams: Readonly<Record<string, string | number | boolean>>;
  durationRangeSeconds?: readonly [number, number];
  legacyPaidEvidence?: boolean;
}

interface CapabilityTierMetadata {
  tierId: string;
  status: "active" | "experimental" | "retired";
  params: Record<string, string | number | boolean>;
}

const LEGACY_FORMAL_TIER_IDS = new Set([
  "img-seedream5pro-169-2k-1",
  "vid-seedance20fast-916-720p-4s",
]);
const RETIRED_TIER_IDS = new Set([
  "vid-seedance20fast-916-720p-4s-lf",
]);

const VERIFIED_PRICE_SOURCE_KINDS = new Set(["实测", "内部定价"]);
const OFFICIAL_ROUNDING_INCREMENT_FEN = 5;
const VIDEO_FPS = 24;

const IMAGE_DEFINITIONS: readonly ArkTierPriceDefinition[] = [
  imageDefinition("img-seedream5pro-169-1k-1", "16:9", "1K", 30),
  imageDefinition("img-seedream5pro-916-1k-1", "9:16", "1K", 30),
  imageDefinition("img-seedream5pro-11-1k-1", "1:1", "1K", 30),
  imageDefinition(
    "img-seedream5pro-169-2k-1",
    "16:9",
    "2K",
    60,
    { legacyPaidEvidence: true },
  ),
  imageDefinition("img-seedream5pro-916-2k-1", "9:16", "2K", 60),
  imageDefinition("img-seedream5pro-11-2k-1", "1:1", "2K", 60),
];

const TIER_UNFREEZE_VIDEO_IDS = new Set([
  "vid-seedance20fast-169-480p",
  "vid-seedance20fast-916-480p",
]);

const VIDEO_DEFINITIONS: readonly ArkTierPriceDefinition[] = [
  ...videoFamilyDefinitions({
    model: ARK_SEEDANCE_2_MODEL,
    idPrefix: "vid-seedance20",
    listPrices: { "480p": 46, "720p": 46, "1080p": 51, "4k": 26 },
  }),
  ...videoFamilyDefinitions({
    model: ARK_SEEDANCE_2_FAST_MODEL,
    idPrefix: "vid-seedance20fast",
    listPrices: { "480p": 37, "720p": 37 },
  }),
  ...videoFamilyDefinitions({
    model: ARK_SEEDANCE_2_MINI_MODEL,
    idPrefix: "vid-seedance20mini",
    listPrices: { "480p": 23, "720p": 23 },
  }),
  {
    ...videoDefinition({
      tierId: "vid-seedance20fast-916-720p-4s",
      model: ARK_SEEDANCE_2_FAST_MODEL,
      ratio: "9:16",
      resolution: "720p",
      yuanPerMillionTokens: 37,
    }),
    requiredParams: {
      aspect_ratio: "9:16",
      resolution: "720p",
      duration_seconds: 4,
      watermark: false,
      quantity: 1,
    },
    durationRangeSeconds: undefined,
    legacyPaidEvidence: true,
  },
  {
    ...videoDefinition({
      tierId: "vid-seedance25-ep-916-720p-4s",
      model: ARK_SEEDANCE_2_5_ENDPOINT_MODEL,
      ratio: "9:16",
      resolution: "720p",
      yuanPerMillionTokens: 70,
    }),
    requiredParams: {
      aspect_ratio: "9:16",
      resolution: "720p",
      duration_seconds: 4,
      watermark: false,
      quantity: 1,
    },
    durationRangeSeconds: undefined,
    priceFormula:
      "921600像素×24fps÷1024×70元/百万token(arkcli pricing models 2026-08-08 账号折后价 NV2VCompletion 0.07 元/千 token,非官网刊例)",
  },
].map((definition) => TIER_UNFREEZE_VIDEO_IDS.has(definition.tierId)
  ? {
      ...definition,
      requiredParams: {
        ...definition.requiredParams,
        generate_audio: false,
      },
    }
  : definition);

const PRICE_DEFINITIONS = new Map(
  [...IMAGE_DEFINITIONS, ...VIDEO_DEFINITIONS].map((definition) => [
    definition.tierId,
    definition,
  ]),
);

export function arkTierPriceDefinition(
  tierId: string,
): ArkTierPriceDefinition | undefined {
  return PRICE_DEFINITIONS.get(tierId);
}

/** Product has retired this tier; keep the deny-list only to reject stale DB rows. */
export function isRetiredGenerationTier(tierId: string): boolean {
  return RETIRED_TIER_IDS.has(tierId);
}

export function listArkTierPriceDefinitions(): readonly ArkTierPriceDefinition[] {
  return [...PRICE_DEFINITIONS.values()];
}

/**
 * One decision function is shared by quote resolution, the public catalog,
 * admin writes and the controlled activation script. Database metadata may
 * carry evidence, but it cannot invent an official price: the expected value
 * comes from the versioned catalog above.
 */
export function assessTierPricingRule(
  rule: TierPricingRuleForGuard,
  context: TierPricingGuardContext = {},
): TierAvailabilityAssessment {
  const tier = readCapabilityTier(rule.metadata);
  if (!tier) return unavailable("pricing_unverified", "档位缺少可核验的参数与价格登记");
  if (isRetiredGenerationTier(tier.tierId)) {
    return unavailable("product_decision_pending", "尾帧延长档已下架，请重新选择视频档位");
  }
  const provider = rule.provider.trim().toLowerCase();
  if (!isCompanyProviderAllowed(
    provider,
    normalizeCompanyProviderAllowlist(context.companyProviderAllowlist),
  )) {
    return unavailable("provider_not_enabled", "该供应商未开通公司账户");
  }

  if (rule.active === false || tier.status !== "active") {
    const explicit = readExplicitAvailability(rule.metadata);
    if (explicit && explicit.code !== "available" && explicit.code !== "dev_smoke_only") {
      return { ...explicit, quoteable: false };
    }
    return defaultFrozenAssessment(rule, tier);
  }

  if (rule.metadata.price_source_kind === "官方牌价×加成率(推算)") {
    return unavailable("billing_unverified", "官方价格已登记，尚未完成本档实测与账单核对");
  }

  if (provider === "ark") {
    return assessArkTier(rule, tier, context);
  }

  // This goal replaces the Ark fixed-floor guard only. Existing active
  // company-routed tiers such as Seed Audio keep the pre-existing contract:
  // positive price + non-inferred provenance. Their provider-specific price
  // catalogs are owned by their own integrations, not the Ark image/video
  // catalog above.
  if (provider === "openspeech"
    && Number.isSafeInteger(rule.unitPriceFen)
    && rule.unitPriceFen > 0) {
    return available();
  }
  if (VERIFIED_PRICE_SOURCE_KINDS.has(String(rule.metadata.price_source_kind))
    && Number.isSafeInteger(rule.unitPriceFen)
    && rule.unitPriceFen > 0) {
    return available();
  }
  return unavailable("pricing_unverified", "该档位尚未完成价格核验");
}

export function pricingVerificationMetadata(
  definition: ArkTierPriceDefinition,
): Record<string, unknown> {
  if (definition.status !== "verified"
    || definition.officialCostFenPerUnit === undefined
    || definition.platformUnitPriceFen === undefined) {
    throw new Error(`${definition.tierId}:官方价格目录尚未核准`);
  }
  return {
    status: "verified",
    catalog_version: definition.catalogVersion,
    official_cost_fen_per_unit: definition.officialCostFenPerUnit,
    platform_unit_price_fen: definition.platformUnitPriceFen,
    billing_unit: definition.billingUnit,
    markup_multiplier: 1,
    rounding_increment_fen: OFFICIAL_ROUNDING_INCREMENT_FEN,
    source_url: definition.sourceUrl,
    source_checked_at: definition.sourceCheckedAt,
    price_formula: definition.priceFormula,
  };
}

function assessArkTier(
  rule: TierPricingRuleForGuard,
  tier: CapabilityTierMetadata,
  context: TierPricingGuardContext,
): TierAvailabilityAssessment {
  const definition = arkTierPriceDefinition(tier.tierId);
  if (!definition) {
    return unavailable("pricing_unverified", "官方价格目录中没有这一档，暂不能报价");
  }
  if (definition.status !== "verified") {
    return unavailable("parameter_matrix_unverified", "该参数组合尚未完成官方能力矩阵核对");
  }
  const identityError = validateDefinitionIdentity(rule, tier, definition);
  if (identityError) return unavailable("parameter_matrix_unverified", identityError);
  if (rule.unitPriceFen !== definition.platformUnitPriceFen) {
    return {
      ...unavailable(
        "pricing_unverified",
        `档位价格与官方目录不一致，应为 ${definition.platformUnitPriceFen} 积分`,
      ),
      expectedUnitPriceFen: definition.platformUnitPriceFen,
      officialCostFenPerUnit: definition.officialCostFenPerUnit,
      priceCatalogVersion: definition.catalogVersion,
    };
  }

  const verified = {
    expectedUnitPriceFen: definition.platformUnitPriceFen,
    officialCostFenPerUnit: definition.officialCostFenPerUnit,
    priceCatalogVersion: definition.catalogVersion,
  };
  if (LEGACY_FORMAL_TIER_IDS.has(tier.tierId)
    && VERIFIED_PRICE_SOURCE_KINDS.has(String(rule.metadata.price_source_kind))) {
    return { ...available(), ...verified };
  }
  if (rule.metadata.activation_scope === "dev_smoke_only") {
    return {
      code: "dev_smoke_only",
      reason: context.allowDevSmoke
        ? "仅供受控开发脚本逐档实测，尚未完成正式核账与上档"
        : "开发冒烟档不能进入普通用户报价链",
      quoteable: context.allowDevSmoke === true,
      ...verified,
    };
  }
  if (!VERIFIED_PRICE_SOURCE_KINDS.has(String(rule.metadata.price_source_kind))
    || !hasActivationEvidence(rule.metadata)) {
    return {
      ...unavailable("billing_unverified", "官方价格已匹配，尚缺本档实测与账单核对证据"),
      ...verified,
    };
  }
  return { ...available(), ...verified };
}

function defaultFrozenAssessment(
  rule: TierPricingRuleForGuard,
  tier: CapabilityTierMetadata,
): TierAvailabilityAssessment {
  const provider = rule.provider.trim().toLowerCase();
  if (provider !== "ark") {
    return unavailable("product_decision_pending", "该档位等待产品负责人确认开放范围");
  }
  const definition = arkTierPriceDefinition(tier.tierId);
  if (!definition) return unavailable("pricing_unverified", "该档位没有已核准的官方价格");
  if (definition.status === "pending_parameter_matrix") {
    return unavailable("parameter_matrix_unverified", "该参数组合尚未完成官方能力矩阵核对");
  }
  const identityError = validateDefinitionIdentity(rule, tier, definition);
  if (identityError) return unavailable("parameter_matrix_unverified", identityError);
  if (rule.unitPriceFen !== definition.platformUnitPriceFen) {
    return {
      ...unavailable(
        "pricing_unverified",
        `档位价格与官方目录不一致，应为 ${definition.platformUnitPriceFen} 积分`,
      ),
      expectedUnitPriceFen: definition.platformUnitPriceFen,
      officialCostFenPerUnit: definition.officialCostFenPerUnit,
      priceCatalogVersion: definition.catalogVersion,
    };
  }
  return unavailable("billing_unverified", "官方价格已匹配，尚未完成本档实测与账单核对");
}

function validateDefinitionIdentity(
  rule: TierPricingRuleForGuard,
  tier: CapabilityTierMetadata,
  definition: ArkTierPriceDefinition,
): string | null {
  if (rule.provider.trim().toLowerCase() !== definition.provider
    || rule.model !== definition.model
    || rule.mediaKind !== definition.mediaKind
    || rule.billingUnit !== definition.billingUnit) {
    return "档位的供应商、模型或计费单位与官方价格目录不一致";
  }
  for (const [key, expected] of Object.entries(definition.requiredParams)) {
    if (tier.params[key] !== expected) return `档位参数 ${key} 与官方能力目录不一致`;
  }
  if (definition.durationRangeSeconds) {
    const duration = tier.params.duration_seconds;
    if (duration !== undefined && (
      typeof duration !== "number"
      || !Number.isSafeInteger(duration)
      || duration < definition.durationRangeSeconds[0]
      || duration > definition.durationRangeSeconds[1]
    )) {
      return `档位参数 duration_seconds 必须在 ${definition.durationRangeSeconds[0]}-${definition.durationRangeSeconds[1]} 秒`;
    }
  }
  return null;
}

function readCapabilityTier(
  metadata: Record<string, unknown>,
): CapabilityTierMetadata | null {
  const raw = metadata.capability_tier;
  if (!isRecord(raw)) return null;
  const tierId = raw.tier_id;
  const status = raw.status;
  const params = raw.params;
  if (typeof tierId !== "string" || !tierId.trim() || !isRecord(params)) return null;
  if (status !== "active" && status !== "experimental" && status !== "retired") return null;
  const scalarParams: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return null;
    }
    scalarParams[key] = value;
  }
  return { tierId, status, params: scalarParams };
}

function readExplicitAvailability(
  metadata: Record<string, unknown>,
): Omit<TierAvailabilityAssessment, "quoteable"> | null {
  const raw = metadata.tier_availability;
  if (!isRecord(raw) || !isAvailabilityCode(raw.code) || typeof raw.reason !== "string") return null;
  const reason = raw.reason.trim();
  return reason ? { code: raw.code, reason } : null;
}

function hasActivationEvidence(metadata: Record<string, unknown>): boolean {
  const evidence = metadata.activation_evidence;
  if (!isRecord(evidence)) return false;
  return typeof evidence.batch_id === "string"
    && evidence.batch_id.trim().length > 0
    && typeof evidence.evidence_sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(evidence.evidence_sha256)
    && typeof evidence.provider_task_fingerprint === "string"
    && /^[0-9a-f]{16,64}$/u.test(evidence.provider_task_fingerprint)
    && typeof evidence.artifact_sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(evidence.artifact_sha256)
    && typeof evidence.provider_billing_reference === "string"
    && evidence.provider_billing_reference.trim().length > 0
    && evidence.provider_billing_reference.length <= 240
    && typeof evidence.guard_deployed_commit === "string"
    && /^[0-9a-f]{7,40}$/u.test(evidence.guard_deployed_commit)
    && typeof evidence.smoke_completed_at === "string"
    && isIsoTimestamp(evidence.smoke_completed_at)
    && typeof evidence.account_checked_at === "string"
    && isIsoTimestamp(evidence.account_checked_at)
    && typeof evidence.platform_list_price_fen === "number"
    && Number.isSafeInteger(evidence.platform_list_price_fen)
    && evidence.platform_list_price_fen > 0
    && typeof evidence.provider_billed_fen === "number"
    && Number.isFinite(evidence.provider_billed_fen)
    && evidence.provider_billed_fen > 0;
}

function imageDefinition(
  tierId: string,
  ratio: string,
  resolution: string,
  priceFen: number,
  options: { legacyPaidEvidence?: boolean } = {},
): ArkTierPriceDefinition {
  return {
    tierId,
    provider: "ark",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    mediaKind: "image",
    billingUnit: "image",
    status: "verified",
    officialCostFenPerUnit: priceFen,
    platformUnitPriceFen: priceFen,
    sourceUrl: ARK_OFFICIAL_PRICE_SOURCE_URL,
    sourceCheckedAt: ARK_OFFICIAL_PRICE_SOURCE_CHECKED_AT,
    catalogVersion: ARK_TIER_PRICE_CATALOG_VERSION,
    priceFormula: resolution === "1K"
      ? "Seedream 5.0 Pro 1.5K及以下固定0.30元/张"
      : "历史2K档按已完成付费实测的0.60元/张",
    requiredParams: {
      aspect_ratio: ratio,
      resolution,
      watermark: false,
      sequential_image_generation: "disabled",
      quantity: 1,
    },
    ...(options.legacyPaidEvidence ? { legacyPaidEvidence: true } : {}),
  };
}

function videoFamilyDefinitions(input: {
  model: string;
  idPrefix: string;
  listPrices: Readonly<Record<string, number>>;
}): ArkTierPriceDefinition[] {
  return Object.entries(input.listPrices).flatMap(([resolution, listPrice]) => (
    (["16:9", "9:16", "1:1"] as const).map((ratio) => videoDefinition({
      tierId: `${input.idPrefix}-${ratio.replace(":", "")}-${resolution}`,
      model: input.model,
      ratio,
      resolution,
      yuanPerMillionTokens: listPrice,
    }))
  ));
}

function videoDefinition(input: {
  tierId: string;
  model: string;
  ratio: "16:9" | "9:16" | "1:1";
  resolution: string;
  yuanPerMillionTokens: number;
}): ArkTierPriceDefinition {
  const pixels = videoPixels(input.resolution, input.ratio === "1:1");
  const tokensPerSecond = (pixels * VIDEO_FPS) / 1024;
  const officialCostFenPerUnit =
    roundDecimal((tokensPerSecond * input.yuanPerMillionTokens) / 10_000, 6);
  return {
    tierId: input.tierId,
    provider: "ark",
    model: input.model,
    mediaKind: "video",
    billingUnit: "second",
    status: "verified",
    officialCostFenPerUnit,
    platformUnitPriceFen: ceilToIncrement(
      officialCostFenPerUnit,
      OFFICIAL_ROUNDING_INCREMENT_FEN,
    ),
    sourceUrl: ARK_OFFICIAL_PRICE_SOURCE_URL,
    sourceCheckedAt: ARK_OFFICIAL_PRICE_SOURCE_CHECKED_AT,
    catalogVersion: ARK_TIER_PRICE_CATALOG_VERSION,
    priceFormula:
      `${pixels}像素×${VIDEO_FPS}fps÷1024×${input.yuanPerMillionTokens}元/百万token`,
    requiredParams: {
      aspect_ratio: input.ratio,
      resolution: input.resolution,
      watermark: false,
      quantity: 1,
    },
    durationRangeSeconds: [4, 15],
  };
}

function videoPixels(resolution: string, square: boolean): number {
  if (resolution === "480p") return square ? 409_600 : 428_544;
  if (resolution === "720p") return 921_600;
  if (resolution === "1080p") return 2_073_600;
  if (resolution === "4k") return 8_294_400;
  throw new Error(`未登记的视频分辨率:${resolution}`);
}

function ceilToIncrement(value: number, increment: number): number {
  return Math.ceil((value - Number.EPSILON) / increment) * increment;
}

function roundDecimal(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function available(): TierAvailabilityAssessment {
  return { code: "available", reason: "已完成官方价格核验、逐档实测与账单核对", quoteable: true };
}

function unavailable(
  code: Exclude<TierAvailabilityCode, "available" | "dev_smoke_only">,
  reason: string,
): TierAvailabilityAssessment {
  return { code, reason, quoteable: false };
}

function isAvailabilityCode(value: unknown): value is TierAvailabilityCode {
  return value === "available"
    || value === "dev_smoke_only"
    || value === "billing_unverified"
    || value === "pricing_unverified"
    || value === "parameter_matrix_unverified"
    || value === "provider_not_enabled"
    || value === "product_decision_pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /T/u.test(value);
}
