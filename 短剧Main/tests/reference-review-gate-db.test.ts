import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import {
  assetEntities,
  assetMedia,
  episodes,
  generationAttemptNotifications,
  generationAttempts,
  generationQuotes,
  generationRequests,
  pricingRules,
  projectAssetRefs,
  projects,
  sessions,
  shots,
  userCreditAccounts,
  users,
} from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrate.js";
import { hashSessionToken } from "../src/modules/auth/service.js";
import { ControlPackageRepository } from "../src/modules/control-packages/repository.js";
import { GenerationError } from "../src/modules/generation/errors.js";
import { PostgresGenerationRepository } from "../src/modules/generation/repository.js";
import { GenerationService } from "../src/modules/generation/service.js";
import type { SubmitGenerationInput } from "../src/modules/generation/types.js";
import { ARK_SEEDREAM_5_PRO_MODEL } from "../src/modules/generation/v01Contract.js";
import {
  errorBody,
  knownDatabaseBusinessError,
  NotFoundError,
  UnprocessableEntityError,
} from "../src/shared/errors.js";

const databaseUrl = process.env.REFERENCE_REVIEW_GATE_TEST_DATABASE_URL;
const pre050Migrations = process.env.REFERENCE_REVIEW_GATE_PRE_050_MIGRATIONS_DIR;
const migration050Directory = process.env.REFERENCE_REVIEW_GATE_050_MIGRATIONS_DIR;

