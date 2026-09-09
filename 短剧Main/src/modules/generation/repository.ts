import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { settings } from "../../config/env.js";
import type { AudioPromptDimensions } from "../audio/types.js";
import { commonAssetReviewRejection } from "../assets/productionReviewGate.js";
import { SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS } from "../seedance-assets/policy.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  agentSessions,
  audioVersions,
  generationBatchAuthorizationItems,
  generationBatchAuthorizations,
  episodes,
  generationAttemptNotifications,
  generationAttempts,
  generationBillingFailureFacts,
  generationQuotes,
  generationRequests,
  mediaProvenanceParentEdges,
  mediaProvenanceSubjects,
  mediaResults,
  generationTosOrphans,
  pricingRules,
  projectAssetRefs,
  projectMembers,
  projects,
  scenes,
  seedanceAssetRegistrations,
  shotAssetRefs,
  shots,
  users,
  promptDefaultTemplates,
} from "../../db/schema.js";
import { errorBody, ForbiddenError } from "../../shared/errors.js";
import { canPerformProjectAction, resolveProjectAccess } from "../project-access/service.js";
import { GenerationAttemptLeaseLostError, GenerationError } from "./errors.js";
import { referenceImageViolation } from "./referencePrecheck.js";
import {
  DEFAULT_IMAGE_PROMPT_TEMPLATE,
  DEFAULT_VIDEO_PROMPT_TEMPLATE,
  type PromptCompilationContext,
  type PromptReferenceEntry,
} from "./promptCompiler.js";
import {
  initialMediaReviewStatus,
  recordAutoAcceptedAction,
  resolveMediaReviewStrategies,
} from "../reviews/mediaPolicy.js";
import {
  requireTierId,
  requireTierMatchesInput,
  resolveTierFromPricingRule,
  resolveTierFromPricingRules,
  tierError,
  type ResolvedGenerationTier,
} from "./capabilityTiers.js";
import { EffectiveShotMediaRepository } from "../shot-media/effectiveSelectionRepository.js";
import {
  estimateGenerationCost,
  generationPricingLockKey,
  type CostEstimate,
  type GenerationPricingRule,
} from "./cost.js";
import { PostgresProviderCostRepository } from "./providerCostRepository.js";
import type { CreateGenerationResult, GenerationRepository, GenerationWorkerLeaseRepository } from "./ports.js";
import {
  hashGenerationRequest,
  hashLegacyFullGenerationRequest,
  normalizeGenerationInput,
} from "./service.js";
import {
  normalizeV01Parameters,
  readReferenceSnapshots,
  isArkSeedance2Model,
  V01GenerationContractError,
} from "./v01Contract.js";
import type {
  AigcComplianceMetadata,
  BatchGenerationSubmitInput,
  GenerationBatchAuthorizationStatus,
  GenerationBatchItemStatus,
  GenerationBatchSubmissionView,
  GenerationFailedPage,
  GenerationFailedView,
  GenerationQuoteSource,
  GenerationQuoteView,
  GenerationAttemptNotificationView,
  GenerationInFlightPage,
  GenerationInFlightView,
  GenerationProductionMode,
  GenerationReferenceSnapshot,
  GenerationParameters,
  GenerationTosObjectReceipt,
  GenerationView,
  NormalizedGenerationInput,
  ProviderResultSnapshot,
  RecoverableGenerationContext,
  StoredGenerationMedia,
  SubmitGenerationInput,
} from "./types.js";

const budgetLockKey = 1_724_016;

type AttemptRow = typeof generationAttempts.$inferSelect;
type RequestRow = typeof generationRequests.$inferSelect;
type MediaRow = typeof mediaResults.$inferSelect;
type QuoteRow = typeof generationQuotes.$inferSelect;
type BatchAuthorizationRow = typeof generationBatchAuthorizations.$inferSelect;
type BatchAuthorizationItemRow = typeof generationBatchAuthorizationItems.$inferSelect;

export const ETA_HISTORY_SAMPLE_LIMIT = 20;
export const ETA_MINIMUM_SAMPLE_COUNT = 5;
/** One recovery retry after an operational persistence failure, then terminal. */
export const DEFAULT_PERSISTENCE_RETRY_LIMIT = 1;
/**
 * Server-only JSON stored alongside the frozen request parameters. It is
 * stripped before the V0.1 provider contract runs, and only restores the
 * structured audio directions after a worker restart. A migration is not
 * needed because `generation_requests.parameters` is already durable JSON.
 */
const AUDIO_PROMPT_DIMENSIONS_SNAPSHOT_KEY = "__s43AudioPromptDimensions";
const PRODUCTION_MODE_SNAPSHOT_KEY = "__s84ProductionMode";

/**
 * Worker claim and user-facing queue position must use one predicate. Keeping
 * it here prevents a UI "第 1 位" from drifting away from the next row a worker
 * can actually lease.
 */
export function recoverableAttemptConditions(now: Date | SQL, allowNewSubmission: boolean): SQL[] {
  return [
    inArray(generationAttempts.status, ["pending", "running"]),
    // Historical rows without a frozen price must stay visible but cannot be
    // resumed by guessing a provider tier and poisoning the worker queue.
    sql`${generationAttempts.priceSnapshot} <> '{}'::jsonb`,
    ...(allowNewSubmission ? [] : [sql`${generationAttempts.phase} <> 'created'`]),
    or(isNull(generationAttempts.nextPollAt), lte(generationAttempts.nextPollAt, now))!,
    or(isNull(generationAttempts.leaseUntil), lte(generationAttempts.leaseUntil, now))!,
  ];
}

/** Stable final id tie-breaker keeps the claim order and displayed position deterministic. */
export function recoverableAttemptOrderBy() {
  return [generationAttempts.nextPollAt, generationAttempts.createdAt, generationAttempts.id] as const;
}

