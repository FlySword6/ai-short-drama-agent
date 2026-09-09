import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { BadRequestError } from "../../shared/errors.js";
import { VnextScriptService } from "./script/service.js";
import { type GenerationTelemetryEvent, type GraphDocument, type VnextActorKind, VnextProjectService } from "./service.js";
import type { VnextGraphDocument } from "./types.js";
import { SnapshotAImportService, type SnapshotARegistrationPort, type SnapshotATosVerificationPort, type SnapshotAssetView } from "./imports/service.js";
import { registerStoryboardRoutes } from "./storyboard/routes.js";
import type { StoryboardService } from "./storyboard/service.js";
import { ControlPackageRepository } from "./control-packages/repository.js";
import { ControlPackageService, createControlPackageProjectAccess } from "./control-packages/service.js";
import { PendingIntentRepository } from "./generation-intents/repository.js";
import { GenerationIntentService } from "./generation-intents/service.js";
import { registerGenerationIntentRoutes } from "./generation-intents/routes.js";
import { VnextPendingIntentAuthorization } from "./generation-intents/authorization.js";
import { registerVnextGenerationRoutes } from "./generation/routes.js";
import { createSeedance25Provider, createVnextGenerationService, createVnextGenerationWorker, vnextGenerationExecutionEnabled } from "./generation/factory.js";
import { VnextGenerationRepository } from "./generation/repository.js";
import { VnextVideoVersionRepository, VnextVideoChangeDraftRepository } from "./video-versions/repository.js";
import { VnextVideoVersionService } from "./video-versions/service.js";
import { registerVnextVideoVersionRoutes } from "./video-versions/routes.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id });
const listProjectsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
const listRevisionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const position = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const node = z.object({
  id: z.string().uuid(),
  kind: z.enum(["scene", "asset", "task", "note"]),
  label: z.string().trim().min(1).max(240),
  position,
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).strict();
const edge = z.object({
  id: z.string().uuid(),
  source: z.string().uuid(),
  target: z.string().uuid(),
  label: z.string().trim().min(1).max(240).optional(),
}).strict();
const graphDocument = z.object({ schema_version: z.literal(1), nodes: z.array(node).max(1000), edges: z.array(edge).max(2000) }).strict();
const documentWrite = z.object({ expected_revision: z.number().int().min(0), document: graphDocument }).strict();
const telemetryEvent = z.object({
  id,
  user_id: id,
  request_id: z.string().trim().min(1).max(128),
  project_id: id,
  task_id: id,
  event_type: z.string().trim().min(1).max(64),
  provider: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(256).optional(),
  capability_snapshot_version: z.string().trim().min(1).max(128).optional(),
  paid_confirmation: z.boolean().optional(),
  queue_latency_ms: z.number().int().min(0).optional(),
  provider_latency_ms: z.number().int().min(0).optional(),
  provider_cost_fen: z.number().int().min(0).optional(),
  result_status: z.string().trim().min(1).max(64).optional(),
  retry_reason: z.string().trim().min(1).max(128).optional(),
}).strict();
const scriptImport = z.object({
  source_kind: z.enum(["paste", "upload"]),
  file_name: z.string().trim().min(1).max(255).optional(),
  script_content: z.string().min(1).max(200_000),
  client_idempotency_key: z.string().trim().min(1).max(128),
}).strict();
const scriptRunParams = z.object({ run_id: id });
const confirmationBody = z.object({
  client_idempotency_key: z.string().trim().min(1).max(128),
}).strict();
const snapshotAImport = z.object({
  source_system: z.string().trim().min(1).max(64),
  source_id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  asset_kind: z.enum(["character", "scene", "prop"]),
  media_kind: z.enum(["image", "video", "audio"]),
  media_url: z.string().url().max(2_000),
  media_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  snapshot_at: z.string().datetime(),
  snapshot_version: z.string().trim().min(1).max(64),
}).strict();

export interface VnextRouteDependencies {
  getMainDatabase?: () => Database;
  createScriptService?: (vnextDatabase: Database, mainDatabase: Database) => VnextScriptService;
  createSnapshotARegistration?: (actorUserId?: string) => SnapshotARegistrationPort | undefined;
  createSnapshotATosVerification?: () => SnapshotATosVerificationPort | undefined;
  createStoryboardService?: (vnextDatabase: Database) => StoryboardService;
  createVnextGenerationService?: (vnextDatabase: Database) => import("./generation/service.js").VnextGenerationService;
}

export async function registerVnextRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: VnextRouteDependencies = {},
): Promise<void> {
  const service = () => new VnextProjectService(getDatabase());
  const scripts = () => {
    const vnextDatabase = getDatabase();
    const mainDatabase = dependencies.getMainDatabase?.() ?? vnextDatabase;
    return dependencies.createScriptService?.(vnextDatabase, mainDatabase)
      ?? new VnextScriptService(vnextDatabase, undefined, mainDatabase);
  };
  const snapshotAssets = (request?: FastifyRequest) => new SnapshotAImportService(
    getDatabase(),
    dependencies.createSnapshotARegistration?.(request?.authUser?.id),
    dependencies.createSnapshotATosVerification?.(),
  );
  const activeScriptRuns = new Set<string>();
  const scheduleScriptRun = (runId: string, recover = false) => {
    if (activeScriptRuns.has(runId)) return;
    activeScriptRuns.add(runId);
    setImmediate(() => {
      void (async () => {
        if (recover) await scripts().recoverInterrupted(runId);
        await scripts().executeRun(runId);
      })().catch(() => {
        app.log.error({ runId }, "vNext script parse execution failed");
      }).finally(() => activeScriptRuns.delete(runId));
    });
  };

  app.get("/api/vnext/projects", {
    attachValidation: true,
    schema: listProjectsOpenApiSchema,
  }, async (request) => {
    const query = parseRequest(listProjectsQuery, request.query ?? {});
    const page = await service().listProjects(requireCurrentUser(request), { limit: query.limit, cursor: query.cursor });
    return success({ items: page.items, nextCursor: page.nextCursor });
  });
  app.post("/api/vnext/projects", {
    attachValidation: true,
    schema: createProjectOpenApiSchema,
  }, async (request, reply) => {
    const input = parseRequest(z.object({ name: z.string().trim().min(1).max(255) }).strict(), request.body);
    return reply.code(201).send(success(await service().createProject(requireCurrentUser(request), input.name)));
  });
  app.get("/api/vnext/projects/:project_id", {
    attachValidation: true,
    schema: getProjectOpenApiSchema,
  }, async (request) => {
    const { project_id } = parseRequest(projectParams, request.params);
    return success(await service().getProject(requireCurrentUser(request), project_id));
  });
  app.get("/api/vnext/projects/:project_id/graph", {
    attachValidation: true,
    schema: getGraphOpenApiSchema,
  }, async (request) => {
    const { project_id } = parseRequest(projectParams, request.params);
    return success(toDocumentResponse(await service().getDocument(requireCurrentUser(request), project_id)));
  });
  // 画布写是 vNext 唯一对 Agent 放行的 mutation(复用仓库 Agent access 机制的
  // 显式放行档 candidate);其余 mutation(建项目、遥测)对 Agent 保持 fail-closed。
  app.put("/api/vnext/projects/:project_id/graph", {
    attachValidation: true,
    schema: putGraphOpenApiSchema,
    config: { agentAccess: "candidate" },
  }, async (request) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const input = parseRequest(documentWrite, request.body);
    return success(toDocumentResponse(await service().replaceDocument({
      actor: requireCurrentUser(request),
      projectId: project_id,
      expectedRevision: input.expected_revision,
      document: fromWireDocument(input.document),
      actorKind: currentActorKind(request),
    })));
  });
  app.get("/api/vnext/projects/:project_id/revisions", {
    attachValidation: true,
    schema: listRevisionsOpenApiSchema,
  }, async (request) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const query = parseRequest(listRevisionsQuery, request.query ?? {});
    const items = await service().listRevisions(requireCurrentUser(request), project_id, query.limit ?? 20);
    return success({ items });
  });
  app.post("/api/vnext/generation-telemetry", {
    attachValidation: true,
    schema: telemetryOpenApiSchema,
  }, async (request, reply) => {
    const input = parseRequest(telemetryEvent, request.body);
    const actor = requireCurrentUser(request);
    if (input.user_id !== actor.id) throw new BadRequestError("遥测事件必须关联当前用户");
    await service().recordGenerationTelemetry(actor, fromWireTelemetry(input));
    return reply.code(201).send(success({ id: input.id }));
  });
  app.post("/api/vnext/projects/:project_id/script-runs", {
    attachValidation: true,
    schema: createScriptRunOpenApiSchema,
  }, async (request, reply) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const input = parseRequest(scriptImport, request.body);
    const result = await scripts().createRun(requireCurrentUser(request), {
      projectId: project_id,
      sourceKind: input.source_kind,
      fileName: input.file_name,
      scriptContent: input.script_content,
      clientIdempotencyKey: input.client_idempotency_key,
    });
    if (result.created) scheduleScriptRun(result.run.id);
    return reply.code(result.created ? 202 : 200).send(success({
      run: toScriptRunResponse(result.run),
      outcome: result.created ? "created" : "replayed",
    }));
  });
  app.get("/api/vnext/projects/:project_id/script-workbench", {
    attachValidation: true,
    schema: getScriptWorkbenchOpenApiSchema,
  }, async (request) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const state = await scripts().workbench(requireCurrentUser(request), project_id);
    if (state.run?.status === "queued") scheduleScriptRun(state.run.id);
    if (state.run?.status === "running" && !activeScriptRuns.has(state.run.id)) {
      scheduleScriptRun(state.run.id, true);
    }
    return success({
      run: state.run ? toScriptRunResponse(state.run) : null,
      formalFacts: state.formalFacts,
    });
  });
  app.post("/api/vnext/script-runs/:run_id/retry", {
    attachValidation: true,
    schema: retryScriptRunOpenApiSchema,
  }, async (request, reply) => {
    const { run_id } = parseRequest(scriptRunParams, request.params);
    const result = await scripts().retry(requireCurrentUser(request), run_id);
    if (result.outcome === "created") scheduleScriptRun(result.run.id);
    return reply.code(result.outcome === "created" ? 202 : 200).send(success({
      run: toScriptRunResponse(result.run),
      outcome: result.outcome,
    }));
  });
  app.post("/api/vnext/script-runs/:run_id/confirm", {
    attachValidation: true,
    schema: confirmScriptRunOpenApiSchema,
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const { run_id } = parseRequest(scriptRunParams, request.params);
    const input = parseRequest(confirmationBody, request.body);
    const facts = await scripts().confirm(requireCurrentUser(request), run_id, input.client_idempotency_key);
    return success({ formalFacts: facts });
  });
  app.get("/api/vnext/assets/legacy-library", {
    attachValidation: true,
    schema: legacyLibraryOpenApiSchema,
  }, async (request) => success({ items: (await snapshotAssets(request).list()).map(toLegacyAssetResponse) }));
  app.post("/api/vnext/assets/snapshot-a", {
    attachValidation: true,
    schema: snapshotAImportOpenApiSchema,
  }, async (request, reply) => {
    const input = parseRequest(snapshotAImport, request.body);
    const result = await snapshotAssets(request).import({
      sourceSystem: input.source_system, sourceId: input.source_id, name: input.name,
      assetKind: input.asset_kind, mediaKind: input.media_kind, mediaUrl: input.media_url,
      mediaSha256: input.media_sha256, snapshotAt: input.snapshot_at, snapshotVersion: input.snapshot_version,
    });
    return reply.code(result.outcome === "created" ? 201 : 200).send(success({ asset: toLegacyAssetResponse(result.asset), outcome: result.outcome }));
  });
  app.post("/api/vnext/assets/:asset_id/registration/retry", {
    attachValidation: true,
    schema: retrySnapshotRegistrationOpenApiSchema,
  }, async (request) => {
    const { asset_id } = parseRequest(z.object({ asset_id: id }).strict(), request.params);
    return success({ asset: toLegacyAssetResponse(await snapshotAssets(request).retry(asset_id)) });
  });
  await registerStoryboardRoutes(app, getDatabase, {
    createService: dependencies.createStoryboardService,
  });
  await registerGenerationIntentRoutes(app, {
    controlPackages: () => {
      const vnextDatabase = getDatabase();
      return ControlPackageService.fromDatabase(vnextDatabase);
    },
    intents: () => {
      const vnextDatabase = getDatabase();
      const mainDatabase = dependencies.getMainDatabase?.() ?? vnextDatabase;
      const controlPackageRepository = new ControlPackageRepository(vnextDatabase);
      const controlPackageAccess = createControlPackageProjectAccess(vnextDatabase);
      return new GenerationIntentService(
        new PendingIntentRepository(vnextDatabase),
        controlPackageRepository,
        controlPackageAccess,
        new VnextPendingIntentAuthorization(vnextDatabase, mainDatabase),
      );
    },
  });

  // Issue #312: vNext generation task confirm + status (Seedance 2.5).
  const generationService = () => {
    const vnextDatabase = getDatabase();
    if (dependencies.createVnextGenerationService) {
      return dependencies.createVnextGenerationService(vnextDatabase);
    }
    return createVnextGenerationService(
      vnextDatabase,
      new PendingIntentRepository(vnextDatabase),
      createControlPackageProjectAccess(vnextDatabase),
    );
  };
  await registerVnextGenerationRoutes(app, { generationService });

  // Issue #313: immutable video segment versions (register / modify / extend).
  const videoVersionService = () => {
    const vnextDatabase = getDatabase();
    const mainDatabase = dependencies.getMainDatabase?.() ?? vnextDatabase;
    const access = createControlPackageProjectAccess(vnextDatabase);
    return new VnextVideoVersionService({
      versions: new VnextVideoVersionRepository(vnextDatabase),
      drafts: new VnextVideoChangeDraftRepository(vnextDatabase),
      access,
      controlPackages: ControlPackageService.fromDatabase(vnextDatabase),
      intents: new GenerationIntentService(
        new PendingIntentRepository(vnextDatabase),
        new ControlPackageRepository(vnextDatabase),
        access,
        new VnextPendingIntentAuthorization(vnextDatabase, mainDatabase),
      ),
      pendingIntents: new PendingIntentRepository(vnextDatabase),
      generationTasks: new VnextGenerationRepository(vnextDatabase),
      lockedTaskParameters: createSeedance25Provider(),
    });
  };
  await registerVnextVideoVersionRoutes(app, { videoVersionService });

  if (vnextGenerationExecutionEnabled() && !dependencies.createVnextGenerationService) {
    const vnextDatabase = getDatabase();
    const worker = createVnextGenerationWorker(
      vnextDatabase,
      new PendingIntentRepository(vnextDatabase),
      createControlPackageProjectAccess(vnextDatabase),
      app.log,
    );
    worker.start();
    app.addHook("onClose", async () => worker.stop());
  }
}

