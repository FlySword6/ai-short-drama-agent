import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { ProjectStyleRepository } from "../generation/project-styles/repository.js";
import { OperationsService } from "../operations/service.js";
import { REVIEW_STRATEGIES } from "../operations/types.js";
import { operationsActorFromRequest } from "../operations/routes.js";
import { ProductionService, type ShotWriteInput } from "./service.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id });
const episodeParams = z.object({ episode_id: id });
const sceneParams = z.object({ scene_id: id });
const shotParams = z.object({ shot_id: id });
const nullableText = z.string().trim().max(10_000).nullable().optional();
const generationConfigText = z.string().trim().max(10_000).nullable().optional();
const styleReferenceMediaIds = z.array(id).max(20).optional();
const generationConfigSchema = z.object({
  default_ratio: z.enum(["9:16", "16:9", "1:1"]).optional(),
  default_image_resolution: z.string().trim().min(1).max(64).optional(),
  default_video_resolution: z.string().trim().min(1).max(64).optional(),
  image: z.object({
    style_description: generationConfigText,
    style_reference_media_ids: styleReferenceMediaIds,
    prompt_template: generationConfigText,
  }).strict().optional(),
  video: z.object({
    style_description: generationConfigText,
    style_reference_media_ids: styleReferenceMediaIds,
    prompt_template: generationConfigText,
  }).strict().optional(),
}).strict();
const shotBreakdownElements = z.object({
  subject: z.string().trim().min(1).max(240).nullable(),
  action: z.string().trim().min(1).max(240).nullable(),
  visual: z.string().trim().min(1).max(240).nullable(),
  camera_language: z.string().trim().min(1).max(240).nullable(),
}).strict();

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: nullableText,
  generation_config: generationConfigSchema.optional(),
});
const reviewPolicyPatchSchema = z.object({
  default_strategy: z.enum(REVIEW_STRATEGIES).optional(),
  reviewer_user_id: id.nullable().optional(),
}).strict().refine(hasAnyProperty, "审核策略至少提供一个要修改的字段");

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: nullableText,
  status: z.enum(["active", "archived"]).optional(),
  genre: z.string().trim().min(1).max(32).nullable().optional(),
  generation_config: generationConfigSchema.optional(),
  review_policies: z.object({
    image: reviewPolicyPatchSchema.optional(),
    video: reviewPolicyPatchSchema.optional(),
  }).strict().optional(),
}).refine(hasAnyProperty, "至少提供一个要修改的字段");

const createEpisodeSchema = z.object({
  episode_no: z.coerce.number().int().positive(),
  name: z.string().trim().max(255).nullable().optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
});
const updateEpisodeSchema = createEpisodeSchema.partial().extend({
  synopsis: nullableText,
  status: z.enum(["active", "archived"]).optional(),
}).refine(hasAnyProperty, "至少提供一个要修改的字段");

const createSceneSchema = z.object({
  scene_no: z.coerce.number().int().positive(),
  name: z.string().trim().max(255).nullable().optional(),
  description: nullableText,
  sort_order: z.coerce.number().int().min(0).optional(),
});
const updateSceneSchema = createSceneSchema.partial().refine(hasAnyProperty, "至少提供一个要修改的字段");

const createShotSchema = z.object({
  shot_no: z.string().trim().min(1).max(64),
  scene_id: id.nullable().optional(),
  title: z.string().trim().max(255).nullable().optional(),
  script_text: nullableText,
  breakdown_elements: shotBreakdownElements.nullable().optional(),
  director_prompt: nullableText,
  image_prompt: nullableText,
  video_prompt: nullableText,
  duration_seconds: z.coerce.number().int().positive().nullable().optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
});
const updateShotSchema = createShotSchema.partial().extend({
  // v1.4 长尾字段(迁移 065):只放开 `lite.shot` 命名空间,合并式 PATCH
  // (service.mergeShotMetadata 只覆盖出现的键,保留其它命名空间)。
  metadata: z.object({
    lite: z.object({
      shot: z.object({
        atmosphere: z.string().trim().max(2_000).nullable().optional(),
        dialogue_note: z.string().trim().max(2_000).nullable().optional(),
        dialogue: z.object({
          lines: z.array(z.object({
            speaker: z.string().trim().min(1).max(255),
            text: z.string().trim().min(1).max(5_000),
            asset_entity_id: id.nullable().optional(),
          }).strict()).max(100),
        }).strict().nullable().optional(),
        prompt_locked: z.boolean().nullable().optional(),
      }).strict().refine(hasAnyProperty, "至少提供一个要修改的字段"),
    }).strict(),
  }).strict().optional(),
}).refine(hasAnyProperty, "至少提供一个要修改的字段");