/** Returns null rather than a made-up duration when the historical sample is too small. */
export function medianEstimatedDurationSeconds(durations: readonly number[]): number | null {
  if (durations.length < ETA_MINIMUM_SAMPLE_COUNT) return null;
  const sorted = [...durations].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

type ControlReferenceResolveOptions = {
  useRegisteredSeedanceAssetUris?: boolean;
  /** Only providers with the Seedance reference-image capability use its size gate. */
  enforceReferenceImageDimensions?: boolean;
  /** Exact route-scoped project capability from ProjectAccessService. */
  authorizedProjectId?: string;
};

/**
 * 本镜定稿图相对「素材库」的三种处境。
 * `unregistered` 必须与 `absent` 分开:定稿图在、只是没入库时按纯文字生视频会
 * 产出人物全对不上的废片,得挡;压根没有定稿图则是用户的正常选择,不该挡。
 */
export type ShotFinalReferenceResolution =
  | { status: "registered"; mediaId: string }
  | { status: "unregistered" }
  | { status: "absent" };

export interface ProjectGenerationConfig {
  defaultRatio?: string;
  defaultImageResolution?: string;
  defaultVideoResolution?: string;
  styleDescription?: string;
  styleReferenceMediaIds: string[];
  promptTemplate?: string;
  promptTemplateSource: "platform_default" | "project";
}

type TransactionCreateResult =
  | { outcome: "created" | "existing"; attemptId: string }
  | { outcome: "idempotency_conflict" | "budget_exceeded" };

type BatchTransactionResult = { authorizationId: string; idempotentReplay: boolean };

export type GenerationActorAccessGuard = (db: Database, actorId: string) => Promise<void>;

export class PostgresGenerationRepository implements GenerationRepository, GenerationWorkerLeaseRepository {
  private readonly providerCostRepository: PostgresProviderCostRepository;

  constructor(
    private readonly db: Database,
    private readonly pollIntervalMs: number,
    private readonly allowNewSubmission = true,
    /**
     * Deployment capability guard injected by the production factory. It is
     * deliberately evaluated beside every paid state transition, rather than
     * only in HTTP routes, so a stale quote cannot reserve budget for an
     * unconfigured audio provider.
     */
    private readonly assertRequestConfigured: (
      request: NormalizedGenerationInput,
      expectedProvider?: string,
    ) => string | void = () => {},
    private readonly persistenceRetryLimit = DEFAULT_PERSISTENCE_RETRY_LIMIT,
    /**
     * Pilot account-credit gate. The production factory wires one database
     * backed guard here so HTTP, CLI and Agent callers share the same policy.
     * Idempotent replays return before this guard wherever a durable result
     * already exists.
     */
    private readonly assertActorAccess: GenerationActorAccessGuard = async () => {},
  ) {
    if (!Number.isSafeInteger(persistenceRetryLimit) || persistenceRetryLimit < 0) {
      throw new Error("persistenceRetryLimit must be a non-negative integer");
    }
    this.providerCostRepository = new PostgresProviderCostRepository(db);
  }

  /** Route-facing lookup: model, parameters and price rule come from one row. */
  async resolveActiveTier(input: {
    tierId: string;
    mediaKind: "image" | "video" | "audio";
    parameters: GenerationParameters;
    quantity: number;
  }): Promise<ResolvedGenerationTier> {
    return requireCurrentTier(this.db, input);
  }

  async listActiveTiers(mediaKind: "image" | "video" | "audio"): Promise<ResolvedGenerationTier[]> {
    return (await findActivePricingRules(this.db, mediaKind, new Date()))
      .map((rule) => resolveTierFromPricingRule(rule))
      .filter((tier): tier is ResolvedGenerationTier => tier !== null);
  }

  async resolveProjectGenerationConfig(
    projectId: string,
    mediaKind: "image" | "video",
  ): Promise<ProjectGenerationConfig> {
    const row = (await this.db.select({
      defaultRatio: projects.defaultRatio,
      defaultImageResolution: projects.defaultImageResolution,
      defaultVideoResolution: projects.defaultVideoResolution,
      imageStyleDescription: projects.imageStyleDescription,
      videoStyleDescription: projects.videoStyleDescription,
      imageStyleReferenceMediaIds: projects.imageStyleReferenceMediaIds,
      videoStyleReferenceMediaIds: projects.videoStyleReferenceMediaIds,
      imagePromptTemplate: projects.imagePromptTemplate,
      videoPromptTemplate: projects.videoPromptTemplate,
    }).from(projects).where(and(
      eq(projects.id, projectId),
      isNull(projects.deletedAt),
    )).limit(1))[0];
    if (!row) throw generationNotFound();
    const styleDescription = mediaKind === "image"
      ? row.imageStyleDescription
      : row.videoStyleDescription;
    const styleReferenceMediaIds = mediaKind === "image"
      ? row.imageStyleReferenceMediaIds
      : row.videoStyleReferenceMediaIds;
    const customPromptTemplate = mediaKind === "image"
      ? row.imagePromptTemplate
      : row.videoPromptTemplate;
    const customTemplate = customPromptTemplate?.trim();
    let promptTemplate: string;
    if (customTemplate) {
      promptTemplate = customTemplate;
    } else {
      // 平台默认模板（迁移 064 播种的 prompt_default_templates，即「系统模板」），缺行回落代码常量。
      const platformTemplate = (await this.db.select({ content: promptDefaultTemplates.content })
        .from(promptDefaultTemplates)
        .where(eq(promptDefaultTemplates.mediaKind, mediaKind))
        .limit(1))[0];
      promptTemplate = platformTemplate?.content
        ?? (mediaKind === "image" ? DEFAULT_IMAGE_PROMPT_TEMPLATE : DEFAULT_VIDEO_PROMPT_TEMPLATE);
    }
    return {
      defaultRatio: row.defaultRatio,
      defaultImageResolution: row.defaultImageResolution,
      defaultVideoResolution: row.defaultVideoResolution,
      ...(styleDescription?.trim() ? { styleDescription: styleDescription.trim() } : {}),
      styleReferenceMediaIds: [...styleReferenceMediaIds],
      promptTemplate,
      promptTemplateSource: customPromptTemplate?.trim() ? "project" : "platform_default",
    };
  }

  async createSubmissionQuote(input: {
    actorId: string;
    authorizedProjectId?: string;
    source: GenerationQuoteSource;
    assistantSessionId?: string;
    requestHash: string;
    request: NormalizedGenerationInput;
    ttlSeconds: number;
  }): Promise<GenerationQuoteView> {
    this.assertRequestConfigured(input.request);
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      assertQuoteTtl(input.ttlSeconds);
      await assertQuoteSource(tx, input.actorId, input.source, input.assistantSessionId);
      await assertTargetAccess(tx, input.actorId, input.request, input.authorizedProjectId);
      await assertCurrentControlAssetReferences(tx, input.actorId, input.request, input.authorizedProjectId);
      await assertCurrentSeedanceReferences(tx, input.request);
      await this.assertActorAccess(tx, input.actorId);
      await transaction.execute(sql`select pg_advisory_xact_lock(${generationPricingLockKey})`);
      const cost = await requireCurrentCost(tx, input.request);
      this.assertRequestConfigured(input.request, cost.provider);
      const now = new Date();
      const rows = await transaction.insert(generationQuotes).values({
        id: crypto.randomUUID(),
        userId: input.actorId,
        source: input.source,
        action: "submit",
        assistantSessionId: input.assistantSessionId ?? null,
        originalRequestId: null,
        baseAttemptId: null,
        baseAttemptNo: null,
        requestHash: input.requestHash,
        normalizedRequest: normalizedRequestSnapshot(input.request),
        pricingRuleId: cost.pricingRuleId,
        priceSnapshot: asJsonRecord(cost),
        estimatedCostFen: cost.estimatedCostFen,
        status: "pending_confirmation",
        expiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000),
        confirmedAt: null,
        confirmedByUserId: null,
        consumedAt: null,
        generationRequestId: null,
        generationAttemptId: null,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const quote = rows[0];
      if (!quote) throw new Error("Generation quote was not persisted");
      return quoteViewFromRow(quote);
    });
  }

  async createRetryQuote(input: {
    actorId: string;
    authorizedProjectId?: string;
    source: GenerationQuoteSource;
    assistantSessionId?: string;
    requestId: string;
    ttlSeconds: number;
  }): Promise<GenerationQuoteView> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      assertQuoteTtl(input.ttlSeconds);
      await assertQuoteSource(tx, input.actorId, input.source, input.assistantSessionId);
      const request = (await transaction.select().from(generationRequests).where(and(
        eq(generationRequests.id, input.requestId),
        ...generationRequestActorScope(input.actorId, input.authorizedProjectId),
      )).limit(1))[0];
      if (!request) throw generationNotFound();
      const prior = await latestAttempt(tx, request.id);
      if (!prior) throw generationNotFound();
      assertRetryAllowed(prior);
      const tier = await requireCurrentTierForModel(
        tx,
        prior.model,
        asGenerationMediaKind(request.mediaKind),
        retryTierIdFromSnapshot(prior.priceSnapshot),
      );
      const normalized = requestInput(request, prior.model, tier.tierId);
      this.assertRequestConfigured(normalized);
      await assertCurrentControlAssetReferences(tx, input.actorId, normalized, input.authorizedProjectId);
      await assertFrozenRetryReferences(tx, input.actorId, request, input.authorizedProjectId);
      await assertCurrentSeedanceReferences(tx, normalized);
      await this.assertActorAccess(tx, input.actorId);
      const requestHash = hashGenerationRequest(normalized);
      await transaction.execute(sql`select pg_advisory_xact_lock(${generationPricingLockKey})`);
      const cost = await requireCurrentCost(tx, normalized);
      this.assertRequestConfigured(normalized, cost.provider);
      const now = new Date();
      const rows = await transaction.insert(generationQuotes).values({
        id: crypto.randomUUID(),
        userId: input.actorId,
        source: input.source,
        action: "retry",
        assistantSessionId: input.assistantSessionId ?? null,
        originalRequestId: request.id,
        baseAttemptId: prior.id,
        baseAttemptNo: prior.attemptNo,
        requestHash,
        normalizedRequest: normalizedRequestSnapshot(normalized),
        pricingRuleId: cost.pricingRuleId,
        priceSnapshot: asJsonRecord(cost),
        estimatedCostFen: cost.estimatedCostFen,
        status: "pending_confirmation",
        expiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000),
        confirmedAt: null,
        confirmedByUserId: null,
        consumedAt: null,
        generationRequestId: null,
        generationAttemptId: null,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const quote = rows[0];
      if (!quote) throw new Error("Generation quote was not persisted");
      return quoteViewFromRow(quote);
    });
  }

  async confirmQuote(
    actorId: string,
    quoteId: string,
    authorizedProjectId: string,
  ): Promise<GenerationQuoteView> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const quote = await lockQuote(tx, actorId, quoteId);
      await assertQuoteProjectScope(tx, actorId, quote, authorizedProjectId);
      if (quote.status === "consumed") return quoteViewFromRow(quote);
      await assertQuoteTierCurrent(transaction as unknown as Database, quote);
      const now = new Date();
      if (quote.expiresAt.getTime() <= now.getTime()) throw quoteExpired();
      if (quote.status === "confirmed") {
        assertQuoteConfirmedByActor(quote, actorId);
        return quoteViewFromRow(quote);
      }
      await this.assertActorAccess(tx, actorId);
      const rows = await transaction.update(generationQuotes).set({
        status: "confirmed",
        confirmedAt: now,
        confirmedByUserId: actorId,
        updatedAt: now,
      }).where(and(
        eq(generationQuotes.id, quote.id),
        ...generationQuoteActorScope(actorId),
        eq(generationQuotes.status, "pending_confirmation"),
      )).returning();
      const confirmed = rows[0];
      if (!confirmed) throw quoteNotFound();
      return quoteViewFromRow(confirmed);
    });
  }

  /** v1.9 十.7：Lite 自动确认——提交事务内对同 actor 的 pending 报价做同口径确认跃迁，并同步内存 quote。 */
  private async maybeAutoConfirmQuote(
    db: Database,
    actorId: string,
    quote: QuoteRow,
    autoConfirm?: boolean,
  ): Promise<void> {
    if (!autoConfirm || quote.status !== "pending_confirmation") return;
    const now = new Date();
    if (quote.expiresAt.getTime() <= now.getTime()) throw quoteExpired();
    await this.assertActorAccess(db, actorId);
    const rows = await db.update(generationQuotes).set({
      status: "confirmed",
      confirmedAt: now,
      confirmedByUserId: actorId,
      updatedAt: now,
    }).where(and(
      eq(generationQuotes.id, quote.id),
      ...generationQuoteActorScope(actorId),
      eq(generationQuotes.status, "pending_confirmation"),
    )).returning();
    const confirmed = rows[0];
    if (!confirmed) throw quoteNotFound();
    quote.status = "confirmed";
    quote.confirmedAt = now;
    quote.confirmedByUserId = actorId;
  }

  async createSubmission(input: {
    actorId: string;
    authorizedProjectId: string;
    source: GenerationQuoteSource;
    quoteId: string;
    requestHash: string;
    request: NormalizedGenerationInput;
    budgetLimitFen: number;
    autoConfirm?: boolean;
  }): Promise<CreateGenerationResult> {
    this.assertRequestConfigured(input.request);
    const result = await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await transaction.execute(sql`select pg_advisory_xact_lock(${budgetLockKey})`);

      const quote = await lockQuote(tx, input.actorId, input.quoteId);
      await assertQuoteProjectScope(tx, input.actorId, quote, input.authorizedProjectId);
      assertQuoteRequest(quote, input.source, "submit", input.request);
      if (quote.status === "consumed") return consumedQuoteResult(quote);
      if (quote.generationAttemptId) {
        // 同一已确认报价单被再次提交(并发重复点击/断线重试):输入已在上面
        // assertQuoteRequest 校验为同一生成输入,直接幂等返回既有 attempt,
        // 不重复建任务、不重复占用报价。
        return { outcome: "existing", attemptId: quote.generationAttemptId } satisfies TransactionCreateResult;
      }
      await assertQuoteNotReservedForBatch(tx, quote.id);
      await this.maybeAutoConfirmQuote(tx, input.actorId, quote, input.autoConfirm);
      assertConfirmedAndFresh(quote, input.actorId);
      await assertTargetAccess(tx, input.actorId, input.request, input.authorizedProjectId);
      await assertCurrentControlAssetReferences(tx, input.actorId, input.request, input.authorizedProjectId);
      await assertCurrentSeedanceReferences(tx, input.request);

      const existing = (await transaction.select({
        id: generationRequests.id,
        requestHash: generationRequests.requestHash,
      }).from(generationRequests).where(and(
        eq(generationRequests.userId, input.actorId),
        eq(generationRequests.clientIdempotencyKey, input.request.clientIdempotencyKey),
      )).limit(1))[0];
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          return { outcome: "idempotency_conflict" } satisfies TransactionCreateResult;
        }
        const attempt = await latestAttempt(tx, existing.id);
        if (!attempt) throw new Error("Generation request has no attempt");
        await bindQuoteIfUnbound(tx, input.actorId, quote.id, existing.id, attempt.id);
        return { outcome: "existing", attemptId: attempt.id } satisfies TransactionCreateResult;
      }

      await this.assertActorAccess(tx, input.actorId);
      await transaction.execute(sql`select pg_advisory_xact_lock(${generationPricingLockKey})`);
      const cost = await requireCurrentCost(tx, input.request);
      const routedProvider = this.assertRequestConfigured(input.request, cost.provider) ?? cost.provider;
      assertQuotePriceCurrent(quote, cost);
      const usedFen = await reservedCostFen(tx);
      if (cost.estimatedCostFen > input.budgetLimitFen - usedFen) {
        return { outcome: "budget_exceeded" } satisfies TransactionCreateResult;
      }

      const now = new Date();
      const requestId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      await transaction.insert(generationRequests).values({
        id: requestId,
        userId: input.actorId,
        projectId: input.request.projectId,
        episodeId: input.request.episodeId ?? null,
        sceneId: input.request.sceneId ?? null,
        shotId: input.request.shotId ?? null,
        targetAssetEntityId: input.request.targetAssetEntityId ?? null,
        targetAssetVariantId: input.request.targetAssetVariantId ?? null,
        mediaKind: input.request.mediaKind,
        prompt: input.request.prompt,
        referenceMediaIds: input.request.referenceMediaIds,
        referenceAssetSnapshots: toJsonRecords(input.request.referenceAssetSnapshots),
        parameters: persistedRequestParameters(input.request),
        quantity: input.request.quantity,
        clientIdempotencyKey: input.request.clientIdempotencyKey,
        requestHash: input.requestHash,
        createdAt: now,
        updatedAt: now,
      });
      await transaction.insert(generationAttempts).values({
        id: attemptId,
        requestId,
        attemptNo: 1,
        retryIdempotencyKey: null,
        provider: routedProvider,
        providerTaskId: null,
        model: input.request.model,
        parameters: input.request.parameters,
        quantity: input.request.quantity,
        status: "pending",
        phase: "created",
        providerStatus: null,
        providerResponse: null,
        errorCode: null,
        errorMessage: null,
        retryable: false,
        estimatedCostFen: cost.estimatedCostFen,
        actualCostFen: null,
        actualCostStatus: "unavailable",
        pricingRuleId: cost.pricingRuleId,
        priceSnapshot: attemptPriceSnapshot(cost),
        lastQueryError: null,
        nextPollAt: now,
        lastPolledAt: null,
        leaseOwner: null,
        leaseUntil: null,
        submittedAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await bindQuote(tx, input.actorId, quote.id, requestId, attemptId, now);
      return { outcome: "created", attemptId } satisfies TransactionCreateResult;
    });
    return this.withView(result);
  }

  async createBatchAuthorization(input: {
    actorId: string;
    authorizedProjectId: string;
    source: GenerationQuoteSource;
    batch: BatchGenerationSubmitInput;
    listHash: string;
  }): Promise<GenerationBatchSubmissionView> {
    const result = await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await assertCurrentProjectCreateAccess(
        tx,
        input.actorId,
        input.batch.projectId,
        input.authorizedProjectId,
      );
      const existing = (await transaction.select().from(generationBatchAuthorizations).where(and(
        eq(generationBatchAuthorizations.userId, input.actorId),
        eq(generationBatchAuthorizations.clientIdempotencyKey, input.batch.clientIdempotencyKey),
      )).limit(1).for("update"))[0];
      if (existing) {
        assertBatchAuthorizationIdentity(existing, input.batch, input.listHash);
        return { authorizationId: existing.id, idempotentReplay: true } satisfies BatchTransactionResult;
      }

      const quotesById = new Map<string, QuoteRow>();
      for (const quoteId of [...new Set(input.batch.items.map((item) => item.quoteId))].sort()) {
        const quote = await lockQuote(tx, input.actorId, quoteId);
        await assertQuoteProjectScope(tx, input.actorId, quote, input.authorizedProjectId);
        assertQuoteIdentity(quote, input.source, "submit");
        assertBatchQuoteProductionMode(quote, input.batch.productionMode ?? "full");
        if (await quoteProjectId(tx, quote.originalRequestId, quote.normalizedRequest) !== input.batch.projectId) {
          throw new GenerationError(
            "GENERATION_QUOTE_CONFLICT",
            "清单中有报价不属于当前项目，请重新估价",
            409,
          );
        }
        assertBatchQuoteReady(quote, new Date());
        await assertQuoteTierCurrent(tx, quote);
        quotesById.set(quoteId, quote);
      }
      await this.assertActorAccess(tx, input.actorId);
      const authorizedTotal = sumBatchQuoteCost(input.batch, quotesById);
      if (authorizedTotal !== input.batch.expectedTotalEstimatedCostFen) {
        throw new GenerationError(
          "GENERATION_QUOTE_CONFLICT",
          "清单总价已变化，请重新估价并再次确认",
          409,
        );
      }

      const authorizationId = crypto.randomUUID();
      const now = new Date();
      await transaction.insert(generationBatchAuthorizations).values({
        id: authorizationId,
        userId: input.actorId,
        projectId: input.batch.projectId,
        clientIdempotencyKey: input.batch.clientIdempotencyKey,
        listHash: input.listHash,
        status: "confirmed",
        authorizedTotalEstimatedCostFen: authorizedTotal,
        submittedTotalEstimatedCostFen: 0,
        currency: "CNY",
        authorizedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      for (const [position, item] of input.batch.items.entries()) {
        const quote = quotesById.get(item.quoteId);
        if (!quote) throw new Error("Batch quote lock is missing");
        await transaction.insert(generationBatchAuthorizationItems).values({
          id: crypto.randomUUID(),
          authorizationId,
          position,
          itemId: item.itemId,
          generationQuoteId: quote.id,
          estimatedCostFen: quote.estimatedCostFen,
          status: "confirmed",
          failureCode: null,
          failureMessage: null,
          generationRequestId: null,
          generationAttemptId: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      for (const quote of quotesById.values()) {
        const confirmed = await transaction.update(generationQuotes).set({
          status: "confirmed",
          confirmedAt: now,
          confirmedByUserId: input.actorId,
          updatedAt: now,
        }).where(and(
          eq(generationQuotes.id, quote.id),
          ...generationQuoteActorScope(input.actorId),
          eq(generationQuotes.status, "pending_confirmation"),
        )).returning({ id: generationQuotes.id });
        if (!confirmed[0]) throw quoteStale("清单中的报价已被处理，请重新估价并确认");
      }
      return { authorizationId, idempotentReplay: false } satisfies BatchTransactionResult;
    });
    return this.batchSubmissionView(
      result.authorizationId,
      result.idempotentReplay,
      input.batch.productionMode ?? "full",
    );
  }

  async findBatchAuthorizationProjectId(actorId: string, authorizationId: string): Promise<string | null> {
    const row = (await this.db.select({ projectId: generationBatchAuthorizations.projectId })
      .from(generationBatchAuthorizations)
      .where(and(
        eq(generationBatchAuthorizations.id, authorizationId),
        eq(generationBatchAuthorizations.userId, actorId),
      ))
      .limit(1))[0];
    return row?.projectId ?? null;
  }

  async submitBatchAuthorization(input: {
    actorId: string;
    authorizedProjectId: string;
    source: GenerationQuoteSource;
    authorizationId: string;
    budgetLimitFen: number;
  }): Promise<GenerationBatchSubmissionView> {
    const result = await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await transaction.execute(sql`select pg_advisory_xact_lock(${budgetLockKey})`);

      const authorization = (await transaction.select().from(generationBatchAuthorizations).where(and(
        eq(generationBatchAuthorizations.id, input.authorizationId),
        eq(generationBatchAuthorizations.userId, input.actorId),
      )).limit(1).for("update"))[0];
      if (!authorization) throw batchAuthorizationNotFound();
      await assertCurrentProjectCreateAccess(
        tx,
        input.actorId,
        authorization.projectId,
        input.authorizedProjectId,
        batchAuthorizationNotFound,
      );
      if (authorization.status !== "confirmed") {
        if (authorization.status === "completed" || authorization.status === "partial" || authorization.status === "failed") {
          return { authorizationId: authorization.id, idempotentReplay: true } satisfies BatchTransactionResult;
        }
        throw new GenerationError("GENERATION_QUOTE_UNCONFIRMED", "请先确认整份生成清单", 409);
      }

      const itemRows = await transaction.select().from(generationBatchAuthorizationItems)
        .where(eq(generationBatchAuthorizationItems.authorizationId, authorization.id))
        .orderBy(generationBatchAuthorizationItems.position)
        .for("update");
      if (itemRows.length === 0 || itemRows.some((item) => item.status !== "confirmed")) {
        throw new GenerationError("GENERATION_QUOTE_CONFLICT", "这份生成清单状态不完整，请重新估价并确认", 409);
      }

      const quotesById = new Map<string, QuoteRow>();
      for (const quoteId of [...new Set(itemRows.map((item) => item.generationQuoteId))].sort()) {
        const quote = await lockQuote(tx, input.actorId, quoteId);
        await assertQuoteProjectScope(tx, input.actorId, quote, input.authorizedProjectId);
        assertQuoteIdentity(quote, input.source, "submit");
        quotesById.set(quoteId, quote);
      }

      // A batch is one transaction, so per-item sorting is not enough: item A
      // could lock entity Y before item B asks for X while review locks X then
      // Y. Pre-lock the union once in the same global media/variant/entity
      // order used by every individual review check.
      await lockCurrentControlAssetReferenceRows(
        tx,
        [...quotesById.values()].flatMap(frozenQuoteReferenceMediaIds),
      );

      await this.assertActorAccess(tx, input.actorId);
      await transaction.execute(sql`select pg_advisory_xact_lock(${generationPricingLockKey})`);
      let usedFen = await reservedCostFen(tx);
      let createdCount = 0;
      let submittedTotal = 0;
      const now = new Date();

      for (const item of itemRows) {
        const quote = quotesById.get(item.generationQuoteId);
        if (!quote) throw new Error("Batch quote lock is missing");
        let status: GenerationBatchItemStatus = "failed";
        let failure: ReturnType<typeof batchFailure> | undefined;
        let requestId: string | undefined;
        let attemptId: string | undefined;

        try {
          assertConfirmedAndFresh(quote, input.actorId, new Date());
          const request = batchRequestFromQuote(quote, authorization.id, item.itemId);
          if (request.projectId !== authorization.projectId || !quoteRequestHashMatches(quote, request)) {
            throw quoteStale("报价内容已变化，请重新估价并确认");
          }
          this.assertRequestConfigured(request);
          await assertTargetAccess(tx, input.actorId, request, input.authorizedProjectId);
          await assertCurrentControlAssetReferences(tx, input.actorId, request, input.authorizedProjectId);
          await assertCurrentSeedanceReferences(tx, request);
          const cost = await requireCurrentCost(tx, request);
          const routedProvider = this.assertRequestConfigured(request, cost.provider) ?? cost.provider;
          assertQuotePriceCurrent(quote, cost);
          if (cost.estimatedCostFen > input.budgetLimitFen - usedFen) {
            throw new GenerationError(
              "GENERATION_BUDGET_EXCEEDED",
              "当前预算不足，未创建这项生成任务",
              402,
            );
          }

          requestId = crypto.randomUUID();
          attemptId = crypto.randomUUID();
          await transaction.insert(generationRequests).values({
            id: requestId,
            userId: input.actorId,
            projectId: request.projectId,
            episodeId: request.episodeId ?? null,
            sceneId: request.sceneId ?? null,
            shotId: request.shotId ?? null,
            targetAssetEntityId: request.targetAssetEntityId ?? null,
            targetAssetVariantId: request.targetAssetVariantId ?? null,
            mediaKind: request.mediaKind,
            prompt: request.prompt,
            referenceMediaIds: request.referenceMediaIds,
            referenceAssetSnapshots: toJsonRecords(request.referenceAssetSnapshots),
            parameters: persistedRequestParameters(request),
            quantity: request.quantity,
            clientIdempotencyKey: request.clientIdempotencyKey,
            requestHash: quote.requestHash,
            createdAt: now,
            updatedAt: now,
          });
          await transaction.insert(generationAttempts).values({
            id: attemptId,
            requestId,
            attemptNo: 1,
            retryIdempotencyKey: null,
            provider: routedProvider,
            providerTaskId: null,
            model: request.model,
            parameters: request.parameters,
            quantity: request.quantity,
            status: "pending",
            phase: "created",
            providerStatus: null,
            providerResponse: null,
            errorCode: null,
            errorMessage: null,
            retryable: false,
            estimatedCostFen: cost.estimatedCostFen,
            actualCostFen: null,
            actualCostStatus: "unavailable",
            pricingRuleId: cost.pricingRuleId,
            priceSnapshot: attemptPriceSnapshot(cost),
            lastQueryError: null,
            nextPollAt: now,
            lastPolledAt: null,
            leaseOwner: null,
            leaseUntil: null,
            submittedAt: null,
            startedAt: null,
            finishedAt: null,
            createdAt: now,
            updatedAt: now,
          });
          await consumeQuote(tx, input.actorId, quote.id, requestId, attemptId, now);
          status = "created";
          usedFen += cost.estimatedCostFen;
          submittedTotal += cost.estimatedCostFen;
          createdCount += 1;
        } catch (error) {
          if (!(error instanceof GenerationError)) throw error;
          failure = batchFailure(error);
          status = failure.status;
        }

        await transaction.update(generationBatchAuthorizationItems).set({
          status,
          failureCode: failure?.error.code ?? null,
          failureMessage: failure?.error.message ?? null,
          failureStatusCode: failure?.error.statusCode ?? null,
          failureDetails: failure?.error.details
            ? asJsonRecord(failure.error.details)
            : null,
          generationRequestId: requestId ?? null,
          generationAttemptId: attemptId ?? null,
          updatedAt: now,
        }).where(eq(generationBatchAuthorizationItems.id, item.id));
      }

      const status: GenerationBatchAuthorizationStatus = createdCount === itemRows.length
        ? "completed"
        : createdCount > 0 ? "partial" : "failed";
      await transaction.update(generationBatchAuthorizations).set({
        status,
        submittedTotalEstimatedCostFen: submittedTotal,
        updatedAt: now,
      }).where(eq(generationBatchAuthorizations.id, authorization.id));
      return { authorizationId: authorization.id, idempotentReplay: false } satisfies BatchTransactionResult;
    });
    return this.batchSubmissionView(result.authorizationId, result.idempotentReplay);
  }

  async createRetry(input: {
    actorId: string;
    authorizedProjectId: string;
    source: GenerationQuoteSource;
    requestId: string;
    quoteId: string;
    clientIdempotencyKey: string;
    budgetLimitFen: number;
    autoConfirm?: boolean;
  }): Promise<CreateGenerationResult> {
    const result = await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await transaction.execute(sql`select pg_advisory_xact_lock(${budgetLockKey})`);
      const request = (await transaction.select().from(generationRequests).where(and(
        eq(generationRequests.id, input.requestId),
        ...generationRequestActorScope(input.actorId, input.authorizedProjectId),
      )).limit(1))[0];
      if (!request) throw generationNotFound();

      const quote = await lockQuote(tx, input.actorId, input.quoteId);
      await assertQuoteProjectScope(tx, input.actorId, quote, input.authorizedProjectId);
      assertQuoteIdentity(quote, input.source, "retry", input.requestId);
      if (quote.status === "consumed") return consumedQuoteResult(quote);
      if (quote.generationAttemptId) {
        // 同一重试报价单被再次提交:绑定到同一请求即幂等返回既有 attempt,
        // 不重复创建重试任务。绑定到其他请求(理论不可达,报价单是 actor 作用域)
        // 仍走 bindQuote 冲突兜底。
        if (quote.generationRequestId === input.requestId) {
          return { outcome: "existing", attemptId: quote.generationAttemptId } satisfies TransactionCreateResult;
        }
        throw new GenerationError("GENERATION_QUOTE_CONFLICT", "报价单已被其他请求处理", 409);
      }
      const prior = await latestAttempt(tx, input.requestId);
      if (!prior) throw generationNotFound();
      assertRetryBaseCurrent(quote, prior);
      const tier = await requireCurrentTierForModel(
        tx,
        prior.model,
        asGenerationMediaKind(request.mediaKind),
        retryTierIdFromSnapshot(prior.priceSnapshot),
      );
      const normalized = requestInput(request, prior.model, tier.tierId);
      this.assertRequestConfigured(normalized);
      await assertCurrentControlAssetReferences(tx, input.actorId, normalized, input.authorizedProjectId);
      await assertFrozenRetryReferences(tx, input.actorId, request, input.authorizedProjectId);
      await assertCurrentSeedanceReferences(tx, normalized);
      await this.maybeAutoConfirmQuote(tx, input.actorId, quote, input.autoConfirm);
      assertConfirmedAndFresh(quote, input.actorId);
      assertQuoteRequest(quote, input.source, "retry", normalized, input.requestId);

      const repeated = (await transaction.select({ id: generationAttempts.id })
        .from(generationAttempts)
        .where(and(
          eq(generationAttempts.requestId, input.requestId),
          eq(generationAttempts.retryIdempotencyKey, input.clientIdempotencyKey),
        )).limit(1))[0];
      if (repeated) {
        await bindQuoteIfUnbound(tx, input.actorId, quote.id, input.requestId, repeated.id);
        return { outcome: "existing", attemptId: repeated.id } satisfies TransactionCreateResult;
      }

      await this.assertActorAccess(tx, input.actorId);
      await transaction.execute(sql`select pg_advisory_xact_lock(${generationPricingLockKey})`);
      const cost = await requireCurrentCost(tx, normalized);
      const routedProvider = this.assertRequestConfigured(normalized, cost.provider) ?? cost.provider;
      assertQuotePriceCurrent(quote, cost);
      assertRetryAllowed(prior);

      const usedFen = await reservedCostFen(tx);
      if (cost.estimatedCostFen > input.budgetLimitFen - usedFen) {
        return { outcome: "budget_exceeded" } satisfies TransactionCreateResult;
      }
      const now = new Date();
      const attemptId = crypto.randomUUID();
      await transaction.insert(generationAttempts).values({
        id: attemptId,
        requestId: input.requestId,
        attemptNo: prior.attemptNo + 1,
        retryIdempotencyKey: input.clientIdempotencyKey,
        provider: routedProvider,
        providerTaskId: null,
        model: prior.model,
        parameters: prior.parameters,
        quantity: prior.quantity,
        status: "pending",
        phase: "created",
        providerStatus: null,
        providerResponse: null,
        errorCode: null,
        errorMessage: null,
        retryable: false,
        estimatedCostFen: cost.estimatedCostFen,
        actualCostFen: null,
        actualCostStatus: "unavailable",
        pricingRuleId: cost.pricingRuleId,
        priceSnapshot: attemptPriceSnapshot(cost),
        lastQueryError: null,
        nextPollAt: now,
        lastPolledAt: null,
        leaseOwner: null,
        leaseUntil: null,
        submittedAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await bindQuote(tx, input.actorId, quote.id, input.requestId, attemptId, now);
      return { outcome: "created", attemptId } satisfies TransactionCreateResult;
    });
    return this.withView(result);
  }

  async findViewForActor(
    actorId: string,
    requestId: string,
    authorizedProjectId?: string,
  ): Promise<GenerationView | null> {
    const row = (await this.db.select({ request: generationRequests, attempt: generationAttempts })
      .from(generationRequests)
      .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
      .where(and(
        eq(generationRequests.id, requestId),
        ...generationRequestVisibilityScope(actorId, authorizedProjectId),
      ))
      .orderBy(desc(generationAttempts.attemptNo))
      .limit(1))[0];
    return row ? this.viewFromRow(row.request, row.attempt) : null;
  }

  async findViewByAttemptId(attemptId: string): Promise<GenerationView | null> {
    const row = (await this.db.select({ request: generationRequests, attempt: generationAttempts })
      .from(generationAttempts)
      .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
      .where(eq(generationAttempts.id, attemptId))
      .limit(1))[0];
    return row ? this.viewFromRow(row.request, row.attempt) : null;
  }

  /**
   * Cross-project production queue for one task owner. Project permissions do
   * not widen this scope: "my queue" must never become a project activity feed
   * merely because the actor is an administrator.
   */
  async listInFlightViewsForActor(
    actorId: string,
    page: number,
    pageSize: number,
  ): Promise<GenerationInFlightPage> {
    const latest = this.db
      .select({
        requestId: generationAttempts.requestId,
        maxAttemptNo: sql<number>`max(${generationAttempts.attemptNo})`.as("max_attempt_no"),
      })
      .from(generationAttempts)
      .groupBy(generationAttempts.requestId)
      .as("latest_in_flight_generation_attempt_no");
    const active = and(
      eq(generationRequests.userId, actorId),
      inArray(generationAttempts.status, ["pending", "running"]),
    );
    const offset = (page - 1) * pageSize;
    const [rows, totalRows] = await Promise.all([
      this.db.select({ request: generationRequests, attempt: generationAttempts })
        .from(generationRequests)
        .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
        .innerJoin(latest, and(
          eq(generationAttempts.requestId, latest.requestId),
          eq(generationAttempts.attemptNo, latest.maxAttemptNo),
        ))
        .where(active)
        .orderBy(asc(generationAttempts.createdAt), asc(generationRequests.id))
        .limit(pageSize)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::integer` })
        .from(generationRequests)
        .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
        .innerJoin(latest, and(
          eq(generationAttempts.requestId, latest.requestId),
          eq(generationAttempts.attemptNo, latest.maxAttemptNo),
        ))
        .where(active),
    ]);
    const waitingValues = await this.waitingValuesForInFlightRows(rows);
    const items = rows.map(({ request, attempt }): GenerationInFlightView => {
      const waitingValue = waitingValues.get(attempt.id)
        ?? { queuePosition: null, estimatedDurationSeconds: null, estimatedDurationSampleCount: 0 };
      return {
        requestId: request.id,
        attemptId: attempt.id,
        projectId: request.projectId,
        ...(request.episodeId ? { episodeId: request.episodeId } : {}),
        ...(request.shotId ? { shotId: request.shotId } : {}),
        ...(request.targetAssetEntityId ? { targetAssetEntityId: request.targetAssetEntityId } : {}),
        mediaKind: asGenerationMediaKind(request.mediaKind),
        status: asInFlightStatus(attempt.status),
        attemptNo: attempt.attemptNo,
        tierId: attemptViewTierId(attempt.priceSnapshot),
        model: attempt.model,
        queuePosition: waitingValue.queuePosition ?? null,
        estimatedDurationSeconds: waitingValue.estimatedDurationSeconds ?? null,
        estimatedDurationSampleCount: waitingValue.estimatedDurationSampleCount ?? 0,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      };
    });
    return {
      items,
      page,
      pageSize,
      total: Number(totalRows[0]?.total ?? 0),
    };
  }

  async listFailedViewsForActor(
    actorId: string,
    page: number,
    pageSize: number,
  ): Promise<GenerationFailedPage> {
    const latest = this.db
      .select({
        requestId: generationAttempts.requestId,
        maxAttemptNo: sql<number>`max(${generationAttempts.attemptNo})`.as("max_attempt_no"),
      })
      .from(generationAttempts)
      .groupBy(generationAttempts.requestId)
      .as("latest_failed_generation_attempt_no");
    const failed = and(
      eq(generationRequests.userId, actorId),
      eq(generationAttempts.status, "failed"),
    );
    const offset = (page - 1) * pageSize;
    const [rows, totalRows] = await Promise.all([
      this.db.select({ request: generationRequests, attempt: generationAttempts })
        .from(generationRequests)
        .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
        .innerJoin(latest, and(
          eq(generationAttempts.requestId, latest.requestId),
          eq(generationAttempts.attemptNo, latest.maxAttemptNo),
        ))
        .where(failed)
        .orderBy(
          sql`${generationAttempts.finishedAt} desc nulls last`,
          desc(generationAttempts.updatedAt),
          desc(generationAttempts.id),
        )
        .limit(pageSize)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::integer` })
        .from(generationRequests)
        .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
        .innerJoin(latest, and(
          eq(generationAttempts.requestId, latest.requestId),
          eq(generationAttempts.attemptNo, latest.maxAttemptNo),
        ))
        .where(failed),
    ]);
    const items = rows.map(({ request, attempt }): GenerationFailedView => ({
      requestId: request.id,
      attemptId: attempt.id,
      projectId: request.projectId,
      ...(request.episodeId ? { episodeId: request.episodeId } : {}),
      ...(request.sceneId ? { sceneId: request.sceneId } : {}),
      ...(request.shotId ? { shotId: request.shotId } : {}),
      ...(request.targetAssetEntityId ? { targetAssetEntityId: request.targetAssetEntityId } : {}),
      mediaKind: asGenerationMediaKind(request.mediaKind),
      status: "failed",
      phase: asPhase(attempt.phase),
      attemptNo: attempt.attemptNo,
      tierId: attemptViewTierId(attempt.priceSnapshot),
      model: attempt.model,
      retryable: attempt.retryable && !isLegacyUnpricedSnapshot(attempt.priceSnapshot),
      ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
      ...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {}),
      createdAt: attempt.createdAt,
      finishedAt: attempt.finishedAt,
      updatedAt: attempt.updatedAt,
    }));
    return {
      items,
      page,
      pageSize,
      total: Number(totalRows[0]?.total ?? 0),
    };
  }

  async listViewsForProject(
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): Promise<GenerationView[]> {
    if (authorizedProjectId !== projectId) {
      const ownsProject = await this.db.select({ id: projects.id }).from(projects).where(and(
        eq(projects.id, projectId),
        eq(projects.ownerUserId, actorId),
        isNull(projects.deletedAt),
      )).limit(1);
      if (!ownsProject[0]) throw generationNotFound();
    }

    const rows = await this.db.select({ request: generationRequests, attempt: generationAttempts })
      .from(generationRequests)
      .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
      .where(and(
        eq(generationRequests.projectId, projectId),
        ...(authorizedProjectId === projectId ? [] : [eq(generationRequests.userId, actorId)]),
      ))
      .orderBy(desc(generationRequests.createdAt), desc(generationAttempts.attemptNo));
    const seen = new Set<string>();
    const views: GenerationView[] = [];
    for (const row of rows) {
      if (seen.has(row.request.id)) continue;
      seen.add(row.request.id);
      views.push(await this.viewFromRow(row.request, row.attempt));
    }
    return views;
  }

  async listAttemptViewsForActor(
    actorId: string,
    requestId: string,
    authorizedProjectId?: string,
  ): Promise<GenerationView[]> {
    const rows = await this.db.select({ request: generationRequests, attempt: generationAttempts })
      .from(generationRequests)
      .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
      .where(and(
        eq(generationRequests.id, requestId),
        ...generationRequestVisibilityScope(actorId, authorizedProjectId),
      ))
      .orderBy(generationAttempts.attemptNo);
    const views: GenerationView[] = [];
    for (const row of rows) views.push(await this.viewFromRow(row.request, row.attempt));
    return views;
  }

  /**
   * Station-only inbox for succeeded and definitely failed attempts. It is
   * deliberately scoped to the task owner, not a project-wide activity feed,
   * so it cannot reveal another member's generation result through a reminder.
   */
  async listUnacknowledgedAttemptNotifications(
    actorId: string,
    limit: number,
  ): Promise<GenerationAttemptNotificationView[]> {
    const rows = await this.db.select({
      notification: generationAttemptNotifications,
      request: generationRequests,
      attempt: generationAttempts,
    }).from(generationAttemptNotifications)
      .innerJoin(generationRequests, eq(generationAttemptNotifications.generationRequestId, generationRequests.id))
      .innerJoin(generationAttempts, eq(generationAttemptNotifications.attemptId, generationAttempts.id))
      .where(and(
        eq(generationAttemptNotifications.userId, actorId),
        isNull(generationAttemptNotifications.acknowledgedAt),
        inArray(generationAttempts.status, ["succeeded", "failed"]),
      ))
      .orderBy(desc(generationAttemptNotifications.createdAt), desc(generationAttemptNotifications.id))
      .limit(limit);

    return rows.map(({ notification, request, attempt }) => ({
      id: notification.id,
      requestId: notification.generationRequestId,
      attemptId: notification.attemptId,
      projectId: notification.projectId,
      ...(request.episodeId ? { episodeId: request.episodeId } : {}),
      ...(request.shotId ? { shotId: request.shotId } : {}),
      ...(request.targetAssetEntityId ? { targetAssetEntityId: request.targetAssetEntityId } : {}),
      mediaKind: asGenerationMediaKind(request.mediaKind),
      status: asTerminalNotificationStatus(attempt.status),
      ...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {}),
      createdAt: notification.createdAt,
    }));
  }

  /** Explicit acknowledgement keeps unread reminders durable across refreshes and logins. */
  async acknowledgeAttemptNotification(actorId: string, notificationId: string): Promise<void> {
    const notification = (await this.db.select({ id: generationAttemptNotifications.id })
      .from(generationAttemptNotifications)
      .where(and(
        eq(generationAttemptNotifications.id, notificationId),
        eq(generationAttemptNotifications.userId, actorId),
      ))
      .limit(1))[0];
    if (!notification) throw generationNotificationNotFound();
    await this.db.update(generationAttemptNotifications).set({ acknowledgedAt: new Date() })
      .where(eq(generationAttemptNotifications.id, notification.id));
  }

  async getRecoverableAttempt(attemptId: string): Promise<RecoverableGenerationContext | null> {
    const row = (await this.db.select({ request: generationRequests, attempt: generationAttempts })
      .from(generationAttempts)
      .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
      .where(and(
        eq(generationAttempts.id, attemptId),
        sql`${generationAttempts.priceSnapshot} <> '{}'::jsonb`,
      ))
      .limit(1))[0];
    if (!row) return null;
    const media = await this.persistedMedia(attemptId);
    return {
      request: {
        id: row.request.id,
        actorId: row.request.userId,
        input: requestInput(row.request, row.attempt.model, costSnapshot(row.attempt.priceSnapshot).tierId),
        requestHash: row.request.requestHash,
        estimatedCostFen: row.attempt.estimatedCostFen,
      },
      attempt: {
        id: row.attempt.id,
        status: asStatus(row.attempt.status),
        phase: asPhase(row.attempt.phase),
        ...(row.attempt.providerTaskId ? { providerTaskId: row.attempt.providerTaskId } : {}),
        ...(providerSnapshot(row.attempt.providerResponse)
          ? { providerResult: providerSnapshot(row.attempt.providerResponse) }
          : {}),
      },
      media,
    };
  }

  async recordProviderCost(
    input: Parameters<PostgresProviderCostRepository["record"]>[0],
  ): ReturnType<PostgresProviderCostRepository["record"]> {
    return this.providerCostRepository.record(input);
  }

  async markSubmitting(attemptId: string, leaseOwner?: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const row = (await transaction.select({
        request: generationRequests,
        attempt: generationAttempts,
      }).from(generationAttempts)
        .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
        .where(eq(generationAttempts.id, attemptId))
        .limit(1)
        .for("update"))[0];
      if (!row) throw generationNotFound();
      assertLeaseOwner(attemptId, leaseOwner, row.attempt.leaseOwner, row.attempt.status);
      // The context was read before this transaction. Only the process that
      // atomically wins `created -> submitting` may send the paid POST.
      if (row.attempt.phase !== "created") {
        throw new GenerationAttemptLeaseLostError(attemptId);
      }
      // The row lock prevents a concurrent claimant, but it does not make an
      // expired lease valid again.  Check against PostgreSQL's clock before
      // and after the durable media unit so an expired-but-not-yet-reclaimed
      // worker cannot commit a result merely because no second worker won the
      // row in time.
      await assertLiveLeaseAtDatabaseNow(tx, attemptId, leaseOwner);
      await assertCurrentControlAssetReferences(tx, row.request.userId, {
        projectId: row.request.projectId,
        ...(row.request.shotId ? { shotId: row.request.shotId } : {}),
        referenceMediaIds: row.request.referenceMediaIds,
        referenceAssetSnapshots: readReferenceSnapshots(row.request.referenceAssetSnapshots),
      }, row.request.projectId);
      await assertCurrentSeedanceReferences(tx, {
        mediaKind: asGenerationMediaKind(row.request.mediaKind),
        model: row.attempt.model,
        referenceAssetSnapshots: readReferenceSnapshots(row.request.referenceAssetSnapshots),
      });
      const now = new Date();
      const updated = await transaction.update(generationAttempts).set({
        status: "running",
        phase: "submitting",
        startedAt: now,
        updatedAt: now,
        errorCode: null,
        errorMessage: null,
        retryable: false,
      }).where(and(
        attemptMutationCondition(attemptId, leaseOwner),
        eq(generationAttempts.phase, "created"),
      )).returning({ id: generationAttempts.id });
      if (updated.length === 0) throw new GenerationAttemptLeaseLostError(attemptId);
    });
  }

  async markProviderAccepted(
    attemptId: string,
    providerTaskId: string,
    rawStatus?: string,
    leaseOwner?: string,
  ): Promise<void> {
    const now = new Date();
    await this.updateAttempt(attemptId, {
      status: "running",
      phase: "provider_queued",
      providerTaskId,
      providerStatus: rawStatus ?? "queued",
      submittedAt: now,
      nextPollAt: this.nextPollAt(),
      updatedAt: now,
    }, leaseOwner);
  }

  async markProviderProgress(
    attemptId: string,
    result: ProviderResultSnapshot,
    leaseOwner?: string,
  ): Promise<void> {
    const now = new Date();
    await this.updateAttempt(attemptId, {
      status: "running",
      phase: result.status === "pending" ? "provider_queued" : "provider_running",
      providerStatus: result.rawStatus ?? result.status,
      providerResponse: asJsonRecord(result),
      lastQueryError: null,
      lastPolledAt: now,
      nextPollAt: this.nextPollAt(),
      updatedAt: now,
    }, leaseOwner);
  }

  async markProviderSucceeded(
    attemptId: string,
    result: ProviderResultSnapshot,
    leaseOwner?: string,
  ): Promise<void> {
    const now = new Date();
    await this.updateAttempt(attemptId, {
      status: "running",
      phase: "provider_succeeded",
      providerTaskId: result.providerTaskId ?? undefined,
      providerStatus: result.rawStatus ?? "succeeded",
      providerResponse: asJsonRecord(result),
      lastQueryError: null,
      lastPolledAt: now,
      nextPollAt: now,
      updatedAt: now,
    }, leaseOwner);
  }

  async markProviderFailed(input: {
    attemptId: string;
    errorCode: string;
    errorMessage: string;
    providerResult?: ProviderResultSnapshot;
    recordCompensationPending?: boolean;
    leaseOwner?: string;
  }): Promise<void> {
    const now = new Date();
    await this.updateTerminalAttempt(input.attemptId, {
      status: "failed",
      phase: "complete",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      ...(input.providerResult ? {
        providerTaskId: input.providerResult.providerTaskId ?? undefined,
        providerStatus: input.providerResult.rawStatus ?? input.providerResult.status,
        providerResponse: asJsonRecord(redactInlineProviderResult(input.providerResult)),
      } : {}),
      retryable: false,
      finishedAt: now,
      nextPollAt: null,
      updatedAt: now,
    }, input.leaseOwner, {
      discardPersistedMedia: true,
      ...(input.recordCompensationPending ? { compensationFailureCode: input.errorCode } : {}),
    });
  }

  async markSubmissionOutcomeUnknown(attemptId: string, errorMessage: string, leaseOwner?: string): Promise<void> {
    const now = new Date();
    await this.updateTerminalAttempt(attemptId, {
      status: "failed",
      phase: "submitting",
      errorCode: "SUBMISSION_OUTCOME_UNKNOWN",
      errorMessage,
      retryable: false,
      finishedAt: now,
      nextPollAt: null,
      updatedAt: now,
    }, leaseOwner);
  }

  async recordPollFailure(attemptId: string, errorMessage: string, leaseOwner?: string): Promise<void> {
    const now = new Date();
    await this.updateAttempt(attemptId, {
      lastQueryError: errorMessage,
      lastPolledAt: now,
      nextPollAt: this.nextPollAt(),
      updatedAt: now,
    }, leaseOwner);
  }

  async markPersisting(attemptId: string, leaseOwner?: string): Promise<void> {
    await this.updateAttempt(attemptId, {
      status: "running",
      phase: "persisting",
      nextPollAt: null,
      updatedAt: new Date(),
    }, leaseOwner);
  }

  async recordPersistenceFailure(attemptId: string, errorMessage: string, leaseOwner?: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      // This row lock makes the retry budget atomic across competing workers.
      const attempt = (await transaction.select({
        status: generationAttempts.status,
        phase: generationAttempts.phase,
        leaseOwner: generationAttempts.leaseOwner,
        providerResponse: generationAttempts.providerResponse,
      }).from(generationAttempts)
        .where(eq(generationAttempts.id, attemptId))
        .limit(1)
        .for("update"))[0];
      if (!attempt) throw generationNotFound();
      assertLeaseOwner(attemptId, leaseOwner, attempt.leaseOwner, attempt.status);
      // A delayed worker must never revive or overwrite a terminal attempt
      // that another worker completed after this attempt's lease expired.
      // `provider_succeeded` is included because a corrupt/missing result
      // snapshot is detected immediately before `markPersisting` and still
      // needs to consume the bounded recovery budget instead of getting stuck.
      if (attempt.status !== "running"
        || (attempt.phase !== "provider_succeeded" && attempt.phase !== "persisting")) return;
      const now = new Date();
      const persistenceRetryCount = readPersistenceRetryCount(attempt.providerResponse);
      if (persistenceRetryCount >= this.persistenceRetryLimit) {
        const terminalMessage = `Persistence recovery retry limit (${this.persistenceRetryLimit}) exhausted: ${errorMessage}`;
        const terminal = await transaction.update(generationAttempts).set({
          status: "failed",
          phase: "complete",
          errorCode: "PERSISTENCE_RETRY_EXHAUSTED",
          errorMessage: terminalMessage,
          providerResponse: redactInlineProviderResponse(attempt.providerResponse),
          retryable: false,
          finishedAt: now,
          nextPollAt: null,
          updatedAt: now,
        }).where(attemptMutationCondition(attemptId, leaseOwner)).returning({ id: generationAttempts.id });
        if (terminal.length === 0) {
          if (leaseOwner) throw new GenerationAttemptLeaseLostError(attemptId);
          return;
        }
        // A persistence retry can fail after an earlier result has already
        // been stored. Make the failure and withdrawal of every derived
        // admission fact one transaction.
        await withdrawFailedAttemptOutputs(transaction as unknown as Database, attemptId, now);
        const recipient = (await transaction.select({
          userId: generationRequests.userId,
          requestId: generationRequests.id,
          projectId: generationRequests.projectId,
        }).from(generationAttempts)
          .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
          .where(eq(generationAttempts.id, attemptId))
          .limit(1))[0];
        if (!recipient) return;
        await transaction.insert(generationAttemptNotifications).values({
          id: crypto.randomUUID(),
          attemptId,
          generationRequestId: recipient.requestId,
          projectId: recipient.projectId,
          userId: recipient.userId,
          acknowledgedAt: null,
          createdAt: now,
        }).onConflictDoNothing({ target: generationAttemptNotifications.attemptId });
        return;
      }
      await transaction.update(generationAttempts).set({
        status: "running",
        phase: "persisting",
        errorCode: "PERSISTENCE_FAILED",
        errorMessage,
        retryable: true,
        providerResponse: withPersistenceRetryCount(attempt.providerResponse, persistenceRetryCount + 1),
        nextPollAt: new Date(now.getTime() + this.pollIntervalMs),
        updatedAt: now,
      }).where(attemptMutationCondition(attemptId, leaseOwner));
    });
  }

  async recordTosObjectUpload(
    attemptId: string,
    object: GenerationTosObjectReceipt,
    _leaseOwner?: string,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const attempt = (await transaction.select({
        userId: generationRequests.userId,
        projectId: generationRequests.projectId,
      }).from(generationAttempts)
        .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
        .where(eq(generationAttempts.id, attemptId))
        .limit(1))[0];
      if (!attempt) throw generationNotFound();

      const now = new Date();
      // The TOS copy already exists at this point.  Keep the object in the
      // cleanup ledger until saveMediaResult atomically binds it to a media
      // row; this package deliberately never deletes a remote object. This is
      // the one audit-only post-effect write allowed after lease loss: a stale
      // worker may disclose an object it actually created, but cannot progress
      // the attempt because saveMediaResult remains database-clock fenced.
      await transaction.insert(generationTosOrphans).values({
        id: crypto.randomUUID(),
        attemptId,
        userId: attempt.userId,
        projectId: attempt.projectId,
        mediaResultId: null,
        providerResultKey: object.providerResultKey,
        storageBucket: object.storageBucket,
        objectKey: object.objectKey,
        producedAt: object.producedAt,
        cleanupStatus: "pending_cleanup",
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [generationTosOrphans.storageBucket, generationTosOrphans.objectKey],
        set: {
          attemptId: sql`CASE
            WHEN ${generationTosOrphans.cleanupStatus} = 'referenced'
              THEN ${generationTosOrphans.attemptId}
            ELSE excluded.attempt_id
          END`,
          userId: sql`CASE
            WHEN ${generationTosOrphans.cleanupStatus} = 'referenced'
              THEN ${generationTosOrphans.userId}
            ELSE excluded.user_id
          END`,
          projectId: sql`CASE
            WHEN ${generationTosOrphans.cleanupStatus} = 'referenced'
              THEN ${generationTosOrphans.projectId}
            ELSE excluded.project_id
          END`,
          mediaResultId: sql`CASE
            WHEN ${generationTosOrphans.cleanupStatus} = 'referenced'
              THEN ${generationTosOrphans.mediaResultId}
            ELSE NULL
          END`,
          providerResultKey: sql`CASE
            WHEN ${generationTosOrphans.cleanupStatus} = 'referenced'
              THEN ${generationTosOrphans.providerResultKey}
            ELSE excluded.provider_result_key
          END`,
          cleanupStatus: sql`CASE
            WHEN ${generationTosOrphans.cleanupStatus} = 'referenced'
              THEN 'referenced'
            ELSE 'pending_cleanup'
          END`,
          updatedAt: sql`CASE
            WHEN ${generationTosOrphans.cleanupStatus} = 'referenced'
              THEN ${generationTosOrphans.updatedAt}
            ELSE excluded.updated_at
          END`,
        },
      });
    });
  }

  async saveMediaResult(
    attemptId: string,
    result: StoredGenerationMedia,
    leaseOwner?: string,
  ): Promise<void> {
    // A recovered worker skips any row that is already persisted.  Audio's
    // candidate is therefore inseparable from that row: if inserting the
    // candidate (or its automatic-review audit) fails, roll back the media
    // upsert too so recovery retries the complete persistence unit.
    await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const row = (await transaction.select({ request: generationRequests, attempt: generationAttempts })
        .from(generationAttempts)
        .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
        .where(eq(generationAttempts.id, attemptId)).limit(1).for("update"))[0];
      if (!row) throw generationNotFound();
      assertLeaseOwner(attemptId, leaseOwner, row.attempt.leaseOwner, row.attempt.status);
      await assertLiveLeaseAtDatabaseNow(tx, attemptId, leaseOwner);
      // Legacy image/video callers do not carry a lease owner. They still
      // must not create durable media after cancellation or another terminal
      // transition; their recovery flow will read the terminal view instead.
      if (row.attempt.status !== "pending" && row.attempt.status !== "running") return;
      const snapshot = providerSnapshot(row.attempt.providerResponse);
      const providerMedia = snapshot?.media.find((item) => item.providerResultKey === result.providerResultKey);
      const resultIndex = snapshot?.media.findIndex((item) => item.providerResultKey === result.providerResultKey) ?? -1;
      if (!providerMedia || resultIndex < 0) {
        throw new Error("Provider media result is missing from the attempt snapshot");
      }
      const now = new Date();
      const reviewMediaKind = result.mediaKind;
      const strategies = await resolveMediaReviewStrategies(tx, row.request.projectId);
      const initialReviewStatus = initialMediaReviewStatus(strategies[reviewMediaKind]);
      const persisted = await transaction.insert(mediaResults).values({
        id: crypto.randomUUID(),
        requestId: row.request.id,
        attemptId,
        shotId: row.request.shotId,
        originKind: "generation",
        sourceAssetMediaId: null,
        registeredByUserId: null,
        mediaKind: result.mediaKind,
        resultIndex,
        providerResultKey: result.providerResultKey,
        // The temporary supplier URL exists only in the private attempt
        // snapshot while bytes are being copied. A persisted media row must
        // never become a durable or user-facing provider link.
        providerUrl: null,
        providerUrlExpiresAt: null,
        persistenceStatus: "persisted",
        storageBucket: result.storageBucket,
        storagePath: result.storagePath,
        storageUrl: result.storageUrl,
        sha256: result.sha256,
        mimeType: result.mimeType,
        widthPx: null,
        heightPx: null,
        durationSeconds: result.mediaKind === "audio" ? null : result.durationSeconds ?? null,
        reviewStatus: initialReviewStatus,
        complianceMetadata: result.complianceMetadata ?? {},
        metadata: result.preview === true ? { preview: true } : {},
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        deletedByUserId: null,
      }).onConflictDoUpdate({
        target: [mediaResults.attemptId, mediaResults.providerResultKey],
        set: {
          persistenceStatus: "persisted",
          storageBucket: result.storageBucket,
          storagePath: result.storagePath,
          storageUrl: result.storageUrl,
          sha256: result.sha256,
          mimeType: result.mimeType,
          durationSeconds: result.mediaKind === "audio" ? null : result.durationSeconds ?? null,
          complianceMetadata: result.complianceMetadata ?? {},
          updatedAt: now,
        },
      }).returning({ id: mediaResults.id, createdAt: mediaResults.createdAt });
      const persistedMediaResult = persisted[0];
      const mediaResultId = persistedMediaResult?.id;
      if (mediaResultId) {
        // The upload receipt is created before this database persistence. A
        // successful media upsert is its only transition out of pending
        // cleanup; no TOS delete happens here or in failure handling.
        const linkedObject = await transaction.update(generationTosOrphans).set({
          mediaResultId,
          cleanupStatus: "referenced",
          updatedAt: now,
        }).where(and(
          eq(generationTosOrphans.attemptId, attemptId),
          eq(generationTosOrphans.storageBucket, result.storageBucket),
          eq(generationTosOrphans.objectKey, result.storagePath),
        )).returning({ id: generationTosOrphans.id });
        if (linkedObject.length !== 1) {
          throw new Error("Persisted media requires a matching TOS object receipt");
        }
        // The child is always a server-observed application generation; its
        // external/unknown ancestry is derived by PostgreSQL from the complete
        // immutable parent graph below.  Client metadata, model text and C2PA
        // claims never select the source channel.
        const lineageSnapshots = readReferenceSnapshots(row.request.referenceAssetSnapshots);
        const snapshotMediaIds = lineageSnapshots
          .map((snapshot) => snapshot.mediaId)
          .filter((value): value is string => Boolean(value));
        const referenceMediaIds = [...new Set([
          ...row.request.referenceMediaIds,
          ...snapshotMediaIds,
        ])];
        if (referenceMediaIds.length > 0) {
          const existingParents = await transaction.select({ assetMediaId: mediaProvenanceSubjects.assetMediaId })
            .from(mediaProvenanceSubjects)
            .where(inArray(mediaProvenanceSubjects.assetMediaId, referenceMediaIds));
          const knownParentMediaIds = new Set(
            existingParents.flatMap((parent) => parent.assetMediaId ? [parent.assetMediaId] : []),
          );
          const missingParentMediaIds = referenceMediaIds.filter((id) => !knownParentMediaIds.has(id));
          if (missingParentMediaIds.length > 0) {
            // A new/nonstandard asset write that skipped the formal ingest
            // path is still safe: it is materialised as unknown, never as a
            // self-produced source inferred from metadata.
            await transaction.insert(mediaProvenanceSubjects).values(missingParentMediaIds.map((assetMediaId) => ({
              assetMediaId,
              mediaResultId: null,
              sourceChannel: "unknown",
              sourceGenerationAttemptId: null,
              providerAssetId: null,
              observedAt: now,
            }))).onConflictDoNothing();
          }
        }
        const insertedSubject = (await transaction.insert(mediaProvenanceSubjects).values({
          assetMediaId: null,
          mediaResultId,
          sourceChannel: "first_party_generation",
          sourceGenerationAttemptId: attemptId,
          providerAssetId: null,
          observedAt: now,
        }).onConflictDoNothing().returning({ id: mediaProvenanceSubjects.id }))[0];
        const childSubjectId = insertedSubject?.id ?? (await transaction.select({ id: mediaProvenanceSubjects.id })
          .from(mediaProvenanceSubjects)
          .where(eq(mediaProvenanceSubjects.mediaResultId, mediaResultId))
          .limit(1))[0]?.id;
        if (!childSubjectId) throw new Error("Generated media provenance subject is missing");
        if (referenceMediaIds.length > 0) {
          const parentSubjects = await transaction.select({ id: mediaProvenanceSubjects.id })
            .from(mediaProvenanceSubjects)
            .where(inArray(mediaProvenanceSubjects.assetMediaId, referenceMediaIds));
          if (parentSubjects.length !== referenceMediaIds.length) {
            throw new Error("Frozen reference media lacks a provenance subject");
          }
          await transaction.insert(mediaProvenanceParentEdges).values(parentSubjects.map((parent) => ({
            childSubjectId,
            parentSubjectId: parent.id,
            createdAt: now,
          }))).onConflictDoNothing();
        }
      }
      if (mediaResultId && result.mediaKind === "audio") {
        await transaction.insert(audioVersions).values({
          id: crypto.randomUUID(),
          projectId: row.request.projectId,
          generationRequestId: row.request.id,
          mediaResultId,
          status: "candidate",
          ...(result.subtitle !== undefined ? { subtitleJson: result.subtitle } : {}),
          complianceMetadata: result.complianceMetadata ?? {},
          createdByUserId: row.request.userId,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing();
      }
      if (mediaResultId && initialReviewStatus === "accepted") {
        // automatic 策略下落库即视同 accepted,但系统动作必须留痕;
        // onConflictDoNothing + 部分唯一索引保证幂等重放不重复记审计。
        await recordAutoAcceptedAction(tx, {
          projectId: row.request.projectId,
          mediaResultId,
          createdAt: now,
        });
      }
      // A slow insert/review write may cross the lease boundary.  This second
      // database-clock CAS intentionally happens before transaction commit;
      // on loss it rolls the complete media/candidate/review unit back.
      await assertLiveLeaseAtDatabaseNow(tx, attemptId, leaseOwner);
    });
  }

  async markSucceeded(attemptId: string, leaseOwner?: string): Promise<void> {
    const attempt = (await this.db.select().from(generationAttempts)
      .where(eq(generationAttempts.id, attemptId)).limit(1))[0];
    if (!attempt) throw generationNotFound();
    assertLeaseOwner(attemptId, leaseOwner, attempt.leaseOwner, attempt.status);
    const expected = providerSnapshot(attempt.providerResponse)?.media ?? [];
    const saved = await this.db.select({ key: mediaResults.providerResultKey })
      .from(mediaResults)
      .where(and(eq(mediaResults.attemptId, attemptId), eq(mediaResults.persistenceStatus, "persisted")));
    const keys = new Set(saved.map((item) => item.key));
    if (expected.length === 0 || !expected.every((item) => keys.has(item.providerResultKey))) {
      throw new Error("Media persistence is incomplete");
    }
    const now = new Date();
    await this.updateTerminalAttempt(attemptId, {
      status: "succeeded",
      phase: "complete",
      errorCode: null,
      errorMessage: null,
      providerResponse: redactInlineProviderResponse(attempt.providerResponse),
      retryable: false,
      finishedAt: now,
      nextPollAt: null,
      updatedAt: now,
    }, leaseOwner);
  }

  async claimNextRecoverableAttempt(
    workerId: string,
    leaseSeconds: number,
    allowNewSubmission: boolean,
  ): Promise<string | null> {
    return this.db.transaction(async (transaction) => {
      // Lease timing is database time, never the application host clock. A
      // worker running on a skewed node must not steal or prolong another
      // worker's paid submission.
      const now = sql`now()`;
      const candidate = (await transaction.select({ id: generationAttempts.id })
        .from(generationAttempts)
        .where(and(...recoverableAttemptConditions(now, allowNewSubmission)))
        .orderBy(...recoverableAttemptOrderBy())
        .limit(1)
        .for("update", { skipLocked: true }))[0];
      if (!candidate) return null;
      await transaction.update(generationAttempts).set({
        leaseOwner: workerId,
        leaseUntil: sql`now() + (${leaseSeconds} * interval '1 second')`,
        updatedAt: sql`now()`,
      }).where(eq(generationAttempts.id, candidate.id));
      return candidate.id;
    });
  }

  async renewLease(attemptId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const renewed = await this.db.update(generationAttempts).set({
      leaseUntil: sql`now() + (${leaseSeconds} * interval '1 second')`,
      updatedAt: sql`now()`,
    }).where(and(
      eq(generationAttempts.id, attemptId),
      eq(generationAttempts.leaseOwner, workerId),
      inArray(generationAttempts.status, ["pending", "running"]),
      gt(generationAttempts.leaseUntil, sql`now()`),
    )).returning({ id: generationAttempts.id });
    return renewed.length === 1;
  }

  async releaseLease(attemptId: string, workerId: string, delayMs?: number): Promise<void> {
    await this.db.update(generationAttempts).set({
      leaseOwner: null,
      leaseUntil: null,
      ...(delayMs === undefined ? {} : { nextPollAt: sql`now() + (${delayMs} * interval '1 millisecond')` }),
      updatedAt: sql`now()`,
    }).where(and(
      eq(generationAttempts.id, attemptId),
      eq(generationAttempts.leaseOwner, workerId),
    ));
  }

  async cancelForActor(actorId: string, requestId: string, authorizedProjectId?: string): Promise<GenerationView> {
    const request = (await this.db.select({ id: generationRequests.id }).from(generationRequests)
      .where(and(
        eq(generationRequests.id, requestId),
        ...generationRequestActorScope(actorId, authorizedProjectId),
      )).limit(1))[0];
    if (!request) throw generationNotFound();
    const attemptId = await this.db.transaction(async (transaction) => {
      // Lock before reading the JSONB snapshot. This serializes cancellation
      // with a late provider write, so the terminal update redacts the actual
      // last inline payload rather than a stale pre-write copy.
      const attempt = (await transaction.select().from(generationAttempts)
        .where(eq(generationAttempts.requestId, requestId))
        .orderBy(desc(generationAttempts.attemptNo))
        .limit(1)
        .for("update"))[0];
      if (!attempt) throw generationNotFound();
      if (attempt.status === "pending" || attempt.status === "running") {
        const now = new Date();
        // Cancellation and a worker completion can race. Make the transition
        // conditional on an active state so a late cancel never overwrites a
        // terminal result, then revoke the lease before an in-flight worker can
        // write the cancelled attempt back to running.
        await transaction.update(generationAttempts).set({
          status: "cancelled",
          phase: "complete",
          errorCode: "CANCELLED_BY_USER",
          errorMessage: "用户已停止本地继续处理",
          retryable: false,
          nextPollAt: null,
          providerResponse: redactInlineProviderResponse(attempt.providerResponse),
          leaseOwner: null,
          leaseUntil: null,
          finishedAt: now,
          updatedAt: now,
        }).where(and(
          eq(generationAttempts.id, attempt.id),
          inArray(generationAttempts.status, ["pending", "running"]),
        ));
        // v1.9 十.6：取消同事务作废绑定报价（不扣费）。
        await settleBoundQuote(transaction as unknown as Database, attempt.id, "cancelled");
      }
      return attempt.id;
    });
    const view = await this.findViewByAttemptId(attemptId);
    if (!view) throw generationNotFound();
    return view;
  }

  /**
   * Route-only lookup before ProjectAccessService makes the visibility
   * decision. The id is never returned to a caller until that decision passes.
   */
  async findProjectIdForRequest(requestId: string): Promise<string | null> {
    const row = (await this.db.select({ projectId: generationRequests.projectId })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId))
      .limit(1))[0];
    return row?.projectId ?? null;
  }

  /** Same pre-access lookup for an expiring quote, including retry quotes. */
  async findProjectIdForQuote(quoteId: string): Promise<string | null> {
    const quote = (await this.db.select({
      originalRequestId: generationQuotes.originalRequestId,
      normalizedRequest: generationQuotes.normalizedRequest,
    }).from(generationQuotes).where(eq(generationQuotes.id, quoteId)).limit(1))[0];
    if (!quote) return null;
    return quoteProjectId(this.db, quote.originalRequestId, quote.normalizedRequest);
  }

  async findActivePricingRule(model: string, mediaKind: "image" | "video" | "audio"): Promise<GenerationPricingRule | null> {
    return findActivePricingRule(this.db, model, mediaKind, new Date());
  }

  /**
   * Resolves the legacy, reference-only array used by the CLI and Pi prepare
   * card. Deliberately do not infer first/last-frame intent from this array:
   * callers must use the explicit control slots below.
   */
  async resolveReferenceSnapshots(
    actorId: string,
    mediaKind: "image" | "video" | "audio",
    mediaIds: string[],
  ): Promise<GenerationReferenceSnapshot[]> {
    return this.resolveControlReferenceSnapshots(actorId, mediaKind, {
      referenceMediaIds: mediaIds,
    }, { useRegisteredSeedanceAssetUris: false });
  }

  /**
   * #164 拿定稿生视频(PRD 生产章 §10.1「下游一律默认用定稿」):镜头定稿图——
   * 人工选用优先,否则最新成功默认,与交付/审核/集视图同一个解析器——已登记
   * 为可用资产媒体时返回该资产媒体 id,由路由层补进视频参考清单最前。
   *
   * R223 起返回判别联合而不是「id 或 null」。原来两种处境都塌成 null:
   * 「本镜压根没有定稿图」和「定稿图在、只是没入库」。前者用户可能就想纯文字
   * 生成,后者会静默产出人物全对不上的废片(实测证据 outputs/e2e-wolf-ep1-20260808/)。
   * 塌在一起,路由层就没法只挡后者——这是判别联合存在的唯一理由。
   */
  async resolveShotFinalReference(input: {
    projectId: string;
    shotId: string;
    useRegisteredSeedanceAssetUris: boolean;
  }): Promise<ShotFinalReferenceResolution> {
    const shot = (await this.db.select({
      id: shots.id,
      selectedImageResultId: shots.selectedImageResultId,
    }).from(shots).where(and(
      eq(shots.id, input.shotId),
      isNull(shots.deletedAt)),
    ).limit(1))[0];
    if (!shot) return { status: "absent" };
    const effective = await new EffectiveShotMediaRepository(this.db).resolve(input.projectId, [{
      id: shot.id,
      selectedImageResultId: shot.selectedImageResultId,
      selectedVideoResultId: null,
    }]);
    const imageResultId = effective.get(shot.id)?.image?.id ?? null;
    if (!imageResultId) return { status: "absent" };
    /* 定稿图 → 资产媒体的两条既有链:服务端素材登记(sourceMediaResultId,
       「存进资产库」的种子登记流)与从素材库选用回挂(sourceAssetMediaId)。 */
    const candidateIds = new Set<string>();
    const registrationRows = await this.db.select({
      assetMediaId: seedanceAssetRegistrations.assetMediaId,
    }).from(seedanceAssetRegistrations).where(and(
      eq(seedanceAssetRegistrations.sourceMediaResultId, imageResultId),
      eq(seedanceAssetRegistrations.status, "active"),
    ));
    for (const row of registrationRows) candidateIds.add(row.assetMediaId);
    const resultRow = (await this.db.select({
      id: mediaResults.id,
      sourceAssetMediaId: mediaResults.sourceAssetMediaId,
      storageUrl: mediaResults.storageUrl,
    }).from(mediaResults).where(and(
      eq(mediaResults.id, imageResultId),
      isNull(mediaResults.deletedAt)),
    ).limit(1))[0];
    if (resultRow?.sourceAssetMediaId) candidateIds.add(resultRow.sourceAssetMediaId);
    for (const candidateId of candidateIds) {
      const mediaRow = (await this.db.select({
        storageUrl: assetMedia.storageUrl,
      }).from(assetMedia).where(and(
        eq(assetMedia.id, candidateId),
        isNull(assetMedia.deletedAt)),
      ).limit(1))[0];
      if (!mediaRow?.storageUrl) continue;
      if (!input.useRegisteredSeedanceAssetUris) return { status: "registered", mediaId: candidateId };
      const admission = await loadSeedanceAdmission(this.db, candidateId);
      if (admission.remoteAssetId) {
        return { status: "registered", mediaId: candidateId };
      }
    }
    /* 定稿图存在但没有可用登记时，必须引导登记，不能丢图改走纯文本。 */
    return { status: "unregistered" };
  }

  /**
   * v1.3 T10.14:服务端生成提交(shot_id 存在)时,按 shots.reference_asset_snapshots
   * 中的 (asset_entity_id, variant_id) 取各变体主图,并入参考清单。
   * 仅媒体匹配:无主图(或主图已软删)的变体跳过,不阻断提交。
   * 返回空数组 = 快照无变体信息或均无可用主图。
   */
  async resolveShotAssetVariantReferences(input: { shotId: string }): Promise<string[]> {
    const shot = (await this.db.select({
      referenceAssetSnapshots: shots.referenceAssetSnapshots,
    }).from(shots).where(and(
      eq(shots.id, input.shotId),
      isNull(shots.deletedAt)),
    ).limit(1))[0];
    if (!shot) return [];
    const variantIds = new Set<string>();
    for (const snapshot of shot.referenceAssetSnapshots) {
      if (snapshot && typeof snapshot.variant_id === "string") variantIds.add(snapshot.variant_id);
    }
    if (variantIds.size === 0) return [];
    const mediaRows = await this.db.select({ id: assetMedia.id })
      .from(assetMedia)
      .where(and(
        inArray(assetMedia.assetVariantId, [...variantIds]),
        eq(assetMedia.isPrimary, true),
        isNull(assetMedia.deletedAt),
      ));
    return [...new Set(mediaRows.map((row) => row.id))];
  }

  /**
   * Canonical control-package resolver for every web quote/submit path.
   * A media ID can occupy exactly one slot. Asset usage_mode is the source of
   * truth: unclassified historical assets are conservative `reference`.
   */
  async resolveControlReferenceSnapshots(
    actorId: string,
    mediaKind: "image" | "video" | "audio",
    input: {
      referenceMediaIds: string[];
      firstFrameMediaId?: string;
      lastFrameMediaId?: string;
    },
    options: ControlReferenceResolveOptions = {},
  ): Promise<GenerationReferenceSnapshot[]> {
    const referenceMediaIds = [...new Set(input.referenceMediaIds)];
    const slotIds = [input.firstFrameMediaId, input.lastFrameMediaId].filter(
      (id): id is string => Boolean(id),
    );
    const allIds = [...referenceMediaIds, ...slotIds];
    if (new Set(allIds).size !== allIds.length) {
      throw new GenerationError(
        "INVALID_GENERATION_REQUEST",
        "同一素材不能同时作为参考图和首尾帧",
        422,
      );
    }
    if (mediaKind !== "video" && slotIds.length > 0) {
      throw new GenerationError(
        "INVALID_GENERATION_REQUEST",
        "首帧和尾帧只用于视频生成",
        422,
      );
    }
    if (allIds.length === 0) return [];

    const rows = await this.db.select({ media: assetMedia, variantEntityId: assetVariants.assetEntityId })
      .from(assetMedia)
      .leftJoin(assetVariants, eq(assetMedia.assetVariantId, assetVariants.id))
      .where(and(inArray(assetMedia.id, allIds), isNull(assetMedia.deletedAt)));
    const byId = new Map(rows.map((row) => [row.media.id, row]));
    const snapshots: GenerationReferenceSnapshot[] = [];
    for (const mediaId of referenceMediaIds) {
      snapshots.push(await this.resolveControlSnapshot(actorId, byId, mediaId, "reference", mediaKind, options));
    }
    if (input.firstFrameMediaId) {
      snapshots.push(await this.resolveControlSnapshot(actorId, byId, input.firstFrameMediaId, "first_frame", mediaKind, options));
    }
    if (input.lastFrameMediaId) {
      snapshots.push(await this.resolveControlSnapshot(actorId, byId, input.lastFrameMediaId, "last_frame", mediaKind, options));
    }
    return snapshots;
  }

  private async resolveControlSnapshot(
    actorId: string,
    byId: Map<string, { media: typeof assetMedia.$inferSelect; variantEntityId: string | null }>,
    mediaId: string,
    expectedUsageMode: ControlUsageMode,
    generationMediaKind: "image" | "video" | "audio",
    options: ControlReferenceResolveOptions,
  ): Promise<GenerationReferenceSnapshot> {
      const row = byId.get(mediaId);
      const entityId = row?.media.assetEntityId ?? row?.variantEntityId;
      if (!row || !entityId || !row.media.storageUrl) {
        throw new GenerationError("INVALID_GENERATION_REQUEST", "引用媒体不存在或没有可用地址", 400);
      }
      const entity = (await this.db.select().from(assetEntities).where(and(
        eq(assetEntities.id, entityId),
        isNull(assetEntities.deletedAt),
      )).limit(1))[0];
      if (!entity) {
        throw new ForbiddenError("没有权限使用引用媒体");
      }
      if (!await canInspectAssetProductionGate(
        this.db,
        actorId,
        entity,
        options.authorizedProjectId,
        row.media,
      )) {
        throw new ForbiddenError("没有权限使用引用媒体");
      }
      const reviewRejection = commonAssetReviewRejection(entity, "付费生成", row.media.id);
      if (reviewRejection) {
        throw invalidCurrentControlAssetReference(reviewRejection.message, reviewRejection.details);
      }
      if (!await canUseAssetForGeneration(
        this.db,
        actorId,
        entity,
        options.authorizedProjectId,
        row.media,
      )) {
        throw new ForbiddenError("没有权限使用引用媒体");
      }
      if (isThreeDimensionalMedia(row.media)) {
        throw new GenerationError(
          "INVALID_GENERATION_REQUEST",
          "3D 素模仅供导演台使用，不能作为生成参考",
          422,
        );
      }
      const actualUsageMode = controlUsageMode(entity.usageMode);
      if (actualUsageMode !== expectedUsageMode) {
        throw new GenerationError(
          "INVALID_GENERATION_REQUEST",
          controlUsageMessage(actualUsageMode, expectedUsageMode),
          422,
        );
      }
      const kind = normalizeReferenceKind(row.media);
      if ((expectedUsageMode === "first_frame" || expectedUsageMode === "last_frame") && kind !== "image") {
        throw new GenerationError(
          "INVALID_GENERATION_REQUEST",
          "首帧和尾帧资产必须是图片",
          422,
        );
      }
      // Seedance 参考图约束:多模态视频参考提交前预检(宽高比/边长),人话
      // 报错;大小与音视频时长当前 schema 不可测,回执登记。锚帧槽不在本预检
      // 范围(合同口径为参考图约束,锚帧由上传链既有像素上限约束)。
      if (options.enforceReferenceImageDimensions && expectedUsageMode === "reference" && kind === "image") {
        const violation = referenceImageViolation(row.media);
        if (violation) {
          throw new GenerationError("INVALID_GENERATION_REQUEST", violation, 422);
        }
      }
      if (generationMediaKind === "audio" && expectedUsageMode === "reference") {
        if (kind !== "audio" && kind !== "image") {
          throw new GenerationError(
            "INVALID_GENERATION_REQUEST",
            "音频生成参考必须是音频或图片素材",
            422,
          );
        }
        if (kind === "audio") {
          const durationSeconds = row.media.metadata.durationSeconds;
          if (typeof durationSeconds !== "number"
            || !Number.isFinite(durationSeconds)
            || durationSeconds <= 0
            || durationSeconds > 30) {
            throw new GenerationError(
              "INVALID_GENERATION_REQUEST",
              "音频参考必须带有 1 到 30 秒的已核验 durationSeconds 元数据",
              422,
            );
          }
        }
      }
      const admission = options.useRegisteredSeedanceAssetUris
        ? await loadSeedanceAdmission(this.db, row.media.id)
        : null;

      return {
        kind,
        mediaId: row.media.id,
        // Seedance has one admission channel: an active CreateAsset
        // registration is consumed as asset://; otherwise a direct URL is
        // not allowed (guide the user to register the asset).
        url: providerReferenceUrl(
          row.media.storageUrl,
          expectedUsageMode,
          admission?.remoteAssetId ?? null,
          options.useRegisteredSeedanceAssetUris,
          admission?.status,
        ),
        ...(referenceRole(kind, expectedUsageMode) ? { role: referenceRole(kind, expectedUsageMode) } : {}),
      };
  }

  /**
   * 两段式提示词编译(合同第二节)的结构化真源查询。仅在路由完成项目授权与
   * 控制资产权限校验(resolveControlReferenceSnapshots)之后于同一请求内调用;
   * 集/场/分镜不属于当前项目时对应栏留空(提交前 assertTargetAccess 仍会拒绝)。
   * 参考条目按入参 mediaIds 顺序返回;无资产实体登记的媒体跳过(无登记描述
   * 可编译),不等于权限放行。
   */
  async resolvePromptCompilationContext(input: {
    projectId: string;
    episodeId?: string;
    sceneId?: string;
    shotId?: string;
    referenceMediaIds: string[];
    styleDescription?: string;
    promptTemplate?: string;
    mediaKind?: "image" | "video";
  }): Promise<PromptCompilationContext> {
    const context: PromptCompilationContext = {
      ...(input.styleDescription ? { styleDescription: input.styleDescription } : {}),
      ...(input.promptTemplate ? { promptTemplate: input.promptTemplate } : {}),
      ...(input.mediaKind ? { mediaKind: input.mediaKind } : {}),
    };
    if (input.episodeId) {
      const episode = (await this.db.select({ name: episodes.name }).from(episodes).where(and(
        eq(episodes.id, input.episodeId),
        eq(episodes.projectId, input.projectId),
        isNull(episodes.deletedAt),
      )).limit(1))[0];
      if (episode?.name?.trim()) context.episodeBackground = episode.name.trim();
    }
    if (input.sceneId) {
      const scene = (await this.db.select({ description: scenes.description }).from(scenes)
        .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
        .where(and(
          eq(scenes.id, input.sceneId),
          eq(episodes.projectId, input.projectId),
          isNull(scenes.deletedAt),
          isNull(episodes.deletedAt),
        )).limit(1))[0];
      if (scene?.description?.trim()) context.sceneDescription = scene.description.trim();
    }
    // 分镜上下文(v1.4,迁移 065):除 director_prompt/script_text 外,
    // 把 breakdown_elements 的 camera_language/action/visual 一并编进 shot_intent
    // (promptCompiler 无独立槽位;action+visual 也随之进入 segment_content,
    // 与 PRD 决策 6 的「action+visual→segment_content、camera_language→shot_intent」对齐)。
    // 存量分镜(breakdown 为空)自然回退为原 director_prompt 行为。
    let shotSubject: string | undefined;
    if (input.shotId) {
      const shot = (await this.db.select({
        directorPrompt: shots.directorPrompt,
        scriptText: shots.scriptText,
        breakdownElements: shots.breakdownElements,
        videoPrompt: shots.videoPrompt,
        metadata: shots.metadata,
      }).from(shots)
        .innerJoin(episodes, eq(shots.episodeId, episodes.id))
        .where(and(
          eq(shots.id, input.shotId),
          eq(episodes.projectId, input.projectId),
          isNull(shots.deletedAt),
          isNull(episodes.deletedAt),
        )).limit(1))[0];
      if (shot) {
        const breakdown = shot.breakdownElements;
        const intentParts = [
          shot.directorPrompt,
          breakdown?.camera_language,
          breakdown?.action,
          breakdown?.visual,
        ].map((part) => part?.trim()).filter((part): part is string => Boolean(part));
        if (intentParts.length > 0) context.shotIntent = intentParts.join("。");
        if (shot.scriptText?.trim()) context.scriptText = shot.scriptText.trim();
        if (breakdown?.subject?.trim()) shotSubject = breakdown.subject.trim();
        const lockedVideoPrompt = shot.videoPrompt?.trim() ?? "";
        if (input.mediaKind === "video"
          && shot.metadata?.lite?.shot?.prompt_locked === true
          && lockedVideoPrompt) {
          context.promptLocked = true;
          context.manualPrompt = lockedVideoPrompt;
        }
      }
    }

    const referenceMediaIds = [...new Set(input.referenceMediaIds)];
    const references: PromptReferenceEntry[] = [];
    const referencedEntityIds = new Set<string>();
    if (referenceMediaIds.length > 0) {
      const rows = await this.db.select({ media: assetMedia, variantEntityId: assetVariants.assetEntityId })
        .from(assetMedia)
        .leftJoin(assetVariants, eq(assetMedia.assetVariantId, assetVariants.id))
        .where(and(inArray(assetMedia.id, referenceMediaIds), isNull(assetMedia.deletedAt)));
      const entityIdByMediaId = new Map(rows.flatMap((row) => {
        const entityId = row.media.assetEntityId ?? row.variantEntityId;
        return entityId ? [[row.media.id, entityId] as const] : [];
      }));
      const entityIds = [...new Set(entityIdByMediaId.values())];
      const entities = entityIds.length === 0
        ? []
        : await this.db.select({
          id: assetEntities.id,
          role: assetEntities.role,
          name: assetEntities.name,
          displayName: assetEntities.displayName,
          intro: assetEntities.intro,
          appearance: assetEntities.appearance,
        }).from(assetEntities).where(and(
          inArray(assetEntities.id, entityIds),
          isNull(assetEntities.deletedAt),
        ));
      const entityById = new Map(entities.map((entity) => [entity.id, entity]));
      for (const mediaId of input.referenceMediaIds) {
        const entityId = entityIdByMediaId.get(mediaId);
        const entity = entityId ? entityById.get(entityId) : undefined;
        if (!entity) continue;
        const name = (entity.displayName ?? entity.name).trim();
        if (!name) continue;
        const description = [entity.intro?.trim(), entity.appearance?.trim()]
          .filter((part): part is string => Boolean(part))
          .join(";");
        references.push({
          lane: entity.role?.trim() || "reference",
          name,
          ...(description ? { description } : {}),
        });
        referencedEntityIds.add(entity.id);
      }
    }
    if (input.shotId) {
      // v1.4(迁移 065):分镜-资产引用作为可编辑引用真值,补充/承接媒体快照条目。
      // 已由 referenceMediaIds 带入的实体跳过,避免同一实体双条目。
      const refRows = await this.db.select({
        entityId: assetEntities.id,
        role: assetEntities.role,
        name: assetEntities.name,
        displayName: assetEntities.displayName,
        intro: assetEntities.intro,
        appearance: assetEntities.appearance,
      }).from(shotAssetRefs)
        .innerJoin(assetEntities, eq(shotAssetRefs.assetEntityId, assetEntities.id))
        .where(and(
          eq(shotAssetRefs.shotId, input.shotId),
          isNull(shotAssetRefs.deletedAt),
          eq(shotAssetRefs.enabled, true),
          isNull(assetEntities.deletedAt),
        ))
        .orderBy(asc(shotAssetRefs.sortOrder), asc(shotAssetRefs.createdAt));
      for (const entity of refRows) {
        if (referencedEntityIds.has(entity.entityId)) continue;
        const name = (entity.displayName ?? entity.name).trim();
        if (!name) continue;
        const description = [entity.intro?.trim(), entity.appearance?.trim()]
          .filter((part): part is string => Boolean(part))
          .join(";");
        references.push({
          lane: entity.role?.trim() || "reference",
          name,
          ...(description ? { description } : {}),
        });
        referencedEntityIds.add(entity.entityId);
      }
    }
    // 主题兜底(PRD 决策 6:subject→characters):无角色引用条目时补一条 character。
    if (shotSubject && !references.some((entry) => entry.lane === "character")) {
      references.push({ lane: "character", name: shotSubject });
    }
    if (references.length > 0) context.references = references;
    return context;
  }

  private async batchSubmissionView(
    authorizationId: string,
    idempotentReplay: boolean,
    productionMode?: GenerationProductionMode,
  ): Promise<GenerationBatchSubmissionView> {
    const authorization = (await this.db.select().from(generationBatchAuthorizations)
      .where(eq(generationBatchAuthorizations.id, authorizationId)).limit(1))[0];
    if (!authorization) throw new Error("Generation batch authorization was not persisted");
    const itemRows = await this.db.select().from(generationBatchAuthorizationItems)
      .where(eq(generationBatchAuthorizationItems.authorizationId, authorizationId))
      .orderBy(generationBatchAuthorizationItems.position);
    const effectiveProductionMode = productionMode ?? await this.batchAuthorizationProductionMode(itemRows);
    const views = await Promise.all(itemRows.map(async (item) => (
      item.generationAttemptId ? this.findViewByAttemptId(item.generationAttemptId) : null
    )));
    const viewByAttemptId = new Map(
      views.filter((view): view is GenerationView => view !== null).map((view) => [view.attemptId, view]),
    );
    const items = itemRows.map((item) => batchItemViewFromRow(
      item,
      item.generationAttemptId ? viewByAttemptId.get(item.generationAttemptId) : undefined,
    ));
    const createdCount = items.filter((item) => item.status === "created").length;
    const failedCount = items.filter((item) => item.status !== "created" && item.status !== "confirmed").length;
    return {
      authorizationId: authorization.id,
      userId: authorization.userId,
      projectId: authorization.projectId,
      clientIdempotencyKey: authorization.clientIdempotencyKey,
      listHash: authorization.listHash,
      productionMode: effectiveProductionMode,
      status: batchAuthorizationStatus(authorization.status),
      authorizedTotalEstimatedCostFen: authorization.authorizedTotalEstimatedCostFen,
      submittedTotalEstimatedCostFen: authorization.submittedTotalEstimatedCostFen,
      currency: batchCurrency(authorization.currency),
      createdCount,
      failedCount,
      authorizedAt: authorization.authorizedAt,
      idempotentReplay,
      items,
    };
  }

  private async batchAuthorizationProductionMode(
    items: BatchAuthorizationItemRow[],
  ): Promise<GenerationProductionMode> {
    const quoteId = items[0]?.generationQuoteId;
    if (!quoteId) throw new Error("Generation batch authorization has no frozen items");
    const quote = (await this.db.select({ priceSnapshot: generationQuotes.priceSnapshot })
      .from(generationQuotes)
      .where(eq(generationQuotes.id, quoteId))
      .limit(1))[0];
    if (!quote) throw new Error("Generation batch authorization quote is missing");
    return productionModeFromSnapshot(quote.priceSnapshot);
  }

  private async withView(result: TransactionCreateResult): Promise<CreateGenerationResult> {
    if (!("attemptId" in result)) return result;
    const view = await this.findViewByAttemptId(result.attemptId);
    if (!view) throw new Error("Generation attempt was not persisted");
    return { outcome: result.outcome, view };
  }

  private async viewFromRow(request: RequestRow, attempt: AttemptRow): Promise<GenerationView> {
    const [media, waitingValue] = await Promise.all([
      this.persistedMedia(attempt.id),
      this.waitingValueForAttempt(request, attempt),
    ]);
    return {
      requestId: request.id,
      attemptId: attempt.id,
      projectId: request.projectId,
      ...(request.episodeId ? { episodeId: request.episodeId } : {}),
      ...(request.shotId ? { shotId: request.shotId } : {}),
      attemptNo: attempt.attemptNo,
      status: asStatus(attempt.status),
      phase: asPhase(attempt.phase),
      mediaKind: asGenerationMediaKind(request.mediaKind),
      tierId: attemptViewTierId(attempt.priceSnapshot),
      model: attempt.model,
      prompt: request.prompt,
      parameters: readStoredRequestParameters(request.parameters).parameters,
      estimatedCostFen: attempt.estimatedCostFen,
      ...(attempt.providerTaskId ? { providerTaskId: attempt.providerTaskId } : {}),
      media,
      referenceAssetSnapshots: readReferenceSnapshots(request.referenceAssetSnapshots),
      ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
      ...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {}),
      ...waitingValue,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    };
  }

  /**
   * `queuePosition` describes only the local worker's yet-to-submit queue. A
   * provider-queued attempt has no honest local position, so it returns null
   * and the existing phase vocabulary continues to describe its provider state.
   */
  private async waitingValueForAttempt(
    request: RequestRow,
    attempt: AttemptRow,
  ): Promise<Pick<GenerationView, "queuePosition" | "estimatedDurationSeconds" | "estimatedDurationSampleCount">> {
    if (attempt.status !== "pending" && attempt.status !== "running") {
      return { queuePosition: null, estimatedDurationSeconds: null, estimatedDurationSampleCount: 0 };
    }
    const [queuePosition, duration] = await Promise.all([
      attempt.status === "pending" && attempt.phase === "created"
        ? this.queuePositionForCreatedAttempt(attempt.id)
        : Promise.resolve(null),
      this.estimatedDurationForAttempt(request, attempt),
    ]);
    return {
      queuePosition,
      estimatedDurationSeconds: duration.seconds,
      estimatedDurationSampleCount: duration.sampleCount,
    };
  }

  /**
   * The station polls this list as one page, so calculate queue positions once
   * and deduplicate ETA history reads for equal frozen workloads. This avoids
   * turning one HTTP poll into one queue scan plus one history scan per row.
   */
  private async waitingValuesForInFlightRows(
    rows: Array<{ request: RequestRow; attempt: AttemptRow }>,
  ): Promise<Map<string, Pick<GenerationView, "queuePosition" | "estimatedDurationSeconds" | "estimatedDurationSampleCount">>> {
    const queueAttemptIds = rows.flatMap(({ attempt }) => (
      attempt.status === "pending" && attempt.phase === "created" ? [attempt.id] : []
    ));
    const queuePositionsPromise = this.queuePositionsForCreatedAttempts(queueAttemptIds);
    const durationPromises = new Map<string, Promise<{ seconds: number | null; sampleCount: number }>>();
    const durationKeyByAttemptId = new Map<string, string>();
    for (const { request, attempt } of rows) {
      const key = JSON.stringify([
        request.mediaKind,
        attempt.provider,
        attempt.model,
        attempt.quantity,
        attempt.parameters,
      ]);
      durationKeyByAttemptId.set(attempt.id, key);
      if (!durationPromises.has(key)) {
        durationPromises.set(key, this.estimatedDurationForAttempt(request, attempt));
      }
    }
    const [queuePositions, durationEntries] = await Promise.all([
      queuePositionsPromise,
      Promise.all([...durationPromises.entries()].map(async ([key, value]) => [key, await value] as const)),
    ]);
    const durationByKey = new Map(durationEntries);
    return new Map(rows.map(({ attempt }) => {
      const duration = durationByKey.get(durationKeyByAttemptId.get(attempt.id)!)
        ?? { seconds: null, sampleCount: 0 };
      return [attempt.id, {
        queuePosition: queuePositions.get(attempt.id) ?? null,
        estimatedDurationSeconds: duration.seconds,
        estimatedDurationSampleCount: duration.sampleCount,
      }];
    }));
  }

  private async queuePositionForCreatedAttempt(attemptId: string): Promise<number | null> {
    return (await this.queuePositionsForCreatedAttempts([attemptId])).get(attemptId) ?? null;
  }

  private async queuePositionsForCreatedAttempts(attemptIds: readonly string[]): Promise<Map<string, number>> {
    if (attemptIds.length === 0) return new Map();
    const now = new Date();
    const candidates = await this.db.select({ id: generationAttempts.id })
      .from(generationAttempts)
      .where(and(...recoverableAttemptConditions(now, this.allowNewSubmission)))
      .orderBy(...recoverableAttemptOrderBy())
      .for("update", { skipLocked: true });
    const wanted = new Set(attemptIds);
    return new Map(candidates.flatMap((candidate, index) => (
      wanted.has(candidate.id) ? [[candidate.id, index + 1] as const] : []
    )));
  }

  /**
   * "同类" is provider + media kind + model + quantity + frozen parameters.
   * It uses the last 20 successful end-to-end attempts (created→finished), so
   * the displayed value describes what a creator actually waits through rather
   * than provider time alone. Missing/invalid histories are excluded and never
   * replaced by a made-up fallback.
   */
  private async estimatedDurationForAttempt(
    request: RequestRow,
    attempt: AttemptRow,
  ): Promise<{ seconds: number | null; sampleCount: number }> {
    const histories = await this.db.select({
      createdAt: generationAttempts.createdAt,
      finishedAt: generationAttempts.finishedAt,
    }).from(generationAttempts)
      .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
      .where(and(
        eq(generationAttempts.provider, attempt.provider),
        eq(generationAttempts.model, attempt.model),
        eq(generationAttempts.quantity, attempt.quantity),
        eq(generationAttempts.parameters, attempt.parameters),
        eq(generationRequests.mediaKind, request.mediaKind),
        eq(generationAttempts.status, "succeeded"),
        isNotNull(generationAttempts.finishedAt),
        sql`${generationAttempts.finishedAt} >= ${generationAttempts.createdAt}`,
      ))
      .orderBy(desc(generationAttempts.finishedAt), desc(generationAttempts.id))
      .limit(ETA_HISTORY_SAMPLE_LIMIT);
    const durations = histories.flatMap((history) => {
      if (!history.finishedAt) return [];
      const seconds = Math.round((history.finishedAt.getTime() - history.createdAt.getTime()) / 1_000);
      return Number.isFinite(seconds) && seconds >= 0 ? [seconds] : [];
    });
    return {
      seconds: medianEstimatedDurationSeconds(durations),
      sampleCount: durations.length,
    };
  }

  private async persistedMedia(attemptId: string): Promise<StoredGenerationMedia[]> {
    const rows = await this.db.select().from(mediaResults).where(and(
      eq(mediaResults.attemptId, attemptId),
      eq(mediaResults.persistenceStatus, "persisted"),
      isNull(mediaResults.deletedAt),
    )).orderBy(mediaResults.resultIndex);
    return rows.flatMap(storedMediaFromRow);
  }

  /**
   * The succeeded/failed status and its in-site reminder are one database
   * transaction: a process crash cannot leave one of those outcomes with no
   * durable way for its owner to discover it after navigating away.
   */
  private async updateTerminalAttempt(
    attemptId: string,
    patch: Partial<AttemptRow>,
    leaseOwner?: string,
    options: {
      discardPersistedMedia?: boolean;
      compensationFailureCode?: string;
    } = {},
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      // v1.9 十.6：成功才扣——终态跃迁同事务内结算绑定报价：
      // succeeded → consume（触发器扣积分）；failed → void（不扣费）。
      if (patch.status === "succeeded" || patch.status === "failed" || patch.status === "cancelled") {
        await settleBoundQuote(transaction as unknown as Database, attemptId, patch.status);
      }
      const updated = await transaction.update(generationAttempts).set(patch)
        .where(attemptMutationCondition(attemptId, leaseOwner))
        .returning({ id: generationAttempts.id });
      if (updated.length === 0) {
        if (leaseOwner) throw new GenerationAttemptLeaseLostError(attemptId);
        return;
      }
      const recipient = (await transaction.select({
        userId: generationRequests.userId,
        requestId: generationRequests.id,
        projectId: generationRequests.projectId,
      }).from(generationAttempts)
        .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
        .where(eq(generationAttempts.id, attemptId))
        .limit(1))[0];
      if (!recipient) throw generationNotFound();
      if (options.compensationFailureCode) {
        const consumedQuotes = await transaction.select({
          id: generationQuotes.id,
          estimatedCostFen: generationQuotes.estimatedCostFen,
        }).from(generationQuotes).where(and(
          eq(generationQuotes.generationAttemptId, attemptId),
          eq(generationQuotes.status, "consumed"),
        ));
        if (consumedQuotes.length === 0) {
          throw new Error("AIGC compensation fact requires a consumed generation quote");
        }
        const createdAt = patch.finishedAt instanceof Date ? patch.finishedAt : new Date();
        await transaction.insert(generationBillingFailureFacts).values(consumedQuotes.map((quote) => ({
          id: crypto.randomUUID(),
          attemptId,
          quoteId: quote.id,
          userId: recipient.userId,
          projectId: recipient.projectId,
          failureCode: options.compensationFailureCode!,
          reservedAmountFen: quote.estimatedCostFen,
          providerCostStatus: "incurred",
          resolutionStatus: "pending_compensation",
          createdAt,
          updatedAt: createdAt,
        }))).onConflictDoNothing({
          target: [generationBillingFailureFacts.attemptId, generationBillingFailureFacts.quoteId],
        });
      }
      if (options.discardPersistedMedia) {
        // A provider result can already have been partially persisted when a
        // recovered worker discovers that a remaining result fails local
        // acceptance (for example, its AIGC label cannot be written). A
        // failed attempt must never leave those earlier rows selectable for
        // review or delivery. Keep this in the terminal-state transaction so
        // a crash cannot expose a terminal failed attempt with a half batch.
        await withdrawFailedAttemptOutputs(
          transaction as unknown as Database,
          attemptId,
          patch.finishedAt instanceof Date ? patch.finishedAt : new Date(),
          patch.updatedAt instanceof Date ? patch.updatedAt : new Date(),
        );
      }
      await transaction.insert(generationAttemptNotifications).values({
        id: crypto.randomUUID(),
        attemptId,
        generationRequestId: recipient.requestId,
        projectId: recipient.projectId,
        userId: recipient.userId,
        acknowledgedAt: null,
        createdAt: patch.finishedAt instanceof Date ? patch.finishedAt : new Date(),
      }).onConflictDoNothing({ target: generationAttemptNotifications.attemptId });
    });
  }

  private async updateAttempt(
    attemptId: string,
    patch: Partial<AttemptRow>,
    leaseOwner?: string,
  ): Promise<void> {
    const updated = await this.db.update(generationAttempts).set(patch)
      .where(attemptMutationCondition(attemptId, leaseOwner))
      .returning({ id: generationAttempts.id });
    if (leaseOwner && updated.length === 0) throw new GenerationAttemptLeaseLostError(attemptId);
  }

  private nextPollAt(): Date {
    return new Date(Date.now() + this.pollIntervalMs);
  }
}

