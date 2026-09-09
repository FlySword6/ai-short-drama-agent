import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { generationAttempts, pricingRules } from "../src/db/schema.js";
import { settings } from "../src/config/env.js";
import { createAssistantToolServices } from "../src/modules/assistant/services.js";

if (!settings.allowPaidGeneration) {
  throw new Error("Validation requires ALLOW_PAID_GENERATION=true, but it never starts the worker or calls Ark");
}
if (!settings.arkImageModel) throw new Error("Validation requires ARK_IMAGE_MODEL");
const noPaidSentinel = "local-no-paid-validation";
const expectedNoPaidSettings = [
  settings.arkApiKey,
  settings.tosBucket,
  settings.tosAccessKey,
  settings.tosSecretKey,
];
if (expectedNoPaidSettings.some((value) => value !== noPaidSentinel)) {
  throw new Error("No-paid validation requires explicit local-only Ark and TOS sentinel credentials");
}
if (
  settings.arkBaseUrl !== "https://example.invalid"
  || settings.tosEndpoint !== "https://example.invalid"
  || settings.tosPublicBaseUrl !== "https://example.invalid/no-paid"
) {
  throw new Error("No-paid validation requires non-routable example.invalid provider endpoints");
}

const databaseHandle = createDatabase();
await runMigrations(databaseHandle);
const app = await createApp({ databaseHandle, logger: false, startGenerationWorker: false });

