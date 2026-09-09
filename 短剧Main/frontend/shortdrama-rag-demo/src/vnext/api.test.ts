import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { UNAUTHORIZED_EVENT } from "../api";
import { readSessionExpiry, readSessionToken, writeSessionExpiry, writeSessionToken } from "../auth-token";
import { VnextApiError, vnextApi } from "./api";

async function withUnauthorizedResponse(run: (events: CustomEvent[]) => Promise<void>): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
  const originalFetch = globalThis.fetch;
  const happyWindow = new Window();
  const events: CustomEvent[] = [];

  Object.defineProperty(globalThis, "window", { configurable: true, value: happyWindow });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: happyWindow.CustomEvent });
  happyWindow.addEventListener(UNAUTHORIZED_EVENT, (event) => events.push(event as unknown as CustomEvent));
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: {
      message: "vNext 会话已失效",
      code: "vnext_session_expired",
      details: { recovery: "sign_in" },
    },
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

  try {
    await run(events);
  } finally {
    globalThis.fetch = originalFetch;
    happyWindow.close();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalCustomEvent) Object.defineProperty(globalThis, "CustomEvent", originalCustomEvent);
    else Reflect.deleteProperty(globalThis, "CustomEvent");
  }
}

test("vNext 401 复用统一未登录事件并清除失效会话", async () => {
  await withUnauthorizedResponse(async (events) => {
    writeSessionToken("expired-token");
    writeSessionExpiry("2099-01-01T00:00:00.000Z");

    await assert.rejects(vnextApi.listProjects());

    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.detail, { reason: "revoked" });
    assert.equal(readSessionToken(), null);
    assert.equal(readSessionExpiry(), null);
  });
});

test("vNext 401 保留原有 VnextApiError 映射", async () => {
  await withUnauthorizedResponse(async () => {
    await assert.rejects(vnextApi.listProjects(), (error: unknown) => {
      assert.ok(error instanceof VnextApiError);
      assert.equal(error.message, "vNext 会话已失效");
      assert.equal(error.status, 401);
      assert.equal(error.code, "vnext_session_expired");
      assert.deepEqual(error.details, { recovery: "sign_in" });
      return true;
    });
  });
});
