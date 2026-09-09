import assert from "node:assert/strict";
import test from "node:test";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../../db/client.js";
import { toHttpErrorResponse } from "../../http/errorResponse.js";
import { AppError } from "../../shared/errors.js";
import { registerAuthRoutes, type AuthServicePort } from "./routes.js";
import type { WecomAuthPort } from "./wecomService.js";

const userId = "22222222-2222-4222-8222-222222222222";
const nonceCookie = "__Host-wecom_oauth_nonce";

test("status always returns the server capability envelope", async () => {
  const app = await routeApp(wecomStub({ status: () => ({ enabled: false }) }));
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/wecom/status" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, data: { enabled: false } });
  } finally { await app.close(); }
});

test("route registration keeps one app-scoped WeCom service across requests", async () => {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  let creations = 0;
  await registerAuthRoutes(app, () => ({} as Database), {
    createService: ordinaryAuthStub,
    createWecomService: () => {
      creations += 1;
      return wecomStub();
    },
  });
  try {
    await app.inject({ method: "GET", url: "/api/v1/auth/wecom/status" });
    await app.inject({ method: "GET", url: "/api/v1/auth/wecom/status" });
    assert.equal(creations, 1);
  } finally { await app.close(); }
});

test("authorize sets the frozen host cookie and redirects without exposing the nonce", async () => {
  const app = await routeApp(wecomStub({
    authorize: async () => ({
      location: "https://provider.test/authorize",
      nonce: "browser-nonce",
      expiresInSeconds: 180,
    }),
  }));
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/wecom/authorize?return_to=%2Fprojects" });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "https://provider.test/authorize");
    const setCookie = String(response.headers["set-cookie"]);
    assert.match(setCookie, /^__Host-wecom_oauth_nonce=browser-nonce;/u);
    assert.match(setCookie, /Max-Age=180/u);
    assert.match(setCookie, /Path=\//u);
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /Secure/u);
    assert.match(setCookie, /SameSite=Lax/u);
    assert.doesNotMatch(setCookie, /Domain=/u);
    assert.equal(response.headers.location?.includes("browser-nonce"), false);
  } finally { await app.close(); }
});

test("callback emits only one-time result and safe redirect in fragment", async () => {
  let callbackInput: unknown;
  const app = await routeApp(wecomStub({
    callback: async (input) => {
      callbackInput = input;
      return { result: "opaque/result", returnPath: "/lite/projects?tab=mine" };
    },
  }));
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/wecom/callback?code=provider-code&state=opaque-state",
      headers: { cookie: `${nonceCookie}=browser-nonce` },
    });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers.location, "/landing#wecom_result=opaque%2Fresult&redirect=%2Flite%2Fprojects%3Ftab%3Dmine");
    assert.deepEqual(callbackInput, { code: "provider-code", state: "opaque-state", nonce: "browser-nonce" });
    assert.equal(response.headers.location?.includes("provider-code"), false);
  } finally { await app.close(); }
});

test("callback maps expected failures to stable fragments without supplier text", async () => {
  const app = await routeApp(wecomStub({
    callback: async () => { throw new AppError(503, "wecom_provider_unavailable", "supplier secret detail"); },
  }));
  try {
    const providerFailure = await app.inject({
      method: "GET",
      url: "/api/v1/auth/wecom/callback?code=code&state=state",
      headers: { cookie: `${nonceCookie}=nonce` },
    });
    assert.equal(providerFailure.statusCode, 303);
    assert.equal(providerFailure.headers.location, "/landing#wecom_error=wecom_provider_unavailable");
    assert.equal(providerFailure.headers.location?.includes("supplier"), false);

    const malformed = await app.inject({ method: "GET", url: "/api/v1/auth/wecom/callback?state=state" });
    assert.equal(malformed.statusCode, 303);
    assert.equal(malformed.headers.location, "/landing#wecom_error=wecom_transaction_invalid");
  } finally { await app.close(); }
});

