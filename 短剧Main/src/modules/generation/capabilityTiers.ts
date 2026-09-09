import { z } from "zod";
import { settings } from "../../config/env.js";
import { GenerationError } from "./errors.js";
import {
  assessTierPricingRule,
  isRetiredGenerationTier,
  type TierPricingGuardContext,
} from "./tierPricingGuard.js";
import type { GenerationMediaKind, GenerationParameters, NormalizedGenerationInput } from "./types.js";
import { normalizeV01Parameters, V01GenerationContractError } from "./v01Contract.js";

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

export interface TierPricingRule {
  id: string;
  provider: string;
  model: string;
  mediaKind: GenerationMediaKind;
  billingUnit: "request" | "image" | "second" | "ten_thousand_characters";
  unitPriceFen: number;
  metadata: Record<string, unknown>;
}

export interface ResolvedGenerationTier {
  tierId: string;
  rule: TierPricingRule;
  parameters: GenerationParameters;
  quantity: number;
}

/**
 * The tier is projected directly from a current pricing rule. There is no
 * environment registry or second price table: retiring the rule metadata
 * immediately removes the tier from quote, confirm and submit.
 */
export function resolveTierFromPricingRule(
  rule: TierPricingRule,
  guardContext: TierPricingGuardContext = runtimeGuardContext(),
): ResolvedGenerationTier | null {
  const parsed = tierMetadataSchema.safeParse(rule.metadata);
  if (!parsed.success || parsed.data.capability_tier.status !== "active") return null;
  if (isRetiredGenerationTier(parsed.data.capability_tier.tier_id)) return null;
  if (!assessTierPricingRule({ ...rule, active: true }, guardContext).quoteable) return null;
  const metadata = parsed.data.capability_tier;
  const quantity = readQuantity(metadata.params.quantity);
  if (!quantity) return null;
  try {
    return {
      tierId: metadata.tier_id,
      rule,
      parameters: normalizeV01Parameters({
        mediaKind: rule.mediaKind,
        model: rule.model,
        parameters: providerParameters(rule.mediaKind, metadata.params),
        quantity,
      }),
      quantity,
    };
  } catch (error) {
    if (error instanceof V01GenerationContractError) return null;
    throw error;
  }
}

/**
 * Resolve from newest-to-oldest current rows without letting an invalid or
 * experimental row shadow an older approved tier for the same model.
 */
export function resolveTierFromPricingRules(
  rules: readonly TierPricingRule[],
  selection: { model?: string; tierId?: string } = {},
  guardContext: TierPricingGuardContext = runtimeGuardContext(),
): ResolvedGenerationTier | null {
  for (const rule of rules) {
    if (selection.model !== undefined && rule.model !== selection.model) continue;
    const tier = resolveTierFromPricingRule(rule, guardContext);
    if (!tier || (selection.tierId !== undefined && tier.tierId !== selection.tierId)) continue;
    return tier;
  }
  return null;
}

function runtimeGuardContext(): TierPricingGuardContext {
  return { companyProviderAllowlist: settings.companyProviderAllowlist };
}

export function requireTierMatchesInput(
  tier: ResolvedGenerationTier,
  input: Pick<NormalizedGenerationInput, "tierId" | "mediaKind" | "model" | "parameters" | "quantity">,
): ResolvedGenerationTier {
  const matches = tier.tierId === input.tierId
    && tier.rule.mediaKind === input.mediaKind
    && tier.rule.model === input.model
    && tier.quantity === input.quantity
    && (input.mediaKind === "audio"
      ? sameAudioTierParameters(tier.parameters, input.parameters)
      : input.mediaKind === "video" && tier.parameters.preview === true
        ? sameVideoPreviewTierParameters(tier.parameters, input.parameters)
        : sameParameters(tier.parameters, input.parameters));
  if (!matches) {
    throw tierError("生成参数必须与所选档位完全一致，请重新选择档位");
  }
  return tier;
}

