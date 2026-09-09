import type { FastifyInstance } from "fastify";
import { createAiGatewayService, type AiGatewayService } from "../ai/service.js";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { isScriptTextFile, ScriptTextExtractor } from "../../services/script-text-extractor.js";
import { BadRequestError, PayloadTooLargeError } from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { lockProjectAssetNamespace } from "../project-assets/repository.js";
import { createScriptBreakdownService } from "../script-breakdown/routes.js";
import { DrizzleLiteRepository } from "./repository.js";
import { LiteAssetService, LiteScriptService } from "./service.js";

const projectParamsSchema = z.object({
  project_id: z.string().uuid(),
});

const assetMediaParamsSchema = z.object({
  project_id: z.string().uuid(),
  asset_entity_id: z.string().uuid(),
});

const episodeIdQuerySchema = z.object({
  episode_id: z.string().uuid(),
});

const submitLiteScriptBodySchema = z.object({
  episode_id: z.string().uuid(),
  raw_text: z.string().trim().min(1).max(60_000),
  client_idempotency_key: z.string().trim().min(8).max(255),
  /** 一键生成本集默认采用:解析定稿后服务端直接确认(§2 P2);不传按 true。 */
  auto_confirm: z.boolean().optional(),
}).strict();

/** 资产 kind 枚举:五类可解析资产 + 三个纯上传参考通道。 */
const liteAssetKindSchema = z.enum([
  "character", "scene", "prop", "costume", "audio",
  "light_ref", "photo_ref", "video_ref",
]);

const listAssetsQuerySchema = z.object({
  kind: liteAssetKindSchema.optional(),
}).strict();

const createAssetBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  asset_kind: liteAssetKindSchema,
  intro: z.string().trim().max(500).optional(),
  note: z.string().trim().max(2000).optional(),
}).strict();

const patchAssetBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  intro: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
}).strict();

export interface LiteRouteDependencies {
  createService?: (db: Database) => LiteScriptService;
  createAssetService?: (db: Database) => LiteAssetService;
  /** 测试用:注入 fake AI 网关;生产默认 createAiGatewayService(db)(v1.6 匹配建议)。 */
  createGateway?: (db: Database) => Pick<AiGatewayService, "completeValidated">;
  /** 测试用:创建后在请求内同步执行完拆解计划。 */
  executeRunsInline?: boolean;
  /**
   * 2026-08-19 主变体自动登记:注入登记服务工厂后,Lite 设主图/主音频成功时
   * 后台自动登记火山素材(fire-and-forget,失败落登记行由前端重试)。未注入
   * (测试或完整版)保持纯人工登记。
   */
  createRegistrationService?: (db: Database) => {
    registerAssetMedia(
      actor: ProjectAccessActor,
      assetId: string,
      mediaId: string,
    ): Promise<unknown>;
  };
}

