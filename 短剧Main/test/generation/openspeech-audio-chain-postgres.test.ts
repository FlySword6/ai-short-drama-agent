import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { settings } from "../../src/config/env.js";
import type { Database } from "../../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../../src/db/migrate.js";
import {
  AigcMetadataLabeler,
  readAigcImplicitLabel,
} from "../../src/modules/generation/aigcLabeler.js";
import { GenerationAttemptLeaseLostError } from "../../src/modules/generation/errors.js";
import type { GenerationAigcLabeler } from "../../src/modules/generation/ports.js";
import { OpenspeechTtsProvider } from "../../src/modules/generation/provider/openspeechTtsProvider.js";
import { SeedAudioProvider } from "../../src/modules/generation/provider/seedAudioProvider.js";
import { PostgresGenerationRepository } from "../../src/modules/generation/repository.js";
import { registerGenerationRoutes } from "../../src/modules/generation/routes.js";
import { assertAudioProviderMediaIntegrity, GenerationService } from "../../src/modules/generation/service.js";
import { GenerationWorker } from "../../src/modules/generation/worker.js";

// This is deliberately a real route + repository + provider-adapter chain.
// Only fetch and TOS are stubbed, so it never contacts a vendor or writes to TOS.
const integrationTestDatabaseUrl = process.env.AUDIO_CHAIN_TEST_DATABASE_URL;
const ENDPOINT = "https://openspeech.bytedance.com/api/v1/tts";

