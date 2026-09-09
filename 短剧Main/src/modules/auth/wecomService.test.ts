import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { AppError } from "../../shared/errors.js";
import { WecomProviderError } from "../../integrations/wecom.js";
import type { AuthRepository } from "./repository.js";
import { hashOpaqueValue, normalizeReturnPath, WecomAuthService, wecomUsername, type WecomAuthConfiguration } from "./wecomService.js";

const configuration: WecomAuthConfiguration = {
  enabled: true,
  corpId: "ww-corp",
  agentId: "1000002",
  corpSecret: "provider-secret",
  callbackUrl: "https://example.test/api/v1/auth/wecom/callback",
  stateTtlSeconds: 300,
  sessionTtlHours: 24,
};

test("status fails closed unless the switch and every startup value are present", async () => {
  const repository = {} as AuthRepository;
  const disabled = service(repository, { ...configuration, enabled: false });
  assert.deepEqual(disabled.status(), { enabled: false });
  await assert.rejects(disabled.authorize(), hasCode("wecom_login_disabled"));
  assert.deepEqual(service(repository, { ...configuration, corpSecret: undefined }).status(), { enabled: false });
  assert.deepEqual(service(repository).status(), { enabled: true });
});

test("authorize stores only hashes, keeps the safe return path and emits adapter URL", async () => {
  const now = new Date("2026-08-23T01:02:03.000Z");
  let captured: Record<string, unknown> | undefined;
  const repository = {
    createWecomAuthTransaction: async (input: Record<string, unknown>) => { captured = input; return "tx"; },
  } as unknown as AuthRepository;
  const auth = service(repository, configuration, () => now);
  const result = await auth.authorize("/lite/projects?tab=mine");
  assert.equal(result.location, `https://provider.test/?state=${encodeURIComponent(result.location.split("state=")[1]!)}`);
  assert.equal(captured?.returnPath, "/lite/projects?tab=mine");
  assert.equal(captured?.stateHash, hashOpaqueValue(result.location.slice(result.location.indexOf("state=") + 6)));
  assert.equal(captured?.browserNonceHash, hashOpaqueValue(result.nonce));
  assert.equal(JSON.stringify(captured).includes(result.nonce), false);
  assert.equal((captured?.expiresAt as Date).toISOString(), "2026-08-23T01:07:03.000Z");
  assert.equal(result.expiresInSeconds, 300);
});

test("callback consumes state before one provider exchange and maps provider failures", async () => {
  let exchanges = 0;
  const repository = {
    consumeWecomCallback: async () => ({ kind: "consumed", transactionId: "tx", returnPath: "/projects" }),
    resolveWecomIdentityAndIssueResult: async () => ({ kind: "resolved", created: true, user: {} }),
  } as unknown as AuthRepository;
  const auth = new WecomAuthService({} as Database, {
    repository,
    configuration,
    adapter: {
      authorizationUrl: (state) => `https://provider.test/?state=${state}`,
      exchangeCode: async () => { exchanges += 1; throw new WecomProviderError("member_not_allowed"); },
      getMemberProfile: async () => { throw new Error("profile must not run"); },
    },
  });
  await assert.rejects(auth.callback({ code: "once", state: "state", nonce: "nonce" }), hasCode("wecom_member_not_allowed"));
  assert.equal(exchanges, 1);
});

test("callback maps cancellation and every adapter failure without supplier details", async () => {
  const repository = {
    consumeWecomCallback: async () => ({ kind: "consumed", transactionId: "tx", returnPath: "/projects" }),
  } as unknown as AuthRepository;
  await assert.rejects(service(repository).callback({ code: "authdeny", state: "state", nonce: "nonce" }), hasCode("wecom_authorization_cancelled"));
  for (const [reason, code] of [
    ["profile_incomplete", "wecom_profile_incomplete"],
    ["provider_unavailable", "wecom_provider_unavailable"],
  ] as const) {
    const auth = new WecomAuthService({} as Database, {
      repository,
      configuration,
      adapter: {
        authorizationUrl: (state) => `https://provider.test/?state=${state}`,
        exchangeCode: async () => { throw new WecomProviderError(reason); },
        getMemberProfile: async () => { throw new Error("profile must not run"); },
      },
    });
    await assert.rejects(auth.callback({ code: "once", state: "state", nonce: "nonce" }), hasCode(code));
  }
});

test("transaction states and result exchange preserve stable error codes", async () => {
  for (const [kind, code] of [["invalid", "wecom_transaction_invalid"], ["expired", "wecom_transaction_expired"], ["replayed", "wecom_transaction_replayed"]] as const) {
    const callbackRepository = { consumeWecomCallback: async () => ({ kind }) } as unknown as AuthRepository;
    await assert.rejects(service(callbackRepository).callback({ code: "code", state: "state", nonce: "nonce" }), hasCode(code));

    const exchangeRepository = { exchangeWecomResultForSession: async () => ({ kind }) } as unknown as AuthRepository;
    await assert.rejects(service(exchangeRepository).exchange({ result: "result", nonce: "nonce" }), hasCode(code));
  }
});