export async function registerLiteRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: LiteRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase()) ?? createLiteScriptService(getDatabase(), app.log);
  const assetService = () => dependencies.createAssetService?.(getDatabase())
    ?? createLiteAssetService(getDatabase(), {
      gateway: dependencies.createGateway?.(getDatabase()) ?? createAiGatewayService(getDatabase()),
      logger: app.log,
      ...(dependencies.createRegistrationService
        ? {
            registerPrimary: async (input: {
              actor: ProjectAccessActor;
              projectId: string;
              assetEntityId: string;
              mediaId: string;
            }) => {
              await dependencies.createRegistrationService!(getDatabase())
                .registerAssetMedia(input.actor, input.assetEntityId, input.mediaId);
            },
          }
        : {}),
    });

  app.post("/api/v1/projects/:project_id/lite/script", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    const body = parseRequest(submitLiteScriptBodySchema, request.body);
    const autoConfirm = body.auto_confirm ?? true;
    const result = await service().submitScript(actor, projectId, {
      episodeId: body.episode_id,
      rawText: body.raw_text,
      clientIdempotencyKey: body.client_idempotency_key,
    });
    // BFF 不等拆解结果:run 创建后后台执行,前端另行轮询进度。
    if (result.outcome === "created") {
      const run = async (): Promise<void> => {
        await service().executeRun(result.runId, actor.id, { autoConfirm });
        // v0.9:一键生成本集 = 解析+确认+落资产+出现记录一次闭环(§3.4.7 前置物化);
        // materialize 幂等,失败只记日志不阻断 run(端点仍可手动补)。
        if (autoConfirm) {
          try {
            await assetService().materializeAssets(actor, projectId, body.episode_id);
          } catch (error) {
            app.log.error(error, "lite auto-materialize after confirm failed");
          }
        }
      };
      if (dependencies.executeRunsInline) {
        await run();
      } else {
        setImmediate(() => {
          void run().catch((error: unknown) => {
            app.log.error(error, "lite script breakdown execution failed");
          });
        });
      }
    }
    return reply.code(201).send(success({
      episodeId: result.episodeId,
      runId: result.runId,
      outcome: result.outcome,
    }));
  });

  // 从文件导入剧本文本:multipart 上传 → 后端提取纯文字 → 前端填进粘贴框(不落库、不解析)。
  app.post("/api/v1/projects/:project_id/lite/script/extract-text", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    const file = await request.file();
    if (!file) throw new BadRequestError("请选择一个剧本文件");
    if (!isScriptTextFile(file.filename)) {
      throw new BadRequestError("目前支持 .txt、.md、.docx 和 .pdf 四种格式，请转换后再上传");
    }
    const content = await file.toBuffer();
    if (!content.length) throw new BadRequestError("文件是空的，没有可提取的文本");
    if (content.length > 5 * 1024 * 1024) throw new PayloadTooLargeError("文件不能超过 5 兆");
    const result = await service().extractScriptText(actor, projectId, file.filename, content);
    return reply.send(success({
      text: result.text,
      char_count: result.charCount,
      source_format: result.sourceFormat,
    }));
  });

  // 整部剧本导入:multipart 上传 → 提取文本 → 按集标题拆分 → 逐集建 episode+version，不自动解析。
  app.post("/api/v1/projects/:project_id/lite/script/import-bulk", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    const file = await request.file();
    if (!file) throw new BadRequestError("请选择一个剧本文件");
    if (!isScriptTextFile(file.filename)) {
      throw new BadRequestError("目前支持 .txt、.md、.docx 和 .pdf 四种格式，请转换后再上传");
    }
    const content = await file.toBuffer();
    if (!content.length) throw new BadRequestError("文件是空的，没有可提取的文本");
    if (content.length > 5 * 1024 * 1024) throw new PayloadTooLargeError("文件不能超过 5 兆");
    const result = await service().importBulkScript(actor, projectId, file.filename, content);
    return reply.code(201).send(success({
      episodes: result.episodes.map((ep) => ({
        episode_id: ep.episodeId,
        episode_no: ep.episodeNo,
        script_version_id: ep.scriptVersionId,
      })),
      replaced: result.replaced,
    }));
  });

  // 候选落成资产:幂等,重复调用不重复建行,故不返 201。多集模式:按当前选中集 materialize。
  app.post("/api/v1/projects/:project_id/lite/assets/materialize", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    const { episode_id: episodeId } = parseRequest(episodeIdQuerySchema, request.query);
    const result = await assetService().materializeAssets(actor, projectId, episodeId);
    return success(result);
  });

  app.get("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/media", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(
      assetMediaParamsSchema,
      request.params,
    );
    const items = await assetService().listAssetMedia(actor, projectId, assetEntityId);
    return success({ items });
  });

  // 参考资产清单:本项目已登记 active 且可用于视频参考的资产,references 认登记的 asset_media_id。
  app.get("/api/v1/projects/:project_id/lite/reference-assets", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    const items = await assetService().listReferenceAssets(actor, projectId);
    return success({ items });
  });

  // 素材列表页:按项目(+可选 kind)列资产,附 tab 聚合计数。
  app.get("/api/v1/projects/:project_id/lite/assets", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    const query = parseRequest(listAssetsQuerySchema, request.query);
    const result = await assetService().listAssets(actor, projectId, query.kind);
    return success({
      items: result.items.map((item) => ({
        asset_entity_id: item.assetEntityId,
        name: item.name,
        intro: item.intro,
        asset_kind: item.assetKind,
        audio_kind: item.audioKind,
        has_media: item.hasMedia,
        has_primary: item.hasPrimary,
        primary_media_url: item.primaryMediaUrl,
        has_pending_generation: item.hasPendingGeneration,
        last_modified_at: item.lastModifiedAt.toISOString(),
      })),
      tab_counts: result.tabCounts.map((tab) => ({ kind: tab.kind, count: tab.count })),
    });
  });

  // 资产详情:正式列 + metadata.lite 投影。
  app.get("/api/v1/projects/:project_id/lite/assets/:asset_entity_id", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(
      assetMediaParamsSchema,
      request.params,
    );
    const detail = await assetService().getAssetDetail(actor, projectId, assetEntityId);
    return success({
      asset_entity_id: detail.assetEntityId,
      name: detail.name,
      intro: detail.intro,
      asset_kind: detail.assetKind,
      audio_kind: detail.audioKind,
      note: detail.note,
      has_media: detail.hasMedia,
      has_primary: detail.hasPrimary,
      has_pending_generation: detail.hasPendingGeneration,
      last_modified_at: detail.lastModifiedAt.toISOString(),
      modified_by_user_id: detail.modifiedByUserId,
      gender: detail.gender,
      age_value: detail.ageValue,
      appearance: detail.appearance,
      hair_description: detail.hairDescription,
      outfit_description: detail.outfitDescription,
      height_cm: detail.heightCm,
      metadata_lite: detail.metadataLite,
    });
  });

  // 手动新建资产:不关联 script_breakdown_runs,metadata.lite.usages 初始空。
  app.post("/api/v1/projects/:project_id/lite/assets", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    const body = parseRequest(createAssetBodySchema, request.body);
    const result = await assetService().createAssetManually(actor, projectId, {
      name: body.name,
      assetKind: body.asset_kind,
      intro: body.intro ?? null,
      note: body.note ?? null,
    });
    return reply.code(201).send(success({
      asset_entity_id: result.assetEntityId,
      first_variant_id: result.firstVariantId,
    }));
  });

  // 更新资产:只改 name/intro/metadata.lite.note,保留 metadata 其他命名空间。
  app.patch("/api/v1/projects/:project_id/lite/assets/:asset_entity_id", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(
      assetMediaParamsSchema,
      request.params,
    );
    const body = parseRequest(patchAssetBodySchema, request.body);
    await assetService().updateAsset(actor, projectId, assetEntityId, {
      name: body.name,
      intro: body.intro,
      note: body.note,
    });
    return success({ ok: true });
  });

  // --- Phase 2:变体 / 版本图轨 / 设主图 / 关联分镜 ---

  // 资产变体列表
  app.get("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/variants", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(assetMediaParamsSchema, request.params);
    const variants = await assetService().listAssetVariants(actor, projectId, assetEntityId);
    return success({
      items: variants.map((v) => ({
        variant_id: v.variantId,
        variant_kind: v.variantKind,
        display_name: v.displayName,
        is_primary: v.isPrimary,
        image_url: v.imageUrl,
      })),
    });
  });

  // 版本图素材轨
  app.get("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/version-track", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(assetMediaParamsSchema, request.params);
    const track = await assetService().listAssetVersionTrack(actor, projectId, assetEntityId);
    return success({
      items: track.map((t) => ({
        asset_media_id: t.assetMediaId,
        media_result_id: t.mediaResultId,
        storage_url: t.storageUrl,
        variant_id: t.variantId,
        is_primary: t.isPrimary,
        source: t.source,
        media_kind: t.mediaKind,
        format: t.format,
        width_px: t.widthPx,
        height_px: t.heightPx,
        created_at: t.createdAt,
      })),
    });
  });

  // 设主图(原子翻转,冲突 409;上传图传 asset_media_id,生成图传 media_result_id,严格二选一)
  app.patch("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/primary-media", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(assetMediaParamsSchema, request.params);
    const body = parseRequest(
      z.object({
        asset_media_id: z.string().uuid().optional(),
        media_result_id: z.string().uuid().optional(),
      }).strict().refine(
        (v) => (v.asset_media_id != null) !== (v.media_result_id != null),
        { message: "asset_media_id 与 media_result_id 必须且只能提供一个" },
      ),
      request.body,
    );
    await assetService().setPrimaryMedia(actor, projectId, assetEntityId, {
      assetMediaId: body.asset_media_id,
      mediaResultId: body.media_result_id,
    });
    return success({ ok: true });
  });

  // 关联分镜列表(可选按变体过滤)
  app.get("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/usages", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(assetMediaParamsSchema, request.params);
    const query = parseRequest(z.object({ variant_id: z.string().uuid().optional() }).strict(), request.query);
    const usages = await assetService().listAssetUsages(actor, projectId, assetEntityId, query.variant_id);
    return success({
      items: usages.map((u) => ({
        usage_id: u.usageId,
        variant_id: u.variantId,
        shot_id: u.shotId,
        episode_id: u.episodeId,
        episode_no: u.episodeNo,
        shot_no: u.shotNo,
        scene_name: u.sceneName,
        shot_label: u.shotLabel,
        status: u.status,
        matched_by: u.matchedBy,
        evidence: {
          scene_names: u.evidence.sceneNames,
          line_indices: u.evidence.lineIndices,
          source_text_snippets: u.evidence.sourceTextSnippets,
        },
      })),
    });
  });

  // 批量添加关联分镜(数组):命中真实分镜 → bound;未命中 → pending 待绑定。
  app.post("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/usages", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(assetMediaParamsSchema, request.params);
    const usageItemSchema = z.object({
      shot_id: z.string().uuid().optional(),
      episode_no: z.number().int().positive().optional(),
      shot_no: z.number().int().positive().optional(),
      scene_name: z.string().max(200).optional(),
      variant_id: z.string().uuid().optional(),
    }).refine(
      (d) => d.shot_id || (d.episode_no != null && d.shot_no != null),
      "需要 shot_id 或 (episode_no + shot_no)",
    );
    const body = parseRequest(z.object({ items: z.array(usageItemSchema).min(1).max(100) }).strict(), request.body);
    const items = body.items.map((item) => ({
      shotId: item.shot_id,
      episodeNo: item.episode_no,
      shotNo: item.shot_no,
      sceneName: item.scene_name,
      variantId: item.variant_id,
    }));
    const result = await assetService().addAssetShotUsages(actor, projectId, assetEntityId, items);
    return reply.code(201).send(success({ added: result.added, pending: result.pending }));
  });

  // 移除关联分镜(按 usage_id)
  app.delete("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/usages/:usage_id", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId, usage_id: usageId } = parseRequest(
      z.object({
        project_id: z.string().uuid(),
        asset_entity_id: z.string().uuid(),
        // usage_id 是 deterministicUsageId 对资产/分镜元组做的 SHA-256 摘要,
        // 不保证 RFC-4122 版本/变体位,不能当严格 uuid 校验(否则存量与新建关联都删不掉)。
        usage_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
      }),
      request.params,
    );
    await assetService().removeAssetShotUsage(actor, projectId, assetEntityId, usageId);
    return success({ ok: true });
  });

  // v1.7 分镜侧删除自动引用(八.10.5):移除该对 exact_name 快照并记抑制名单,backfill 重跑不复活。
  app.delete("/api/v1/projects/:project_id/lite/shots/:shot_id/auto-refs/:asset_entity_id/:variant_id", async (request) => {
    const actor = requireCurrentUser(request);
    const {
      project_id: projectId,
      shot_id: shotId,
      asset_entity_id: assetEntityId,
      variant_id: variantId,
    } = parseRequest(
      z.object({
        project_id: z.string().uuid(),
        shot_id: z.string().uuid(),
        asset_entity_id: z.string().uuid(),
        variant_id: z.string().uuid(),
      }),
      request.params,
    );
    await assetService().removeShotAutoRef(actor, projectId, shotId, assetEntityId, variantId);
    return success({ ok: true });
  });

  // v1.9 十.1 删资产(软删,级联变体/媒体/本项目引用/shot 快照;R1 可逆)
  app.delete("/api/v1/projects/:project_id/lite/assets/:asset_entity_id", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId } = parseRequest(
      z.object({ project_id: z.string().uuid(), asset_entity_id: z.string().uuid() }),
      request.params,
    );
    await assetService().deleteAsset(actor, projectId, assetEntityId);
    return success({ ok: true });
  });

  // 删变体(软删)
  app.delete("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/variants/:variant_id", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId, variant_id: variantId } = parseRequest(
      z.object({ project_id: z.string().uuid(), asset_entity_id: z.string().uuid(), variant_id: z.string().uuid() }),
      request.params,
    );
    await assetService().deleteAssetVariant(actor, projectId, assetEntityId, variantId);
    return success({ ok: true });
  });

  // v1.6 ✨ 匹配剧集(问题八 8.2):AI 只给建议、零写库;确认后写入走既有手动关联路径。
  app.post("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/variants/:variant_id/match-suggest", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId, variant_id: variantId } = parseRequest(
      z.object({ project_id: z.string().uuid(), asset_entity_id: z.string().uuid(), variant_id: z.string().uuid() }),
      request.params,
    );
    const gateway = dependencies.createGateway?.(getDatabase()) ?? createAiGatewayService(getDatabase());
    const result = await assetService().suggestVariantUsages(actor, projectId, assetEntityId, variantId, gateway);
    return success({
      items: result.items.map((item) => ({
        episode_no: item.episodeNo,
        shot_no: item.shotNo,
        scene_name: item.sceneName,
        shot_id: item.shotId,
        reason: item.reason,
        conflict_variant_name: item.conflictVariantName,
      })),
      truncated: result.truncated,
    });
  });

  // 删媒体(软删,media_id 可为 asset_media.id 或 media_results.id)
  app.delete("/api/v1/projects/:project_id/lite/assets/:asset_entity_id/media/:media_id", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId, asset_entity_id: assetEntityId, media_id: mediaId } = parseRequest(
      z.object({ project_id: z.string().uuid(), asset_entity_id: z.string().uuid(), media_id: z.string().uuid() }),
      request.params,
    );
    await assetService().deleteAssetMedia(actor, projectId, assetEntityId, mediaId);
    return success({ ok: true });
  });
}

