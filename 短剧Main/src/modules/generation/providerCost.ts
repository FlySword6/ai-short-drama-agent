import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  GenerationMediaKind,
  GenerationParameters,
  ProviderResultSnapshot,
} from "./types.js";

export const PROVIDER_COST_CALCULATION_VERSION = "s84-v1";

const parameterMatchValueSchema = z.union([
  z.string().trim().min(1).max(128),
  z.array(z.string().trim().min(1).max(128)).min(1).max(16),
]);

const requestQuantityFallbackSchema = z.object({
  kind: z.literal("request_quantity"),
}).strict();

const videoTokenFormulaFallbackSchema = z.object({
  kind: z.literal("video_token_formula"),
  frames_per_second: z.number().int().positive().max(240),
  token_divisor: z.number().int().positive().max(1_000_000),
  pixel_count_by_resolution_ratio: z.record(
    z.string().trim().min(1).max(32),
    z.record(
      z.string().trim().min(1).max(16),
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ),
  ),
}).strict();

const requestedDurationFallbackSchema = z.object({
  kind: z.literal("requested_duration_ms"),
}).strict();

export const providerCostBasisPayloadSchema = z.object({
  provider: z.string().trim().min(1).max(32),
  model: z.string().trim().min(1).max(128),
  media_kind: z.enum(["image", "video", "audio"]),
  parameter_match: z.record(z.string().trim().min(1).max(64), parameterMatchValueSchema),
  billing_unit: z.enum(["image", "million_output_tokens", "millisecond"]),
  usage_keys: z.array(z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(64)).min(1).max(8),
  unit_price_cny_micros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  unit_size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.literal("CNY"),
  fallback: z.discriminatedUnion("kind", [
    requestQuantityFallbackSchema,
    videoTokenFormulaFallbackSchema,
    requestedDurationFallbackSchema,
  ]),
  source_url: z.string().url().max(512),
}).strict().superRefine((payload, context) => {
  const validShape = (payload.media_kind === "image"
      && payload.billing_unit === "image"
      && payload.fallback.kind === "request_quantity"
      && payload.unit_size === 1)
    || (payload.media_kind === "video"
      && payload.billing_unit === "million_output_tokens"
      && payload.fallback.kind === "video_token_formula"
      && payload.unit_size === 1_000_000)
    || (payload.media_kind === "audio"
      && payload.billing_unit === "millisecond"
      && payload.fallback.kind === "requested_duration_ms");
  if (!validShape) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "供应商成本的媒介、计费单位、除数与兜底公式不一致",
    });
  }
});

export type ProviderCostBasisPayload = z.infer<typeof providerCostBasisPayloadSchema>;

export interface ProviderCostConfigEntry {
  id: string;
  updatedAt: Date;
  payload: unknown;
}

export interface ProviderCostObservation {
  provider: string;
  model: string;
  mediaKind: GenerationMediaKind;
  parameters: GenerationParameters;
  quantity: number;
  result: ProviderResultSnapshot;
}

export interface ProviderCostRecordOutcome {
  status: "confirmed" | "estimated" | "unavailable";
  requiresAttention: boolean;
  failureCode?: string;
}

export type ProviderCostCalculation =
  | {
      status: "confirmed" | "estimated";
      usageSource: "provider_reported" | "formula_fallback";
      usageUnit: "images" | "tokens" | "milliseconds";
      usageQuantity: number;
      billingUnit: ProviderCostBasisPayload["billing_unit"];
      unitPriceCnyMicros: number;
      unitSize: number;
      costCnyMicros: number;
      costFenRounded: number;
      currency: "CNY";
      configEntryId: string;
      configUpdatedAt: Date;
      configChecksum: string;
      actualModelId: string;
      calculationVersion: typeof PROVIDER_COST_CALCULATION_VERSION;
      requiresAttention: boolean;
      failureCode: null;
    }
  | {
      status: "unavailable";
      usageSource: "unavailable";
      usageUnit: null;
      usageQuantity: null;
      billingUnit: null;
      unitPriceCnyMicros: null;
      unitSize: null;
      costCnyMicros: null;
      costFenRounded: null;
      currency: "CNY";
      configEntryId: null;
      configUpdatedAt: null;
      configChecksum: null;
      actualModelId: string;
      calculationVersion: typeof PROVIDER_COST_CALCULATION_VERSION;
      requiresAttention: true;
      failureCode: "cost_basis_missing" | "cost_basis_ambiguous" | "provider_usage_unavailable";
    };

