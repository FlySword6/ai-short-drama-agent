import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import {
  agentSessions,
  assetEntities,
  assetMedia,
  episodes,
  generationAttempts,
  generationBatchAuthorizations,
  generationQuotes,
  generationRequests,
  pricingRules,
  projectMembers,
  projects,
  seedanceAssetRegistrations,
  sessions,
  shots,
  userCreditAccounts,
  users,
} from "../src/db/schema.js";
import { GenerationError } from "../src/modules/generation/errors.js";
import { hashSessionToken } from "../src/modules/auth/service.js";
import { PostgresGenerationRepository } from "../src/modules/generation/repository.js";
import { GenerationService } from "../src/modules/generation/service.js";
import type { ScopedGenerationActor, SubmitGenerationInput } from "../src/modules/generation/types.js";
import {
  ARK_SEEDANCE_2_FAST_MODEL,
  ARK_SEEDREAM_5_PRO_MODEL,
} from "../src/modules/generation/v01Contract.js";

const databaseUrl = process.env.GENERATION_QUOTES_TEST_DATABASE_URL;

test("PostgreSQL 报价单阻止重复付费与过期费用", { skip: !databaseUrl }, async () => {
  const handle = createDatabase(databaseUrl);
  const db = handle.db;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const now = new Date();
  const ids = {
    owner: randomUUID(),
    editor: randomUUID(),
    other: randomUUID(),
    project: randomUUID(),
    episode: randomUUID(),
    shot: randomUUID(),
    price: randomUUID(),
    videoPrice: randomUUID(),
    otherSession: randomUUID(),
    legacy3dAsset: randomUUID(),
    legacy3dMedia: randomUUID(),
    legacy3dRequest: randomUUID(),
    legacy3dAttempt: randomUUID(),
    videoReferenceAsset: randomUUID(),
    videoReferenceMedia: randomUUID(),
  };
  const ownerActor = { userId: ids.owner, authorizedProjectId: ids.project };
  const otherActor = { userId: ids.other, authorizedProjectId: ids.project };
  try {
    await db.insert(users).values([
      userValues(ids.owner, "quote-owner", now),
      userValues(ids.editor, "quote-editor", now),
      userValues(ids.other, "quote-other", now),
    ]);
    await db.update(userCreditAccounts).set({
      balancePoints: 50_000_000,
      dailyLimitPoints: 50_000_000,
      updatedAt: now,
    }).where(inArray(userCreditAccounts.userId, [ids.owner, ids.editor]));
    const apiToken = `quote-api-${randomUUID()}`;
    await db.insert(sessions).values({
      id: randomUUID(),
      userId: ids.owner,
      tokenHash: hashSessionToken(apiToken),
      credentialSource: "web",
      agentType: null,
      userAgent: "generation-quotes-db-test",
      credentialLabel: null,
      issuedBySessionId: null,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      revokedAt: null,
      createdAt: now,
    });
    await db.insert(projects).values({
      id: ids.project,
      ownerUserId: ids.owner,
      name: `报价测试-${ids.project.slice(0, 8)}`,
      description: null,
      status: "active",
      // This suite registers only the historical 16:9 / 2K image tier.
      // Keep its project defaults on that tier so it tests quote semantics,
      // while project-default tier switching stays covered by route tests.
      defaultRatio: "16:9",
      defaultImageResolution: "2K",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await db.insert(projectMembers).values({
      projectId: ids.project,
      userId: ids.editor,
      role: "editor",
      addedByUserId: ids.owner,
      createdAt: now,
    });
    await db.insert(episodes).values({
      id: ids.episode,
      projectId: ids.project,
      episodeNo: 1,
      name: "第1集",
      sortOrder: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await db.insert(shots).values({
      id: ids.shot,
      episodeId: ids.episode,
      sceneId: null,
      shotCode: "G01",
      title: "报价测试分镜",
      scriptText: null,
      directorPrompt: null,
      imagePrompt: "雨夜街道",
      videoPrompt: null,
      durationSeconds: null,
      sortOrder: 1,
      referenceAssetSnapshots: [],
      selectedImageResultId: null,
      selectedVideoResultId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await db.insert(agentSessions).values({
      id: ids.otherSession,
      userId: ids.other,
      authSessionId: null,
      agentType: "platform_assistant",
      userAgent: "generation-quotes-db-test",
      projectId: null,
      shotId: null,
      title: "他人会话",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await db.insert(pricingRules).values(priceValues(ids.price, 60, now));
    await db.insert(pricingRules).values(videoPriceValues(ids.videoPrice, now));

    await db.insert(assetEntities).values(legacyAssetValues(ids.legacy3dAsset, ids.owner, now));
    await db.insert(assetMedia).values(legacy3dMediaValues(
      ids.legacy3dMedia,
      ids.legacy3dAsset,
      now,
    ));
    await db.insert(assetEntities).values({
      ...legacyAssetValues(ids.videoReferenceAsset, ids.owner, now),
      name: "视频参考定价夹具",
      displayName: "视频参考定价夹具",
    });
    await db.insert(assetMedia).values(videoReferenceMediaValues(
      ids.videoReferenceMedia,
      ids.videoReferenceAsset,
      now,
    ));
    await db.insert(seedanceAssetRegistrations).values({
      id: randomUUID(),
      assetMediaId: ids.videoReferenceMedia,
      sourceMediaResultId: null,
      assetGroupId: "generation-quotes-db-test",
      projectName: "shortdrama-dev",
      remoteAssetId: videoReferenceRemoteAssetId(ids.videoReferenceMedia),
      remoteAssetName: null,
      status: "active",
      createdByUserId: ids.owner,
      lastActionByUserId: ids.owner,
      createdAt: now,
      updatedAt: now,
      lastActionAt: now,
      activatedAt: now,
      authorizationExpiresAt: null,
      lastVerifiedAt: now,
      latestRequestId: null,
      latestErrorCode: null,
      latestErrorMessage: null,
      retryCount: 0,
      lastRetryAt: null,
    });
    await db.insert(generationRequests).values({
      id: ids.legacy3dRequest,
      userId: ids.owner,
      projectId: ids.project,
      episodeId: ids.episode,
      sceneId: null,
      shotId: ids.shot,
      targetAssetEntityId: null,
      mediaKind: "image",
      prompt: "历史 3D 素模被旧版错误冻结为图片",
      referenceMediaIds: [ids.legacy3dMedia],
      referenceAssetSnapshots: [{
        kind: "image",
        url: "https://assets.test/signed-proxy/no-extension",
        role: "reference_image",
      }],
      parameters: { size: "2K", watermark: false, sequentialImageGeneration: "disabled" },
      quantity: 1,
      clientIdempotencyKey: `legacy-3d-${ids.legacy3dRequest}`,
      requestHash: "0".repeat(64),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(generationAttempts).values({
      id: ids.legacy3dAttempt,
      requestId: ids.legacy3dRequest,
      attemptNo: 1,
      retryIdempotencyKey: null,
      provider: "ark",
      providerTaskId: null,
      model: ARK_SEEDREAM_5_PRO_MODEL,
      parameters: { size: "2K", watermark: false, sequentialImageGeneration: "disabled" },
      quantity: 1,
      status: "failed",
      phase: "complete",
      providerStatus: "failed",
      providerResponse: null,
      errorCode: "LEGACY_TEST_FAILURE",
      errorMessage: "旧任务用于重试安全测试",
      retryable: true,
      estimatedCostFen: 60,
      actualCostFen: null,
      actualCostStatus: "unavailable",
      pricingRuleId: ids.price,
      priceSnapshot: {
        tierId: "img-seedream5pro-169-2k-1",
        pricingRuleId: ids.price,
        provider: "ark",
        model: ARK_SEEDREAM_5_PRO_MODEL,
        mediaKind: "image",
        billingUnit: "image",
        unitPriceFen: 60,
        billableUnits: 1,
        estimatedCostFen: 60,
        fullEstimatedCostFen: 60,
        productionMode: "full",
        priceMultiplierBps: 10_000,
        discountNumerator: 1,
        discountDenominator: 1,
        currency: "CNY",
        test_only: true,
      },
      lastQueryError: null,
      nextPollAt: null,
      lastPolledAt: null,
      leaseOwner: null,
      leaseUntil: null,
      submittedAt: now,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    let providerCalls = 0;
    const repository = new PostgresGenerationRepository(db, 5_000);
    const service = new GenerationService({
      repository,
      provider: {
        submit: async () => {
          providerCalls += 1;
          throw new Error("测试不允许调用方舟");
        },
        query: async () => {
          providerCalls += 1;
          throw new Error("测试不允许调用方舟");
        },
      },
      storage: {
        uploadBytes: async () => { throw new Error("测试不允许写入存储"); },
      },
      budgetLimitFen: 50_000_000,
    });

    const mismatchGuardCalls: Array<string | undefined> = [];
    const mismatchRepository = new PostgresGenerationRepository(
      db,
      5_000,
      true,
      (_request, expectedProvider) => {
        mismatchGuardCalls.push(expectedProvider);
        if (expectedProvider) {
          throw new GenerationError(
            "GENERATION_CAPABILITY_UNAVAILABLE",
            "current price provider does not match the configured route",
            503,
          );
        }
        return "minimax";
      },
    );
    const mismatchService = new GenerationService({
      repository: mismatchRepository,
      provider: {
        submit: async () => { throw new Error("provider must not be called"); },
        query: async () => { throw new Error("provider must not be called"); },
      },
      storage: {
        uploadBytes: async () => { throw new Error("storage must not be called"); },
      },
      budgetLimitFen: 50_000_000,
    });
    const quoteCountBeforeProviderMismatch = (await db.select({ id: generationQuotes.id })
      .from(generationQuotes)).length;
    await assert.rejects(
      () => mismatchService.quoteSubmission(
        ownerActor,
        generationInput(ids, "provider-price-mismatch"),
        "web",
      ),
      (error: unknown) => hasCode(error, "GENERATION_CAPABILITY_UNAVAILABLE"),
    );
    assert.deepEqual(mismatchGuardCalls, [undefined, "ark"]);
    assert.equal(
      (await db.select({ id: generationQuotes.id }).from(generationQuotes)).length,
      quoteCountBeforeProviderMismatch,
      "provider mismatch must not persist a quote",
    );

    const routedRepository = new PostgresGenerationRepository(
      db,
      5_000,
      true,
      (_request, expectedProvider) => {
        if (expectedProvider && expectedProvider !== "ark") {
          throw new GenerationError(
            "GENERATION_CAPABILITY_UNAVAILABLE",
            "unexpected current price provider",
            503,
          );
        }
        return "ark-routed-test";
      },
    );
    const routedService = new GenerationService({
      repository: routedRepository,
      provider: {
        submit: async () => { throw new Error("provider must not be called"); },
        query: async () => { throw new Error("provider must not be called"); },
      },
      storage: {
        uploadBytes: async () => { throw new Error("storage must not be called"); },
      },
      budgetLimitFen: 50_000_000,
    });
    const routedInput = generationInput(ids, "routed-attempt-provider");
    const routedQuote = await confirmedQuote(routedService, ownerActor, routedInput);
    const routed = await routedService.submit(ownerActor, routedInput, routedQuote.id, "web");
    const [routedAttempt] = await db.select({ provider: generationAttempts.provider })
      .from(generationAttempts)
      .where(eq(generationAttempts.id, routed.attemptId));
    assert.equal(
      routedAttempt?.provider,
      "ark-routed-test",
      "attempt provenance must use the provider returned by the configured route",
    );
    assert.equal(providerCalls, 0);

    const quoteCountBeforeLegacyRetry = (await db.select({ id: generationQuotes.id })
      .from(generationQuotes)).length;
    await assert.rejects(
      () => service.quoteRetry(ownerActor, ids.legacy3dRequest, "web"),
      (error: unknown) => error instanceof GenerationError
        && error.code === "control_asset_invalid_usage"
        && error.statusCode === 422
        && error.message.includes("3D 素模"),
    );
    assert.equal((await db.select({ id: generationQuotes.id }).from(generationQuotes)).length,
      quoteCountBeforeLegacyRetry);
    assert.equal((await db.select({ id: generationAttempts.id }).from(generationAttempts)
      .where(eq(generationAttempts.requestId, ids.legacy3dRequest))).length, 1);
    assert.equal(providerCalls, 0);

    const quoteCountBeforeUnsupportedVideoReference = (await db.select({ id: generationQuotes.id })
      .from(generationQuotes)).length;
    await assert.rejects(
      () => service.quoteSubmission(ownerActor, videoGenerationInput(ids, "video-reference-without-price"),
      "web",),
      (error: unknown) => error instanceof GenerationError
        && error.code === "INVALID_GENERATION_REQUEST"
        && error.message.includes("单价未覆盖视频参考"),
    );
    const quoteCountAfterUnsupportedVideoReference = (await db.select({ id: generationQuotes.id })
      .from(generationQuotes)).length;
    assert.equal(quoteCountAfterUnsupportedVideoReference, quoteCountBeforeUnsupportedVideoReference);

    await assert.rejects(
      () => service.quoteSubmission(
        ownerActor,
        generationInput(ids, "assistant-cross-user"),
        "assistant",
        ids.otherSession,
      ),
      (error: unknown) => hasCode(error, "INVALID_GENERATION_REQUEST"),
    );

    const foreignQuote = await service.quoteSubmission(ownerActor, generationInput(ids, "foreign-quote"), "web");
    await assert.rejects(
      () => service.confirmQuote(otherActor, foreignQuote.id),
      (error: unknown) => hasCode(error, "GENERATION_QUOTE_NOT_FOUND"),
    );

    const unconfirmedInput = generationInput(ids, "unconfirmed");
    const unconfirmed = await service.quoteSubmission(ownerActor, unconfirmedInput, "web");
    await assert.rejects(
      () => service.submit(ownerActor, unconfirmedInput, unconfirmed.id, "web"),
      (error: unknown) => hasCode(error, "GENERATION_QUOTE_UNCONFIRMED"),
    );

    const revokedEditorInput = generationInput(ids, "revoked-editor");
    const revokedEditorActor = { userId: ids.editor, authorizedProjectId: ids.project };
    const revokedEditorQuote = await service.quoteSubmission(revokedEditorActor, revokedEditorInput, "web");
    await service.confirmQuote(revokedEditorActor, revokedEditorQuote.id);
    const requestCountBeforeRevokedSubmit = (await db.select({ id: generationRequests.id })
      .from(generationRequests)).length;
    const attemptCountBeforeRevokedSubmit = (await db.select({ id: generationAttempts.id })
      .from(generationAttempts)).length;
    await db.delete(projectMembers).where(and(
      eq(projectMembers.projectId, ids.project),
      eq(projectMembers.userId, ids.editor),
    ));
    await assert.rejects(
      () => service.submit(revokedEditorActor, revokedEditorInput, revokedEditorQuote.id, "web"),
      (error: unknown) => hasCode(error, "GENERATION_QUOTE_NOT_FOUND"),
    );
    assert.equal(
      (await db.select({ id: generationRequests.id }).from(generationRequests)).length,
      requestCountBeforeRevokedSubmit,
      "revoked project access must not create a generation request",
    );
    assert.equal(
      (await db.select({ id: generationAttempts.id }).from(generationAttempts)).length,
      attemptCountBeforeRevokedSubmit,
      "revoked project access must not create an attempt",
    );
    const [revokedEditorQuoteAfterSubmit] = await db.select({ status: generationQuotes.status })
      .from(generationQuotes)
      .where(eq(generationQuotes.id, revokedEditorQuote.id));
    assert.equal(revokedEditorQuoteAfterSubmit?.status, "confirmed");
    assert.equal(providerCalls, 0, "rejected submission must not invoke the provider");

    // 撤权复核合同覆盖全部四个付费消费入口：confirm / submit / batch / retry。
    // submit 已在上方覆盖；下面三段在恢复成员资格后各自撤权，断言每个入口的
    // 写事务都重判项目权限，不产生 request/attempt/provider 调用。
    const editorMembership = {
      projectId: ids.project,
      userId: ids.editor,
      role: "editor" as const,
      addedByUserId: ids.owner,
      createdAt: now,
    };
    const revokeEditorMembership = () => db.delete(projectMembers).where(and(
      eq(projectMembers.projectId, ids.project),
      eq(projectMembers.userId, ids.editor),
    ));

    await db.insert(projectMembers).values(editorMembership);
    const revokedConfirmQuote = await service.quoteSubmission(
      revokedEditorActor,
      generationInput(ids, "revoked-confirm"),
      "web",
    );
    const requestCountBeforeRevokedConfirm = (await db.select({ id: generationRequests.id })
      .from(generationRequests)).length;
    const attemptCountBeforeRevokedConfirm = (await db.select({ id: generationAttempts.id })
      .from(generationAttempts)).length;
    await revokeEditorMembership();
    await assert.rejects(
      () => service.confirmQuote(revokedEditorActor, revokedConfirmQuote.id),
      (error: unknown) => hasCode(error, "GENERATION_QUOTE_NOT_FOUND"),
    );
    assert.equal(
      (await db.select({ id: generationRequests.id }).from(generationRequests)).length,
      requestCountBeforeRevokedConfirm,
      "revoked confirm must not create a generation request",
    );
    assert.equal(
      (await db.select({ id: generationAttempts.id }).from(generationAttempts)).length,
      attemptCountBeforeRevokedConfirm,
      "revoked confirm must not create an attempt",
    );
    const [revokedConfirmQuoteAfter] = await db.select({ status: generationQuotes.status })
      .from(generationQuotes)
      .where(eq(generationQuotes.id, revokedConfirmQuote.id));
    assert.equal(revokedConfirmQuoteAfter?.status, "pending_confirmation");
    assert.equal(providerCalls, 0, "rejected confirm must not invoke the provider");

    await db.insert(projectMembers).values(editorMembership);
    const revokedBatchQuote = await service.quoteSubmission(
      revokedEditorActor,
      generationInput(ids, "revoked-batch"),
      "web",
    );
    const revokedBatchAuthorization = await service.confirmBatch(revokedEditorActor, {
      projectId: ids.project,
      clientIdempotencyKey: "revoked-batch-auth",
      expectedTotalEstimatedCostFen: revokedBatchQuote.estimatedCostFen,
      items: [{ itemId: "revoked-batch-item", quoteId: revokedBatchQuote.id }],
    }, "web");
    const requestCountBeforeRevokedBatch = (await db.select({ id: generationRequests.id })
      .from(generationRequests)).length;
    const attemptCountBeforeRevokedBatch = (await db.select({ id: generationAttempts.id })
      .from(generationAttempts)).length;
    await revokeEditorMembership();
    await assert.rejects(
      () => service.submitBatchAuthorization(
        revokedEditorActor,
        revokedBatchAuthorization.authorizationId,
        "web",
      ),
      (error: unknown) => hasCode(error, "GENERATION_BATCH_AUTHORIZATION_NOT_FOUND"),
    );
    assert.equal(
      (await db.select({ id: generationRequests.id }).from(generationRequests)).length,
      requestCountBeforeRevokedBatch,
      "revoked batch submission must not create a generation request",
    );
    assert.equal(
      (await db.select({ id: generationAttempts.id }).from(generationAttempts)).length,
      attemptCountBeforeRevokedBatch,
      "revoked batch submission must not create an attempt",
    );
    const [revokedBatchAuthorizationAfter] = await db.select({ status: generationBatchAuthorizations.status })
      .from(generationBatchAuthorizations)
      .where(eq(generationBatchAuthorizations.id, revokedBatchAuthorization.authorizationId));
    assert.equal(revokedBatchAuthorizationAfter?.status, "confirmed");
    assert.equal(providerCalls, 0, "rejected batch submission must not invoke the provider");

    await db.insert(projectMembers).values(editorMembership);
    const revokedRetryInput = generationInput(ids, "revoked-retry");
    const revokedRetryQuoteForSubmit = await service.quoteSubmission(revokedEditorActor, revokedRetryInput, "web");
    await service.confirmQuote(revokedEditorActor, revokedRetryQuoteForSubmit.id);
    const revokedRetrySubmission = await service.submit(
      revokedEditorActor,
      revokedRetryInput,
      revokedRetryQuoteForSubmit.id,
      "web",
    );
    await repository.cancelForActor(ids.editor, revokedRetrySubmission.requestId, ids.project);
    const revokedRetryQuote = await service.quoteRetry(revokedEditorActor, revokedRetrySubmission.requestId, "web");
    await service.confirmQuote(revokedEditorActor, revokedRetryQuote.id);
    const requestCountBeforeRevokedRetry = (await db.select({ id: generationRequests.id })
      .from(generationRequests)).length;
    const attemptCountBeforeRevokedRetry = (await db.select({ id: generationAttempts.id })
      .from(generationAttempts)).length;
    await revokeEditorMembership();
    await assert.rejects(
      () => service.retry(
        revokedEditorActor,
        revokedRetrySubmission.requestId,
        "revoked-retry-key",
        revokedRetryQuote.id,
        "web",
      ),
      (error: unknown) => hasCode(error, "GENERATION_QUOTE_NOT_FOUND"),
    );
    assert.equal(
      (await db.select({ id: generationRequests.id }).from(generationRequests)).length,
      requestCountBeforeRevokedRetry,
      "revoked retry must not create a generation request",
    );
    assert.equal(
      (await db.select({ id: generationAttempts.id }).from(generationAttempts)).length,
      attemptCountBeforeRevokedRetry,
      "revoked retry must not create an attempt",
    );
    const [revokedRetryQuoteAfter] = await db.select({ status: generationQuotes.status })
      .from(generationQuotes)
      .where(eq(generationQuotes.id, revokedRetryQuote.id));
    assert.equal(revokedRetryQuoteAfter?.status, "confirmed");
    assert.equal(providerCalls, 0, "rejected retry must not invoke the provider");
    const mismatchInput = generationInput(ids, "mismatch");
    const mismatchQuote = await confirmedQuote(service, ownerActor, mismatchInput);
    await assert.rejects(
      () => service.submit(
        ownerActor,
        { ...mismatchInput, prompt: "被替换的提示词" },
        mismatchQuote.id,
        "web",
      ),
      (error: unknown) => hasCode(error, "GENERATION_QUOTE_CONFLICT"),
    );

    const expiredInput = generationInput(ids, "expired");
    const expiredQuote = await confirmedQuote(service, ownerActor, expiredInput);
    await db.update(generationQuotes).set({
      createdAt: new Date(now.getTime() - 20 * 60_000),
      expiresAt: new Date(now.getTime() - 10 * 60_000),
    }).where(eq(generationQuotes.id, expiredQuote.id));
    await assert.rejects(
      () => service.submit(ownerActor, expiredInput, expiredQuote.id, "web"),
      (error: unknown) => hasCode(error, "GENERATION_QUOTE_EXPIRED"),
    );

    const driftInput = generationInput(ids, "price-drift");
    const driftQuote = await confirmedQuote(service, ownerActor, driftInput);
    await db.update(pricingRules).set({ unitPriceFen: 61, updatedAt: new Date() })
      .where(eq(pricingRules.id, ids.price));
    await assert.rejects(
      () => service.submit(ownerActor, driftInput, driftQuote.id, "web"),
      (error: unknown) => hasCode(error, "quote_stale"),
    );
    const [stillConfirmed] = await db.select().from(generationQuotes)
      .where(eq(generationQuotes.id, driftQuote.id));
    assert.equal(stillConfirmed?.status, "confirmed");
    await db.update(pricingRules).set({ unitPriceFen: 60, updatedAt: new Date() })
      .where(eq(pricingRules.id, ids.price));

    const concurrentInput = generationInput(ids, "concurrent");
    const concurrentQuote = await confirmedQuote(service, ownerActor, concurrentInput);
    const [first, replay] = await Promise.all([
      service.submit(ownerActor, concurrentInput, concurrentQuote.id, "web"),
      service.submit(
        ownerActor,
        { ...concurrentInput, clientIdempotencyKey: "concurrent-replay-key" },
        concurrentQuote.id,
        "web",
      ),
    ]);
    assert.equal(replay.attemptId, first.attemptId);
    const boundAttempts = await db.select().from(generationAttempts)
      .where(eq(generationAttempts.requestId, first.requestId));
    assert.equal(boundAttempts.length, 1);
    await assert.rejects(
      () => service.submit(
        ownerActor,
        { ...concurrentInput, prompt: "不同输入", clientIdempotencyKey: "concurrent-different" },
        concurrentQuote.id,
        "web",
      ),
      (error: unknown) => hasCode(error, "GENERATION_QUOTE_CONFLICT"),
    );

    await repository.cancelForActor(ids.owner, first.requestId);
    const retryQuoteOne = await service.quoteRetry(ownerActor, first.requestId, "web");
    const retryQuoteTwo = await service.quoteRetry(ownerActor, first.requestId, "cli");
    await service.confirmQuote(ownerActor, retryQuoteOne.id);
    await service.confirmQuote(ownerActor, retryQuoteTwo.id);
    assert.equal(retryQuoteOne.baseAttemptId, first.attemptId);
    assert.equal(retryQuoteTwo.baseAttemptId, first.attemptId);

    const retried = await service.retry(ownerActor, first.requestId, "retry-first-key", retryQuoteOne.id, "web");
    const retriedReplay = await service.retry(ownerActor, first.requestId, "retry-replay-key", retryQuoteOne.id, "web");
    assert.equal(retriedReplay.attemptId, retried.attemptId);
    await assert.rejects(
      () => service.retry(
        ownerActor,
        first.requestId,
        "retry-second-key",
        retryQuoteTwo.id,
        "cli",
      ),
      (error: unknown) => hasCode(error, "quote_stale"),
    );

    const userRequests = await db.select().from(generationRequests)
      .where(eq(generationRequests.userId, ids.owner));
    const concurrentRequest = userRequests.find((item) => item.id === first.requestId);
    assert.ok(concurrentRequest);
    const attempts = await db.select().from(generationAttempts)
      .where(eq(generationAttempts.requestId, first.requestId));
    assert.equal(attempts.length, 2);

    // v1.9 十.6：单发/重试提交时只绑定报价、成功才消费（成功 → consumed，
    // 失败/取消 → voided 不扣费）。该并发报价在下方 cancelForActor 里随
    // 被取消的 attempt 作废，终态是 voided 而不是 consumed——断言作废且
    // 只作废一次，证明重复提交没有多占一份可扣费状态。
    const voided = await db.select().from(generationQuotes).where(and(
      eq(generationQuotes.id, concurrentQuote.id),
      eq(generationQuotes.status, "voided"),
    ));
    assert.equal(voided.length, 1);

    app = await createApp({ databaseHandle: handle, logger: false, startGenerationWorker: false });
    appForRequest = app;
    const simpleEstimate = await api("POST", "/api/v1/generations/estimate", apiToken, {
      media_kind: "image",
      tier_id: "img-seedream5pro-169-2k-1",
      parameters: {},
      quantity: 1,
    });
    assert.equal(simpleEstimate.statusCode, 200, simpleEstimate.body);
    assert.equal(apiData(simpleEstimate).generation_quote_id, null);

    const apiInput = {
      media_kind: "image",
      tier_id: "img-seedream5pro-169-2k-1",
      project_id: ids.project,
      episode_id: ids.episode,
      shot_id: ids.shot,
      prompt: "接口报价生成测试",
      reference_media_ids: [],
      parameters: {},
      quantity: 1,
      client_idempotency_key: "api-quote-submit",
      source: "web",
    };
    const spoofedSource = await api("POST", "/api/v1/generations/estimate", apiToken, {
      ...apiInput,
      source: "cli",
    });
    assert.equal(spoofedSource.statusCode, 200, spoofedSource.body);
    assert.equal(apiData(spoofedSource).source, "web", "body source cannot override the bearer credential source");
    const apiEstimate = await api("POST", "/api/v1/generations/estimate", apiToken, apiInput);
    assert.equal(apiEstimate.statusCode, 200, apiEstimate.body);
    const apiQuoteId = apiData(apiEstimate).generation_quote_id;
    assert.equal(typeof apiQuoteId, "string");
    assert.equal(apiData(apiEstimate).status, "pending_confirmation");

    const missingQuote = await api("POST", "/api/v1/generations", apiToken, apiInput);
    assert.equal(missingQuote.statusCode, 400, missingQuote.body);
    const confirmedResponse = await api(
      "POST",
      `/api/v1/generation-quotes/${apiQuoteId as string}/confirm`,
      apiToken,
    );
    assert.equal(apiData(confirmedResponse).status, "confirmed");
    const submittedResponse = await api("POST", "/api/v1/generations", apiToken, {
      ...apiInput,
      generation_quote_id: apiQuoteId,
    });
    assert.equal(submittedResponse.statusCode, 202, submittedResponse.body);
    assert.equal(apiData(submittedResponse).status, "pending");
  } finally {
    await app?.close();
    appForRequest = undefined;
    await handle.pool.end();
  }
});

function generationInput(
  ids: { project: string; episode: string; shot: string },
  key: string,
): SubmitGenerationInput {
  return {
    projectId: ids.project,
    episodeId: ids.episode,
    shotId: ids.shot,
    mediaKind: "image",
    tierId: "img-seedream5pro-169-2k-1",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    prompt: "一名角色站在雨夜街头",
    parameters: {},
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    quantity: 1,
    clientIdempotencyKey: key.padEnd(8, "-"),
  };
}

async function confirmedQuote(
  service: GenerationService,
  actor: ScopedGenerationActor,
  input: SubmitGenerationInput,
) {
  const quote = await service.quoteSubmission(actor, input, "web");
  return service.confirmQuote(actor, quote.id);
}

function userValues(id: string, username: string, now: Date) {
  return {
    id,
    username: `${username}-${id.slice(0, 6)}`,
    displayName: username,
    passwordHash: "test-only-hash",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

function priceValues(id: string, unitPriceFen: number, now: Date) {
  return {
    id,
    provider: "ark",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen,
    currency: "CNY",
    source: "generation-quote-db-test",
    active: true,
    effectiveFrom: new Date(now.getTime() - 60_000),
    effectiveTo: null,
    metadata: {
      test_only: true,
      price_source_kind: "实测",
      capability_tier: {
        tier_id: "img-seedream5pro-169-2k-1",
        params: {
          resolution: "2K",
          aspect_ratio: "16:9",
          quantity: 1,
          watermark: false,
          sequential_image_generation: "disabled",
        },
        status: "active",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function videoPriceValues(id: string, now: Date) {
  return {
    id,
    provider: "ark",
    model: ARK_SEEDANCE_2_FAST_MODEL,
    mediaKind: "video" as const,
    billingUnit: "second",
    unitPriceFen: 80,
    currency: "CNY",
    source: "generation-quote-db-test",
    active: true,
    effectiveFrom: new Date(now.getTime() - 60_000),
    effectiveTo: null,
    // No explicit assertion: this price cannot be reused for video-reference input.
    metadata: {
      test_only: true,
      price_source_kind: "实测",
      capability_tier: {
        tier_id: "vid-seedance20fast-916-720p-4s",
        params: {
          resolution: "720p",
          aspect_ratio: "9:16",
          duration_seconds: 4,
          quantity: 1,
          watermark: false,
          generate_audio: true,
        },
        status: "active",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function videoGenerationInput(
  ids: { project: string; episode: string; shot: string; videoReferenceMedia: string },
  key: string,
): SubmitGenerationInput {
  return {
    projectId: ids.project,
    episodeId: ids.episode,
    shotId: ids.shot,
    mediaKind: "video",
    tierId: "vid-seedance20fast-916-720p-4s",
    model: ARK_SEEDANCE_2_FAST_MODEL,
    prompt: "动作和运镜参考测试",
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
    referenceMediaIds: [ids.videoReferenceMedia],
    referenceAssetSnapshots: [{
      kind: "video",
      mediaId: ids.videoReferenceMedia,
      url: `asset://${videoReferenceRemoteAssetId(ids.videoReferenceMedia)}`,
      role: "reference_video",
    }],
    quantity: 1,
    clientIdempotencyKey: key.padEnd(8, "-"),
  };
}

function videoReferenceRemoteAssetId(mediaId: string): string {
  return `Asset-generation-quotes-${mediaId}`;
}

function legacyAssetValues(id: string, ownerUserId: string, now: Date) {
  return {
    id,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId,
    visibility: "personal",
    assetKind: "reference",
    role: null,
    usageMode: null,
    name: "历史导演台素模",
    displayName: "历史导演台素模",
    intro: null,
    appearance: null,
    ageValue: null,
    gender: null,
    heightCm: null,
    hairDescription: null,
    outfitDescription: null,
    category: null,
    styleTags: [],
    approved: true,
    reuseScope: "all_projects",
    status: "approved",
    sourceFileUrl: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function legacy3dMediaValues(id: string, assetEntityId: string, now: Date) {
  return {
    id,
    assetEntityId,
    assetVariantId: null,
    mediaKind: "image",
    viewAngle: null,
    title: "旧版误分类素模",
    description: null,
    storageBucket: "quote-test-bucket",
    storagePath: "director/proxy/object",
    storageUrl: "https://assets.test/signed-proxy/no-extension",
    widthPx: null,
    heightPx: null,
    format: null,
    sha256: "1".repeat(64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata: { mime_type: "model/gltf-binary" },
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function videoReferenceMediaValues(id: string, assetEntityId: string, now: Date) {
  return {
    id,
    assetEntityId,
    assetVariantId: null,
    mediaKind: "video",
    viewAngle: null,
    title: "视频参考定价夹具",
    description: null,
    storageBucket: "quote-test-bucket",
    storagePath: `references/${id}.mp4`,
    storageUrl: "https://media.example.com/action-reference.mp4",
    widthPx: 1280,
    heightPx: 720,
    format: "mp4",
    sha256: "2".repeat(64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata: {},
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof GenerationError && error.code === code;
}

function api(method: string, url: string, token: string, body?: unknown) {
  if (!appForRequest) throw new Error("API test app is not ready");
  return appForRequest.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

let appForRequest: Awaited<ReturnType<typeof createApp>> | undefined;

function apiData(response: { json(): unknown }): Record<string, unknown> {
  const body = response.json() as { ok?: boolean; data?: unknown };
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.ok(body.data && typeof body.data === "object");
  return body.data as Record<string, unknown>;
}
