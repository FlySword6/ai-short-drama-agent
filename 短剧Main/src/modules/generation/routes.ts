import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { promptDefaultTemplates } from "../../db/schema.js";
import { settings } from "../../config/env.js";
import {
  requireCurrentContext,
  requireCurrentUser,
  type AuthenticatedUser,
} from "../../http/authenticate.js";
import { toHttpErrorResponse } from "../../http/errorResponse.js";
import { parseRequest, success } from "../../http/response.js";
import { AppError, errorBody, publicStoredMessage } from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessAction } from "../project-access/types.js";
import { estimateGenerationCost } from "./cost.js";
import { GenerationError } from "./errors.js";
import type {
  PostgresGenerationRepository,
  ProjectGenerationConfig,
} from "./repository.js";
export type { ShotFinalReferenceResolution } from "./repository.js";
import type { GenerationCapability } from "./provider/modelProviderRegistry.js";
import {
  createGenerationProviderRegistry,
  createGenerationRepository,
  createGenerationService,
  requireGenerationRequestConfigured,
  requireGenerationSubmissionReady,
} from "./factory.js";
import {
  deriveReferenceMode,
  readReferenceSnapshots,
  referenceManifest,
  isArkSeedance2Model,
  normalizeV01Parameters,
  V01GenerationContractError,
} from "./v01Contract.js";
import {
  compileAutoPrompt,
  DEFAULT_IMAGE_PROMPT_TEMPLATE,
  DEFAULT_VIDEO_PROMPT_TEMPLATE,
  joinPromptSegments,
  SEGMENT_NO_BGM_CONSTRAINT,
  SEGMENT_PROMPT_DEFAULTS_VERSION,
  stripPromptTimecodes,
  type PromptCompilationContext,
} from "./promptCompiler.js";
import { compileAudioPrompt } from "../audio/prompts.js";
import type { AudioPromptDimensions } from "../audio/types.js";
import type {
  BatchGenerationSubmitInput,
  GenerationAttemptNotificationView,
  GenerationBatchSubmissionView,
  GenerationFailedView,
  GenerationInFlightView,
  GenerationParameters,
  GenerationPromptCompilation,
  GenerationQuoteSource,
  ScopedGenerationActor,
  GenerationQuoteView,
  GenerationReferenceSnapshot,
  GenerationView,
  PrecheckResult,
  SubmitGenerationInput,
} from "./types.js";
import { evaluatePromptCompleteness } from "./promptPrechecker.js";
import { buildPrecheckInput } from "./precheckDerive.js";

const uuid = z.string().uuid();
const requestParams = z.object({ request_id: uuid });
const projectParams = z.object({ project_id: uuid });
const quoteParams = z.object({ quote_id: uuid });
const batchAuthorizationParams = z.object({ authorization_id: uuid });
const notificationParams = z.object({ notification_id: uuid });
const notificationListQuery = z.object({
  // This is an unread-reminder drain, not a history endpoint. A bounded,
  // stable page prevents an old batch from flooding the application shell.
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
const inFlightListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(24),
});
const parameterSchema = z.record(z.string(), z.unknown()).default({});
const simpleEstimateSchema = z.object({
  media_kind: z.enum(["image", "video", "audio"]),
  tier_id: z.string().trim().min(1).max(128),
  parameters: parameterSchema,
  quantity: z.coerce.number().int().min(1).max(8).default(1),
});

const generationInputShape = {
  media_kind: z.enum(["image", "video", "audio"]),
  tier_id: z.string().trim().min(1).max(128),
  project_id: uuid,
  episode_id: uuid.nullable().optional(),
  scene_id: uuid.nullable().optional(),
  shot_id: uuid.nullable().optional(),
  target_asset_entity_id: uuid.nullable().optional(),
  /** v1.9 十.10：发起生成的变体（Lite 从变体生图时带上，产物按变体归属）。 */
  target_asset_variant_id: uuid.nullable().optional(),
  // 两段式提示词(合同第二节):prompt 为传统全人工段,supplement_prompt 为
  // 人工补充段(自动段由服务端编译)。二者互斥,语义校验在路由层统一 422。
  prompt: z.string().trim().min(1).max(100_000).optional(),
  // 人工补充段上限 5000：Lite 提示词模板库（prompt_templates 表）的内容经客户端
  // 解析后以 supplement_prompt 提交（docs/design/prd-v2/lite-model-defaults.md §4.3，
  // 生成期拼接与模板表无关，模板内容走补充段）。
  supplement_prompt: z.string().trim().max(5000).optional(),
  audio_prompt_dimensions: z.object({
    voiceReference: z.string().max(1000).optional(),
    performanceEmotion: z.string().max(1000).optional(),
    paceAndPauses: z.string().max(1000).optional(),
    languageAndAccent: z.string().max(1000).optional(),
    vocalDistance: z.string().max(1000).optional(),
    continuity: z.string().max(1000).optional(),
  }).strict().optional(),
  use_project_style: z.boolean().default(true),
  // The legacy shape remains accepted during the compatibility window. Do not
  // default this field here: an absent legacy field must be distinguishable
  // from a client sending both shapes, which is an ambiguous request.
  reference_media_ids: z.array(uuid).max(20).optional(),
  // Reference and start/end frames are distinct control slots. A media ID may
  // not appear in more than one slot; the repository verifies asset usage_mode.
  first_frame_media_id: uuid.optional(),
  last_frame_media_id: uuid.optional(),
  // The control-asset contract's canonical input. `references` may contain
  // the ordinary reference set plus at most one first/last-frame anchor.
  // Semantic validation lives below so violations consistently become 422.
  references: z.array(z.object({
    media_id: uuid,
    usage_mode: z.string(),
  })).max(22).optional(),
  parameters: parameterSchema,
  quantity: z.coerce.number().int().min(1).max(8).default(1),
  client_idempotency_key: z.string().trim().min(8).max(255),
};

const batchEstimateItemSchema = z.object({
  /**
   * Client-provided stable handle. It is echoed for every outcome so a batch
   * list can remain in its original order even when individual rows fail.
   */
  item_id: z.string().trim().min(1).max(128),
  ...generationInputShape,
}).refine((input) => Boolean(input.shot_id || input.target_asset_entity_id), {
  message: "shot_id 和 target_asset_entity_id 至少提供一个",
});

const batchEstimateSchema = z.object({
  // Individual rows intentionally remain unknown at this boundary. A batch
  // estimate is a preparation list: one invalid row must not hide estimates
  // for the other rows. Container errors still fail the whole request.
  production_mode: z.enum(["full", "sample"]).default("full"),
  items: z.array(z.unknown()).min(1).max(50),
});

const batchSubmitItemSchema = z.object({
  item_id: z.string().trim().min(1).max(128),
  generation_quote_id: uuid,
});

const batchSubmitSchema = z.object({
  project_id: uuid,
  client_idempotency_key: z.string().trim().min(8).max(255),
  expected_total_estimated_cost_fen: z.coerce.number().int().min(0),
  production_mode: z.enum(["full", "sample"]).default("full"),
  items: z.array(batchSubmitItemSchema).min(1).max(50),
}).superRefine((input, context) => {
  const itemIds = new Set<string>();
  const quoteIds = new Set<string>();
  for (const [index, item] of input.items.entries()) {
    if (itemIds.has(item.item_id)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "item_id"],
        message: "清单项 item_id 不能重复",
      });
    }
    if (quoteIds.has(item.generation_quote_id)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "generation_quote_id"],
        message: "同一报价不能在一份清单中重复使用",
      });
    }
    itemIds.add(item.item_id);
    quoteIds.add(item.generation_quote_id);
  }
});

const precheckRequestSchema = z.object({
  project_id: uuid,
  shot_id: uuid.nullable().optional(),
  target_asset_entity_id: uuid.nullable().optional(),
  episode_id: uuid.nullable().optional(),
  scene_id: uuid.nullable().optional(),
  tier_id: z.string().trim().min(1).max(128),
  media_kind: z.enum(["image", "video", "audio"]),
  supplement_prompt: z.string().trim().max(2000).optional(),
  audio_prompt_dimensions: z.object({
    voiceReference: z.string().max(1000).optional(),
    performanceEmotion: z.string().max(1000).optional(),
    paceAndPauses: z.string().max(1000).optional(),
    languageAndAccent: z.string().max(1000).optional(),
    vocalDistance: z.string().max(1000).optional(),
    continuity: z.string().max(1000).optional(),
  }).strict().optional(),
  reference_media_ids: z.array(uuid).max(20).optional(),
  first_frame_media_id: uuid.optional(),
  last_frame_media_id: uuid.optional(),
  references: z.array(z.object({
    media_id: uuid,
    usage_mode: z.string(),
  })).max(22).optional(),
  parameters: parameterSchema,
  quantity: z.coerce.number().int().min(1).max(8).default(1),
  reference_lane_count: z.coerce.number().int().min(0).max(22).default(0),
}).refine((input) => Boolean(input.shot_id || input.target_asset_entity_id || input.scene_id), {
  message: "shot_id、target_asset_entity_id 或 scene_id 至少提供一个",
});

const submissionEstimateSchema = z.object({
  ...generationInputShape,
  action: z.literal("submit").default("submit"),
  source: z.enum(["web", "cli"]).optional(),
}).refine((input) => Boolean(input.shot_id || input.target_asset_entity_id), {
  message: "shot_id 和 target_asset_entity_id 至少提供一个",
});

