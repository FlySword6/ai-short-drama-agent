import { isWithinBudget } from "../../src/modules/generation/cost.js";
import { GenerationError } from "../../src/modules/generation/errors.js";
import type {
  CreateGenerationResult,
  GenerationRepository,
} from "../../src/modules/generation/ports.js";
import type {
  GenerationBatchSubmissionView,
  GenerationInFlightPage,
  GenerationQuoteSource,
  GenerationQuoteView,
  GenerationView,
  GenerationTosObjectReceipt,
  ProviderResultSnapshot,
  RecoverableGenerationContext,
  StoredGenerationMedia,
} from "../../src/modules/generation/types.js";
import type { ProviderCostRecordOutcome } from "../../src/modules/generation/providerCost.js";

interface StoredRequest {
  actorId: string;
  projectId: string;
  requestHash: string;
  estimatedCostFen: number;
  latestAttemptId: string;
}

export interface FakeGenerationTosObjectLedgerEntry {
  attemptId: string;
  providerResultKey: string;
  storageBucket: string;
  objectKey: string;
  producedAt: Date;
  cleanupStatus: "pending_cleanup" | "referenced";
}

export interface FakeGenerationBillingFailureFact {
  attemptId: string;
  quoteId: string;
  reservedAmountFen: number;
  failureCode: string;
  providerCostStatus: "incurred";
  resolutionStatus: "pending_compensation";
}

export class FakeGenerationRepository implements GenerationRepository {
  usedFen = 0;
  pollFailures = 0;
  persistenceFailures = 0;
  persistenceRetryLimit = 1;
  unitPriceFen = 100;
  markSubmittingError: Error | undefined;
  readonly tosObjectLedger = new Map<string, FakeGenerationTosObjectLedgerEntry>();
  readonly billingFailureFacts: FakeGenerationBillingFailureFact[] = [];
  readonly providerCostRecords: Array<{ attemptId: string; result: ProviderResultSnapshot }> = [];
  providerCostError: Error | undefined;
  providerCostOutcome: ProviderCostRecordOutcome = {
    status: "confirmed",
    requiresAttention: false,
  };

  private counter = 0;
  private quoteCounter = 0;
  private readonly requests = new Map<string, StoredRequest>();
  private readonly contexts = new Map<string, RecoverableGenerationContext>();
  private readonly views = new Map<string, GenerationView>();
  private readonly submissionKeys = new Map<string, { requestHash: string; attemptId: string }>();
  private readonly retryKeys = new Map<string, { requestId: string; attemptId: string }>();
  private readonly quotes = new Map<string, GenerationQuoteView>();
  private readonly batchSubmissions = new Map<string, GenerationBatchSubmissionView>();
  private readonly batchAuthorizationsById = new Map<string, GenerationBatchSubmissionView>();
  private readonly persistenceFailureCounts = new Map<string, number>();

  async createSubmissionQuote(
    input: Parameters<GenerationRepository["createSubmissionQuote"]>[0],
  ): Promise<GenerationQuoteView> {
    return this.createQuote({
      actorId: input.actorId,
      source: input.source,
      assistantSessionId: input.assistantSessionId,
      action: "submit",
      requestHash: input.requestHash,
      normalizedRequest: quoteRequest(input.request),
      estimatedCostFen: this.unitPriceFen,
    });
  }

  async createRetryQuote(
    input: Parameters<GenerationRepository["createRetryQuote"]>[0],
  ): Promise<GenerationQuoteView> {
    const request = this.requests.get(input.requestId);
    if (!request || request.actorId !== input.actorId) throw new Error("request not found");
    const view = this.views.get(request.latestAttemptId);
    if (!view) throw new Error("attempt not found");
    return this.createQuote({
      actorId: input.actorId,
      source: input.source,
      assistantSessionId: input.assistantSessionId,
      action: "retry",
      originalRequestId: input.requestId,
      baseAttemptId: view.attemptId,
      baseAttemptNo: view.attemptNo ?? 1,
      requestHash: request.requestHash,
      normalizedRequest: quoteRequest(this.requireContext(view.attemptId).request.input),
      estimatedCostFen: this.unitPriceFen,
    });
  }

