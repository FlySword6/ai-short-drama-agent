import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { createAiGatewayService } from "../ai/service.js";
import { submitAssistantGenerationQuote } from "../assistant/generationQuoteSubmit.js";
import { DrizzleGenerationTierCatalog } from "./catalog.js";
import {
  CatalogGenerationVoiceResolver,
  DrizzleGenerationTurnContextAuthorizer,
} from "./contextAuthorizer.js";
import {
  MockGenerationOperationExecutor,
  RealGenerationOperationExecutor,
} from "./executors.js";
import {
  AiGenerationIntentInterpreter,
  DeterministicGenerationIntentInterpreter,
} from "./interpreter.js";
import {
  generationConfirmOpenApiSchema,
  generationRequoteOpenApiSchema,
  generationTurnOpenApiSchema,
} from "./openapi.js";
import {
  DrizzleGenerationReferenceResolver,
  MockGenerationQuoteAdapter,
  RealGenerationQuoteAdapter,
} from "./quoteAdapters.js";
import {
  generationParametersFromWire,
  generationRequestedParametersWireSchema,
} from "./requestParameters.js";
import { DrizzleGenerationOrchestrationStore } from "./repository.js";
import { GenerationOrchestrationService } from "./service.js";

const uuid = z.string().uuid();
const sessionParamsSchema = z.object({ session_id: uuid }).strict();
const operationParamsSchema = z.object({
  session_id: uuid,
  operation_id: uuid,
}).strict();
const emptyBodySchema = z.object({}).strict();
const turnSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  context: z.object({
    project_id: uuid,
    episode_id: uuid.optional(),
    scene_id: uuid.optional(),
    shot_id: uuid.optional(),
    selected_asset: z.object({
      asset_entity_id: uuid,
      media_id: uuid,
      media_kind: z.enum(["image", "video", "audio"]),
    }).strict().optional(),
    reference_media_ids: z.array(uuid).max(20).default([]),
  }).strict(),
}).strict();
const requoteSchema = z.object({
  tier_id: z.string().trim().min(1).max(128).optional(),
  parameters: generationRequestedParametersWireSchema.default({}),
}).strict();

export interface RegisterGenerationOrchestrationRoutesOptions {
  createService?: (db: Database) => GenerationOrchestrationService;
}

export async function registerGenerationOrchestrationRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  options: RegisterGenerationOrchestrationRoutesOptions = {},
): Promise<void> {
  let registeredService: GenerationOrchestrationService | undefined;
  const service = () => {
    registeredService ??= options.createService?.(getDatabase())
      ?? createGenerationOrchestrationService(getDatabase());
    return registeredService;
  };

  app.post(
    "/api/v1/agent/sessions/:session_id/generation-orchestration/turns",
    {
      config: { agentAccess: "human_only" },
      schema: generationTurnOpenApiSchema,
      validatorCompiler: () => (data) => ({ value: data }),
      preValidation: async (request) => {
        // Fastify's global AJV removes unknown properties. Run the strict Zod
        // contract first so forbidden provider/model fields are rejected
        // instead of silently disappearing before the handler sees them.
        parseRequest(turnSchema, request.body);
      },
    },
    async (request, reply) => {
      const actor = requireCurrentUser(request);
      const params = parseRequest(sessionParamsSchema, request.params);
      const input = parseRequest(turnSchema, request.body);
      const result = await service().createTurn({
        actorId: actor.id,
        sessionId: params.session_id,
        message: input.message,
        context: {
          projectId: input.context.project_id,
          ...(input.context.episode_id ? { episodeId: input.context.episode_id } : {}),
          ...(input.context.scene_id ? { sceneId: input.context.scene_id } : {}),
          ...(input.context.shot_id ? { shotId: input.context.shot_id } : {}),
          ...(input.context.selected_asset
            ? {
                selectedAsset: {
                  assetEntityId: input.context.selected_asset.asset_entity_id,
                  mediaId: input.context.selected_asset.media_id,
                  mediaKind: input.context.selected_asset.media_kind,
                },
              }
            : {}),
          referenceMediaIds: input.context.reference_media_ids,
        },
      });
      return reply.code(result.status === "confirmation_required" ? 201 : 200)
        .send(success(result));
    },
  );

  app.post(
    "/api/v1/agent/sessions/:session_id/generation-orchestration/operations/:operation_id/requote",
    {
      config: { agentAccess: "human_only" },
      schema: generationRequoteOpenApiSchema,
      validatorCompiler: () => (data) => ({ value: data }),
      preValidation: async (request) => {
        parseRequest(requoteSchema, request.body ?? {});
      },
    },
    async (request, reply) => {
      const actor = requireCurrentUser(request);
      const params = parseRequest(operationParamsSchema, request.params);
      const input = parseRequest(requoteSchema, request.body ?? {});
      const result = await service().requote({
        actorId: actor.id,
        sessionId: params.session_id,
        operationId: params.operation_id,
        ...(input.tier_id ? { tierId: input.tier_id } : {}),
        requestedParameters: generationParametersFromWire(input.parameters),
      });
      return reply.code(result.status === "confirmation_required" ? 201 : 200)
        .send(success(result));
    },
  );

  app.post(
    "/api/v1/agent/sessions/:session_id/generation-orchestration/operations/:operation_id/confirm",
    {
      config: { agentAccess: "human_only" },
      schema: generationConfirmOpenApiSchema,
      validatorCompiler: () => (data) => ({ value: data }),
      preValidation: async (request) => {
        if (request.body !== undefined) {
          parseRequest(emptyBodySchema, request.body);
        }
      },
    },
    async (request, reply) => {
      const actor = requireCurrentUser(request);
      const params = parseRequest(operationParamsSchema, request.params);
      const receipt = await service().confirm({
        actorId: actor.id,
        sessionId: params.session_id,
        operationId: params.operation_id,
      });
      return reply.code(receipt.executionMode === "real" && receipt.status === "queued" ? 202 : 200)
        .send(success(receipt));
    },
  );
}

export function createGenerationOrchestrationService(db: Database): GenerationOrchestrationService {
  const store = new DrizzleGenerationOrchestrationStore(db);
  const catalog = new DrizzleGenerationTierCatalog(db, settings.companyProviderAllowlist);
  const references = new DrizzleGenerationReferenceResolver(db);
  const contextAuthorizer = new DrizzleGenerationTurnContextAuthorizer(db, { references });
  const mode = settings.generationOrchestrationMode;
  const interpreter = mode === "real"
    ? new AiGenerationIntentInterpreter(createAiGatewayService(db))
    : new DeterministicGenerationIntentInterpreter();
  return new GenerationOrchestrationService({
    mode,
    store,
    interpreter,
    catalog,
    quoteAdapters: {
      mock: new MockGenerationQuoteAdapter(references),
      real: new RealGenerationQuoteAdapter(db, references),
    },
    executors: {
      mock: new MockGenerationOperationExecutor(catalog),
      real: new RealGenerationOperationExecutor((actorId, session, quoteId, authorizedProjectId) => (
        submitAssistantGenerationQuote(db, {
          actorId,
          authorizedProjectId,
          session,
          quoteId,
        })
      )),
    },
    contextAuthorizer,
    voiceResolver: CatalogGenerationVoiceResolver.fromDatabase(db),
  });
}