/**
 * Withdraws every application-visible fact derived from a failed partial
 * batch. Provenance rows remain immutable audit evidence, while admission and
 * candidate projections are closed in the same transaction as the terminal
 * attempt transition.
 */
async function withdrawFailedAttemptOutputs(
  db: Database,
  attemptId: string,
  withdrawnAt: Date,
  updatedAt: Date = withdrawnAt,
): Promise<void> {
  const outputs = await db.select({
    id: mediaResults.id,
    providerResultKey: mediaResults.providerResultKey,
    storageBucket: mediaResults.storageBucket,
    storagePath: mediaResults.storagePath,
    createdAt: mediaResults.createdAt,
  }).from(mediaResults).where(and(
    eq(mediaResults.attemptId, attemptId),
    eq(mediaResults.persistenceStatus, "persisted"),
    isNull(mediaResults.deletedAt),
  ));
  const mediaResultIds = outputs.map((output) => output.id);
  if (mediaResultIds.length === 0) return;
  const recipient = (await db.select({
    userId: generationRequests.userId,
    projectId: generationRequests.projectId,
  }).from(generationAttempts)
    .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
    .where(eq(generationAttempts.id, attemptId))
    .limit(1))[0];
  if (!recipient) throw generationNotFound();

  // The objects remain in TOS after this local withdrawal.  Re-open their
  // object ledger entries for S69's later inventory/cleanup workflow instead
  // of pretending that an upload never happened or deleting it in this path.
  const uploadedObjects = outputs.flatMap((output) => (
    output.providerResultKey && output.storageBucket && output.storagePath
      ? [{
        id: crypto.randomUUID(),
        attemptId,
        userId: recipient.userId,
        projectId: recipient.projectId,
        mediaResultId: output.id,
        providerResultKey: output.providerResultKey,
        storageBucket: output.storageBucket,
        objectKey: output.storagePath,
        producedAt: output.createdAt,
        cleanupStatus: "pending_cleanup",
        createdAt: withdrawnAt,
        updatedAt,
      }]
      : []
  ));
  if (uploadedObjects.length > 0) {
    await db.insert(generationTosOrphans).values(uploadedObjects).onConflictDoUpdate({
      target: [generationTosOrphans.storageBucket, generationTosOrphans.objectKey],
      set: {
        attemptId,
        userId: recipient.userId,
        projectId: recipient.projectId,
        mediaResultId: sql`excluded.media_result_id`,
        providerResultKey: sql`excluded.provider_result_key`,
        cleanupStatus: "pending_cleanup",
        updatedAt,
      },
    });
  }

  const promoted = await db.select({ assetMediaId: seedanceAssetRegistrations.assetMediaId })
    .from(seedanceAssetRegistrations)
    .where(inArray(seedanceAssetRegistrations.sourceMediaResultId, mediaResultIds));
  const promotedAssetMediaIds = [...new Set(promoted.map((row) => row.assetMediaId))];
  const promotedShotResults = promotedAssetMediaIds.length > 0
    ? await db.select({ id: mediaResults.id }).from(mediaResults).where(and(
      inArray(mediaResults.sourceAssetMediaId, promotedAssetMediaIds),
      eq(mediaResults.originKind, "asset_media"),
      isNull(mediaResults.deletedAt),
    ))
    : [];
  const withdrawnMediaResultIds = [
    ...mediaResultIds,
    ...promotedShotResults.map((result) => result.id),
  ];

  await db.update(mediaResults).set({
    deletedAt: withdrawnAt,
    deletedByUserId: null,
    updatedAt,
  }).where(and(
    inArray(mediaResults.id, withdrawnMediaResultIds),
    isNull(mediaResults.deletedAt),
  ));

  await db.update(shots).set({
    selectedImageResultId: null,
    updatedAt,
  }).where(inArray(shots.selectedImageResultId, withdrawnMediaResultIds));
  await db.update(shots).set({
    selectedVideoResultId: null,
    updatedAt,
  }).where(inArray(shots.selectedVideoResultId, withdrawnMediaResultIds));

  // An unselected audio candidate is only a projection of its source result.
  // Remove it rather than attributing a synthetic discard action to a user.
  await db.delete(audioVersions).where(and(
    inArray(audioVersions.mediaResultId, mediaResultIds),
    eq(audioVersions.status, "candidate"),
  ));

  // Preserve the opaque remote ID for reconciliation, but revoke local
  // admission immediately. The prior human last-action attribution remains
  // untouched because this withdrawal is system-owned.
  await db.update(seedanceAssetRegistrations).set({
    status: "unavailable",
    activatedAt: null,
    latestErrorCode: "SOURCE_GENERATION_WITHDRAWN",
    latestErrorMessage: "来源生成失败，火山素材本地准入已撤销",
    updatedAt,
  }).where(inArray(seedanceAssetRegistrations.sourceMediaResultId, mediaResultIds));

  const controlPackageRefs = sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier("control_package_refs")}`;
  const resultValues = sql.join(withdrawnMediaResultIds.map((id) => sql`${id}`), sql`, `);
  if (promotedAssetMediaIds.length > 0) {
    const assetValues = sql.join(promotedAssetMediaIds.map((id) => sql`${id}`), sql`, `);
    await db.execute(sql`
      DELETE FROM ${controlPackageRefs}
      WHERE media_result_id IN (${resultValues})
         OR asset_media_id IN (${assetValues})
    `);
  } else {
    await db.execute(sql`
      DELETE FROM ${controlPackageRefs}
      WHERE media_result_id IN (${resultValues})
    `);
  }

  if (promotedAssetMediaIds.length > 0) {
    await db.update(assetMedia).set({
      deletedAt: withdrawnAt,
      deletedByUserId: null,
    }).where(and(
      inArray(assetMedia.id, promotedAssetMediaIds),
      isNull(assetMedia.deletedAt),
    ));
  }
}

/** Every worker-owned mutation uses the same lease compare-and-set predicate. */
function attemptMutationCondition(attemptId: string, leaseOwner?: string) {
  return and(
    eq(generationAttempts.id, attemptId),
    inArray(generationAttempts.status, ["pending", "running"]),
    ...(leaseOwner ? [
      eq(generationAttempts.leaseOwner, leaseOwner),
      gt(generationAttempts.leaseUntil, sql`now()`),
    ] : []),
  );
}

function assertLeaseOwner(
  attemptId: string,
  expectedLeaseOwner: string | undefined,
  actualLeaseOwner: string | null,
  actualStatus: string,
): void {
  if (
    expectedLeaseOwner
    && (
      actualLeaseOwner !== expectedLeaseOwner
      || (actualStatus !== "pending" && actualStatus !== "running")
    )
  ) {
    throw new GenerationAttemptLeaseLostError(attemptId);
  }
}

type SeedanceAdmissionStatus =
  | "usable"
  | "verification_expired"
  | "authorization_expired"
  | "different_media_version_registered"
  | "provider_asset_id_mismatch"
  | "unregistered";

const seedanceAdmissionMessages = {
  verification_expired: "这张图片的素材登记核验已过期，请刷新登记后再生成",
  authorization_expired: "这张图片的素材登记授权已过期，请重新登记或联系管理员协助",
  different_media_version_registered: "当前选中的图片版本尚未登记，请选择已登记的版本或登记当前版本",
  provider_asset_id_mismatch: "Seedance CreateAsset 登记已失效或远端素材编号已变化，请刷新后重新提交",
  unregistered: "这张图片还未完成视频生成所需的素材登记，请先点击“转为参考资产”",
  usable: "这张图片还未完成视频生成所需的素材登记，请先点击“转为参考资产”",
} satisfies Record<SeedanceAdmissionStatus, string>;

interface SeedanceAdmission {
  /** Current `asset://` identity from either registration truth or provider library truth. */
  remoteAssetId: string | null;
  status: SeedanceAdmissionStatus;
}