const retryEstimateSchema = z.object({
  action: z.literal("retry"),
  source: z.enum(["web", "cli"]).optional(),
  original_request_id: uuid,
});

const submissionSchema = z.object({
  ...generationInputShape,
  generation_quote_id: uuid,
  cost_confirmed: z.literal(true).optional(),
  /** v1.9 十.7：Lite 自动确认（提交事务内确认 pending 报价）。完整版不带此键。 */
  auto_confirm: z.literal(true).optional(),
}).refine((input) => Boolean(input.shot_id || input.target_asset_entity_id), {
  message: "shot_id 和 target_asset_entity_id 至少提供一个",
});

const retrySchema = z.object({
  generation_quote_id: uuid,
  client_idempotency_key: z.string().trim().min(8).max(255),
  cost_confirmed: z.literal(true).optional(),
  /** v1.9 十.7：同 submission。 */
  auto_confirm: z.literal(true).optional(),
});

const fullEstimateKeys = new Set([
  "project_id",
  "episode_id",
  "scene_id",
  "shot_id",
  "target_asset_entity_id",
  "prompt",
  "supplement_prompt",
  "audio_prompt_dimensions",
  "reference_media_ids",
  "first_frame_media_id",
  "last_frame_media_id",
  "references",
  "use_project_style",
  "client_idempotency_key",
]);

type GenerationRouteRepository = ReturnType<typeof createGenerationRepository>;
type GenerationProjectAccess = Pick<ProjectAccessService, "require">;

/** Injectable only for route-level contract tests; production uses PostgreSQL. */
export interface GenerationRouteDependencies {
  createRepository?: (database: Database) => GenerationRouteRepository;
  createProjectAccessService?: (database: Database) => GenerationProjectAccess;
  /** Route tests use a no-op seam; production always checks paid readiness. */
  requireSubmissionReady?: (mediaKind?: "image" | "video" | "audio") => void;
}