async function withProjectAssetNamespaceLock<T>(
  db: Database,
  projectId: string,
  work: (scoped: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (transaction) => {
    const scoped = transaction as unknown as Database;
    await lockProjectAssetNamespace(scoped, projectId);
    return work(scoped);
  });
}

export function createLiteScriptService(
  db: Database,
  logger?: { info(obj: Record<string, unknown>, msg: string): void },
): LiteScriptService {
  const createBreakdown = (scoped: Database) => createScriptBreakdownService(scoped, {
    logger,
    // 提示词全文含用户剧本:生产默认不落盘,显式 BREAKDOWN_TRACE_DIR 才开。
    traceDir: process.env.BREAKDOWN_TRACE_DIR
      ?? (process.env.NODE_ENV === "production" ? undefined : "tmp/breakdown-traces"),
  });
  return new LiteScriptService(
    new DrizzleLiteRepository(db),
    ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
    createBreakdown(db),
    new ScriptTextExtractor(),
    {
      logger,
      runProjectMutation: (projectId, work) => withProjectAssetNamespaceLock(
        db,
        projectId,
        (scoped) => work({
          repository: new DrizzleLiteRepository(scoped),
          breakdown: createBreakdown(scoped),
        }),
      ),
    },
  );
}

export function createLiteAssetService(
  db: Database,
  config: {
    gateway?: Pick<AiGatewayService, "completeValidated">;
    logger?: { info(obj: Record<string, unknown>, msg: string): void };
    registerPrimary?: (input: {
      actor: ProjectAccessActor;
      projectId: string;
      assetEntityId: string;
      mediaId: string;
    }) => Promise<void> | void;
  } = {},
): LiteAssetService {
  return new LiteAssetService(
    new DrizzleLiteRepository(db),
    ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
    {
      ...config,
      runProjectMutation: (projectId, work) => withProjectAssetNamespaceLock(
        db,
        projectId,
        (scoped) => work(new DrizzleLiteRepository(scoped)),
      ),
    },
  );
}
