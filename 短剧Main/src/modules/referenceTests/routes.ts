import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { GenerationDefaultStrategyRepository } from "../generation/defaults/repository.js";
import { createGenerationDefaultStrategyService } from "../generation/defaults/service.js";
import { createReferenceTestService, type ReferenceTestService } from "./service.js";
import { referenceTestMediaKinds, referenceTestModes } from "./types.js";

const uuid = z.string().uuid();
const projectParams = z.object({ project_id: uuid });
const testParams = z.object({ project_id: uuid, reference_test_id: uuid });
const resultParams = z.object({ project_id: uuid, reference_test_id: uuid, result_id: uuid });
const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  media_kind: z.enum(referenceTestMediaKinds).optional(),
});
const resultPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});
const referenceTestBody = z.object({
  name: z.string().trim().min(1).max(128),
  media_kind: z.enum(referenceTestMediaKinds),
  mode: z.enum(referenceTestModes),
  model_key: z.string().trim().min(1).max(128),
  prompt: z.string().max(20_000).default(""),
  parameters: z.record(z.string(), z.unknown()).default({}),
  reference_media_ids: z.array(uuid).max(50).default([]),
}).strict();
const updateReferenceTestBody = referenceTestBody.extend({
  expected_version: z.coerce.number().int().min(1),
}).strict();
const deleteReferenceTestBody = z.object({
  expected_version: z.coerce.number().int().min(1),
}).strict();
const attachResultBody = z.object({
  generation_request_id: uuid,
  media_result_id: uuid,
}).strict();
const setDefaultBody = z.object({
  expected_version: z.coerce.number().int().min(0),
}).strict();

export interface ReferenceTestRouteDependencies {
  createService?: () => ReferenceTestService;
}

export async function registerReferenceTestRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ReferenceTestRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.() ?? createReferenceTestService(
    getDatabase(),
    createGenerationDefaultStrategyService(new GenerationDefaultStrategyRepository(getDatabase())),
  );

  app.post("/api/v1/projects/:project_id/reference-tests", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(referenceTestBody, request.body);
    return success(await service().create(requireCurrentUser(request).id, params.project_id, toInput(input)));
  });

  app.get("/api/v1/projects/:project_id/reference-tests", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const query = parseRequest(pagination, request.query);
    return success(await service().list(requireCurrentUser(request).id, params.project_id, query.page, query.page_size, query.media_kind));
  });

  app.get("/api/v1/projects/:project_id/reference-test-results", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const query = parseRequest(pagination, request.query);
    return success(await service().listProjectResults(
      requireCurrentUser(request).id,
      params.project_id,
      query.page,
      query.page_size,
      query.media_kind,
    ));
  });

  app.get("/api/v1/projects/:project_id/reference-tests/:reference_test_id", async (request) => {
    const params = parseRequest(testParams, request.params);
    return success(await service().get(requireCurrentUser(request).id, params.project_id, params.reference_test_id));
  });

  app.put("/api/v1/projects/:project_id/reference-tests/:reference_test_id", async (request) => {
    const params = parseRequest(testParams, request.params);
    const input = parseRequest(updateReferenceTestBody, request.body);
    return success(await service().update(
      requireCurrentUser(request).id,
      params.project_id,
      params.reference_test_id,
      toInput(input),
      input.expected_version,
    ));
  });

  app.delete("/api/v1/projects/:project_id/reference-tests/:reference_test_id", async (request, reply) => {
    const params = parseRequest(testParams, request.params);
    const body = parseRequest(deleteReferenceTestBody, request.body);
    await service().remove(requireCurrentUser(request).id, params.project_id, params.reference_test_id, body.expected_version);
    return reply.code(204).send();
  });

  app.post("/api/v1/projects/:project_id/reference-tests/:reference_test_id/results", async (request) => {
    const params = parseRequest(testParams, request.params);
    const input = parseRequest(attachResultBody, request.body);
    return success(await service().attachResult(requireCurrentUser(request).id, params.project_id, params.reference_test_id, {
      generationRequestId: input.generation_request_id,
      mediaResultId: input.media_result_id,
    }));
  });

  app.get("/api/v1/projects/:project_id/reference-tests/:reference_test_id/results", async (request) => {
    const params = parseRequest(testParams, request.params);
    const query = parseRequest(resultPagination, request.query);
    return success(await service().listResults(requireCurrentUser(request).id, params.project_id, params.reference_test_id, query.page, query.page_size));
  });

  app.post("/api/v1/projects/:project_id/reference-tests/:reference_test_id/results/:result_id/set-default", async (request) => {
    const params = parseRequest(resultParams, request.params);
    const body = parseRequest(setDefaultBody, request.body);
    return success(await service().setResultAsDefault(
      requireCurrentUser(request).id,
      params.project_id,
      params.reference_test_id,
      params.result_id,
      body.expected_version,
    ));
  });
}

function toInput(input: z.infer<typeof referenceTestBody>) {
  return {
    name: input.name,
    mediaKind: input.media_kind,
    mode: input.mode,
    modelKey: input.model_key,
    prompt: input.prompt,
    parameters: input.parameters,
    referenceMediaIds: input.reference_media_ids,
  };
}