export async function registerGenerationRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: GenerationRouteDependencies = {},
): Promise<void> {
  const repository = () => dependencies.createRepository?.(getDatabase())
    ?? createGenerationRepository(getDatabase());
  const projectAccess = () => dependencies.createProjectAccessService?.(getDatabase())
    ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(getDatabase()));

  app.get("/api/v1/generation-models", async (request) => {
    requireCurrentUser(request);
    const items = createGenerationProviderRegistry().listCapabilities().map(generationCapabilityData);
    return success({ items, count: items.length });
  });

  // 平台默认提示词模板（只读；docs/design/prd-v2/lite-model-defaults.md v1.0）。
  // v1.0 起默认配置=数据：读 prompt_default_templates（迁移 064 播种的两条平台默认模板），
  // 缺行/表不存在（老环境未迁移）时回落代码常量（promptCompiler.ts）。
  app.get("/api/v1/generation/default-prompt-templates", async (request) => {
    requireCurrentUser(request);
    let image: string | undefined;
    let video: string | undefined;
    try {
      const rows = await getDatabase()
        .select({
          mediaKind: promptDefaultTemplates.mediaKind,
          content: promptDefaultTemplates.content,
        })
        .from(promptDefaultTemplates);
      for (const row of rows) {
        if (row.mediaKind === "image") image = row.content;
        else if (row.mediaKind === "video") video = row.content;
      }
    } catch {
      // 未跑迁移 064 的环境没有本表：按历史行为回落到代码常量。
    }
    return success({
      image: image ?? DEFAULT_IMAGE_PROMPT_TEMPLATE,
      video: video ?? DEFAULT_VIDEO_PROMPT_TEMPLATE,
    });
  });

  app.get("/api/v1/generation-attempt-notifications", async (request) => {
    const actor = requireCurrentUser(request);
    const query = parseRequest(notificationListQuery, request.query);
    const items = await repository().listUnacknowledgedAttemptNotifications(actor.id, query.limit);
    return success({ items: items.map(generationAttemptNotificationData), count: items.length });
  });

  app.post("/api/v1/generation-attempt-notifications/:notification_id/acknowledge", async (request) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(notificationParams, request.params);
    await repository().acknowledgeAttemptNotification(actor.id, params.notification_id);
    return success({ notification_id: params.notification_id, acknowledged: true });
  });

  app.get("/api/v1/generations/in-flight", async (request) => {
    const actor = requireCurrentUser(request);
    const query = parseRequest(inFlightListQuery, request.query);
    const result = await createGenerationService(repository()).listInFlight(
      actor.id,
      query.page,
      query.page_size,
    );
    return success({
      items: result.items.map(inFlightGenerationData),
      page: result.page,
      page_size: result.pageSize,
      total: result.total,
      has_more: result.page * result.pageSize < result.total,
    });
  });

  app.get("/api/v1/generations/failed", async (request) => {
    const actor = requireCurrentUser(request);
    const query = parseRequest(inFlightListQuery, request.query);
    const result = await createGenerationService(repository()).listFailed(
      actor.id,
      query.page,
      query.page_size,
    );
    return success({
      items: result.items.map(failedGenerationData),
      page: result.page,
      page_size: result.pageSize,
      total: result.total,
      has_more: result.page * result.pageSize < result.total,
    });
  });

  app.post("/api/v1/generations/estimate", async (request) => {
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    rejectBatchOnlyProductionMode(body);
    if (body.action === "retry") {
      const input = parseRequest(retryEstimateSchema, request.body);
      const actor = requireCurrentUser(request);
      const generationRepository = repository();
      const generationActor = await authorizeGenerationRequest(
        generationRepository,
        projectAccess(),
        actor,
        input.original_request_id,
        "create",
      );
      const quote = await createGenerationService(generationRepository).quoteRetry(
        generationActor,
        input.original_request_id,
        generationSource(request),
      );
      return success(quoteData(quote));
    }

    const hasFullInput = Object.keys(body).some((key) => fullEstimateKeys.has(key));
    if (hasFullInput) {
      const input = parseRequest(submissionEstimateSchema, request.body);
      const actor = requireCurrentUser(request);
      /* 估价不触发就绪门禁（历史行为）：门禁在提交路由真执行。 */
      const { quote } = await submitGenerationRequest(repository(), projectAccess(), actor, generationSource(request), input, {
        requireSubmissionReady: () => undefined,
      });
      // estimate 的 zod schema 不含 generation_quote_id，必走新建报价分支，quote 恒非空。
      if (!quote) throw new GenerationError("INVALID_GENERATION_REQUEST", "估价请求不应携带已确认报价", 400);
      return success(quoteData(quote));
    }

    const input = parseRequest(simpleEstimateSchema, request.body);
    const generationRepository = repository();
    const tier = await requireActiveTier(generationRepository, input);
    requireGenerationRequestConfigured({
      mediaKind: input.media_kind,
      model: tier.rule.model,
      parameters: tier.parameters,
    }, tier.rule.provider);
    let estimate;
    try {
      estimate = estimateGenerationCost(tier.rule, {
        mediaKind: input.media_kind,
        tierId: tier.tierId,
        model: tier.rule.model,
        quantity: input.quantity,
        parameters: tier.parameters,
        referenceAssetSnapshots: [],
      });
    } catch (error) {
      throw new AppError(
        400,
        "invalid_generation_parameters",
        error instanceof Error ? error.message : "生成参数无法计费",
      );
    }
    return success({
      ...quotePriceSnapshotData(estimate),
      requires_manual_review: requiresManualReview(estimate.estimatedCostFen),
      notice: "预估消耗，非云平台实际账单",
      generation_quote_id: null,
    });
  });

  /**
   * 提示词完整度预检 (规划文档 §5.2): 纯规则评分器,零 LLM 调用,零成本。
   * 不硬阻止提交: 低分仍能点生成,只给醒目提示。
   * 复用 authorizeGenerationProject / requireActiveTier / resolveControlReferences /
   * resolveSubmissionPrompt / resolvePromptCompilationContext,与 estimate 同源。
   */
  app.post("/api/v1/generations/precheck", async (request) => {
    const input = parseRequest(precheckRequestSchema, request.body);
    const actor = requireCurrentUser(request);
    const generationActor = await authorizeGenerationProject(projectAccess(), actor, input.project_id, "create");
    const generationRepository = repository();
    const tier = await requireActiveTier(generationRepository, input);
    const controls = await resolveControlReferences(generationRepository, actor.id, input, {
      useRegisteredSeedanceAssetUris: usesRegisteredSeedanceAssetUris(input.media_kind, tier.rule.model),
      enforceReferenceImageDimensions: usesSeedanceReferenceImageDimensions(input.media_kind),
      authorizedProjectId: generationActor.authorizedProjectId,
    });

    // 编译自动段 prompt (与 estimate/submit 同源)
    const context: PromptCompilationContext = await generationRepository.resolvePromptCompilationContext({
      projectId: input.project_id,
      ...(input.episode_id ? { episodeId: input.episode_id } : {}),
      ...(input.scene_id ? { sceneId: input.scene_id } : {}),
      ...(input.shot_id ? { shotId: input.shot_id } : {}),
      referenceMediaIds: controls.mediaIds,
      ...(input.media_kind === "image" || input.media_kind === "video" ? { mediaKind: input.media_kind } : {}),
    });
    const compiled = compileAutoPrompt(context);
    const precheckManualPrompt = compiled.lockedPrompt !== undefined
      ? input.supplement_prompt?.includes(compiled.lockedPrompt)
        ? input.supplement_prompt
        : joinPromptSegments(compiled.lockedPrompt, input.supplement_prompt ?? "")
      : input.supplement_prompt;

    // 评估
    const precheckInput = buildPrecheckInput({
      context: compiled.lockedPrompt === undefined ? context : {},
      autoPrompt: compiled.autoPrompt,
      ...(precheckManualPrompt ? { manualPrompt: precheckManualPrompt } : {}),
      referenceLaneCount: input.reference_lane_count,
      filledLaneCount: controls.mediaIds.length,
      mediaKind: input.media_kind,
    });
    const result: PrecheckResult = evaluatePromptCompleteness(precheckInput);
    return success(precheckData(result));
  });

  /**
   * Preparation only: this route persists ordinary, expiring quotes so each
   * valid row is traceable, but it never creates a generation request, starts
   * the worker, or invokes a model provider. Batch confirmation/submission is
   * deliberately outside this endpoint.
   */
  app.post("/api/v1/generations/batch-estimate", async (request) => {
    const actor = requireCurrentUser(request);
    const input = parseRequest(batchEstimateSchema, request.body);
    const generationRepository = repository();
    const service = createGenerationService(generationRepository);
    const seenItemIds = new Set<string>();
    const items: BatchEstimateItem[] = [];

    for (const [index, rawItem] of input.items.entries()) {
      const parsed = batchEstimateItemSchema.safeParse(rawItem);
      const itemId = parsed.success
        ? parsed.data.item_id
        : readBatchItemId(rawItem) ?? `invalid-${index + 1}`;
      if (seenItemIds.has(itemId)) {
        items.push(batchItemError(itemId, "invalid", new AppError(
          400,
          "duplicate_batch_item_id",
          "批量清单中的 item_id 不能重复",
        )));
        continue;
      }
      seenItemIds.add(itemId);
      if (!parsed.success) {
        items.push(batchItemError(itemId, "invalid", new AppError(
          400,
          "invalid_request",
          "该清单项内容不正确",
          false,
          parsed.error.issues,
        )));
        continue;
      }

      const item = parsed.data;
      if (input.production_mode === "sample" && item.media_kind !== "video") {
        items.push(batchItemError(item.item_id, "unavailable", new GenerationError(
          "sample_mode_video_only",
          "样片模式仅支持视频生成，请改为成片模式或选择视频项",
          422,
        )));
        continue;
      }
      try {
        const generationActor = await authorizeGenerationProject(projectAccess(), actor, item.project_id, "create");
        const projectConfig = await effectiveProjectGenerationConfig(generationRepository, item);
        const tier = await requireEffectiveProjectTier(generationRepository, item, projectConfig);
        const itemSeedanceAssetUris = usesRegisteredSeedanceAssetUris(item.media_kind, tier.rule.model);
        const itemWithFinal = await withShotFinalImageReference(generationRepository, item, {
          useRegisteredSeedanceAssetUris: itemSeedanceAssetUris,
        });
        const controls = await resolveControlReferences(generationRepository, actor.id, itemWithFinal, {
          useRegisteredSeedanceAssetUris: itemSeedanceAssetUris,
          enforceReferenceImageDimensions: usesSeedanceReferenceImageDimensions(item.media_kind),
          authorizedProjectId: generationActor.authorizedProjectId,
        }, projectConfig.styleReferenceMediaIds);
        const resolvedPrompt = await resolveSubmissionPrompt(
          generationRepository,
          itemWithFinal,
          controls.mediaIds,
          projectConfig,
        );
        const quote = await service.quoteSubmission(
          generationActor,
          submissionInput(
            item,
            tier.tierId,
            tier.rule.model,
            tier.parameters,
            controls.mediaIds,
            controls.snapshots,
            resolvedPrompt,
            input.production_mode,
          ),
          generationSource(request),
        );
        items.push(batchItemAvailable(item.item_id, quote));
      } catch (error) {
        items.push(batchItemError(item.item_id, "unavailable", error));
      }
    }

    return success(batchEstimateData(items, input.production_mode));
  });

  /**
   * A batch has one visible authorization, but each child quote remains an
   * ordinary one-time item. The repository returns row-level outcomes for
   * expired, stale or budget-blocked quotes without quietly changing price.
  */
  app.post("/api/v1/generations/batch-confirm", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const actor = requireCurrentUser(request);
    const input = parseRequest(batchSubmitSchema, request.body);
    const generationActor = await authorizeGenerationProject(projectAccess(), actor, input.project_id, "create");
    const batch: BatchGenerationSubmitInput = {
      projectId: input.project_id,
      clientIdempotencyKey: input.client_idempotency_key,
      expectedTotalEstimatedCostFen: input.expected_total_estimated_cost_fen,
      productionMode: input.production_mode,
      items: input.items.map((item) => ({ itemId: item.item_id, quoteId: item.generation_quote_id })),
    };
    const result = await createGenerationService(repository()).confirmBatch(
      generationActor,
      batch,
      generationSource(request),
    );
    return success(batchSubmissionData(result));
  });

  app.post("/api/v1/generation-batches/:authorization_id/submit", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(batchAuthorizationParams, request.params);
    const generationRepository = repository();
    const service = createGenerationService(generationRepository);
    const projectId = await service.findBatchAuthorizationProjectId(actor.id, params.authorization_id);
    if (!projectId) {
      throw new GenerationError(
        "GENERATION_BATCH_AUTHORIZATION_NOT_FOUND",
        "批量生成授权不存在或你没有访问权限",
        404,
      );
    }
    const generationActor = await authorizeGenerationProject(projectAccess(), actor, projectId, "create");
    (dependencies.requireSubmissionReady ?? requireGenerationSubmissionReady)();
    const result = await service.submitBatchAuthorization(
      generationActor,
      params.authorization_id,
      generationSource(request),
    );
    return accepted(reply, batchSubmissionData(result));
  });

  app.post("/api/v1/generations/batch-submit", async () => {
    throw new AppError(
      410,
      "batch_submit_contract_retired",
      "批量生成已拆为确认和提交两步：请先确认清单费用，再提交已确认的授权。",
    );
  });

  app.post("/api/v1/generation-quotes/:quote_id/confirm", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const params = parseRequest(quoteParams, request.params);
    const actor = requireCurrentUser(request);
    const generationRepository = repository();
    const generationActor = await authorizeGenerationQuote(
      generationRepository,
      projectAccess(),
      actor,
      params.quote_id,
      "create",
    );
    const quote = await createGenerationService(generationRepository).confirmQuote(
      generationActor,
      params.quote_id,
    );
    return success(quoteData(quote));
  });

  app.post("/api/v1/generations", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    rejectBatchOnlyProductionMode(request.body);
    const input = parseRequest(submissionSchema, request.body);
    const actor = requireCurrentUser(request);
    const { view } = await submitGenerationRequest(
      repository(),
      projectAccess(),
      actor,
      generationSource(request),
      input,
      {
        submit: true,
        requireSubmissionReady: dependencies.requireSubmissionReady
          ?? ((mediaKind: "image" | "video" | "audio") => requireGenerationSubmissionReady(undefined, mediaKind)),
      },
    );
    return accepted(reply, generationData(view!));
  });

  app.get("/api/v1/generations/:request_id", async (request) => {
    const params = parseRequest(requestParams, request.params);
    const actor = requireCurrentUser(request);
    const generationRepository = repository();
    const generationActor = await authorizeGenerationRequest(
      generationRepository,
      projectAccess(),
      actor,
      params.request_id,
      "read",
    );
    const view = await createGenerationService(generationRepository).get(generationActor, params.request_id);
    const attempts = await generationRepository.listAttemptViewsForActor(
      actor.id,
      params.request_id,
      generationActor.authorizedProjectId,
    );
    return success({ ...generationData(view), attempts: attempts.map(generationData) });
  });

  app.get("/api/v1/projects/:project_id/generations", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const generationActor = await authorizeGenerationProject(projectAccess(), actor, params.project_id, "read");
    const items = await repository()
      .listViewsForProject(actor.id, params.project_id, generationActor.authorizedProjectId);
    return success({ items: items.map(generationData), count: items.length });
  });

  app.post("/api/v1/generations/:request_id/retry", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const params = parseRequest(requestParams, request.params);
    const input = parseRequest(retrySchema, request.body);
    const actor = requireCurrentUser(request);
    const generationRepository = repository();
    const generationActor = await authorizeGenerationRequest(
      generationRepository,
      projectAccess(),
      actor,
      params.request_id,
      "create",
    );
    (dependencies.requireSubmissionReady ?? requireGenerationSubmissionReady)();
    const view = await createGenerationService(generationRepository).retry(
      generationActor,
      params.request_id,
      input.client_idempotency_key,
      input.generation_quote_id,
      generationSource(request),
      input.auto_confirm,
    );
    return accepted(reply, generationData(view));
  });

  app.post("/api/v1/generations/:request_id/cancel", async (request) => {
    const params = parseRequest(requestParams, request.params);
    const actor = requireCurrentUser(request);
    const generationRepository = repository();
    const generationActor = await authorizeGenerationRequest(
      generationRepository,
      projectAccess(),
      actor,
      params.request_id,
      "create",
    );
    const view = await generationRepository
      .cancelForActor(actor.id, params.request_id, generationActor.authorizedProjectId);
    return success(generationData(view));
  });
}

/** Public catalogue projection: deployment IDs and provider routes stay server-side. */
export function generationCapabilityData(
  capability: GenerationCapability,
): Record<string, unknown> {
  return {
    id: capability.id,
    displayName: capability.displayName,
    mediaKind: capability.mediaKind,
    availability: capability.availability,
    ...(capability.unavailableReason ? { unavailableReason: capability.unavailableReason } : {}),
  };
}