/**
 * Resolves the CreateAsset registration admission from PostgreSQL facts.
 */
async function loadSeedanceAdmission(db: Database, assetMediaId: string): Promise<SeedanceAdmission> {
  const subject = (await db.select({
    id: mediaProvenanceSubjects.id,
    sourceChannel: mediaProvenanceSubjects.sourceChannel,
    providerAssetId: mediaProvenanceSubjects.providerAssetId,
  }).from(mediaProvenanceSubjects)
    .where(eq(mediaProvenanceSubjects.assetMediaId, assetMediaId))
    .limit(1))[0] ?? null;
  const exactMedia = (await db.select({ assetEntityId: assetMedia.assetEntityId })
    .from(assetMedia)
    .where(and(eq(assetMedia.id, assetMediaId), isNull(assetMedia.deletedAt)))
    .limit(1))[0] ?? null;
  const registrations = await db.select({
    assetMediaId: seedanceAssetRegistrations.assetMediaId,
    remoteAssetId: seedanceAssetRegistrations.remoteAssetId,
    status: seedanceAssetRegistrations.status,
    lastVerifiedAt: seedanceAssetRegistrations.lastVerifiedAt,
    authorizationExpiresAt: seedanceAssetRegistrations.authorizationExpiresAt,
    sourceMediaResultId: seedanceAssetRegistrations.sourceMediaResultId,
    sourceMediaResultDeletedAt: mediaResults.deletedAt,
    sourceAttemptStatus: generationAttempts.status,
  }).from(seedanceAssetRegistrations)
    .leftJoin(mediaResults, eq(seedanceAssetRegistrations.sourceMediaResultId, mediaResults.id))
    .leftJoin(generationAttempts, eq(mediaResults.attemptId, generationAttempts.id))
    .leftJoin(assetMedia, eq(seedanceAssetRegistrations.assetMediaId, assetMedia.id))
    .where(and(
      exactMedia?.assetEntityId
        ? eq(assetMedia.assetEntityId, exactMedia.assetEntityId)
        : eq(seedanceAssetRegistrations.assetMediaId, assetMediaId),
      isNull(assetMedia.deletedAt),
    ));
  const now = Date.now();
  const isSourceUsable = (registration: typeof registrations[number]) => (
    registration.sourceMediaResultId === null
    || (registration.sourceMediaResultDeletedAt === null && registration.sourceAttemptStatus === "succeeded")
  );
  const isUsable = (registration: typeof registrations[number]) => (
    registration.status === "active"
    && registration.remoteAssetId !== null
    && registration.lastVerifiedAt !== null
    && registration.lastVerifiedAt.getTime() > now - SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS
    && (registration.authorizationExpiresAt === null || registration.authorizationExpiresAt.getTime() > now)
    && isSourceUsable(registration)
  );
  const exactRegistration = registrations.find(
    (registration) => registration.assetMediaId === assetMediaId,
  ) ?? null;
  const exactUsable = exactRegistration && isUsable(exactRegistration) ? exactRegistration : null;
  const exactRemoteAssetId = exactUsable?.remoteAssetId ?? null;
  if (exactRemoteAssetId) {
    if (subject?.sourceChannel === "provider_library" && subject.providerAssetId !== exactRemoteAssetId) {
      return { remoteAssetId: null, status: "provider_asset_id_mismatch" };
    }
    return { remoteAssetId: exactRemoteAssetId, status: "usable" };
  }
  const exactActive = exactRegistration
    && exactRegistration.status === "active"
    && exactRegistration.remoteAssetId !== null
    && isSourceUsable(exactRegistration)
    ? exactRegistration
    : null;
  if (exactActive) {
    if (exactActive.lastVerifiedAt === null) {
      return { remoteAssetId: null, status: "unregistered" };
    }
    if (exactActive.lastVerifiedAt.getTime() <= now - SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS) {
      return { remoteAssetId: null, status: "verification_expired" };
    }
    if (exactActive.authorizationExpiresAt !== null && exactActive.authorizationExpiresAt.getTime() <= now) {
      return { remoteAssetId: null, status: "authorization_expired" };
    }
  }
  if (registrations.some((registration) => registration.assetMediaId !== assetMediaId && isUsable(registration))) {
    return { remoteAssetId: null, status: "different_media_version_registered" };
  }
  return { remoteAssetId: null, status: "unregistered" };
}

