import { z } from "zod";
import type {
  GenerationOperationReceipt,
  StoredGenerationOperation,
} from "./types.js";

const uuid = z.string().uuid();
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const generationParametersSchema = z.record(z.string(), z.unknown());

const contextSchema = z.object({
  projectId: uuid,
  episodeId: uuid.optional(),
  sceneId: uuid.optional(),
  shotId: uuid.optional(),
  selectedAsset: z.object({
    assetEntityId: uuid,
    mediaId: uuid,
    mediaKind: z.enum(["image", "video", "audio"]),
  }).strict().optional(),
  referenceMediaIds: z.array(uuid).max(20),
}).strict();

const targetSchema = z.object({
  placement: z.enum(["attach_to_shot", "project_asset", "replace_asset_variant"]),
  assetEntityId: uuid.optional(),
  shotId: uuid.optional(),
}).strict();

const controlSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  value: scalar,
  defaultValue: scalar,
  availability: z.enum([
    "adjustable",
    "fixed_by_tier",
    "frozen_context",
    "not_priced",
    "not_supported",
  ]),
  requiresRequote: z.boolean(),
  options: z.array(z.union([z.string(), z.number().finite(), z.boolean()])).max(64).optional(),
  range: z.object({
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive().optional(),
  }).strict().optional(),
  note: z.string().trim().min(1).max(500).optional(),
}).strict();

const groupSchema = z.object({
  key: z.enum(["visual", "motion", "audio", "cost"]),
  label: z.string().trim().min(1).max(32),
  controls: z.array(controlSchema).max(64),
}).strict();

const storedOperationSchema = z.object({
  schemaVersion: z.literal("v0.4.0"),
  executionMode: z.enum(["mock", "real"]),
  operationType: z.enum(["generate", "edit"]),
  inputMode: z.enum([
    "text_to_image",
    "image_to_image",
    "text_to_video",
    "image_to_video",
    "video_to_video",
    "text_to_audio",
  ]),
  mediaKind: z.enum(["image", "video", "audio"]),
  prompt: z.string().trim().min(1).max(100_000),
  context: contextSchema,
  target: targetSchema,
  referenceMediaIds: z.array(uuid).max(20),
  referenceMedia: z.array(z.object({
    mediaId: uuid,
    kind: z.enum(["image", "video", "audio"]),
    role: z.string().trim().min(1).max(64).optional(),
  }).strict()).max(20),
  selectedMediaId: uuid.optional(),
  tier: z.object({
    tierId: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(160),
    providerLabel: z.string().trim().min(1).max(80),
    modelLabel: z.string().trim().min(1).max(160),
  }).strict(),
  defaults: generationParametersSchema,
  parameterGroups: z.array(groupSchema).length(4),
  quote: z.object({
    mode: z.enum(["mock", "real"]),
    generationQuoteId: uuid.nullable(),
    estimatedCostFen: z.number().int().nonnegative(),
    currency: z.literal("CNY"),
    billingUnit: z.string().trim().min(1).max(64),
    billableUnits: z.number().int().positive(),
    expiresAt: z.string().datetime().nullable(),
    notice: z.string().trim().min(1).max(500),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict();

const receiptSchema = z.object({
  operationId: uuid,
  status: z.enum(["queued", "succeeded"]),
  executionMode: z.enum(["mock", "real"]),
  generationRequestId: uuid.nullable(),
  attemptId: z.string().trim().min(1).max(128),
  target: targetSchema,
  artifact: z.object({
    mediaKind: z.enum(["image", "video", "audio"]),
    storageState: z.enum(["simulated", "persisted", "pending"]),
    storageUrl: z.string().url().nullable(),
  }).strict(),
  ledger: z.object({
    estimatedCostFen: z.number().int().nonnegative(),
    chargedCostFen: z.number().int().nonnegative().nullable(),
    pointsSpent: z.number().int().nonnegative().nullable(),
    currency: z.literal("CNY"),
  }).strict(),
  timeline: z.array(z.object({
    state: z.enum(["accepted", "running", "succeeded"]),
    offsetMs: z.number().int().nonnegative(),
  }).strict()).min(1).max(10),
  message: z.string().trim().min(1).max(500),
}).strict();

export function serializeStoredOperation(
  operation: StoredGenerationOperation,
): Record<string, unknown> {
  return {
    ...operation,
    quote: {
      ...operation.quote,
      expiresAt: operation.quote.expiresAt?.toISOString() ?? null,
    },
    createdAt: operation.createdAt.toISOString(),
  };
}

export function parseStoredOperation(value: unknown): StoredGenerationOperation | null {
  const parsed = storedOperationSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    defaults: parsed.data.defaults,
    quote: {
      ...parsed.data.quote,
      expiresAt: parsed.data.quote.expiresAt
        ? new Date(parsed.data.quote.expiresAt)
        : null,
    },
    createdAt: new Date(parsed.data.createdAt),
  } as StoredGenerationOperation;
}

export function parseOperationReceipt(value: unknown): GenerationOperationReceipt | null {
  const parsed = receiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
