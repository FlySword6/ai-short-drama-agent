import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import type { AssetSearchItem, IngestedAssetResponse, JsonAssetInput, JsonObject } from "../../domain/assets/types.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { AssetEntityRepository } from "../../repositories/assetEntityRepository.js";
import { AssetSourceProjectRepository, type AssetSourceProjectListItem } from "../../repositories/assetSourceProjectRepository.js";
import { AppError, BadRequestError, NotFoundError, PayloadTooLargeError } from "../../shared/errors.js";
import { cleanupUpload, EXCEL_EXTENSIONS, extensionOf, IMAGE_EXTENSIONS, saveUpload } from "../../shared/files.js";
import { attachTiming, elapsedMs } from "../../shared/timing.js";
import { ExcelAssetIngestService, ImageAssetIngestService, JsonAssetIngestService } from "../../services/assetIngestService.js";
import { mapConcurrent } from "../../shared/concurrency.js";
import { VectorSyncService } from "../../services/vectorSyncService.js";
import { AssetCatalogService } from "./catalog.js";
import { AssetCopyRepository } from "./copyRepository.js";
import { AssetCopyService, type AssetCopyPort } from "./copyService.js";
import { HybridAssetSearchService } from "./hybridSearchService.js";
import { AssetMediaUploadService, type AssetMediaUploadInput } from "./mediaUpload.js";
import { AssetVariantService } from "./variants.js";
import { AssetUsageService } from "./usage.js";
import { ProjectAssetCatalogService } from "./projectScope.js";
import { registerAssetTagRoutes, type AssetTagRouteDependencies } from "./tagRoutes.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import { DrizzleVocabularyRepository } from "../vocabulary/repository.js";
import { AssetKindVocabularyService, TagVocabularyService } from "../vocabulary/service.js";
import {
  registerVolcAssetRegistrationRoutes,
  type VolcRegistrationRouteDependencies,
} from "./volcRegistrationRoutes.js";
import { AiGatewayService, ArkAiCompletionProvider } from "../ai/service.js";
import { DrizzleAiCallRepository } from "../ai/repository.js";
import { LlmSearchQueryTokenizer } from "./llmSearchQueryTokenizer.js";
import { VisualAssetSearchService, type VisualSearchItem } from "./visualSearchService.js";
import { AssetMediaRepository } from "../../repositories/assetMediaRepository.js";
import { TosStorage } from "../../integrations/tosStorage.js";
import { DoubaoVisionClient } from "../../integrations/visionClient.js";

// Preserve the legacy import path used by the projection-fallback contract test;
// the implementation remains in the HTTP-independent searchFailover module.
export {
  type AssetSearchFailoverResult,
  isRebuildableSearchDependencyFailure,
  searchWithPostgresFailover,
  searchWithPostgresFailoverResult,
} from "./searchFailover.js";

/** 资产媒体 multipart 全局限额(20MB;与音频单文件上限一致,图片按 media_kind 再收紧到 10MB)。 */
export const ASSET_MEDIA_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_FILES = 50;
const IMAGE_INGEST_CONCURRENCY = 6;

const jsonObjectSchema = z.record(z.string(), z.unknown());
const assetRoleSchema = z.enum([
  "character_identity",
  "scene",
  "prop",
  "motion",
  "camera_storyboard",
  "style_env",
]);
const assetUsageModeSchema = z.enum(["reference", "first_frame", "last_frame"]);
const controlAssetInputSchema = z.object({
  role: assetRoleSchema.nullable().optional(),
  usage_mode: assetUsageModeSchema.nullable().optional(),
});
const jsonAssetSchema = z.object({
  asset_kind: z.string().min(1),
  name: z.string().min(1),
  display_name: z.string().nullable().optional(),
  intro: z.string().nullable().optional(),
  appearance: z.string().nullable().optional(),
  age_value: z.coerce.number().int().nullable().optional(),
  gender: z.string().nullable().optional(),
  height_cm: z.coerce.number().int().nullable().optional(),
  hair_description: z.string().nullable().optional(),
  outfit_description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  style_tags: z.array(z.string()).default([]),
  approved: z.boolean().nullable().optional(),
  reuse_scope: z.string().default("needs_review"),
  status: z.string().default("pending_review"),
  source_file_url: z.string().nullable().optional(),
  metadata: jsonObjectSchema.default({}),
  role: assetRoleSchema.nullable().optional(),
  usage_mode: assetUsageModeSchema.nullable().optional(),
});
const jsonIngestSchema = z.object({
  source_project_id: z.string().uuid().nullable().optional(),
  source_project_name: z.string().nullable().optional(),
  assets: z.array(jsonAssetSchema).min(1),
});
const hybridSearchSchema = z.object({
  query: z.string().trim().min(1).max(255),
  scope: z.enum(["personal", "common"]).optional(),
  project_id: z.string().uuid().optional(),
  source_project_id: z.string().uuid().optional(),
  page: z.number().int().min(1).max(100).default(1),
  page_size: z.number().int().min(1).max(50).default(20),
}).refine((value) => !(value.scope && value.project_id), {
  message: "资产范围和项目范围不能同时选择",
});
const visualSearchJsonSchema = z.object({
  image_media_id: z.string().uuid(),
  query: z.string().trim().max(255).optional(),
  alpha: z.number().min(0).max(1).optional(),
  scope: z.enum(["personal", "common"]).optional(),
  project_id: z.string().uuid().optional(),
  source_project_id: z.string().uuid().optional(),
  page: z.number().int().min(1).max(100).default(1),
  page_size: z.number().int().min(1).max(50).default(20),
});

const legacySemanticSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});
const assetSourceProjectListSchema = z.object({
  scope: z.enum(["personal", "common", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const id = z.string().uuid();
const assetParams = z.object({ asset_id: id });
const importPersonalSchema = z.object({ asset_id: id });
const assetMediaParams = z.object({ asset_id: id, media_id: id });
const assetListSchema = z.object({
  scope: z.enum(["personal", "common", "project"]).default("personal"),
  project_id: id.optional(),
  q: z.string().trim().max(255).optional(),
  // 旧客户端兼容；新资产中心统一使用 q。
  query: z.string().trim().max(255).optional(),
  asset_kind: z.string().trim().max(32).optional(),
  status: z.string().trim().max(32).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  tags: z.string().trim().max(1_024).optional().transform((value, context) => {
    if (!value) return undefined;
    const tags = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
    if (tags.length === 0) return undefined;
    if (tags.length > 20) {
      context.addIssue({ code: "custom", message: "标签筛选最多选择 20 项" });
      return z.NEVER;
    }
    if (tags.some((item) => item.length > 64)) {
      context.addIssue({ code: "custom", message: "单个标签不能超过 64 个字符" });
      return z.NEVER;
    }
    return tags;
  }),
  media: z.enum(["image", "model3d"]).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  source: id.optional(),
  gender: z.string().trim().min(1).max(32).optional(),
  age_band: z.string().trim().min(1).max(32).optional(),
  sort: z.enum(["composite", "newest"]).default("composite"),
  page: z.coerce.number().int().min(1).max(100).default(1),
  // 兼容尚未接分页的旧调用端；资产中心新客户端必须显式传 24。
  page_size: z.coerce.number().int().min(1).max(500).default(500),
});
const mediaUploadFieldsSchema = z.object({
  media_kind: z.enum(["image", "audio"]).default("image"),
  is_primary: z.enum(["true", "false", "1", "0"]).default("false")
    .transform((value) => value === "true" || value === "1"),
  title: z.string().trim().min(1).max(128).optional(),
  description: z.string().trim().min(1).max(2_000).optional(),
  asset_variant_id: z.string().uuid().optional(),
});
const updateAssetSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  display_name: z.string().trim().max(128).nullable().optional(),
  intro: z.string().trim().max(10_000).nullable().optional(),
  appearance: z.string().trim().max(10_000).nullable().optional(),
  age_value: z.coerce.number().int().min(0).max(500).nullable().optional(),
  gender: z.string().trim().max(32).nullable().optional(),
  height_cm: z.coerce.number().int().min(0).max(300).nullable().optional(),
  hair_description: z.string().trim().max(512).nullable().optional(),
  outfit_description: z.string().trim().max(10_000).nullable().optional(),
  category: z.string().trim().max(64).nullable().optional(),
  style_tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  reuse_scope: z.string().trim().min(1).max(20).optional(),
  status: z.string().trim().min(1).max(20).optional(),
  metadata: jsonObjectSchema.optional(),
  role: assetRoleSchema.nullable().optional(),
  usage_mode: assetUsageModeSchema.nullable().optional(),
}).refine((input) => Object.keys(input).length > 0, "至少提供一个要修改的字段");
// asset_variants: name varchar(128), variant_kind varchar(32), usage_context varchar(255)
const createVariantSchema = z.object({
  name: z.string().trim().min(1).max(128),
  variant_kind: z.string().trim().min(1).max(32).default("look"),
  description: z.string().trim().max(10_000).nullable().optional(),
  usage_context: z.string().trim().max(255).nullable().optional(),
  visual_prompt: z.string().trim().max(10_000).nullable().optional(),
  is_primary: z.boolean().default(false),
  sort_order: z.number().int().min(0).max(9999).default(0),
  episode_nos: z.array(z.number().int().min(1).max(9999)).max(500).optional(),
}).strict();

const usageQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
}).strict();

export interface AssetRouteDependencies {
  createAssetCopyService?: (db: Database) => AssetCopyPort;
  createAssetCatalogService?: (db: Database) => AssetCatalogService;
  createMediaUploadService?: (
    db: Database,
  ) => Pick<AssetMediaUploadService, "assertManageable" | "upload">;
  createVariantService?: (db: Database) => Pick<AssetVariantService, "create" | "list">;
  createUsageService?: (db: Database) => Pick<AssetUsageService, "report">;
  createProjectAssetCatalogService?: (db: Database) => Pick<ProjectAssetCatalogService, "list">;
  createProjectAccessService?: (db: Database) => Pick<ProjectAccessService, "require">;
  createAssetSourceProjectRepository?: (db: Database) => Pick<AssetSourceProjectRepository, "listVisibleForUser">;
  createHybridSearchService?: (db: Database) => Pick<HybridAssetSearchService, "search">;
  createVisualSearchService?: (db: Database) => Pick<VisualAssetSearchService, "search">;
  createVectorSyncService?: () => Pick<VectorSyncService, "syncEntity">;
  /** S41 资产标签路由注入(测试用);缺省走词表服务 + 数据库。 */
  assetTagRoutes?: AssetTagRouteDependencies;
  /** 火山素材登记通用 API 注入；旧 seedance-registration 路由仍独立保留。 */
  volcRegistrationRoutes?: VolcRegistrationRouteDependencies;
  /**
   * 2026-08-19 触发模型:注入登记服务后,is_primary=true 上传(完整版与 Lite
   * 共用 mediaUpload 钩子)persist 成功后后台自动登记火山素材。未注入保持纯人工登记。
   */
  createAssetRegistrationService?: (db: Database) => {
    registerAssetMedia(actor: string, assetId: string, mediaId: string): Promise<unknown>;
  };
}