/**
 * A selected row can still belong to the nominal worker after `lease_until`
 * has elapsed.  Durable writes therefore need an explicit database-clock
 * fence, not only the owner/status check used for in-memory branch selection.
 */
async function assertLiveLeaseAtDatabaseNow(
  db: Database,
  attemptId: string,
  leaseOwner?: string,
): Promise<void> {
  if (!leaseOwner) return;
  const live = await db.select({ id: generationAttempts.id })
    .from(generationAttempts)
    .where(attemptMutationCondition(attemptId, leaseOwner))
    .limit(1);
  if (live.length !== 1) throw new GenerationAttemptLeaseLostError(attemptId);
}

/**
 * A remote Ark asset is eligible only after GetAsset reports Active. We keep
 * first/last-frame semantics on the direct TOS image URL: the current Ark
 * contract documents asset:// for the all-reference collection, not anchors.
 */
export function providerReferenceUrl(
  storageUrl: string,
  usageMode: ControlUsageMode,
  activeRemoteAssetId: string | null,
  useRegisteredSeedanceAssetUris = false,
  admissionStatus: SeedanceAdmissionStatus = "unregistered",
): string {
  if (!useRegisteredSeedanceAssetUris) return storageUrl;
  if (usageMode === "reference" && activeRemoteAssetId) {
    return `asset://${activeRemoteAssetId}`;
  }
  // The Ark contract only uses asset:// for the ordinary all-reference
  // collection. An actively verified CreateAsset mapping still authorizes the
  // original TOS URL when the same image occupies a first/last-frame slot.
  if (activeRemoteAssetId) return storageUrl;
  throw invalidSeedanceReference(seedanceAdmissionMessages[admissionStatus]);
}