interface ParsedCostBasis {
  id: string;
  updatedAt: Date;
  payload: ProviderCostBasisPayload;
  checksum: string;
}

interface BillableUsage {
  source: "provider_reported" | "formula_fallback";
  unit: "images" | "tokens" | "milliseconds";
  quantity: number;
}

export function calculateProviderCost(
  configEntries: readonly ProviderCostConfigEntry[],
  observation: ProviderCostObservation,
): ProviderCostCalculation {
  const actualModelId = observation.result.actualModelId?.trim() || observation.model.trim();
  const matching = configEntries.flatMap((entry) => {
    const parsed = providerCostBasisPayloadSchema.safeParse(entry.payload);
    if (!parsed.success) return [];
    const basis: ParsedCostBasis = {
      id: entry.id,
      updatedAt: entry.updatedAt,
      payload: parsed.data,
      checksum: providerCostConfigChecksum(parsed.data),
    };
    return matchesObservation(basis.payload, observation, actualModelId) ? [basis] : [];
  });

  if (matching.length === 0) return unavailable(actualModelId, "cost_basis_missing");
  if (matching.length > 1) return unavailable(actualModelId, "cost_basis_ambiguous");
  const basis = matching[0]!;
  const usage = providerReportedUsage(basis.payload, observation.result)
    ?? fallbackUsage(basis.payload, observation);
  if (!usage) return unavailable(actualModelId, "provider_usage_unavailable");

  const costNumerator = BigInt(basis.payload.unit_price_cny_micros) * BigInt(usage.quantity);
  const costCnyMicros = safeBigIntToNumber(
    costNumerator === 0n
      ? 0n
      : divideRoundUp(costNumerator, BigInt(basis.payload.unit_size)),
    "cost_cny_micros",
  );
  const costFenRounded = safeBigIntToNumber(
    (BigInt(costCnyMicros) + 5_000n) / 10_000n,
    "cost_fen_rounded",
  );
  const status = usage.source === "provider_reported" ? "confirmed" : "estimated";
  return {
    status,
    usageSource: usage.source,
    usageUnit: usage.unit,
    usageQuantity: usage.quantity,
    billingUnit: basis.payload.billing_unit,
    unitPriceCnyMicros: basis.payload.unit_price_cny_micros,
    unitSize: basis.payload.unit_size,
    costCnyMicros,
    costFenRounded,
    currency: "CNY",
    configEntryId: basis.id,
    configUpdatedAt: basis.updatedAt,
    configChecksum: basis.checksum,
    actualModelId,
    calculationVersion: PROVIDER_COST_CALCULATION_VERSION,
    requiresAttention: status === "estimated",
    failureCode: null,
  };
}

export function providerCostConfigChecksum(payload: ProviderCostBasisPayload): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function unavailable(
  actualModelId: string,
  failureCode: Extract<ProviderCostCalculation, { status: "unavailable" }>["failureCode"],
): ProviderCostCalculation {
  return {
    status: "unavailable",
    usageSource: "unavailable",
    usageUnit: null,
    usageQuantity: null,
    billingUnit: null,
    unitPriceCnyMicros: null,
    unitSize: null,
    costCnyMicros: null,
    costFenRounded: null,
    currency: "CNY",
    configEntryId: null,
    configUpdatedAt: null,
    configChecksum: null,
    actualModelId,
    calculationVersion: PROVIDER_COST_CALCULATION_VERSION,
    requiresAttention: true,
    failureCode,
  };
}

function matchesObservation(
  basis: ProviderCostBasisPayload,
  observation: ProviderCostObservation,
  actualModelId: string,
): boolean {
  if (basis.provider !== observation.provider.trim()
    || basis.model !== actualModelId
    || basis.media_kind !== observation.mediaKind) {
    return false;
  }
  return Object.entries(basis.parameter_match).every(([key, expected]) => {
    const actual = observation.parameters[key as keyof GenerationParameters];
    if (actual === undefined || actual === null) return false;
    const normalized = String(actual);
    return Array.isArray(expected) ? expected.includes(normalized) : expected === normalized;
  });
}

