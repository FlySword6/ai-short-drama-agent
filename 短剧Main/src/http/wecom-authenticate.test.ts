import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../db/client.js";
import { createAuthenticationHook } from "./authenticate.js";
import { toHttpErrorResponse } from "./errorResponse.js";

test("only the four exact WeCom auth paths are public", async () => {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const normalized = toHttpErrorResponse(error);
    return reply.code(normalized.statusCode).send({ ok: false, error: normalized.body });
  });
  app.addHook("preHandler", createAuthenticationHook(() => ({} as Database)));
  for (const path of [
    "/api/v1/auth/wecom/status",
    "/api/v1/auth/wecom/authorize",
    "/api/v1/auth/wecom/callback",
    "/api/v1/auth/wecom/exchange",
    "/api/v1/auth/wecom/status/extra",
    "/api/v1/auth/wecom/unknown",
  ]) {
    app.all(path, async () => ({ ok: true }));
  }
  try {
    for (const path of [
      "/api/v1/auth/wecom/status",
      "/api/v1/auth/wecom/authorize",
      "/api/v1/auth/wecom/callback",
      "/api/v1/auth/wecom/exchange",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 200, path);
    }
    for (const path of ["/api/v1/auth/wecom/status/extra", "/api/v1/auth/wecom/unknown"]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 401, path);
    }
  } finally { await app.close(); }
});
