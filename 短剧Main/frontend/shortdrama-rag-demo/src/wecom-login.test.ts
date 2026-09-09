import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

const happyWindow = new Window({ url: "http://localhost/landing?redirect=%2Fprojects%2Fp1" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).Event = happyWindow.Event;
(globalThis as Record<string, unknown>).CustomEvent = happyWindow.CustomEvent;
(globalThis as Record<string, unknown>).MouseEvent = happyWindow.MouseEvent;
(globalThis as Record<string, unknown>).PopStateEvent = happyWindow.PopStateEvent;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, StrictMode } = await import("react");
(globalThis as Record<string, unknown>).React = await import("react");
const { createRoot } = await import("react-dom/client");
const { api, ApiClientError } = await import("./api");
const { LoginCard, consumeWecomCallbackFragment, wecomErrorMessage } = await import("./pages/login-card");
const { LandingPage } = await import("./pages/landing-page");
const { useAppAuthentication } = await import("./app-authentication");
const { safeRedirectTarget, wecomAuthorizePath, wecomPostLoginPath } = await import("./routing");
type User = import("./types").User;

const fullUser: User = { id: "full-user", username: "full", display_name: "完整用户", ui_mode: "full" };
const liteUser: User = { id: "lite-user", username: "lite", display_name: "轻量用户", ui_mode: "lite" };

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function storageValues(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key !== null)
    .map((key) => storage.getItem(key) ?? "");
}

function mountLoginCard(
  props: {
    onAuthenticated?: (user: User) => void;
    wecomCallback?: import("./pages/login-card").WecomCallback | null;
    onWecomCallbackHandled?: () => void;
  } = {},
  strict = false,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    const card = createElement(LoginCard, {
      onAuthenticated: props.onAuthenticated ?? (() => {}),
      wecomCallback: props.wecomCallback,
      onWecomCallbackHandled: props.onWecomCallbackHandled,
    });
    root.render(strict ? createElement(StrictMode, null, card) : card);
  });
  return { container, unmount: () => act(() => { root.unmount(); container.remove(); }) };
}