async function authorizeGenerationProject(
  projectAccess: GenerationProjectAccess,
  actor: AuthenticatedUser,
  projectId: string,
  action: ProjectAccessAction,
): Promise<ScopedGenerationActor> {
  const access = await projectAccess.require(actor, projectId, action);
  return { userId: actor.id, authorizedProjectId: access.projectId };
}

async function authorizeGenerationRequest(
  repository: GenerationRouteRepository,
  projectAccess: GenerationProjectAccess,
  actor: AuthenticatedUser,
  requestId: string,
  action: ProjectAccessAction,
): Promise<ScopedGenerationActor> {
  const projectId = await repository.findProjectIdForRequest(requestId);
  if (!projectId) throw generationRouteNotFound();
  return authorizeGenerationProject(projectAccess, actor, projectId, action);
}

async function authorizeGenerationQuote(
  repository: GenerationRouteRepository,
  projectAccess: GenerationProjectAccess,
  actor: AuthenticatedUser,
  quoteId: string,
  action: ProjectAccessAction,
): Promise<ScopedGenerationActor> {
  const projectId = await repository.findProjectIdForQuote(quoteId);
  if (!projectId) throw generationRouteNotFound();
  return authorizeGenerationProject(projectAccess, actor, projectId, action);
}

function generationRouteNotFound(): GenerationError {
  return new GenerationError("GENERATION_NOT_FOUND", "生成任务或目标不存在", 404);
}

function submissionInput(
  input: GenerationSubmissionBody,
  tierId: string,
  model: string,
  parameters: GenerationParameters,
  referenceMediaIds: string[],
  referenceAssetSnapshots: SubmitGenerationInput["referenceAssetSnapshots"],
  resolvedPrompt: ResolvedSubmissionPrompt,
  productionMode: "full" | "sample" = "full",
): SubmitGenerationInput {
  return {
    projectId: input.project_id,
    ...(input.episode_id ? { episodeId: input.episode_id } : {}),
    ...(input.scene_id ? { sceneId: input.scene_id } : {}),
    ...(input.shot_id ? { shotId: input.shot_id } : {}),
    ...(input.target_asset_entity_id ? { targetAssetEntityId: input.target_asset_entity_id } : {}),
    ...(input.target_asset_variant_id ? { targetAssetVariantId: input.target_asset_variant_id } : {}),
    mediaKind: input.media_kind,
    tierId,
    model,
    prompt: resolvedPrompt.prompt,
    ...(resolvedPrompt.promptCompilation ? { promptCompilation: resolvedPrompt.promptCompilation } : {}),
    referenceMediaIds,
    referenceAssetSnapshots,
    parameters,
    quantity: input.quantity,
    productionMode,
    clientIdempotencyKey: input.client_idempotency_key,
  };
}

/**
 * 生成提交编排（估价/提交共用）：项目授权 → 就绪门禁 → 档位/项目配置 →
 * 定稿图补参考 → 控制参考解析 → 提示词编译 → 报价；submit=true 时同调用内
 * 自动确认并落生成任务。HTTP 路由（estimate/submit）与创作广场 BFF 共用，
 * 保证广场与主链同一套档位/参考/计费契约。
 */
export async function submitGenerationRequest(
  repository: PostgresGenerationRepository,
  projectAccess: GenerationProjectAccess,
  actor: AuthenticatedUser,
  source: Exclude<GenerationQuoteSource, "assistant">,
  input: GenerationSubmissionBody,
  options: {
    /** 就绪门禁；估价路由传 no-op 保持历史行为，提交路由传真门禁。 */
    requireSubmissionReady?: (mediaKind: "image" | "video" | "audio") => void;
    /** true = 报价后同调用内确认并创建生成任务（auto_confirm）。 */
    submit?: boolean;
  } = {},
): Promise<{ quote: GenerationQuoteView | null; view: GenerationView | null; tierId: string }> {
  const generationActor = await authorizeGenerationProject(projectAccess, actor, input.project_id, "create");
  const readinessGate = options.requireSubmissionReady
    ?? ((mediaKind: "image" | "video" | "audio") => requireGenerationSubmissionReady(undefined, mediaKind));
  readinessGate(input.media_kind);
  const projectConfig = await effectiveProjectGenerationConfig(repository, input);
  const tier = await requireEffectiveProjectTier(repository, input, projectConfig);
  const seedanceAssetUris = usesRegisteredSeedanceAssetUris(input.media_kind, tier.rule.model);
  const withFinalImage = await withShotFinalImageReference(repository, input, {
    useRegisteredSeedanceAssetUris: seedanceAssetUris,
  });
  const controls = await resolveControlReferences(repository, actor.id, withFinalImage, {
    useRegisteredSeedanceAssetUris: seedanceAssetUris,
    enforceReferenceImageDimensions: usesSeedanceReferenceImageDimensions(input.media_kind),
    authorizedProjectId: generationActor.authorizedProjectId,
  }, projectConfig.styleReferenceMediaIds);
  const resolvedPrompt = await resolveSubmissionPrompt(
    repository,
    withFinalImage,
    controls.mediaIds,
    projectConfig,
  );
  const service = createGenerationService(repository);
  const built = submissionInput(
    withFinalImage,
    tier.tierId,
    tier.rule.model,
    tier.parameters,
    controls.mediaIds,
    controls.snapshots,
    resolvedPrompt,
  );
  /* 两步契约（estimate→confirm→submit）：客户端已确认 generation_quote_id 时直接提交，
     不再新建报价——否则每次提交都多落一张 pending 报价（孤儿报价/配额污染）。
     R3 Lite 视频 submit 契约与 generation-quotes 闸都锁定此行为。 */
  if (input.generation_quote_id) {
    const view = options.submit
      ? await service.submit(generationActor, built, input.generation_quote_id, source, input.auto_confirm === true)
      : null;
    return { quote: null, view, tierId: tier.tierId };
  }
  const quote = await service.quoteSubmission(generationActor, built, source);
  if (!options.submit) return { quote, view: null, tierId: tier.tierId };
  const view = await service.submit(generationActor, built, quote.id, source, input.auto_confirm === true);
  return { quote, view, tierId: tier.tierId };
}

type ResolvedSubmissionPrompt = {
  prompt: string;
  promptCompilation?: GenerationPromptCompilation;
};

type EffectiveProjectGenerationConfig = ProjectGenerationConfig & {
  projectStyleApplied: boolean;
};

async function effectiveProjectGenerationConfig(
  repository: GenerationRouteRepository,
  input: GenerationSubmissionBody,
): Promise<EffectiveProjectGenerationConfig> {
  if (input.media_kind === "audio") {
    return {
      styleReferenceMediaIds: [],
      promptTemplateSource: "platform_default",
      projectStyleApplied: false,
    };
  }
  const config = await repository.resolveProjectGenerationConfig(
    input.project_id,
    input.media_kind,
  );
  if (!input.use_project_style) {
    return {
      ...(config.defaultRatio ? { defaultRatio: config.defaultRatio } : {}),
      ...(config.defaultImageResolution
        ? { defaultImageResolution: config.defaultImageResolution }
        : {}),
      ...(config.defaultVideoResolution
        ? { defaultVideoResolution: config.defaultVideoResolution }
        : {}),
      ...(config.promptTemplate ? { promptTemplate: config.promptTemplate } : {}),
      styleReferenceMediaIds: [],
      promptTemplateSource: config.promptTemplateSource,
      projectStyleApplied: false,
    };
  }
  return {
    ...config,
    projectStyleApplied: Boolean(
      config.styleDescription || config.styleReferenceMediaIds.length > 0,
    ),
  };
}

/**
 * 两段式提示词(合同第二节)的路由层决议:传统全人工 prompt 与人工补充段
 * supplement_prompt 互斥(同发 = 歧义 422);走补充段(或两段皆空)时服务端从
 * 结构化真源编译自动段,拼接 = 自动段 + 补充段;编译产物随报价持久化并在响应
 * 回带(只读展示)。必须在 resolveControlReferences 之后调用:参考清单以归一化
 * 后的 mediaIds 为准,且资产权限已校验。
 */
