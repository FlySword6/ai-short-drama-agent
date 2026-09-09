import assert from "node:assert/strict";
import test from "node:test";
import { WecomAdapter, WecomProviderError, type WecomRequest } from "./wecom.js";

function jsonResponse(payload: unknown) {
  return { statusCode: 200, body: { json: async () => payload, dump: async () => undefined } };
}

test("WeCom authorization URL uses the frozen corporate OAuth parameters", () => {
  const adapter = new WecomAdapter({
    corpId: "ww-corp",
    agentId: "1000002",
    corpSecret: "not-used",
    callbackUrl: "https://example.test/api/v1/auth/wecom/callback",
  });
  const rendered = adapter.authorizationUrl("opaque-state");
  const [rawUrl, fragment] = rendered.split("#");
  const url = new URL(rawUrl!);
  assert.equal(url.origin, "https://open.weixin.qq.com");
  assert.equal(url.searchParams.get("appid"), "ww-corp");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.test/api/v1/auth/wecom/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "snsapi_base");
  assert.equal(url.searchParams.get("state"), "opaque-state");
  assert.equal(url.searchParams.get("agentid"), "1000002");
  assert.equal(fragment, "wechat_redirect");
});

test("access token is cached and concurrent exchanges share one token request", async () => {
  let tokenRequests = 0;
  const request: WecomRequest = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/gettoken")) {
      tokenRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ errcode: 0, access_token: "provider-token", expires_in: 7200 });
    }
    if (url.pathname.endsWith("/getuserinfo")) {
      return jsonResponse({ errcode: 0, UserId: url.searchParams.get("code") });
    }
    return jsonResponse({ errcode: 0, name: `成员-${url.searchParams.get("userid")}` });
  };
  const adapter = adapterWith(request);
  const members = await Promise.all([adapter.exchangeCode("one"), adapter.exchangeCode("two")]);
  assert.equal(tokenRequests, 1);
  assert.deepEqual(members.map((item) => item.userId), ["one", "two"]);
  assert.deepEqual(await adapter.getMemberProfile("one"), { userId: "one", displayName: "成员-one" });
  await adapter.exchangeCode("three");
  assert.equal(tokenRequests, 1);
});

test("authorization code is sent once and provider details are normalized", async () => {
  const requested: string[] = [];
  const idempotency: Array<boolean | undefined> = [];
  const request: WecomRequest = async (input, options) => {
    const url = new URL(input);
    requested.push(url.toString());
    idempotency.push(options.idempotent);
    assert.equal(options.headersTimeout, 37);
    assert.equal(options.bodyTimeout, 37);
    assert.equal(options.signal.aborted, false);
    if (url.pathname.endsWith("/gettoken")) return jsonResponse({ access_token: "token", expires_in: 7200 });
    throw new Error("supplier said secret=do-not-leak");
  };
  const adapter = adapterWith(request, 37);
  await assert.rejects(adapter.exchangeCode("one-time-code"), (error: unknown) => {
    assert.ok(error instanceof WecomProviderError);
    assert.equal(error.reason, "provider_unavailable");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(requested.filter((url) => url.includes("code=one-time-code")).length, 1);
  assert.deepEqual(idempotency, [undefined, false]);
});

test("the adapter applies one bounded timeout signal to provider requests", async () => {
  const request: WecomRequest = async (_input, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  // AbortSignal.timeout() uses an unref'ed timer. Keep the event loop alive so
  // an isolated test process observes the production timeout instead of being
  // cancelled by the Node test runner before the abort fires.
  const keepAlive = setTimeout(() => undefined, 1_000);
  const startedAt = Date.now();
  try {
    await assert.rejects(adapterWith(request, 10).exchangeCode("code"), (error: unknown) => {
      assert.ok(error instanceof WecomProviderError);
      assert.equal(error.reason, "provider_unavailable");
      return true;
    });
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("non-member and missing profile are mapped to stable failures", async () => {
  const nonMember = adapterWith(async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/gettoken")) return jsonResponse({ access_token: "token", expires_in: 7200 });
    return jsonResponse({ errcode: 60011, errmsg: "raw supplier detail" });
  });
  await assert.rejects(nonMember.exchangeCode("code"), (error: unknown) => {
    assert.ok(error instanceof WecomProviderError);
    assert.equal(error.reason, "member_not_allowed");
    return true;
  });

  const incomplete = adapterWith(async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/gettoken")) return jsonResponse({ access_token: "token", expires_in: 7200 });
    if (url.pathname.endsWith("/getuserinfo")) return jsonResponse({ UserId: "member-1" });
    return jsonResponse({ name: "" });
  });
  const identity = await incomplete.exchangeCode("code");
  await assert.rejects(incomplete.getMemberProfile(identity.userId), (error: unknown) => {
    assert.ok(error instanceof WecomProviderError);
    assert.equal(error.reason, "profile_incomplete");
    return true;
  });
});

test("profile permission failures map to profile_incomplete", async () => {
  for (const errcode of [60011, 48002]) {
    const adapter = adapterWith(async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/gettoken")) return jsonResponse({ access_token: "token", expires_in: 7200 });
      return jsonResponse({ errcode, errmsg: "raw supplier detail" });
    });
    await assert.rejects(adapter.getMemberProfile("prebound-member"), (error: unknown) => {
      assert.ok(error instanceof WecomProviderError);
      assert.equal(error.reason, "profile_incomplete");
      return true;
    });
  }
});

test("non-2xx provider responses are drained before the connection is released", async () => {
  let dumped = false;
  const adapter = adapterWith(async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/gettoken")) return jsonResponse({ access_token: "token", expires_in: 7200 });
    return {
      statusCode: 503,
      body: {
        json: async () => { throw new Error("body must not be parsed"); },
        dump: async () => { dumped = true; },
      },
    };
  });
  await assert.rejects(adapter.exchangeCode("one-time-code"), (error: unknown) => {
    assert.ok(error instanceof WecomProviderError);
    assert.equal(error.reason, "provider_unavailable");
    return true;
  });
  assert.equal(dumped, true);
});

function adapterWith(request: WecomRequest, timeoutMs = 5_000): WecomAdapter {
  return new WecomAdapter({
    corpId: "ww-corp",
    agentId: "1000002",
    corpSecret: "provider-secret",
    callbackUrl: "https://example.test/api/v1/auth/wecom/callback",
    request,
    timeoutMs,
  });
}