function mountAppAuthentication(startupWecomCallback: import("./pages/login-card").WecomCallback) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function AuthenticationHarness(): React.JSX.Element {
    const authentication = useAppAuthentication(startupWecomCallback, fullUser);
    if (authentication.user) return createElement("p", { "data-testid": "authenticated-user" }, authentication.user.id);
    return createElement(LandingPage, {
      onAuthenticated: authentication.handleAuthenticated,
      wecomCallback: authentication.wecomCallback,
      onWecomCallbackHandled: authentication.markWecomCallbackHandled,
    });
  }
  act(() => root.render(createElement(StrictMode, null, createElement(AuthenticationHarness))));
  return { container, unmount: () => act(() => { root.unmount(); container.remove(); }) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("企业微信站内 return_to 严格校验并按服务端 ui_mode 选择落点", () => {
  assert.equal(safeRedirectTarget("?redirect=%2Fprojects%2Fp1"), "/projects/p1");
  assert.equal(safeRedirectTarget("?redirect=%2F%5Cevil.example"), null);
  assert.equal(wecomAuthorizePath("?redirect=%2Fprojects%2Fp1%3Ftab%3Dassets"), "/api/v1/auth/wecom/authorize?return_to=%2Fprojects%2Fp1%3Ftab%3Dassets");
  assert.equal(wecomAuthorizePath("?redirect=https%3A%2F%2Fevil.example"), "/api/v1/auth/wecom/authorize");
  assert.equal(wecomPostLoginPath("full", "/projects/p1"), "/projects/p1");
  assert.equal(wecomPostLoginPath("full", "/lite/projects/p1"), "/projects");
  assert.equal(wecomPostLoginPath("lite", "/lite/projects/p1/workspace"), "/lite/projects/p1/workspace");
  assert.equal(wecomPostLoginPath("lite", "/projects/p1"), "/lite/projects");
  assert.equal(wecomPostLoginPath("lite", "//evil.example"), "/lite/projects");
});

test("callback fragment 读取后同步清除，result 只留在内存返回值", () => {
  const target = new Window({ url: "http://localhost/landing?source=wecom#wecom_result=opaque-once&redirect=%2Flite%2Fprojects%2Fp1" });
  const callback = consumeWecomCallbackFragment(target as unknown as Parameters<typeof consumeWecomCallbackFragment>[0]);
  assert.deepEqual(callback, { kind: "result", result: "opaque-once", returnTo: "/lite/projects/p1" });
  assert.equal(target.location.href, "http://localhost/landing?source=wecom");
  assert.deepEqual(storageValues(target.localStorage), []);
  assert.deepEqual(storageValues(target.sessionStorage), []);
});

test("callback 异常或歧义参数失败关闭，并同样立即清除 fragment", () => {
  const target = new Window({ url: "http://localhost/landing#wecom_result=one&wecom_error=wecom_provider_unavailable" });
  assert.deepEqual(
    consumeWecomCallbackFragment(target as unknown as Parameters<typeof consumeWecomCallbackFragment>[0]),
    { kind: "error", code: "wecom_transaction_invalid" },
  );
  assert.equal(target.location.hash, "");
});

async function assertCallbackSupersedesStoredSession(storedToken: string): Promise<void> {
  const originalMe = api.me;
  const originalStatus = api.wecomStatus;
  const originalExchange = api.exchangeWecomResult;
  let meCalls = 0;
  let exchanges = 0;
  const exchange = deferred<{ token: string; expires_at: string; user: User }>();
  try {
    happyWindow.history.replaceState({}, "", `/landing#wecom_result=${storedToken}-callback&redirect=%2Fprojects`);
    api.setToken(storedToken);
    api.me = async () => {
      meCalls += 1;
      if (storedToken === "expired-session") throw new ApiClientError("expired", { status: 401 });
      return fullUser;
    };
    api.wecomStatus = async () => ({ enabled: true });
    api.exchangeWecomResult = (result) => {
      exchanges += 1;
      assert.equal(result, `${storedToken}-callback`);
      return exchange.promise.then((response) => {
        api.setToken(response.token);
        return response;
      });
    };

    // 与 App 根启动一致：React render 前捕获并同步清除，不受 StrictMode 重放影响。
    const callback = consumeWecomCallbackFragment(
      happyWindow as unknown as Parameters<typeof consumeWecomCallbackFragment>[0],
    );
    assert.ok(callback?.kind === "result");
    assert.equal(happyWindow.location.hash, "");
    const mounted = mountAppAuthentication(callback);
    await flush();
    assert.equal(meCalls, 0, "存在 callback 时不得先用旧 token 请求 /auth/me");
    assert.equal(exchanges, 1, "callback result 在 StrictMode 下也只能交换一次");

    exchange.resolve({
      token: "fresh-wecom-session",
      expires_at: "2026-08-23T12:00:00.000Z",
      user: fullUser,
    });
    await flush();
    assert.equal(mounted.container.querySelector('[data-testid="authenticated-user"]')?.textContent, fullUser.id);
    assert.equal(happyWindow.sessionStorage.getItem("shortdrama_v01_token"), "fresh-wecom-session");
    mounted.unmount();
  } finally {
    api.me = originalMe;
    api.wecomStatus = originalStatus;
    api.exchangeWecomResult = originalExchange;
    api.setToken(null);
    happyWindow.history.replaceState({}, "", "/landing");
  }
}

test("已有有效 token 时 callback 仍同步清除并优先且仅 exchange 一次", async () => {
  await assertCallbackSupersedesStoredSession("valid-session");
});

test("已有失效 token 时 callback 不经过 /auth/me 且仅 exchange 一次", async () => {
  await assertCallbackSupersedesStoredSession("expired-session");
});

test("status 使用服务端能力真值：读取中、关闭或失败均隐藏，开启后才显示入口", async () => {
  const originalStatus = api.wecomStatus;
  let resolveStatus: ((status: { enabled: boolean }) => void) | undefined;
  try {
    api.wecomStatus = () => new Promise((resolve) => { resolveStatus = resolve; });
    const loading = mountLoginCard();
    assert.equal(loading.container.querySelector('[data-testid="wecom-login-button"]'), null, "读取中不得抢先显示");
    await act(async () => { resolveStatus?.({ enabled: false }); });
    assert.equal(loading.container.querySelector('[data-testid="wecom-login-button"]'), null, "关闭时必须隐藏");
    loading.unmount();

    api.wecomStatus = async () => { throw new Error("provider raw failure"); };
    const failed = mountLoginCard();
    await flush();
    assert.equal(failed.container.querySelector('[data-testid="wecom-login-button"]'), null, "读取失败必须隐藏");
    assert.ok(!failed.container.textContent?.includes("provider raw failure"), "不得显示原始错误");
    failed.unmount();

    api.wecomStatus = async () => ({ enabled: true });
    const enabled = mountLoginCard();
    await flush();
    assert.ok(enabled.container.querySelector('[data-testid="wecom-login-button"]'), "开启后应显示入口");
    enabled.unmount();
  } finally {
    api.wecomStatus = originalStatus;
  }
});

test("企业微信关闭时普通密码登录仍可提交并进入原有 Full 落点", async () => {
  const originalStatus = api.wecomStatus;
  const originalLogin = api.login;
  let loginCalls = 0;
  let authenticated: User | null = null;
  try {
    happyWindow.history.replaceState({}, "", "/landing");
    api.wecomStatus = async () => ({ enabled: false });
    api.login = async (identifier, password) => {
      loginCalls += 1;
      assert.equal(identifier, "full@example.test");
      assert.equal(password, "password123");
      return {
        token: "ordinary-session",
        expires_at: "2026-08-23T12:00:00.000Z",
        user: fullUser,
      };
    };
    const mounted = mountLoginCard({ onAuthenticated: (user) => { authenticated = user; } });
    await flush();
    assert.equal(mounted.container.querySelector('[data-testid="wecom-login-button"]'), null);

    const identifier = mounted.container.querySelector('[data-testid="login-username-input"]') as HTMLInputElement;
    const password = mounted.container.querySelector('[data-testid="login-password-input"]') as HTMLInputElement;
    const form = mounted.container.querySelector("form") as HTMLFormElement;
    const setInputValue = Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, "value")?.set;
    assert.ok(setInputValue);
    act(() => {
      setInputValue.call(identifier, "full@example.test");
      identifier.dispatchEvent(new Event("input", { bubbles: true }));
      setInputValue.call(password, "password123");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(loginCalls, 1);
    assert.deepEqual(authenticated, fullUser);
    assert.equal(happyWindow.location.pathname, "/projects");
    mounted.unmount();
  } finally {
    api.wecomStatus = originalStatus;
    api.login = originalLogin;
    api.setToken(null);
    happyWindow.history.replaceState({}, "", "/landing");
  }
});

test("点击入口进入跳转中状态，并只携带已校验的站内 return_to", async () => {
  const originalStatus = api.wecomStatus;
  try {
    happyWindow.history.replaceState({}, "", "/landing?redirect=%2Fprojects%2Fp1%3Ftab%3Dassets");
    api.wecomStatus = async () => ({ enabled: true });
    const mounted = mountLoginCard();
    await flush();
    const button = mounted.container.querySelector('[data-testid="wecom-login-button"]') as HTMLButtonElement | null;
    assert.ok(button);
    act(() => button.click());
    assert.ok(mounted.container.textContent?.includes("正在前往企业微信"));
    assert.equal(happyWindow.location.pathname, "/api/v1/auth/wecom/authorize");
    assert.equal(happyWindow.location.search, "?return_to=%2Fprojects%2Fp1%3Ftab%3Dassets");
    mounted.unmount();
  } finally {
    api.wecomStatus = originalStatus;
    happyWindow.history.replaceState({}, "", "/landing");
  }
});

test("result 只 exchange 一次，保存现有 session，并按返回 ui_mode 导航", async () => {
  const originalStatus = api.wecomStatus;
  const originalExchange = api.exchangeWecomResult;
  let exchanges = 0;
  let handled = 0;
  let authenticated: User | null = null;
  try {
    happyWindow.history.replaceState({}, "", "/landing");
    happyWindow.sessionStorage.clear();
    api.wecomStatus = async () => ({ enabled: true });
    api.exchangeWecomResult = async (result) => {
      exchanges += 1;
      assert.equal(result, "opaque-once");
      api.setToken("session-token");
      return { token: "session-token", expires_at: "2026-08-22T12:00:00.000Z", user: liteUser };
    };
    const mounted = mountLoginCard({
      onAuthenticated: (user) => { authenticated = user; },
      wecomCallback: { kind: "result", result: "opaque-once", returnTo: "/projects/not-lite" },
      onWecomCallbackHandled: () => { handled += 1; },
    }, true);
    await flush();
    assert.equal(exchanges, 1);
    assert.equal(handled, 1, "StrictMode 重放 effect 时 callback 也只能交接一次");
    assert.deepEqual(authenticated, liteUser);
    assert.equal(happyWindow.location.pathname, "/lite/projects");
    assert.equal(happyWindow.sessionStorage.getItem("shortdrama_v01_token"), "session-token");
    assert.ok(!storageValues(happyWindow.sessionStorage).includes("opaque-once"), "一次性 result 不得进入 sessionStorage");
    mounted.unmount();

    happyWindow.history.replaceState({}, "", "/landing");
    api.exchangeWecomResult = async () => {
      exchanges += 1;
      return { token: "full-session", expires_at: "2026-08-22T12:00:00.000Z", user: fullUser };
    };
    const full = mountLoginCard({
      onAuthenticated: (user) => { authenticated = user; },
      wecomCallback: { kind: "result", result: "full-once", returnTo: "/projects/full-project" },
    }, true);
    await flush();
    assert.equal(exchanges, 2, "StrictMode 重放 effect 时每个 result 仍只能交换一次");
    assert.deepEqual(authenticated, fullUser);
    assert.equal(happyWindow.location.pathname, "/projects/full-project");
    full.unmount();
  } finally {
    api.wecomStatus = originalStatus;
    api.exchangeWecomResult = originalExchange;
    api.setToken(null);
  }
});

test("callback exchange 在途时 Escape、背景与关闭按钮均不能关闭登录弹层", async () => {
  const originalStatus = api.wecomStatus;
  const originalExchange = api.exchangeWecomResult;
  const exchange = deferred<{ token: string; expires_at: string; user: User }>();
  let exchanges = 0;
  try {
    happyWindow.history.replaceState({}, "", "/landing");
    api.wecomStatus = async () => ({ enabled: true });
    api.exchangeWecomResult = () => {
      exchanges += 1;
      return exchange.promise;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(LandingPage, {
      onAuthenticated: () => {},
      wecomCallback: { kind: "result", result: "pending-result", returnTo: null },
      onWecomCallbackHandled: () => {},
    })));
    await flush();
    assert.equal(exchanges, 1);
    const dialog = () => container.querySelector('[role="dialog"]');
    const overlay = dialog() as HTMLElement;
    const close = container.querySelector('[aria-label="关闭登录"]') as HTMLButtonElement;
    assert.equal(close.disabled, true);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.ok(dialog(), "Escape 不得关闭 exchange 中的弹层");
    act(() => overlay.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.ok(dialog(), "背景点击不得关闭 exchange 中的弹层");
    act(() => close.click());
    assert.ok(dialog(), "关闭按钮不得关闭 exchange 中的弹层");

    exchange.resolve({ token: "late-session", expires_at: "2026-08-23T12:00:00.000Z", user: fullUser });
    await flush();
    act(() => { root.unmount(); container.remove(); });
  } finally {
    api.wecomStatus = originalStatus;
    api.exchangeWecomResult = originalExchange;
    api.setToken(null);
    happyWindow.history.replaceState({}, "", "/landing");
  }
});

test("callback 与 exchange 稳定错误码展示中文，不透传供应商 message", async () => {
  const originalStatus = api.wecomStatus;
  const originalExchange = api.exchangeWecomResult;
  try {
    api.wecomStatus = async () => ({ enabled: true });
    const cancelled = mountLoginCard({ wecomCallback: { kind: "error", code: "wecom_authorization_cancelled" } });
    await flush();
    assert.ok(cancelled.container.textContent?.includes("已取消企业微信授权"));
    cancelled.unmount();

    api.exchangeWecomResult = async () => {
      throw new ApiClientError("raw provider stack and secret", { status: 503, code: "wecom_provider_unavailable" });
    };
    const unavailable = mountLoginCard({ wecomCallback: { kind: "result", result: "expired-result", returnTo: null } });
    await flush();
    assert.ok(unavailable.container.textContent?.includes("企业微信服务暂时不可用"));
    assert.ok(!unavailable.container.textContent?.includes("raw provider"));
    unavailable.unmount();
  } finally {
    api.wecomStatus = originalStatus;
    api.exchangeWecomResult = originalExchange;
  }
  assert.equal(wecomErrorMessage("wecom_account_disabled"), "该平台账号已停用，请联系管理员。");
  assert.ok(!wecomErrorMessage(new Error("vendor secret")).includes("vendor"));
  for (const inheritedKey of ["__proto__", "constructor", "toString"]) {
    assert.equal(
      wecomErrorMessage(inheritedKey),
      "企业微信登录未完成，请重新尝试或使用邮箱登录。",
      `${inheritedKey} 不得读取对象原型链或进入 React child`,
    );
  }
  for (const code of [
    "wecom_login_disabled",
    "wecom_transaction_invalid",
    "wecom_transaction_expired",
    "wecom_transaction_replayed",
    "wecom_authorization_cancelled",
    "wecom_member_not_allowed",
    "wecom_profile_incomplete",
    "wecom_identity_conflict",
    "wecom_account_disabled",
    "wecom_provider_unavailable",
  ]) {
    assert.match(wecomErrorMessage(code), /[\u3400-\u9fff]/, `${code} 必须映射为中文`);
  }
});

test("BFCache pageshow 恢复时清除跳转中状态并重新 fail-closed 读取 status", async () => {
  const originalStatus = api.wecomStatus;
  const refreshedStatus = deferred<{ enabled: boolean }>();
  let statusCalls = 0;
  try {
    happyWindow.history.replaceState({}, "", "/landing");
    api.wecomStatus = () => {
      statusCalls += 1;
      return statusCalls === 1 ? Promise.resolve({ enabled: true }) : refreshedStatus.promise;
    };
    const mounted = mountLoginCard();
    await flush();
    const button = mounted.container.querySelector('[data-testid="wecom-login-button"]') as HTMLButtonElement;
    act(() => button.click());
    assert.ok(mounted.container.textContent?.includes("正在前往企业微信"));

    happyWindow.history.replaceState({}, "", "/landing");
    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    act(() => window.dispatchEvent(pageShow));
    assert.equal(statusCalls, 2);
    assert.equal(mounted.container.querySelector('[data-testid="wecom-login-button"]'), null, "恢复后 status 未返回前必须隐藏入口");
    assert.ok(!mounted.container.textContent?.includes("正在前往企业微信"));

    await act(async () => { refreshedStatus.resolve({ enabled: true }); });
    const restored = mounted.container.querySelector('[data-testid="wecom-login-button"]') as HTMLButtonElement;
    assert.equal(restored.textContent, "使用企业微信登录");
    mounted.unmount();
  } finally {
    api.wecomStatus = originalStatus;
    happyWindow.history.replaceState({}, "", "/landing");
  }
});

test("API mock：status 和 strict exchange 使用冻结路径与请求体", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  try {
    happyWindow.sessionStorage.clear();
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      const data = calls.length === 1
        ? { enabled: true }
        : { token: "bearer", expires_at: "2026-08-22T12:00:00.000Z", user: fullUser };
      return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    assert.deepEqual(await api.wecomStatus(), { enabled: true });
    assert.deepEqual((await api.exchangeWecomResult("opaque")).user, fullUser);
    assert.equal(calls[0]?.url, "/api/v1/auth/wecom/status");
    assert.equal(calls[1]?.url, "/api/v1/auth/wecom/exchange");
    assert.equal(calls[1]?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { result: "opaque" });
  } finally {
    globalThis.fetch = originalFetch;
    api.setToken(null);
  }
});

test("Lite 合同默认落点在应用路由中可达", async () => {
  const { readFile } = await import("node:fs/promises");
  const appSource = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
  assert.ok(appSource.includes('pathname === "/lite" || pathname === "/lite/projects"'));
});