  async confirmQuote(
    actorId: string,
    quoteId: string,
    _authorizedProjectId: string,
  ): Promise<GenerationQuoteView> {
    const quote = this.quotes.get(quoteId);
    if (!quote || quote.userId !== actorId) throw new Error("quote not found");
    if (quote.status === "pending_confirmation") {
      quote.status = "confirmed";
      quote.confirmedAt = new Date("2026-07-14T12:00:01.000Z");
      quote.confirmedByUserId = actorId;
      quote.updatedAt = quote.confirmedAt;
    }
    if (quote.confirmedByUserId !== actorId) throw new Error("quote confirmer mismatch");
    return cloneQuote(quote);
  }

  async recordProviderCost(input: {
    attemptId: string;
    result: ProviderResultSnapshot;
  }): Promise<ProviderCostRecordOutcome> {
    this.providerCostRecords.push(input);
    if (this.providerCostError) throw this.providerCostError;
    return this.providerCostOutcome;
  }

  async createSubmission(
    input: Parameters<GenerationRepository["createSubmission"]>[0],
  ): Promise<CreateGenerationResult> {
    const quote = this.requireConfirmedQuote(
      input.actorId,
      input.source,
      input.quoteId,
      "submit",
      input.requestHash,
    );
    if (quote.status === "consumed") return this.consumedQuote(quote);
    const key = `${input.actorId}:${input.request.clientIdempotencyKey}`;
    const existing = this.submissionKeys.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) return { outcome: "idempotency_conflict" };
      this.consumeQuote(input.actorId, quote, this.views.get(existing.attemptId)?.requestId ?? "", existing.attemptId);
      return { outcome: "existing", view: this.cloneView(existing.attemptId) };
    }
    if (!isWithinBudget(this.usedFen, quote.estimatedCostFen, input.budgetLimitFen)) {
      return { outcome: "budget_exceeded" };
    }

    const requestId = `request-${++this.counter}`;
    const attemptId = `attempt-${this.counter}`;
    const now = new Date("2026-07-14T12:00:00.000Z");
    const view: GenerationView = {
      requestId,
      attemptId,
      projectId: input.request.projectId,
      ...(input.request.episodeId ? { episodeId: input.request.episodeId } : {}),
      ...(input.request.shotId ? { shotId: input.request.shotId } : {}),
      status: "pending",
      phase: "created",
      mediaKind: input.request.mediaKind,
      model: input.request.model,
      estimatedCostFen: quote.estimatedCostFen,
      media: [],
      createdAt: now,
      updatedAt: now,
    };
    const context: RecoverableGenerationContext = {
      request: {
        id: requestId,
        actorId: input.actorId,
        input: input.request,
        requestHash: input.requestHash,
        estimatedCostFen: quote.estimatedCostFen,
      },
      attempt: { id: attemptId, status: "pending", phase: "created" },
      media: view.media,
    };
    this.usedFen += quote.estimatedCostFen;
    this.requests.set(requestId, {
      actorId: input.actorId,
      projectId: input.request.projectId,
      requestHash: input.requestHash,
      estimatedCostFen: quote.estimatedCostFen,
      latestAttemptId: attemptId,
    });
    this.contexts.set(attemptId, context);
    this.views.set(attemptId, view);
    this.submissionKeys.set(key, { requestHash: input.requestHash, attemptId });
    this.consumeQuote(input.actorId, quote, requestId, attemptId);
    return { outcome: "created", view: this.cloneView(attemptId) };
  }

  async createBatchAuthorization(
    input: Parameters<GenerationRepository["createBatchAuthorization"]>[0],
  ): Promise<GenerationBatchSubmissionView> {
    const key = `${input.actorId}:${input.batch.clientIdempotencyKey}`;
    const existing = this.batchSubmissions.get(key);
    if (existing) {
      if (existing.listHash !== input.listHash
        || existing.projectId !== input.batch.projectId
        || existing.authorizedTotalEstimatedCostFen !== input.batch.expectedTotalEstimatedCostFen) {
        throw new GenerationError("IDEMPOTENCY_CONFLICT", "batch key was reused for another list", 409);
      }
      return cloneBatchSubmission(existing, true);
    }

    const quotes = input.batch.items.map((item) => {
      const quote = this.quotes.get(item.quoteId);
      if (!quote || quote.userId !== input.actorId || quote.source !== input.source || quote.action !== "submit") {
        throw new GenerationError("GENERATION_QUOTE_NOT_FOUND", "quote not found", 404);
      }
      return { item, quote };
    });
    const authorizedTotal = quotes.reduce((total, { quote }) => total + quote.estimatedCostFen, 0);
    if (authorizedTotal !== input.batch.expectedTotalEstimatedCostFen) {
      throw new GenerationError("GENERATION_QUOTE_CONFLICT", "batch total does not match quotes", 409);
    }

    const now = new Date("2026-07-14T12:00:00.000Z");
    const items: GenerationBatchSubmissionView["items"] = [];
    for (const { item, quote } of quotes) {
      if (quote.status !== "pending_confirmation") {
        throw new GenerationError("GENERATION_QUOTE_CONFLICT", "quote has already been handled", 409);
      }
      quote.status = "confirmed";
      quote.confirmedAt = now;
      quote.confirmedByUserId = input.actorId;
      items.push({
        itemId: item.itemId,
        quoteId: quote.id,
        estimatedCostFen: quote.estimatedCostFen,
        status: "confirmed",
      });
    }
    const result: GenerationBatchSubmissionView = {
      authorizationId: `batch-authorization-${++this.counter}`,
      userId: input.actorId,
      projectId: input.batch.projectId,
      clientIdempotencyKey: input.batch.clientIdempotencyKey,
      listHash: input.listHash,
      productionMode: input.batch.productionMode ?? "full",
      status: "confirmed",
      authorizedTotalEstimatedCostFen: authorizedTotal,
      submittedTotalEstimatedCostFen: 0,
      currency: "CNY",
      createdCount: 0,
      failedCount: 0,
      authorizedAt: now,
      idempotentReplay: false,
      items,
    };
    this.batchSubmissions.set(key, result);
    this.batchAuthorizationsById.set(result.authorizationId, result);
    return cloneBatchSubmission(result, false);
  }

  async findBatchAuthorizationProjectId(actorId: string, authorizationId: string): Promise<string | null> {
    const authorization = this.batchAuthorizationsById.get(authorizationId);
    return authorization?.userId === actorId ? authorization.projectId : null;
  }

  async submitBatchAuthorization(
    input: Parameters<GenerationRepository["submitBatchAuthorization"]>[0],
  ): Promise<GenerationBatchSubmissionView> {
    const authorization = this.batchAuthorizationsById.get(input.authorizationId);
    if (!authorization || authorization.userId !== input.actorId) {
      throw new GenerationError("GENERATION_BATCH_AUTHORIZATION_NOT_FOUND", "batch not found", 404);
    }
    if (authorization.status !== "confirmed") return cloneBatchSubmission(authorization, true);
    let submittedTotal = 0;
    const items: GenerationBatchSubmissionView["items"] = [];
    for (const item of authorization.items) {
      const quote = this.quotes.get(item.quoteId);
      if (!quote || quote.status !== "confirmed") {
        items.push({
          ...item,
          status: "quote_unavailable",
          error: { code: "GENERATION_QUOTE_CONFLICT", message: "quote has already been handled", retryable: false },
        });
        continue;
      }
      if (!isWithinBudget(this.usedFen, quote.estimatedCostFen, input.budgetLimitFen)) {
        items.push({
          ...item,
          status: "budget_blocked",
          error: { code: "GENERATION_BUDGET_EXCEEDED", message: "budget exceeded", retryable: true },
        });
        continue;
      }
      const requestId = `batch-request-${++this.counter}`;
      const attemptId = `batch-attempt-${this.counter}`;
      this.usedFen += quote.estimatedCostFen;
      submittedTotal += quote.estimatedCostFen;
      this.consumeQuote(input.actorId, quote, requestId, attemptId);
      items.push({
        ...item,
        status: "created",
        generationRequestId: requestId,
        generationAttemptId: attemptId,
      });
    }
    const createdCount = items.filter((item) => item.status === "created").length;
    const completed: GenerationBatchSubmissionView = {
      ...authorization,
      status: createdCount === items.length ? "completed" : createdCount > 0 ? "partial" : "failed",
      submittedTotalEstimatedCostFen: submittedTotal,
      createdCount,
      failedCount: items.length - createdCount,
      idempotentReplay: false,
      items,
    };
    this.batchAuthorizationsById.set(completed.authorizationId, completed);
    this.batchSubmissions.set(`${completed.userId}:${completed.clientIdempotencyKey}`, completed);
    return cloneBatchSubmission(completed, false);
  }

  async createRetry(input: Parameters<GenerationRepository["createRetry"]>[0]): Promise<CreateGenerationResult> {
    const request = this.requests.get(input.requestId);
    if (!request || request.actorId !== input.actorId) throw new Error("request not found");
    const quote = this.requireConfirmedQuote(
      input.actorId,
      input.source,
      input.quoteId,
      "retry",
      request.requestHash,
      input.requestId,
    );
    if (quote.status === "consumed") return this.consumedQuote(quote);
    if (quote.baseAttemptId !== request.latestAttemptId) throw new Error("quote_stale");
    const key = `${input.actorId}:${input.clientIdempotencyKey}`;
    const existing = this.retryKeys.get(key);
    if (existing) {
      if (existing.requestId !== input.requestId) return { outcome: "idempotency_conflict" };
      this.consumeQuote(input.actorId, quote, input.requestId, existing.attemptId);
      return { outcome: "existing", view: this.cloneView(existing.attemptId) };
    }
    if (!isWithinBudget(this.usedFen, quote.estimatedCostFen, input.budgetLimitFen)) {
      return { outcome: "budget_exceeded" };
    }

    const priorContext = this.contexts.get(request.latestAttemptId);
    if (!priorContext) throw new Error("attempt not found");
    const attemptId = `attempt-${++this.counter}`;
    const now = new Date("2026-07-14T12:01:00.000Z");
    const view: GenerationView = {
      requestId: input.requestId,
      attemptId,
      projectId: priorContext.request.input.projectId,
      ...(priorContext.request.input.episodeId ? { episodeId: priorContext.request.input.episodeId } : {}),
      ...(priorContext.request.input.shotId ? { shotId: priorContext.request.input.shotId } : {}),
      status: "pending",
      phase: "created",
      mediaKind: priorContext.request.input.mediaKind,
      model: priorContext.request.input.model,
      estimatedCostFen: quote.estimatedCostFen,
      media: [],
      createdAt: now,
      updatedAt: now,
    };
    this.contexts.set(attemptId, {
      request: priorContext.request,
      attempt: { id: attemptId, status: "pending", phase: "created" },
      media: view.media,
    });
    this.views.set(attemptId, view);
    request.latestAttemptId = attemptId;
    this.usedFen += quote.estimatedCostFen;
    this.retryKeys.set(key, { requestId: input.requestId, attemptId });
    this.consumeQuote(input.actorId, quote, input.requestId, attemptId);
    return { outcome: "created", view: this.cloneView(attemptId) };
  }

  async findViewForActor(
    actorId: string,
    requestId: string,
    authorizedProjectId?: string,
  ): Promise<GenerationView | null> {
    const request = this.requests.get(requestId);
    if (!request || (request.actorId !== actorId && request.projectId !== authorizedProjectId)) return null;
    return this.cloneView(request.latestAttemptId);
  }

  async findViewByAttemptId(attemptId: string): Promise<GenerationView | null> {
    return this.views.has(attemptId) ? this.cloneView(attemptId) : null;
  }

  async listInFlightViewsForActor(actorId: string, page: number, pageSize: number): Promise<GenerationInFlightPage> {
    const active = [...this.requests.entries()]
      .filter(([, request]) => request.actorId === actorId)
      .map(([, request]) => this.cloneView(request.latestAttemptId))
      .filter((view) => view.status === "pending" || view.status === "running")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()
        || left.requestId.localeCompare(right.requestId));
    return {
      items: active.slice((page - 1) * pageSize, page * pageSize).map((view) => ({
        requestId: view.requestId,
        attemptId: view.attemptId,
        projectId: view.projectId,
        ...(view.episodeId ? { episodeId: view.episodeId } : {}),
        ...(view.shotId ? { shotId: view.shotId } : {}),
        mediaKind: view.mediaKind,
        status: view.status as "pending" | "running",
        attemptNo: view.attemptNo ?? 1,
        model: view.model,
        queuePosition: view.queuePosition ?? null,
        estimatedDurationSeconds: view.estimatedDurationSeconds ?? null,
        estimatedDurationSampleCount: view.estimatedDurationSampleCount ?? 0,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
      })),
      page,
      pageSize,
      total: active.length,
    };
  }

  async getRecoverableAttempt(attemptId: string): Promise<RecoverableGenerationContext | null> {
    return this.contexts.get(attemptId) ?? null;
  }

  async markSubmitting(attemptId: string): Promise<void> {
    if (this.markSubmittingError) throw this.markSubmittingError;
    this.update(attemptId, { status: "running", phase: "submitting" });
  }

  async markProviderAccepted(attemptId: string, providerTaskId: string): Promise<void> {
    const context = this.requireContext(attemptId);
    context.attempt.providerTaskId = providerTaskId;
    this.update(attemptId, { status: "running", phase: "provider_queued", providerTaskId });
  }

  async markProviderProgress(attemptId: string, result: ProviderResultSnapshot): Promise<void> {
    this.update(attemptId, {
      status: "running",
      phase: result.status === "pending" ? "provider_queued" : "provider_running",
    });
  }

  async markProviderSucceeded(attemptId: string, result: ProviderResultSnapshot): Promise<void> {
    const context = this.requireContext(attemptId);
    context.attempt.providerResult = result;
    this.update(attemptId, { status: "running", phase: "provider_succeeded" });
  }

  async markProviderFailed(
    input: Parameters<GenerationRepository["markProviderFailed"]>[0],
  ): Promise<void> {
    const context = this.requireContext(input.attemptId);
    if (input.providerResult) context.attempt.providerResult = input.providerResult;
    // Match the database repository's fail-closed terminal transition: a
    // partially persisted batch is not an output of a failed attempt.
    this.markAttemptMediaPendingCleanup(input.attemptId, context);
    context.media.splice(0);
    if (input.recordCompensationPending) {
      for (const quote of this.quotes.values()) {
        if (quote.status !== "consumed" || quote.generationAttemptId !== input.attemptId) continue;
        if (this.billingFailureFacts.some((fact) => fact.attemptId === input.attemptId && fact.quoteId === quote.id)) {
          continue;
        }
        this.billingFailureFacts.push({
          attemptId: input.attemptId,
          quoteId: quote.id,
          reservedAmountFen: quote.estimatedCostFen,
          failureCode: input.errorCode,
          // This records the supplier-side cost fact only. It deliberately
          // neither refunds nor changes the price charged to the user.
          providerCostStatus: "incurred",
          resolutionStatus: "pending_compensation",
        });
      }
    }
    this.update(input.attemptId, {
      status: "failed",
      phase: "complete",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
  }

  async markSubmissionOutcomeUnknown(attemptId: string, errorMessage: string): Promise<void> {
    this.update(attemptId, {
      status: "failed",
      phase: "submitting",
      errorCode: "SUBMISSION_OUTCOME_UNKNOWN",
      errorMessage,
    });
  }

  async recordPollFailure(attemptId: string, errorMessage: string): Promise<void> {
    this.pollFailures += 1;
    this.update(attemptId, { errorMessage });
  }

  async markPersisting(attemptId: string): Promise<void> {
    this.update(attemptId, { status: "running", phase: "persisting" });
  }

  async recordPersistenceFailure(attemptId: string, errorMessage: string): Promise<void> {
    this.persistenceFailures += 1;
    const retryCount = this.persistenceFailureCounts.get(attemptId) ?? 0;
    if (retryCount >= this.persistenceRetryLimit) {
      const context = this.requireContext(attemptId);
      this.markAttemptMediaPendingCleanup(attemptId, context);
      context.media.splice(0);
      this.update(attemptId, {
        status: "failed",
        phase: "complete",
        errorCode: "PERSISTENCE_RETRY_EXHAUSTED",
        errorMessage: `Persistence recovery retry limit (${this.persistenceRetryLimit}) exhausted: ${errorMessage}`,
      });
      return;
    }
    this.persistenceFailureCounts.set(attemptId, retryCount + 1);
    this.update(attemptId, { status: "running", phase: "persisting", errorMessage });
  }

  async recordTosObjectUpload(
    attemptId: string,
    object: GenerationTosObjectReceipt,
  ): Promise<void> {
    const ledgerKey = this.tosLedgerKey(object.storageBucket, object.objectKey);
    const existing = this.tosObjectLedger.get(ledgerKey);
    if (existing?.cleanupStatus === "referenced") return;
    this.tosObjectLedger.set(ledgerKey, {
      attemptId,
      providerResultKey: object.providerResultKey,
      storageBucket: object.storageBucket,
      objectKey: object.objectKey,
      producedAt: object.producedAt,
      cleanupStatus: "pending_cleanup",
    });
  }

  async saveMediaResult(attemptId: string, result: StoredGenerationMedia): Promise<void> {
    const context = this.requireContext(attemptId);
    const ledgerEntry = this.tosObjectLedger.get(this.tosLedgerKey(result.storageBucket, result.storagePath));
    if (!ledgerEntry || ledgerEntry.attemptId !== attemptId) {
      throw new Error("Persisted media requires a matching TOS object receipt");
    }
    const existing = context.media.findIndex((item) => item.providerResultKey === result.providerResultKey);
    if (existing >= 0) context.media[existing] = result;
    else context.media.push(result);
    ledgerEntry.cleanupStatus = "referenced";
  }

  async markSucceeded(attemptId: string): Promise<void> {
    const context = this.requireContext(attemptId);
    const expected = context.attempt.providerResult?.media ?? [];
    if (!expected.every((item) => (
      context.media.some((stored) => stored.providerResultKey === item.providerResultKey)
    ))) {
      throw new Error("media persistence is incomplete");
    }
    this.update(attemptId, {
      status: "succeeded",
      phase: "complete",
      errorCode: undefined,
      errorMessage: undefined,
    });
  }

  forcePhase(attemptId: string, phase: RecoverableGenerationContext["attempt"]["phase"]): void {
    this.update(attemptId, { status: "running", phase });
  }

  private createQuote(input: {
    actorId: string;
    source: GenerationQuoteSource;
    assistantSessionId?: string;
    action: "submit" | "retry";
    originalRequestId?: string;
    baseAttemptId?: string;
    baseAttemptNo?: number;
    requestHash: string;
    normalizedRequest: Record<string, unknown>;
    estimatedCostFen: number;
  }): GenerationQuoteView {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const id = `quote-${++this.quoteCounter}`;
    const quote: GenerationQuoteView = {
      id,
      userId: input.actorId,
      source: input.source,
      action: input.action,
      ...(input.assistantSessionId ? { assistantSessionId: input.assistantSessionId } : {}),
      ...(input.originalRequestId ? { originalRequestId: input.originalRequestId } : {}),
      ...(input.baseAttemptId ? { baseAttemptId: input.baseAttemptId } : {}),
      ...(input.baseAttemptNo ? { baseAttemptNo: input.baseAttemptNo } : {}),
      requestHash: input.requestHash,
      normalizedRequest: input.normalizedRequest,
      pricingRuleId: "fake-price",
      priceSnapshot: {
        pricingRuleId: "fake-price",
        provider: "ark",
        model: "fake-model",
        mediaKind: "image",
        billingUnit: "request",
        unitPriceFen: input.estimatedCostFen,
        billableUnits: 1,
        estimatedCostFen: input.estimatedCostFen,
        fullEstimatedCostFen: input.estimatedCostFen,
        productionMode: "full",
        priceMultiplierBps: 10_000,
        discountNumerator: 1,
        discountDenominator: 1,
        currency: "CNY",
      },
      estimatedCostFen: input.estimatedCostFen,
      status: "pending_confirmation",
      expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
      createdAt: now,
      updatedAt: now,
    };
    this.quotes.set(id, quote);
    return cloneQuote(quote);
  }

  private requireConfirmedQuote(
    actorId: string,
    source: GenerationQuoteSource,
    quoteId: string,
    action: "submit" | "retry",
    requestHash: string,
    originalRequestId?: string,
  ): GenerationQuoteView {
    const quote = this.quotes.get(quoteId);
    if (!quote || quote.userId !== actorId) throw new Error("quote not found");
    if (quote.source !== source) {
      throw new GenerationError(
        "GENERATION_QUOTE_SOURCE_MISMATCH",
        "quote source does not match entry",
        409,
      );
    }
    if (quote.action !== action
      || quote.requestHash !== requestHash
      || quote.originalRequestId !== originalRequestId) {
      throw new GenerationError("GENERATION_QUOTE_CONFLICT", "quote input changed", 409);
    }
    if (quote.status !== "confirmed" && quote.status !== "consumed") {
      throw new GenerationError("GENERATION_QUOTE_UNCONFIRMED", "quote is not confirmed", 409);
    }
    if (quote.confirmedByUserId !== actorId) {
      throw new GenerationError("GENERATION_QUOTE_CONFLICT", "quote was not confirmed by this actor", 409);
    }
    return quote;
  }

  private consumeQuote(actorId: string, quote: GenerationQuoteView, requestId: string, attemptId: string): void {
    if (quote.userId !== actorId || quote.confirmedByUserId !== actorId) {
      throw new Error("quote actor mismatch");
    }
    const now = new Date("2026-07-14T12:01:00.000Z");
    quote.status = "consumed";
    quote.consumedAt = now;
    quote.generationRequestId = requestId;
    quote.generationAttemptId = attemptId;
    quote.updatedAt = now;
  }

  private consumedQuote(quote: GenerationQuoteView): CreateGenerationResult {
    if (!quote.generationAttemptId) throw new Error("consumed quote has no attempt");
    return { outcome: "existing", view: this.cloneView(quote.generationAttemptId) };
  }

  private update(attemptId: string, patch: Partial<GenerationView>): void {
    const view = this.views.get(attemptId);
    const context = this.requireContext(attemptId);
    if (!view) throw new Error("view not found");
    Object.assign(view, patch, { updatedAt: new Date("2026-07-14T12:02:00.000Z") });
    if (patch.status) context.attempt.status = patch.status;
    if (patch.phase) context.attempt.phase = patch.phase;
  }

  private requireContext(attemptId: string): RecoverableGenerationContext {
    const context = this.contexts.get(attemptId);
    if (!context) throw new Error("attempt not found");
    return context;
  }

  private markAttemptMediaPendingCleanup(
    attemptId: string,
    context: RecoverableGenerationContext,
  ): void {
    for (const media of context.media) {
      const ledgerEntry = this.tosObjectLedger.get(this.tosLedgerKey(media.storageBucket, media.storagePath));
      if (ledgerEntry) {
        ledgerEntry.attemptId = attemptId;
        ledgerEntry.cleanupStatus = "pending_cleanup";
      }
    }
  }

  private tosLedgerKey(storageBucket: string, objectKey: string): string {
    return `${storageBucket}:${objectKey}`;
  }

  private cloneView(attemptId: string): GenerationView {
    const view = this.views.get(attemptId);
    if (!view) throw new Error("view not found");
    return { ...view, media: [...view.media] };
  }
}

function quoteRequest(input: RecoverableGenerationContext["request"]["input"]): Record<string, unknown> {
  const { clientIdempotencyKey: _key, ...request } = input;
  return JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
}

function cloneQuote(quote: GenerationQuoteView): GenerationQuoteView {
  return {
    ...quote,
    normalizedRequest: { ...quote.normalizedRequest },
    priceSnapshot: { ...quote.priceSnapshot },
  };
}

function cloneBatchSubmission(
  submission: GenerationBatchSubmissionView,
  idempotentReplay: boolean,
): GenerationBatchSubmissionView {
  return {
    ...submission,
    idempotentReplay,
    items: submission.items.map((item) => ({
      ...item,
      ...(item.error ? { error: { ...item.error } } : {}),
    })),
  };
}