test("exchange has a strict body and uses the nonce cookie", async () => {
  let exchangeInput: unknown;
  const app = await routeApp(wecomStub({
    exchange: async (input) => {
      exchangeInput = input;
      return sessionResult();
    },
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wecom/exchange",
      headers: { cookie: `${nonceCookie}=browser-nonce`, "user-agent": "browser-test" },
      payload: { result: "opaque-result" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(exchangeInput, { result: "opaque-result", nonce: "browser-nonce", userAgent: "browser-test" });
    assert.equal(response.json().data.token, "platform-token");

    const extra = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wecom/exchange",
      payload: { result: "opaque-result", code: "must-not-be-accepted" },
    });
    assert.equal(extra.statusCode, 400);
    assert.equal(extra.json().error.code, "invalid_request");
  } finally { await app.close(); }
});

test("prebind is restricted to human administrators and keeps a strict body", async () => {
  let prebindInput: unknown;
  const wecom = wecomStub({
    prebind: async (actor, targetUserId, wecomUserId) => {
      prebindInput = { actor, targetUserId, wecomUserId };
      return { user_id: targetUserId, bound: true };
    },
  });

  const adminApp = await routeApp(wecom, "admin", "web");
  try {
    const response = await adminApp.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${userId}/wecom-identity`,
      payload: { wecom_user_id: "zhangsan" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(prebindInput, {
      actor: { userId, sessionId: "33333333-3333-4333-8333-333333333333" },
      targetUserId: userId,
      wecomUserId: "zhangsan",
    });
    const extra = await adminApp.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${userId}/wecom-identity`,
      payload: { wecom_user_id: "zhangsan", corp_id: "forbidden" },
    });
    assert.equal(extra.statusCode, 400);
  } finally { await adminApp.close(); }

  const memberApp = await routeApp(wecom, "member", "web");
  try {
    const response = await memberApp.inject({ method: "PUT", url: `/api/v1/admin/users/${userId}/wecom-identity`, payload: { wecom_user_id: "zhangsan" } });
    assert.equal(response.statusCode, 403);
  } finally { await memberApp.close(); }

  const agentApp = await routeApp(wecom, "admin", "agent");
  try {
    const response = await agentApp.inject({ method: "PUT", url: `/api/v1/admin/users/${userId}/wecom-identity`, payload: { wecom_user_id: "zhangsan" } });
    assert.equal(response.statusCode, 403);
  } finally { await agentApp.close(); }
});

async function routeApp(
  wecom: WecomAuthPort,
  role?: "admin" | "member",
  source: "web" | "agent" = "web",
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const normalized = toHttpErrorResponse(error);
    return reply.code(normalized.statusCode).send({ ok: false, error: normalized.body });
  });
  if (role) {
    app.addHook("preHandler", async (request) => {
      request.authUser = { id: userId, username: "actor", displayName: "Actor", role };
      request.authSessionId = "33333333-3333-4333-8333-333333333333";
      request.authContext = {
        user: request.authUser,
        credential: {
          sessionId: request.authSessionId,
          source,
          actorKind: source === "agent" ? "agent" : "human",
          agentType: source === "agent" ? "test-agent" : null,
          userAgent: null,
          expiresAt: new Date("2026-08-23T00:00:00.000Z"),
        },
      };
    });
  }
  await registerAuthRoutes(app, () => ({} as Database), {
    createService: ordinaryAuthStub,
    createWecomService: () => wecom,
  });
  return app;
}

function wecomStub(overrides: Partial<WecomAuthPort> = {}): WecomAuthPort {
  return {
    status: () => ({ enabled: true }),
    authorize: async () => ({ location: "https://provider.test/authorize", nonce: "browser-nonce", expiresInSeconds: 300 }),
    callback: async () => ({ result: "opaque-result", returnPath: "/projects" }),
    exchange: async () => sessionResult(),
    prebind: async (_actor, targetUserId) => ({ user_id: targetUserId, bound: true }),
    ...overrides,
  };
}

function ordinaryAuthStub(): AuthServicePort {
  const unavailable = async () => { throw new Error("ordinary auth is outside this test"); };
  return {
    requestEmailVerification: unavailable,
    register: unavailable,
    login: unavailable,
    loginCli: unavailable,
    issueAgentCredential: unavailable,
    listAgentCredentials: unavailable,
    revokeAgentCredential: unavailable,
    logout: unavailable,
    getUiMode: unavailable,
    updateUiMode: unavailable,
  } as unknown as AuthServicePort;
}

function sessionResult() {
  return {
    token: "platform-token",
    expires_at: "2026-08-23T00:00:00.000Z",
    user: { id: userId, username: "member", display_name: "成员", role: "member" as const, ui_mode: "full" as const },
  };
}