export async function registerAssetRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AssetRouteDependencies = {},
): Promise<void> {
  // S41:词表接线只发生在 HTTP 路由层。离线工具与降级搜索等直接构造
  // AssetCatalogService(db) 的调用点保持 identity 端口(精确匹配)。
  const vocabularyRepository = () => new DrizzleVocabularyRepository(getDatabase());
  const catalog = () => dependencies.createAssetCatalogService?.(getDatabase())
    ?? new AssetCatalogService(getDatabase(), {
      kinds: new AssetKindVocabularyService(vocabularyRepository()),
      tags: new TagVocabularyService(vocabularyRepository()),
    });
  const assetCopy = () => new AssetCopyService(
    dependencies.createAssetCopyService?.(getDatabase()) ?? new AssetCopyRepository(getDatabase()),
  );
  const mediaUpload = () => dependencies.createMediaUploadService?.(getDatabase())
    ?? new AssetMediaUploadService(getDatabase(), dependencies.createAssetRegistrationService
      ? {
          registerPrimary: async ({ actorId, assetId, mediaId }) => {
            await dependencies.createAssetRegistrationService!(getDatabase())
              .registerAssetMedia(actorId, assetId, mediaId);
          },
        }
      : {});
  const variants = () => dependencies.createVariantService?.(getDatabase())
    ?? new AssetVariantService(getDatabase());
  const usage = () => dependencies.createUsageService?.(getDatabase())
    ?? new AssetUsageService(getDatabase());
  const projectCatalog = () => dependencies.createProjectAssetCatalogService?.(getDatabase())
    ?? new ProjectAssetCatalogService(getDatabase(), {
      kinds: new AssetKindVocabularyService(vocabularyRepository()),
      tags: new TagVocabularyService(vocabularyRepository()),
      tagLinks: vocabularyRepository(),
    });
  const projectAccess = () => dependencies.createProjectAccessService?.(getDatabase())
    ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(getDatabase()));
  const sourceProjects = () => dependencies.createAssetSourceProjectRepository?.(getDatabase())
    ?? new AssetSourceProjectRepository(getDatabase());
  const hybridSearch = () => dependencies.createHybridSearchService?.(getDatabase())
    ?? createDefaultHybridSearchService(getDatabase());
  const visualSearch = () => dependencies.createVisualSearchService?.(getDatabase())
    ?? createDefaultVisualSearchService(getDatabase());
  const vectorSync = () => dependencies.createVectorSyncService?.() ?? new VectorSyncService();

  app.get("/api/v1/assets", async (request) => {
    const input = parseAssetListQuery(request.query);
    const actor = requireCurrentUser(request);
    const actorId = actor.id;
    const requestedTags = input.tags ?? (input.tag ? [input.tag] : undefined);
    const filters = {
      ...(input.q || input.query ? { query: input.q ?? input.query } : {}),
      ...(input.asset_kind ? { assetKind: input.asset_kind } : {}),
      ...(input.scope === "common" && actor.role !== "admin"
        ? { status: "approved" }
        : input.status ? { status: input.status } : {}),
      ...(input.scope === "common" && actor.role === "admin"
        ? { allowUnapprovedCommon: true }
        : {}),
      ...(requestedTags ? { tags: requestedTags } : {}),
      ...(input.media ? { media: input.media } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.source ? { sourceProjectId: input.source } : {}),
      ...(input.gender ? { gender: input.gender } : {}),
      ...(input.age_band ? { ageBand: input.age_band } : {}),
      sort: input.sort,
    };
    if (input.scope === "project") {
      const items = await listProjectAssets(
        projectCatalog(),
        projectAccess(),
        actor,
        input.project_id!,
        filters,
      );
      return success({ items, count: items.length });
    }
    const result = await catalog().listPage(
      actorId,
      { scope: input.scope, ...filters },
      input.page,
      input.page_size,
    );
    return success({
      items: result.items,
      count: result.total,
      total: result.total,
      filtered_count: result.filteredTotal,
      page: result.page,
      page_size: result.pageSize,
      has_more: result.hasMore,
      kind_counts: result.kindCounts,
    });
  });

  app.get("/api/v1/assets/:asset_id", async (request) => {
    const params = parseRequest(assetParams, request.params);
    const actor = requireCurrentUser(request);
    return success(await catalog().get(actor.id, params.asset_id, {
      allowUnapprovedCommon: actor.role === "admin",
    }));
  });

  app.post("/api/v1/assets/:asset_id/copy-to-personal", async (request, reply) => {
    const params = parseRequest(assetParams, request.params);
    const result = await assetCopy().copyCommonToPersonal(
      requireCurrentUser(request).id,
      params.asset_id,
    );
    return reply.code(result.created ? 201 : 200).send(success(result));
  });

  app.post("/api/v1/assets/import-personal", async (request, reply) => {
    const input = parseRequest(importPersonalSchema, request.body);
    const actorId = requireCurrentUser(request).id;
    const result = await assetCopy().copyCommonToPersonal(actorId, input.asset_id);
    const asset = await catalog().get(actorId, result.assetId);
    return reply.code(result.created ? 201 : 200).send(success({
      ...asset,
      created: result.created,
      sourceAssetId: result.sourceAssetId,
      copiedVariantCount: result.copiedVariantCount,
      copiedMediaCount: result.copiedMediaCount,
    }));
  });

  app.patch("/api/v1/assets/:asset_id", async (request) => {
    const params = parseRequest(assetParams, request.params);
    const input = parseRequest(updateAssetSchema, request.body);
    const updated = await catalog().update(requireCurrentUser(request).id, params.asset_id, compact({
      name: input.name,
      displayName: input.display_name,
      intro: input.intro,
      appearance: input.appearance,
      ageValue: input.age_value,
      gender: input.gender,
      heightCm: input.height_cm,
      hairDescription: input.hair_description,
      outfitDescription: input.outfit_description,
      category: input.category,
      styleTags: input.style_tags,
      reuseScope: input.reuse_scope,
      status: input.status,
      metadata: input.metadata,
      role: input.role,
      usageMode: input.usage_mode,
    }));
    // 向量同步不复用路由层加工过的展示对象(toAssetData 会脱敏 metadata、改写
    // 媒体 URL),回仓库重查原始行,和 Excel/图片入库共用同一条同步路径。
    queueEntityVectorSync(getDatabase(), params.asset_id, vectorSync);
    return success(updated);
  });

  app.delete("/api/v1/assets/:asset_id", async (request) => {
    const params = parseRequest(assetParams, request.params);
    await catalog().moveToTrash(requireCurrentUser(request).id, params.asset_id);
    return success({ deleted: true });
  });

  app.get("/api/v1/assets/:asset_id/versions", async (request) => {
    const params = parseRequest(assetParams, request.params);
    const actor = requireCurrentUser(request);
    const items = await catalog().versions(actor.id, params.asset_id, {
      allowUnapprovedCommon: actor.role === "admin",
    });
    return success({ items, count: items.length });
  });

  app.get("/api/v1/assets/:asset_id/variants", async (request) => {
    const params = parseRequest(assetParams, request.params);
    const items = await variants().list(requireCurrentUser(request).id, params.asset_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/assets/:asset_id/variants", async (request, reply) => {
    const params = parseRequest(assetParams, request.params);
    const input = parseRequest(createVariantSchema, request.body);
    const variant = await variants().create({
      actorId: requireCurrentUser(request).id,
      assetId: params.asset_id,
      name: input.name,
      variantKind: input.variant_kind,
      description: input.description ?? null,
      usageContext: input.usage_context ?? null,
      visualPrompt: input.visual_prompt ?? null,
      isPrimary: input.is_primary,
      sortOrder: input.sort_order,
      ...(input.episode_nos ? { episodeNos: input.episode_nos } : {}),
    });
    return reply.code(201).send(success(variant));
  });

  app.get("/api/v1/assets/:asset_id/usage", async (request) => {
    const params = parseRequest(assetParams, request.params);
    const query = parseRequest(usageQuerySchema, request.query ?? {});
    const report = await usage().report(
      requireCurrentUser(request),
      params.asset_id,
      query.project_id,
    );
    return success(report);
  });

  app.get("/api/v1/asset-source-projects", async (request) => {
    const input = parseRequest(assetSourceProjectListSchema, request.query ?? {});
    const actor = requireCurrentUser(request);
    const items = await sourceProjects().listVisibleForUser(actor.id, input);
    return success({ items: items.map(toAssetSourceProjectResponse), count: items.length });
  });

  app.post("/api/v1/assets/:asset_id/media", async (request, reply) => {
    const params = parseRequest(assetParams, request.params);
    const actorId = requireCurrentUser(request).id;
    const service = mediaUpload();
    // Check access before Fastify reads the multipart file into memory. The
    // service and its persistence transaction both check again after reading.
    await service.assertManageable(actorId, params.asset_id);
    const upload = await readAssetMediaMultipart(request);
    const item = await service.upload({
      actorId,
      assetId: params.asset_id,
      ...upload,
    });
    return reply.code(201).send(success(item));
  });

  app.post("/api/v1/assets/:asset_id/media/:media_id/set-primary", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const params = parseRequest(assetMediaParams, request.params);
    return success(await catalog().setPrimary(
      requireCurrentUser(request).id,
      params.asset_id,
      params.media_id,
    ));
  });

  app.post("/api/v1/asset-ingest/json/assets", async (request) => {
    const input = parseRequest(jsonIngestSchema, request.body);
    const items = await new JsonAssetIngestService(getDatabase()).ingest({
      ownerUserId: requireCurrentUser(request).id,
      visibility: "personal",
      sourceProjectId: input.source_project_id,
      sourceProjectName: input.source_project_name,
      assets: input.assets.map(toJsonAssetInput),
    });
    return success({ count: items.length, items });
  });

  app.post("/api/v1/asset-ingest/upload", async (request, reply) => {
    return handleUpload(request, reply, getDatabase, false, vectorSync);
  });

  app.post("/api/v1/asset-ingest/excel/upload", async (request, reply) => {
    return handleUpload(request, reply, getDatabase, true, vectorSync);
  });

  app.post("/api/v1/asset-search/semantic", async (request) => {
    console.info("[asset-search] deprecated endpoint /api/v1/asset-search/semantic called");
    const input = parseRequest(legacySemanticSearchSchema, request.body);
    const actor = requireCurrentUser(request);
    const result = await hybridSearch().search({
      actorId: actor.id,
      query: input.query,
      page: 1,
      pageSize: input.limit,
    });
    return success({
      mode: "hybrid",
      count: result.items.length,
      items: result.items.map(toLegacySemanticSearchResponse),
    });
  });

  app.post("/api/v1/asset-search", async (request) => {
    const input = parseRequest(hybridSearchSchema, request.body);
    if (input.project_id && input.source_project_id) {
      throw new BadRequestError("project_id and source_project_id cannot be used together");
    }
    const actor = requireCurrentUser(request);
    const projectAccessRecord = input.project_id
      ? await projectAccess().require(actor, input.project_id, "read")
      : undefined;
    const result = await hybridSearch().search({
      actorId: actor.id,
      query: input.query,
      page: input.page,
      pageSize: input.page_size,
      ...(input.scope ? { libraryScope: input.scope } : {}),
      ...(projectAccessRecord ? { projectId: projectAccessRecord.projectId } : {}),
      ...(input.source_project_id ? { sourceProjectId: input.source_project_id } : {}),
    });
    return success({
      items: result.items.map(toHybridSearchResponse),
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
      diagnostics: result.diagnostics,
    });
  });

  app.post("/api/v1/asset-search/visual", async (request) => {
    const actor = requireCurrentUser(request);
    const isMultipart = (request.headers["content-type"] ?? "").includes("multipart/form-data");
    let imageContent: Buffer;
    let imageContentType: string | null;
    let imageMediaId: string | null = null;
    let query: string | undefined;
    let alpha: number | undefined;
    let scope: "personal" | "common" | undefined;
    let projectId: string | undefined;
    let sourceProjectId: string | undefined;
    let page = 1;
    let pageSize = 20;
    if (isMultipart) {
      let file: { content: Buffer; contentType: string } | undefined;
      const fields: Record<string, string> = {};
      try {
        for await (const part of request.parts({ limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10, parts: 11 } })) {
          if (part.type === "file") {
            if (file) throw new BadRequestError("only one image file is allowed");
            file = { content: await part.toBuffer(), contentType: part.mimetype };
          } else if (typeof part.value === "string") {
            fields[part.fieldname] = part.value;
          }
        }
      } catch (error) {
        if (isMultipartFileTooLarge(error)) throw new PayloadTooLargeError("image exceeds 10MB limit");
        throw error;
      }
      if (!file) throw new BadRequestError("missing image file");
      imageContent = file.content;
      imageContentType = file.contentType;
      query = fields.query?.trim() || undefined;
      alpha = fields.alpha ? Number(fields.alpha) : undefined;
      scope = (fields.scope as "personal" | "common" | undefined) || undefined;
      projectId = fields.project_id || undefined;
      sourceProjectId = fields.source_project_id || undefined;
      page = fields.page ? Number(fields.page) : 1;
      pageSize = fields.page_size ? Number(fields.page_size) : 20;
    } else {
      const input = parseRequest(visualSearchJsonSchema, request.body);
      imageMediaId = input.image_media_id;
      const mediaRepo = new AssetMediaRepository(getDatabase());
      const mediaRow = await mediaRepo.findById(imageMediaId);
      if (!mediaRow || !mediaRow.storagePath) throw new NotFoundError("asset media not found");
      const tos = new TosStorage();
      imageContent = await tos.readObjectBytes(mediaRow.storagePath, { maxBytes: 10 * 1024 * 1024 });
      imageContentType = null;
      query = input.query;
      alpha = input.alpha;
      scope = input.scope;
      projectId = input.project_id;
      sourceProjectId = input.source_project_id;
      page = input.page;
      pageSize = input.page_size;
    }
    if (projectId && sourceProjectId) {
      throw new BadRequestError("project_id and source_project_id cannot be used together");
    }
    const projectAccessRecord = projectId
      ? await projectAccess().require(actor, projectId, "read")
      : undefined;
    const result = await visualSearch().search({
      actorId: actor.id,
      imageContent,
      imageContentType,
      query,
      alpha,
      page,
      pageSize,
      ...(scope ? { libraryScope: scope } : {}),
      ...(projectAccessRecord ? { projectId: projectAccessRecord.projectId } : {}),
      ...(sourceProjectId ? { sourceProjectId } : {}),
    });
    if (!result.diagnostics.semanticAvailable) {
      let caption: string;
      if (imageMediaId) {
        const mediaRepo = new AssetMediaRepository(getDatabase());
        const mediaRow = await mediaRepo.findById(imageMediaId);
        const entityRepo = new AssetEntityRepository(getDatabase());
        if (mediaRow) {
          const entityRow = await entityRepo.getById(mediaRow.assetEntityId ?? "");
          caption = entityRow ? [entityRow.name, entityRow.intro, entityRow.appearance].filter(Boolean).join(" ") : "";
        } else { caption = ""; }
      } else {
        const vision = new DoubaoVisionClient();
        const raw = await vision.describeImage(imageContent, imageContentType, { fileName: "visual-search", sourceProjectName: "" }, {});
        const name = typeof raw.name === "string" ? raw.name : "";
        const intro = typeof raw.intro === "string" ? raw.intro : "";
        const appearance = typeof raw.appearance === "string" ? raw.appearance : "";
        caption = [name, intro, appearance].filter(Boolean).join(" ");
      }
      if (!caption) {
        return success({ items: [], page, pageSize, hasMore: false, diagnostics: { ...result.diagnostics, fallbackMode: "caption_text" } });
      }
      const textResult = await hybridSearch().search({
        actorId: actor.id,
        query: caption,
        page,
        pageSize,
        ...(scope ? { libraryScope: scope } : {}),
        ...(projectAccessRecord ? { projectId: projectAccessRecord.projectId } : {}),
        ...(sourceProjectId ? { sourceProjectId } : {}),
      });
      return success({
        items: textResult.items.map((item) => toVisualSearchResponse({ ...item, matchedMedia: null })),
        page: textResult.page,
        pageSize: textResult.pageSize,
        hasMore: textResult.hasMore,
        diagnostics: { ...textResult.diagnostics, fallbackMode: "caption_text" },
      });
    }
    return success({
      items: result.items.map(toVisualSearchResponse),
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
      diagnostics: result.diagnostics,
    });
  });

  await registerAssetTagRoutes(app, getDatabase, dependencies.assetTagRoutes);
  await registerVolcAssetRegistrationRoutes(app, getDatabase, dependencies.volcRegistrationRoutes);
}