async function resolveSubmissionPrompt(
  repository: GenerationRouteRepository,
  input: GenerationSubmissionBody,
  referenceMediaIds: string[],
  projectConfig: EffectiveProjectGenerationConfig,
): Promise<ResolvedSubmissionPrompt> {
  if (input.media_kind === "audio") {
    const supplement = [input.prompt, input.supplement_prompt].filter(Boolean).join("\n");
    const compiled = compileAudioPrompt(input.audio_prompt_dimensions ?? {}, supplement);
    if (!compiled.prompt) {
      throw new GenerationError(
        "INVALID_GENERATION_REQUEST",
        "音频台词为空:请填写要合成的台词；声音维度不会作为台词朗读",
        422,
      );
    }
    return {
      prompt: compiled.prompt,
      promptCompilation: {
        version: compiled.version,
        autoPrompt: compiled.prompt,
        supplementPrompt: supplement,
        audioDimensions: compiled.dimensions,
      },
    };
  }
  if (input.prompt !== undefined && input.supplement_prompt !== undefined) {
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      "prompt 和 supplement_prompt 只能二选一:需要人工补充时请只发 supplement_prompt,自动段由服务端编译",
      422,
    );
  }
  if (input.prompt !== undefined) {
    /* 显式 prompt 同样携带项目风格(#170):界面批量/单发始终带分镜提示词提交,
       若只在自动编排段拼风格,项目风格描述永远进不了生成任务。
       use_project_style=false 时 styleDescription 已被 effectiveProjectGenerationConfig
       剥掉,这里天然尊重该开关;prompt 已含风格原文时不重复追加。 */
    const styleDescription = projectConfig.styleDescription?.trim();
    const styleSegment = styleDescription && !input.prompt.includes(styleDescription)
      ? `风格:${styleDescription}`
      : undefined;
    if (input.media_kind === "video" && input.scene_id) {
      const supplementPrompt = stripPromptTimecodes(input.prompt);
      if (!supplementPrompt) {
        throw new GenerationError(
          "INVALID_GENERATION_REQUEST",
          "提示词去除时间码后为空，请填写镜头内容后重试",
          422,
        );
      }
      return {
        prompt: joinPromptSegments(
          joinPromptSegments(SEGMENT_NO_BGM_CONSTRAINT, supplementPrompt),
          styleSegment,
        ),
        promptCompilation: {
          version: SEGMENT_PROMPT_DEFAULTS_VERSION,
          autoPrompt: SEGMENT_NO_BGM_CONSTRAINT,
          supplementPrompt,
        },
      };
    }
    return styleSegment
      ? { prompt: joinPromptSegments(input.prompt, styleSegment) }
      : { prompt: input.prompt };
  }
  const context = await repository.resolvePromptCompilationContext({
    projectId: input.project_id,
    ...(input.episode_id ? { episodeId: input.episode_id } : {}),
    ...(input.scene_id ? { sceneId: input.scene_id } : {}),
    ...(input.shot_id ? { shotId: input.shot_id } : {}),
    referenceMediaIds,
    ...(projectConfig.styleDescription
      ? { styleDescription: projectConfig.styleDescription }
      : {}),
    ...(projectConfig.promptTemplate
      ? { promptTemplate: projectConfig.promptTemplate }
      : {}),
    mediaKind: input.media_kind,
  });
  const compiled = compileAutoPrompt(context);
  const segmentDefaultsApply = input.media_kind === "video" && Boolean(input.scene_id);
  const autoPrompt = segmentDefaultsApply
    ? joinPromptSegments(compiled.autoPrompt, SEGMENT_NO_BGM_CONSTRAINT)
    : compiled.autoPrompt;
  const requestSupplementPrompt = segmentDefaultsApply
    ? stripPromptTimecodes(input.supplement_prompt ?? "")
    : input.supplement_prompt;
  const lockedPrompt = compiled.lockedPrompt !== undefined && segmentDefaultsApply
    ? stripPromptTimecodes(compiled.lockedPrompt)
    : compiled.lockedPrompt;
  const supplementPrompt = lockedPrompt !== undefined
    ? requestSupplementPrompt?.includes(lockedPrompt)
      ? requestSupplementPrompt
      : joinPromptSegments(lockedPrompt, requestSupplementPrompt ?? "")
    : requestSupplementPrompt;
  const substantivePrompt = joinPromptSegments(compiled.autoPrompt, supplementPrompt);
  const prompt = joinPromptSegments(autoPrompt, supplementPrompt);
  if (!substantivePrompt) {
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      "提示词为空:请填写 prompt 或 supplement_prompt,或完善剧集/场次/分镜信息后重试",
      422,
    );
  }
  return {
    prompt,
    promptCompilation: {
      version: segmentDefaultsApply
        ? `${compiled.version}+${SEGMENT_PROMPT_DEFAULTS_VERSION}`
        : compiled.version,
      autoPrompt,
      supplementPrompt: supplementPrompt ?? "",
      projectStyleApplied: compiled.lockedPrompt === undefined
        ? projectConfig.projectStyleApplied
        : projectConfig.styleReferenceMediaIds.length > 0,
      projectStyleReferenceMediaIds: projectConfig.styleReferenceMediaIds,
      ...(compiled.lockedPrompt === undefined
        ? { promptTemplateSource: projectConfig.promptTemplateSource }
        : {}),
    },
  };
}

async function resolveControlReferences(
  repository: ReturnType<typeof createGenerationRepository>,
  actorId: string,
  input: Pick<GenerationSubmissionBody, "media_kind" | "shot_id" | "reference_media_ids" | "first_frame_media_id" | "last_frame_media_id" | "references" | "shotFinalReference">,
  options: {
    useRegisteredSeedanceAssetUris: boolean;
    enforceReferenceImageDimensions: boolean;
    authorizedProjectId?: string;
  },
  additionalReferenceMediaIds: string[] = [],
): Promise<{
  mediaIds: string[];
  snapshots: NonNullable<SubmitGenerationInput["referenceAssetSnapshots"]>;
}> {
  const controls = normalizeControlReferences(input);
  // v1.3 T10.14:服务端按 shot 参考快照 (asset_entity_id, variant_id) 取各变体主图并入参考清单。
  // 只取各变体主图(asset_media.is_primary),无主图变体跳过;不替代用户显式参考。
  let shotVariantMediaIds: string[] = [];
  if (input.shot_id) {
    try {
      shotVariantMediaIds = await repository.resolveShotAssetVariantReferences({ shotId: input.shot_id });
    } catch (error) {
      throw normalizeControlReferenceError(error);
    }
  }
  const referenceMediaIds = [...new Set([
    ...controls.referenceMediaIds,
    ...shotVariantMediaIds,
    ...additionalReferenceMediaIds,
  ])];
  if (referenceMediaIds.length > 20) {
    throw controlAssetUsageError("参考素材与项目风格参考图合计最多 20 个");
  }
  ensureUniqueControlMedia(
    referenceMediaIds,
    controls.firstFrameMediaId,
    controls.lastFrameMediaId,
  );
  let snapshots: NonNullable<SubmitGenerationInput["referenceAssetSnapshots"]>;
  try {
    snapshots = await repository.resolveControlReferenceSnapshots(actorId, input.media_kind, {
      referenceMediaIds,
      ...(controls.firstFrameMediaId ? { firstFrameMediaId: controls.firstFrameMediaId } : {}),
      ...(controls.lastFrameMediaId ? { lastFrameMediaId: controls.lastFrameMediaId } : {}),
    }, options);
  } catch (error) {
    throw normalizeControlReferenceError(error);
  }
  return {
    mediaIds: [
      ...referenceMediaIds,
      ...(controls.firstFrameMediaId ? [controls.firstFrameMediaId] : []),
      ...(controls.lastFrameMediaId ? [controls.lastFrameMediaId] : []),
    ],
    snapshots: [
      ...(input.shotFinalReference ? [input.shotFinalReference] : []),
      ...snapshots,
    ],
  };
}

/**
 * #164 拿定稿生视频(PRD 生产章 §10.1「下游一律默认用定稿」):视频生成且指定
 * 镜头、调用方未显式给首/尾帧(锚帧与参考集互斥,合同既定)时,把该镜定稿图
 * 的已登记资产媒体补到参考清单最前(顺序=提示词里的引用顺序)。
 *
 * 定稿图没登记为资产时，Ark 仍接受受控 HTTPS 原件作为全能参考；没有这条
 * 可复核直链资格就明确阻止并引导登记，绝不确认后丢图改走纯文字。
 * 实测对照(outputs/e2e-wolf-ep1-20260808/)同一分镜同一提示词,只差有没有入库——
 * 不入库,一广场全是狼、三个主角一个没有;入库了人物全对上。也就是说入库是
 * 人物一致性的唯一开关,静默降级等于闷着头产废片,用户不知道自己在放弃什么。
 *
 * 闸门放在这个函数里而不是三处调用点:补参考的判断条件(视频 / 有镜头 /
 * 无显式锚帧 / 该档吃不吃素材登记)与该不该挡是**同一组条件**,拆开写就是把
 * 同一个判断抄三遍,以后任一处漏改就出现「这个入口挡、那个入口不挡」的裂口。
 * 代价是这个函数不再纯粹补参考,所以名字之外由这段注释交代它也会拒绝。
 */
export async function withShotFinalImageReference(
  repository: Pick<GenerationRouteRepository, "resolveShotFinalReference">,
  input: GenerationSubmissionBody,
  options: {
    useRegisteredSeedanceAssetUris: boolean;
  },
): Promise<GenerationSubmissionBody> {
  if (input.media_kind !== "video" || !input.shot_id) return input;
  if (input.first_frame_media_id || input.last_frame_media_id) return input;
  if (input.references?.some((reference) => reference.usage_mode === "first_frame" || reference.usage_mode === "last_frame")) {
    return input;
  }
  const resolution = await repository.resolveShotFinalReference({
    projectId: input.project_id,
    shotId: input.shot_id,
    useRegisteredSeedanceAssetUris: options.useRegisteredSeedanceAssetUris,
  });
  if (resolution.status === "absent") return input;
  if (resolution.status === "unregistered") {
    throw new GenerationError(
      "shot_final_image_reference_unavailable",
      "本镜定稿图还不能作为视频参考。请先将它转为参考资产后再生成，系统不会忽略定稿图改按纯文字生成。",
      422,
    );
  }
  const mediaId = resolution.mediaId;
  if (input.references !== undefined) {
    if (input.references.some((reference) => reference.media_id === mediaId)) return input;
    return { ...input, references: [{ media_id: mediaId, usage_mode: "reference" }, ...input.references] };
  }
  const existing = input.reference_media_ids ?? [];
  if (existing.includes(mediaId)) return input;
  return { ...input, reference_media_ids: [mediaId, ...existing] };
}