async function lockQuote(
  db: Database,
  actorId: string,
  quoteId: string,
): Promise<QuoteRow> {
  const quote = (await db.select().from(generationQuotes).where(and(
    eq(generationQuotes.id, quoteId),
    ...generationQuoteActorScope(actorId),
  )).limit(1).for("update"))[0];
  if (!quote) throw quoteNotFound();
  return quote;
}

/**
 * A quote belongs to the project carried by its immutable normalized request;
 * retry quotes also carry a durable original request. Re-check this inside
 * the write transaction so a route's earlier access decision cannot be used
 * to consume a quote from another project.
 */
async function assertQuoteProjectScope(
  db: Database,
  actorId: string,
  quote: QuoteRow,
  authorizedProjectId: string,
): Promise<void> {
  const projectId = await quoteProjectId(db, quote.originalRequestId, quote.normalizedRequest);
  if (!projectId) throw quoteNotFound();
  await assertCurrentProjectCreateAccess(db, actorId, projectId, authorizedProjectId);
}

/**
 * The route's authorization is stale by the time a paid quote is consumed.
 * Lock the project, actor and membership rows in the write transaction so a
 * concurrent revocation, deactivation or project deletion cannot race the
 * request/attempt write. The decision itself stays in project-access policy.
 */
async function assertCurrentProjectCreateAccess(
  db: Database,
  actorId: string,
  projectId: string,
  authorizedProjectId: string,
  notFound: () => GenerationError = quoteNotFound,
): Promise<void> {
  if (authorizedProjectId !== projectId) throw notFound();

  const project = (await db.select({
    id: projects.id,
    ownerUserId: projects.ownerUserId,
  }).from(projects).where(and(
    eq(projects.id, projectId),
    isNull(projects.deletedAt),
  )).limit(1).for("share"))[0];
  if (!project) throw notFound();

  const actor = (await db.select({
    id: users.id,
    active: users.active,
    role: users.role,
  }).from(users).where(eq(users.id, actorId)).limit(1).for("share"))[0];
  if (!actor?.active) throw notFound();

  const membership = (await db.select({ role: projectMembers.role }).from(projectMembers)
    .where(and(
      eq(projectMembers.projectId, project.id),
      eq(projectMembers.userId, actor.id),
    ))
    .limit(1)
    .for("share"))[0];
  const access = resolveProjectAccess({ id: actor.id, role: actor.role }, {
    projectId: project.id,
    ownerUserId: project.ownerUserId,
    membershipRole: membership?.role ?? null,
  });
  if (!access || !canPerformProjectAction(access, "create")) throw notFound();
}

async function quoteProjectId(
  db: Database,
  originalRequestId: string | null,
  normalizedRequest: Record<string, unknown>,
): Promise<string | null> {
  if (originalRequestId) {
    const request = (await db.select({ projectId: generationRequests.projectId })
      .from(generationRequests)
      .where(eq(generationRequests.id, originalRequestId))
      .limit(1))[0];
    return request?.projectId ?? null;
  }
  const projectId = [normalizedRequest.projectId, normalizedRequest.project_id]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return projectId ?? null;
}

/**
 * Paid write ownership never follows a project capability. The capability is
 * only an additional exact-project constraint after the actor-owned row has
 * been selected.
 */
function generationRequestActorScope(actorId: string, authorizedProjectId?: string) {
  return [
    generationActorOwnership(generationRequests.userId, actorId),
    ...(authorizedProjectId ? [eq(generationRequests.projectId, authorizedProjectId)] : []),
  ];
}

/**
 * Project authorization grants read visibility only. It never changes the
 * actor recorded on the request, quote, debit account, or ledger entry.
 */
function generationRequestVisibilityScope(actorId: string, authorizedProjectId?: string) {
  return authorizedProjectId
    ? [eq(generationRequests.projectId, authorizedProjectId)]
    : [generationActorOwnership(generationRequests.userId, actorId)];
}

/** The sole ownership predicate for every paid generation resource. */
function generationActorOwnership(userIdColumn: AnyColumn, actorId: string) {
  return eq(userIdColumn, actorId);
}

/** One canonical quote-owner scope shared by every paid quote transition. */
function generationQuoteActorScope(actorId: string) {
  return [generationActorOwnership(generationQuotes.userId, actorId)];
}

function assertQuoteRequest(
  quote: QuoteRow,
  source: GenerationQuoteSource,
  action: "submit" | "retry",
  request: NormalizedGenerationInput,
  originalRequestId?: string,
): void {
  assertQuoteIdentity(quote, source, action, originalRequestId);
  if (!quoteRequestHashMatches(quote, request)) {
    throw new GenerationError(
      "GENERATION_QUOTE_CONFLICT",
      "这张报价单与当前生成输入不一致",
      409,
    );
  }
}

function quoteRequestHashMatches(quote: QuoteRow, request: NormalizedGenerationInput): boolean {
  if (quote.requestHash === hashGenerationRequest(request)) return true;
  return request.productionMode === "full"
    && !Object.prototype.hasOwnProperty.call(quote.normalizedRequest, "productionMode")
    && !Object.prototype.hasOwnProperty.call(quote.normalizedRequest, "production_mode")
    && quote.requestHash === hashLegacyFullGenerationRequest(request);
}

function assertQuoteIdentity(
  quote: QuoteRow,
  source: GenerationQuoteSource,
  action: "submit" | "retry",
  originalRequestId?: string,
): void {
  if (quote.source !== source) {
    throw new GenerationError(
      "GENERATION_QUOTE_SOURCE_MISMATCH",
      "这张报价单不能在当前入口使用，请从当前页面重新报价",
      409,
    );
  }
  if (quote.action !== action || (quote.originalRequestId ?? undefined) !== originalRequestId) {
    throw new GenerationError(
      "GENERATION_QUOTE_CONFLICT",
      "这张报价单与当前生成操作不一致",
      409,
    );
  }
}

function assertConfirmedAndFresh(quote: QuoteRow, actorId: string, now = new Date()): void {
  if (quote.expiresAt.getTime() <= now.getTime()) throw quoteExpired();
  if (quote.status !== "confirmed" || !quote.confirmedAt) {
    throw new GenerationError(
      "GENERATION_QUOTE_UNCONFIRMED",
      "请先明确确认这张生成费用报价单",
      409,
    );
  }
  assertQuoteConfirmedByActor(quote, actorId);
}

function assertQuoteConfirmedByActor(quote: QuoteRow, actorId: string): void {
  if (quote.confirmedByUserId !== actorId || quote.userId !== actorId) {
    throw quoteStale("报价缺少有效确认人，请重新估价并确认");
  }
}

function assertQuotePriceCurrent(quote: QuoteRow, cost: CostEstimate): void {
  if (quote.pricingRuleId !== cost.pricingRuleId
    || quote.estimatedCostFen !== cost.estimatedCostFen
    || canonicalJson(costSnapshot(quote.priceSnapshot)) !== canonicalJson(cost)) {
    throw quoteStale();
  }
}

async function assertQuoteTierCurrent(db: Database, quote: QuoteRow): Promise<void> {
  const request = quote.normalizedRequest;
  const tierId = typeof request.tierId === "string" ? request.tierId : undefined;
  const mediaKind = request.mediaKind === "image" || request.mediaKind === "video" || request.mediaKind === "audio"
    ? request.mediaKind
    : undefined;
  const parameters = isRecord(request.parameters) ? request.parameters : undefined;
  const quantity = typeof request.quantity === "number" ? request.quantity : undefined;
  if (!tierId || !mediaKind || !parameters || !quantity) {
    throw quoteStale("报价缺少生成档位快照，请重新估价");
  }
  await requireCurrentTier(db, { tierId, mediaKind, parameters, quantity });
}

function assertRetryBaseCurrent(quote: QuoteRow, prior: AttemptRow): void {
  if (quote.baseAttemptId !== prior.id || quote.baseAttemptNo !== prior.attemptNo) {
    throw quoteStale("重试基础任务已变化，请重新估价并确认");
  }
}

function consumedQuoteResult(quote: QuoteRow): TransactionCreateResult {
  if (!quote.generationAttemptId || !quote.generationRequestId) {
    throw new Error("Consumed generation quote has no bound request or attempt");
  }
  return { outcome: "existing", attemptId: quote.generationAttemptId };
}
/** 完整版批量授权路径沿用旧合同：提交即消费（触发器扣费）。单发/重试已改绑定+成功才扣（十.6）。 */
async function consumeQuote(
  db: Database,
  actorId: string,
  quoteId: string,
  requestId: string,
  attemptId: string,
  now = new Date(),
): Promise<void> {
  const updated = await db.update(generationQuotes).set({
    status: "consumed",
    consumedAt: now,
    generationRequestId: requestId,
    generationAttemptId: attemptId,
    updatedAt: now,
  }).where(and(
    eq(generationQuotes.id, quoteId),
    ...generationQuoteActorScope(actorId),
    eq(generationQuotes.confirmedByUserId, actorId),
    eq(generationQuotes.status, "confirmed"),
  )).returning({ id: generationQuotes.id });
  if (!updated[0]) {
    throw new GenerationError(
      "GENERATION_QUOTE_CONFLICT",
      "报价单已被其他请求处理",
      409,
    );
  }
}

async function bindQuote(
  db: Database,
  actorId: string,
  quoteId: string,
  requestId: string,
  attemptId: string,
  now = new Date(),
): Promise<void> {
  const updated = await db.update(generationQuotes).set({
    generationRequestId: requestId,
    generationAttemptId: attemptId,
    updatedAt: now,
  }).where(and(
    eq(generationQuotes.id, quoteId),
    ...generationQuoteActorScope(actorId),
    eq(generationQuotes.confirmedByUserId, actorId),
    eq(generationQuotes.status, "confirmed"),
    isNull(generationQuotes.generationAttemptId),
  )).returning({ id: generationQuotes.id });
  if (!updated[0]) {
    throw new GenerationError(
      "GENERATION_QUOTE_CONFLICT",
      "报价单已被其他请求处理",
      409,
    );
  }
}

/** 幂等重入：报价已绑定到同一 attempt 时放行，绑定到别处时冲突。 */
async function bindQuoteIfUnbound(
  db: Database,
  actorId: string,
  quoteId: string,
  requestId: string,
  attemptId: string,
): Promise<void> {
  const row = (await db.select({ generationAttemptId: generationQuotes.generationAttemptId })
    .from(generationQuotes)
    .where(and(
      eq(generationQuotes.id, quoteId),
      ...generationQuoteActorScope(actorId),
    )).limit(1))[0];
  if (!row) {
    throw new GenerationError("GENERATION_QUOTE_CONFLICT", "报价单已被其他请求处理", 409);
  }
  if (row.generationAttemptId === attemptId) return;
  if (row.generationAttemptId === null) {
    await bindQuote(db, actorId, quoteId, requestId, attemptId);
    return;
  }
  throw new GenerationError("GENERATION_QUOTE_CONFLICT", "报价单已被其他请求处理", 409);
}

/** v1.9 十.6：终态结算。succeeded → consumed（迁移 034 触发器扣积分）；failed/cancelled → voided（不扣费）。 */
async function settleBoundQuote(db: Database, attemptId: string, status: "succeeded" | "failed" | "cancelled"): Promise<void> {
  const now = new Date();
  if (status === "succeeded") {
    await db.execute(sql`
      UPDATE ${generationQuotes}
      SET status = 'consumed', consumed_at = ${now}, updated_at = ${now}
      WHERE generation_attempt_id = ${attemptId} AND status = 'confirmed'
    `);
    return;
  }
  await db.execute(sql`
    UPDATE ${generationQuotes}
    SET status = 'voided', updated_at = ${now}
    WHERE generation_attempt_id = ${attemptId} AND status IN ('pending_confirmation', 'confirmed')
  `);
}

function assertBatchAuthorizationIdentity(
  existing: BatchAuthorizationRow,
  batch: BatchGenerationSubmitInput,
  listHash: string,
): void {
  if (existing.projectId !== batch.projectId
    || existing.listHash !== listHash
    || existing.authorizedTotalEstimatedCostFen !== batch.expectedTotalEstimatedCostFen) {
    throw new GenerationError(
      "IDEMPOTENCY_CONFLICT",
      "这个批次幂等键已经用于另一份清单",
      409,
    );
  }
}

async function assertQuoteNotReservedForBatch(db: Database, quoteId: string): Promise<void> {
  const reserved = (await db.select({ id: generationBatchAuthorizationItems.id })
    .from(generationBatchAuthorizationItems)
    .innerJoin(
      generationBatchAuthorizations,
      eq(generationBatchAuthorizations.id, generationBatchAuthorizationItems.authorizationId),
    )
    .where(and(
      eq(generationBatchAuthorizationItems.generationQuoteId, quoteId),
      eq(generationBatchAuthorizationItems.status, "confirmed"),
      eq(generationBatchAuthorizations.status, "confirmed"),
    ))
    .limit(1))[0];
  if (reserved) {
    throw new GenerationError(
      "GENERATION_QUOTE_CONFLICT",
      "这份报价已经属于已确认的批量清单，请提交对应的批量授权",
      409,
    );
  }
}

function batchAuthorizationNotFound(): GenerationError {
  return new GenerationError(
    "GENERATION_BATCH_AUTHORIZATION_NOT_FOUND",
    "批量生成授权不存在或你没有访问权限",
    404,
  );
}

function assertBatchQuoteProductionMode(quote: QuoteRow, productionMode: GenerationProductionMode): void {
  if (productionModeFromSnapshot(quote.priceSnapshot) !== productionMode) {
    throw new GenerationError(
      "GENERATION_QUOTE_CONFLICT",
      "报价模式与本次提交不一致，请按当前生产模式重新估价",
      409,
    );
  }
}

function sumBatchQuoteCost(
  batch: BatchGenerationSubmitInput,
  quotesById: ReadonlyMap<string, QuoteRow>,
): number {
  let total = 0;
  for (const item of batch.items) {
    const quote = quotesById.get(item.quoteId);
    if (!quote) throw new Error("Batch quote is missing");
    total += quote.estimatedCostFen;
    if (!Number.isSafeInteger(total)) {
      throw new GenerationError("INVALID_GENERATION_REQUEST", "清单总价超出安全范围", 400);
    }
  }
  return total;
}

function assertBatchQuoteReady(quote: QuoteRow, now: Date): void {
  if (quote.expiresAt.getTime() <= now.getTime()) throw quoteExpired();
  if (quote.status !== "pending_confirmation") {
    throw new GenerationError(
      "GENERATION_QUOTE_CONFLICT",
      "报价已被确认或消费，请重新估价后加入新的清单",
      409,
    );
  }
}

function batchRequestFromQuote(
  quote: QuoteRow,
  authorizationId: string,
  itemId: string,
): NormalizedGenerationInput {
  const input = {
    ...(quote.normalizedRequest as unknown as SubmitGenerationInput),
    clientIdempotencyKey: `batch-${authorizationId}-${itemId}`,
  };
  return normalizeGenerationInput(input);
}

function batchFailure(error: GenerationError): {
  status: Exclude<GenerationBatchItemStatus, "created" | "confirmed">;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    statusCode: number;
    details: unknown | null;
  };
} {
  const publicError = errorBody(error);
  const status: Exclude<GenerationBatchItemStatus, "created" | "confirmed"> = error.code === "GENERATION_QUOTE_EXPIRED"
    ? "expired"
    : error.code === "quote_stale"
      ? "price_changed"
      : error.code === "GENERATION_BUDGET_EXCEEDED"
        ? "budget_blocked"
        : [
          "GENERATION_QUOTE_NOT_FOUND",
          "GENERATION_QUOTE_UNCONFIRMED",
          "GENERATION_QUOTE_CONFLICT",
          "GENERATION_QUOTE_SOURCE_MISMATCH",
          "GENERATION_QUOTE_CONTEXT_MISMATCH",
          "GENERATION_QUOTE_INVALID_SNAPSHOT",
        ].includes(error.code)
          ? "quote_unavailable"
          : "failed";
  return {
    status,
    error: {
      code: publicError.code,
      message: publicError.message,
      retryable: publicError.retryable || status !== "quote_unavailable",
      statusCode: error.statusCode,
      details: publicError.details,
    },
  };
}

function batchAuthorizationStatus(value: string): GenerationBatchAuthorizationStatus {
  if (value === "confirmed" || value === "completed" || value === "partial" || value === "failed") return value;
  throw new Error("Generation batch authorization status is invalid");
}

function batchItemStatus(value: string): GenerationBatchItemStatus {
  if (["confirmed", "created", "expired", "price_changed", "budget_blocked", "quote_unavailable", "failed"].includes(value)) {
    return value as GenerationBatchItemStatus;
  }
  throw new Error("Generation batch item status is invalid");
}

function batchCurrency(value: string): "CNY" {
  if (value !== "CNY") throw new Error("Generation batch currency is invalid");
  return "CNY";
}

function batchItemViewFromRow(
  row: BatchAuthorizationItemRow,
  view?: GenerationView,
): GenerationBatchSubmissionView["items"][number] {
  const status = batchItemStatus(row.status);
  const storedError = row.failureCode || row.failureMessage
    ? errorBody(new GenerationError(
        batchFailureCode(row.failureCode),
        row.failureMessage ?? "这项生成任务没有创建，请重新估价后再次确认",
        row.failureStatusCode ?? 422,
        status !== "quote_unavailable",
        row.failureDetails,
      ))
    : undefined;
  const error = storedError
    ? {
        ...storedError,
        statusCode: row.failureStatusCode ?? 422,
      }
    : undefined;
  return {
    itemId: row.itemId,
    quoteId: row.generationQuoteId,
    estimatedCostFen: row.estimatedCostFen,
    status,
    ...(row.generationRequestId ? { generationRequestId: row.generationRequestId } : {}),
    ...(row.generationAttemptId ? { generationAttemptId: row.generationAttemptId } : {}),
    ...(view ? {
      queuePosition: view.queuePosition,
      estimatedDurationSeconds: view.estimatedDurationSeconds,
    } : {}),
    ...(error ? { error } : {}),
  };
}

function batchFailureCode(value: string | null): GenerationError["code"] {
  return (value ?? "INVALID_GENERATION_REQUEST") as GenerationError["code"];
}

async function assertQuoteSource(
  db: Database,
  actorId: string,
  source: GenerationQuoteSource,
  assistantSessionId?: string,
): Promise<void> {
  if (assistantSessionId && source !== "assistant") {
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      "只有助手报价可以绑定助手会话",
      400,
    );
  }
  if (!assistantSessionId) return;
  const session = (await db.select({ id: agentSessions.id }).from(agentSessions).where(and(
    eq(agentSessions.id, assistantSessionId),
    eq(agentSessions.userId, actorId),
    isNull(agentSessions.deletedAt),
  )).limit(1))[0];
  if (!session) {
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      "助手会话不存在或不属于当前用户",
      400,
    );
  }
}

function assertQuoteTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Generation quote ttlSeconds must be a positive integer");
  }
}

async function requireCurrentCost(
  db: Database,
  request: NormalizedGenerationInput,
): Promise<CostEstimate> {
  const tier = resolveTierFromPricingRules(
    await findActivePricingRules(db, request.mediaKind, new Date()),
    { model: request.model, tierId: request.tierId },
  );
  if (!tier) {
    throw quoteStale("当前生成档位已不可用，请重新估价");
  }
  requireTierMatchesInput(tier, request);
  try {
    return estimateGenerationCost(tier.rule, request);
  } catch (error) {
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      error instanceof Error ? error.message : "生成参数无法计费",
      400,
    );
  }
}