async function listProjectAssets(
  catalog: Pick<ProjectAssetCatalogService, "list">,
  access: Pick<ProjectAccessService, "require">,
  actor: ReturnType<typeof requireCurrentUser>,
  projectId: string,
  filters: {
    query?: string;
    assetKind?: string;
    status?: string;
    tags?: string[];
    media?: "image" | "model3d";
    category?: string;
    sourceProjectId?: string;
    gender?: string;
    ageBand?: string;
    sort?: "composite" | "newest";
  },
) {
  const projectAccess = await access.require(actor, projectId, "read");
  return catalog.list(actor.id, projectId, {
    query: filters.query,
    assetKind: filters.assetKind,
    status: filters.status,
    tag: filters.tags?.[0],
  }, projectAccess.projectId);
}

export function parseAssetListQuery(input: unknown): z.infer<typeof assetListSchema> {
  const parsed = parseRequest(assetListSchema, input);
  if (parsed.scope === "project" && !parsed.project_id) {
    throw new BadRequestError("查看项目资产没成：请先选择项目。");
  }
  if ((parsed.gender || parsed.age_band) && parsed.asset_kind !== "character") {
    throw new BadRequestError("性别和年龄段筛选仅适用于角色资产");
  }
  return parsed;
}

function createDefaultHybridSearchService(db: Database): HybridAssetSearchService {
  const gateway = new AiGatewayService(
    new DrizzleAiCallRepository(db),
    new ArkAiCompletionProvider(),
  );
  return new HybridAssetSearchService(db, {
    lexicalTokenizer: new LlmSearchQueryTokenizer(gateway),
  });
}