test("真链: audio route keeps spoken text separate and applies platform AIGC evidence", {
  skip: !integrationTestDatabaseUrl,
  timeout: 120_000,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabaseUrl(integrationTestDatabaseUrl);
  assertSafeTestSchema(settings.postgresSchema);

  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schema = quoteIdentifier(settings.postgresSchema);
  const userId = randomUUID();
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const shotId = randomUUID();
  const pricingRuleId = randomUUID();
  const repository = new PostgresGenerationRepository(
    drizzle(pool) as unknown as Database,
    1_000,
    true,
    () => {},
    1,
  );
  let storageUploads = 0;
  const fetchBodies: Array<{
    app: Record<string, unknown>;
    user: Record<string, unknown>;
    audio: Record<string, unknown>;
    request: Record<string, unknown>;
  }> = [];
  const provider = new OpenspeechTtsProvider({
    token: "test-token",
    appId: "test-appid",
    endpoint: ENDPOINT,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), ENDPOINT);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer;test-token");
      const body = JSON.parse(String(init?.body)) as {
        app: Record<string, unknown>;
        user: Record<string, unknown>;
        audio: Record<string, unknown>;
        request: Record<string, unknown>;
      };
      fetchBodies.push(body);
      const spokenText = typeof body.request.text === "string" ? body.request.text : "";
      const duration = spokenText === "超时长台词" ? 13_001 : 1_960;
      return jsonResponse({
        code: 3000,
        reqid: `s43-open-speech-result-${fetchBodies.length}`,
        data: Buffer.from("s43-audio-bytes").toString("base64"),
        addition: {
          duration,
          frontend: [{ text: spokenText, start_time: 0, end_time: duration }],
        },
      });
    },
  });
  const workerService = new GenerationService({
    repository,
    provider,
    storage: {
      uploadBytes: async ({ storagePath }) => {
        storageUploads += 1;
        return {
          bucket: "s43-test-bucket",
          storagePath,
          storageUrl: `https://tos.example.test/${storagePath}`,
        };
      },
    },
    aigcLabeler: testAigcLabeler(),
    budgetLimitFen: 50_000,
  });
  const app = Fastify({ logger: false });

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await applyMigrations(pool, settings.postgresSchema, await migrationFilesThroughCurrent());
    await seedAudioProject(pool, { schema, userId, projectId, episodeId, shotId, pricingRuleId });

    app.setErrorHandler((error, _request, reply) => reply.code(
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? Number((error as { statusCode: number }).statusCode)
        : 500,
    ).send({ ok: false, error: { message: error.message } }));
    app.addHook("preHandler", async (request) => {
      request.authUser = { id: userId, username: "s43-audio-user", displayName: "S43 Audio", role: "member" };
      request.authSessionId = "11111111-1111-4111-8111-111111111111";
      request.authContext = {
        user: request.authUser,
        credential: {
          sessionId: request.authSessionId,
          source: "web",
          actorKind: "human",
          agentType: null,
          userAgent: "openspeech-audio-chain-postgres-test",
          expiresAt: new Date("2027-08-03T00:00:00.000Z"),
        },
      };
    });
    await registerGenerationRoutes(app, () => drizzle(pool) as unknown as Database, {
      createRepository: () => repository,
      createProjectAccessService: () => ({
        require: async (_actor, requestedProjectId) => ({
          projectId: requestedProjectId,
          actorId: userId,
          platformRole: "member" as const,
          membershipRole: "owner" as const,
          isPlatformObserver: false,
        }),
      }),
      // The route contract is exercised without enabling a real paid runtime.
      requireSubmissionReady: () => {},
    });

    const payload = {
      media_kind: "audio",
      tier_id: "aud-openspeech-2s",
      project_id: projectId,
      episode_id: episodeId,
      shot_id: shotId,
      prompt: "我不会走的。",
      audio_prompt_dimensions: {
        voiceReference: "温柔女声",
        performanceEmotion: "悲伤克制",
        paceAndPauses: "慢，句尾留白",
        languageAndAccent: "普通话",
        vocalDistance: "近讲",
        continuity: "承接上一句",
      },
      parameters: {
        speaker_id: "zh_female_test",
        speech_rate: 50,
        loudness_rate: -50,
      },
      quantity: 1,
      client_idempotency_key: "s43-audio-chain-key",
    };
    const estimateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload,
    });
    assert.equal(estimateResponse.statusCode, 200, estimateResponse.body);
    const quoteId = (estimateResponse.json() as { data: { generation_quote_id: string } }).data.generation_quote_id;
    assert.ok(quoteId);

    const confirmResponse = await app.inject({
      method: "POST",
      url: `/api/v1/generation-quotes/${quoteId}/confirm`,
    });
    assert.equal(confirmResponse.statusCode, 200, confirmResponse.body);

    const submitResponse = await app.inject({
      method: "POST",
      url: "/api/v1/generations",
      payload: { ...payload, generation_quote_id: quoteId },
    });
    assert.equal(submitResponse.statusCode, 202, submitResponse.body);
    const attemptId = (submitResponse.json() as { data: { current_attempt_id: string } }).data.current_attempt_id;
    assert.ok(attemptId);

    const completed = await workerService.runRecoverableAttempt(attemptId);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.phase, "complete");
    assert.equal(completed.errorCode, undefined);
    assert.equal(fetchBodies.length, 1);
    assert.deepEqual(fetchBodies[0]?.app, {
      appid: "test-appid",
      token: "placeholder",
      cluster: "volcano_tts",
    });
    assert.deepEqual(fetchBodies[0]?.user, { uid: "shortdrama" });
    assert.deepEqual(fetchBodies[0]?.audio, {
      voice_type: "zh_female_test",
      encoding: "mp3",
      rate: 24000,
      speed_ratio: 1.5,
      loudness_ratio: 0.5,
      emotion: "悲伤克制",
    });
    assert.equal(typeof fetchBodies[0]?.request.reqid, "string");
    assert.equal(fetchBodies[0]?.request.text, "我不会走的。");
    assert.equal(fetchBodies[0]?.request.operation, "query");
    assert.equal(fetchBodies[0]?.request.with_timestamp, 1);
    assert.doesNotMatch(JSON.stringify(fetchBodies[0]), /音色基准|表演情绪|语速停顿|补充/);
    assert.equal(storageUploads, 1);

    const persisted = await pool.query<{
      prompt: string;
      parameters: Record<string, unknown>;
      provider_response: {
        metadata?: {
          mappedAudioDimensions?: string[];
          unmappedAudioDimensions?: string[];
          inlineMediaAudit?: Array<{ byteLength?: number; sha256?: string; contentType?: string }>;
        };
        media?: Array<{
          actualDurationMs?: number;
          durationDeltaMs?: number;
          subtitle?: { cues?: Array<Record<string, unknown>> };
          complianceMetadata?: Record<string, unknown>;
          inlineContent?: Record<string, unknown>;
        }>;
      };
      attempt_status: string;
      attempt_phase: string;
      error_code: string | null;
    }>(`
      SELECT r.prompt, r.parameters, a.provider_response, a.status AS attempt_status,
             a.phase AS attempt_phase, a.error_code
      FROM ${schema}.generation_requests r
      JOIN ${schema}.generation_attempts a ON a.request_id = r.id
      WHERE a.id = $1
    `, [attemptId]);
    assert.equal(persisted.rows.length, 1);
    const row = persisted.rows[0]!;
    assert.equal(row.prompt, "我不会走的。");
    const storedDimensions = row.parameters.__s43AudioPromptDimensions as Record<string, unknown> | undefined;
    assert.equal(storedDimensions?.performanceEmotion, "悲伤克制");
    assert.equal(row.provider_response.media?.[0]?.actualDurationMs, 1960);
    assert.equal(row.provider_response.media?.[0]?.durationDeltaMs, -40);
    assert.deepEqual(row.provider_response.media?.[0]?.subtitle, {
      cues: [{ text: "我不会走的。", start: 0, end: 1.96 }],
    });
    assert.deepEqual(row.provider_response.media?.[0]?.complianceMetadata, {
      aigcMetadataEnabled: true,
      aigcMetadataEvidence: "platform_applied",
      contentId: `generation-attempt:${attemptId}:media:0`,
      contentProducer: "001191110000802044347C00000",
      schemaVersion: "GB45438-2025-Appendix-E",
    });
    assert.equal(row.provider_response.media?.[0]?.inlineContent, undefined);
    assert.deepEqual(row.provider_response.metadata?.mappedAudioDimensions, ["performanceEmotion->emotion"]);
    assert.deepEqual(row.provider_response.metadata?.unmappedAudioDimensions, [
      "voiceReference",
      "paceAndPauses",
      "languageAndAccent",
      "vocalDistance",
      "continuity",
    ]);
    assert.equal(row.provider_response.metadata?.inlineMediaAudit?.[0]?.byteLength, Buffer.byteLength("s43-audio-bytes"));
    assert.match(row.provider_response.metadata?.inlineMediaAudit?.[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(row.attempt_status, "succeeded");
    assert.equal(row.attempt_phase, "complete");
    assert.equal(row.error_code, null);
    const firstOutcomeNotifications = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM ${schema}.generation_attempt_notifications
      WHERE attempt_id = $1
    `, [attemptId]);
    assert.equal(firstOutcomeNotifications.rows[0]?.count, 1);
    const persistedOutputRows = await pool.query<{
      media_count: number;
      audio_candidate_count: number;
      media_evidence: string | null;
      candidate_evidence: string | null;
    }>(`
      SELECT
        (SELECT count(*)::int FROM ${schema}.media_results WHERE attempt_id = $1) AS media_count,
        (SELECT count(*)::int FROM ${schema}.audio_versions WHERE generation_request_id = $2) AS audio_candidate_count,
        (SELECT compliance_metadata->>'aigcMetadataEvidence' FROM ${schema}.media_results WHERE attempt_id = $1 LIMIT 1) AS media_evidence,
        (SELECT compliance_metadata->>'aigcMetadataEvidence' FROM ${schema}.audio_versions WHERE generation_request_id = $2 LIMIT 1) AS candidate_evidence
    `, [attemptId, completed.requestId]);
    assert.equal(persistedOutputRows.rows[0]?.media_count, 1);
    assert.equal(persistedOutputRows.rows[0]?.audio_candidate_count, 1);
    assert.equal(persistedOutputRows.rows[0]?.media_evidence, "platform_applied");
    assert.equal(persistedOutputRows.rows[0]?.candidate_evidence, "platform_applied");
    const referencedTosObject = await pool.query<{
      attempt_id: string;
      provider_result_key: string;
      object_key: string;
      cleanup_status: string;
      produced_at: Date;
      media_result_id: string;
    }>(`
      SELECT attempt_id, provider_result_key, object_key, cleanup_status, produced_at, media_result_id
      FROM ${schema}.generation_tos_orphans
      WHERE attempt_id = $1
    `, [attemptId]);
    assert.deepEqual(referencedTosObject.rows.map((object) => ({
      ...object,
      produced_at: object.produced_at instanceof Date,
    })), [{
      attempt_id: attemptId,
      provider_result_key: "s43-open-speech-result-1",
      object_key: `projects/${projectId}/shots/${shotId}/audio/s43-open-speech-result-1/0.mp3`,
      cleanup_status: "referenced",
      produced_at: true,
      media_result_id: referencedTosObject.rows[0]?.media_result_id,
    }]);
    assert.match(referencedTosObject.rows[0]?.media_result_id ?? "", /^[a-f0-9-]{36}$/);
    await repository.recordTosObjectUpload(attemptId, {
      providerResultKey: "s43-open-speech-result-1",
      storageBucket: "s43-test-bucket",
      objectKey: referencedTosObject.rows[0]!.object_key,
      producedAt: new Date(),
    }, "s49-expired-worker-after-reference");
    const afterLateReceipt = await pool.query<{ cleanup_status: string; media_result_id: string }>(`
      SELECT cleanup_status, media_result_id
      FROM ${schema}.generation_tos_orphans
      WHERE attempt_id = $1
    `, [attemptId]);
    assert.deepEqual(afterLateReceipt.rows, [{
      cleanup_status: "referenced",
      media_result_id: referencedTosObject.rows[0]!.media_result_id,
    }]);

    // The same real route/provider/repository path rejects an observed TTS
    // duration outside the provisional tolerance before any TOS persistence.
    const outOfTolerancePayload = {
      ...payload,
      prompt: "超时长台词",
      client_idempotency_key: "s43-audio-duration-outlier",
    };
    const outlierEstimate = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      payload: outOfTolerancePayload,
    });
    assert.equal(outlierEstimate.statusCode, 200, outlierEstimate.body);
    const outlierQuoteId = (outlierEstimate.json() as { data: { generation_quote_id: string } }).data.generation_quote_id;
    const outlierConfirm = await app.inject({
      method: "POST",
      url: `/api/v1/generation-quotes/${outlierQuoteId}/confirm`,
    });
    assert.equal(outlierConfirm.statusCode, 200, outlierConfirm.body);
    const outlierSubmit = await app.inject({
      method: "POST",
      url: "/api/v1/generations",
      payload: { ...outOfTolerancePayload, generation_quote_id: outlierQuoteId },
    });
    assert.equal(outlierSubmit.statusCode, 202, outlierSubmit.body);
    const outlierAttemptId = (outlierSubmit.json() as { data: { current_attempt_id: string } }).data.current_attempt_id;
    const outlierCompleted = await workerService.runRecoverableAttempt(outlierAttemptId);
    assert.equal(outlierCompleted.status, "failed");
    assert.equal(outlierCompleted.phase, "complete");
    assert.equal(outlierCompleted.errorCode, "AUDIO_RESULT_DURATION_OUT_OF_TOLERANCE");
    assert.equal(fetchBodies.length, 2);
    assert.equal(fetchBodies[1]?.request.text, "超时长台词");
    assert.equal(storageUploads, 1);
    const outlierSnapshot = await pool.query<{
      provider_response: { media?: Array<{ actualDurationMs?: number; durationDeltaMs?: number; inlineContent?: unknown }> };
      status: string;
      phase: string;
      error_code: string | null;
    }>(`
      SELECT provider_response, status, phase, error_code
      FROM ${schema}.generation_attempts WHERE id = $1
    `, [outlierAttemptId]);
    assert.equal(outlierSnapshot.rows[0]?.provider_response.media?.[0]?.actualDurationMs, 13_001);
    assert.equal(outlierSnapshot.rows[0]?.provider_response.media?.[0]?.durationDeltaMs, 11_001);
    assert.equal(outlierSnapshot.rows[0]?.provider_response.media?.[0]?.inlineContent, undefined);
    assert.deepEqual({
      status: outlierSnapshot.rows[0]?.status,
      phase: outlierSnapshot.rows[0]?.phase,
      errorCode: outlierSnapshot.rows[0]?.error_code,
    }, {
      status: "failed",
      phase: "complete",
      errorCode: "AUDIO_RESULT_DURATION_OUT_OF_TOLERANCE",
    });
    const outlierNotification = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM ${schema}.generation_attempt_notifications WHERE attempt_id = $1
    `, [outlierAttemptId]);
    assert.equal(outlierNotification.rows[0]?.count, 1);
    const outlierOutputRows = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM ${schema}.media_results WHERE attempt_id = $1
    `, [outlierAttemptId]);
    assert.equal(outlierOutputRows.rows[0]?.count, 0);

    // A provider can fail after part of a batch has already persisted. The
    // terminal transition must withdraw that durable output in the same real
    // PostgreSQL transaction, rather than exposing a failed half batch.
    const providerFailureFixture = await seedPersistedAudioAttempt({
      pool,
      schema,
      repository,
      userId,
      projectId,
      shotId,
      pricingRuleId,
      fixtureName: "s49-provider-terminal-with-persisted-media",
    });
    const providerFailureAttemptId = providerFailureFixture.attemptId;
    const providerFailureQuoteId = randomUUID();
    await pool.query(`
      INSERT INTO ${schema}.generation_quotes (
        id, user_id, confirmed_by_user_id, source, action, request_hash, normalized_request, pricing_rule_id,
        price_snapshot, estimated_cost_fen, status, expires_at, confirmed_at, consumed_at,
        generation_request_id, generation_attempt_id, created_at, updated_at
      ) VALUES (
        $1, $2, $2, 'web', 'submit', $3, '{}'::jsonb, $4, $7::jsonb, 46, 'consumed',
        now() + interval '1 hour', now(), now(), $5, $6, now(), now()
      )
    `, [
      providerFailureQuoteId,
      userId,
      randomUUID().replaceAll("-", "").repeat(2),
      pricingRuleId,
      providerFailureFixture.requestId,
      providerFailureAttemptId,
      JSON.stringify(audioPriceSnapshot(pricingRuleId)),
    ]);
    await repository.markProviderFailed({
      attemptId: providerFailureAttemptId,
      errorCode: "AUDIO_RESULT_AIGC_LABELING_FAILED",
      errorMessage: "AIGC labeling failed after one audio result persisted",
      recordCompensationPending: true,
    });
    const providerFailureMedia = await pool.query<{ deleted_at: Date | null }>(`
      SELECT deleted_at
      FROM ${schema}.media_results
      WHERE attempt_id = $1 AND persistence_status = 'persisted'
    `, [providerFailureAttemptId]);
    assert.equal(providerFailureMedia.rows.length, 1);
    assert.ok(providerFailureMedia.rows[0]?.deleted_at);
    const providerFailureCandidates = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM ${schema}.audio_versions av
      INNER JOIN ${schema}.media_results mr ON mr.id = av.media_result_id
      WHERE mr.attempt_id = $1
    `, [providerFailureAttemptId]);
    assert.equal(providerFailureCandidates.rows[0]?.count, 0);
    const providerFailureFact = await pool.query<{
      quote_id: string;
      reserved_amount_fen: number;
      provider_cost_status: string;
      resolution_status: string;
    }>(`
      SELECT quote_id, reserved_amount_fen, provider_cost_status, resolution_status
      FROM ${schema}.generation_billing_failure_facts
      WHERE attempt_id = $1
    `, [providerFailureAttemptId]);
    assert.deepEqual(providerFailureFact.rows, [{
      quote_id: providerFailureQuoteId,
      reserved_amount_fen: 46,
      provider_cost_status: "incurred",
      resolution_status: "pending_compensation",
    }]);
    const providerFailureOrphans = await pool.query<{
      object_key: string;
      cleanup_status: string;
      produced_at: Date;
    }>(`
      SELECT object_key, cleanup_status, produced_at
      FROM ${schema}.generation_tos_orphans
      WHERE attempt_id = $1
    `, [providerFailureAttemptId]);
    assert.deepEqual(providerFailureOrphans.rows.map((object) => ({
      ...object,
      produced_at: object.produced_at instanceof Date,
    })), [{
      object_key: providerFailureFixture.storagePath,
      cleanup_status: "pending_cleanup",
      produced_at: true,
    }]);

    // Same real repository, limit=1: one scheduled recovery and then a
    // terminal result with notification, never an endlessly claimable row.
    const failingFixture = await seedPersistedAudioAttempt({
      pool,
      schema,
      repository,
      userId,
      projectId,
      shotId,
      pricingRuleId,
      fixtureName: "s49-persistence-limit-with-persisted-media",
    });
    const failingAttemptId = failingFixture.attemptId;
    await repository.recordPersistenceFailure(failingAttemptId, "temporary storage fault");
    const afterFirstFailure = await pool.query<{
      provider_response: { metadata?: { persistenceRetryCount?: number } };
      status: string;
      retryable: boolean;
    }>(`
      SELECT provider_response, status, retryable
      FROM ${schema}.generation_attempts WHERE id = $1
    `, [failingAttemptId]);
    assert.equal(afterFirstFailure.rows[0]?.provider_response.metadata?.persistenceRetryCount, 1);
    assert.equal(afterFirstFailure.rows[0]?.status, "running");
    assert.equal(afterFirstFailure.rows[0]?.retryable, true);
    await repository.recordPersistenceFailure(failingAttemptId, "temporary storage fault again");
    const afterLimit = await pool.query<{
      status: string;
      phase: string;
      error_code: string;
      retryable: boolean;
      next_poll_at: Date | null;
      finished_at: Date | null;
    }>(`
      SELECT status, phase, error_code, retryable, next_poll_at, finished_at
      FROM ${schema}.generation_attempts WHERE id = $1
    `, [failingAttemptId]);
    assert.equal(afterLimit.rows[0]?.status, "failed");
    assert.equal(afterLimit.rows[0]?.phase, "complete");
    assert.equal(afterLimit.rows[0]?.error_code, "PERSISTENCE_RETRY_EXHAUSTED");
    assert.equal(afterLimit.rows[0]?.retryable, false);
    assert.equal(afterLimit.rows[0]?.next_poll_at, null);
    assert.ok(afterLimit.rows[0]?.finished_at);
    const exhaustedPersistenceMedia = await pool.query<{ deleted_at: Date | null }>(`
      SELECT deleted_at
      FROM ${schema}.media_results
      WHERE attempt_id = $1 AND persistence_status = 'persisted'
    `, [failingAttemptId]);
    assert.equal(exhaustedPersistenceMedia.rows.length, 1);
    assert.ok(exhaustedPersistenceMedia.rows[0]?.deleted_at);
    const exhaustedPersistenceCandidates = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM ${schema}.audio_versions av
      INNER JOIN ${schema}.media_results mr ON mr.id = av.media_result_id
      WHERE mr.attempt_id = $1
    `, [failingAttemptId]);
    assert.equal(exhaustedPersistenceCandidates.rows[0]?.count, 0);
    const exhaustedPersistenceOrphans = await pool.query<{ object_key: string; cleanup_status: string }>(`
      SELECT object_key, cleanup_status
      FROM ${schema}.generation_tos_orphans
      WHERE attempt_id = $1
    `, [failingAttemptId]);
    assert.deepEqual(exhaustedPersistenceOrphans.rows, [{
      object_key: failingFixture.storagePath,
      cleanup_status: "pending_cleanup",
    }]);
    // A late failure from an expired worker must not resurrect a terminal row
    // that another worker may already have completed.
    await repository.recordPersistenceFailure(failingAttemptId, "late worker fault");
    const afterLateFailure = await pool.query<{
      status: string;
      phase: string;
      error_code: string;
      retryable: boolean;
      next_poll_at: Date | null;
    }>(`
      SELECT status, phase, error_code, retryable, next_poll_at
      FROM ${schema}.generation_attempts WHERE id = $1
    `, [failingAttemptId]);
    assert.deepEqual(afterLateFailure.rows[0], {
      status: "failed",
      phase: "complete",
      error_code: "PERSISTENCE_RETRY_EXHAUSTED",
      retryable: false,
      next_poll_at: null,
    });
    const notifications = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM ${schema}.generation_attempt_notifications WHERE attempt_id = $1
    `, [failingAttemptId]);
    assert.equal(notifications.rows[0]?.count, 1);

    // Claim/reclaim against the real table: an expired worker cannot mutate a
    // new owner's terminal outcome or consume its persistence retry budget.
    const leasedRequestId = randomUUID();
    const leasedAttemptId = randomUUID();
    await pool.query(`
      INSERT INTO ${schema}.generation_requests (
        id, user_id, project_id, shot_id, media_kind, prompt, reference_media_ids,
        reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash
      ) VALUES ($1, $2, $3, $4, 'audio', '租约 CAS', '[]'::jsonb, '[]'::jsonb,
        '{"originalDurationSeconds":2,"format":"mp3","sampleRate":24000,"speakerId":"zh_female_test"}'::jsonb,
        1, 's43-lease-cas', repeat('c', 64))
    `, [leasedRequestId, userId, projectId, shotId]);
    await pool.query(`
      INSERT INTO ${schema}.generation_attempts (
        id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
        provider_response, estimated_cost_fen, retryable, next_poll_at, price_snapshot
      ) VALUES ($1, $2, 1, 'openspeech', 'openspeech-tts-test', '{}'::jsonb, 1,
        'running', 'persisting', '{}'::jsonb, 46, true, now() - interval '1 minute', $3::jsonb)
    `, [leasedAttemptId, leasedRequestId, JSON.stringify(audioPriceSnapshot(pricingRuleId))]);
    assert.equal(await repository.claimNextRecoverableAttempt("s43-stale-worker", 60, true), leasedAttemptId);
    await pool.query(`
      UPDATE ${schema}.generation_attempts
      SET lease_until = now() - interval '1 second'
      WHERE id = $1
    `, [leasedAttemptId]);
    assert.equal(await repository.claimNextRecoverableAttempt("s43-current-worker", 60, true), leasedAttemptId);
    await repository.markProviderFailed({
      attemptId: leasedAttemptId,
      errorCode: "CURRENT_WORKER_TERMINAL",
      errorMessage: "current worker completed the attempt",
      leaseOwner: "s43-current-worker",
    });
    await assert.rejects(
      () => repository.markPersisting(leasedAttemptId, "s43-stale-worker"),
      (error: unknown) => error instanceof GenerationAttemptLeaseLostError,
    );
    await assert.rejects(
      () => repository.recordPersistenceFailure(leasedAttemptId, "stale worker fault", "s43-stale-worker"),
      (error: unknown) => error instanceof GenerationAttemptLeaseLostError,
    );
    const leaseCasOutcome = await pool.query<{
      status: string;
      phase: string;
      error_code: string;
      retryable: boolean;
      provider_response: { metadata?: { persistenceRetryCount?: number } };
    }>(`
      SELECT status, phase, error_code, retryable, provider_response
      FROM ${schema}.generation_attempts WHERE id = $1
    `, [leasedAttemptId]);
    assert.deepEqual(leaseCasOutcome.rows[0], {
      status: "failed",
      phase: "complete",
      error_code: "CURRENT_WORKER_TERMINAL",
      retryable: false,
      provider_response: {},
    });

    // A lease may expire before another worker has had a chance to reclaim
    // the row.  That alone must fence durable media writes: ownership string
    // equality is insufficient because the database clock has already ended
    // the lease.  This is a real PostgreSQL assertion, not a fake repository
    // branch test.
    const expiredWriterRequestId = randomUUID();
    const expiredWriterAttemptId = randomUUID();
    await pool.query(`
      INSERT INTO ${schema}.generation_requests (
        id, user_id, project_id, shot_id, media_kind, prompt, reference_media_ids,
        reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash
      ) VALUES ($1, $2, $3, $4, 'audio', '过期写入栅栏', '[]'::jsonb, '[]'::jsonb,
        '{"originalDurationSeconds":2,"format":"mp3","sampleRate":24000,"speakerId":"zh_female_test"}'::jsonb,
        1, 's49-expired-write', repeat('f', 64))
    `, [expiredWriterRequestId, userId, projectId, shotId]);
    await pool.query(`
      INSERT INTO ${schema}.generation_attempts (
        id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
        provider_response, estimated_cost_fen, retryable, next_poll_at, lease_owner, lease_until, price_snapshot
      ) VALUES ($1, $2, 1, 'openspeech', 'openspeech-tts-test', '{}'::jsonb, 1,
        'running', 'persisting',
        '{"status":"succeeded","media":[{"kind":"audio","providerResultKey":"expired-writer-audio","inlineContent":{"contentBase64":"ZXhwaXJlZC13cml0ZXItYXVkaW8=","contentType":"audio/mpeg"}}]}',
        46, true, now(), 's49-expired-worker', now() - interval '1 second', $3::jsonb)
    `, [expiredWriterAttemptId, expiredWriterRequestId, JSON.stringify(audioPriceSnapshot(pricingRuleId))]);
    await repository.recordTosObjectUpload(expiredWriterAttemptId, {
      providerResultKey: "expired-writer-audio",
      storageBucket: "s49-test-bucket",
      objectKey: "s49/expired-writer.mp3",
      producedAt: new Date(),
    }, "s49-expired-worker");
    await assert.rejects(
      () => repository.saveMediaResult(expiredWriterAttemptId, {
        providerResultKey: "expired-writer-audio",
        mediaKind: "audio",
        storageBucket: "s49-test-bucket",
        storagePath: "s49/expired-writer.mp3",
        storageUrl: "https://tos.example.test/s49/expired-writer.mp3",
        sha256: "e".repeat(64),
        mimeType: "audio/mpeg",
      }, "s49-expired-worker"),
      (error: unknown) => error instanceof GenerationAttemptLeaseLostError,
    );
    const expiredWriterMedia = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM ${schema}.media_results WHERE attempt_id = $1
    `, [expiredWriterAttemptId]);
    assert.equal(expiredWriterMedia.rows[0]?.count, 0);
    const expiredWriterOrphan = await pool.query<{ cleanup_status: string }>(`
      SELECT cleanup_status
      FROM ${schema}.generation_tos_orphans
      WHERE attempt_id = $1 AND object_key = 's49/expired-writer.mp3'
    `, [expiredWriterAttemptId]);
    assert.deepEqual(expiredWriterOrphan.rows, [{ cleanup_status: "pending_cleanup" }]);
    await repository.cancelForActor(userId, expiredWriterRequestId, projectId);

    // Both linearizations of cancel versus a worker write are protected by
    // the real PostgreSQL state CAS: cancel revokes the lease and a late
    // worker cannot revive the row; a late cancel cannot overwrite a terminal
    // worker result. The unowned mutation proves the legacy image/video
    // caller shape is also terminal-safe without changing active behavior.
    const cancelledRequestId = randomUUID();
    const cancelledAttemptId = randomUUID();
    await pool.query(`
      INSERT INTO ${schema}.generation_requests (
        id, user_id, project_id, shot_id, media_kind, prompt, reference_media_ids,
        reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash
      ) VALUES ($1, $2, $3, $4, 'audio', '取消 CAS', '[]'::jsonb, '[]'::jsonb,
        '{"originalDurationSeconds":2,"format":"mp3","sampleRate":24000,"speakerId":"zh_female_test"}'::jsonb,
        1, 's43-cancel-cas', repeat('d', 64))
    `, [cancelledRequestId, userId, projectId, shotId]);
    await pool.query(`
      INSERT INTO ${schema}.generation_attempts (
        id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
        provider_response, estimated_cost_fen, retryable, next_poll_at, lease_owner, lease_until, price_snapshot
      ) VALUES ($1, $2, 1, 'openspeech', 'openspeech-tts-test', '{}'::jsonb, 1,
        'running', 'persisting',
        '{"media":[{"providerResultKey":"cancel-inline-audio","inlineContent":{"contentBase64":"Y2FuY2VsbGVkLWF1ZGlvLWJ5dGVz","contentType":"audio/mpeg"}}]}'::jsonb,
        46, true, now(), 's43-cancelled-worker', now() + interval '1 minute', $3::jsonb)
    `, [cancelledAttemptId, cancelledRequestId, JSON.stringify(audioPriceSnapshot(pricingRuleId))]);
    await repository.cancelForActor(userId, cancelledRequestId, projectId);
    const cancelledBeforeLateWrites = await pool.query<{
      status: string;
      phase: string;
      error_code: string;
      retryable: boolean;
      next_poll_at: Date | null;
      lease_owner: string | null;
      lease_until: Date | null;
      provider_response: {
        media?: Array<{ inlineContent?: unknown }>;
        metadata?: { inlineMediaAudit?: Array<{ byteLength?: number; sha256?: string; contentType?: string }> };
      };
    }>(`
      SELECT status, phase, error_code, retryable, next_poll_at, lease_owner, lease_until, provider_response
      FROM ${schema}.generation_attempts WHERE id = $1
    `, [cancelledAttemptId]);
    assert.deepEqual(cancelledBeforeLateWrites.rows[0], {
      status: "cancelled",
      phase: "complete",
      error_code: "CANCELLED_BY_USER",
      retryable: false,
      next_poll_at: null,
      lease_owner: null,
      lease_until: null,
      provider_response: {
        media: [{ providerResultKey: "cancel-inline-audio" }],
        metadata: {
          inlineMediaAudit: [{
            providerResultKey: "cancel-inline-audio",
            contentType: "audio/mpeg",
            byteLength: Buffer.byteLength("cancelled-audio-bytes"),
            sha256: "49a362397dee0b66e8d1b612683c8217802742dd9be722ad5af519a10a09238b",
          }],
        },
      },
    });
    await assert.rejects(
      () => repository.markPersisting(cancelledAttemptId, "s43-cancelled-worker"),
      (error: unknown) => error instanceof GenerationAttemptLeaseLostError,
    );
    await repository.markProviderFailed({
      attemptId: cancelledAttemptId,
      errorCode: "LATE_WORKER_FAILURE",
      errorMessage: "must not revive a cancelled attempt",
    });
    const cancelledAfterLateWrites = await pool.query<{
      status: string;
      phase: string;
      error_code: string;
      lease_owner: string | null;
    }>(`
      SELECT status, phase, error_code, lease_owner
      FROM ${schema}.generation_attempts WHERE id = $1
    `, [cancelledAttemptId]);
    assert.deepEqual(cancelledAfterLateWrites.rows[0], {
      status: "cancelled",
      phase: "complete",
      error_code: "CANCELLED_BY_USER",
      lease_owner: null,
    });
    await repository.cancelForActor(userId, leasedRequestId, projectId);
    const terminalAfterLateCancel = await pool.query<{
      status: string;
      phase: string;
      error_code: string;
    }>(`
      SELECT status, phase, error_code
      FROM ${schema}.generation_attempts WHERE id = $1
    `, [leasedAttemptId]);
    assert.deepEqual(terminalAfterLateCancel.rows[0], {
      status: "failed",
      phase: "complete",
      error_code: "CURRENT_WORKER_TERMINAL",
    });
    assert.equal(await repository.claimNextRecoverableAttempt("s43-test-worker", 60, true), null);

    // A slow provider submit must keep a database lease alive.  This uses two
    // actual GenerationWorkers and the real table: after the original three-
    // second lease would have expired, worker B still cannot reclaim it, and
    // the provider-facing submit callback ran exactly once.
    const heartbeatRequestId = randomUUID();
    const heartbeatAttemptId = randomUUID();
    await pool.query(`
      INSERT INTO ${schema}.generation_requests (
        id, user_id, project_id, shot_id, media_kind, prompt, reference_media_ids,
        reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash
      ) VALUES ($1, $2, $3, $4, 'audio', '慢提交心跳', '[]'::jsonb, '[]'::jsonb,
        '{"originalDurationSeconds":2,"format":"mp3","sampleRate":24000,"speakerId":"zh_female_test"}'::jsonb,
        1, 's49-heartbeat', repeat('e', 64))
    `, [heartbeatRequestId, userId, projectId, shotId]);
    await pool.query(`
      INSERT INTO ${schema}.generation_attempts (
        id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
        provider_response, estimated_cost_fen, retryable, next_poll_at, price_snapshot
      ) VALUES ($1, $2, 1, 'openspeech', 'openspeech-tts-test', '{}'::jsonb, 1,
        'pending', 'created', '{}'::jsonb, 46, true, now(), $3::jsonb)
    `, [
      heartbeatAttemptId,
      heartbeatRequestId,
      JSON.stringify(audioPriceSnapshot(pricingRuleId)),
    ]);
    let providerSubmitCount = 0;
    const slowProvider = {
      submit: async () => {
        providerSubmitCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 4_500));
        return { outcome: "accepted" as const, providerTaskId: "s49-provider-task" };
      },
      query: async () => ({ status: "pending" as const, media: [] }),
    };
    const slowService = new GenerationService({
      repository,
      provider: slowProvider,
      storage: { uploadBytes: async () => ({ bucket: "unused", storagePath: "unused", storageUrl: "https://example.test/unused" }) },
      aigcLabeler: testAigcLabeler(),
      budgetLimitFen: 50_000,
    });
    const workerDiagnostics: unknown[] = [];
    const workerLogger = {
      info: () => {},
      warn: (value: unknown) => { workerDiagnostics.push(value); },
      error: (value: unknown) => { workerDiagnostics.push(value); },
    };
    const workerA = new GenerationWorker(drizzle(pool) as unknown as Database, workerLogger, {
      repository,
      service: slowService,
      workerId: "s49-worker-a",
      // Production configuration enforces >=180 seconds. This isolated test
      // override makes the slow submit cross a lease boundary while leaving
      // enough scheduling margin for loaded Docker runners.
      leaseSeconds: 3,
      pollIntervalMs: 10_000,
      allowPaidGeneration: true,
      executionEnabled: () => true,
    });
    const workerB = new GenerationWorker(drizzle(pool) as unknown as Database, workerLogger, {
      repository,
      service: slowService,
      workerId: "s49-worker-b",
      leaseSeconds: 3,
      pollIntervalMs: 10_000,
      allowPaidGeneration: true,
      executionEnabled: () => true,
    });
    workerA.start();
    try {
      await waitFor(() => providerSubmitCount === 1, 10_000);
    } catch {
      const state = await pool.query(`
        SELECT status, phase, error_code, lease_owner, lease_until
        FROM ${schema}.generation_attempts WHERE id = $1
      `, [heartbeatAttemptId]);
      assert.fail(`worker submit did not start: ${JSON.stringify({
        state: state.rows[0] ?? null,
        workerDiagnostics,
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_150));
    workerB.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await repository.claimNextRecoverableAttempt("s49-observer", 1, true), null);
    assert.equal(providerSubmitCount, 1);
    await workerB.stop();
    await workerA.stop();
  } finally {
    await app.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

test("真链: Seed Audio deployment alias restores provider duration capability after persistence", {
  skip: !integrationTestDatabaseUrl,
  timeout: 120_000,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabaseUrl(integrationTestDatabaseUrl);
  assertSafeTestSchema(settings.postgresSchema);

  const fixture = await mp3Fixture();
  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schema = quoteIdentifier(settings.postgresSchema);
  const userId = randomUUID();
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const shotId = randomUUID();
  const pricingRuleId = randomUUID();
  const referenceAssetId = randomUUID();
  const referenceMediaId = randomUUID();
  const repository = new PostgresGenerationRepository(
    drizzle(pool) as unknown as Database,
    1_000,
    true,
    () => {},
    1,
  );
  const endpoint = "https://openspeech.bytedance.com/api/v3/tts/create";
  const fetchBodies: Record<string, unknown>[] = [];
  const uploaded: Buffer[] = [];
  const provider = new SeedAudioProvider({
    apiKey: "seed-audio-v3-test-key",
    endpoint,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), endpoint);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["X-Api-Key"], "seed-audio-v3-test-key");
      assert.match(headers["X-Api-Request-Id"] ?? "", /^[0-9a-f-]{36}$/);
      assert.equal(headers.Authorization, undefined);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      fetchBodies.push(body);
      return jsonResponse({
        code: 0,
        url: "https://provider.example.test/seed-audio-result.mp3",
        // The frozen quote is two seconds. Seed Audio decides actual output
        // duration from the prompt/reference, so this records a delta rather
        // than tripping the legacy TTS ±1-second terminal gate.
        duration: 70,
        original_duration: 3.1,
        subtitle: {
          sentences: [{
            text: "请把这一段旁白读得平静坚定。",
            start_time: 0,
            end_time: 2_000,
          }],
        },
      }, 200, { "X-Tt-Logid": "seed-audio-v3-log-1" });
    },
  });
  const workerService = new GenerationService({
    repository,
    provider,
    storage: {
      uploadBytes: async ({ content, storagePath }) => {
        uploaded.push(content);
        return {
          bucket: "seed-audio-v3-test-bucket",
          storagePath,
          storageUrl: `https://tos.example.test/${storagePath}`,
        };
      },
    },
    mediaDownloader: async (url) => {
      assert.equal(url, "https://provider.example.test/seed-audio-result.mp3");
      return {
        content: fixture.bytes,
        contentType: "audio/mpeg",
        byteLength: fixture.bytes.byteLength,
        extension: "mp3",
      };
    },
    aigcLabeler: new AigcMetadataLabeler(),
    budgetLimitFen: 50_000,
  });
  const app = Fastify({ logger: false });

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await applyMigrations(pool, settings.postgresSchema, await migrationFilesThroughCurrent());
    await pool.query(`
      INSERT INTO ${schema}.config_entries (
        id, kind, entry_key, status, sort, payload, source, created_at, updated_at
      ) VALUES ($1, 'provider_cost_basis', 'test-seed-audio-deployment-alias', 'published', 99, $2::jsonb, 'test-only', now(), now())
    `, [randomUUID(), JSON.stringify({
      provider: "openspeech",
      model: "seed-audio-prod-deployment-alias",
      media_kind: "audio",
      parameter_match: { format: ["mp3", "wav", "pcm"] },
      billing_unit: "millisecond",
      usage_keys: ["original_duration_ms"],
      unit_price_cny_micros: 1_000_000,
      unit_size: 60_000,
      currency: "CNY",
      fallback: { kind: "requested_duration_ms" },
      source_url: "https://www.volcengine.com/docs/6561/1359370",
    })]);
    await seedAudioProject(pool, {
      schema,
      userId,
      projectId,
      episodeId,
      shotId,
      pricingRuleId,
      provider: "openspeech",
      model: "seed-audio-prod-deployment-alias",
      tierId: "aud-seed-audio-v3-2s",
      sampleRate: 48_000,
    });
    await seedApprovedPersonalImageReference(pool, {
      schema,
      assetId: referenceAssetId,
      mediaId: referenceMediaId,
      userId,
    });

    app.addHook("preHandler", async (request) => {
      request.authUser = { id: userId, username: "seed-audio-v3-user", displayName: "Seed Audio V3", role: "member" };
      request.authSessionId = "11111111-1111-4111-8111-111111111111";
      request.authContext = {
        user: request.authUser,
        credential: {
          sessionId: request.authSessionId,
          source: "web",
          actorKind: "human",
          agentType: null,
          userAgent: "openspeech-audio-chain-postgres-test",
          expiresAt: new Date("2027-08-03T00:00:00.000Z"),
        },
      };
    });
    await registerGenerationRoutes(app, () => drizzle(pool) as unknown as Database, {
      createRepository: () => repository,
      createProjectAccessService: () => ({
        require: async (_actor, requestedProjectId) => ({
          projectId: requestedProjectId,
          actorId: userId,
          platformRole: "member" as const,
          membershipRole: "owner" as const,
          isPlatformObserver: false,
        }),
      }),
      requireSubmissionReady: () => {},
    });

    const payload = {
      media_kind: "audio",
      tier_id: "aud-seed-audio-v3-2s",
      project_id: projectId,
      episode_id: episodeId,
      shot_id: shotId,
      prompt: "请把这一段旁白读得平静坚定。",
      parameters: {
        original_duration_seconds: 2,
        format: "mp3",
        sample_rate: 48_000,
        enable_subtitle: true,
        aigc_metadata_enabled: true,
        aigc_watermark_enabled: false,
      },
      reference_media_ids: [referenceMediaId],
      quantity: 1,
      client_idempotency_key: "seed-audio-v3-chain-key",
    };
    const estimate = await app.inject({ method: "POST", url: "/api/v1/generations/estimate", payload });
    assert.equal(estimate.statusCode, 200, estimate.body);
    const quoteId = (estimate.json() as { data: { generation_quote_id: string } }).data.generation_quote_id;
    const confirmed = await app.inject({ method: "POST", url: `/api/v1/generation-quotes/${quoteId}/confirm` });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/generations",
      payload: { ...payload, generation_quote_id: quoteId },
    });
    assert.equal(submitted.statusCode, 202, submitted.body);
    const attemptId = (submitted.json() as { data: { current_attempt_id: string } }).data.current_attempt_id;

    const completed = await workerService.runRecoverableAttempt(attemptId);
    assert.equal(completed.status, "succeeded");
    assert.equal(fetchBodies.length, 1);
    assert.deepEqual(fetchBodies[0], {
      model: "seed-audio-prod-deployment-alias",
      text_prompt: "请把这一段旁白读得平静坚定。",
      references: [{ image_url: `https://tos.example.test/assets/${referenceMediaId}.png` }],
      audio_config: {
        format: "mp3",
        sample_rate: 48_000,
        enable_subtitle: true,
      },
      watermark: {
        aigc_watermark: false,
        aigc_metadata: { enable: false },
      },
    });
    assert.equal(uploaded.length, 1);
    const implicitLabel = readAigcImplicitLabel(uploaded[0]!, "audio", "mp3");
    assert.deepEqual(Object.keys(implicitLabel), [
      "Label",
      "ContentProducer",
      "ProduceID",
      "ReservedCode1",
      "ContentPropagator",
      "PropagateID",
      "ReservedCode2",
    ]);
    assert.equal(implicitLabel.ProduceID, `generation-attempt:${attemptId}:media:0`);
    assert.equal(implicitLabel.PropagateID, `generation-attempt:${attemptId}:media:0`);

    const persisted = await pool.query<{
      provider: string;
      model: string;
      provider_response: {
        usage?: { original_duration_ms?: number };
        media?: Array<{ actualDurationMs?: number; durationDeltaMs?: number }>;
      };
      storage_bucket: string;
      storage_path: string;
      aigc_evidence: string | null;
      audio_status: string;
      audio_evidence: string | null;
      tos_bucket: string;
      object_key: string;
      cleanup_status: string;
    }>(`
      SELECT a.provider, a.model, a.provider_response,
             mr.storage_bucket, mr.storage_path,
             mr.compliance_metadata->>'aigcMetadataEvidence' AS aigc_evidence,
             av.status AS audio_status,
             av.compliance_metadata->>'aigcMetadataEvidence' AS audio_evidence,
             o.storage_bucket AS tos_bucket, o.object_key, o.cleanup_status
      FROM ${schema}.generation_attempts a
      JOIN ${schema}.media_results mr ON mr.attempt_id = a.id
      JOIN ${schema}.audio_versions av ON av.media_result_id = mr.id
      JOIN ${schema}.generation_tos_orphans o ON o.media_result_id = mr.id
      WHERE a.id = $1
    `, [attemptId]);
    assert.equal(persisted.rows.length, 1);
    assert.deepEqual({
      provider: persisted.rows[0]?.provider,
      model: persisted.rows[0]?.model,
      storageBucket: persisted.rows[0]?.storage_bucket,
      storagePath: persisted.rows[0]?.storage_path,
      mediaAigcEvidence: persisted.rows[0]?.aigc_evidence,
      audioStatus: persisted.rows[0]?.audio_status,
      audioAigcEvidence: persisted.rows[0]?.audio_evidence,
      tosBucket: persisted.rows[0]?.tos_bucket,
      tosObjectKey: persisted.rows[0]?.object_key,
      tosCleanupStatus: persisted.rows[0]?.cleanup_status,
    }, {
      provider: "openspeech",
      model: "seed-audio-prod-deployment-alias",
      storageBucket: "seed-audio-v3-test-bucket",
      storagePath: persisted.rows[0]?.storage_path,
      mediaAigcEvidence: "platform_applied",
      audioStatus: "candidate",
      audioAigcEvidence: "platform_applied",
      tosBucket: "seed-audio-v3-test-bucket",
      tosObjectKey: persisted.rows[0]?.object_key,
      tosCleanupStatus: "referenced",
    });
    assert.match(
      persisted.rows[0]?.storage_path ?? "",
      new RegExp(`^projects/${projectId}/shots/${shotId}/audio/[a-z0-9-]+/0\\.mp3$`),
    );
    assert.equal(persisted.rows[0]?.storage_path, persisted.rows[0]?.object_key);
    assert.equal(persisted.rows[0]?.provider_response.usage?.original_duration_ms, 3_100);
    assert.equal(persisted.rows[0]?.provider_response.media?.[0]?.actualDurationMs, 70_000);
    assert.equal(persisted.rows[0]?.provider_response.media?.[0]?.durationDeltaMs, 68_000);
    const restored = await repository.getRecoverableAttempt(attemptId);
    const restoredMedia = restored?.attempt.providerResult?.media[0];
    assert.deepEqual(restoredMedia?.audioDurationPolicy, {
      source: "provider_reported",
      maxDurationMs: 120_000,
    });
    assert.deepEqual(
      restored && restoredMedia
        ? assertAudioProviderMediaIntegrity(restored.request.input, restoredMedia)
        : undefined,
      { actualDurationMs: 70_000, durationDeltaMs: 68_000 },
    );

    const providerCost = await pool.query<{
      calculation_status: string;
      usage_source: string;
      usage_quantity: number;
      cost_cny_micros: number;
      cost_fen_rounded: number;
      requires_attention: boolean;
    }>(`
      SELECT calculation_status, usage_source, usage_quantity::integer AS usage_quantity,
             cost_cny_micros::integer AS cost_cny_micros,
             cost_fen_rounded, requires_attention
      FROM ${schema}.provider_costs
      WHERE generation_attempt_id = $1
    `, [attemptId]);
    assert.deepEqual(providerCost.rows, [{
      calculation_status: "confirmed",
      usage_source: "provider_reported",
      usage_quantity: 3_100,
      cost_cny_micros: 51_667,
      cost_fen_rounded: 5,
      requires_attention: false,
    }]);

    const userCharge = await pool.query<{
      estimated_cost_fen: number;
      charged_points: number;
    }>(`
      SELECT q.estimated_cost_fen, r.charged_points
      FROM ${schema}.generation_quotes q
      JOIN ${schema}.generation_requests r ON r.id = q.generation_request_id
      WHERE q.id = $1
    `, [quoteId]);
    assert.deepEqual(userCharge.rows, [{ estimated_cost_fen: 46, charged_points: 46 }]);
  } finally {
    await app.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
    await fixture.dispose();
  }
});

