import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { generationQuotes } from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";
import { GenerationError } from "../generation/errors.js";
import {
  createGenerationRepository,
  createGenerationService,
  requireGenerationSubmissionReady,
  type GenerationWorkerDependencies,
} from "../generation/factory.js";
import {
  hashGenerationRequest,
  normalizeGenerationInput,
} from "../generation/service.js";
import type {
  GenerationParameters,
  GenerationView,
  SubmitGenerationInput,
} from "../generation/types.js";
import type { AssistantSessionRow } from "./repository.js";
import { assistantConfirmationIdempotencyKey } from "./tools.js";

const uuid = z.string().uuid();
const referenceRole = z.enum([
  "reference_image",
  "first_frame",
  "last_frame",
  "reference_video",
  "reference_audio",
]);
const referenceSnapshotSchema = z.object({
  kind: z.enum(["image", "video", "audio"]),
  url: z.string().url().refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }),
  role: referenceRole.optional(),
}).strict();

const commonSnapshotShape = {
  projectId: uuid,
  episodeId: uuid.optional(),
  sceneId: uuid.optional(),
  shotId: uuid,
  targetAssetEntityId: uuid.optional(),
  model: z.string().trim().min(1).max(128),
  prompt: z.string().trim().min(1).max(100_000),
  referenceMediaIds: z.array(uuid).max(20),
  referenceAssetSnapshots: z.array(referenceSnapshotSchema).max(20),
  quantity: z.literal(1),
};

const assistantImageSnapshotSchema = z.object({
  ...commonSnapshotShape,
  mediaKind: z.literal("image"),
  parameters: z.object({
    size: z.literal("2K"),
    watermark: z.literal(false),
    sequentialImageGeneration: z.literal("disabled"),
  }).strict(),
}).strict();

const assistantVideoSnapshotSchema = z.object({
  ...commonSnapshotShape,
  mediaKind: z.literal("video"),
  parameters: z.object({
    resolution: z.literal("720p"),
    ratio: z.literal("9:16"),
    durationSeconds: z.literal(4),
    watermark: z.literal(false),
    generateAudio: z.boolean(),
  }).strict(),
}).strict();

const assistantGenerationSnapshotSchema = z.discriminatedUnion("mediaKind", [
  assistantImageSnapshotSchema,
  assistantVideoSnapshotSchema,
]).superRefine((snapshot, context) => {
  if (new Set(snapshot.referenceMediaIds).size !== snapshot.referenceMediaIds.length) {
    context.addIssue({
      code: "custom",
      path: ["referenceMediaIds"],
      message: "referenceMediaIds must be unique",
    });
  }
  if (snapshot.referenceMediaIds.length !== snapshot.referenceAssetSnapshots.length) {
    context.addIssue({
      code: "custom",
      path: ["referenceAssetSnapshots"],
      message: "reference snapshots must match reference media ids",
    });
  }
});

