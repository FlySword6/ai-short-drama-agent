import assert from "node:assert/strict";
import test from "node:test";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import type { Database } from "../src/db/client.js";
import { registerVnextRoutes } from "../src/modules/vnext/routes.js";

interface OpenApiOperation {
  responses?: Record<string, {
    content?: Record<string, { schema?: unknown }>;
  }>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

test("vNext 剧本路由公开 closed response schemas", async () => {
  const app = Fastify({ logger: false });
  await app.register(swagger, {
    openapi: { info: { title: "vNext script contract test", version: "0.1.0" } },
  });
  await registerVnextRoutes(app, () => ({} as Database));
  await app.ready();
  try {
    const document = app.swagger() as OpenApiDocument;
    const createScriptRun = operation(
      document,
      "/api/vnext/projects/{project_id}/script-runs",
      "post",
    );
    assertClosedResponse(createScriptRun, "200");
    assertClosedResponse(createScriptRun, "202");

    const retryScriptRun = operation(document, "/api/vnext/script-runs/{run_id}/retry", "post");
    assertClosedResponse(retryScriptRun, "200");
    assertClosedResponse(retryScriptRun, "202");

    const confirmScriptRun = operation(document, "/api/vnext/script-runs/{run_id}/confirm", "post");
    assertClosedResponse(confirmScriptRun, "200");

    const workbench = operation(
      document,
      "/api/vnext/projects/{project_id}/script-workbench",
      "get",
    );
    assertClosedResponse(workbench, "200");
  } finally {
    await app.close();
  }
});

function operation(document: OpenApiDocument, path: string, method: string): OpenApiOperation {
  const value = document.paths[path]?.[method];
  assert.ok(value, `OpenAPI 缺少 ${method.toUpperCase()} ${path}`);
  return value;
}

function assertClosedResponse(operation: OpenApiOperation, status: string): void {
  const schema = operation.responses?.[status]?.content?.["application/json"]?.schema;
  assert.ok(schema, `OpenAPI ${status} 响应缺少 JSON schema`);
  assertClosedObjectSchemas(schema, `responses.${status}`);
}

function assertClosedObjectSchemas(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClosedObjectSchemas(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path} 必须是 closed object schema`);
  }
  for (const [key, item] of Object.entries(schema)) {
    assertClosedObjectSchemas(item, `${path}.${key}`);
  }
}