/**
 * Ark's `asset://` is a Seedance all-reference library URI, not a general
 * storage URL. Keep it out of image generation, anchor frames, legacy
 * adapters, and every future model until its contract explicitly opts in.
 */
function usesRegisteredSeedanceAssetUris(
  mediaKind: GenerationSubmissionBody["media_kind"],
  model: string,
): boolean {
  return mediaKind === "video" && isArkSeedance2Model(model);
}

/** The current reference-image dimensions are a video-provider capability, never an audio gate. */
function usesSeedanceReferenceImageDimensions(
  mediaKind: GenerationSubmissionBody["media_kind"],
): boolean {
  return mediaKind === "video";
}

type ReferenceUsageMode = "reference" | "first_frame" | "last_frame";

type NormalizedControlReferences = {
  referenceMediaIds: string[];
  firstFrameMediaId?: string;
  lastFrameMediaId?: string;
};

/**
 * Converts either public request shape to the repository's established slot
 * representation. A request must choose exactly one shape so a client cannot
 * silently submit contradictory control instructions.
 */
export function normalizeControlReferences(
  input: Pick<GenerationSubmissionBody, "reference_media_ids" | "first_frame_media_id" | "last_frame_media_id" | "references">,
): NormalizedControlReferences {
  const hasNewShape = input.references !== undefined;
  const hasLegacyShape = input.reference_media_ids !== undefined
    || input.first_frame_media_id !== undefined
    || input.last_frame_media_id !== undefined;
  if (hasNewShape && hasLegacyShape) {
    throw controlAssetUsageError("参考素材请只使用 references 或旧版字段，不能同时提交两种格式");
  }

  if (!hasNewShape) {
    const referenceMediaIds = input.reference_media_ids ?? [];
    ensureUniqueControlMedia(referenceMediaIds, input.first_frame_media_id, input.last_frame_media_id);
    return {
      referenceMediaIds,
      ...(input.first_frame_media_id ? { firstFrameMediaId: input.first_frame_media_id } : {}),
      ...(input.last_frame_media_id ? { lastFrameMediaId: input.last_frame_media_id } : {}),
    };
  }

  const referenceMediaIds: string[] = [];
  let firstFrameMediaId: string | undefined;
  let lastFrameMediaId: string | undefined;
  for (const reference of input.references ?? []) {
    const usageMode = reference.usage_mode as ReferenceUsageMode;
    if (usageMode !== "reference" && usageMode !== "first_frame" && usageMode !== "last_frame") {
      throw controlAssetUsageError("参考素材类型不正确，请选择参考、首帧或尾帧");
    }
    if (usageMode === "reference") {
      referenceMediaIds.push(reference.media_id);
    } else if (usageMode === "first_frame") {
      if (firstFrameMediaId) throw controlAssetUsageError("首帧只能选择一张图片");
      firstFrameMediaId = reference.media_id;
    } else {
      if (lastFrameMediaId) throw controlAssetUsageError("尾帧只能选择一张图片");
      lastFrameMediaId = reference.media_id;
    }
  }
  if (referenceMediaIds.length > 20) {
    throw controlAssetUsageError("参考集最多可放 20 个素材");
  }
  ensureUniqueControlMedia(referenceMediaIds, firstFrameMediaId, lastFrameMediaId);
  return {
    referenceMediaIds,
    ...(firstFrameMediaId ? { firstFrameMediaId } : {}),
    ...(lastFrameMediaId ? { lastFrameMediaId } : {}),
  };
}

function ensureUniqueControlMedia(
  referenceMediaIds: string[],
  firstFrameMediaId?: string,
  lastFrameMediaId?: string,
): void {
  const mediaIds = [...referenceMediaIds, firstFrameMediaId, lastFrameMediaId]
    .filter((mediaId): mediaId is string => Boolean(mediaId));
  if (new Set(mediaIds).size !== mediaIds.length) {
    throw controlAssetUsageError("同一素材不能同时作为参考、首帧或尾帧");
  }
}

function controlAssetUsageError(message: string): GenerationError {
  return new GenerationError("control_asset_invalid_usage", message, 422);
}

/**
 * Repository-level control-slot validation predates the public control-asset
 * API. Keep its internal code compatible while exposing one stable code to
 * clients for the 422 invalid-usage family.
 */
export function normalizeControlReferenceError(error: unknown): unknown {
  if (error instanceof GenerationError
    && error.code === "INVALID_GENERATION_REQUEST"
    && error.statusCode === 422) {
    return controlAssetUsageError(error.message);
  }
  return error;
}

export type GenerationSubmissionBody = {
  media_kind: "image" | "video" | "audio";
  tier_id: string;
  project_id: string;
  episode_id?: string | null;
  scene_id?: string | null;
  shot_id?: string | null;
  target_asset_entity_id?: string | null;
  /** v1.9 十.9：发起生成的变体，产物按变体归属。 */
  target_asset_variant_id?: string | null;
  prompt?: string;
  supplement_prompt?: string;
  audio_prompt_dimensions?: AudioPromptDimensions;
  use_project_style: boolean;
  reference_media_ids?: string[];
  first_frame_media_id?: string;
  last_frame_media_id?: string;
  references?: Array<{ media_id: string; usage_mode: string }>;
  /** 仅由 withShotFinalImageReference 写入，Zod 对外输入不会接受它。 */
  shotFinalReference?: GenerationReferenceSnapshot;
  parameters: Record<string, unknown>;
  quantity: number;
  client_idempotency_key: string;
  /** v1.9 十.7：Lite/广场自动确认（提交事务内确认 pending 报价）；完整版不带此键。 */
  /** 两步契约（estimate→confirm→submit）：客户端已确认的报价 id；未带则用编排内新建报价。 */
  generation_quote_id?: string;
  auto_confirm?: boolean;
};

function rejectBatchOnlyProductionMode(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.prototype.hasOwnProperty.call(value, "production_mode")) return;
  throw new GenerationError(
    "sample_mode_batch_only",
    "生产模式只能在批量估价和批量提交中选择；单项生成请使用默认成片模式",
    422,
  );
}

/**
 * The source is projected from the server-issued bearer credential. Headers
 * and request bodies are untrusted compatibility inputs and never change it.
 */
export function generationSource(request: FastifyRequest): Exclude<GenerationQuoteSource, "assistant"> {
  return requireCurrentContext(request).credential.source;
}

export function precheckData(result: PrecheckResult): Record<string, unknown> {
  return {
    overall_score: result.overallScore,
    dimensions: result.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      score: d.score,
      weight: d.weight,
      status: d.status,
      detail: d.detail,
      ...(d.suggestion ? { suggestion: d.suggestion } : {}),
    })),
    auto_prompt_preview: result.autoPromptPreview,
    missing_references: result.missingReferences,
    recommendations: result.recommendations,
    estimated_sampling_effect: {
      warning: result.estimatedSamplingEffect.warning,
      ...(result.estimatedSamplingEffect.message
        ? { message: result.estimatedSamplingEffect.message }
        : {}),
    },
    precheck_id: result.precheckId,
    created_at: result.createdAt,
  };
}

export function quoteData(
  quote: GenerationQuoteView,
  reviewThresholdFen: number = settings.paidGenerationReviewThresholdFen,
): Record<string, unknown> {
  const referenceSnapshots = readReferenceSnapshots(quote.normalizedRequest.referenceAssetSnapshots);
  const promptCompilation = readPromptCompilation(quote.normalizedRequest.promptCompilation);
  return {
    generation_quote_id: quote.id,
    source: quote.source,
    action: quote.action,
    assistant_session_id: quote.assistantSessionId ?? null,
    original_request_id: quote.originalRequestId ?? null,
    base_attempt_id: quote.baseAttemptId ?? null,
    base_attempt_no: quote.baseAttemptNo ?? null,
    status: quote.status,
    tier_id: quote.priceSnapshot.tierId,
    price_snapshot: quotePriceSnapshotData(quote.priceSnapshot),
    estimated_cost_fen: quote.estimatedCostFen,
    requires_manual_review: requiresManualReview(quote.estimatedCostFen, reviewThresholdFen),
    currency: quote.priceSnapshot.currency,
    reference_mode: deriveReferenceMode(referenceSnapshots),
    reference_manifest: referenceManifestData(referenceSnapshots),
    // 合同第二节:响应回带编译后的自动段全文(只读展示)+模板版本;传统全
    // 人工 prompt 模式与历史报价无编译记录,回带 null。
    compiled_prompt: promptCompilation?.autoPrompt ?? null,
    prompt_template_version: promptCompilation?.version ?? null,
    project_style_applied: promptCompilation?.projectStyleApplied ?? false,
    project_style_reference_media_ids:
      promptCompilation?.projectStyleReferenceMediaIds ?? [],
    prompt_template_source: promptCompilation?.promptTemplateSource ?? null,
    expires_at: quote.expiresAt,
    confirmed_at: quote.confirmedAt ?? null,
    consumed_at: quote.consumedAt ?? null,
    generation_request_id: quote.generationRequestId ?? null,
    generation_attempt_id: quote.generationAttemptId ?? null,
    notice: "预估消耗，非云平台实际账单",
  };
}

