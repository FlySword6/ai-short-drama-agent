import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import {
  agentSessions,
  episodes,
  generationAttempts,
  generationQuotes,
  generationRequests,
  pricingRules,
  projects,
  sessions,
  shots,
  users,
} from "../src/db/schema.js";
import { hashSessionToken } from "../src/modules/auth/service.js";
import {
  effectivePaidBudgetFen,
  workerDependenciesReady,
} from "../src/modules/generation/factory.js";
import { PostgresGenerationRepository } from "../src/modules/generation/repository.js";
import { GenerationService } from "../src/modules/generation/service.js";
import type { SubmitGenerationInput } from "../src/modules/generation/types.js";

const databaseUrl = process.env.ASSISTANT_QUOTE_SUBMIT_TEST_DATABASE_URL;
const canRun = Boolean(
  databaseUrl
  && settings.allowPaidGeneration
  && settings.arkImageModel
  && workerDependenciesReady()
  && effectivePaidBudgetFen() > 0,
);

test("助手页面按钮从冻结报价直接提交，重放不重复预留费用", { skip: !canRun }, async () => {
  assert.ok(databaseUrl);
  assert.ok(settings.arkImageModel);
  const handle = createDatabase(databaseUrl);
  const db = handle.db;
  const now = new Date();
  const ids = {
    owner: randomUUID(),
    project: randomUUID(),
    episode: randomUUID(),
    shot: randomUUID(),
    session: randomUUID(),
    siblingSession: randomUUID(),
    price: randomUUID(),
  };
  const token = `assistant-submit-${randomUUID()}`;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;

  try {
    await db.insert(users).values({
      id: ids.owner,
      username: `assistant-submit-${ids.owner.slice(0, 8)}`,
      displayName: "助手报价提交测试",
      passwordHash: "test-only-hash",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessions).values({
      id: randomUUID(),
      userId: ids.owner,
      tokenHash: hashSessionToken(token),
      credentialSource: "web",
      agentType: null,
      userAgent: "assistant-generation-quote-submit-db-test",
      credentialLabel: null,
      issuedBySessionId: null,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      revokedAt: null,
      createdAt: now,
    });
    await db.insert(projects).values({
      id: ids.project,
      ownerUserId: ids.owner,
      name: `助手报价-${ids.project.slice(0, 8)}`,
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
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
      shotCode: "AQ01",
      title: "助手报价分镜",
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
    await db.insert(agentSessions).values([
      agentSessionValues(ids.session, ids.owner, ids.project, ids.shot, now),
      agentSessionValues(ids.siblingSession, ids.owner, ids.project, ids.shot, now),
    ]);
    await db.insert(pricingRules).values({
      id: ids.price,
      provider: "ark",
      model: settings.arkImageModel,
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 1,
      currency: "CNY",
      source: "assistant-quote-submit-db-test",
      active: true,
      effectiveFrom: new Date(now.getTime() - 1_000),
      effectiveTo: null,
      metadata: { test_only: true },
      createdAt: now,
      updatedAt: now,
    });

    const service = quoteOnlyService(db);
    const quote = await service.quoteSubmission(
      { userId: ids.owner },
      generationInput(ids, settings.arkImageModel, "assistant-direct-submit"),
      "assistant",
      ids.session,
    );
    app = await createApp({ databaseHandle: handle, logger: false, startGenerationWorker: false });

    const [first, concurrentReplay] = await Promise.all([
      post(app, token, `/api/v1/agent/sessions/${ids.session}/generation-quotes/${quote.id}/submit`),
      post(app, token, `/api/v1/agent/sessions/${ids.session}/generation-quotes/${quote.id}/submit`),
    ]);
    assert.equal(first.statusCode, 202, first.body);
    assert.equal(concurrentReplay.statusCode, 202, concurrentReplay.body);
    const firstData = responseData(first);
    const replayData = responseData(concurrentReplay);
    assert.equal(replayData.generation_request_id, firstData.generation_request_id);
    assert.equal(replayData.current_attempt_id, firstData.current_attempt_id);
    assert.equal(firstData.status, "pending");
    assert.equal("normalized_request" in firstData, false);
    assert.equal("prompt" in firstData, false);

    const persistedRequests = await db.select().from(generationRequests)
      .where(eq(generationRequests.id, firstData.generation_request_id as string));
    assert.equal(persistedRequests.length, 1);
    assert.equal(persistedRequests[0]?.clientIdempotencyKey, `confirmation:${quote.id}`);
    const attempts = await db.select().from(generationAttempts)
      .where(eq(generationAttempts.requestId, firstData.generation_request_id as string));
    assert.equal(attempts.length, 1);
    const consumedQuote = (await db.select().from(generationQuotes)
      .where(eq(generationQuotes.id, quote.id)))[0];
    assert.equal(consumedQuote?.status, "consumed");
    assert.equal(consumedQuote?.generationAttemptId, firstData.current_attempt_id);

    const wrongSession = await post(
      app,
      token,
      `/api/v1/agent/sessions/${ids.siblingSession}/generation-quotes/${quote.id}/submit`,
    );
    assert.equal(wrongSession.statusCode, 404);

    const wrongSource = await service.quoteSubmission(
      { userId: ids.owner },
      generationInput(ids, settings.arkImageModel, "assistant-wrong-source"),
      "web",
    );
    const wrongSourceResponse = await post(
      app,
      token,
      `/api/v1/agent/sessions/${ids.session}/generation-quotes/${wrongSource.id}/submit`,
    );
    assert.equal(wrongSourceResponse.statusCode, 404);

    const tampered = await service.quoteSubmission(
      { userId: ids.owner },
      generationInput(ids, settings.arkImageModel, "assistant-tampered"),
      "assistant",
      ids.session,
    );
    await db.update(generationQuotes).set({
      normalizedRequest: {
        ...tampered.normalizedRequest,
        prompt: "被篡改的提示词",
      },
    }).where(eq(generationQuotes.id, tampered.id));
    const tamperedResponse = await post(
      app,
      token,
      `/api/v1/agent/sessions/${ids.session}/generation-quotes/${tampered.id}/submit`,
    );
    assert.equal(tamperedResponse.statusCode, 409);
    assert.equal(responseErrorCode(tamperedResponse), "GENERATION_QUOTE_INVALID_SNAPSHOT");
    const unchangedQuote = (await db.select().from(generationQuotes)
      .where(eq(generationQuotes.id, tampered.id)))[0];
    assert.equal(unchangedQuote?.status, "pending_confirmation");
    assert.equal(unchangedQuote?.confirmedAt, null);
  } finally {
    await app?.close();
    await handle.pool.end();
  }
});

function quoteOnlyService(db: ReturnType<typeof createDatabase>["db"]): GenerationService {
  return new GenerationService({
    repository: new PostgresGenerationRepository(db, 5_000),
    provider: {
      submit: async () => { throw new Error("测试不允许调用方舟"); },
      query: async () => { throw new Error("测试不允许调用方舟"); },
    },
    storage: {
      uploadBytes: async () => { throw new Error("测试不允许写入存储"); },
    },
    budgetLimitFen: 50_000_000,
  });
}

function generationInput(
  ids: { project: string; episode: string; shot: string },
  model: string,
  key: string,
): SubmitGenerationInput {
  return {
    projectId: ids.project,
    episodeId: ids.episode,
    shotId: ids.shot,
    mediaKind: "image",
    model,
    prompt: "雨夜街道上的人物",
    parameters: { ratio: "16:9" },
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    quantity: 1,
    clientIdempotencyKey: key,
  };
}

function agentSessionValues(
  id: string,
  userId: string,
  projectId: string,
  shotId: string,
  now: Date,
) {
  return {
    id,
    userId,
    authSessionId: null,
    agentType: "platform_assistant",
    userAgent: "assistant-generation-quote-submit-db-test",
    projectId,
    shotId,
    title: "助手报价测试会话",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function post(app: Awaited<ReturnType<typeof createApp>>, token: string, url: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

function responseData(response: { json(): unknown }): Record<string, unknown> {
  const body = response.json() as { ok?: boolean; data?: unknown };
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.ok(body.data && typeof body.data === "object");
  return body.data as Record<string, unknown>;
}

function responseErrorCode(response: { json(): unknown }): string | undefined {
  const body = response.json() as { error?: { code?: unknown } };
  return typeof body.error?.code === "string" ? body.error.code : undefined;
}