/**
 * 生产装配(Ark OpenAPI adapter + 凭据、TOS 校验)属于 composition root;
 * vNext 路由只消费 SnapshotARegistrationPort / SnapshotATosVerificationPort。
 * 注册后端缺省 undefined = 未注入:导入仍落 PostgreSQL 真源,注册状态记录
 * 「未开启、未发送任何请求」;TOS 校验缺省则导入直接失败,不落任何资产行。
 */

/** Agent 与界面共用同一写入服务;actorKind 由认证钩子按凭证来源给出,缺省按人类计。 */
function currentActorKind(request: FastifyRequest): VnextActorKind {
  return request.authContext?.credential.actorKind === "agent" ? "agent" : "human";
}

function fromWireDocument(document: z.infer<typeof graphDocument>): GraphDocument {
  return { schemaVersion: 1, nodes: document.nodes, edges: document.edges };
}

function toDocumentResponse(document: VnextGraphDocument) {
  return {
    projectId: document.projectId,
    revision: document.revision,
    document: { schemaVersion: 1, nodes: document.document.nodes, edges: document.document.edges },
    updatedAt: document.updatedAt,
    lastWrite: document.lastWrite,
  };
}
function toLegacyAssetResponse(asset: SnapshotAssetView) {
  return {
    id: asset.id,
    library_name: asset.libraryName,
    source_system: asset.sourceSystem,
    source_id: asset.sourceId,
    name: asset.name,
    asset_kind: asset.assetKind,
    media_kind: asset.mediaKind,
    media_url: asset.mediaUrl,
    media_sha256: asset.mediaSha256,
    snapshot_at: asset.snapshotAt.toISOString(),
    snapshot_version: asset.snapshotVersion,
    review_status: asset.reviewStatus,
    registration_status: asset.registrationStatus,
    registration_id: asset.registrationId,
    registration_failure_code: asset.registrationFailureCode,
    registration_failure_reason: asset.registrationFailureReason,
    registration_readback: asset.registrationReadback,
  };
}