async function requireCurrentTier(
  db: Database,
  input: {
    tierId: string;
    mediaKind: "image" | "video" | "audio";
    parameters: GenerationParameters;
    quantity: number;
  },
): Promise<ResolvedGenerationTier> {
  const tierId = requireTierId(input.tierId);
  const tier = (await findActivePricingRules(db, input.mediaKind, new Date()))
    .map((rule) => resolveTierFromPricingRule(rule))
    .find((candidate): candidate is ResolvedGenerationTier => candidate?.tierId === tierId);
  if (!tier) throw tierError("当前生成档位不可用，请重新选择");
  // 客户端参数是对档位的"断言",与档位真源走同一套 V0.1 归一化后再比对:
  // 省略字段按合同默认补齐(选档不调参,空参数=接受档位参数),显式冲突参数被合同拒绝。
  let claimedParameters;
  try {
    claimedParameters = normalizeV01Parameters({
      mediaKind: input.mediaKind,
      model: tier.rule.model,
      // Audio tiers own price-bearing duration/output format; sound choice and
      // performance controls remain request-scoped creative input. Merge the
      // tier defaults before normalization so an omitted client field accepts
      // the tier, while a conflicting price-bearing field still fails below.
      parameters: input.mediaKind === "audio"
        ? { ...tier.parameters, ...input.parameters }
        : input.parameters,
      quantity: input.quantity,
    });
  } catch (error) {
    if (error instanceof V01GenerationContractError) {
      throw tierError("生成参数必须与所选档位完全一致，请重新选择档位");
    }
    throw error;
  }
  requireTierMatchesInput(tier, {
    tierId,
    mediaKind: input.mediaKind,
    model: tier.rule.model,
    parameters: claimedParameters,
    quantity: input.quantity,
  });
  // 预览档(快乐马)同音频:分辨率/画幅/时长是客户端可调项,返回归一化后的断言参数
  // 让覆盖值(含 preview 身份键)直达报价与供应商;正片档仍冻结为档位参数。
  return input.mediaKind === "audio" || (input.mediaKind === "video" && tier.parameters.preview === true)
    ? { ...tier, parameters: claimedParameters }
    : tier;
}

async function requireCurrentTierForModel(
  db: Database,
  model: string,
  mediaKind: "image" | "video" | "audio",
  tierId: string,
): Promise<ResolvedGenerationTier> {
  const tier = resolveTierFromPricingRules(
    await findActivePricingRules(db, mediaKind, new Date()),
    { model, tierId },
  );
  if (!tier) throw quoteStale("当前生成档位已不可用，请重新估价");
  return tier;
}

async function findActivePricingRules(
  db: Database,
  mediaKind: "image" | "video" | "audio",
  now: Date,
): Promise<GenerationPricingRule[]> {
  const rows = await db.select().from(pricingRules).where(and(
    eq(pricingRules.mediaKind, mediaKind),
    eq(pricingRules.active, true),
    lte(pricingRules.effectiveFrom, now),
    or(isNull(pricingRules.effectiveTo), gt(pricingRules.effectiveTo, now)),
  )).orderBy(desc(pricingRules.effectiveFrom));
  return rows.flatMap((row) => toPricingRule(row, mediaKind));
}

async function findActivePricingRule(
  db: Database,
  model: string,
  mediaKind: "image" | "video" | "audio",
  now: Date,
): Promise<GenerationPricingRule | null> {
  const rows = await db.select().from(pricingRules).where(and(
    eq(pricingRules.model, model),
    eq(pricingRules.mediaKind, mediaKind),
    eq(pricingRules.active, true),
    lte(pricingRules.effectiveFrom, now),
    or(isNull(pricingRules.effectiveTo), gt(pricingRules.effectiveTo, now)),
  )).orderBy(desc(pricingRules.effectiveFrom));
  return resolveTierFromPricingRules(
    rows.flatMap((row) => toPricingRule(row, mediaKind)),
    { model },
  )?.rule ?? null;
}

function toPricingRule(
  row: typeof pricingRules.$inferSelect,
  mediaKind: "image" | "video" | "audio",
): GenerationPricingRule[] {
  if (!(["request", "image", "second", "ten_thousand_characters"] as const)
    .includes(row.billingUnit as "request" | "image" | "second" | "ten_thousand_characters")) {
    return [];
  }
  return [{
    id: row.id,
    provider: row.provider,
    model: row.model,
    mediaKind,
    billingUnit: row.billingUnit as "request" | "image" | "second" | "ten_thousand_characters",
    unitPriceFen: row.unitPriceFen,
    metadata: row.metadata,
    ...(row.metadata.supports_input_video === true && row.source.trim().length > 0
      ? { supportsInputVideo: true }
      : {}),
  }];
}

function normalizedRequestSnapshot(input: NormalizedGenerationInput): Record<string, unknown> {
  const { clientIdempotencyKey: _clientIdempotencyKey, ...request } = input;
  return asJsonRecord(request);
}