test("未过审通用资产不能进入控制包或付费生成，个人资产继续免审", {
  skip: !databaseUrl,
}, async () => {
  const handle = createDatabase(databaseUrl);
  const db = handle.db;
  const now = new Date();
  assert.ok(pre050Migrations, "真 PG runner 必须提供 001-049 的迁移目录");
  assert.ok(migration050Directory, "真 PG runner 必须提供只含 050 的迁移目录");
  await runMigrations(handle, pre050Migrations);

  const legacy = {
    owner: randomUUID(),
    project: randomUUID(),
    asset: randomUUID(),
    request: randomUUID(),
    attempt: randomUUID(),
  };
  // users 同理:夹具停在 049,而当前 Drizzle users 投影已带 060 的 ui_mode
  // (带库默认值,insert 会写成 default 列),049 时代的表没有这一列。
  await db.execute(sql`
    INSERT INTO ${users} (
      id,
      username,
      display_name,
      password_hash,
      active,
      role,
      created_at,
      updated_at
    ) VALUES (
      ${legacy.owner},
      ${`reference-legacy-${legacy.owner.slice(0, 8)}`},
      ${"历史提交收口测试用户"},
      ${"test-only-hash"},
      ${true},
      ${"member"},
      ${now},
      ${now}
    )
  `);
  // This fixture deliberately stops at migration 049. Use its historical
  // column set instead of the current Drizzle table projection, which already
  // includes the project-generation columns introduced by migration 054.
  await db.execute(sql`
    INSERT INTO ${projects} (
      id,
      owner_user_id,
      name,
      description,
      status,
      created_at,
      updated_at,
      deleted_at,
      deleted_by_user_id
    ) VALUES (
      ${legacy.project},
      ${legacy.owner},
      ${"历史提交收口测试项目"},
      ${null},
      ${"active"},
      ${now},
      ${now},
      ${null},
      ${null}
    )
  `);
  await db.insert(assetEntities).values(
    assetValues(legacy.asset, null, "common", "历史提交目标资产", "approved", now),
  );
  // 夹具停在 049,而当前 Drizzle generationRequests 投影已带 069 的
  // target_asset_variant_id——049 时代的表没有这一列。沿用 users/projects
  // 的历史列集 raw SQL,显式只写 049 时代就存在的列。
  await db.execute(sql`
    INSERT INTO ${generationRequests} (
      id,
      user_id,
      project_id,
      episode_id,
      scene_id,
      shot_id,
      target_asset_entity_id,
      media_kind,
      prompt,
      reference_media_ids,
      reference_asset_snapshots,
      parameters,
      quantity,
      client_idempotency_key,
      request_hash,
      charged_points,
      created_at,
      updated_at
    ) VALUES (
      ${legacy.request},
      ${legacy.owner},
      ${legacy.project},
      ${null},
      ${null},
      ${null},
      ${legacy.asset},
      ${"image"},
      ${"历史提交收口"},
      ${"[]"},
      ${"[]"},
      ${"{}"},
      ${1},
      ${"reference-review-legacy-attempt"},
      ${"a".repeat(64)},
      ${0},
      ${now},
      ${now}
    )
  `);
  await db.insert(generationAttempts).values({
    id: legacy.attempt,
    requestId: legacy.request,
    attemptNo: 1,
    retryIdempotencyKey: null,
    provider: "ark",
    providerTaskId: null,
    model: ARK_SEEDREAM_5_PRO_MODEL,
    parameters: {},
    quantity: 1,
    status: "running",
    phase: "submitting",
    providerStatus: null,
    providerResponse: null,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    estimatedCostFen: 0,
    actualCostFen: null,
    actualCostStatus: "unavailable",
    pricingRuleId: null,
    priceSnapshot: {},
    lastQueryError: null,
    nextPollAt: now,
    lastPolledAt: null,
    leaseOwner: "legacy-dead-worker",
    leaseUntil: new Date(now.getTime() + 60 * 60_000),
    submittedAt: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  assert.deepEqual(
    await runMigrations(handle, migration050Directory),
    ["050_reference_review_paid_submission_guard.sql"],
    "050 必须在真实 001-049 历史库上单独前向执行",
  );
  const reconciledLegacyAttempt = (await db.select({
    status: generationAttempts.status,
    phase: generationAttempts.phase,
    errorCode: generationAttempts.errorCode,
    retryable: generationAttempts.retryable,
    leaseOwner: generationAttempts.leaseOwner,
    leaseUntil: generationAttempts.leaseUntil,
    nextPollAt: generationAttempts.nextPollAt,
    finishedAt: generationAttempts.finishedAt,
  }).from(generationAttempts).where(eq(generationAttempts.id, legacy.attempt)).limit(1))[0];
  assert.deepEqual({
    ...reconciledLegacyAttempt,
    finishedAt: undefined,
  }, {
    status: "failed",
    phase: "submitting",
    errorCode: "SUBMISSION_OUTCOME_UNKNOWN",
    retryable: false,
    leaseOwner: null,
    leaseUntil: null,
    nextPollAt: null,
    finishedAt: undefined,
  }, "不可恢复的历史 submitting 必须保留未知结果事实并释放永久冻结");
  assert.ok(reconciledLegacyAttempt?.finishedAt instanceof Date);
  assert.equal((await db.select({ id: generationAttemptNotifications.id })
    .from(generationAttemptNotifications)
    .where(eq(generationAttemptNotifications.attemptId, legacy.attempt))
    .limit(1)).length, 1, "历史未知提交必须给所有者留下站内终态提醒");
  assert.deepEqual(await runMigrations(handle, migration050Directory), [], "050 重放必须 no-op");
  await runMigrations(handle);

  const ids = {
    owner: randomUUID(),
    other: randomUUID(),
    project: randomUUID(),
    episode: randomUUID(),
    shot: randomUUID(),
    session: randomUUID(),
    pricingRule: randomUUID(),
    approvedAsset: randomUUID(),
    approvedMedia: randomUUID(),
    automaticAsset: randomUUID(),
    automaticMedia: randomUUID(),
    pendingAsset: randomUUID(),
    pendingMedia: randomUUID(),
    rejectedAsset: randomUUID(),
    rejectedMedia: randomUUID(),
    unknownAsset: randomUUID(),
    unknownMedia: randomUUID(),
    hiddenCommonAsset: randomUUID(),
    hiddenCommonMedia: randomUUID(),
    hiddenAsset: randomUUID(),
    hiddenMedia: randomUUID(),
    racingAsset: randomUUID(),
    racingMedia: randomUUID(),
    personalAsset: randomUUID(),
    personalMedia: randomUUID(),
    delegatedAsset: randomUUID(),
    delegatedMedia: randomUUID(),
  };
  const token = `reference-review-gate-${randomUUID()}`;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await db.insert(users).values({
      id: ids.owner,
      username: `reference-gate-${ids.owner.slice(0, 8)}`,
      displayName: "参考门禁测试用户",
      passwordHash: "test-only-hash",
      active: true,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(users).values({
      id: ids.other,
      username: `reference-other-${ids.other.slice(0, 8)}`,
      displayName: "并发变更测试用户",
      passwordHash: "test-only-hash",
      active: true,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });
    await db.update(userCreditAccounts).set({
      balancePoints: 50_000_000,
      dailyLimitPoints: 50_000_000,
      updatedAt: now,
    }).where(eq(userCreditAccounts.userId, ids.owner));
    await db.insert(sessions).values({
      id: ids.session,
      userId: ids.owner,
      tokenHash: hashSessionToken(token),
      credentialSource: "web",
      agentType: null,
      userAgent: "reference-review-gate-db-test",
      credentialLabel: null,
      issuedBySessionId: null,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      revokedAt: null,
      createdAt: now,
    });
    await db.insert(projects).values({
      id: ids.project,
      ownerUserId: ids.owner,
      name: "未过审资产生产门禁",
      description: null,
      status: "active",
      defaultRatio: "16:9",
      defaultImageResolution: "2K",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await db.insert(episodes).values({
      id: ids.episode,
      projectId: ids.project,
      episodeNo: 1,
      name: "第一集",
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
      shotCode: "P28-001",
      title: "未过审资产门禁分镜",
      scriptText: null,
      directorPrompt: null,
      imagePrompt: "雨夜主角站在街口",
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
    await db.insert(assetEntities).values([
      assetValues(ids.approvedAsset, null, "common", "已通过主角", "approved", now),
      assetValues(ids.automaticAsset, null, "common", "自动审核主角", "automatic_review", now),
      assetValues(ids.pendingAsset, null, "common", "待审核主角", "pending_review", now),
      assetValues(ids.rejectedAsset, null, "common", "已拒绝主角", "rejected", now),
      assetValues(ids.unknownAsset, null, "common", "异常状态主角", "legacy_unknown", now),
      assetValues(ids.hiddenCommonAsset, null, "common", "未公开通用探测目标", "pending_review", now),
      assetValues(ids.hiddenAsset, ids.other, "personal", "未公开探测目标", "pending_review", now),
      assetValues(ids.racingAsset, ids.other, "common", "并发改域主角", "approved", now),
      assetValues(ids.personalAsset, ids.owner, "personal", "个人免审主角", "pending_review", now),
      assetValues(ids.delegatedAsset, ids.other, "personal", "项目授权个人主角", "pending_review", now),
    ]);
    await db.insert(assetMedia).values([
      mediaValues(ids.approvedMedia, ids.approvedAsset, now),
      mediaValues(ids.automaticMedia, ids.automaticAsset, now),
      mediaValues(ids.pendingMedia, ids.pendingAsset, now),
      mediaValues(ids.rejectedMedia, ids.rejectedAsset, now),
      mediaValues(ids.unknownMedia, ids.unknownAsset, now),
      mediaValues(ids.hiddenCommonMedia, ids.hiddenCommonAsset, now),
      mediaValues(ids.hiddenMedia, ids.hiddenAsset, now),
      mediaValues(ids.racingMedia, ids.racingAsset, now),
      mediaValues(ids.personalMedia, ids.personalAsset, now),
      mediaValues(ids.delegatedMedia, ids.delegatedAsset, now),
    ]);
    const delegatedProjectRef = projectRefValues(
      ids.project,
      ids.delegatedAsset,
      ids.delegatedMedia,
      ids.owner,
      now,
    );
    await db.insert(projectAssetRefs).values([
      projectRefValues(ids.project, ids.approvedAsset, ids.approvedMedia, ids.owner, now),
      projectRefValues(ids.project, ids.automaticAsset, ids.automaticMedia, ids.owner, now),
      projectRefValues(ids.project, ids.pendingAsset, ids.pendingMedia, ids.owner, now),
      projectRefValues(ids.project, ids.rejectedAsset, ids.rejectedMedia, ids.owner, now),
      projectRefValues(ids.project, ids.unknownAsset, ids.unknownMedia, ids.owner, now),
      delegatedProjectRef,
    ]);
    await db.insert(pricingRules).values(priceValues(ids.pricingRule, now));

    const controlPackages = new ControlPackageRepository(db);
    for (const blocked of [
      {
        entityId: ids.automaticAsset,
        mediaId: ids.automaticMedia,
        name: "自动审核主角",
        rawStatus: "automatic_review",
        status: "自动审核中",
      },
      {
        entityId: ids.pendingAsset,
        mediaId: ids.pendingMedia,
        name: "待审核主角",
        rawStatus: "pending_review",
        status: "待审核",
      },
      {
        entityId: ids.rejectedAsset,
        mediaId: ids.rejectedMedia,
        name: "已拒绝主角",
        rawStatus: "rejected",
        status: "已拒绝",
      },
      {
        entityId: ids.unknownAsset,
        mediaId: ids.unknownMedia,
        name: "异常状态主角",
        rawStatus: "legacy_unknown",
        status: "状态异常",
      },
    ]) {
      await assert.rejects(
        () => controlPackages.addRef(ids.owner, ids.shot, {
          lane: "prop",
          assetMediaId: blocked.mediaId,
        }),
        (error: unknown) => {
          if (!(error instanceof UnprocessableEntityError)) return false;
          assert.deepEqual(errorBody(error).details, {
            kind: "reference_asset_review_required",
            asset_entity_id: blocked.entityId,
            asset_media_id: blocked.mediaId,
            asset_name: blocked.name,
            review_status: blocked.rawStatus,
            review_status_label: blocked.status,
            destination: "参考控制包",
            display_message: error.message,
          });
          return error.statusCode === 422
            && error.message.includes(blocked.name)
            && error.message.includes(blocked.status);
        },
        `${blocked.status}的通用资产必须在控制包事务内被中文 422 拦下`,
      );
    }
    assert.equal((await controlPackages.addRef(ids.owner, ids.shot, {
      lane: "prop",
      assetMediaId: ids.approvedMedia,
    })).mediaId, ids.approvedMedia);
    assert.equal((await controlPackages.addRef(ids.owner, ids.shot, {
      lane: "prop",
      assetMediaId: ids.personalMedia,
    })).mediaId, ids.personalMedia, "个人资产不受通用资产审核态门禁影响");

    const racingHandle = createDatabase(databaseUrl);
    let releaseVisibilityChange!: () => void;
    let visibilityChangeReady!: () => void;
    const releaseVisibilityChangePromise = new Promise<void>((resolve) => {
      releaseVisibilityChange = resolve;
    });
    const visibilityChangeReadyPromise = new Promise<void>((resolve) => {
      visibilityChangeReady = resolve;
    });
    try {
      const visibilityChange = racingHandle.db.transaction(async (transaction) => {
        await transaction.update(assetEntities).set({
          visibility: "personal",
          ownerUserId: ids.other,
          updatedAt: new Date(),
        }).where(eq(assetEntities.id, ids.racingAsset));
        visibilityChangeReady();
        await releaseVisibilityChangePromise;
      });
      await visibilityChangeReadyPromise;
      let addRefSettled = false;
      const addRefOutcome = controlPackages.addRef(ids.owner, ids.shot, {
        lane: "prop",
        assetMediaId: ids.racingMedia,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => {
        addRefSettled = true;
      });
      await delay(50);
      assert.equal(addRefSettled, false, "控制包写入必须等待正在变化的实体事实，而不是使用旧快照");
      releaseVisibilityChange();
      await visibilityChange;
      const addRefResult = await addRefOutcome;
      assert.equal(addRefResult.ok, false);
      assert.ok(!addRefResult.ok && addRefResult.error instanceof NotFoundError,
        "common → 他人 personal 提交后必须重新校验访问权并拒绝");
    } finally {
      releaseVisibilityChange();
      await racingHandle.pool.end();
    }

    app = await createApp({
      databaseHandle: handle,
      logger: false,
      startGenerationWorker: false,
      startAssetUploadWorker: false,
      startTrashRetentionWorker: false,
    });
    const pendingControlRef = await app.inject({
      method: "POST",
      url: `/api/v1/shots/${ids.shot}/control-package/refs`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        lane: "prop",
        asset_media_id: ids.pendingMedia,
      }),
    });
    assert.equal(pendingControlRef.statusCode, 422, pendingControlRef.body);
    assertReviewHttpError(
      pendingControlRef,
      "unprocessable_entity",
      ids.pendingAsset,
      ids.pendingMedia,
      "待审核主角",
      "pending_review",
      "待审核",
      "参考控制包",
    );
    const hiddenCommonControlRef = await app.inject({
      method: "POST",
      url: `/api/v1/shots/${ids.shot}/control-package/refs`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        lane: "prop",
        asset_media_id: ids.hiddenCommonMedia,
      }),
    });
    assert.equal(hiddenCommonControlRef.statusCode, 404, hiddenCommonControlRef.body);
    assertHiddenAssetNotDisclosed(hiddenCommonControlRef, "未公开通用探测目标");
    const hiddenControlRef = await app.inject({
      method: "POST",
      url: `/api/v1/shots/${ids.shot}/control-package/refs`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        lane: "prop",
        asset_media_id: ids.hiddenMedia,
      }),
    });
    assert.equal(hiddenControlRef.statusCode, 404, hiddenControlRef.body);
    assertHiddenAssetNotDisclosed(hiddenControlRef, "未公开探测目标");

    const quoteCountBeforeHttpRejection = (await db.select({ id: generationQuotes.id })
      .from(generationQuotes)).length;
    const pendingEstimate = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(httpEstimateBody(ids, ids.pendingMedia, "http-pending-reference")),
    });
    assert.equal(pendingEstimate.statusCode, 422, pendingEstimate.body);
    const pendingError = pendingEstimate.json() as {
      ok: boolean;
      error: { code: string; message: string; details: unknown };
    };
    assert.equal(pendingError.ok, false);
    assert.equal(pendingError.error.code, "control_asset_invalid_usage");
    assert.match(pendingError.error.message, /待审核主角/);
    assert.match(pendingError.error.message, /待审核/);
    assert.deepEqual(pendingError.error.details, {
      kind: "reference_asset_review_required",
      asset_entity_id: ids.pendingAsset,
      asset_media_id: ids.pendingMedia,
      asset_name: "待审核主角",
      review_status: "pending_review",
      review_status_label: "待审核",
      destination: "付费生成",
      display_message: pendingError.error.message,
    });
    assert.equal((await db.select({ id: generationQuotes.id }).from(generationQuotes)).length,
      quoteCountBeforeHttpRejection, "HTTP 拒绝不得创建报价");
    const hiddenCommonEstimate = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(
        httpEstimateBody(ids, ids.hiddenCommonMedia, "http-hidden-common-reference"),
      ),
    });
    assert.equal(hiddenCommonEstimate.statusCode, 403, hiddenCommonEstimate.body);
    assertHiddenAssetNotDisclosed(hiddenCommonEstimate, "未公开通用探测目标");
    const hiddenEstimate = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(httpEstimateBody(ids, ids.hiddenMedia, "http-hidden-reference")),
    });
    assert.equal(hiddenEstimate.statusCode, 403, hiddenEstimate.body);
    assertHiddenAssetNotDisclosed(hiddenEstimate, "未公开探测目标");
    assert.equal((await db.select({ id: generationQuotes.id }).from(generationQuotes)).length,
      quoteCountBeforeHttpRejection, "无权探测未公开资产也不得创建报价");

    const pendingBatchEstimate = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-estimate",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        production_mode: "full",
        items: [{
          item_id: "pending-reference",
          ...httpEstimateBody(ids, ids.pendingMedia, "batch-pending-reference"),
        }],
      }),
    });
    assert.equal(pendingBatchEstimate.statusCode, 200, pendingBatchEstimate.body);
    const pendingBatchItem = (responseData(pendingBatchEstimate).items as Array<{
      error?: Record<string, unknown>;
    }>)[0];
    assert.equal(pendingBatchItem?.error?.status_code, 422);
    assert.deepEqual(pendingBatchItem?.error?.details, pendingError.error.details);

    const httpDriftInput = httpEstimateBody(ids, ids.approvedMedia, "http-approved-then-drift");
    const approvedEstimate = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(httpDriftInput),
    });
    assert.equal(approvedEstimate.statusCode, 200, approvedEstimate.body);
    const approvedQuoteId = responseData(approvedEstimate).generation_quote_id;
    assert.equal(typeof approvedQuoteId, "string");
    const approvedConfirmation = await app.inject({
      method: "POST",
      url: `/api/v1/generation-quotes/${approvedQuoteId as string}/confirm`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(approvedConfirmation.statusCode, 200, approvedConfirmation.body);
    await db.update(assetEntities).set({
      status: "pending_review",
      approved: false,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.approvedAsset));
    const requestsBeforeHttpDriftSubmit = (await db.select({ id: generationRequests.id })
      .from(generationRequests)).length;
    const attemptsBeforeHttpDriftSubmit = (await db.select({ id: generationAttempts.id })
      .from(generationAttempts)).length;
    const httpDriftSubmit = await app.inject({
      method: "POST",
      url: "/api/v1/generations",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        ...httpDriftInput,
        generation_quote_id: approvedQuoteId,
      }),
    });
    assert.equal(httpDriftSubmit.statusCode, 422, httpDriftSubmit.body);
    assertReviewHttpError(
      httpDriftSubmit,
      "control_asset_invalid_usage",
      ids.approvedAsset,
      ids.approvedMedia,
      "已通过主角",
      "pending_review",
      "待审核",
      "付费生成",
    );
    assert.equal((await db.select({ id: generationRequests.id }).from(generationRequests)).length,
      requestsBeforeHttpDriftSubmit, "HTTP 提交门禁拒绝不得创建 request");
    assert.equal((await db.select({ id: generationAttempts.id }).from(generationAttempts)).length,
      attemptsBeforeHttpDriftSubmit, "HTTP 提交门禁拒绝不得创建 attempt");
    await db.update(assetEntities).set({
      status: "approved",
      approved: true,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.approvedAsset));

    const batchApprovedInput = httpEstimateBody(ids, ids.approvedMedia, "batch-approved-then-drift");
    const batchEstimate = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-estimate",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        production_mode: "full",
        items: [{
          item_id: "approved-reference",
          ...batchApprovedInput,
        }],
      }),
    });
    assert.equal(batchEstimate.statusCode, 200, batchEstimate.body);
    const batchEstimateItem = (responseData(batchEstimate).items as Array<{
      quote?: Record<string, unknown>;
    }>)[0];
    const batchQuoteId = batchEstimateItem?.quote?.generation_quote_id;
    const batchEstimatedCostFen = batchEstimateItem?.quote?.estimated_cost_fen;
    assert.equal(typeof batchQuoteId, "string");
    assert.equal(typeof batchEstimatedCostFen, "number");
    const batchConfirmation = await app.inject({
      method: "POST",
      url: "/api/v1/generations/batch-confirm",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        project_id: ids.project,
        client_idempotency_key: "reference-gate-batch-confirm",
        expected_total_estimated_cost_fen: batchEstimatedCostFen,
        production_mode: "full",
        items: [{
          item_id: "approved-reference",
          generation_quote_id: batchQuoteId,
        }],
      }),
    });
    assert.equal(batchConfirmation.statusCode, 200, batchConfirmation.body);
    const batchAuthorizationId = responseData(batchConfirmation).authorization_id;
    assert.equal(typeof batchAuthorizationId, "string");
    await db.update(assetEntities).set({
      status: "pending_review",
      approved: false,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.approvedAsset));
    const requestsBeforeBatchDrift = (await db.select({ id: generationRequests.id })
      .from(generationRequests)).length;
    const attemptsBeforeBatchDrift = (await db.select({ id: generationAttempts.id })
      .from(generationAttempts)).length;
    const batchSubmit = await app.inject({
      method: "POST",
      url: `/api/v1/generation-batches/${batchAuthorizationId as string}/submit`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(batchSubmit.statusCode, 202, batchSubmit.body);
    const batchSubmitData = responseData(batchSubmit);
    assert.equal(batchSubmitData.status, "failed");
    const batchFailureItem = (batchSubmitData.items as Array<{
      error?: Record<string, unknown>;
    }>)[0];
    assert.equal(batchFailureItem?.error?.status_code, 422);
    assert.deepEqual(batchFailureItem?.error?.details, {
      kind: "reference_asset_review_required",
      asset_entity_id: ids.approvedAsset,
      asset_media_id: ids.approvedMedia,
      asset_name: "已通过主角",
      review_status: "pending_review",
      review_status_label: "待审核",
      destination: "付费生成",
      display_message: batchFailureItem?.error?.message,
    });
    assert.equal((await db.select({ id: generationRequests.id }).from(generationRequests)).length,
      requestsBeforeBatchDrift, "批量逐项 422 不得创建 request");
    assert.equal((await db.select({ id: generationAttempts.id }).from(generationAttempts)).length,
      attemptsBeforeBatchDrift, "批量逐项 422 不得创建 attempt");
    const batchReplay = await app.inject({
      method: "POST",
      url: `/api/v1/generation-batches/${batchAuthorizationId as string}/submit`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(batchReplay.statusCode, 202, batchReplay.body);
    const batchReplayData = responseData(batchReplay);
    assert.equal(batchReplayData.idempotent_replay, true);
    assert.deepEqual(
      (batchReplayData.items as Array<{ error?: unknown }>)[0]?.error,
      batchFailureItem?.error,
      "批量幂等重放必须保留逐项 422 和前端直显字段",
    );
    await db.update(assetEntities).set({
      status: "approved",
      approved: true,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.approvedAsset));

    let providerCalls = 0;
    const generationRepository = new PostgresGenerationRepository(db, 5_000, true);
    const generationActor = {
      userId: ids.owner,
      authorizedProjectId: ids.project,
    };
    const generation = new GenerationService({
      repository: generationRepository,
      provider: {
        submit: async () => {
          providerCalls += 1;
          throw new Error("真库门禁测试不允许调用付费供应商");
        },
        query: async () => {
          providerCalls += 1;
          throw new Error("真库门禁测试不允许调用付费供应商");
        },
      },
      storage: {
        uploadBytes: async () => {
          throw new Error("真库门禁测试不允许写入对象存储");
        },
      },
      budgetLimitFen: 50_000_000,
    });

    await assert.rejects(
      () => generation.quoteSubmission(
        generationActor,
        generationInput(ids, ids.automaticMedia, "repo-automatic-reference"),
        "web",
      ),
      (error: unknown) => isReviewGateError(error, "自动审核主角", "自动审核中"),
      "绕过 HTTP 直调 service/repository 也必须被当前审核态拦下",
    );

    const driftInput = generationInput(ids, ids.approvedMedia, "approved-then-drift");
    const driftQuote = await generation.quoteSubmission(generationActor, driftInput, "web");
    await generation.confirmQuote(generationActor, driftQuote.id);
    await db.update(assetEntities).set({
      status: "pending_review",
      approved: false,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.approvedAsset));
    const requestsBeforeDriftSubmit = (await db.select({ id: generationRequests.id })
      .from(generationRequests)).length;
    const attemptsBeforeDriftSubmit = (await db.select({ id: generationAttempts.id })
      .from(generationAttempts)).length;
    await assert.rejects(
      () => generation.submit(generationActor, driftInput, driftQuote.id, "web"),
      (error: unknown) => isReviewGateError(error, "已通过主角", "待审核"),
      "报价后降为待审核时，创建付费 attempt 的事务必须重新检查并拒绝",
    );
    assert.equal((await db.select({ id: generationRequests.id }).from(generationRequests)).length,
      requestsBeforeDriftSubmit);
    assert.equal((await db.select({ id: generationAttempts.id }).from(generationAttempts)).length,
      attemptsBeforeDriftSubmit);

    await db.update(assetEntities).set({
      status: "approved",
      approved: true,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.approvedAsset));
    const approvedInput = generationInput(ids, ids.approvedMedia, "approved-production");
    const approvedQuote = await generation.quoteSubmission(generationActor, approvedInput, "web");
    await generation.confirmQuote(generationActor, approvedQuote.id);
    const approvedGeneration = await generation.submit(
      generationActor,
      approvedInput,
      approvedQuote.id,
      "web",
    );
    const workerId = "reference-review-gate-worker";
    assert.equal(
      await generationRepository.claimNextRecoverableAttempt(workerId, 60, true),
      approvedGeneration.attemptId,
    );
    const reviewRaceHandle = createDatabase(databaseUrl);
    let releaseReviewChange!: () => void;
    let reviewChangeReady!: () => void;
    const releaseReviewChangePromise = new Promise<void>((resolve) => {
      releaseReviewChange = resolve;
    });
    const reviewChangeReadyPromise = new Promise<void>((resolve) => {
      reviewChangeReady = resolve;
    });
    try {
      const reviewChange = reviewRaceHandle.db.transaction(async (transaction) => {
        await transaction.update(assetEntities).set({
          status: "rejected",
          approved: false,
          updatedAt: new Date(),
        }).where(eq(assetEntities.id, ids.approvedAsset));
        reviewChangeReady();
        await releaseReviewChangePromise;
      });
      await reviewChangeReadyPromise;
      let workerSettled = false;
      const workerOutcome = generation.runRecoverableAttempt(
        approvedGeneration.attemptId,
        undefined,
        workerId,
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => {
        workerSettled = true;
      });
      await delay(50);
      assert.equal(workerSettled, false,
        "真实 worker 必须等待并发审核事务后复核，不能抢先调用 provider");
      releaseReviewChange();
      await reviewChange;
      const workerResult = await workerOutcome;
      assert.equal(workerResult.ok, true,
        !workerResult.ok && workerResult.error instanceof Error ? workerResult.error.message : undefined);
    } finally {
      releaseReviewChange();
      await reviewRaceHandle.pool.end();
    }
    assert.deepEqual((await db.select({
      status: generationAttempts.status,
      phase: generationAttempts.phase,
      errorCode: generationAttempts.errorCode,
    }).from(generationAttempts).where(eq(generationAttempts.id, approvedGeneration.attemptId))
      .limit(1))[0], {
      status: "failed",
      phase: "complete",
      errorCode: "control_asset_invalid_usage",
    }, "worker 门禁失败必须落确定终态，不能留下可再次领取的 pending attempt");
    assert.equal(providerCalls, 0, "并发审核漂移必须在真实 worker provider 调用前被截断");

    const delegatedInput = generationInput(
      ids,
      ids.delegatedMedia,
      "delegated-reference-revoked",
    );
    const delegatedQuote = await generation.quoteSubmission(generationActor, delegatedInput, "web");
    await generation.confirmQuote(generationActor, delegatedQuote.id);
    const delegatedGeneration = await generation.submit(
      generationActor,
      delegatedInput,
      delegatedQuote.id,
      "web",
    );
    const delegatedWorkerId = "reference-project-ref-worker";
    assert.equal(
      await generationRepository.claimNextRecoverableAttempt(delegatedWorkerId, 60, true),
      delegatedGeneration.attemptId,
    );
    const projectRefRaceHandle = createDatabase(databaseUrl);
    let releaseProjectRefRevocation!: () => void;
    let projectRefRevocationReady!: () => void;
    const releaseProjectRefRevocationPromise = new Promise<void>((resolve) => {
      releaseProjectRefRevocation = resolve;
    });
    const projectRefRevocationReadyPromise = new Promise<void>((resolve) => {
      projectRefRevocationReady = resolve;
    });
    try {
      const projectRefRevocation = projectRefRaceHandle.db.transaction(async (transaction) => {
        await transaction.update(projectAssetRefs).set({
          deletedAt: new Date(),
          deletedByUserId: ids.owner,
        }).where(eq(projectAssetRefs.id, delegatedProjectRef.id));
        projectRefRevocationReady();
        await releaseProjectRefRevocationPromise;
      });
      await projectRefRevocationReadyPromise;
      let delegatedWorkerSettled = false;
      const delegatedWorkerOutcome = generation.runRecoverableAttempt(
        delegatedGeneration.attemptId,
        undefined,
        delegatedWorkerId,
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => {
        delegatedWorkerSettled = true;
      });
      await delay(50);
      assert.equal(
        delegatedWorkerSettled,
        false,
        "真实 worker 必须等待项目素材授权事务，不能按撤销前快照调用 provider",
      );
      releaseProjectRefRevocation();
      await projectRefRevocation;
      const delegatedWorkerResult = await delegatedWorkerOutcome;
      assert.equal(
        delegatedWorkerResult.ok,
        true,
        !delegatedWorkerResult.ok && delegatedWorkerResult.error instanceof Error
          ? delegatedWorkerResult.error.message
          : undefined,
      );
    } finally {
      releaseProjectRefRevocation();
      await projectRefRaceHandle.pool.end();
    }
    assert.deepEqual((await db.select({
      status: generationAttempts.status,
      phase: generationAttempts.phase,
      errorCode: generationAttempts.errorCode,
    }).from(generationAttempts).where(eq(generationAttempts.id, delegatedGeneration.attemptId))
      .limit(1))[0], {
      status: "failed",
      phase: "complete",
      errorCode: "control_asset_invalid_usage",
    }, "项目素材授权撤销后 worker 必须落确定终态，不能留下 lease 或再次领取");
    assert.equal(providerCalls, 0, "项目素材授权撤销必须在真实 worker provider 调用前被截断");

    await db.update(assetEntities).set({
      status: "approved",
      approved: true,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.approvedAsset));
    const windowInput = generationInput(ids, ids.approvedMedia, "approved-window-guard");
    const windowQuote = await generation.quoteSubmission(generationActor, windowInput, "web");
    await generation.confirmQuote(generationActor, windowQuote.id);
    const windowGeneration = await generation.submit(
      generationActor,
      windowInput,
      windowQuote.id,
      "web",
    );
    await generationRepository.markSubmitting(windowGeneration.attemptId);
    assert.deepEqual((await db.select({
      status: generationAttempts.status,
      phase: generationAttempts.phase,
    }).from(generationAttempts).where(eq(generationAttempts.id, windowGeneration.attemptId))
      .limit(1))[0], { status: "running", phase: "submitting" });
    await assert.rejects(
      () => db.update(assetEntities).set({
        status: "rejected",
        approved: false,
        updatedAt: new Date(),
      }).where(eq(assetEntities.id, ids.approvedAsset)),
      (error: unknown) => knownDatabaseBusinessError(error)?.code === "asset_review_change_in_progress",
      "最终复核提交后到 provider 结果落库前，数据库必须阻止通用资产审核态穿窗变化",
    );
    await assert.rejects(
      () => db.update(assetEntities).set({
        visibility: "personal",
        ownerUserId: ids.owner,
        status: "rejected",
        approved: false,
        updatedAt: new Date(),
      }).where(eq(assetEntities.id, ids.approvedAsset)),
      (error: unknown) => knownDatabaseBusinessError(error)?.code === "asset_review_change_in_progress",
      "common 资产不能通过同时改成 personal 来绕过提交窗口冻结",
    );
    assert.equal((await db.select({
      status: assetEntities.status,
    }).from(assetEntities).where(eq(assetEntities.id, ids.approvedAsset)).limit(1))[0]?.status,
    "approved");

    await generationRepository.markProviderAccepted(
      windowGeneration.attemptId,
      "reference-review-gate-provider-task",
      "queued",
    );
    await db.update(assetEntities).set({
      status: "pending_review",
      approved: false,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.approvedAsset));
    assert.equal((await db.select({
      status: assetEntities.status,
    }).from(assetEntities).where(eq(assetEntities.id, ids.approvedAsset)).limit(1))[0]?.status,
    "pending_review", "provider 已确认接单后应释放短窗口审核态冻结");
    await db.update(generationAttempts).set({
      status: "failed",
      phase: "complete",
      errorCode: "REFERENCE_GATE_TEST_FAILURE",
      errorMessage: "用于验证重试门禁",
      retryable: true,
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(generationAttempts.id, windowGeneration.attemptId));
    const quoteCountBeforeRetryRejection = (await db.select({ id: generationQuotes.id })
      .from(generationQuotes)).length;
    await assert.rejects(
      () => generation.quoteRetry(generationActor, windowGeneration.requestId, "web"),
      (error: unknown) => isReviewGateError(error, "已通过主角", "待审核"),
      "人工重试也必须复核当前审核态，不能复用历史 approved 快照",
    );
    assert.equal((await db.select({ id: generationQuotes.id }).from(generationQuotes)).length,
      quoteCountBeforeRetryRejection, "重试门禁拒绝不得创建新报价");

    const personalInput = generationInput(ids, ids.personalMedia, "personal-review-exempt");
    const personalQuote = await generation.quoteSubmission(generationActor, personalInput, "web");
    await generation.confirmQuote(generationActor, personalQuote.id);
    const personalGeneration = await generation.submit(
      generationActor,
      personalInput,
      personalQuote.id,
      "web",
    );
    await generationRepository.markSubmitting(personalGeneration.attemptId);
    assert.deepEqual((await db.select({
      status: generationAttempts.status,
      phase: generationAttempts.phase,
    }).from(generationAttempts).where(eq(generationAttempts.id, personalGeneration.attemptId))
      .limit(1))[0], { status: "running", phase: "submitting" });
    await db.update(assetEntities).set({
      status: "rejected",
      approved: false,
      updatedAt: new Date(),
    }).where(eq(assetEntities.id, ids.personalAsset));
    assert.equal((await db.select({
      status: assetEntities.status,
    }).from(assetEntities).where(eq(assetEntities.id, ids.personalAsset)).limit(1))[0]?.status,
    "rejected", "个人资产在付费提交窗口仍不受通用审核态冻结影响");
    await assert.rejects(
      () => db.update(assetEntities).set({
        visibility: "common",
        updatedAt: new Date(),
      }).where(eq(assetEntities.id, ids.personalAsset)),
      (error: unknown) => knownDatabaseBusinessError(error)?.code === "asset_review_change_in_progress",
      "personal 资产在提交窗口不能跨域成未过审 common 资产",
    );
    assert.equal((await db.select({
      visibility: assetEntities.visibility,
    }).from(assetEntities).where(eq(assetEntities.id, ids.personalAsset)).limit(1))[0]?.visibility,
    "personal");
    assert.equal(providerCalls, 0, "所有验证止于 provider 前，不得触发付费调用");
  } finally {
    await app?.close();
    await handle.pool.end();
  }
});

function assetValues(
  id: string,
  ownerUserId: string | null,
  visibility: "common" | "personal",
  name: string,
  status: string,
  now: Date,
) {
  return {
    id,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId,
    visibility,
    assetKind: "keyframe",
    role: "character_identity",
    usageMode: "reference",
    name,
    displayName: name,
    intro: null,
    appearance: null,
    ageValue: null,
    gender: null,
    heightCm: null,
    hairDescription: null,
    outfitDescription: null,
    category: null,
    styleTags: [],
    approved: status === "approved",
    reuseScope: "all_projects",
    status,
    sourceFileUrl: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function mediaValues(id: string, assetEntityId: string, now: Date) {
  return {
    id,
    assetEntityId,
    assetVariantId: null,
    mediaKind: "image",
    viewAngle: "front",
    title: "参考门禁测试图",
    description: null,
    storageBucket: "reference-review-gate-test",
    storagePath: `assets/${id}.png`,
    storageUrl: mediaUrl(id),
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata: {},
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function projectRefValues(
  projectId: string,
  assetEntityId: string,
  assetMediaId: string,
  createdByUserId: string,
  now: Date,
) {
  return {
    id: randomUUID(),
    projectId,
    assetEntityId,
    assetVariantId: null,
    assetMediaId,
    versionSnapshot: { test_only: true },
    createdByUserId,
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function priceValues(id: string, now: Date) {
  return {
    id,
    provider: "ark",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    mediaKind: "image" as const,
    billingUnit: "image",
    unitPriceFen: 60,
    currency: "CNY",
    source: "reference-review-gate-db-test",
    active: true,
    effectiveFrom: new Date(now.getTime() - 60_000),
    effectiveTo: null,
    metadata: {
      test_only: true,
      price_source_kind: "实测",
      capability_tier: {
        tier_id: "img-seedream5pro-169-2k-1",
        params: {
          aspect_ratio: "16:9",
          resolution: "2K",
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

function generationInput(
  ids: { project: string; episode: string; shot: string },
  mediaId: string,
  key: string,
): SubmitGenerationInput {
  return {
    projectId: ids.project,
    episodeId: ids.episode,
    shotId: ids.shot,
    mediaKind: "image",
    tierId: "img-seedream5pro-169-2k-1",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    prompt: "雨夜主角站在街口",
    parameters: {},
    referenceMediaIds: [mediaId],
    referenceAssetSnapshots: [{
      kind: "image",
      mediaId,
      url: mediaUrl(mediaId),
      role: "reference_image",
    }],
    quantity: 1,
    clientIdempotencyKey: key.padEnd(8, "-"),
  };
}

function httpEstimateBody(
  ids: { project: string; episode: string; shot: string },
  mediaId: string,
  key: string,
) {
  return {
    media_kind: "image",
    tier_id: "img-seedream5pro-169-2k-1",
    project_id: ids.project,
    episode_id: ids.episode,
    shot_id: ids.shot,
    prompt: "雨夜主角站在街口",
    references: [{ media_id: mediaId, usage_mode: "reference" }],
    parameters: {},
    quantity: 1,
    client_idempotency_key: key.padEnd(8, "-"),
  };
}

function mediaUrl(mediaId: string): string {
  return `https://assets.test/reference-review-gate/${mediaId}.png`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isReviewGateError(error: unknown, assetName: string, status: string): boolean {
  return error instanceof GenerationError
    && error.code === "control_asset_invalid_usage"
    && error.statusCode === 422
    && error.message.includes(assetName)
    && error.message.includes(status);
}

function responseData(response: { json(): unknown }): Record<string, unknown> {
  const body = response.json() as { ok?: boolean; data?: unknown };
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.ok(body.data && typeof body.data === "object");
  return body.data as Record<string, unknown>;
}

function assertReviewHttpError(
  response: { json(): unknown },
  code: "unprocessable_entity" | "control_asset_invalid_usage",
  assetEntityId: string,
  assetMediaId: string,
  assetName: string,
  reviewStatus: string,
  reviewStatusLabel: string,
  destination: "参考控制包" | "付费生成",
): void {
  const body = response.json() as {
    ok?: boolean;
    error?: { code?: string; message?: string; details?: unknown };
  };
  assert.equal(body.ok, false, JSON.stringify(body));
  assert.equal(body.error?.code, code);
  assert.equal(typeof body.error?.message, "string");
  assert.match(body.error?.message ?? "", new RegExp(assetName));
  assert.match(body.error?.message ?? "", new RegExp(reviewStatusLabel));
  assert.deepEqual(body.error?.details, {
    kind: "reference_asset_review_required",
    asset_entity_id: assetEntityId,
    asset_media_id: assetMediaId,
    asset_name: assetName,
    review_status: reviewStatus,
    review_status_label: reviewStatusLabel,
    destination,
    display_message: body.error?.message,
  });
}

function assertHiddenAssetNotDisclosed(
  response: { json(): unknown; body: string },
  assetName: string,
): void {
  const body = response.json() as { error?: { details?: unknown } };
  assert.equal(body.error?.details ?? null, null);
  assert.doesNotMatch(response.body, new RegExp(assetName));
}