function fromWireTelemetry(event: z.infer<typeof telemetryEvent>): GenerationTelemetryEvent {
  return {
    id: event.id, userId: event.user_id, requestId: event.request_id, projectId: event.project_id, taskId: event.task_id,
    eventType: event.event_type, provider: event.provider, model: event.model,
    capabilitySnapshotVersion: event.capability_snapshot_version, paidConfirmation: event.paid_confirmation,
    queueLatencyMs: event.queue_latency_ms, providerLatencyMs: event.provider_latency_ms,
    providerCostFen: event.provider_cost_fen, resultStatus: event.result_status, retryReason: event.retry_reason,
  };
}

function toScriptRunResponse(run: Awaited<ReturnType<VnextScriptService["createRun"]>>["run"]) {
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    progress: run.progress,
    currentStage: run.currentStage,
    draft: run.draft,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    confirmedAt: run.confirmedAt,
  };
}

export function newTelemetryEventId(): string {
  return randomUUID();
}

type JsonSchema = Record<string, unknown>;

const uuidOpenApiSchema = { type: "string", format: "uuid" } as const;
const dateTimeOpenApiSchema = { type: "string", format: "date-time" } as const;
const projectParamsOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["project_id"],
  properties: { project_id: uuidOpenApiSchema },
} as const;
const graphNodeOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "label", "position"],
  properties: {
    id: uuidOpenApiSchema,
    kind: { type: "string", enum: ["scene", "asset", "task", "note"] },
    label: { type: "string", minLength: 1, maxLength: 240 },
    position: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: { x: { type: "number" }, y: { type: "number" } },
    },
    data: {
      type: "object",
      additionalProperties: {
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
        ],
      },
    },
  },
} as const;
const graphEdgeOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "source", "target"],
  properties: {
    id: uuidOpenApiSchema,
    source: uuidOpenApiSchema,
    target: uuidOpenApiSchema,
    label: { type: "string", minLength: 1, maxLength: 240 },
  },
} as const;
const graphDocumentOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "nodes", "edges"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    nodes: { type: "array", maxItems: 1000, items: graphNodeOpenApiSchema },
    edges: { type: "array", maxItems: 2000, items: graphEdgeOpenApiSchema },
  },
} as const;
const projectOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "created_at", "updated_at"],
  properties: {
    id: uuidOpenApiSchema,
    name: { type: "string" },
    created_at: dateTimeOpenApiSchema,
    updated_at: dateTimeOpenApiSchema,
  },
} as const;
const lastWriteOpenApiSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "user_id", "at"],
      properties: {
        kind: { type: "string", enum: ["human", "agent"] },
        user_id: { anyOf: [uuidOpenApiSchema, { type: "null" }] },
        at: dateTimeOpenApiSchema,
      },
    },
    { type: "null" },
  ],
} as const;
const graphSnapshotOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["project_id", "revision", "document", "updated_at", "last_write"],
  properties: {
    project_id: uuidOpenApiSchema,
    revision: { type: "integer", minimum: 0 },
    document: graphDocumentOpenApiSchema,
    updated_at: dateTimeOpenApiSchema,
    last_write: lastWriteOpenApiSchema,
  },
} as const;
const errorEnvelopeOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "error"],
  properties: {
    ok: { type: "boolean", const: false },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable", "details"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        details: {},
      },
    },
  },
} as const;