try {
  const now = new Date();
  await databaseHandle.db.insert(pricingRules).values({
    id: crypto.randomUUID(),
    provider: "ark",
    model: settings.arkImageModel,
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 123,
    currency: "CNY",
    source: "local-no-paid-validation",
    active: true,
    effectiveFrom: new Date(now.getTime() - 1_000),
    effectiveTo: null,
    metadata: { validation_only: true },
    createdAt: now,
    updatedAt: now,
  });

  const register = await request("POST", "/api/v1/auth/register", {
    username: "v01_tester",
    password: "test-pass-123",
    display_name: "V0.1 Tester",
  });
  assert.equal(register.statusCode, 201);

  const login = await request("POST", "/api/v1/auth/login", {
    username: "v01_tester",
    password: "test-pass-123",
  });
  assert.equal(login.statusCode, 200);
  const loginData = data(login);
  const token = loginData.token as string;
  const actorId = (loginData.user as { id: string }).id;
  assert.ok(token);

  const project = data(await authed("POST", "/api/v1/projects", token, {
    name: "无付费验收项目",
    description: "只验证本地持久化和幂等",
  }));
  const episode = data(await authed("POST", `/api/v1/projects/${project.id as string}/episodes`, token, {
    episode_no: 1,
    name: "第1集",
  }));
  const scene = data(await authed("POST", `/api/v1/episodes/${episode.id as string}/scenes`, token, {
    scene_no: 1,
    name: "测试场",
  }));
  const shot = data(await authed("POST", `/api/v1/episodes/${episode.id as string}/shots`, token, {
    shot_no: "TJ1-2",
    scene_id: scene.id,
    title: "无付费分镜",
    image_prompt: "一名角色站在雨夜街头",
  }));

  const assistantSessionResponse = await authed("POST", "/api/v1/agent/sessions", token, {
    project_id: project.id,
    episode_id: episode.id,
    shot_id: shot.id,
  });
  assert.equal(assistantSessionResponse.statusCode, 201);
  const assistantSession = data(assistantSessionResponse);
  const assistantMessages = await authed(
    "GET",
    `/api/v1/agent/sessions/${assistantSession.session_id as string}/messages`,
    token,
  );
  assert.equal((data(assistantMessages).items as unknown[]).length, 0);
  const assistantWithoutCredentials = await authed(
    "POST",
    `/api/v1/agent/sessions/${assistantSession.session_id as string}/messages`,
    token,
    { content: "帮我检索雨夜角色资产" },
  );
  assert.equal(assistantWithoutCredentials.statusCode, 503);
  assert.ok(["assistant_model_missing", "assistant_not_configured"].includes(errorCode(assistantWithoutCredentials) ?? ""));

  const assistantGenerationInput = {
    actorId,
    assistantSessionId: assistantSession.session_id as string,
    projectId: project.id as string,
    shotId: shot.id as string,
    mediaKind: "image" as const,
    prompt: "一名角色站在雨夜街头",
    referenceMediaIds: [],
    parameters: { ratio: "16:9" },
    clientIdempotencyKey: "assistant-validation-estimate",
  };
  const assistantQuote = await createAssistantToolServices(databaseHandle.db)
    .generateMedia(assistantGenerationInput) as Record<string, unknown>;
  assert.equal(assistantQuote.status, "pending_confirmation");
  assert.equal(assistantQuote.confirmation_required, true);
  assert.equal(assistantQuote.estimated_cost_fen, 123);
  assert.equal(assistantQuote.currency, "CNY");
  assert.equal(assistantQuote.media_kind, "image");
  const assistantQuoteId = assistantQuote.generation_quote_id;
  assert.equal(typeof assistantQuoteId, "string");
  const otherAssistantSession = data(await authed("POST", "/api/v1/agent/sessions", token, {
    project_id: project.id,
    episode_id: episode.id,
    shot_id: shot.id,
    title: "另一个助手会话",
  }));
  await assert.rejects(
    createAssistantToolServices(databaseHandle.db).generateMedia({
      ...assistantGenerationInput,
      assistantSessionId: otherAssistantSession.session_id as string,
      clientIdempotencyKey: `confirmation:${assistantQuoteId as string}`,
      generationQuoteId: assistantQuoteId as string,
    }),
    /当前助手会话没有这张生成费用报价单/,
  );
  await assert.rejects(
    createAssistantToolServices(databaseHandle.db).generateMedia({
      ...assistantGenerationInput,
      clientIdempotencyKey: `confirmation:${assistantQuoteId as string}`,
      generationQuoteId: assistantQuoteId as string,
    }),
    /请先明确确认这张生成费用报价单/,
  );
  const assistantConfirmed = await authed(
    "POST",
    `/api/v1/generation-quotes/${assistantQuoteId as string}/confirm`,
    token,
  );
  assert.equal(data(assistantConfirmed).status, "confirmed");
  const assistantSubmission = await createAssistantToolServices(databaseHandle.db).generateMedia({
    ...assistantGenerationInput,
    clientIdempotencyKey: `confirmation:${assistantQuoteId as string}`,
    generationQuoteId: assistantQuoteId as string,
  }) as Record<string, unknown>;
  assert.equal(assistantSubmission.submitted, true);
  const assistantReplay = await createAssistantToolServices(databaseHandle.db).generateMedia({
    ...assistantGenerationInput,
    clientIdempotencyKey: `confirmation:${assistantQuoteId as string}`,
    generationQuoteId: assistantQuoteId as string,
  }) as Record<string, unknown>;
  assert.equal(assistantReplay.generation_request_id, assistantSubmission.generation_request_id);
  assert.equal(assistantReplay.attempt_no, assistantSubmission.attempt_no);

  const estimate = await authed("POST", "/api/v1/generations/estimate", token, {
    media_kind: "image",
    parameters: { ratio: "16:9" },
    quantity: 1,
  });
  assert.equal(estimate.statusCode, 200);
  assert.equal(data(estimate).estimated_cost_fen, 123);

  const input = {
    media_kind: "image",
    project_id: project.id,
    episode_id: episode.id,
    scene_id: scene.id,
    shot_id: shot.id,
    prompt: "一名角色站在雨夜街头",
    reference_media_ids: [],
    parameters: { ratio: "16:9" },
    client_idempotency_key: "validation-first-submit",
  };
  const webQuote = await authed("POST", "/api/v1/generations/estimate", token, {
    ...input,
    source: "web",
  });
  assert.equal(webQuote.statusCode, 200);
  assert.equal(data(webQuote).status, "pending_confirmation");
  const webQuoteId = data(webQuote).generation_quote_id as string;
  const webConfirmed = await authed(
    "POST",
    `/api/v1/generation-quotes/${webQuoteId}/confirm`,
    token,
  );
  assert.equal(data(webConfirmed).status, "confirmed");

  const first = await authed("POST", "/api/v1/generations", token, {
    ...input,
    generation_quote_id: webQuoteId,
  });
  assert.equal(first.statusCode, 202);
  const firstData = data(first);
  assert.equal(firstData.status, "pending");
  assert.equal(firstData.attempt_no, 1);

  const repeated = await authed("POST", "/api/v1/generations", token, {
    ...input,
    generation_quote_id: webQuoteId,
  });
  assert.equal(repeated.statusCode, 202);
  assert.equal(data(repeated).current_attempt_id, firstData.current_attempt_id);

  const conflict = await authed("POST", "/api/v1/generations", token, {
    ...input,
    prompt: "改变后的提示词",
    generation_quote_id: webQuoteId,
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(errorCode(conflict), "GENERATION_QUOTE_CONFLICT");

  const cancelled = await authed(
    "POST",
    `/api/v1/generations/${firstData.generation_request_id as string}/cancel`,
    token,
  );
  assert.equal(data(cancelled).status, "cancelled");

  const retryQuote = await authed("POST", "/api/v1/generations/estimate", token, {
    action: "retry",
    source: "web",
    original_request_id: firstData.generation_request_id,
  });
  assert.equal(data(retryQuote).status, "pending_confirmation");
  const retryQuoteId = data(retryQuote).generation_quote_id as string;
  const retryConfirmed = await authed(
    "POST",
    `/api/v1/generation-quotes/${retryQuoteId}/confirm`,
    token,
  );
  assert.equal(data(retryConfirmed).status, "confirmed");
  const retryBody = {
    client_idempotency_key: `confirmation:${retryQuoteId}`,
    generation_quote_id: retryQuoteId,
  };
  const retry = await authed(
    "POST",
    `/api/v1/generations/${firstData.generation_request_id as string}/retry`,
    token,
    retryBody,
  );
  assert.equal(retry.statusCode, 202);
  assert.equal(data(retry).attempt_no, 2);

  const retryRepeated = await authed(
    "POST",
    `/api/v1/generations/${firstData.generation_request_id as string}/retry`,
    token,
    retryBody,
  );
  assert.equal(data(retryRepeated).current_attempt_id, data(retry).current_attempt_id);

  const detail = await authed(
    "GET",
    `/api/v1/generations/${firstData.generation_request_id as string}`,
    token,
  );
  assert.equal((data(detail).attempts as unknown[]).length, 2);

  const attempts = await databaseHandle.db.select().from(generationAttempts);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((attempt) => attempt.providerTaskId === null));

  process.stdout.write(JSON.stringify({
    ok: true,
    migrations: "applied",
    auth: "passed",
    production_crud: "passed",
    assistant_session_and_no_credentials_gate: "passed",
    assistant_quote_button_confirmation_and_replay: "passed",
    estimate: "passed",
    idempotency: "passed",
    retry_idempotency: "passed",
    paid_provider_calls: 0,
    attempts: attempts.length,
  }, null, 2) + "\n");
} finally {
  await app.close();
  await databaseHandle.pool.end();
}

async function request(method: string, url: string, body?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function authed(method: string, url: string, token: string, body?: unknown) {
  return request(method, url, body, token);
}

function data(response: { json(): unknown }): Record<string, unknown> {
  const body = response.json() as { ok?: boolean; data?: unknown };
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.ok(body.data && typeof body.data === "object");
  return body.data as Record<string, unknown>;
}

function errorCode(response: { json(): unknown }): string | undefined {
  const body = response.json() as { error?: { code?: string } };
  return body.error?.code;
}