function quotePriceSnapshotData(snapshot: GenerationQuoteView["priceSnapshot"]): Record<string, unknown> {
  const pricingBasis = snapshot.pricingBasis;
  return {
    tier_id: snapshot.tierId,
    media_kind: snapshot.mediaKind,
    billing_unit: snapshot.billingUnit,
    unit_price_fen: snapshot.unitPriceFen,
    billable_units: snapshot.billableUnits,
    estimated_cost_fen: snapshot.estimatedCostFen,
    full_estimated_cost_fen: snapshot.fullEstimatedCostFen ?? snapshot.estimatedCostFen,
    production_mode: snapshot.productionMode ?? "full",
    price_multiplier_bps: snapshot.priceMultiplierBps ?? 10_000,
    discount_numerator: snapshot.discountNumerator ?? 1,
    discount_denominator: snapshot.discountDenominator ?? 1,
    currency: snapshot.currency,
    ...(pricingBasis ? {
      pricing_basis: {
        contract_version: pricingBasis.contractVersion,
        method: pricingBasis.method,
        fixed_parameters: pricingBasis.fixedParameters,
        ...(pricingBasis.noInputVideo ? { no_input_video: true } : {}),
        ...(pricingBasis.inputVideoReferenceCount !== undefined
          ? { input_video_reference_count: pricingBasis.inputVideoReferenceCount }
          : {}),
        ...(pricingBasis.estimatedTokens !== undefined
          ? { estimated_tokens: pricingBasis.estimatedTokens }
          : {}),
        ...(pricingBasis.providerYuanPerMillionTokens !== undefined
          ? { provider_yuan_per_million_tokens: pricingBasis.providerYuanPerMillionTokens }
          : {}),
      },
    } : {}),
  };
}

/** 报价快照里的编译记录防御性读取(历史报价无此字段时返回 undefined)。 */
function readPromptCompilation(value: unknown): GenerationPromptCompilation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || typeof record.autoPrompt !== "string") return undefined;
  const audioDimensions = readAudioPromptDimensions(record.audioDimensions);
  return {
    version: record.version,
    autoPrompt: record.autoPrompt,
    supplementPrompt: typeof record.supplementPrompt === "string" ? record.supplementPrompt : "",
    ...(typeof record.projectStyleApplied === "boolean"
      ? { projectStyleApplied: record.projectStyleApplied }
      : {}),
    ...(Array.isArray(record.projectStyleReferenceMediaIds)
      ? {
          projectStyleReferenceMediaIds: record.projectStyleReferenceMediaIds
            .filter((value): value is string => typeof value === "string"),
        }
      : {}),
    ...(record.promptTemplateSource === "platform_default" || record.promptTemplateSource === "project"
      ? { promptTemplateSource: record.promptTemplateSource }
      : {}),
    ...(audioDimensions ? { audioDimensions } : {}),
  };
}

function readAudioPromptDimensions(value: unknown): Required<AudioPromptDimensions> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    voiceReference: typeof record.voiceReference === "string" ? record.voiceReference : "",
    performanceEmotion: typeof record.performanceEmotion === "string" ? record.performanceEmotion : "",
    paceAndPauses: typeof record.paceAndPauses === "string" ? record.paceAndPauses : "",
    languageAndAccent: typeof record.languageAndAccent === "string" ? record.languageAndAccent : "",
    vocalDistance: typeof record.vocalDistance === "string" ? record.vocalDistance : "",
    continuity: typeof record.continuity === "string" ? record.continuity : "",
  };
}

/** Wire shape of the S17 transparency manifest (explicit snake_case keys). */
function referenceManifestData(
  snapshots: GenerationReferenceSnapshot[],
): Array<Record<string, unknown>> {
  return referenceManifest(snapshots).map((item) => ({
    media_id: item.mediaId,
    kind: item.kind,
    role: item.role,
  }));
}

/**
 * The review boundary is intentionally strict: a task at the configured
 * threshold remains in the ordinary human-click flow; only a larger single
 * task carries the additional review signal. This does not change submit,
 * budget, or quote-confirmation semantics.
 */
export function requiresManualReview(
  estimatedCostFen: number,
  reviewThresholdFen: number = settings.paidGenerationReviewThresholdFen,
): boolean {
  return estimatedCostFen > reviewThresholdFen;
}

export function generationParameters(input: Record<string, unknown>): GenerationParameters {
  const parameters: GenerationParameters = {};
  if (typeof input.size === "string") parameters.size = input.size;
  if (typeof input.ratio === "string") parameters.ratio = input.ratio;
  if (typeof input.resolution === "string") parameters.resolution = input.resolution;
  if (typeof input.duration_seconds === "number") parameters.durationSeconds = input.duration_seconds;
  if (typeof input.seed === "number") parameters.seed = input.seed;
  if (typeof input.watermark === "boolean") parameters.watermark = input.watermark;
  if (typeof input.generate_audio === "boolean") parameters.generateAudio = input.generate_audio;
  if (typeof input.original_duration_seconds === "number") {
    parameters.originalDurationSeconds = input.original_duration_seconds;
  }
  if (input.format === "mp3" || input.format === "wav" || input.format === "pcm") {
    parameters.format = input.format;
  }
  if (typeof input.sample_rate === "number") parameters.sampleRate = input.sample_rate;
  if (typeof input.speech_rate === "number") parameters.speechRate = input.speech_rate;
  if (typeof input.loudness_rate === "number") parameters.loudnessRate = input.loudness_rate;
  if (typeof input.pitch_rate === "number") parameters.pitchRate = input.pitch_rate;
  if (typeof input.speaker_id === "string") parameters.speakerId = input.speaker_id;
  if (typeof input.enable_subtitle === "boolean") parameters.enableSubtitle = input.enable_subtitle;
  if (input.sequential_image_generation === "auto" || input.sequential_image_generation === "disabled") {
    parameters.sequentialImageGeneration = input.sequential_image_generation;
  }
  return parameters;
}