function providerReportedUsage(
  basis: ProviderCostBasisPayload,
  result: ProviderResultSnapshot,
): BillableUsage | undefined {
  for (const key of basis.usage_keys) {
    const quantity = readNonNegativeSafeInteger(
      result.usage?.[key],
      result.metadata?.[key],
      result.metadata?.[snakeToCamel(key)],
      key === "duration_ms" ? summedActualDurationMs(result) : undefined,
    );
    if (quantity === undefined) continue;
    return {
      source: "provider_reported",
      unit: usageUnit(basis.billing_unit),
      quantity,
    };
  }
  return undefined;
}

function fallbackUsage(
  basis: ProviderCostBasisPayload,
  observation: ProviderCostObservation,
): BillableUsage | undefined {
  if (observation.result.status !== "succeeded") return undefined;
  switch (basis.fallback.kind) {
    case "request_quantity": {
      const quantity = positiveSafeInteger(observation.quantity);
      return quantity === undefined
        ? undefined
        : { source: "formula_fallback", unit: "images", quantity };
    }
    case "requested_duration_ms": {
      const seconds = positiveSafeInteger(observation.parameters.originalDurationSeconds);
      const quantity = positiveSafeInteger(observation.quantity);
      if (seconds === undefined || quantity === undefined) return undefined;
      return {
        source: "formula_fallback",
        unit: "milliseconds",
        quantity: multiplySafe([seconds, 1_000, quantity], "fallback_duration_ms"),
      };
    }
    case "video_token_formula": {
      const resolution = stringValue(observation.parameters.resolution);
      const ratio = stringValue(observation.parameters.ratio);
      if (!resolution || !ratio) return undefined;
      const pixelCount = basis.fallback.pixel_count_by_resolution_ratio[resolution]?.[ratio];
      const durationSeconds = readPositiveSafeInteger(
        observation.result.usage?.duration_seconds,
        observation.result.metadata?.durationSeconds,
        observation.result.metadata?.duration_seconds,
        observation.parameters.durationSeconds,
      );
      const quantity = positiveSafeInteger(observation.quantity);
      if (pixelCount === undefined || durationSeconds === undefined || quantity === undefined) return undefined;
      const numerator = multiplyBigInt([
        pixelCount,
        basis.fallback.frames_per_second,
        durationSeconds,
        quantity,
      ]);
      return {
        source: "formula_fallback",
        unit: "tokens",
        quantity: safeBigIntToNumber(
          divideRoundUp(numerator, BigInt(basis.fallback.token_divisor)),
          "fallback_video_tokens",
        ),
      };
    }
  }
}

function usageUnit(
  billingUnit: ProviderCostBasisPayload["billing_unit"],
): BillableUsage["unit"] {
  if (billingUnit === "image") return "images";
  if (billingUnit === "millisecond") return "milliseconds";
  return "tokens";
}

function summedActualDurationMs(result: ProviderResultSnapshot): number | undefined {
  const durations = result.media.flatMap((media) => (
    media.actualDurationMs === undefined ? [] : [media.actualDurationMs]
  ));
  if (durations.length === 0
    || durations.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return undefined;
  }
  return safeBigIntToNumber(
    durations.reduce((total, value) => total + BigInt(value), 0n),
    "provider_duration_ms",
  );
}

function readNonNegativeSafeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

function readPositiveSafeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number") {
      const parsed = positiveSafeInteger(value);
      if (parsed !== undefined) return parsed;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = positiveSafeInteger(Number(value));
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function multiplySafe(values: readonly number[], field: string): number {
  return safeBigIntToNumber(multiplyBigInt(values), field);
}

function multiplyBigInt(values: readonly number[]): bigint {
  return values.reduce((product, value) => product * BigInt(value), 1n);
}

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n || denominator <= 0n) throw new Error("provider cost division requires positive integers");
  return (numerator + denominator - 1n) / denominator;
}

function safeBigIntToNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} exceeds the safe integer range`);
  return Number(value);
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