function createDefaultVisualSearchService(db: Database): VisualAssetSearchService {
  return new VisualAssetSearchService(db);
}

async function readAssetMediaMultipart(
  request: FastifyRequest,
): Promise<Omit<AssetMediaUploadInput, "actorId" | "assetId">> {
  let file: { fileName: string; declaredContentType: string; content: Buffer } | undefined;
  const fields: Record<string, string> = {};
  try {
    for await (const part of request.parts({
      limits: {
        fileSize: ASSET_MEDIA_MAX_FILE_BYTES,
        files: 1,
        fields: 5,
        parts: 6,
      },
    })) {
      if (part.type === "file") {
        if (file) throw new BadRequestError("一次只能上传一个媒体文件");
        file = {
          fileName: part.filename,
          declaredContentType: part.mimetype,
          content: await part.toBuffer(),
        };
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    if (isMultipartFileTooLarge(error)) {
      throw new PayloadTooLargeError("上传文件不能超过 20 兆。");
    }
    throw error;
  }
  if (!file) throw new BadRequestError("缺少上传媒体文件");
  const input = parseRequest(mediaUploadFieldsSchema, fields);
  return {
    ...file,
    mediaKind: input.media_kind,
    isPrimary: input.is_primary,
    ...(input.title ? { title: input.title } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.asset_variant_id ? { assetVariantId: input.asset_variant_id } : {}),
  };
}

function isMultipartFileTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE";
}

function isMultipartCountLimitExceeded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT";
}

