import assert from "node:assert/strict";
import test from "node:test";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { registerVnextRoutes } from "./routes.js";

interface OpenApiOperation {
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, {
    content?: Record<string, { schema?: unknown }>;
  }>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

test("vNext 路由公开稳定分页、GraphDocument CAS 与真实状态码 schema", async () => {
  const app = Fastify({ logger: false });
  await app.register(swagger, {
    openapi: { info: { title: "vNext contract test", version: "0.1.0" } },
  });
  await registerVnextRoutes(app, () => ({} as Database));
  await app.ready();
  try {
    const document = app.swagger() as OpenApiDocument;
    const list = operation(document, "/api/vnext/projects", "get");
    assert.ok(list.responses?.["200"]);
    assert.ok(list.responses?.["401"]);

    const create = operation(document, "/api/vnext/projects", "post");
    assert.ok(create.requestBody?.content?.["application/json"]?.schema);
    assert.ok(create.responses?.["201"]);
    assert.equal(create.responses?.["200"], undefined);

    const graph = operation(document, "/api/vnext/projects/{project_id}/graph", "put");
    assert.ok(graph.requestBody?.content?.["application/json"]?.schema);
    assert.ok(graph.responses?.["200"]);
    assert.ok(graph.responses?.["409"]);

    const telemetry = operation(document, "/api/vnext/generation-telemetry", "post");
    assert.ok(telemetry.requestBody?.content?.["application/json"]?.schema);
    assert.ok(telemetry.responses?.["201"]);
  } finally {
    await app.close();
  }
});

function operation(document: OpenApiDocument, path: string, method: string): OpenApiOperation {
  const value = document.paths[path]?.[method];
  assert.ok(value, `OpenAPI 缺少 ${method.toUpperCase()} ${path}`);
  return value;
}