const orchestrationReferenceSnapshotSchema = z.object({
  kind: z.enum(["image", "video", "audio"]),
  url: z.string().trim().min(1).max(8_000).refine((value) => {
    if (/^asset:\/\/[^\s/?#]+$/u.test(value)) return true;
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }),
  role: referenceRole.optional(),
  mediaId: uuid.optional(),
}).strict();

const orchestrationGenerationSnapshotSchema = z.object({
  projectId: uuid,
  episodeId: uuid.optional(),
  sceneId: uuid.optional(),
  shotId: uuid.optional(),
  targetAssetEntityId: uuid.optional(),
  mediaKind: z.enum(["image", "video", "audio"]),
  tierId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(128),
  prompt: z.string().trim().min(1).max(100_000),
  parameters: z.record(z.string(), z.unknown()),
  referenceMediaIds: z.array(uuid).max(20),
  referenceAssetSnapshots: z.array(orchestrationReferenceSnapshotSchema).max(20),
  quantity: z.literal(1),
  productionMode: z.enum(["full", "sample"]),
}).strict().superRefine((snapshot, context) => {
  if (new Set(snapshot.referenceMediaIds).size !== snapshot.referenceMediaIds.length) {
    context.addIssue({
      code: "custom",
      path: ["referenceMediaIds"],
      message: "referenceMediaIds must be unique",
    });
  }
  if (snapshot.referenceMediaIds.length !== snapshot.referenceAssetSnapshots.length) {
    context.addIssue({
      code: "custom",
      path: ["referenceAssetSnapshots"],
      message: "reference snapshots must match reference media ids",
    });
  }
});

const restorableAssistantSnapshotSchema = z.union([
  assistantGenerationSnapshotSchema,
  orchestrationGenerationSnapshotSchema,
]);

export interface SubmitAssistantGenerationQuoteInput {
  actorId: string;
  /** Current server-authorized project capability, never supplied by the browser. */
  authorizedProjectId: string;
  session: Pick<AssistantSessionRow, "id" | "projectId" | "shotId">
    & Partial<AssistantSessionRow>;
  quoteId: string;
  paidGenerationEnabled?: boolean;
  generationReadiness?: GenerationWorkerDependencies;
}

/**
 * Submit an assistant quote from its server-side frozen snapshot. The browser
 * never sends the generation input back, so a model turn cannot reconstruct or
 * change paid parameters after the user clicks the confirmation button.
 */
export async function submitAssistantGenerationQuote(
  db: Database,
  input: SubmitAssistantGenerationQuoteInput,
): Promise<GenerationView> {
  // Do not reveal quote existence or touch PostgreSQL while paid work is
  // globally disabled or its common worker dependencies are unavailable.
  const readiness = {
    ...(input.generationReadiness ?? settings),
    allowPaidGeneration: input.paidGenerationEnabled ?? settings.allowPaidGeneration,
  };
  requireGenerationSubmissionReady(readiness);
  const quote = (await db.select({
    requestHash: generationQuotes.requestHash,
    normalizedRequest: generationQuotes.normalizedRequest,
  }).from(generationQuotes).where(and(
    eq(generationQuotes.id, input.quoteId),
    eq(generationQuotes.userId, input.actorId),
    eq(generationQuotes.source, "assistant"),
    eq(generationQuotes.action, "submit"),
    eq(generationQuotes.assistantSessionId, input.session.id),
  )).limit(1))[0];
  if (!quote) {
    throw new GenerationError(
      "GENERATION_QUOTE_NOT_FOUND",
      "当前助手会话没有这张生成费用报价单",
      404,
    );
  }

  const generationInput = restoreAssistantGenerationInput(
    quote.normalizedRequest,
    input.session,
    input.quoteId,
  );
  const normalized = normalizeGenerationInput(generationInput);
  // Once the immutable snapshot is restored, apply the media-specific provider
  // check (including Seed Audio's independent credentials).
  requireGenerationSubmissionReady(readiness, normalized.mediaKind);
  if (hashGenerationRequest(normalized) !== quote.requestHash) {
    throw invalidSnapshot();
  }

  if (input.session.projectId !== input.authorizedProjectId) {
    throw new GenerationError(
      "GENERATION_QUOTE_CONTEXT_MISMATCH",
      "当前授权项目与助手会话上下文不一致",
      403,
    );
  }
  const service = createGenerationService(createGenerationRepository(db));
  await service.confirmQuote({
    userId: input.actorId,
    authorizedProjectId: input.authorizedProjectId,
  }, input.quoteId);
  return service.submit({
    userId: input.actorId,
    authorizedProjectId: input.authorizedProjectId,
  }, generationInput, input.quoteId, "assistant");
}

export function restoreAssistantGenerationInput(
  snapshot: unknown,
  session: Pick<AssistantSessionRow, "projectId" | "shotId">,
  quoteId: string,
): SubmitGenerationInput {
  const parsed = restorableAssistantSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw invalidSnapshot();
  const orchestrationSnapshot = "tierId" in parsed.data;
  if (!session.projectId
    || parsed.data.projectId !== session.projectId
    || (orchestrationSnapshot
      ? Boolean(session.shotId && parsed.data.shotId !== session.shotId)
      : !session.shotId || parsed.data.shotId !== session.shotId)) {
    throw new GenerationError(
      "GENERATION_QUOTE_CONTEXT_MISMATCH",
      "报价单与当前助手会话的项目或分镜不一致",
      409,
    );
  }
  return {
    ...parsed.data,
    parameters: parsed.data.parameters as GenerationParameters,
    clientIdempotencyKey: assistantConfirmationIdempotencyKey(quoteId),
  };
}

export function requireAssistantPaidGenerationEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new AppError(403, "paid_generation_disabled", "真实生成尚未开启，不会产生付费调用");
  }
}

function invalidSnapshot(): GenerationError {
  return new GenerationError(
    "GENERATION_QUOTE_INVALID_SNAPSHOT",
    "生成费用报价单的冻结输入不完整或已变化，请重新报价",
    409,
  );
}
