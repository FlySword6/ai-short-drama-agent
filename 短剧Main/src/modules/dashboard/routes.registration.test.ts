import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { registerOperationsRoutes } from "../operations/routes.js";
import type { OperationsStore } from "../operations/types.js";
import { registerDashboardRoutes } from "./routes.js";

test("运营成本路由与仪表盘摘要可同时注册，项目成本路径只有运营合同一份", async () => {
  const app = Fastify({ logger: false });
  try {
    await registerOperationsRoutes(app, () => ({} as Database), {
      createStore: () => ({}) as OperationsStore,
    });
    await assert.doesNotReject(async () => registerDashboardRoutes(app, () => ({} as Database)));
    // Registering both modules would already throw on a duplicate Fastify
    // method/path pair.  A request reaching the operations handler then gets
    // its normal auth rejection instead of a 404, proving that the one
    // canonical project-cost route remains present.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/11111111-1111-4111-8111-111111111111/costs?group_by=member",
    });
    assert.equal(response.statusCode, 401, response.body);
  } finally {
    await app.close();
  }
});
