import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { success } from "../src/http/response.js";
import type { WecomAuthPort } from "../src/modules/auth/wecomService.js";

test("success responses use snake_case recursively", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  assert.deepEqual(success({ projectId: "p1", mediaResults: [{ storageUrl: "https://example.test/a" }], now }), {
    ok: true,
    data: {
      project_id: "p1",
      media_results: [{ storage_url: "https://example.test/a" }],
      now,
    },
  });
});

test("health uses the frozen success envelope", async () => {
  const app = await createApp({ logger: false });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.status, "ok");
  } finally {
    await app.close();
  }
});

test("business routes reject missing bearer tokens without touching the database", async () => {
  const app = await createApp({ logger: false });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      ok: false,
      error: {
        code: "unauthorized",
        message: "请先登录",
        retryable: false,
        details: null,
      },
    });
  } finally {
    await app.close();
  }
});

test("request and 5xx logs keep network metadata while excluding query and database parameters", async () => {
  const lines: string[] = [];
  class SensitiveDatabaseError extends Error {
    readonly query = "select * from identities where userid = 'SENTINEL-QUERY'";
    readonly params = ["SENTINEL-USERID", "SENTINEL-DISPLAY-NAME"];
  }
  const app = await createApp({
    logger: {
      level: "info",
      stream: { write: (line) => { lines.push(line); } },
    },
    authRoutes: {
      createWecomService: () => ({
        status: () => { throw new SensitiveDatabaseError("SENTINEL-ERROR-MESSAGE"); },
      }) as unknown as WecomAuthPort,
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/wecom/status?code=SENTINEL-OAUTH-CODE",
      remoteAddress: "198.51.100.23",
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, "internal_error");

    const rendered = lines.join("");
    for (const sentinel of [
      "SENTINEL-OAUTH-CODE",
      "SENTINEL-QUERY",
      "SENTINEL-USERID",
      "SENTINEL-DISPLAY-NAME",
      "SENTINEL-ERROR-MESSAGE",
    ]) {
      assert.equal(rendered.includes(sentinel), false, sentinel);
    }
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const incoming = entries.find((entry) => entry.msg === "incoming request");
    assert.deepEqual(incoming?.req, {
      method: "GET",
      url: "/api/v1/auth/wecom/status",
      host: "localhost:80",
      remoteAddress: "198.51.100.23",
    });
    const failure = entries.find((entry) => entry.msg === "request failed");
    assert.equal(typeof failure?.requestId, "string");
    assert.equal(failure?.code, "internal_error");
    assert.equal(failure?.errorType, "SensitiveDatabaseError");
    assert.equal(failure?.stage, "http_error_handler");
    assert.equal("err" in (failure ?? {}), false);
  } finally {
    await app.close();
  }
});