function quoteViewFromRow(row: QuoteRow): GenerationQuoteView {
  if (row.source !== "web" && row.source !== "assistant" && row.source !== "cli") {
    throw new Error("Generation quote source is invalid");
  }
  if (row.action !== "submit" && row.action !== "retry") {
    throw new Error("Generation quote action is invalid");
  }
  if (row.status !== "pending_confirmation" && row.status !== "confirmed" && row.status !== "consumed" && row.status !== "voided") {
    throw new Error("Generation quote status is invalid");
  }
  return {
    id: row.id,
    userId: row.userId,
    source: row.source,
    action: row.action,
    ...(row.assistantSessionId ? { assistantSessionId: row.assistantSessionId } : {}),
    ...(row.originalRequestId ? { originalRequestId: row.originalRequestId } : {}),
    ...(row.baseAttemptId ? { baseAttemptId: row.baseAttemptId } : {}),
    ...(row.baseAttemptNo ? { baseAttemptNo: row.baseAttemptNo } : {}),
    requestHash: row.requestHash,
    normalizedRequest: row.normalizedRequest,
    pricingRuleId: row.pricingRuleId,
    priceSnapshot: costSnapshot(row.priceSnapshot),
    estimatedCostFen: row.estimatedCostFen,
    status: row.status,
    expiresAt: row.expiresAt,
    ...(row.confirmedAt ? { confirmedAt: row.confirmedAt } : {}),
    ...(row.confirmedByUserId ? { confirmedByUserId: row.confirmedByUserId } : {}),
    ...(row.consumedAt ? { consumedAt: row.consumedAt } : {}),
    ...(row.generationRequestId ? { generationRequestId: row.generationRequestId } : {}),
    ...(row.generationAttemptId ? { generationAttemptId: row.generationAttemptId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function costSnapshot(value: Record<string, unknown>): CostEstimate {
  const billingUnit = value.billingUnit;
  const mediaKind = value.mediaKind;
  if ((billingUnit !== "request"
    && billingUnit !== "image"
    && billingUnit !== "second"
    && billingUnit !== "ten_thousand_characters")
    || (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio")
    || value.currency !== "CNY"
    || typeof value.tierId !== "string"
    || value.tierId.trim().length === 0
    || typeof value.pricingRuleId !== "string"
    || typeof value.provider !== "string"
    || typeof value.model !== "string"
    || !Number.isSafeInteger(value.unitPriceFen)
    || !Number.isSafeInteger(value.billableUnits)
    || !Number.isSafeInteger(value.estimatedCostFen)) {
    throw new Error("Generation quote price snapshot is invalid");
  }
  const productionMode = productionModeFromSnapshot(value);
  const fullEstimatedCostFen = typeof value.fullEstimatedCostFen === "number"
    && Number.isSafeInteger(value.fullEstimatedCostFen)
    ? value.fullEstimatedCostFen
    : value.estimatedCostFen as number;
  const discountNumerator = typeof value.discountNumerator === "number" && Number.isSafeInteger(value.discountNumerator)
    ? value.discountNumerator
    : 1;
  const discountDenominator = typeof value.discountDenominator === "number" && Number.isSafeInteger(value.discountDenominator)
    ? value.discountDenominator
    : 1;
  let priceMultiplierBps: 6_000 | 10_000;
  if (value.priceMultiplierBps === undefined || value.priceMultiplierBps === null) {
    priceMultiplierBps = productionMode === "sample" ? 6_000 : 10_000;
  } else if (value.priceMultiplierBps === 6_000 || value.priceMultiplierBps === 10_000) {
    priceMultiplierBps = value.priceMultiplierBps;
  } else {
    throw new Error("Generation quote price multiplier snapshot is invalid");
  }
  if (fullEstimatedCostFen < 0 || discountNumerator <= 0 || discountDenominator <= 0
    || (productionMode === "full" && priceMultiplierBps !== 10_000)
    || (productionMode === "sample" && priceMultiplierBps !== 6_000)
    || (productionMode === "full" && (fullEstimatedCostFen !== value.estimatedCostFen || discountNumerator !== 1 || discountDenominator !== 1))
    || (productionMode === "sample" && (discountNumerator !== 3 || discountDenominator !== 5
      || value.estimatedCostFen !== Math.ceil(fullEstimatedCostFen * 3 / 5)))) {
    throw new Error("Generation quote production-mode price snapshot is invalid");
  }
  return {
    tierId: value.tierId,
    pricingRuleId: value.pricingRuleId,
    provider: value.provider,
    model: value.model,
    mediaKind,
    billingUnit,
    unitPriceFen: value.unitPriceFen as number,
    billableUnits: value.billableUnits as number,
    estimatedCostFen: value.estimatedCostFen as number,
    fullEstimatedCostFen,
    productionMode,
    priceMultiplierBps,
    discountNumerator,
    discountDenominator,
    currency: "CNY",
    ...(isRecord(value.pricingBasis)
      ? { pricingBasis: pricingBasisSnapshot(value.pricingBasis) }
      : {}),
  };
}

export const LEGACY_UNPRICED_TIER_ID = "legacy-unpriced";

export function isLegacyUnpricedSnapshot(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

/**
 * Attempts created before frozen quote snapshots existed legitimately carry
 * `{}`. Read-only history views keep those rows visible without inventing a
 * price or model binding. Any non-empty malformed snapshot still fails closed,
 * and all quote, retry, recovery and debit paths continue to use the strict
 * `costSnapshot` parser above.
 */
export function attemptViewTierId(value: Record<string, unknown>): string {
  if (isLegacyUnpricedSnapshot(value)) return LEGACY_UNPRICED_TIER_ID;
  return costSnapshot(value).tierId;
}

export function retryTierIdFromSnapshot(value: Record<string, unknown>): string {
  if (isLegacyUnpricedSnapshot(value)) {
    throw new GenerationError(
      "GENERATION_STATE_CONFLICT",
      "这条历史任务缺少冻结价格，不能直接重试；请重新发起生成",
      409,
      false,
    );
  }
  return costSnapshot(value).tierId;
}

function productionModeFromSnapshot(value: Record<string, unknown>): GenerationProductionMode {
  return readProductionMode(value.productionMode);
}

function readProductionMode(value: unknown): GenerationProductionMode {
  if (value === undefined || value === null) return "full";
  if (value === "full" || value === "sample") return value;
  throw new Error("Generation production mode is invalid");
}

function pricingBasisSnapshot(value: Record<string, unknown>): NonNullable<CostEstimate["pricingBasis"]> {
  const method = value.method;
  const fixedParameters = value.fixedParameters;
  if ((value.contractVersion !== "v0.1-ark-fixed"
      && value.contractVersion !== "v0.2-audio-original-duration"
      && value.contractVersion !== "v0.3-audio-characters"
      && value.contractVersion !== "v0.4-provider-tier")
    || (method !== "configured_per_image"
      && method !== "conservative_per_second"
      && method !== "configured_per_10k_characters")
    || !isRecord(fixedParameters)) {
    throw new Error("Generation quote pricing basis is invalid");
  }
  const normalizedFixedParameters: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(fixedParameters)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error("Generation quote fixed pricing parameters are invalid");
    }
    normalizedFixedParameters[key] = item;
  }
  if (value.noInputVideo !== undefined && value.noInputVideo !== true) {
    throw new Error("Generation quote no-input-video flag is invalid");
  }
  const inputVideoReferenceCount = value.inputVideoReferenceCount;
  if (inputVideoReferenceCount !== undefined
    && (typeof inputVideoReferenceCount !== "number"
      || !Number.isSafeInteger(inputVideoReferenceCount)
      || inputVideoReferenceCount <= 0)) {
    throw new Error("Generation quote input-video reference count is invalid");
  }
  if (value.noInputVideo === true && inputVideoReferenceCount !== undefined) {
    throw new Error("Generation quote video-reference pricing basis is contradictory");
  }
  if (value.estimatedTokens !== undefined && !Number.isSafeInteger(value.estimatedTokens)) {
    throw new Error("Generation quote estimated tokens are invalid");
  }
  if (value.providerYuanPerMillionTokens !== undefined
    && (typeof value.providerYuanPerMillionTokens !== "number"
      || !Number.isFinite(value.providerYuanPerMillionTokens))) {
    throw new Error("Generation quote provider unit price is invalid");
  }
  return {
    contractVersion: value.contractVersion,
    method,
    fixedParameters: normalizedFixedParameters,
    ...(value.noInputVideo === true ? { noInputVideo: true } : {}),
    ...(typeof inputVideoReferenceCount === "number"
      ? { inputVideoReferenceCount }
      : {}),
    ...(typeof value.estimatedTokens === "number" ? { estimatedTokens: value.estimatedTokens } : {}),
    ...(typeof value.providerYuanPerMillionTokens === "number"
      ? { providerYuanPerMillionTokens: value.providerYuanPerMillionTokens }
      : {}),
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function quoteNotFound(): GenerationError {
  return new GenerationError("GENERATION_QUOTE_NOT_FOUND", "生成费用报价单不存在", 404);
}

function quoteExpired(): GenerationError {
  return new GenerationError("GENERATION_QUOTE_EXPIRED", "报价单已超过10分钟，请重新估价", 409);
}

function quoteStale(message = "生成单价或费用已变化，请重新估价并确认"): GenerationError {
  return new GenerationError("quote_stale", message, 409);
}

function assertRetryAllowed(prior: AttemptRow): void {
  if (prior.status === "pending" || prior.status === "running") {
    throw new GenerationError(
      "GENERATION_STATE_CONFLICT",
      "当前生成任务仍在处理，不能重复付费提交",
      409,
    );
  }
  if (prior.status === "succeeded") {
    throw new GenerationError(
      "GENERATION_STATE_CONFLICT",
      "任务已经成功；如需新版本，请重新发起生成",
      409,
    );
  }
}

async function latestAttempt(db: Database, requestId: string): Promise<AttemptRow | undefined> {
  return (await db.select().from(generationAttempts)
    .where(eq(generationAttempts.requestId, requestId))
    .orderBy(desc(generationAttempts.attemptNo))
    .limit(1))[0];
}

async function reservedCostFen(db: Database): Promise<number> {
  const row = (await db.select({ total: sql<number>`coalesce(sum(${generationAttempts.estimatedCostFen}), 0)::integer` })
    .from(generationAttempts))[0];
  return Number(row?.total ?? 0);
}

async function assertTargetAccess(
  db: Database,
  actorId: string,
  input: NormalizedGenerationInput,
  authorizedProjectId?: string,
): Promise<void> {
  if (authorizedProjectId && authorizedProjectId !== input.projectId) throw generationNotFound();
  const project = (await db.select().from(projects).where(and(
    eq(projects.id, input.projectId),
    isNull(projects.deletedAt),
    ...(authorizedProjectId ? [] : [eq(projects.ownerUserId, actorId)]),
  )).limit(1))[0];
  if (!project) throw generationNotFound();

  if (input.episodeId) {
    const episode = (await db.select().from(episodes).where(and(
      eq(episodes.id, input.episodeId),
      eq(episodes.projectId, input.projectId),
      isNull(episodes.deletedAt),
    )).limit(1))[0];
    if (!episode) throw new GenerationError("INVALID_GENERATION_REQUEST", "集不属于当前项目", 400);
  }
  if (input.sceneId) {
    const scene = (await db.select({ scene: scenes, episode: episodes }).from(scenes)
      .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
      .where(and(
        eq(scenes.id, input.sceneId),
        eq(episodes.projectId, input.projectId),
        isNull(scenes.deletedAt),
        isNull(episodes.deletedAt),
      )).limit(1))[0];
    if (!scene || (input.episodeId && scene.episode.id !== input.episodeId)) {
      throw new GenerationError("INVALID_GENERATION_REQUEST", "场不属于当前项目或集", 400);
    }
  }
  if (input.shotId) {
    const shot = (await db.select({ shot: shots, episode: episodes }).from(shots)
      .innerJoin(episodes, eq(shots.episodeId, episodes.id))
      .where(and(
        eq(shots.id, input.shotId),
        eq(episodes.projectId, input.projectId),
        isNull(shots.deletedAt),
        isNull(episodes.deletedAt),
      )).limit(1))[0];
    if (!shot
      || (input.episodeId && shot.episode.id !== input.episodeId)
      || (input.sceneId && shot.shot.sceneId !== input.sceneId)) {
      throw new GenerationError("INVALID_GENERATION_REQUEST", "分镜不属于当前项目、集或场", 400);
    }
  }
  if (input.targetAssetEntityId) {
    const asset = (await db.select().from(assetEntities).where(and(
      eq(assetEntities.id, input.targetAssetEntityId),
      isNull(assetEntities.deletedAt),
    )).limit(1))[0];
    if (!asset || !await canUseAssetForGeneration(db, actorId, asset, authorizedProjectId)) {
      throw new GenerationError("INVALID_GENERATION_REQUEST", "目标资产不存在或不可用", 400);
    }
  }
}

/**
 * A project membership is not global access to another user's personal
 * library. It only adds an access path through an active project asset
 * reference, and a locked reference only authorizes its exact media/variant.
 */
async function canUseAssetForGeneration(
  db: Database,
  actorId: string,
  asset: typeof assetEntities.$inferSelect,
  authorizedProjectId?: string,
  media?: Pick<typeof assetMedia.$inferSelect, "id" | "assetVariantId">,
): Promise<boolean> {
  if (isDirectAssetUsableForGeneration(asset, actorId)) return true;
  if (asset.visibility === "common") return false;
  if (asset.visibility !== "personal" || !authorizedProjectId) return false;
  return hasExactProjectAssetReference(db, authorizedProjectId, asset.id, media);
}

/**
 * A review-gate rejection may name an unapproved common asset only when the
 * caller could already inspect that exact asset through this project (or is a
 * platform admin). A guessed UUID must not turn the 422 display contract into
 * an unpublished-catalogue oracle.
 */
async function canInspectAssetProductionGate(
  db: Database,
  actorId: string,
  asset: typeof assetEntities.$inferSelect,
  authorizedProjectId?: string,
  media?: Pick<typeof assetMedia.$inferSelect, "id" | "assetVariantId">,
): Promise<boolean> {
  if (asset.visibility === "personal") {
    return canUseAssetForGeneration(db, actorId, asset, authorizedProjectId, media);
  }
  if (asset.visibility !== "common") return false;
  if (asset.status === "approved") return true;
  if (
    authorizedProjectId
    && await hasExactProjectAssetReference(db, authorizedProjectId, asset.id, media)
  ) {
    return true;
  }
  const actor = (await db.select({ role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1))[0];
  return actor?.active === true && actor.role === "admin";
}

async function hasExactProjectAssetReference(
  db: Database,
  projectId: string,
  assetId: string,
  media?: Pick<typeof assetMedia.$inferSelect, "id" | "assetVariantId">,
): Promise<boolean> {
  const references = await db.select({
    assetVariantId: projectAssetRefs.assetVariantId,
    assetMediaId: projectAssetRefs.assetMediaId,
  }).from(projectAssetRefs).where(and(
    eq(projectAssetRefs.projectId, projectId),
    eq(projectAssetRefs.assetEntityId, assetId),
    isNull(projectAssetRefs.deletedAt),
  )).for("share");
  return references.some((reference) => isProjectAssetReferenceCompatible(reference, media));
}

export function isDirectAssetUsableForGeneration(
  asset: Pick<typeof assetEntities.$inferSelect, "visibility" | "status" | "ownerUserId">,
  actorId: string,
): boolean {
  if (asset.visibility === "common") return asset.status === "approved";
  return asset.visibility === "personal" && asset.ownerUserId === actorId;
}

/** Exported pure check keeps the read and generation boundaries testable. */
export function isProjectAssetReferenceCompatible(
  reference: Pick<typeof projectAssetRefs.$inferSelect, "assetVariantId" | "assetMediaId"> | undefined,
  media?: Pick<typeof assetMedia.$inferSelect, "id" | "assetVariantId">,
): boolean {
  if (!reference) return false;
  if (!media) return true;
  if (reference.assetMediaId) return reference.assetMediaId === media.id;
  if (reference.assetVariantId) return reference.assetVariantId === media.assetVariantId;
  return true;
}

function frozenQuoteReferenceMediaIds(quote: QuoteRow): string[] {
  const value = quote.normalizedRequest.referenceMediaIds;
  if (!Array.isArray(value)) return [];
  return value.filter((mediaId): mediaId is string => typeof mediaId === "string");
}

interface LockedControlAssetReferenceRows {
  mediaById: Map<string, typeof assetMedia.$inferSelect>;
  variantsById: Map<string, {
    id: string;
    assetEntityId: string;
    deletedAt: Date | null;
  }>;
  entitiesById: Map<string, typeof assetEntities.$inferSelect>;
}

/**
 * Lock a union of references in one deterministic order. Callers may validate
 * one request or pre-lock an entire batch; both paths therefore share the
 * exact media -> variant -> entity acquisition order.
 */
async function lockCurrentControlAssetReferenceRows(
  db: Database,
  mediaIds: string[],
): Promise<LockedControlAssetReferenceRows> {
  const mediaRows: Array<typeof assetMedia.$inferSelect> = [];
  for (const mediaId of [...new Set(mediaIds)].sort()) {
    const media = (await db.select().from(assetMedia)
      .where(eq(assetMedia.id, mediaId))
      .limit(1)
      .for("share"))[0];
    if (media) mediaRows.push(media);
  }
  const mediaById = new Map(mediaRows.map((media) => [media.id, media]));
  const variantIds = [...new Set(mediaRows
    .map((media) => media.assetVariantId)
    .filter((id): id is string => Boolean(id)))].sort();
  const variants: Array<{
    id: string;
    assetEntityId: string;
    deletedAt: Date | null;
  }> = [];
  for (const variantId of variantIds) {
    const variant = (await db.select({
      id: assetVariants.id,
      assetEntityId: assetVariants.assetEntityId,
      deletedAt: assetVariants.deletedAt,
    }).from(assetVariants)
      .where(eq(assetVariants.id, variantId))
      .limit(1)
      .for("share"))[0];
    if (variant) variants.push(variant);
  }
  const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
  const entityIds = [...new Set(mediaRows.flatMap((media) => {
    const variant = media.assetVariantId ? variantsById.get(media.assetVariantId) : undefined;
    const entityId = media.assetEntityId ?? variant?.assetEntityId;
    return entityId ? [entityId] : [];
  }))].sort();
  const entities: Array<typeof assetEntities.$inferSelect> = [];
  for (const entityId of entityIds) {
    const entity = (await db.select().from(assetEntities)
      .where(eq(assetEntities.id, entityId))
      .limit(1)
      .for("share"))[0];
    if (entity) entities.push(entity);
  }
  return {
    mediaById,
    variantsById,
    entitiesById: new Map(entities.map((entity) => [entity.id, entity])),
  };
}

/**
 * Resolve and lock every current asset fact behind a frozen generation
 * reference. HTTP resolution is an early UX guard; this repository guard is
 * the paid-chain authority and therefore runs again while quoting, creating
 * an attempt, retrying, batch-submitting, and entering worker submission.
 */
async function assertCurrentControlAssetReferences(
  db: Database,
  actorId: string,
  request: Pick<NormalizedGenerationInput, "projectId" | "shotId" | "referenceMediaIds" | "referenceAssetSnapshots">,
  authorizedProjectId?: string,
): Promise<void> {
  const mediaIds = request.referenceMediaIds;
  const snapshots = request.referenceAssetSnapshots;
  if (mediaIds.length === 0 && snapshots.length === 0) return;
  const assetSnapshots = snapshots;
  if (
    (mediaIds.length === 0 && assetSnapshots.length > 0)
    || assetSnapshots.length !== mediaIds.length
    || new Set(mediaIds).size !== mediaIds.length
  ) {
    throw invalidCurrentControlAssetReference("参考素材记录不完整，无法安全进入生成流程，请重新选择素材");
  }

  const { mediaById, variantsById, entitiesById } =
    await lockCurrentControlAssetReferenceRows(db, mediaIds);

  for (const [index, mediaId] of mediaIds.entries()) {
    const snapshot = assetSnapshots[index];
    const media = mediaById.get(mediaId);
    const variant = media?.assetVariantId ? variantsById.get(media.assetVariantId) : undefined;
    const entityId = media?.assetEntityId ?? variant?.assetEntityId;
    const entity = entityId ? entitiesById.get(entityId) : undefined;
    if (
      !snapshot
      || !media
      || media.deletedAt
      || (media.assetVariantId && (!variant || variant.deletedAt))
      || !entity
      || entity.deletedAt
      || !media.storageUrl
    ) {
      throw invalidCurrentControlAssetReference("参考素材已删除或不可访问，无法进入生成流程，请重新选择素材");
    }

    if (!await canInspectAssetProductionGate(
      db,
      actorId,
      entity,
      authorizedProjectId,
      media,
    )) {
      throw invalidCurrentControlAssetReference(
        "参考素材已删除或不可访问，无法进入生成流程，请重新选择素材",
      );
    }
    const reviewRejection = commonAssetReviewRejection(entity, "付费生成", media.id);
    if (reviewRejection) {
      throw invalidCurrentControlAssetReference(reviewRejection.message, reviewRejection.details);
    }
    if (!await canUseAssetForGeneration(db, actorId, entity, authorizedProjectId, media)) {
      throw invalidCurrentControlAssetReference(
        "参考素材已删除或不可访问，无法进入生成流程，请重新选择素材",
      );
    }
    if (snapshot.mediaId && snapshot.mediaId !== mediaId) {
      throw invalidCurrentControlAssetReference("参考素材编号与冻结记录不一致，请重新选择素材");
    }
    if (!snapshot.url.startsWith("asset://") && snapshot.url !== media.storageUrl) {
      throw invalidCurrentControlAssetReference("参考素材地址已变化，请重新选择素材");
    }
    if (isThreeDimensionalMedia(media)) {
      throw invalidCurrentControlAssetReference("3D 素模仅供导演台使用，不能作为生成参考");
    }
    let currentKind: "image" | "video" | "audio";
    try {
      currentKind = normalizeReferenceKind(media);
    } catch {
      throw invalidCurrentControlAssetReference("参考素材类型无法复核，请重新选择素材");
    }
    if (currentKind !== snapshot.kind) {
      throw invalidCurrentControlAssetReference("参考素材类型已变化，请重新选择素材");
    }
  }
}

function requestInput(request: RequestRow, model: string, tierId: string): NormalizedGenerationInput {
  const { parameters, audioDimensions, productionMode } = readStoredRequestParameters(request.parameters);
  const input: Omit<NormalizedGenerationInput, "tierId"> = {
    projectId: request.projectId,
    ...(request.episodeId ? { episodeId: request.episodeId } : {}),
    ...(request.sceneId ? { sceneId: request.sceneId } : {}),
    ...(request.shotId ? { shotId: request.shotId } : {}),
    ...(request.targetAssetEntityId ? { targetAssetEntityId: request.targetAssetEntityId } : {}),
    mediaKind: asGenerationMediaKind(request.mediaKind),
    model,
    prompt: request.prompt,
    ...(audioDimensions ? {
      promptCompilation: {
        version: "sound-workshop-v1",
        autoPrompt: request.prompt,
        supplementPrompt: "",
        audioDimensions,
      },
    } : {}),
    parameters,
    referenceMediaIds: request.referenceMediaIds,
    referenceAssetSnapshots: readReferenceSnapshots(request.referenceAssetSnapshots),
    quantity: request.quantity,
    productionMode,
    clientIdempotencyKey: request.clientIdempotencyKey,
  };
  return { ...input, tierId };
}

/**
 * Persist only the dimensions needed by a restarted worker. The generic
 * compiler display snapshot stays with the quote; it is not needed to make a
 * paid retry reproducible. Invalid historical snapshots are omitted rather
 * than trusted on a paid retry.
 */
function persistedRequestParameters(input: NormalizedGenerationInput): GenerationParameters {
  const productionMode = { [PRODUCTION_MODE_SNAPSHOT_KEY]: input.productionMode };
  if (input.mediaKind !== "audio" || !input.promptCompilation?.audioDimensions) {
    return { ...input.parameters, ...productionMode };
  }
  return {
    ...input.parameters,
    ...productionMode,
    [AUDIO_PROMPT_DIMENSIONS_SNAPSHOT_KEY]: asJsonRecord(input.promptCompilation.audioDimensions),
  };
}

function readStoredRequestParameters(value: Record<string, unknown>): {
  parameters: GenerationParameters;
  audioDimensions?: Required<AudioPromptDimensions>;
  productionMode: GenerationProductionMode;
} {
  const parameters: GenerationParameters = { ...value };
  const audioDimensions = readStoredAudioDimensions(parameters[AUDIO_PROMPT_DIMENSIONS_SNAPSHOT_KEY]);
  delete parameters[AUDIO_PROMPT_DIMENSIONS_SNAPSHOT_KEY];
  const productionMode = readProductionMode(parameters[PRODUCTION_MODE_SNAPSHOT_KEY]);
  delete parameters[PRODUCTION_MODE_SNAPSHOT_KEY];
  return {
    parameters,
    productionMode,
    ...(audioDimensions ? { audioDimensions } : {}),
  };
}

function readStoredAudioDimensions(value: unknown): Required<AudioPromptDimensions> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    voiceReference: typeof record.voiceReference === "string" ? record.voiceReference : "",
    performanceEmotion: typeof record.performanceEmotion === "string" ? record.performanceEmotion : "",
    paceAndPauses: typeof record.paceAndPauses === "string" ? record.paceAndPauses : "",
    languageAndAccent: typeof record.languageAndAccent === "string" ? record.languageAndAccent : "",
    vocalDistance: typeof record.vocalDistance === "string" ? record.vocalDistance : "",
    continuity: typeof record.continuity === "string" ? record.continuity : "",
  };
}

/**
 * A persistence-recovery counter belongs to the durable provider snapshot,
 * not to a paid-task retry. Keeping it in existing JSON avoids an unrelated
 * schema migration while the row lock above still makes increments atomic.
 */
function readPersistenceRetryCount(value: Record<string, unknown> | null): number {
  const metadata = value && isRecord(value.metadata) ? value.metadata : undefined;
  const count = metadata?.persistenceRetryCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function withPersistenceRetryCount(
  value: Record<string, unknown> | null,
  persistenceRetryCount: number,
): Record<string, unknown> {
  const currentMetadata = value && isRecord(value.metadata) ? value.metadata : {};
  return {
    ...(value ?? {}),
    metadata: { ...currentMetadata, persistenceRetryCount },
  };
}

/**
 * Retries keep the historical URL/role snapshot, but must not silently reuse a
 * control asset that has since become unavailable or has been reclassified as
 * a 3D director-only model. Legacy snapshots do not contain media ids, so an
 * exact one-to-one, order-preserving list is required before retrying.
 */
async function assertFrozenRetryReferences(
  db: Database,
  actorId: string,
  request: RequestRow,
  authorizedProjectId?: string,
): Promise<void> {
  const mediaIds = request.referenceMediaIds;
  const snapshots = readReferenceSnapshots(request.referenceAssetSnapshots);
  if (mediaIds.length === 0 && request.referenceAssetSnapshots.length === 0) return;
  const assetSnapshots = snapshots;
  if (
    (mediaIds.length === 0 && assetSnapshots.length > 0)
    || snapshots.length !== request.referenceAssetSnapshots.length
    || assetSnapshots.length !== mediaIds.length
    || new Set(mediaIds).size !== mediaIds.length
  ) {
    throw invalidFrozenRetryReference("历史参考素材记录不完整，无法安全重试，请重新提交生成任务");
  }

  const rows = await db.select({ media: assetMedia, variantEntityId: assetVariants.assetEntityId })
    .from(assetMedia)
    .leftJoin(assetVariants, eq(assetMedia.assetVariantId, assetVariants.id))
    .where(inArray(assetMedia.id, mediaIds));
  const byId = new Map(rows.map((row) => [row.media.id, row]));
  const entityIds = [...new Set(rows.flatMap((row) => {
    const entityId = row.media.assetEntityId ?? row.variantEntityId;
    return entityId ? [entityId] : [];
  }))];
  const entities = entityIds.length === 0
    ? []
    : await db.select().from(assetEntities).where(inArray(assetEntities.id, entityIds));
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));

  for (const [index, mediaId] of mediaIds.entries()) {
    const row = byId.get(mediaId);
    const entityId = row?.media.assetEntityId ?? row?.variantEntityId;
    const entity = entityId ? entitiesById.get(entityId) : undefined;
    if (!row || !entityId || !entity || row.media.deletedAt || entity.deletedAt || !row.media.storageUrl) {
      throw invalidFrozenRetryReference("历史参考素材已不存在或不可访问，无法安全重试，请重新提交生成任务");
    }
    if (!await canUseAssetForGeneration(db, actorId, entity, authorizedProjectId, row.media)) {
      throw invalidFrozenRetryReference("历史参考素材已无使用权限，无法安全重试，请重新提交生成任务");
    }
    if (isThreeDimensionalMedia(row.media)) {
      throw invalidFrozenRetryReference("历史参考素材已识别为 3D 素模，仅供导演台使用，请重新提交生成任务");
    }
    let currentKind: "image" | "video" | "audio";
    try {
      currentKind = normalizeReferenceKind(row.media);
    } catch {
      throw invalidFrozenRetryReference("历史参考素材类型无法复核，无法安全重试，请重新提交生成任务");
    }
    if (currentKind !== assetSnapshots[index]?.kind) {
      throw invalidFrozenRetryReference("历史参考素材类型已变化，无法安全重试，请重新提交生成任务");
    }
  }
}

/**
 * A quote freezes display/control data, not an unbounded right to reuse a
 * provider asset. Re-check the CreateAsset admission in the same transaction
 * that quotes or creates a paid attempt, and once more at the worker's
 * `submitting` transition.
 *
 * - CreateAsset: active registration + exact remote id.
 * - every other/unknown source: fail closed, never fall back to TOS.
 */
async function assertCurrentSeedanceReferences(
  db: Database,
  request: Pick<NormalizedGenerationInput, "mediaKind" | "model" | "referenceAssetSnapshots">,
): Promise<void> {
  if (request.mediaKind !== "video" || !isArkSeedance2Model(request.model)) return;
  const snapshots = request.referenceAssetSnapshots;
  if (snapshots.length === 0) return;
  const mediaIds = snapshots
    .map((snapshot) => snapshot.mediaId)
    .filter((value): value is string => Boolean(value));
  if (mediaIds.length !== snapshots.length) {
    throw invalidSeedanceReference("Seedance 参考资产缺少可复核的本地媒体编号，请重新选择素材");
  }
  for (const snapshot of snapshots) {
    const mediaId = snapshot.mediaId!;
    const media = (await db.select({
      id: assetMedia.id,
      storageUrl: assetMedia.storageUrl,
      deletedAt: assetMedia.deletedAt,
    }).from(assetMedia).where(eq(assetMedia.id, mediaId)).limit(1))[0];
    if (!media || media.deletedAt || !media.storageUrl) {
      throw invalidSeedanceReference("Seedance 参考资产已删除或没有可复核的 TOS 地址");
    }
    const admission = await loadSeedanceAdmission(db, mediaId);
    if (snapshot.url.startsWith("asset://")) {
      if (!admission.remoteAssetId || snapshot.url !== `asset://${admission.remoteAssetId}`) {
        throw invalidSeedanceReference(
          admission.remoteAssetId
            ? seedanceAdmissionMessages.provider_asset_id_mismatch
            : seedanceAdmissionMessages[admission.status],
        );
      }
      continue;
    }
    if (snapshot.url !== media.storageUrl) {
      throw invalidSeedanceReference("Seedance 参考资产地址已变化，请重新选择素材");
    }
    const isAnchor = snapshot.role === "first_frame" || snapshot.role === "last_frame";
    if (admission.remoteAssetId && isAnchor) continue;
    if (admission.remoteAssetId) {
      throw invalidSeedanceReference("Seedance 已登记普通参考必须使用当前 asset://，请重新估价并提交");
    }
    throw invalidSeedanceReference(seedanceAdmissionMessages[admission.status]);
  }
}

function invalidFrozenRetryReference(message: string): GenerationError {
  return new GenerationError("control_asset_invalid_usage", message, 422);
}

function invalidCurrentControlAssetReference(message: string, details: unknown | null = null): GenerationError {
  return new GenerationError("control_asset_invalid_usage", message, 422, false, details);
}

function invalidSeedanceReference(message: string): GenerationError {
  return new GenerationError("control_asset_invalid_usage", message, 422);
}

function storedMediaFromRow(row: MediaRow): StoredGenerationMedia[] {
  if (!row.providerResultKey || !row.storageBucket || !row.storagePath || !row.storageUrl || !row.sha256 || !row.mimeType) return [];
  const complianceMetadata = asAigcComplianceMetadata(row.complianceMetadata);
  return [{
    id: row.id,
    providerResultKey: row.providerResultKey,
    mediaKind: row.mediaKind === "video" || row.mediaKind === "audio" ? row.mediaKind : "image",
    storageBucket: row.storageBucket,
    storagePath: row.storagePath,
    storageUrl: row.storageUrl,
    sha256: row.sha256,
    mimeType: row.mimeType,
    ...(row.durationSeconds !== null ? { durationSeconds: row.durationSeconds } : {}),
    ...(complianceMetadata ? { complianceMetadata } : {}),
    createdAt: row.createdAt,
  }];
}

function providerSnapshot(value: Record<string, unknown> | null): ProviderResultSnapshot | undefined {
  if (!value || !Array.isArray(value.media)) return undefined;
  const status = value.status;
  if (status !== "pending" && status !== "running" && status !== "succeeded" && status !== "failed") return undefined;
  const media = value.media.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const temporaryUrl = typeof record.temporaryUrl === "string" ? record.temporaryUrl : undefined;
    const inline = isRecord(record.inlineContent) ? record.inlineContent : undefined;
    const inlineContent = inline
      && typeof inline.contentBase64 === "string" && inline.contentBase64.length > 0
      && typeof inline.contentType === "string" && inline.contentType.length > 0
      ? { contentBase64: inline.contentBase64, contentType: inline.contentType }
      : undefined;
    if ((record.kind !== "image" && record.kind !== "video" && record.kind !== "audio" && record.kind !== "last_frame")
      || (temporaryUrl === undefined && !inlineContent)
      || typeof record.providerResultKey !== "string") return [];
    const kind = record.kind as "image" | "video" | "audio" | "last_frame";
    const durationPolicy = isRecord(record.audioDurationPolicy)
      && record.audioDurationPolicy.source === "provider_reported"
      && typeof record.audioDurationPolicy.maxDurationMs === "number"
      && Number.isSafeInteger(record.audioDurationPolicy.maxDurationMs)
      && record.audioDurationPolicy.maxDurationMs > 0
      ? {
          source: "provider_reported" as const,
          maxDurationMs: record.audioDurationPolicy.maxDurationMs,
        }
      : undefined;
    return [{
      kind,
      ...(temporaryUrl !== undefined ? { temporaryUrl } : {}),
      ...(inlineContent ? { inlineContent } : {}),
      providerResultKey: record.providerResultKey,
      ...(typeof record.durationSeconds === "number" && Number.isFinite(record.durationSeconds)
        ? { durationSeconds: record.durationSeconds }
        : {}),
      ...(typeof record.actualDurationMs === "number" && Number.isSafeInteger(record.actualDurationMs)
        ? { actualDurationMs: record.actualDurationMs }
        : {}),
      ...(typeof record.durationDeltaMs === "number" && Number.isSafeInteger(record.durationDeltaMs)
        ? { durationDeltaMs: record.durationDeltaMs }
        : {}),
      ...(durationPolicy ? { audioDurationPolicy: durationPolicy } : {}),
      ...(isRecord(record.subtitle) || Array.isArray(record.subtitle)
        ? { subtitle: record.subtitle }
        : {}),
      ...(asAigcComplianceMetadata(record.complianceMetadata)
        ? { complianceMetadata: asAigcComplianceMetadata(record.complianceMetadata)! }
        : {}),
    }];
  });
  return {
    status,
    ...(typeof value.providerTaskId === "string" ? { providerTaskId: value.providerTaskId } : {}),
    ...(typeof value.rawStatus === "string" ? { rawStatus: value.rawStatus } : {}),
    ...(typeof value.unknownStatus === "boolean" ? { unknownStatus: value.unknownStatus } : {}),
    media: media as unknown as ProviderResultSnapshot["media"],
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
    ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
    ...(value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? { metadata: value.metadata as Record<string, unknown> }
      : {}),
  };
}

function asAigcComplianceMetadata(value: unknown): AigcComplianceMetadata | undefined {
  if (!isRecord(value) || value.aigcMetadataEnabled !== true) return undefined;
  if (value.aigcMetadataEvidence !== "platform_applied"
    && value.aigcMetadataEvidence !== "provider_response") return undefined;
  return value as AigcComplianceMetadata;
}

/**
 * Inline TTS bytes are required only while a recoverable persistence attempt
 * is in flight. Terminal rows retain their audit facts but never a second
 * permanent copy of the audio payload in JSONB.
 */
function redactInlineProviderResult(result: ProviderResultSnapshot): ProviderResultSnapshot {
  const response = redactInlineProviderResponse(asJsonRecord(result));
  return response ? {
    ...result,
    // This helper only removes inline bytes; it preserves the provider media
    // object shape, including the stricter AIGC metadata fields.
    media: response.media as unknown as ProviderResultSnapshot["media"],
    ...(isRecord(response.metadata) ? { metadata: response.metadata } : {}),
  } : result;
}

function redactInlineProviderResponse(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value || !Array.isArray(value.media)) return value;
  const inlineMediaAudit: Array<Record<string, unknown>> = [];
  const media = value.media.map((item) => {
    if (!isRecord(item) || !isRecord(item.inlineContent)) return item;
    const inlineContent = item.inlineContent;
    const contentBase64 = typeof inlineContent.contentBase64 === "string" ? inlineContent.contentBase64 : "";
    const contentType = typeof inlineContent.contentType === "string" ? inlineContent.contentType : undefined;
    const bytes = Buffer.from(contentBase64, "base64");
    inlineMediaAudit.push({
      ...(typeof item.providerResultKey === "string" ? { providerResultKey: item.providerResultKey } : {}),
      ...(contentType ? { contentType } : {}),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const { inlineContent: _inlineContent, ...redacted } = item;
    return redacted;
  });
  if (inlineMediaAudit.length === 0) return value;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  return {
    ...value,
    media,
    metadata: {
      ...metadata,
      inlineMediaAudit,
    },
  };
}

function normalizeReferenceKind(media: typeof assetMedia.$inferSelect): "image" | "video" | "audio" {
  const mediaKind = media.mediaKind.toLowerCase();
  const format = media.format?.toLowerCase() ?? "";
  const storageUrl = media.storageUrl?.toLowerCase() ?? "";
  const storagePath = media.storagePath?.toLowerCase() ?? "";
  if (mediaKind.includes("video") || matchesExtension(format, storageUrl, storagePath, ["mp4", "mov", "webm", "mkv"])) {
    return "video";
  }
  if (mediaKind.includes("audio") || matchesExtension(format, storageUrl, storagePath, ["mp3", "wav", "m4a", "aac", "ogg"])) {
    return "audio";
  }
  if (mediaKind === "image"
    || mediaKind === "keyframe"
    || mediaKind === "storyboard"
    || mediaKind === "character_sheet"
    || matchesExtension(format, storageUrl, storagePath, ["png", "jpg", "jpeg", "webp", "gif", "avif"])) {
    return "image";
  }
  throw new GenerationError(
    "INVALID_GENERATION_REQUEST",
    "引用媒体类型无法识别，请使用已标记的图片或视频素材",
    422,
  );
}

type ControlUsageMode = "reference" | "first_frame" | "last_frame";

function controlUsageMode(value: string | null): ControlUsageMode {
  // Null is the backwards-compatible state for all pre-control-package assets.
  if (value === "first_frame" || value === "last_frame") return value;
  return "reference";
}

function referenceRole(
  kind: "image" | "video" | "audio",
  usageMode: ControlUsageMode,
): "reference_image" | "reference_video" | "reference_audio" | "first_frame" | "last_frame" {
  if (usageMode === "first_frame" || usageMode === "last_frame") return usageMode;
  if (kind === "video") return "reference_video";
  if (kind === "audio") return "reference_audio";
  return "reference_image";
}

function controlUsageMessage(actual: ControlUsageMode, expected: ControlUsageMode): string {
  if (expected === "reference") {
    return actual === "first_frame"
      ? "首帧资产请放入首帧槽，不要放进参考素材"
      : "尾帧资产请放入尾帧槽，不要放进参考素材";
  }
  if (actual === "reference") {
    return expected === "first_frame"
      ? "参考资产不能作为首帧，请选择标记为首帧的图片"
      : "参考资产不能作为尾帧，请选择标记为尾帧的图片";
  }
  return expected === "first_frame"
    ? "该资产标记为尾帧，不能作为首帧"
    : "该资产标记为首帧，不能作为尾帧";
}

function isThreeDimensionalMedia(media: typeof assetMedia.$inferSelect): boolean {
  const mediaKind = media.mediaKind.toLowerCase();
  const format = media.format?.toLowerCase() ?? "";
  const path = media.storagePath?.toLowerCase() ?? "";
  const url = media.storageUrl?.toLowerCase() ?? "";
  const metadataValues = Object.values(media.metadata)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return mediaKind === "model_3d"
    || mediaKind.includes("3d")
    || format === "glb"
    || format === "gltf"
    || path.endsWith(".glb")
    || path.endsWith(".gltf")
    || urlIncludesModelExtension(url)
    || metadataValues.some((value) => value.includes("model/gltf")
      || value.includes("model/gltf-binary")
      || value === "glb"
      || value === "gltf"
      || value.includes("model_3d"));
}

function matchesExtension(format: string, url: string, path: string, extensions: readonly string[]): boolean {
  return extensions.includes(format)
    || extensions.some((extension) => urlHasExtension(url, extension) || path.endsWith(`.${extension}`));
}

function urlIncludesModelExtension(url: string): boolean {
  return urlHasExtension(url, "glb") || urlHasExtension(url, "gltf");
}

function urlHasExtension(url: string, extension: string): boolean {
  return new RegExp(`\\.${extension}(?:[?#]|$)`, "i").test(url);
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function attemptPriceSnapshot(
  cost: CostEstimate,
): Record<string, unknown> {
  return asJsonRecord({
    ...cost,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonRecords(value: GenerationReferenceSnapshot[]): Array<Record<string, unknown>> {
  return value.map((item) => asJsonRecord(item));
}

function asStatus(value: string): GenerationView["status"] {
  if (["pending", "running", "succeeded", "failed", "cancelled"].includes(value)) {
    return value as GenerationView["status"];
  }
  throw new Error(`Unknown generation status: ${value}`);
}

function asInFlightStatus(value: string): GenerationInFlightView["status"] {
  if (value === "pending" || value === "running") return value;
  throw new Error(`Unknown in-flight generation status: ${value}`);
}

function asGenerationMediaKind(value: string): "image" | "video" | "audio" {
  if (value === "image" || value === "video" || value === "audio") return value;
  throw new Error("Generation media kind is invalid");
}

function asPhase(value: string): GenerationView["phase"] {
  if (["created", "submitting", "provider_queued", "provider_running", "provider_succeeded", "persisting", "complete"].includes(value)) {
    return value as GenerationView["phase"];
  }
  throw new Error(`Unknown generation phase: ${value}`);
}

function asTerminalNotificationStatus(
  value: string,
): Extract<GenerationAttemptNotificationView["status"], "succeeded" | "failed"> {
  if (value === "succeeded" || value === "failed") return value;
  throw new Error(`Generation notification points at a non-terminal attempt: ${value}`);
}

function generationNotFound(): GenerationError {
  return new GenerationError("GENERATION_NOT_FOUND", "生成任务或目标不存在", 404);
}

function generationNotificationNotFound(): GenerationError {
  return new GenerationError("GENERATION_NOTIFICATION_NOT_FOUND", "站内任务提醒不存在或无权访问", 404);
}