interface IngestFilePart {
  fileName: string;
  content: Buffer;
  contentType: string;
}

interface IngestMultipartBody {
  fields: Record<string, string>;
  files: IngestFilePart[];
}

async function readIngestMultipart(request: FastifyRequest): Promise<IngestMultipartBody> {
  const fields: Record<string, string> = {};
  const files: IngestFilePart[] = [];
  try {
    for await (const part of request.parts({
      limits: {
        files: MAX_IMAGE_UPLOAD_FILES,
        fields: 10,
        parts: MAX_IMAGE_UPLOAD_FILES + 10,
      },
    })) {
      if (part.type === "field") {
        if (typeof part.value === "string" && part.value.trim()) fields[part.fieldname] = part.value.trim();
        continue;
      }
      if (!part.filename) {
        await part.toBuffer().catch(() => undefined);
        continue;
      }
      files.push({
        fileName: part.filename,
        contentType: part.mimetype,
        content: await part.toBuffer(),
      });
    }
  } catch (error) {
    if (isMultipartFileTooLarge(error)) throw new PayloadTooLargeError("上传文件超过大小限制");
    if (isMultipartCountLimitExceeded(error)) throw new PayloadTooLargeError(`单次最多上传 ${MAX_IMAGE_UPLOAD_FILES} 张图片`);
    throw error;
  }
  return { fields, files };
}