async function seedApprovedPersonalImageReference(
  pool: Pool,
  input: { schema: string; assetId: string; mediaId: string; userId: string },
): Promise<void> {
  await pool.query(`
    INSERT INTO ${input.schema}.asset_entities (
      id, owner_user_id, visibility, asset_kind, role, usage_mode, name,
      display_name, style_tags, approved, reuse_scope, status, metadata,
      created_at, updated_at, use_count
    ) VALUES (
      $1, $2, 'personal', 'reference', 'character_identity', 'reference', 'Seed Audio 人物参考',
      'Seed Audio 人物参考', '[]'::jsonb, true, 'all_projects', 'approved', '{}'::jsonb,
      now(), now(), 0
    )
  `, [input.assetId, input.userId]);
  await pool.query(`
    INSERT INTO ${input.schema}.asset_media (
      id, asset_entity_id, asset_variant_id, media_kind, view_angle, title,
      storage_bucket, storage_path, storage_url, width_px, height_px,
      format, sha256, is_primary, approved, sort_order, metadata, created_at
    ) VALUES (
      $1, $2, NULL, 'image', 'unknown', 'Seed Audio 人物参考',
      'seed-audio-test', $3, $4, 6001, 2400,
      'png', $5, true, true, 0, '{}'::jsonb, now()
    )
  `, [
    input.mediaId,
    input.assetId,
    `assets/${input.mediaId}.png`,
    `https://tos.example.test/assets/${input.mediaId}.png`,
    input.mediaId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
  ]);
}