/**
 * 预览档(快乐马)只冻结预览身份与内容标识:preview 必须仍为 true、watermark 必须一致。
 * 分辨率/画幅/时长是 2026-08-19 参数化裁定开放的可调项,已由 normalizeV01Parameters
 * 按快乐马能力表校验;generateAudio 是创意开关。这里只保证不会把预览档偷换成正片档。
 */
function sameVideoPreviewTierParameters(tier: GenerationParameters, input: GenerationParameters): boolean {
  return tier.preview === true
    && input.preview === true
    && tier.watermark === input.watermark;
}

/**
 * An audio tier freezes only price-bearing and output-format facts. Voice
 * choice and the three performance sliders are creative input, so comparing
 * the whole normalized record would silently turn the promised open controls
 * into immutable tier constants.
 */
function sameAudioTierParameters(tier: GenerationParameters, input: GenerationParameters): boolean {
  return tier.originalDurationSeconds === input.originalDurationSeconds
    && tier.format === input.format
    && tier.sampleRate === input.sampleRate;
}

export function requireTierId(tierId: string | undefined): string {
  const normalized = tierId?.trim();
  if (!normalized) throw tierError("请先选择生成档位");
  return normalized;
}

export function tierError(message: string): GenerationError {
  return new GenerationError("INVALID_GENERATION_REQUEST", message, 422);
}

function providerParameters(
  mediaKind: GenerationMediaKind,
  params: Record<string, string | number | boolean>,
): GenerationParameters {
  if (mediaKind === "image") {
    const size = stringValue(params.resolution) ?? stringValue(params.size);
    const ratio = stringValue(params.aspect_ratio) ?? stringValue(params.ratio);
    const watermark = booleanValue(params.watermark);
    const sequentialImageGeneration = asSequentialMode(
      stringValue(params.sequential_image_generation) ?? stringValue(params.sequentialImageGeneration),
    );
    return {
      ...(size !== undefined ? { size } : {}),
      ...(ratio !== undefined ? { ratio } : {}),
      ...(watermark !== undefined ? { watermark } : {}),
      ...(sequentialImageGeneration !== undefined ? { sequentialImageGeneration } : {}),
    };
  }
  if (mediaKind === "audio") {
    return {
      originalDurationSeconds: numberValue(params.original_duration_seconds) ?? numberValue(params.originalDurationSeconds),
      format: audioFormat(stringValue(params.format)),
      sampleRate: numberValue(params.sample_rate) ?? numberValue(params.sampleRate),
      speechRate: numberValue(params.speech_rate) ?? numberValue(params.speechRate),
      loudnessRate: numberValue(params.loudness_rate) ?? numberValue(params.loudnessRate),
      pitchRate: numberValue(params.pitch_rate) ?? numberValue(params.pitchRate),
      enableSubtitle: booleanValue(params.enable_subtitle) ?? booleanValue(params.enableSubtitle),
      aigcMetadataEnabled: booleanValue(params.aigc_metadata_enabled) ?? booleanValue(params.aigcMetadataEnabled),
      aigcWatermarkEnabled: booleanValue(params.aigc_watermark_enabled) ?? booleanValue(params.aigcWatermarkEnabled),
    };
  }
  return {
    resolution: stringValue(params.resolution),
    ratio: stringValue(params.aspect_ratio) ?? stringValue(params.ratio),
    durationSeconds: numberValue(params.duration_seconds) ?? numberValue(params.durationSeconds),
    watermark: booleanValue(params.watermark),
    generateAudio: booleanValue(params.generate_audio) ?? booleanValue(params.generateAudio),
    preview: booleanValue(params.preview),
  };
}

function audioFormat(value: string | undefined): "mp3" | "wav" | "pcm" | undefined {
  return value === "mp3" || value === "wav" || value === "pcm" ? value : undefined;
}

function readQuantity(value: string | number | boolean | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stringValue(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: string | number | boolean | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: string | number | boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asSequentialMode(value: string | undefined): "auto" | "disabled" | undefined {
  return value === "auto" || value === "disabled" ? value : undefined;
}

function sameParameters(left: GenerationParameters, right: GenerationParameters): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]));
}