async function handleUpload(
  request: FastifyRequest,
  _reply: FastifyReply,
  getDatabase: () => Database,
  excelOnly: boolean,
  createVectorSync: () => Pick<VectorSyncService, "syncEntity">,
): Promise<unknown> {
  const requestStarted = performance.now();
  const upload = await readIngestMultipart(request);
  const multipartReadMs = elapsedMs(requestStarted);
  const file = upload.files[0];
  if (!file) throw new BadRequestError("缺少上传文件");
  const fileName = file.fileName;
  const extension = extensionOf(fileName);
  const fields = upload.fields;
  const sourceProjectName = fieldText(fields.source_project_name);
  const batchSize = parseBoundedInt(fieldText(fields.batch_size), 5, 1, 20);
  const assetKindHint = fieldText(fields.asset_kind_hint);
  const control = parseControlAssetInput({
    role: fieldText(fields.role) ?? undefined,
    usage_mode: fieldText(fields.usage_mode) ?? undefined,
  });
  const isExcel = EXCEL_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension) || file.contentType.startsWith("image/");
  if (isExcel && upload.files.length > 1) throw new BadRequestError("Excel 入库一次只能上传一个文件");
  if (excelOnly && !isExcel) {
    throw new BadRequestError("上传没成：这里只支持 Excel 表格。");
  }
  if (!isExcel && !isImage) throw new BadRequestError("只支持 Excel 或常见图片文件");

  const content = file.content;
  const ownerUserId = requireCurrentUser(request).id;
  if (isExcel) {
    const uploadedPath = await saveUpload(fileName, content);
    const timingStarted = performance.now();
    try {
      const items = await new ExcelAssetIngestService(getDatabase()).ingest({
        ownerUserId,
        visibility: "personal",
        fileName,
        content,
        contentType: file.contentType,
        sourceProjectName,
        batchSize,
        role: control.role,
        usageMode: control.usage_mode,
      });
      const timing = {
        api_save_upload: Math.round(timingStarted - requestStarted),
        api_service_ingest_excel: Math.round(performance.now() - timingStarted),
        api_cleanup_upload: 0,
        api_total_before_response: 0,
      };
      const deleted = await cleanupUpload(uploadedPath);
      timing.api_cleanup_upload = Math.round(elapsedMs(timingStarted));
      timing.api_total_before_response = Math.round(elapsedMs(requestStarted));
      attachTiming(items, timing);
      return success({ mode: "excel", count: items.length, items, uploaded_file_deleted: deleted });
    } catch (error) {
      await cleanupUpload(uploadedPath).catch(() => false);
      throw error;
    }
  }

  const imageValidateStarted = performance.now();
  const imageFiles = upload.files.filter((candidate) => {
    const candidateExtension = extensionOf(candidate.fileName);
    return IMAGE_EXTENSIONS.has(candidateExtension) || candidate.contentType.startsWith("image/");
  });
  if (imageFiles.length !== upload.files.length) throw new BadRequestError("图片文件夹批量入库只能包含常见图片文件");
  if (imageFiles.length > MAX_IMAGE_UPLOAD_FILES) throw new BadRequestError(`单次最多上传 ${MAX_IMAGE_UPLOAD_FILES} 张图片`);
  const imageValidateMs = elapsedMs(imageValidateStarted);
  const imageTotalBytes = imageFiles.reduce((total, item) => total + item.content.length, 0);

  if (imageFiles.length === 1) {
    const imageIngestStarted = performance.now();
    const item = await new ImageAssetIngestService(getDatabase()).ingest({
      ownerUserId,
      visibility: "personal",
      fileName,
      content,
      contentType: file.contentType,
      sourceProjectName,
      batchSize,
      assetKindHint,
      role: control.role,
      usageMode: control.usage_mode,
    }, false);
    const imageIngestMs = elapsedMs(imageIngestStarted);
    const vectorQueueStarted = performance.now();
    queueEntityVectorSync(getDatabase(), item.id, createVectorSync);
    const vectorQueueMs = elapsedMs(vectorQueueStarted);
    const backgroundTiming = item.metadata.ingest_timing_ms;
    if (typeof backgroundTiming === "object" && backgroundTiming !== null && !Array.isArray(backgroundTiming)) {
      item.metadata.vector_sync_status = "queued_background_task";
    }
    const routeTiming: JsonObject = {
      image_mode: "single",
      api_multipart_read: multipartReadMs,
      api_image_validate: imageValidateMs,
      image_file_count: 1,
      image_success_count: 1,
      image_failed_count: 0,
      image_total_bytes: imageTotalBytes,
      image_total_mb: roundTiming(imageTotalBytes / 1024 / 1024),
      image_concurrency: 1,
      api_image_single_ingest: imageIngestMs,
      api_vector_sync_async_enqueue_total: vectorQueueMs,
      api_total_before_response: elapsedMs(requestStarted),
    };
    mergeIngestTiming(item, routeTiming);
    console.info("[image-ingest] timing", {
      ...routeTiming,
      image_per_file: [imageTimingLogItem({
        fileName,
        success: true,
        durationMs: imageIngestMs,
        vectorQueueMs,
        item,
      })],
    });
    return success({ mode: "image", count: 1, items: [item], uploaded_file_deleted: false });
  }

  const service = new ImageAssetIngestService(getDatabase());
  const batchIngestStarted = performance.now();
  const results = await mapConcurrent(imageFiles, IMAGE_INGEST_CONCURRENCY, async (part) => {
    const fileStarted = performance.now();
    try {
      const item = await service.ingest({
        ownerUserId,
        visibility: "personal",
        fileName: part.fileName,
        content: part.content,
        contentType: part.contentType,
        sourceProjectName,
        batchSize,
        assetKindHint,
        role: control.role,
        usageMode: control.usage_mode,
      }, false);
      const serviceDurationMs = elapsedMs(fileStarted);
      const vectorQueueStarted = performance.now();
      queueEntityVectorSync(getDatabase(), item.id, createVectorSync);
      const vectorQueueMs = elapsedMs(vectorQueueStarted);
      const backgroundTiming = item.metadata.ingest_timing_ms;
      if (typeof backgroundTiming === "object" && backgroundTiming !== null && !Array.isArray(backgroundTiming)) {
        item.metadata.vector_sync_status = "queued_background_task";
      }
      return {
        fileName: part.fileName,
        success: true as const,
        item,
        durationMs: elapsedMs(fileStarted),
        serviceDurationMs,
        vectorQueueMs,
      };
    } catch (error) {
      return {
        fileName: part.fileName,
        success: false as const,
        error: imageIngestErrorMessage(error),
        durationMs: elapsedMs(fileStarted),
        serviceDurationMs: elapsedMs(fileStarted),
        vectorQueueMs: 0,
      };
    }
  });
  const batchIngestMs = elapsedMs(batchIngestStarted);
  const items = results.flatMap((result) => (result.success ? [result.item] : []));
  const routeTiming: JsonObject = {
    image_mode: "batch",
    api_multipart_read: multipartReadMs,
    api_image_validate: imageValidateMs,
    image_file_count: imageFiles.length,
    image_success_count: items.length,
    image_failed_count: results.length - items.length,
    image_total_bytes: imageTotalBytes,
    image_total_mb: roundTiming(imageTotalBytes / 1024 / 1024),
    image_concurrency: IMAGE_INGEST_CONCURRENCY,
    api_image_batch_ingest_parallel: batchIngestMs,
    api_vector_sync_async_enqueue_total: roundTiming(results.reduce((total, result) => total + result.vectorQueueMs, 0)),
    api_total_before_response: elapsedMs(requestStarted),
  };
  for (const item of items) mergeIngestTiming(item, routeTiming);
  console.info("[image-ingest] timing", {
    ...routeTiming,
    image_per_file: results.map((result) => imageTimingLogItem(result)),
  });
  const responseResults = results.map((result) => (
    result.success
      ? { fileName: result.fileName, success: true as const, item: result.item }
      : { fileName: result.fileName, success: false as const, error: result.error }
  ));
  return success({ mode: "image_batch", count: items.length, items, results: responseResults, uploaded_file_deleted: false });
}

function roundTiming(value: number): number {
  return Math.round(value * 100) / 100;
}

function ingestTimingSnapshot(item: IngestedAssetResponse): JsonObject {
  const timing = item.metadata.ingest_timing_ms;
  return typeof timing === "object" && timing !== null && !Array.isArray(timing)
    ? timing as JsonObject
    : {};
}