function successOpenApiSchema(data: JsonSchema): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ok", "data"],
    properties: { ok: { type: "boolean", const: true }, data },
  };
}

const commonErrors = {
  400: errorEnvelopeOpenApiSchema,
  401: errorEnvelopeOpenApiSchema,
  403: errorEnvelopeOpenApiSchema,
  404: errorEnvelopeOpenApiSchema,
  409: errorEnvelopeOpenApiSchema,
} as const;
const vnextOpenApiBase = { tags: ["vNext"] } as const;

const listProjectsOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "列出当前用户可访问的 vNext 项目",
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["items", "next_cursor"],
      properties: {
        items: { type: "array", items: projectOpenApiSchema },
        next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    }),
    ...commonErrors,
  },
} as const;

const createProjectOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "创建 vNext 项目",
  body: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", minLength: 1, maxLength: 255 } },
  },
  response: { 201: successOpenApiSchema(projectOpenApiSchema), ...commonErrors },
} as const;

const getProjectOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "读取 vNext 项目",
  params: projectParamsOpenApiSchema,
  response: { 200: successOpenApiSchema(projectOpenApiSchema), ...commonErrors },
} as const;

const getGraphOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "读取 vNext GraphDocument 当前修订",
  params: projectParamsOpenApiSchema,
  response: { 200: successOpenApiSchema(graphSnapshotOpenApiSchema), ...commonErrors },
} as const;

const putGraphOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "以 revision CAS 写入 vNext GraphDocument",
  params: projectParamsOpenApiSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["expected_revision", "document"],
    properties: {
      expected_revision: { type: "integer", minimum: 0 },
      document: graphDocumentOpenApiSchema,
    },
  },
  response: { 200: successOpenApiSchema(graphSnapshotOpenApiSchema), ...commonErrors },
} as const;

const listRevisionsOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "列出 vNext GraphDocument 修订",
  params: projectParamsOpenApiSchema,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
  },
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["revision", "created_by_user_id", "created_by_kind", "created_at"],
            properties: {
              revision: { type: "integer", minimum: 1 },
              created_by_user_id: { anyOf: [uuidOpenApiSchema, { type: "null" }] },
              created_by_kind: { type: "string", enum: ["human", "agent"] },
              created_at: dateTimeOpenApiSchema,
            },
          },
        },
      },
    }),
    ...commonErrors,
  },
} as const;

const telemetryOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "记录 vNext 生成遥测元数据",
  body: {
    type: "object",
    additionalProperties: false,
    required: ["id", "user_id", "request_id", "project_id", "task_id", "event_type"],
    properties: {
      id: uuidOpenApiSchema,
      user_id: uuidOpenApiSchema,
      request_id: { type: "string", minLength: 1, maxLength: 128 },
      project_id: uuidOpenApiSchema,
      task_id: uuidOpenApiSchema,
      event_type: { type: "string", minLength: 1, maxLength: 64 },
      provider: { type: "string", minLength: 1, maxLength: 128 },
      model: { type: "string", minLength: 1, maxLength: 256 },
      capability_snapshot_version: { type: "string", minLength: 1, maxLength: 128 },
      paid_confirmation: { type: "boolean" },
      queue_latency_ms: { type: "integer", minimum: 0 },
      provider_latency_ms: { type: "integer", minimum: 0 },
      provider_cost_fen: { type: "integer", minimum: 0 },
      result_status: { type: "string", minLength: 1, maxLength: 64 },
      retry_reason: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  response: {
    201: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: uuidOpenApiSchema },
    }),
    ...commonErrors,
  },
} as const;

const shotPlanCharacterDraftOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "name", "description"],
  properties: {
    key: { type: "string", minLength: 1, maxLength: 128 },
    name: { type: "string", minLength: 1, maxLength: 160 },
    description: { type: "string", minLength: 1, maxLength: 4_000 },
  },
} as const;
const shotPlanSceneDraftOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "title", "summary", "position"],
  properties: {
    key: { type: "string", minLength: 1, maxLength: 128 },
    title: { type: "string", minLength: 1, maxLength: 240 },
    summary: { type: "string", minLength: 1, maxLength: 4_000 },
    position: { type: "integer", minimum: 0 },
  },
} as const;
const shotPlanShotDraftOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "key", "scene_key", "position", "shot_size", "camera_movement",
    "action", "rhythm", "dialogue", "sound",
  ],
  properties: {
    key: { type: "string", minLength: 1, maxLength: 128 },
    scene_key: { type: "string", minLength: 1, maxLength: 128 },
    position: { type: "integer", minimum: 0 },
    shot_size: { type: "string", minLength: 1, maxLength: 64 },
    camera_movement: { type: "string", minLength: 1, maxLength: 160 },
    action: { type: "string", minLength: 1, maxLength: 4_000 },
    rhythm: { type: "string", minLength: 1, maxLength: 160 },
    dialogue: { type: "string", minLength: 1, maxLength: 4_000 },
    sound: { type: "string", minLength: 1, maxLength: 4_000 },
  },
} as const;
const shotPlanDraftOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "characters", "scenes", "shots", "warnings"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    characters: { type: "array", items: shotPlanCharacterDraftOpenApiSchema },
    scenes: { type: "array", items: shotPlanSceneDraftOpenApiSchema },
    shots: { type: "array", items: shotPlanShotDraftOpenApiSchema },
    warnings: {
      type: "array",
      maxItems: 200,
      items: { type: "string", minLength: 1, maxLength: 255 },
    },
  },
} as const;
const scriptParseErrorOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "retryable"],
  properties: {
    code: {
      type: "string",
      enum: [
        "script_partial_failure",
        "script_model_unavailable",
        "script_parse_timeout",
        "script_schema_validation_failed",
      ],
    },
    message: { type: "string" },
    retryable: { type: "boolean" },
  },
} as const;
const scriptRunOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "project_id", "status", "progress", "current_stage", "draft",
    "error", "created_at", "updated_at", "confirmed_at",
  ],
  properties: {
    id: uuidOpenApiSchema,
    project_id: uuidOpenApiSchema,
    status: {
      type: "string",
      enum: ["queued", "running", "draft", "partial_failure", "failed", "confirmed"],
    },
    progress: { type: "integer", minimum: 0, maximum: 100 },
    current_stage: {
      type: "string",
      enum: ["queued", "reading", "structuring", "validating", "ready", "failed", "confirmed"],
    },
    draft: { anyOf: [shotPlanDraftOpenApiSchema, { type: "null" }] },
    error: { anyOf: [scriptParseErrorOpenApiSchema, { type: "null" }] },
    created_at: dateTimeOpenApiSchema,
    updated_at: dateTimeOpenApiSchema,
    confirmed_at: { anyOf: [dateTimeOpenApiSchema, { type: "null" }] },
  },
} as const;

const formalShotPlanFactsOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["confirmation_id", "confirmed_at", "characters", "scenes", "shots"],
  properties: {
    confirmation_id: uuidOpenApiSchema,
    confirmed_at: dateTimeOpenApiSchema,
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "key", "name", "description"],
        properties: {
          id: uuidOpenApiSchema,
          key: { type: "string", minLength: 1, maxLength: 128 },
          name: { type: "string", minLength: 1, maxLength: 160 },
          description: { type: "string", minLength: 1, maxLength: 4_000 },
        },
      },
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "key", "title", "summary", "position"],
        properties: {
          id: uuidOpenApiSchema,
          key: { type: "string", minLength: 1, maxLength: 128 },
          title: { type: "string", minLength: 1, maxLength: 240 },
          summary: { type: "string", minLength: 1, maxLength: 4_000 },
          position: { type: "integer", minimum: 0 },
        },
      },
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "scene_id", "key", "position", "shot_size", "camera_movement",
          "action", "rhythm", "dialogue", "sound",
        ],
        properties: {
          id: uuidOpenApiSchema,
          scene_id: uuidOpenApiSchema,
          key: { type: "string", minLength: 1, maxLength: 128 },
          position: { type: "integer", minimum: 0 },
          shot_size: { type: "string", minLength: 1, maxLength: 64 },
          camera_movement: { type: "string", minLength: 1, maxLength: 160 },
          action: { type: "string", minLength: 1, maxLength: 4_000 },
          rhythm: { type: "string", minLength: 1, maxLength: 160 },
          dialogue: { type: "string", minLength: 1, maxLength: 4_000 },
          sound: { type: "string", minLength: 1, maxLength: 4_000 },
        },
      },
    },
  },
} as const;

const createScriptRunOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "导入固定剧本并启动持久化解析",
  params: projectParamsOpenApiSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["source_kind", "script_content", "client_idempotency_key"],
    properties: {
      source_kind: { type: "string", enum: ["paste", "upload"] },
      file_name: { type: "string", minLength: 1, maxLength: 255 },
      script_content: { type: "string", minLength: 1, maxLength: 200_000 },
      client_idempotency_key: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["run", "outcome"],
      properties: {
        run: scriptRunOpenApiSchema,
        outcome: { type: "string", enum: ["created", "replayed"] },
      },
    }),
    202: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["run", "outcome"],
      properties: {
        run: scriptRunOpenApiSchema,
        outcome: { type: "string", enum: ["created", "replayed"] },
      },
    }),
    ...commonErrors,
  },
} as const;

const getScriptWorkbenchOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "恢复剧本解析草稿、确认状态和正式分镜事实",
  params: projectParamsOpenApiSchema,
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["run", "formal_facts"],
      properties: {
        run: { anyOf: [scriptRunOpenApiSchema, { type: "null" }] },
        formal_facts: { anyOf: [formalShotPlanFactsOpenApiSchema, { type: "null" }] },
      },
    }),
    ...commonErrors,
  },
} as const;

const retryScriptRunOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "重试可恢复的剧本解析失败",
  params: {
    type: "object",
    additionalProperties: false,
    required: ["run_id"],
    properties: { run_id: uuidOpenApiSchema },
  },
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["run", "outcome"],
      properties: {
        run: scriptRunOpenApiSchema,
        outcome: { type: "string", enum: ["created", "replayed"] },
      },
    }),
    202: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["run", "outcome"],
      properties: {
        run: scriptRunOpenApiSchema,
        outcome: { type: "string", enum: ["created", "replayed"] },
      },
    }),
    ...commonErrors,
  },
} as const;

const confirmScriptRunOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "事务性、幂等地确认分镜草稿为正式事实",
  params: {
    type: "object",
    additionalProperties: false,
    required: ["run_id"],
    properties: { run_id: uuidOpenApiSchema },
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: ["client_idempotency_key"],
    properties: { client_idempotency_key: { type: "string", minLength: 1, maxLength: 128 } },
  },
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["formal_facts"],
      properties: { formal_facts: formalShotPlanFactsOpenApiSchema },
    }),
    ...commonErrors,
  },
} as const;

const snapshotAssetOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "library_name", "source_system", "source_id", "name", "asset_kind",
    "media_kind", "media_url", "media_sha256", "snapshot_at", "snapshot_version",
    "review_status", "registration_status", "registration_id",
    "registration_failure_code", "registration_failure_reason", "registration_readback",
  ],
  properties: {
    id: uuidOpenApiSchema,
    library_name: { type: "string" },
    source_system: { type: "string" },
    source_id: { type: "string" },
    name: { type: "string" },
    asset_kind: { type: "string", enum: ["character", "scene", "prop"] },
    media_kind: { type: "string", enum: ["image", "video", "audio"] },
    media_url: { type: "string" },
    media_sha256: { type: "string" },
    snapshot_at: dateTimeOpenApiSchema,
    snapshot_version: { type: "string" },
    review_status: { type: "string", enum: ["approved", "pending_review", "rejected"] },
    registration_status: {
      type: "string",
      enum: ["not_required", "pending", "active", "processing", "failed", "unknown"],
    },
    registration_id: { anyOf: [{ type: "string" }, { type: "null" }] },
    registration_failure_code: { anyOf: [{ type: "string" }, { type: "null" }] },
    registration_failure_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    registration_readback: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
  },
} as const;

const legacyLibraryOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "列出旧系统素材库快照素材",
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", items: snapshotAssetOpenApiSchema } },
    }),
    ...commonErrors,
  },
} as const;

const snapshotAImportOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "导入快照 A 非真人参考素材(受信清单+TOS 校验;幂等重放同一来源映射)",
  body: {
    type: "object",
    additionalProperties: false,
    required: [
      "source_system", "source_id", "name", "asset_kind", "media_kind",
      "media_url", "media_sha256", "snapshot_at", "snapshot_version",
    ],
    properties: {
      source_system: { type: "string", minLength: 1, maxLength: 64 },
      source_id: { type: "string", minLength: 1, maxLength: 255 },
      name: { type: "string", minLength: 1, maxLength: 255 },
      asset_kind: { type: "string", enum: ["character", "scene", "prop"] },
      media_kind: { type: "string", enum: ["image", "video", "audio"] },
      media_url: { type: "string", format: "uri", maxLength: 2000 },
      media_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      snapshot_at: dateTimeOpenApiSchema,
      snapshot_version: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["asset", "outcome"],
      properties: {
        asset: snapshotAssetOpenApiSchema,
        outcome: { type: "string", enum: ["created", "replayed"] },
      },
    }),
    201: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["asset", "outcome"],
      properties: {
        asset: snapshotAssetOpenApiSchema,
        outcome: { type: "string", enum: ["created", "replayed"] },
      },
    }),
    ...commonErrors,
  },
} as const;

const retrySnapshotRegistrationOpenApiSchema = {
  ...vnextOpenApiBase,
  summary: "恢复快照素材的火山私域素材注册(失败可重试;结果不明确走回读)",
  params: {
    type: "object",
    additionalProperties: false,
    required: ["asset_id"],
    properties: { asset_id: uuidOpenApiSchema },
  },
  response: {
    200: successOpenApiSchema({
      type: "object",
      additionalProperties: false,
      required: ["asset"],
      properties: { asset: snapshotAssetOpenApiSchema },
    }),
    ...commonErrors,
  },
} as const;
