import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../src/db/client.js";
import { registerVnextRoutes } from "../src/modules/vnext/routes.js";
import type { VnextScriptService } from "../src/modules/vnext/script/service.js";

test("生产路由把隔离 vNext 库和主应用库分别注入剧本服务", async () => {
  const vnextDatabase = { role: "vnext_app" } as unknown as Database;
  const mainDatabase = { schema: "common" } as unknown as Database;
  let received: [Database, Database] | undefined;
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: randomUUID(),
      username: "wiring-test",
      displayName: "Wiring Test",
      role: "member",
    };
  });
  await registerVnextRoutes(app, () => vnextDatabase, {
    getMainDatabase: () => mainDatabase,
    createScriptService: (receivedVnext, receivedMain) => {
      received = [receivedVnext, receivedMain];
      return {
        workbench: async () => ({ run: null, formalFacts: null }),
      } as unknown as VnextScriptService;
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/vnext/projects/${randomUUID()}/script-workbench`,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(received);
    assert.deepEqual(received, [vnextDatabase, mainDatabase]);
    assert.notEqual(received[0], received[1]);
  } finally {
    await app.close();
  }
});