test("prebound identity skips unreadable profile and completes callback plus exchange", async () => {
  const now = new Date("2026-08-23T02:00:00.000Z");
  let profileCalls = 0;
  let resolutionInput: { displayName: string; resultExpiresAt: Date } | undefined;
  const repository = {
    consumeWecomCallback: async () => ({ kind: "consumed", transactionId: "tx", returnPath: "/projects" }),
    findWecomIdentity: async () => ({ displayName: "管理员命名" }),
    resolveWecomIdentityAndIssueResult: async (input: { displayName: string; resultExpiresAt: Date }) => {
      resolutionInput = input;
      return { kind: "resolved", created: false, user: {} };
    },
    exchangeWecomResultForSession: async () => ({
      kind: "exchanged",
      sessionId: "session",
      user: { id: "user", username: "bound", displayName: "管理员命名", role: "member", uiMode: "lite" },
    }),
  } as unknown as AuthRepository;
  const auth = new WecomAuthService({} as Database, {
    repository,
    configuration,
    now: () => now,
    adapter: {
      authorizationUrl: (state) => `https://provider.test/?state=${state}`,
      exchangeCode: async () => ({ userId: "prebound-member" }),
      getMemberProfile: async () => {
        profileCalls += 1;
        throw new WecomProviderError("profile_incomplete");
      },
    },
  });

  const callback = await auth.callback({ code: "once", state: "state", nonce: "nonce" });
  assert.equal(profileCalls, 0);
  assert.equal(resolutionInput?.displayName, "管理员命名");
  assert.equal(resolutionInput?.resultExpiresAt.toISOString(), "2026-08-23T02:01:00.000Z");
  const exchanged = await auth.exchange({ result: callback.result, nonce: "nonce" });
  assert.equal(exchanged.user.display_name, "管理员命名");
  assert.equal(exchanged.user.ui_mode, "lite");
  assert.equal(exchanged.expires_at, "2026-08-24T02:00:00.000Z");
});

test("JIT identity conflict and disabled account preserve stable errors", async () => {
  const conflictRepository = {
    consumeWecomCallback: async () => ({ kind: "consumed", transactionId: "tx", returnPath: "/projects" }),
    findWecomIdentity: async () => undefined,
    resolveWecomIdentityAndIssueResult: async () => ({ kind: "identity_conflict" }),
  } as unknown as AuthRepository;
  await assert.rejects(
    service(conflictRepository).callback({ code: "code", state: "state", nonce: "nonce" }),
    hasCode("wecom_identity_conflict"),
  );

  const disabledRepository = {
    exchangeWecomResultForSession: async () => ({ kind: "account_disabled" }),
  } as unknown as AuthRepository;
  await assert.rejects(
    service(disabledRepository).exchange({ result: "result", nonce: "nonce" }),
    hasCode("wecom_account_disabled"),
  );
});

test("stored return path is revalidated before provider and identity side effects", async () => {
  let providerCalls = 0;
  let identityCalls = 0;
  const repository = {
    consumeWecomCallback: async () => ({
      kind: "consumed",
      transactionId: "tx",
      returnPath: "/safe/..//evil.test/path",
    }),
    findWecomIdentity: async () => { identityCalls += 1; return undefined; },
    resolveWecomIdentityAndIssueResult: async () => { identityCalls += 1; return { kind: "resolved" }; },
  } as unknown as AuthRepository;
  const auth = new WecomAuthService({} as Database, {
    repository,
    configuration,
    adapter: {
      authorizationUrl: (state) => `https://provider.test/?state=${state}`,
      exchangeCode: async () => { providerCalls += 1; return { userId: "member" }; },
      getMemberProfile: async (userId) => { providerCalls += 1; return { userId, displayName: "成员" }; },
    },
  });
  await assert.rejects(
    auth.callback({ code: "code", state: "state", nonce: "nonce" }),
    hasCode("invalid_request"),
  );
  assert.equal(providerCalls, 0);
  assert.equal(identityCalls, 0);
});

test("return_to rejects external, protocol-relative, fragment and encoded bypasses", () => {
  assert.equal(normalizeReturnPath("/projects?view=mine"), "/projects?view=mine");
  for (const value of ["https://evil.test/", "//evil.test/", "/\\evil", "/%2f%2fevil", "/%252f%252fevil", "/projects#token", "/safe/..//evil.test/path"]) {
    assert.throws(() => normalizeReturnPath(value));
  }
  assert.equal(wecomUsername("corp", "member"), wecomUsername("corp", "member"));
  assert.notEqual(wecomUsername("corp", "member"), wecomUsername("corp", "other"));
});

function service(
  repository: AuthRepository,
  customConfiguration = configuration,
  now?: () => Date,
): WecomAuthService {
  return new WecomAuthService({} as Database, {
    repository,
    configuration: customConfiguration,
    now,
    adapter: {
      authorizationUrl: (state) => `https://provider.test/?state=${state}`,
      exchangeCode: async () => ({ userId: "member" }),
      getMemberProfile: async (userId) => ({ userId, displayName: "成员" }),
    },
  });
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}
