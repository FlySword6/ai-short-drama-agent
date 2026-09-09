import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { EpisodeRow, ProjectRow, SceneRow, ShotRow } from "../../db/schema.js";
import { ConflictError, ForbiddenError, isPostgresUniqueViolation, NotFoundError } from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import { platformRoleOrMember } from "../auth/types.js";
import {
  DEFAULT_IMAGE_PROMPT_TEMPLATE,
  DEFAULT_VIDEO_PROMPT_TEMPLATE,
  validateProjectPromptTemplate,
} from "../generation/promptCompiler.js";
import {
  EffectiveShotMediaRepository,
  type EffectiveShotMediaStore,
} from "../shot-media/effectiveSelectionRepository.js";
import type { EffectiveShotMedia } from "../shot-media/effectiveSelection.js";
import {
  ProductionRepository,
  type ProjectGenerationConfigInput,
  type ProjectWriteInput,
} from "./repository.js";

export { DEFAULT_IMAGE_PROMPT_TEMPLATE, DEFAULT_VIDEO_PROMPT_TEMPLATE };

/** Existing service callers may continue passing a user id; HTTP routes pass the full actor to preserve its platform role. */
export type ProductionActor = string | ProjectAccessActor;

export interface ProductionServiceDependencies {
  access?: ProjectAccessService;
  allowMemberCreateProject?: boolean;
  effectiveShotMedia?: EffectiveShotMediaStore;
}

export class ProductionService {
  private readonly repository: ProductionRepository;
  private readonly access: ProjectAccessService;
  private readonly allowMemberCreateProject: boolean;
  private readonly effectiveShotMedia: EffectiveShotMediaStore;

