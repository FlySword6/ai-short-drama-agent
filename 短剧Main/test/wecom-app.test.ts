import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/client.js";
import type { WecomAuthPort } from "../src/modules/auth/wecomService.js";

test("createApp wires cookie parsing and fake-backed WeCom routes end to end", async () => {
  const wecom: WecomAuthPort = {
    status: () => ({ enabled: true }),
    authorize: async () => ({ location: "https://provider.test/authorize", nonce: "full-app-nonce" }),
    callback: async () => ({ result: "full-app-result", returnPath: "/projects" }),
    exchange: async () => ({
      token: "platform-token",
      expires_at: "2026-08-23T00:00:00.000Z",
      user: {
        id: "22222222-2222-4222-8222-222222222222",
        username: "member",
        display_name: "成员",
        role: "member",
        ui_mode: "full",
      },
    }),
    prebind: async (_actor, userId) => ({ user_id: userId, bound: true }),
  };
  const app = await createApp({
    logger: false,
    startGenerationWorker: false,
    frontendDistDirectory: path.join(tmpdir(), "shortdrama-no-frontend"),
    databaseHandle: { db: {} as Database, pool: {} as Pool },
    authRoutes: { createWecomService: () => wecom },
  });
  try {
    const authorized = await app.inject({ method: "GET", url: "/api/v1/auth/wecom/authorize" });
    assert.equal(authorized.statusCode, 302);
    assert.match(String(authorized.headers["set-cookie"]), /^__Host-wecom_oauth_nonce=full-app-nonce;/u);

    const callback = await app.inject({
      method: "GET",
      url: "/api/v1/auth/wecom/callback?code=fake-code&state=fake-state",
      headers: { cookie: `${String(authorized.headers["set-cookie"]).split(";", 1)[0]}` },
    });
    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, "/landing#wecom_result=full-app-result&redirect=%2Fprojects");
  } finally {
    await app.close();
  }
});

test("production request logging omits WeCom callback query secrets", async () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const wecom: WecomAuthPort = {
    status: () => ({ enabled: true }),
    authorize: async () => ({ location: "https://provider.test/authorize", nonce: "unused" }),
    callback: async () => ({ result: "redacted-result", returnPath: "/projects" }),
    exchange: async () => {
      throw new Error("not used");
    },
    prebind: async () => {
      throw new Error("not used");
    },
  };
  const app = await createApp({
    logger: { stream },
    startGenerationWorker: false,
    frontendDistDirectory: path.join(tmpdir(), "shortdrama-no-frontend"),
    databaseHandle: { db: {} as Database, pool: {} as Pool },
    authRoutes: { createWecomService: () => wecom },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/wecom/callback?code=SECRET_CODE_427&state=SECRET_STATE_427",
    });
    assert.equal(response.statusCode, 303);
    assert.match(output, /\/api\/v1\/auth\/wecom\/callback/u);
    assert.doesNotMatch(output, /SECRET_CODE_427|SECRET_STATE_427/u);
    assert.doesNotMatch(output, /[?&](?:code|state)=/u);
  } finally {
    await app.close();
  }
});