const shotAssetRefCreateSchema = z.object({
  asset_entity_id: id,
  asset_variant_id: id.nullable().optional(),
  asset_media_id: id.nullable().optional(),
  usage_mode: z.enum(["reference", "first_frame", "last_frame"]).nullable().optional(),
  enabled: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
}).strict();
const shotAssetRefUpdateSchema = shotAssetRefCreateSchema
  .omit({ asset_entity_id: true })
  .refine(hasAnyProperty, "至少提供一个要修改的字段");
const shotAssetRefParams = z.object({ shot_id: id, ref_id: id });

export async function registerProductionRoutes(app: FastifyInstance, getDatabase: () => Database): Promise<void> {
  const service = () => new ProductionService(getDatabase());

  app.get("/api/v1/projects", async (request) => {
    const items = await service().listProjects(requireCurrentUser(request));
    return success({ items, count: items.length });
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const input = parseRequest(createProjectSchema, request.body);
    const data = await service().createProject(requireCurrentUser(request), projectInput(input));
    return created(reply, data);
  });

  app.get("/api/v1/projects/:project_id", async (request) => {
    const params = parseRequest(projectParams, request.params);
    return success(await service().getProject(requireCurrentUser(request), params.project_id));
  });

  app.patch("/api/v1/projects/:project_id", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(updateProjectSchema, request.body);
    const actor = requireCurrentUser(request);
    const productionPatch = compact({
      name: input.name,
      description: input.description,
      status: input.status,
      generationConfig: input.generation_config && generationConfigInput(input.generation_config),
    });
    const hasProductionPatch = Object.keys(productionPatch).length > 0;
    const hasOperationsPatch = input.genre !== undefined || input.review_policies !== undefined;

    // D2（docs/design/prd-v2/lite-config-tabs-and-style.md §4.7，2026-08-17 修订二定稿＝同步）：
    // 完整版 generation_config 直写 projects.style* 列后，将该媒介 Lite 默认风格行与列对齐
    // （非空 → 行内容跟随；空/超长 → 行取消默认），保持「默认行 = 镜像 = 生成注入」一致。
    // 初版「存在 Lite 默认即 409」守卫随锁定口径作废（否则完整版侧「风格随时可改」被卡死）。
    const styleSyncKinds = styleDescriptionKinds(input.generation_config);

    // Existing clients keep receiving the project-shaped response. The new
    // operations fields use the same endpoint, but their authorization and
    // audit path stay entirely inside OperationsService.
    const project = hasProductionPatch
      ? await service().updateProject(actor, params.project_id, productionPatch)
      : await service().getProject(actor, params.project_id);
    if (styleSyncKinds.length > 0) {
      await new ProjectStyleRepository(getDatabase()).alignDefaultRowsWithMirror(params.project_id, styleSyncKinds);
    }
    if (!hasOperationsPatch) return success(project);

    const operations = await OperationsService.fromDatabase(getDatabase()).patchProjectOperations(
      operationsActorFromRequest(request, true),
      params.project_id,
      {
        genre: input.genre,
        reviewPolicies: input.review_policies && {
          ...(input.review_policies.image ? {
            image: {
              defaultStrategy: input.review_policies.image.default_strategy,
              reviewerUserId: input.review_policies.image.reviewer_user_id,
            },
          } : {}),
          ...(input.review_policies.video ? {
            video: {
              defaultStrategy: input.review_policies.video.default_strategy,
              reviewerUserId: input.review_policies.video.reviewer_user_id,
            },
          } : {}),
        },
      },
    );
    return success({
      ...project,
      genre: operations.genre,
      review_policies: Object.fromEntries(operations.reviewPolicies.map((policy) => [policy.mediaKind, {
        default_strategy: policy.defaultStrategy,
        reviewer_user_id: policy.reviewerUserId,
      }])),
    });
  });

  app.delete("/api/v1/projects/:project_id", async (request) => {
    const params = parseRequest(projectParams, request.params);
    await service().deleteProject(requireCurrentUser(request), params.project_id);
    return success({ deleted: true });
  });

  app.get("/api/v1/projects/:project_id/episodes", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const items = await service().listEpisodes(requireCurrentUser(request), params.project_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/projects/:project_id/episodes", async (request, reply) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(createEpisodeSchema, request.body);
    return created(reply, await service().createEpisode(requireCurrentUser(request), params.project_id, {
      episodeNo: input.episode_no,
      name: input.name,
      sortOrder: input.sort_order,
    }));
  });

  app.get("/api/v1/episodes/:episode_id", async (request) => {
    const params = parseRequest(episodeParams, request.params);
    return success(await service().getEpisode(requireCurrentUser(request), params.episode_id));
  });

  app.patch("/api/v1/episodes/:episode_id", async (request) => {
    const params = parseRequest(episodeParams, request.params);
    const input = parseRequest(updateEpisodeSchema, request.body);
    return success(await service().updateEpisode(requireCurrentUser(request), params.episode_id, compact({
      episodeNo: input.episode_no,
      name: input.name,
      synopsis: input.synopsis,
      sortOrder: input.sort_order,
      status: input.status,
    })));
  });

  app.delete("/api/v1/episodes/:episode_id", async (request) => {
    const params = parseRequest(episodeParams, request.params);
    await service().deleteEpisode(requireCurrentUser(request), params.episode_id);
    return success({ deleted: true });
  });

  app.get("/api/v1/episodes/:episode_id/scenes", async (request) => {
    const params = parseRequest(episodeParams, request.params);
    const items = await service().listScenes(requireCurrentUser(request), params.episode_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/episodes/:episode_id/scenes", async (request, reply) => {
    const params = parseRequest(episodeParams, request.params);
    const input = parseRequest(createSceneSchema, request.body);
    return created(reply, await service().createScene(requireCurrentUser(request), params.episode_id, {
      sceneNo: input.scene_no,
      name: input.name,
      description: input.description,
      sortOrder: input.sort_order,
    }));
  });

  app.patch("/api/v1/scenes/:scene_id", async (request) => {
    const params = parseRequest(sceneParams, request.params);
    const input = parseRequest(updateSceneSchema, request.body);
    return success(await service().updateScene(requireCurrentUser(request), params.scene_id, compact({
      sceneNo: input.scene_no,
      name: input.name,
      description: input.description,
      sortOrder: input.sort_order,
    })));
  });

  app.delete("/api/v1/scenes/:scene_id", async (request) => {
    const params = parseRequest(sceneParams, request.params);
    await service().deleteScene(requireCurrentUser(request), params.scene_id);
    return success({ deleted: true });
  });

  app.get("/api/v1/episodes/:episode_id/shots", async (request) => {
    const params = parseRequest(episodeParams, request.params);
    const items = await service().listShots(requireCurrentUser(request), params.episode_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/episodes/:episode_id/shots", async (request, reply) => {
    const params = parseRequest(episodeParams, request.params);
    const input = parseRequest(createShotSchema, request.body);
    return created(reply, await service().createShot(requireCurrentUser(request), params.episode_id, shotInput(input)));
  });

  app.get("/api/v1/shots/:shot_id", async (request) => {
    const params = parseRequest(shotParams, request.params);
    return success(await service().getShot(requireCurrentUser(request), params.shot_id));
  });

  app.patch("/api/v1/shots/:shot_id", async (request) => {
    const params = parseRequest(shotParams, request.params);
    const input = parseRequest(updateShotSchema, request.body);
    return success(await service().updateShot(requireCurrentUser(request), params.shot_id, shotInput(input)));
  });

  app.delete("/api/v1/shots/:shot_id", async (request) => {
    const params = parseRequest(shotParams, request.params);
    await service().deleteShot(requireCurrentUser(request), params.shot_id);
    return success({ deleted: true });
  });

  // 分镜-资产引用(v1.4,迁移 065):当前集分镜详情页的引用清单 CRUD。
  app.get("/api/v1/shots/:shot_id/asset-refs", async (request) => {
    const params = parseRequest(shotParams, request.params);
    const items = await service().listShotAssetRefs(requireCurrentUser(request), params.shot_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/shots/:shot_id/asset-refs", async (request, reply) => {
    const params = parseRequest(shotParams, request.params);
    const input = parseRequest(shotAssetRefCreateSchema, request.body);
    return created(reply, await service().createShotAssetRef(requireCurrentUser(request), params.shot_id, {
      assetEntityId: input.asset_entity_id,
      assetVariantId: input.asset_variant_id ?? null,
      assetMediaId: input.asset_media_id ?? null,
      usageMode: input.usage_mode ?? null,
      enabled: input.enabled,
      sortOrder: input.sort_order,
    }));
  });

  app.patch("/api/v1/shots/:shot_id/asset-refs/:ref_id", async (request) => {
    const params = parseRequest(shotAssetRefParams, request.params);
    const input = parseRequest(shotAssetRefUpdateSchema, request.body);
    return success(await service().updateShotAssetRef(requireCurrentUser(request), params.shot_id, params.ref_id, {
      assetVariantId: input.asset_variant_id,
      assetMediaId: input.asset_media_id,
      usageMode: input.usage_mode,
      enabled: input.enabled,
      sortOrder: input.sort_order,
    }));
  });

  app.delete("/api/v1/shots/:shot_id/asset-refs/:ref_id", async (request) => {
    const params = parseRequest(shotAssetRefParams, request.params);
    await service().deleteShotAssetRef(requireCurrentUser(request), params.shot_id, params.ref_id);
    return success({ deleted: true });
  });
}

function projectInput(input: z.infer<typeof createProjectSchema>) {
  return compact({
    name: input.name,
    description: input.description,
    generationConfig: input.generation_config && generationConfigInput(input.generation_config),
  });
}

function generationConfigInput(input: z.infer<typeof generationConfigSchema>) {
  return compact({
    defaultRatio: input.default_ratio,
    defaultImageResolution: input.default_image_resolution,
    defaultVideoResolution: input.default_video_resolution,
    imageStyleDescription: input.image?.style_description,
    videoStyleDescription: input.video?.style_description,
    imageStyleReferenceMediaIds: input.image?.style_reference_media_ids,
    videoStyleReferenceMediaIds: input.video?.style_reference_media_ids,
    imagePromptTemplate: input.image?.prompt_template,
    videoPromptTemplate: input.video?.prompt_template,
  });
}

function shotInput(input: z.infer<typeof createShotSchema>): ShotWriteInput;
function shotInput(input: z.infer<typeof updateShotSchema>): Partial<ShotWriteInput>;
function shotInput(input: z.infer<typeof createShotSchema> | z.infer<typeof updateShotSchema>): Partial<ShotWriteInput> {
  return compact({
    shotCode: input.shot_no,
    sceneId: input.scene_id,
    title: input.title,
    scriptText: input.script_text,
    breakdownElements: input.breakdown_elements,
    directorPrompt: input.director_prompt,
    imagePrompt: input.image_prompt,
    videoPrompt: input.video_prompt,
    durationSeconds: input.duration_seconds,
    sortOrder: input.sort_order,
    // updateShotSchema 独有字段;createShotSchema 分支无此键,直接置 undefined(compact 过滤)。
    metadata: "metadata" in input ? input.metadata : undefined,
  });
}

function created(reply: FastifyReply, data: unknown) {
  return reply.code(201).send(success(data));
}

function hasAnyProperty(value: object): boolean {
  return Object.keys(value).length > 0;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/**
 * D2（同步口径）：generation_config 里写了 style_description 的媒介（含显式 null 清空）。
 * 这些媒介在写列后需要把 Lite 默认风格行与镜像列对齐（见 handler 内 alignDefaultRowsWithMirror）。
 */
function styleDescriptionKinds(config: z.infer<typeof generationConfigSchema> | undefined): ("image" | "video")[] {
  if (!config) return [];
  const kinds: ("image" | "video")[] = [];
  if (config.image?.style_description !== undefined) kinds.push("image");
  if (config.video?.style_description !== undefined) kinds.push("video");
  return kinds;
}