  constructor(
    db: Database,
    repository = new ProductionRepository(db),
    dependencies: ProductionServiceDependencies = {},
  ) {
    this.repository = repository;
    this.access = dependencies.access ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(db));
    this.allowMemberCreateProject = dependencies.allowMemberCreateProject ?? settings.allowMemberCreateProject;
    this.effectiveShotMedia = dependencies.effectiveShotMedia ?? new EffectiveShotMediaRepository(db);
  }

  async listProjects(actorInput: ProductionActor) {
    const actor = toActor(actorInput);
    const includeAll = actor.role === "admin" || actor.role === "operator";
    const rows = await this.repository.listProjects(actor.id, includeAll);
    // R147：补出看板分桶/卡面要用的 episode_count/asset_count(原 Sol 缺口,加性字段不破坏旧消费方)。
    const counts = await this.repository.listProjectCounts(rows.map((row) => row.id));
    return rows.map((row) => ({
      ...toProject(row),
      episode_count: counts.get(row.id)?.episodes ?? 0,
      asset_count: counts.get(row.id)?.assets ?? 0,
    }));
  }

  async getProject(actorInput: ProductionActor, projectId: string) {
    return toProject(await this.requireProject(actorInput, projectId, "read"));
  }

  async createProject(actorInput: ProductionActor, input: ProjectWriteInput & { name: string }) {
    const actor = toActor(actorInput);
    this.assertProjectCreationAllowed(actor);
    if (input.generationConfig) validateStyleReferenceDescriptions(input.generationConfig);
    return this.withConflict("同名项目已经存在", async () => toProject(await this.repository.createProject({
      ownerUserId: actor.id,
      name: input.name.trim(),
      description: input.description,
      generationConfig: input.generationConfig,
    })));
  }

  async updateProject(
    actorInput: ProductionActor,
    projectId: string,
    input: ProjectWriteInput,
  ) {
    // Archiving remains owner-only. Generation configuration is a creative setting.
    const project = await this.requireProject(
      actorInput,
      projectId,
      input.status === undefined ? "create" : "manage_members",
    );
    const generationConfig = input.generationConfig === undefined
      ? undefined
      : mergeGenerationConfig(project, input.generationConfig);
    return this.withConflict("同名项目已经存在", async () => toProject(await this.repository.updateProject(projectId, {
      ...input,
      generationConfig,
      ...(input.name ? { name: input.name.trim() } : {}),
    })));
  }

  async deleteProject(actorInput: ProductionActor, projectId: string): Promise<void> {
    const actor = toActor(actorInput);
    await this.requireProject(actor, projectId, "delete");
    await this.repository.softDeleteProject(projectId, actor.id);
  }

  async listEpisodes(actorInput: ProductionActor, projectId: string) {
    await this.requireProject(actorInput, projectId, "read");
    return Promise.all((await this.repository.listEpisodes(projectId)).map(toEpisode));
  }

  async getEpisode(actorInput: ProductionActor, episodeId: string) {
    return toEpisode((await this.requireEpisode(actorInput, episodeId, "read")).episode);
  }

  async createEpisode(actorInput: ProductionActor, projectId: string, input: { episodeNo: number; name?: string | null; sortOrder?: number }) {
    await this.requireProject(actorInput, projectId, "create");
    return this.withConflict("这一集已经存在", async () => toEpisode(await this.repository.createEpisode({
      projectId,
      episodeNo: input.episodeNo,
      name: input.name,
      sortOrder: input.sortOrder ?? input.episodeNo,
    })));
  }

  async updateEpisode(actorInput: ProductionActor, episodeId: string, input: { episodeNo?: number; name?: string | null; synopsis?: string | null; sortOrder?: number; status?: string }) {
    await this.requireEpisode(actorInput, episodeId, "create");
    return this.withConflict("这一集已经存在", async () => toEpisode(await this.repository.updateEpisode(episodeId, input)));
  }

  async deleteEpisode(actorInput: ProductionActor, episodeId: string): Promise<void> {
    const actor = toActor(actorInput);
    await this.requireEpisode(actor, episodeId, "create");
    await this.repository.softDeleteEpisode(episodeId, actor.id);
  }

  async listScenes(actorInput: ProductionActor, episodeId: string) {
    await this.requireEpisode(actorInput, episodeId, "read");
    return Promise.all((await this.repository.listScenes(episodeId)).map(toScene));
  }

  async createScene(actorInput: ProductionActor, episodeId: string, input: { sceneNo: number; name?: string | null; description?: string | null; sortOrder?: number }) {
    await this.requireEpisode(actorInput, episodeId, "create");
    return this.withConflict("这一场已经存在", async () => toScene(await this.repository.createScene({
      episodeId,
      sceneNo: input.sceneNo,
      name: input.name,
      description: input.description,
      sortOrder: input.sortOrder ?? input.sceneNo,
    })));
  }

  async updateScene(actorInput: ProductionActor, sceneId: string, input: { sceneNo?: number; name?: string | null; description?: string | null; sortOrder?: number }) {
    await this.requireScene(actorInput, sceneId, "create");
    return this.withConflict("这一场已经存在", async () => toScene(await this.repository.updateScene(sceneId, input)));
  }

  async deleteScene(actorInput: ProductionActor, sceneId: string): Promise<void> {
    const actor = toActor(actorInput);
    await this.requireScene(actor, sceneId, "create");
    await this.repository.softDeleteScene(sceneId, actor.id);
  }

  async listShots(actorInput: ProductionActor, episodeId: string) {
    const access = await this.requireEpisode(actorInput, episodeId, "read");
    const rows = await this.repository.listShots(episodeId);
    const [effective, snapshotImages] = await Promise.all([
      this.effectiveShotMedia.resolve(access.episode.projectId, rows),
      this.snapshotImagesForRows(rows),
    ]);
    return rows.map((row) => toShot(row, effective.get(row.id), snapshotImages));
  }

  async getShot(actorInput: ProductionActor, shotId: string) {
    const access = await this.requireShot(actorInput, shotId, "read");
    const [effective, snapshotImages, variantNames] = await Promise.all([
      this.effectiveShotMedia.resolve(access.projectId, [access.shot]),
      this.repository.resolveSnapshotImages(access.shot.referenceAssetSnapshots),
      this.repository.resolveSnapshotVariantNames(access.shot.referenceAssetSnapshots),
    ]);
    return toShot(access.shot, effective.get(access.shot.id), snapshotImages, variantNames);
  }

  /** 汇总一批分镜的 reference_asset_snapshots,一次解析全部缩略图 URL。 */
  private snapshotImagesForRows(rows: readonly ShotRow[]): Promise<Map<string, string>> {
    const snapshots = rows.flatMap((row) => row.referenceAssetSnapshots);
    return this.repository.resolveSnapshotImages(snapshots);
  }

  async createShot(actorInput: ProductionActor, episodeId: string, input: ShotWriteInput) {
    await this.requireEpisode(actorInput, episodeId, "create");
    if (input.sceneId) await this.requireSceneInEpisode(actorInput, input.sceneId, episodeId, "create");
    return this.withConflict("这个镜号已经存在", async () => toShot(await this.repository.createShot({
      episodeId,
      ...input,
      shotCode: input.shotCode.trim(),
      sortOrder: input.sortOrder ?? 0,
    })));
  }

  async updateShot(actorInput: ProductionActor, shotId: string, input: Partial<ShotWriteInput>) {
    const access = await this.requireShot(actorInput, shotId, "create");
    if (input.sceneId) await this.requireSceneInEpisode(actorInput, input.sceneId, access.shot.episodeId, "create");
    const { metadata, ...rest } = input;
    return this.withConflict("这个镜号已经存在", async () => toShot(await this.repository.updateShot(shotId, {
      ...rest,
      ...(input.shotCode ? { shotCode: input.shotCode.trim() } : {}),
      // 合并式 PATCH:只覆盖 PATCH 里出现的 `metadata.lite.shot` 键,保留其他命名空间
      // (v1.4 长尾字段;`metadata` 由路由层的 shotLiteMetadataSchema 约束形状)。
      ...(metadata !== undefined ? { metadata: mergeShotMetadata(access.shot.metadata, metadata) } : {}),
    })));
  }

  async listShotAssetRefs(actorInput: ProductionActor, shotId: string) {
    await this.requireShot(actorInput, shotId, "read");
    return this.repository.listShotAssetRefs(shotId);
  }

  async createShotAssetRef(actorInput: ProductionActor, shotId: string, input: {
    assetEntityId: string;
    assetVariantId?: string | null;
    assetMediaId?: string | null;
    usageMode?: string | null;
    enabled?: boolean;
    sortOrder?: number;
  }) {
    const access = await this.requireShot(actorInput, shotId, "create");
    await this.repository.requireShotProjectAsset(
      access.projectId,
      input.assetEntityId,
      input.assetVariantId,
      input.assetMediaId,
    );
    return this.repository.createShotAssetRef({
      shotId,
      assetEntityId: input.assetEntityId,
      assetVariantId: input.assetVariantId,
      assetMediaId: input.assetMediaId,
      usageMode: input.usageMode,
      enabled: input.enabled,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  async updateShotAssetRef(actorInput: ProductionActor, shotId: string, refId: string, input: {
    assetVariantId?: string | null;
    assetMediaId?: string | null;
    usageMode?: string | null;
    enabled?: boolean;
    sortOrder?: number;
  }) {
    const access = await this.requireShot(actorInput, shotId, "create");
    const ref = await this.repository.getShotAssetRef(refId);
    if (!ref || ref.shotId !== shotId) throw new NotFoundError("分镜资产引用不存在");
    // 换变体/换媒体时校验指向仍属于该资产实体与本项目;不改实体则跳过。
    if (input.assetVariantId !== undefined || input.assetMediaId !== undefined) {
      await this.repository.requireShotProjectAsset(
        access.projectId,
        ref.assetEntityId,
        input.assetVariantId !== undefined ? input.assetVariantId : ref.assetVariantId,
        input.assetMediaId !== undefined ? input.assetMediaId : ref.assetMediaId,
      );
    }
    return this.repository.updateShotAssetRef(refId, {
      ...(input.assetVariantId !== undefined ? { assetVariantId: input.assetVariantId } : {}),
      ...(input.assetMediaId !== undefined ? { assetMediaId: input.assetMediaId } : {}),
      ...(input.usageMode !== undefined ? { usageMode: input.usageMode } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    });
  }

  async deleteShotAssetRef(actorInput: ProductionActor, shotId: string, refId: string): Promise<void> {
    const actor = toActor(actorInput);
    await this.requireShot(actorInput, shotId, "create");
    const ref = await this.repository.getShotAssetRef(refId);
    if (!ref || ref.shotId !== shotId) throw new NotFoundError("分镜资产引用不存在");
    await this.repository.softDeleteShotAssetRef(refId, actor.id);
  }

  async deleteShot(actorInput: ProductionActor, shotId: string): Promise<void> {
    const actor = toActor(actorInput);
    await this.requireShot(actor, shotId, "create");
    await this.repository.softDeleteShot(shotId, actor.id);
  }

  private async requireProject(
    actorInput: ProductionActor,
    projectId: string,
    action: ProjectAccessAction,
  ): Promise<ProjectRow> {
    const actor = toActor(actorInput);
    const project = await this.repository.getProject(projectId);
    if (!project) throw hiddenProjectNotFound();
    await this.access.require(actor, projectId, action);
    return project;
  }

  private async requireEpisode(actorInput: ProductionActor, episodeId: string, action: ProjectAccessAction) {
    const actor = toActor(actorInput);
    const access = await this.repository.getEpisode(episodeId);
    if (!access) throw hiddenProjectNotFound();
    await this.access.require(actor, access.episode.projectId, action);
    return access;
  }

  private async requireScene(actorInput: ProductionActor, sceneId: string, action: ProjectAccessAction) {
    const actor = toActor(actorInput);
    const access = await this.repository.getScene(sceneId);
    if (!access) throw hiddenProjectNotFound();
    await this.access.require(actor, access.projectId, action);
    return access;
  }

  private async requireShot(actorInput: ProductionActor, shotId: string, action: ProjectAccessAction) {
    const actor = toActor(actorInput);
    const access = await this.repository.getShot(shotId);
    if (!access) throw hiddenProjectNotFound();
    await this.access.require(actor, access.projectId, action);
    return access;
  }

  private async requireSceneInEpisode(
    actorInput: ProductionActor,
    sceneId: string,
    episodeId: string,
    action: ProjectAccessAction,
  ): Promise<void> {
    const access = await this.requireScene(actorInput, sceneId, action);
    if (access.scene.episodeId !== episodeId) throw new ConflictError("场和分镜不属于同一集", "scene_episode_mismatch");
  }

  private assertProjectCreationAllowed(actor: ProjectAccessActor): void {
    if (actor.role === "admin") return;
    if (actor.role === "operator") {
      throw new ForbiddenError("运营账号只能查看和导出，不能创建项目");
    }
    if (!this.allowMemberCreateProject) {
      throw new ForbiddenError("当前账号未获创建项目权限，请联系管理员");
    }
  }

  private async withConflict<T>(message: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError(message, "duplicate_resource");
      throw error;
    }
  }
}

function toActor(input: ProductionActor): ProjectAccessActor & { role: "admin" | "operator" | "member" } {
  if (typeof input === "string") return { id: input, role: "member" };
  return { id: input.id, role: platformRoleOrMember(input.role) };
}

function hiddenProjectNotFound(): NotFoundError {
  return new NotFoundError("项目不存在或你没有访问权限");
}

export interface ShotWriteInput {
  sceneId?: string | null;
  shotCode: string;
  title?: string | null;
  scriptText?: string | null;
  breakdownElements?: ShotRow["breakdownElements"];
  directorPrompt?: string | null;
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  durationSeconds?: number | null;
  sortOrder?: number;
  /** v1.4 长尾字段(065),见 {@link ShotMetadata}。HTTP 层只放开 `lite.shot` 命名空间。 */
  metadata?: ShotRow["metadata"] | null;
}

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    owner_user_id: row.ownerUserId,
    team_id: row.teamId,
    genre: row.genre,
    name: row.name,
    description: row.description,
    status: row.status,
    generation_config: {
      default_ratio: row.defaultRatio,
      default_image_resolution: row.defaultImageResolution,
      default_video_resolution: row.defaultVideoResolution,
      image: projectGenerationMedium(row.imageStyleDescription, row.imageStyleReferenceMediaIds, row.imagePromptTemplate, DEFAULT_IMAGE_PROMPT_TEMPLATE),
      video: projectGenerationMedium(row.videoStyleDescription, row.videoStyleReferenceMediaIds, row.videoPromptTemplate, DEFAULT_VIDEO_PROMPT_TEMPLATE),
    },
    /** Lite 容器集指针（060 迁移起）：非空即 Lite 项目，列表/详情同一出口透出。 */
    lite_episode_id: row.liteEpisodeId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function projectGenerationMedium(
  styleDescription: string | null,
  styleReferenceMediaIds: string[],
  promptTemplate: string | null,
  defaultPromptTemplate: string,
) {
  return {
    style_description: styleDescription,
    style_reference_media_ids: styleReferenceMediaIds,
    prompt_template: promptTemplate ?? defaultPromptTemplate,
    prompt_template_source: promptTemplate === null ? "platform_default" : "project",
  };
}

function mergeGenerationConfig(project: ProjectRow, patch: ProjectGenerationConfigInput): ProjectGenerationConfigInput {
  const merged = {
    defaultRatio: patch.defaultRatio !== undefined ? patch.defaultRatio : project.defaultRatio,
    defaultImageResolution: patch.defaultImageResolution !== undefined ? patch.defaultImageResolution : project.defaultImageResolution,
    defaultVideoResolution: patch.defaultVideoResolution !== undefined ? patch.defaultVideoResolution : project.defaultVideoResolution,
    imageStyleDescription: patch.imageStyleDescription !== undefined ? patch.imageStyleDescription : project.imageStyleDescription,
    videoStyleDescription: patch.videoStyleDescription !== undefined ? patch.videoStyleDescription : project.videoStyleDescription,
    imageStyleReferenceMediaIds: patch.imageStyleReferenceMediaIds !== undefined ? patch.imageStyleReferenceMediaIds : project.imageStyleReferenceMediaIds,
    videoStyleReferenceMediaIds: patch.videoStyleReferenceMediaIds !== undefined ? patch.videoStyleReferenceMediaIds : project.videoStyleReferenceMediaIds,
    imagePromptTemplate: patch.imagePromptTemplate !== undefined ? patch.imagePromptTemplate : project.imagePromptTemplate,
    videoPromptTemplate: patch.videoPromptTemplate !== undefined ? patch.videoPromptTemplate : project.videoPromptTemplate,
  };
  validateStyleReferenceDescriptions(merged);
  return merged;
}

function validateStyleReferenceDescriptions(config: ProjectGenerationConfigInput): void {
  if (config.imageStyleReferenceMediaIds && config.imageStyleReferenceMediaIds.length > 0 && !config.imageStyleDescription?.trim()) {
    throw new ConflictError("图片风格参考图需要图片风格描述", "image_style_description_required");
  }
  if (config.videoStyleReferenceMediaIds && config.videoStyleReferenceMediaIds.length > 0 && !config.videoStyleDescription?.trim()) {
    throw new ConflictError("视频风格参考图需要视频风格描述", "video_style_description_required");
  }
  for (const template of [config.imagePromptTemplate, config.videoPromptTemplate]) {
    if (!template) continue;
    try {
      validateProjectPromptTemplate(template);
    } catch {
      throw new ConflictError(
        "提示词模板占位符不正确，请检查后重试",
        "invalid_project_prompt_template",
      );
    }
  }
}

function toEpisode(row: EpisodeRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    episode_no: row.episodeNo,
    name: row.name,
    synopsis: row.synopsis,
    sort_order: row.sortOrder,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toScene(row: SceneRow) {
  return {
    id: row.id,
    episode_id: row.episodeId,
    scene_no: row.sceneNo,
    name: row.name,
    description: row.description,
    sort_order: row.sortOrder,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toShot(
  row: ShotRow,
  effective?: EffectiveShotMedia,
  snapshotImages?: Map<string, string>,
  variantNames?: Map<string, string>,
) {
  const image = effective?.image ?? (
    row.selectedImageResultId ? { id: row.selectedImageResultId, source: "manual" as const } : null
  );
  const video = effective?.video ?? (
    row.selectedVideoResultId ? { id: row.selectedVideoResultId, source: "manual" as const } : null
  );
  // 快照只存 (asset_entity_id, variant_id),展示用的主图 URL 与变体名由读路径注入,避免
  // 每次写关联都重写 shots 行、也保证全量旧快照(未含 image_url)都能显示缩略图。
  const reference_asset_snapshots = row.referenceAssetSnapshots.map((snap) => {
    const entityId = typeof snap.asset_entity_id === "string" ? snap.asset_entity_id : null;
    if (!entityId) return snap;
    const variantId = typeof snap.variant_id === "string" ? snap.variant_id : null;
    let out = snap;
    if (snapshotImages) {
      const imageUrl = snapshotImages.get(`${entityId}::${variantId ?? "asset"}`);
      if (imageUrl) out = { ...out, image_url: imageUrl };
    }
    if (variantNames && variantId) {
      const variantName = variantNames.get(variantId);
      if (variantName) out = { ...out, variant_name: variantName };
    }
    return out;
  });
  return {
    id: row.id,
    episode_id: row.episodeId,
    scene_id: row.sceneId,
    shot_no: row.shotCode,
    title: row.title,
    script_text: row.scriptText,
    breakdown_elements: row.breakdownElements,
    director_prompt: row.directorPrompt,
    image_prompt: row.imagePrompt,
    video_prompt: row.videoPrompt,
    storyboard_detail: row.storyboardDetail ?? null,
    duration_seconds: row.durationSeconds,
    sort_order: row.sortOrder,
    reference_asset_snapshots,
    metadata: row.metadata,
    selected_image_result_id: image?.id ?? null,
    selected_video_result_id: video?.id ?? null,
    image_selection_source: image?.source ?? null,
    video_selection_source: video?.source ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** 合并式 PATCH(v1.4,迁移 065):只覆盖请求里出现的 `lite.shot` 键,
    保留 `shots.metadata` 里其它命名空间(如未来版本化/合规字段)。 */
function mergeShotMetadata(
  current: ShotRow["metadata"],
  patch: ShotRow["metadata"] | null,
): ShotRow["metadata"] {
  const base: NonNullable<ShotRow["metadata"]> = current ?? {};
  const incoming: NonNullable<ShotRow["metadata"]> = patch ?? {};
  const lite = base.lite ?? {};
  const shot = lite.shot ?? {};
  const shotPatch = incoming.lite?.shot ?? {};
  return {
    ...base,
    lite: {
      ...lite,
      shot: {
        ...shot,
        ...(shotPatch.atmosphere !== undefined ? { atmosphere: shotPatch.atmosphere } : {}),
        ...(shotPatch.dialogue_note !== undefined ? { dialogue_note: shotPatch.dialogue_note } : {}),
        ...(shotPatch.dialogue !== undefined ? { dialogue: shotPatch.dialogue } : {}),
        ...(shotPatch.prompt_locked !== undefined ? { prompt_locked: shotPatch.prompt_locked } : {}),
      },
    },
  };
}