function mergeIngestTiming(item: IngestedAssetResponse, timing: JsonObject): void {
  item.metadata.ingest_timing_ms = { ...ingestTimingSnapshot(item), ...timing };
}

function timingNumber(timing: JsonObject, key: string): number | null {
  const value = timing[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function imageTimingLogItem(result: {
  fileName: string;
  success: boolean;
  durationMs: number;
  serviceDurationMs?: number;
  vectorQueueMs?: number;
  item?: IngestedAssetResponse;
  error?: string;
}): JsonObject {
  const serviceTiming = result.item ? ingestTimingSnapshot(result.item) : {};
  return {
    file_name: result.fileName,
    success: result.success,
    duration_ms: roundTiming(result.durationMs),
    service_duration_ms: result.serviceDurationMs === undefined ? null : roundTiming(result.serviceDurationMs),
    vector_queue_ms: result.vectorQueueMs === undefined ? null : roundTiming(result.vectorQueueMs),
    vision_image_prepare: timingNumber(serviceTiming, "vision_image_prepare"),
    vision_http: timingNumber(serviceTiming, "vision_http"),
    tos_upload: timingNumber(serviceTiming, "tos_upload"),
    pg_write: timingNumber(serviceTiming, "pg_write"),
    service_total_before_commit: timingNumber(serviceTiming, "service_total_before_commit"),
    error: result.error ?? null,
  };
}

function queueEntityVectorSync(db: Database, entityId: string, createVectorSync: () => Pick<VectorSyncService, "syncEntity">): void {
  setImmediate(() => {
    void (async () => {
      const repository = new AssetEntityRepository(db);
      const row = await repository.getById(entityId);
      if (!row) return;
      await createVectorSync().syncEntity(repository.toData(row));
    })().catch((error: unknown) => console.error("[asset-vector-sync] background task failed", error));
  });
}

export function toJsonAssetInput(input: z.infer<typeof jsonAssetSchema>): JsonAssetInput {
  return {
    assetKind: input.asset_kind,
    role: input.role,
    usageMode: input.usage_mode,
    name: input.name,
    displayName: input.display_name,
    intro: input.intro,
    appearance: input.appearance,
    ageValue: input.age_value,
    gender: input.gender,
    heightCm: input.height_cm,
    hairDescription: input.hair_description,
    outfitDescription: input.outfit_description,
    category: input.category,
    styleTags: input.style_tags,
    approved: input.approved,
    reuseScope: input.reuse_scope,
    status: input.status,
    sourceFileUrl: input.source_file_url,
    metadata: JSON.parse(JSON.stringify(input.metadata)) as JsonObject,
  };
}

type AssetControlInput = z.infer<typeof controlAssetInputSchema>;

function parseControlAssetInput(input: unknown): AssetControlInput {
  return parseRequest(controlAssetInputSchema, input);
}

function fieldText(value: { value?: unknown } | string | undefined): string | null {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  return typeof value?.value === "string" && value.value.trim() ? value.value.trim() : null;
}

function imageIngestErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return error instanceof Error ? error.message : "图片入库失败";
}

function parseBoundedInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestError(`数值必须是 ${min} 到 ${max} 之间的整数`);
  }
  return parsed;
}

function toSearchResponse(item: AssetSearchItem): Record<string, unknown> {
  return {
    score: item.score,
    lexical_hit: item.lexicalHit === true,
    semantic_hit: item.semanticHit === true,
    source_table: item.sourceTable,
    source_id: item.sourceId,
    asset_kind: item.assetKind ?? null,
    name: item.name ?? null,
    display_name: item.displayName ?? null,
    parent_entity_id: item.parentEntityId ?? null,
    parent_entity_name: item.parentEntityName ?? null,
    intro: item.intro ?? null,
    appearance: item.appearance ?? null,
    description: item.description ?? null,
    usage_context: item.usageContext ?? null,
    visual_prompt: item.visualPrompt ?? null,
    source_file_url: item.sourceFileUrl ?? null,
    metadata: item.metadata,
    vector_text: item.vectorText ?? null,
  };
}

function toLegacySemanticSearchResponse(item: AssetSearchItem): Record<string, unknown> {
  const { lexical_hit: _lexicalHit, semantic_hit: _semanticHit, ...response } = toSearchResponse(item);
  return response;
}

function toHybridSearchResponse(item: AssetSearchItem): Record<string, unknown> {
  return {
    ...toSearchResponse(item),
    scope: item.scope ?? null,
    status: item.status ?? null,
  };
}

function toVisualSearchResponse(item: VisualSearchItem): Record<string, unknown> {
  const { matchedMedia, ...base } = item;
  return {
    score: base.score,
    lexical_hit: base.lexicalHit === true,
    semantic_hit: base.semanticHit === true,
    source_table: base.sourceTable,
    source_id: base.sourceId,
    asset_kind: base.assetKind ?? null,
    name: base.name ?? null,
    display_name: base.displayName ?? null,
    parent_entity_id: base.parentEntityId ?? null,
    parent_entity_name: base.parentEntityName ?? null,
    intro: base.intro ?? null,
    appearance: base.appearance ?? null,
    description: base.description ?? null,
    usage_context: base.usageContext ?? null,
    visual_prompt: base.visualPrompt ?? null,
    source_file_url: base.sourceFileUrl ?? null,
    metadata: base.metadata,
    vector_text: base.vectorText ?? null,
    matched_media: matchedMedia
      ? { media_id: matchedMedia.mediaId, storage_url: matchedMedia.storageUrl, match_score: matchedMedia.matchScore }
      : null,
  };
}

function toAssetSourceProjectResponse(item: AssetSourceProjectListItem): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    code: item.code,
    description: item.description,
    project_type: item.projectType,
    metadata: item.metadata,
    asset_count: item.assetCount,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    latest_asset_at: item.latestAssetAt,
  };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