async function seedAudioProject(
  pool: Pool,
  input: {
    schema: string;
    userId: string;
    projectId: string;
    episodeId: string;
    shotId: string;
    pricingRuleId: string;
    provider?: string;
    model?: string;
    tierId?: string;
    sampleRate?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO ${input.schema}.users (id, username, display_name, password_hash, active, role)
     VALUES ($1, 's43-audio-user', 'S43 Audio', 'test-only', true, 'member')`,
    [input.userId],
  );
  await pool.query(
    `UPDATE ${input.schema}.user_credit_accounts
     SET balance_points = 50000, daily_limit_points = 50000, updated_at = now()
     WHERE user_id = $1`,
    [input.userId],
  );
  await pool.query(
    `INSERT INTO ${input.schema}.projects (id, owner_user_id, name, status)
     VALUES ($1, $2, 'S43 音频真链测试', 'active')`,
    [input.projectId, input.userId],
  );
  await pool.query(
    `INSERT INTO ${input.schema}.episodes (id, project_id, episode_no, sort_order, status)
     VALUES ($1, $2, 1, 1, 'active')`,
    [input.episodeId, input.projectId],
  );
  await pool.query(
    `INSERT INTO ${input.schema}.shots (id, episode_id, shot_code, sort_order)
     VALUES ($1, $2, 'S43-A01', 1)`,
    [input.shotId, input.episodeId],
  );
  await pool.query(
    `INSERT INTO ${input.schema}.pricing_rules (
      id, provider, model, media_kind, billing_unit, unit_price_fen, currency,
      source, active, effective_from, effective_to, metadata, created_at, updated_at
    ) VALUES ($1, $2, $3, 'audio', 'second', 23, 'CNY',
      's43-test', true, now() - interval '1 minute', NULL, $4::jsonb, now(), now())`,
    [input.pricingRuleId, input.provider ?? "openspeech", input.model ?? "openspeech-tts-test", JSON.stringify({
      capability_tier: {
        tier_id: input.tierId ?? "aud-openspeech-2s",
        params: {
          quantity: 1,
          original_duration_seconds: 2,
          format: "mp3",
          sample_rate: input.sampleRate ?? 24000,
          enable_subtitle: true,
          aigc_metadata_enabled: true,
          aigc_watermark_enabled: false,
        },
        status: "active",
      },
    })],
  );
}

async function mp3Fixture(): Promise<{ bytes: Buffer; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "seed-audio-chain-"));
  const file = path.join(directory, "fixture.mp3");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.1",
    "-f",
    "mp3",
    "-id3v2_version",
    "4",
    "-y",
    file,
  ]);
  return {
    bytes: await readFile(file),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

async function seedPersistedAudioAttempt(input: {
  pool: Pool;
  schema: string;
  repository: PostgresGenerationRepository;
  userId: string;
  projectId: string;
  shotId: string;
  pricingRuleId: string;
  fixtureName: string;
}): Promise<{ attemptId: string; requestId: string; storagePath: string }> {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  const providerResultKey = `${input.fixtureName}-${randomUUID()}`;
  const requestHash = randomUUID().replaceAll("-", "").repeat(2);
  await input.pool.query(`
    INSERT INTO ${input.schema}.generation_requests (
      id, user_id, project_id, shot_id, media_kind, prompt, reference_media_ids,
      reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash
    ) VALUES ($1, $2, $3, $4, 'audio', $5, '[]'::jsonb, '[]'::jsonb,
      '{"originalDurationSeconds":2,"format":"mp3","sampleRate":24000,"speakerId":"zh_female_test"}'::jsonb,
      1, $6, $7)
  `, [requestId, input.userId, input.projectId, input.shotId, input.fixtureName, `${input.fixtureName}-${randomUUID()}`, requestHash]);
  await input.pool.query(`
    INSERT INTO ${input.schema}.generation_attempts (
      id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
      provider_response, estimated_cost_fen, retryable, price_snapshot
    ) VALUES ($1, $2, 1, 'openspeech', 'openspeech-tts-test', '{}'::jsonb, 1,
      'running', 'persisting', $3::jsonb, 46, false, $4::jsonb)
  `, [attemptId, requestId, JSON.stringify({
    status: "succeeded",
    media: [{
      kind: "audio",
      providerResultKey,
      inlineContent: {
        contentBase64: Buffer.from("s49-persisted-audio").toString("base64"),
        contentType: "audio/mpeg",
      },
    }],
  }), JSON.stringify(audioPriceSnapshot(input.pricingRuleId))]);
  const storagePath = `s49/${attemptId}.mp3`;
  await input.repository.recordTosObjectUpload(attemptId, {
    providerResultKey,
    storageBucket: "s49-test-bucket",
    objectKey: storagePath,
    producedAt: new Date(),
  });
  await input.repository.saveMediaResult(attemptId, {
    providerResultKey,
    mediaKind: "audio",
    storageBucket: "s49-test-bucket",
    storagePath,
    storageUrl: `https://tos.example.test/${storagePath}`,
    sha256: "a".repeat(64),
    mimeType: "audio/mpeg",
  });
  return { attemptId, requestId, storagePath };
}