export function generationData(view: GenerationView): Record<string, unknown> {
  const referenceSnapshots = view.referenceAssetSnapshots ?? [];
  return {
    generation_request_id: view.requestId,
    current_attempt_id: view.attemptId,
    project_id: view.projectId,
    episode_id: view.episodeId ?? null,
    shot_id: view.shotId ?? null,
    /* #164 G10:列表/详情下发 media_kind——镜头图片面板要按图片态过滤在途/失败任务
       (media_results 只覆盖成功产物,失败与在途无产物行)。 */
    media_kind: view.mediaKind,
    status: view.status,
    phase: view.phase,
    attempt_no: view.attemptNo ?? 1,
    tier_id: view.tierId ?? null,
    prompt: view.prompt,
    parameters: view.parameters,
    display_reason: generationFailureDisplayReason(view.errorMessage, view.mediaKind),
    error_code: view.errorCode ?? null,
    estimated_cost_fen: view.estimatedCostFen,
    // S29: queue_position is only the local worker's claim order. It never
    // claims to know a provider-side queue, and duration stays null until the
    // repository has a sufficient real historical sample.
    queue_position: view.queuePosition ?? null,
    estimated_duration_seconds: view.estimatedDurationSeconds ?? null,
    estimated_duration_sample_count: view.estimatedDurationSampleCount ?? 0,
    actual_cost_status: "unavailable",
    reference_mode: deriveReferenceMode(referenceSnapshots),
    reference_manifest: referenceManifestData(referenceSnapshots),
    media_results: view.media.map((media) => ({
      id: media.id ?? null,
      media_kind: media.mediaKind,
      storage_bucket: media.storageBucket,
      storage_path: media.storagePath,
      storage_url: media.storageUrl,
      sha256: media.sha256,
      mime_type: media.mimeType,
      created_at: media.createdAt ?? view.updatedAt,
    })),
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
}

export function inFlightGenerationData(view: GenerationInFlightView): Record<string, unknown> {
  return {
    generation_request_id: view.requestId,
    current_attempt_id: view.attemptId,
    project_id: view.projectId,
    episode_id: view.episodeId ?? null,
    shot_id: view.shotId ?? null,
    target_asset_entity_id: view.targetAssetEntityId ?? null,
    media_kind: view.mediaKind,
    status: view.status,
    attempt_no: view.attemptNo,
    tier_id: view.tierId ?? null,
    queue_position: view.queuePosition,
    estimated_duration_seconds: view.estimatedDurationSeconds,
    estimated_duration_sample_count: view.estimatedDurationSampleCount,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
}

export function failedGenerationData(view: GenerationFailedView): Record<string, unknown> {
  return {
    generation_request_id: view.requestId,
    current_attempt_id: view.attemptId,
    project_id: view.projectId,
    episode_id: view.episodeId ?? null,
    scene_id: view.sceneId ?? null,
    shot_id: view.shotId ?? null,
    target_asset_entity_id: view.targetAssetEntityId ?? null,
    media_kind: view.mediaKind,
    status: view.status,
    phase: view.phase,
    attempt_no: view.attemptNo,
    tier_id: view.tierId ?? null,
    retryable: view.retryable,
    error_code: view.errorCode ?? null,
    display_reason: generationFailureDisplayReason(view.errorMessage, view.mediaKind),
    created_at: view.createdAt,
    finished_at: view.finishedAt,
    updated_at: view.updatedAt,
  };
}

export function generationAttemptNotificationData(
  notification: GenerationAttemptNotificationView,
): Record<string, unknown> {
  return {
    id: notification.id,
    generation_request_id: notification.requestId,
    attempt_id: notification.attemptId,
    project_id: notification.projectId,
    episode_id: notification.episodeId ?? null,
    shot_id: notification.shotId ?? null,
    target_asset_entity_id: notification.targetAssetEntityId ?? null,
    media_kind: notification.mediaKind,
    status: notification.status,
    display_reason: generationFailureDisplayReason(notification.errorMessage, notification.mediaKind),
    created_at: notification.createdAt,
  };
}

export function generationFailureDisplayReason(
  rawMessage: string | null | undefined,
  mediaKind: "image" | "video" | "audio" | string,
): string | null {
  if (!rawMessage) return null;
  const subject = mediaKind === "video" ? "视频" : mediaKind === "audio" ? "声音" : "图片";
  return publicStoredMessage(rawMessage, `${subject}生成没成：生成服务暂时没响应，请稍后重试。`);
}

type TierSelectionInput = {
  media_kind: "image" | "video" | "audio";
  tier_id: string;
  parameters: Record<string, unknown>;
  quantity: number;
};

async function requireActiveTier(
  repository: ReturnType<typeof createGenerationRepository>,
  input: TierSelectionInput,
) {
  return repository.resolveActiveTier({
    tierId: input.tier_id,
    mediaKind: input.media_kind,
    parameters: generationParameters(input.parameters),
    quantity: input.quantity,
  });
}

async function requireEffectiveProjectTier(
  repository: ReturnType<typeof createGenerationRepository>,
  input: TierSelectionInput,
  projectConfig: EffectiveProjectGenerationConfig,
) {
  if (input.media_kind === "audio" || typeof repository.listActiveTiers !== "function") {
    return requireActiveTier(repository, input);
  }

  const tiers = await repository.listActiveTiers(input.media_kind);
  const selectedTier = tiers.find((tier) => tier.tierId === input.tier_id);
  if (!selectedTier) {
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      "当前生成模型或参数选项不可用，请重新选择",
      422,
    );
  }

  const requested = generationParameters(input.parameters);
  const base = { ...selectedTier.parameters };
  let effectiveInput: GenerationParameters;
  if (input.media_kind === "image") {
    delete base.size;
    delete base.resolution;
    delete base.ratio;
    effectiveInput = {
      ...base,
      size: requested.size
        ?? requested.resolution
        ?? projectConfig.defaultImageResolution
        ?? selectedTier.parameters.size,
      ratio: requested.ratio
        ?? projectConfig.defaultRatio
        ?? selectedTier.parameters.ratio,
      ...withoutVisualSelection(requested),
    };
  } else {
    delete base.resolution;
    delete base.ratio;
    effectiveInput = {
      ...base,
      resolution: requested.resolution
        ?? projectConfig.defaultVideoResolution
        ?? selectedTier.parameters.resolution,
      ratio: requested.ratio
        ?? projectConfig.defaultRatio
        ?? selectedTier.parameters.ratio,
      ...withoutVisualSelection(requested),
    };
  }

  let normalized: GenerationParameters;
  try {
    normalized = normalizeV01Parameters({
      mediaKind: input.media_kind,
      model: selectedTier.rule.model,
      parameters: effectiveInput,
      quantity: input.quantity,
    });
  } catch (error) {
    if (error instanceof V01GenerationContractError) {
      throw new GenerationError("INVALID_GENERATION_REQUEST", error.message, 422);
    }
    throw error;
  }

  const matchedTier = tiers.find((tier) => (
    tier.rule.model === selectedTier.rule.model
    && tier.quantity === input.quantity
    && sameGenerationParameters(tier.parameters, normalized)
  ));
  if (!matchedTier) {
    // 预览档(快乐马)接受参数覆盖(2026-08-19 裁定):分辨率/画幅/时长可调,
    // 归一化已按快乐马能力表校验;normalized 携带 preview 身份键直达报价与提交。
    if (input.media_kind === "video" && selectedTier.parameters.preview === true) {
      return { ...selectedTier, parameters: normalized };
    }
    throw new GenerationError(
      "INVALID_GENERATION_REQUEST",
      "当前模型不支持这组画幅与清晰度，请更换参数选项",
      422,
    );
  }
  return matchedTier;
}

function withoutVisualSelection(parameters: GenerationParameters): GenerationParameters {
  const rest = { ...parameters };
  delete rest.size;
  delete rest.resolution;
  delete rest.ratio;
  return rest;
}

function sameGenerationParameters(
  left: GenerationParameters,
  right: GenerationParameters,
): boolean {
  const entries = (value: GenerationParameters) => Object.entries(value)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function accepted(reply: FastifyReply, data: unknown) {
  return reply.code(202).send(success(data));
}

type BatchEstimateAvailability = "available" | "invalid" | "unavailable";

export interface BatchEstimateItem {
  itemId: string;
  availability: BatchEstimateAvailability;
  tierId?: string;
  parameterSummary?: GenerationParameters;
  quote?: Record<string, unknown>;
  error?: ReturnType<typeof errorBody> & { status_code: number };
}

export interface BatchEstimateResponse {
  production_mode: "full" | "sample";
  price_multiplier_bps: 6_000 | 10_000;
  items: BatchEstimateItem[];
  count: number;
  available_count: number;
  unavailable_count: number;
  total_estimated_cost_fen: number;
  currency: "CNY";
  requires_manual_review: boolean;
  creates_generation_tasks: false;
  notice: string;
}

export function batchEstimateData(
  items: BatchEstimateItem[],
  productionMode: "full" | "sample" = "full",
  reviewThresholdFen: number = settings.paidGenerationReviewThresholdFen,
): BatchEstimateResponse {
  const availableItems = items.filter((item) => item.availability === "available");
  const totalEstimatedCostFen = availableItems.reduce((total, item) => (
    total + Number(item.quote?.estimated_cost_fen ?? 0)
  ), 0);
  const itemRequiresManualReview = availableItems.some((item) => (
    item.quote?.requires_manual_review === true
  ));
  return {
    production_mode: productionMode,
    price_multiplier_bps: productionMode === "sample" ? 6_000 : 10_000,
    items,
    count: items.length,
    available_count: availableItems.length,
    unavailable_count: items.length - availableItems.length,
    total_estimated_cost_fen: totalEstimatedCostFen,
    currency: "CNY",
    requires_manual_review: itemRequiresManualReview
      || requiresManualReview(totalEstimatedCostFen, reviewThresholdFen),
    // A quote is preparation, not a paid request. The client must never infer
    // from this endpoint that a provider call or task creation has happened.
    creates_generation_tasks: false,
    notice: "已逐项估价；尚未创建生成任务，也不会产生付费调用",
  };
}

export function batchSubmissionData(view: GenerationBatchSubmissionView): Record<string, unknown> {
  const items = view.items.map((item) => ({
    item_id: item.itemId,
    generation_quote_id: item.quoteId,
    estimated_cost_fen: item.estimatedCostFen,
    status: item.status,
    ...(item.generationRequestId ? { generation_request_id: item.generationRequestId } : {}),
    ...(item.generationAttemptId ? { generation_attempt_id: item.generationAttemptId } : {}),
    ...(item.queuePosition !== undefined ? { queue_position: item.queuePosition } : {}),
    ...(item.estimatedDurationSeconds !== undefined
      ? { estimated_duration_seconds: item.estimatedDurationSeconds }
      : {}),
    ...(item.error ? {
      error: {
        code: item.error.code,
        message: item.error.message,
        retryable: item.error.retryable,
        status_code: item.error.statusCode,
        details: item.error.details,
      },
    } : {}),
  }));
  const notice = view.status === "confirmed"
    ? "整份清单费用已确认，尚未创建生成任务；请单独提交这份授权"
    : view.status === "completed"
    ? "整份已确认清单已入队，任务进度会沿用现有队列与站内提醒"
    : view.status === "partial"
      ? "清单已部分入队；未创建的项目保留原因，请重新估价后再次确认"
      : "这份清单没有创建任务；请按每项原因处理后重新估价";
  return {
    authorization_id: view.authorizationId,
    user_id: view.userId,
    project_id: view.projectId,
    client_idempotency_key: view.clientIdempotencyKey,
    list_hash: view.listHash,
    production_mode: view.productionMode,
    price_multiplier_bps: view.productionMode === "sample" ? 6_000 : 10_000,
    status: view.status,
    authorized_total_estimated_cost_fen: view.authorizedTotalEstimatedCostFen,
    submitted_total_estimated_cost_fen: view.submittedTotalEstimatedCostFen,
    currency: view.currency,
    created_count: view.createdCount,
    failed_count: view.failedCount,
    authorized_at: view.authorizedAt,
    idempotent_replay: view.idempotentReplay,
    creates_generation_tasks: view.status !== "confirmed",
    items,
    notice,
  };
}

function batchItemAvailable(itemId: string, quote: GenerationQuoteView): BatchEstimateItem {
  return {
    itemId,
    availability: "available",
    tierId: quote.priceSnapshot.tierId,
    parameterSummary: quote.normalizedRequest.parameters as GenerationParameters,
    quote: quoteData(quote),
  };
}

function batchItemError(
  itemId: string,
  availability: Exclude<BatchEstimateAvailability, "available">,
  error: unknown,
): BatchEstimateItem {
  const publicError = toHttpErrorResponse(error);
  return {
    itemId,
    availability,
    error: {
      ...publicError.body,
      status_code: publicError.statusCode,
    },
  };
}

function readBatchItemId(rawItem: unknown): string | undefined {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return undefined;
  const value = (rawItem as Record<string, unknown>).item_id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 128) : undefined;
}
