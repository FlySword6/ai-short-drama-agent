import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import {
  episodes,
  generationAttempts,
  generationQuotes,
  generationRequests,
  pricingRules,
  projectMembers,
  projects,
  shots,
  users,
} from "../src/db/schema.js";
import { GenerationError } from "../src/modules/generation/errors.js";
import { PostgresGenerationRepository } from "../src/modules/generation/repository.js";
import {
  GenerationService,
  hashLegacyFullGenerationRequest,
  normalizeGenerationInput,
} from "../src/modules/generation/service.js";
import type { SubmitGenerationInput } from "../src/modules/generation/types.js";
import { ARK_SEEDREAM_5_PRO_MODEL } from "../src/modules/generation/v01Contract.js";

const databaseUrl = process.env.S67_GENERATION_ACCOUNTING_TEST_DATABASE_URL;
const schema = settings.postgresSchema;

test("S67 真 PG：项目能力不转移资源所有权、扣费或账本主体", async (t) => {
  assert.ok(databaseUrl, "S67 runner must provide a disposable PostgreSQL URL; this test must never skip");
  assertLocalDatabase(databaseUrl);
  assert.match(schema, /^s67_generation_accounting_[a-z0-9_]+$/);
  const handle = createDatabase(databaseUrl);
  const quoted = quoteIdentifier(schema);
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    await applyMigrations(handle.pool);

    const now = new Date();
    const ids = {
      owner: randomUUID(), member: randomUUID(), project: randomUUID(), episode: randomUUID(),
      shot: randomUUID(), price: randomUUID(), videoPrice: randomUUID(),
    };
    await handle.db.insert(users).values([
      userValue(ids.owner, "s67-owner", now),
      userValue(ids.member, "s67-member", now),
    ]);
    await handle.pool.query(`UPDATE ${quoted}.user_credit_accounts SET balance_points = 100000, daily_limit_points = 100000`);
    await handle.db.insert(projects).values({
      id: ids.project, ownerUserId: ids.owner, name: "S67 accounting", description: null, status: "active", createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(projectMembers).values({
      projectId: ids.project,
      userId: ids.member,
      role: "editor",
      addedByUserId: ids.owner,
      createdAt: now,
    });
    await handle.db.insert(episodes).values({
      id: ids.episode, projectId: ids.project, episodeNo: 1, name: "第 1 集", sortOrder: 1, status: "active", createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(shots).values({
      id: ids.shot, episodeId: ids.episode, sceneId: null, shotCode: "S67-01", title: "主体归属", scriptText: null, directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: null, sortOrder: 1, referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(pricingRules).values(priceValue(ids.price, now));
    await handle.db.insert(pricingRules).values(videoPriceValue(ids.videoPrice, now));

    const repository = new PostgresGenerationRepository(handle.db, 5_000);
    const service = new GenerationService({
      repository,
      provider: { submit: async () => { throw new Error("S67 must not call provider"); }, query: async () => { throw new Error("S67 must not call provider"); } },
      storage: { uploadBytes: async () => { throw new Error("S67 must not upload media"); } },
      budgetLimitFen: 1_000_000,
    });
    const owner = { userId: ids.owner, authorizedProjectId: ids.project };
    const member = { userId: ids.member, authorizedProjectId: ids.project };

    const input = generationInput(ids, "s67-owner-submit");
    const ownerQuote = await service.quoteSubmission(owner, input, "web");
    await t.test("lockQuote：同项目成员不能确认、单发或批量消费他人报价", async () => {
      const beforeForeign = await snapshot(handle.pool, quoted);
      await assertRejectsNotFound(() => service.confirmQuote(member, ownerQuote.id));
      assert.deepEqual(await quoteState(handle.pool, quoted, ownerQuote.id), {
        status: "pending_confirmation",
        confirmed_by_user_id: null,
        generation_request_id: null,
      });
      assert.deepEqual(await snapshot(handle.pool, quoted), beforeForeign, "foreign confirm must not change any paid records");

      await service.confirmQuote(owner, ownerQuote.id);
      await assertRejectsNotFound(() => service.submit(member, input, ownerQuote.id, "web"));
      assert.deepEqual(await snapshot(handle.pool, quoted), beforeForeign, "foreign submit must not charge or create work");

      const ownerBatchInput = generationInput(ids, "s67-owner-batch-foreign");
      const ownerBatchQuote = await service.quoteSubmission(owner, ownerBatchInput, "web");
      const ownerAuthorization = await service.confirmBatch(owner, {
        projectId: ids.project,
        clientIdempotencyKey: "s67-owner-batch",
        expectedTotalEstimatedCostFen: ownerBatchQuote.estimatedCostFen,
        items: [{ itemId: "owner-quote", quoteId: ownerBatchQuote.id }],
      });
      const beforeBatchSubmit = await snapshot(handle.pool, quoted);
      await assertRejectsNotFound(
        () => service.submitBatchAuthorization(member, ownerAuthorization.authorizationId, "web"),
      );
      assert.deepEqual(
        await snapshot(handle.pool, quoted),
        beforeBatchSubmit,
        "foreign batch submit must not charge or create an attempt",
      );
      assert.deepEqual(await quoteState(handle.pool, quoted, ownerBatchQuote.id), {
        status: "confirmed",
        confirmed_by_user_id: ids.owner,
        generation_request_id: null,
      });
    });

    const created = await service.submit(owner, input, ownerQuote.id, "web");
    // v1.9 十.6：提交只绑定报价、不扣费；扣费推迟到成功终态事务。
    const [persistedQuote] = await handle.db.select().from(generationQuotes).where(eq(generationQuotes.id, ownerQuote.id));
    const [request] = await handle.db.select().from(generationRequests).where(eq(generationRequests.id, created.requestId));
    assert.equal(persistedQuote?.userId, ids.owner);
    assert.equal(persistedQuote?.confirmedByUserId, ids.owner);
    assert.equal(request?.userId, ids.owner);
    assert.equal(persistedQuote?.status, "confirmed", "提交后报价保持 confirmed（绑定不消费）");
    assert.equal(persistedQuote?.generationAttemptId, created.attemptId, "报价绑定到本次 attempt");
    const preSuccessLedger = await handle.pool.query<{ points_delta: number }>(
      `SELECT points_delta FROM ${quoted}.user_credit_ledger_entries WHERE source_id = $1`, [ownerQuote.id],
    );
    assert.equal(preSuccessLedger.rows.length, 0, "提交阶段不得产生积分扣减");
    const preSuccessBalances = await handle.pool.query<{ balance_points: number }>(
      `SELECT balance_points FROM ${quoted}.user_credit_accounts WHERE user_id = $1`, [ids.owner],
    );
    assert.equal(preSuccessBalances.rows[0]?.balance_points, 100000, "提交阶段余额不变");


    const secondOwnerInput = generationInput(ids, "s67-owner-inflight-second");
    const secondOwnerQuote = await service.quoteSubmission(owner, secondOwnerInput, "web");
    await service.confirmQuote(owner, secondOwnerQuote.id);
    const secondOwnerTask = await service.submit(owner, secondOwnerInput, secondOwnerQuote.id, "web");
    await t.test("listInFlightViewsForActor：只读提交人自己的跨项目最新在途尝试并接真分页", async () => {
      const firstPage = await repository.listInFlightViewsForActor(ids.owner, 1, 1);
      const secondPage = await repository.listInFlightViewsForActor(ids.owner, 2, 1);
      assert.equal(firstPage.total, 2);
      assert.equal(secondPage.total, 2);
      assert.equal(firstPage.items.length, 1);
      assert.equal(secondPage.items.length, 1);
      assert.deepEqual(
        new Set([...firstPage.items, ...secondPage.items].map((item) => item.requestId)),
        new Set([created.requestId, secondOwnerTask.requestId]),
      );
      assert.ok(
        firstPage.items[0]!.createdAt.getTime() <= secondPage.items[0]!.createdAt.getTime(),
        "current attempts are ordered by longest wait first",
      );
      for (const item of [...firstPage.items, ...secondPage.items]) {
        assert.equal(item.projectId, ids.project);
        assert.equal(item.episodeId, ids.episode);
        assert.equal(item.shotId, ids.shot);
        assert.equal(item.status, "pending");
        assert.equal(item.estimatedDurationSeconds, null, "no real history means no invented ETA");
      }
      const memberPage = await repository.listInFlightViewsForActor(ids.member, 1, 24);
      assert.deepEqual(memberPage, { items: [], page: 1, pageSize: 24, total: 0 });
    });

    await t.test("findViewForActor：同项目成员可以读取项目内生成任务", async () => {
      assert.equal((await repository.findViewForActor(ids.member, created.requestId, ids.project))?.requestId, created.requestId);
      assert.equal((await service.get(member, created.requestId)).requestId, created.requestId);
    });

    await t.test("listAttemptViewsForActor：同项目成员可以列出项目内尝试记录", async () => {
      const attempts = await repository.listAttemptViewsForActor(ids.member, created.requestId, ids.project);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.requestId, created.requestId);
    });

    await t.test("cancelForActor：项目权限不能取消他人已扣费且仍在运行的任务", async () => {
      const beforeRequestWrites = await snapshot(handle.pool, quoted);
      const beforeForeignCancelAttempt = await latestAttemptState(handle.pool, quoted, created.requestId);
      await assertRejectsNotFound(() => repository.cancelForActor(ids.member, created.requestId, ids.project));
      assert.deepEqual(await snapshot(handle.pool, quoted), beforeRequestWrites, "foreign cancel must leave accounts, ledger and work untouched");
      assert.deepEqual(
        await latestAttemptState(handle.pool, quoted, created.requestId),
        beforeForeignCancelAttempt,
        "foreign cancellation must not change latest attempt status, phase or lease",
      );
    });

    await repository.cancelForActor(ids.owner, created.requestId, ids.project);

    await t.test("createRetryQuote：项目权限不能为他人的生成请求创建重试报价", async () => {
      const beforeRetryQuote = await quoteCount(handle.pool, quoted);
      await assertRejectsNotFound(() => service.quoteRetry(member, created.requestId, "web"));
      assert.equal(await quoteCount(handle.pool, quoted), beforeRetryQuote, "foreign retry quote must not be persisted");
    });

    const memberBatchInput = generationInput(ids, "s67-member-batch-positive");
    const memberBatchQuote = await service.quoteSubmission(member, memberBatchInput, "web");
    const memberAuthorization = await service.confirmBatch(member, {
      projectId: ids.project,
      clientIdempotencyKey: "s67-member-batch-positive",
      expectedTotalEstimatedCostFen: memberBatchQuote.estimatedCostFen,
      items: [{ itemId: "member-batch-quote", quoteId: memberBatchQuote.id }],
    });
    assert.equal(memberAuthorization.createdCount, 0, "batch confirmation freezes the list without creating paid work");
    const memberBatch = await service.submitBatchAuthorization(
      member,
      memberAuthorization.authorizationId,
      "web",
    );
    assert.equal(memberBatch.createdCount, 1, "confirmed authorization is consumed by the separate submit action");
    const memberBatchItem = memberBatch.items[0];
    assert.ok(memberBatchItem?.generationRequestId);
    const [persistedMemberBatchQuote] = await handle.db.select().from(generationQuotes).where(eq(generationQuotes.id, memberBatchQuote.id));
    const [memberBatchRequest] = await handle.db.select().from(generationRequests).where(eq(generationRequests.id, memberBatchItem.generationRequestId!));
    const memberBatchLedger = await handle.pool.query<{ user_id: string; actor_user_id: string }>(
      `SELECT user_id, actor_user_id FROM ${quoted}.user_credit_ledger_entries WHERE source_id = $1`, [memberBatchQuote.id],
    );
    assert.equal(persistedMemberBatchQuote?.userId, ids.member);
    assert.equal(persistedMemberBatchQuote?.confirmedByUserId, ids.member);
    assert.equal(memberBatchRequest?.userId, ids.member);
    assert.deepEqual(memberBatchLedger.rows, [{ user_id: ids.member, actor_user_id: ids.member }], "batch debit has one unambiguous member actor");

    await t.test("历史成片报价缺少 mode 时仍可在十分钟窗口单发或批量消费", async () => {
      const singleInput = generationInput(ids, "s67-legacy-full-single");
      const singleQuote = await service.quoteSubmission(owner, singleInput, "web");
      await downgradeFullQuoteToLegacy(
        handle.pool,
        quoted,
        singleQuote.id,
        hashLegacyFullGenerationRequest(normalizeGenerationInput(singleInput)),
      );
      await service.confirmQuote(owner, singleQuote.id);
      const single = await service.submit(owner, singleInput, singleQuote.id, "web");
      assert.ok(single.requestId);

      const batchInput = generationInput(ids, "s67-legacy-full-batch");
      const batchQuote = await service.quoteSubmission(owner, batchInput, "web");
      await downgradeFullQuoteToLegacy(
        handle.pool,
        quoted,
        batchQuote.id,
        hashLegacyFullGenerationRequest(normalizeGenerationInput(batchInput)),
      );
      const authorization = await service.confirmBatch(owner, {
        projectId: ids.project,
        clientIdempotencyKey: "s67-legacy-full-batch",
        expectedTotalEstimatedCostFen: batchQuote.estimatedCostFen,
        productionMode: "full",
        items: [{ itemId: "legacy-full", quoteId: batchQuote.id }],
      });
      const batch = await service.submitBatchAuthorization(owner, authorization.authorizationId, "web");
      assert.equal(batch.createdCount, 1);
    });

    await t.test("样片批次按逐项 0.6× 计费，模式进真库快照且 retry 继承", async () => {
      const sampleInput = videoSampleInput(ids, "s67-sample-batch");
      const sampleQuote = await service.quoteSubmission(owner, sampleInput, "web");
      assert.equal(sampleQuote.estimatedCostFen, 192, "320 分逐项乘 0.6 后为 192 分");
      assert.deepEqual({
        productionMode: sampleQuote.priceSnapshot.productionMode,
        priceMultiplierBps: sampleQuote.priceSnapshot.priceMultiplierBps,
        fullEstimatedCostFen: sampleQuote.priceSnapshot.fullEstimatedCostFen,
      }, {
        productionMode: "sample",
        priceMultiplierBps: 6_000,
        fullEstimatedCostFen: 320,
      });

      const beforeMismatch = await snapshot(handle.pool, quoted);
      await assert.rejects(
        () => service.confirmBatch(owner, {
          projectId: ids.project,
          clientIdempotencyKey: "s67-sample-mode-mismatch",
          expectedTotalEstimatedCostFen: sampleQuote.estimatedCostFen,
          productionMode: "full",
          items: [{ itemId: "sample-video", quoteId: sampleQuote.id }],
        }),
        (error: unknown) => error instanceof GenerationError
          && error.code === "GENERATION_QUOTE_CONFLICT"
          && error.message.includes("报价模式"),
      );
      assert.deepEqual(await snapshot(handle.pool, quoted), beforeMismatch, "模式不一致不能创建任务或扣费");

      const sampleAuthorization = await service.confirmBatch(owner, {
        projectId: ids.project,
        clientIdempotencyKey: "s67-sample-mode-submit",
        expectedTotalEstimatedCostFen: sampleQuote.estimatedCostFen,
        productionMode: "sample",
        items: [{ itemId: "sample-video", quoteId: sampleQuote.id }],
      });
      const sampleBatch = await service.submitBatchAuthorization(
        owner,
        sampleAuthorization.authorizationId,
        "web",
      );
      const sampleRequestId = sampleBatch.items[0]?.generationRequestId;
      assert.ok(sampleRequestId);
      const [sampleRequest] = await handle.db.select().from(generationRequests)
        .where(eq(generationRequests.id, sampleRequestId));
      const [sampleAttempt] = await handle.db.select().from(generationAttempts)
        .where(eq(generationAttempts.requestId, sampleRequestId));
      assert.equal(sampleRequest?.parameters.__s84ProductionMode, "sample");
      assert.equal(sampleAttempt?.estimatedCostFen, 192);
      assert.equal(sampleAttempt?.priceSnapshot.productionMode, "sample");
      assert.equal(sampleAttempt?.priceSnapshot.priceMultiplierBps, 6_000);

      await repository.cancelForActor(ids.owner, sampleRequestId, ids.project);
      const sampleRetryQuote = await service.quoteRetry(owner, sampleRequestId, "web");
      assert.equal(sampleRetryQuote.estimatedCostFen, 192);
      assert.equal(sampleRetryQuote.priceSnapshot.productionMode, "sample");
      assert.equal(sampleRetryQuote.priceSnapshot.priceMultiplierBps, 6_000);
      await service.confirmQuote(owner, sampleRetryQuote.id);
      const sampleRetry = await service.retry(
        owner,
        sampleRequestId,
        "s67-sample-retry",
        sampleRetryQuote.id,
        "web",
      );
      const [sampleRetryAttempt] = await handle.db.select().from(generationAttempts)
        .where(eq(generationAttempts.id, sampleRetry.attemptId));
      assert.equal(sampleRetryAttempt?.estimatedCostFen, 192);
      assert.equal(sampleRetryAttempt?.priceSnapshot.productionMode, "sample");
      assert.equal(sampleRetryAttempt?.priceSnapshot.priceMultiplierBps, 6_000);
    });

    await repository.cancelForActor(ids.member, memberBatchItem.generationRequestId!, ids.project);
    const retryQuote = await service.quoteRetry(owner, created.requestId, "web");
    await service.confirmQuote(owner, retryQuote.id);
    const memberCloneRetryQuoteId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.generation_quotes
        (id,user_id,confirmed_by_user_id,source,action,original_request_id,base_attempt_id,base_attempt_no,request_hash,normalized_request,pricing_rule_id,price_snapshot,estimated_cost_fen,status,expires_at,confirmed_at,created_at,updated_at)
       SELECT $1,$2,$2,source,action,original_request_id,base_attempt_id,base_attempt_no,request_hash,normalized_request,pricing_rule_id,price_snapshot,estimated_cost_fen,'confirmed',expires_at,$3,$3,$3
       FROM ${quoted}.generation_quotes WHERE id=$4`,
      [memberCloneRetryQuoteId, ids.member, now, retryQuote.id],
    );
    await t.test("createRetry：报价属于操作者也不能重试他人的生成请求", async () => {
      const memberOwnedQuote = await handle.pool.query<{ user_id: string; confirmed_by_user_id: string | null }>(
        `SELECT user_id, confirmed_by_user_id FROM ${quoted}.generation_quotes WHERE id=$1`,
        [memberCloneRetryQuoteId],
      );
      assert.deepEqual(memberOwnedQuote.rows, [{
        user_id: ids.member,
        confirmed_by_user_id: ids.member,
      }], "the negative case must pass quote ownership and exercise request ownership");
      const beforeForeignRetry = await snapshot(handle.pool, quoted);
      await assertRejectsNotFound(() => service.retry(
        member,
        created.requestId,
        "s67-member-retry",
        memberCloneRetryQuoteId,
        "web",
      ));
      assert.deepEqual(
        await snapshot(handle.pool, quoted),
        beforeForeignRetry,
        "foreign request retry must not consume a member-owned quote, charge an account or create an attempt",
      );
      assert.deepEqual(await quoteState(handle.pool, quoted, memberCloneRetryQuoteId), {
        status: "confirmed",
        confirmed_by_user_id: ids.member,
        generation_request_id: null,
      });
    });

    const retried = await service.retry(owner, created.requestId, "s67-owner-retry", retryQuote.id, "web");
    assert.ok(retried.attemptId);
    await t.test("listInFlightViewsForActor：retry 后只返回最新 attempt", async () => {
      const page = await repository.listInFlightViewsForActor(ids.owner, 1, 24);
      const retriedItem = page.items.find((item) => item.requestId === created.requestId);
      assert.equal(retriedItem?.attemptId, retried.attemptId);
      assert.equal(retriedItem?.attemptNo, 2);
      assert.equal(page.items.filter((item) => item.requestId === created.requestId).length, 1);
    });
    const retryLedger = await handle.pool.query<{ user_id: string; actor_user_id: string }>(
      `SELECT user_id, actor_user_id FROM ${quoted}.user_credit_ledger_entries WHERE source_id = $1`, [retryQuote.id],
    );
    assert.deepEqual(retryLedger.rows, [], "v1.9 十.6：重试提交只绑定报价，不产生扣减");
    const [boundRetryQuote] = await handle.db.select().from(generationQuotes).where(eq(generationQuotes.id, retryQuote.id));
    assert.equal(boundRetryQuote?.status, "confirmed", "重试报价绑定不消费");
    const preSuccessLateBalances = (await handle.pool.query<{ user_id: string; balance_points: number }>(
      `SELECT user_id, balance_points FROM ${quoted}.user_credit_accounts WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`, [[ids.owner, ids.member]],
    )).rows;
    const preSuccessOwnerBalance = preSuccessLateBalances.find((row) => row.user_id === ids.owner)?.balance_points ?? 0;
    const preSuccessMemberBalance = preSuccessLateBalances.find((row) => row.user_id === ids.member)?.balance_points ?? 0;
    // v1.9 十.6：created 已在上面 cancel 子测试里取消;成功扣费链用一笔新提交。
    const successInput = generationInput(ids, "s67-owner-success");
    const successQuote = await service.quoteSubmission(owner, successInput, "web");
    await service.confirmQuote(owner, successQuote.id);
    const successTask = await service.submit(owner, successInput, successQuote.id, "web");
    await repository.markProviderSucceeded(successTask.attemptId!, {
      status: "succeeded",
      media: [{ kind: "image", providerResultKey: "s67-media-1", temporaryUrl: "https://example.invalid/x.png" }],
    });
    await repository.recordTosObjectUpload(successTask.attemptId!, {
      providerResultKey: "s67-media-1",
      storageBucket: "s67-bucket",
      objectKey: "s67/m1.png",
      producedAt: now,
    });
    await repository.saveMediaResult(successTask.attemptId!, {
      providerResultKey: "s67-media-1",
      mediaKind: "image",
      storageBucket: "s67-bucket",
      storagePath: "s67/m1.png",
      storageUrl: "https://tos.invalid/s67/m1.png",
      sha256: "a".repeat(64),
      mimeType: "image/png",
    });
    await repository.markSucceeded(successTask.attemptId!);
    const ledger = await handle.pool.query<{ user_id: string; actor_user_id: string; points_delta: number }>(
      `SELECT user_id, actor_user_id, points_delta FROM ${quoted}.user_credit_ledger_entries WHERE source_id = $1`, [successQuote.id],
    );
    assert.deepEqual(ledger.rows, [{ user_id: ids.owner, actor_user_id: ids.owner, points_delta: -successQuote.estimatedCostFen }], "成功才扣：恰一条 debit");
    const balances = await handle.pool.query<{ user_id: string; balance_points: number }>(
      `SELECT user_id, balance_points FROM ${quoted}.user_credit_accounts WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`, [[ids.owner, ids.member]],
    );
    assert.equal(balances.rows.find((row) => row.user_id === ids.owner)?.balance_points, preSuccessOwnerBalance - successQuote.estimatedCostFen);
    assert.equal(balances.rows.find((row) => row.user_id === ids.member)?.balance_points, preSuccessMemberBalance, "成功扣费只动提交人账户");
    const [consumedQuote] = await handle.db.select().from(generationQuotes).where(eq(generationQuotes.id, successQuote.id));
    assert.equal(consumedQuote?.status, "consumed", "成功终态消费报价");
    // 被取消的 created 报价应作废、无扣费（十.6 失败/取消不扣）。
    const [voidedQuote] = await handle.db.select().from(generationQuotes).where(eq(generationQuotes.id, ownerQuote.id));
    assert.equal(voidedQuote?.status, "voided", "取消/失败终态报价应 voided");
    const voidedLedger = await handle.pool.query<{ points_delta: number }>(
      `SELECT points_delta FROM ${quoted}.user_credit_ledger_entries WHERE source_id = $1`, [ownerQuote.id],
    );
    assert.equal(voidedLedger.rows.length, 0, "取消的报价不得产生扣减");

    await t.test("迁移 037：数据库拒绝报价人、确认人、请求发起人不一致", async () => {
      await assertTriggerRejectsMismatchedRequest(handle.pool, quoted, ids, now);
    });
    await t.test("迁移 037：数据库拒绝把一个请求的报价记到另一个请求的尝试", async () => {
      await assertTriggerRejectsCrossRequestAttempt(handle.pool, quoted, ids, now);
    });
    await t.test("迁移 037：数据库拒绝重试报价被重写到另一请求", async () => {
      await assertTriggerRejectsRewrittenRetry(handle.pool, quoted, ids, now);
    });
    await t.test("迁移 037：同一尝试的并发消费只允许一次扣费", async () => {
      await assertConcurrentAttemptConsumptionIsSingleDebit(handle.pool, quoted, ids, now);
    });
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

test("S67 真 PG：037 的 NOT VALID 约束保留历史确认报价且约束新写入", async () => {
  assert.ok(databaseUrl, "S67 runner must provide a disposable PostgreSQL URL; this test must never skip");
  const handle = createDatabase(databaseUrl);
  const legacySchema = `${schema}_legacy`;
  const quoted = quoteIdentifier(legacySchema);
  const now = new Date();
  const userId = randomUUID();
  const pricingRuleId = randomUUID();
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    const files = (await readdir(path.resolve("migrations")))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file) && file !== "037_s67_generation_accounting_actor.sql")
      .sort();
    for (const file of files) await handle.pool.query(renderMigrationSql(await readFile(path.resolve("migrations", file), "utf8"), legacySchema));
    await handle.pool.query(
      `INSERT INTO ${quoted}.users (id,username,display_name,password_hash,active,created_at,updated_at)
       VALUES ($1,'s67-legacy','S67 legacy','test-only',true,$2,$2)`,
      [userId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.pricing_rules (id,provider,model,media_kind,billing_unit,unit_price_fen,currency,source,active,effective_from,metadata,created_at,updated_at)
       VALUES ($1,'ark','s67-image','image','image',100,'CNY','s67',true,$2,'{}'::jsonb,$2,$2)`,
      [pricingRuleId, now],
    );
    const legacyQuoteId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.generation_quotes (id,user_id,source,action,request_hash,normalized_request,pricing_rule_id,price_snapshot,estimated_cost_fen,status,expires_at,confirmed_at,created_at,updated_at)
       VALUES ($1,$2,'web','submit',$3,'{}'::jsonb,$4,'{}'::jsonb,100,'confirmed',($5::timestamptz + interval '1 hour'),$5,$5,$5)`,
      [legacyQuoteId, userId, hash64(), pricingRuleId, now],
    );
    await handle.pool.query(renderMigrationSql(await readFile(path.resolve("migrations/037_s67_generation_accounting_actor.sql"), "utf8"), legacySchema));
    const historical = await handle.pool.query<{ confirmed_by_user_id: string | null }>(
      `SELECT confirmed_by_user_id FROM ${quoted}.generation_quotes WHERE id=$1`, [legacyQuoteId],
    );
    assert.deepEqual(historical.rows, [{ confirmed_by_user_id: null }], "migration must not rewrite unverifiable historical actor data");
    const constraint = await handle.pool.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname='generation_quotes_accounting_actor_check' AND conrelid=$1::regclass`,
      [`${legacySchema}.generation_quotes`],
    );
    assert.deepEqual(constraint.rows, [{ convalidated: false }]);
    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.generation_quotes (id,user_id,source,action,request_hash,normalized_request,pricing_rule_id,price_snapshot,estimated_cost_fen,status,expires_at,confirmed_at,created_at,updated_at)
         VALUES ($1,$2,'web','submit',$3,'{}'::jsonb,$4,'{}'::jsonb,100,'confirmed',($5::timestamptz + interval '1 hour'),$5,$5,$5)`,
        [randomUUID(), userId, hash64(), pricingRuleId, now],
      ),
      (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23514",
      "NOT VALID constraints still validate every new row",
    );
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

async function applyMigrations(pool: ReturnType<typeof createDatabase>["pool"]): Promise<void> {
  const files = (await readdir(path.resolve("migrations"))).filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
  assert.ok(files.includes("034_s57_account_registration.sql"));
  assert.ok(files.includes("037_s67_generation_accounting_actor.sql"), "S67 migration must be present for this regression");
  for (const file of files) await pool.query(renderMigrationSql(await readFile(path.resolve("migrations", file), "utf8"), schema));
}

async function snapshot(pool: ReturnType<typeof createDatabase>["pool"], quoted: string) {
  const result = await pool.query<{ accounts: number; account_balance_total: number; daily_charged_total: number; ledger: number; requests: number; attempts: number; batches: number }>(
    `SELECT (SELECT COUNT(*)::int FROM ${quoted}.user_credit_accounts) accounts,
            (SELECT COALESCE(SUM(balance_points), 0)::int FROM ${quoted}.user_credit_accounts) account_balance_total,
            (SELECT COALESCE(SUM(charged_points), 0)::int FROM ${quoted}.user_credit_daily_usage) daily_charged_total,
            (SELECT COUNT(*)::int FROM ${quoted}.user_credit_ledger_entries) ledger,
            (SELECT COUNT(*)::int FROM ${quoted}.generation_requests) requests,
            (SELECT COUNT(*)::int FROM ${quoted}.generation_attempts) attempts,
            (SELECT COUNT(*)::int FROM ${quoted}.generation_batch_authorizations) batches`,
  );
  return result.rows[0]!;
}

async function latestAttemptState(pool: ReturnType<typeof createDatabase>["pool"], quoted: string, requestId: string) {
  const result = await pool.query<{ status: string; phase: string; lease_owner: string | null; lease_until: string | null }>(
    `SELECT status, phase, lease_owner, lease_until::text FROM ${quoted}.generation_attempts WHERE request_id=$1 ORDER BY attempt_no DESC LIMIT 1`,
    [requestId],
  );
  assert.ok(result.rows[0], "request must have one latest attempt");
  return result.rows[0];
}

async function quoteState(pool: ReturnType<typeof createDatabase>["pool"], quoted: string, quoteId: string) {
  const result = await pool.query<{ status: string; confirmed_by_user_id: string | null; generation_request_id: string | null }>(
    `SELECT status, confirmed_by_user_id, generation_request_id FROM ${quoted}.generation_quotes WHERE id=$1`,
    [quoteId],
  );
  assert.ok(result.rows[0], "quote must exist");
  return result.rows[0];
}

async function quoteCount(pool: ReturnType<typeof createDatabase>["pool"], quoted: string): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${quoted}.generation_quotes`);
  return result.rows[0]?.count ?? 0;
}

async function assertTriggerRejectsMismatchedRequest(pool: ReturnType<typeof createDatabase>["pool"], quoted: string, ids: Record<string, string>, now: Date) {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  const quoteId = randomUUID();
  await pool.query(
    `INSERT INTO ${quoted}.generation_requests (id,user_id,project_id,episode_id,shot_id,media_kind,prompt,reference_media_ids,reference_asset_snapshots,parameters,quantity,client_idempotency_key,request_hash,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'image','S67 trigger guard','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,1,$6,repeat('z',64),$7,$7)`,
    [requestId, ids.member, ids.project, ids.episode, ids.shot, `s67-trigger-${requestId}`, now],
  );
  await pool.query(
    `INSERT INTO ${quoted}.generation_attempts (id,request_id,attempt_no,provider,model,parameters,quantity,status,phase,retryable,estimated_cost_fen,actual_cost_status,pricing_rule_id,price_snapshot,created_at,updated_at)
     VALUES ($1,$2,1,'test','s67-image','{}'::jsonb,1,'pending','created',false,100,'estimated',$3,'{}'::jsonb,$4,$4)`,
    [attemptId, requestId, ids.price, now],
  );
  await pool.query(
    `INSERT INTO ${quoted}.generation_quotes (id,user_id,confirmed_by_user_id,source,action,request_hash,normalized_request,pricing_rule_id,price_snapshot,estimated_cost_fen,status,expires_at,confirmed_at,created_at,updated_at)
     VALUES ($1,$2,$2,'web','submit',repeat('b',64),'{}'::jsonb,$3,'{}'::jsonb,100,'confirmed',($4::timestamptz + interval '1 hour'),$4,$4,$4)`,
    [quoteId, ids.owner, ids.price, now],
  );
  const before = await snapshot(pool, quoted);
  await assert.rejects(
    pool.query(`UPDATE ${quoted}.generation_quotes SET status='consumed', consumed_at=$2, generation_request_id=$3, generation_attempt_id=$4, updated_at=$2 WHERE id=$1`, [quoteId, now, requestId, attemptId]),
    (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P0001" && error instanceof Error && error.message === "account_credit_actor_mismatch",
    "database trigger must reject manually mismatched quote/request actors",
  );
  assert.deepEqual(await snapshot(pool, quoted), before, "trigger rejection must roll back every accounting side effect");
  const quote = await pool.query<{ status: string; generation_request_id: string | null; generation_attempt_id: string | null }>(
    `SELECT status, generation_request_id, generation_attempt_id FROM ${quoted}.generation_quotes WHERE id=$1`,
    [quoteId],
  );
  assert.deepEqual(quote.rows, [{
    status: "confirmed",
    generation_request_id: null,
    generation_attempt_id: null,
  }], "a rejected actor mismatch must leave the quote reusable only by its true owner");
}

async function insertRawRequestAttempt(
  pool: ReturnType<typeof createDatabase>["pool"], quoted: string, ids: Record<string, string>, now: Date, userId: string,
) {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO ${quoted}.generation_requests (id,user_id,project_id,episode_id,shot_id,media_kind,prompt,reference_media_ids,reference_asset_snapshots,parameters,quantity,client_idempotency_key,request_hash,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'image','S67 trigger guard','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,1,$6,$7,$8,$8)`,
    [requestId, userId, ids.project, ids.episode, ids.shot, `s67-trigger-${requestId}`, hash64(), now],
  );
  await pool.query(
    `INSERT INTO ${quoted}.generation_attempts (id,request_id,attempt_no,provider,model,parameters,quantity,status,phase,retryable,estimated_cost_fen,actual_cost_status,pricing_rule_id,price_snapshot,created_at,updated_at)
     VALUES ($1,$2,1,'test','s67-image','{}'::jsonb,1,'pending','created',false,100,'estimated',$3,'{}'::jsonb,$4,$4)`,
    [attemptId, requestId, ids.price, now],
  );
  return { requestId, attemptId };
}

async function insertConfirmedRawQuote(
  pool: ReturnType<typeof createDatabase>["pool"], quoted: string, ids: Record<string, string>, now: Date,
  userId: string, action: "submit" | "retry", originalRequestId: string | null, baseAttemptId: string | null,
) {
  const quoteId = randomUUID();
  await pool.query(
    `INSERT INTO ${quoted}.generation_quotes (id,user_id,confirmed_by_user_id,source,action,original_request_id,base_attempt_id,base_attempt_no,request_hash,normalized_request,pricing_rule_id,price_snapshot,estimated_cost_fen,status,expires_at,confirmed_at,created_at,updated_at)
     VALUES ($1,$2,$2,'web',$3,$4,$5,CASE WHEN $5::uuid IS NULL THEN NULL ELSE 1 END,$6,'{}'::jsonb,$7,'{}'::jsonb,100,'confirmed',($8::timestamptz + interval '1 hour'),$8,$8,$8)`,
    [quoteId, userId, action, originalRequestId, baseAttemptId, hash64(), ids.price, now],
  );
  return quoteId;
}

async function assertTriggerRejectsCrossRequestAttempt(pool: ReturnType<typeof createDatabase>["pool"], quoted: string, ids: Record<string, string>, now: Date) {
  const first = await insertRawRequestAttempt(pool, quoted, ids, now, ids.owner);
  const second = await insertRawRequestAttempt(pool, quoted, ids, now, ids.owner);
  const quoteId = await insertConfirmedRawQuote(pool, quoted, ids, now, ids.owner, "submit", null, null);
  const before = await snapshot(pool, quoted);
  await assert.rejects(
    pool.query(`UPDATE ${quoted}.generation_quotes SET status='consumed', consumed_at=$2, generation_request_id=$3, generation_attempt_id=$4, updated_at=$2 WHERE id=$1`, [quoteId, now, first.requestId, second.attemptId]),
    isPgTriggerError("account_credit_attempt_request_mismatch"),
  );
  assert.deepEqual(await snapshot(pool, quoted), before);
}

async function assertTriggerRejectsRewrittenRetry(pool: ReturnType<typeof createDatabase>["pool"], quoted: string, ids: Record<string, string>, now: Date) {
  const original = await insertRawRequestAttempt(pool, quoted, ids, now, ids.owner);
  const rewritten = await insertRawRequestAttempt(pool, quoted, ids, now, ids.owner);
  const quoteId = await insertConfirmedRawQuote(pool, quoted, ids, now, ids.owner, "retry", original.requestId, original.attemptId);
  const before = await snapshot(pool, quoted);
  await assert.rejects(
    pool.query(`UPDATE ${quoted}.generation_quotes SET status='consumed', consumed_at=$2, generation_request_id=$3, generation_attempt_id=$4, updated_at=$2 WHERE id=$1`, [quoteId, now, rewritten.requestId, rewritten.attemptId]),
    isPgTriggerError("account_credit_retry_request_mismatch"),
  );
  assert.deepEqual(await snapshot(pool, quoted), before);
}

async function assertConcurrentAttemptConsumptionIsSingleDebit(pool: ReturnType<typeof createDatabase>["pool"], quoted: string, ids: Record<string, string>, now: Date) {
  const work = await insertRawRequestAttempt(pool, quoted, ids, now, ids.owner);
  const firstQuoteId = await insertConfirmedRawQuote(pool, quoted, ids, now, ids.owner, "submit", null, null);
  const secondQuoteId = await insertConfirmedRawQuote(pool, quoted, ids, now, ids.owner, "submit", null, null);
  const firstClient = await pool.connect();
  const secondClient = await pool.connect();
  let firstCommitted = false;
  let secondFinished = false;
  try {
    await firstClient.query("BEGIN");
    await secondClient.query("BEGIN");
    const [{ backend_pid: secondPid }] = (await secondClient.query<{ backend_pid: number }>("SELECT pg_backend_pid() AS backend_pid")).rows;
    await firstClient.query(
      `UPDATE ${quoted}.generation_quotes SET status='consumed', consumed_at=$2, generation_request_id=$3, generation_attempt_id=$4, updated_at=$2 WHERE id=$1`,
      [firstQuoteId, now, work.requestId, work.attemptId],
    );
    const secondConsumption = secondClient.query(
      `UPDATE ${quoted}.generation_quotes SET status='consumed', consumed_at=$2, generation_request_id=$3, generation_attempt_id=$4, updated_at=$2 WHERE id=$1`,
      [secondQuoteId, now, work.requestId, work.attemptId],
    ).finally(() => { secondFinished = true; });
    const secondRejected = assert.rejects(
      secondConsumption,
      isPgTriggerError("account_credit_duplicate_generation_attempt"),
    );

    const lockObserved = await waitForAttemptLock(pool, secondPid);
    assert.equal(lockObserved, true, "the second consumption must wait on the first transaction's attempt row lock");
    assert.equal(secondFinished, false, "the second consumption must remain pending before the first transaction commits");

    await firstClient.query("COMMIT");
    firstCommitted = true;
    await secondRejected;
    await secondClient.query("ROLLBACK");
  } finally {
    if (!firstCommitted) await firstClient.query("ROLLBACK").catch(() => undefined);
    await secondClient.query("ROLLBACK").catch(() => undefined);
    firstClient.release();
    secondClient.release();
  }
  const ledger = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${quoted}.user_credit_ledger_entries WHERE source_id = ANY($1::uuid[])`,
    [[firstQuoteId, secondQuoteId]],
  );
  assert.equal(ledger.rows[0]?.count, 1, "one attempt has exactly one generation debit");
}

async function waitForAttemptLock(pool: ReturnType<typeof createDatabase>["pool"], backendPid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
      [backendPid],
    );
    if (result.rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function isPgTriggerError(message: string) {
  return (error: unknown) => typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "P0001"
    && error instanceof Error && error.message === message;
}

function hash64(): string {
  return randomUUID().replaceAll("-", "").repeat(2);
}

function assertLocalDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("S67_GENERATION_ACCOUNTING_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL，拒绝连接云 RDS");
  }
}

async function assertRejectsNotFound(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof GenerationError && (
    error.code === "GENERATION_QUOTE_NOT_FOUND"
    || error.code === "GENERATION_NOT_FOUND"
    || error.code === "GENERATION_BATCH_AUTHORIZATION_NOT_FOUND"
  ));
}

function userValue(id: string, username: string, now: Date) {
  return { id, username: `${username}-${id.slice(0, 6)}`, displayName: username, passwordHash: "test-only", active: true, createdAt: now, updatedAt: now };
}

function priceValue(id: string, now: Date) {
  return {
    id, provider: "ark", model: ARK_SEEDREAM_5_PRO_MODEL, mediaKind: "image" as const, billingUnit: "image", unitPriceFen: 60, currency: "CNY", source: "s67", active: true,
    effectiveFrom: new Date(now.getTime() - 60_000), effectiveTo: null,
    metadata: {
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
    createdAt: now, updatedAt: now,
  };
}

function videoPriceValue(id: string, now: Date) {
  return {
    id,
    provider: "ark",
    model: "doubao-seedance-2-0-fast-260128",
    mediaKind: "video" as const,
    billingUnit: "second",
    unitPriceFen: 80,
    currency: "CNY",
    source: "s67",
    active: true,
    effectiveFrom: new Date(now.getTime() - 60_000),
    effectiveTo: null,
    metadata: {
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

function generationInput(ids: Record<string, string>, key: string): SubmitGenerationInput {
  return { projectId: ids.project, episodeId: ids.episode, shotId: ids.shot, mediaKind: "image", tierId: "img-seedream5pro-169-2k-1", model: ARK_SEEDREAM_5_PRO_MODEL, prompt: "S67 accounting actor", parameters: {}, referenceMediaIds: [], referenceAssetSnapshots: [], quantity: 1, clientIdempotencyKey: key };
}

function videoSampleInput(ids: Record<string, string>, key: string): SubmitGenerationInput {
  return {
    projectId: ids.project,
    episodeId: ids.episode,
    shotId: ids.shot,
    mediaKind: "video",
    tierId: "vid-seedance20fast-916-720p-4s",
    model: "doubao-seedance-2-0-fast-260128",
    prompt: "S67 样片计价",
    parameters: {},
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    quantity: 1,
    productionMode: "sample",
    clientIdempotencyKey: key,
  };
}

async function downgradeFullQuoteToLegacy(
  pool: DatabaseHandle["pool"],
  quoted: string,
  quoteId: string,
  legacyHash: string,
): Promise<void> {
  await pool.query(
    `UPDATE ${quoted}.generation_quotes
     SET request_hash = $2,
         normalized_request = normalized_request - 'productionMode',
         price_snapshot = price_snapshot
           - 'productionMode'
           - 'fullEstimatedCostFen'
           - 'priceMultiplierBps'
           - 'discountNumerator'
           - 'discountDenominator'
     WHERE id = $1`,
    [quoteId, legacyHash],
  );
}