function audioPriceSnapshot(pricingRuleId: string): Record<string, unknown> {
  return {
    tierId: "aud-openspeech-2s",
    pricingRuleId,
    provider: "openspeech",
    model: "openspeech-tts-test",
    mediaKind: "audio",
    billingUnit: "second",
    unitPriceFen: 23,
    billableUnits: 2,
    estimatedCostFen: 46,
    currency: "CNY",
  };
}

function assertLocalTestDatabaseUrl(value: string): void {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  assert.ok(
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1",
    "AUDIO_CHAIN_TEST_DATABASE_URL 只能指向本机一次性测试库",
  );
}

function assertSafeTestSchema(value: string): void {
  assert.match(
    value,
    /^s43_audio_chain_test(?:_[a-z0-9_]+)?$/,
    "真链测试只允许专用 s43_audio_chain_test schema，拒绝清理 app/common 等业务 schema",
  );
}

async function migrationFilesThroughCurrent(): Promise<string[]> {
  return (await readdir(path.resolve("migrations")))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName))
    .sort((left, right) => left.localeCompare(right));
}

async function applyMigrations(executor: Pick<Pool, "query">, schemaName: string, fileNames: readonly string[]): Promise<void> {
  for (const fileName of fileNames) {
    const source = await readFile(path.resolve("migrations", fileName), "utf8");
    await executor.query(renderMigrationSql(source, schemaName));
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for worker submit");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function testAigcLabeler(): GenerationAigcLabeler {
  return {
    apply: async (input) => ({
      content: Buffer.concat([input.content, Buffer.from(`|aigc:${input.contentId}`)]),
      complianceMetadata: {
        aigcMetadataEnabled: true,
        aigcMetadataEvidence: "platform_applied",
        contentId: input.contentId,
        contentProducer: "001191110000802044347C00000",
        schemaVersion: "GB45438-2025-Appendix-E",
      },
    }),
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
