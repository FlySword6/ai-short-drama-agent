import { and, asc, count, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { NotFoundError } from "../../shared/errors.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  episodes,
  generationRequests,
  mediaResults,
  projectAssetRefs,
  projectMembers,
  projects,
  scenes,
  shots,
  shotAssetRefs,
  type EpisodeRow,
  type ProjectRow,
  type SceneRow,
  type ShotAssetRefRow,
  type ShotRow,
} from "../../db/schema.js";

export interface EpisodeAccess {
  episode: EpisodeRow;
  ownerUserId: string;
}

export interface SceneAccess {
  scene: SceneRow;
  projectId: string;
  ownerUserId: string;
}

export interface ShotAccess {
  shot: ShotRow;
  projectId: string;
  ownerUserId: string;
}

export class ProductionRepository {
  constructor(private readonly db: Database) {}

  async listProjects(actorUserId: string, includeAll = false): Promise<ProjectRow[]> {
    if (includeAll) {
      return this.db.select().from(projects)
        .where(isNull(projects.deletedAt))
        .orderBy(asc(projects.createdAt));
    }

    // `owner_user_id` remains a read fallback during the forward migration;
    // normal visibility comes from the actor's project_members row. The left
    // join is safe because (project_id, user_id) is a primary key.
    const rows = await this.db.select({ project: projects }).from(projects)
      .leftJoin(projectMembers, and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, actorUserId),
      ))
      .where(and(
        isNull(projects.deletedAt),
        or(eq(projects.ownerUserId, actorUserId), eq(projectMembers.userId, actorUserId)),
      ))
      .orderBy(asc(projects.createdAt));
    return rows.map((row) => row.project);
  }

  /** 看板四列分桶与卡面计数的数据源（R147）：按项目聚合「集数/项目资产数」，
      两次 GROUP BY,不回逐项目 N+1。软删行不计。 */
  async listProjectCounts(projectIds: readonly string[]): Promise<Map<string, { episodes: number; assets: number }>> {
    const map = new Map<string, { episodes: number; assets: number }>();
    if (projectIds.length === 0) return map;
    const ids = [...projectIds];
    const episodeRows = await this.db.select({ projectId: episodes.projectId, value: count() }).from(episodes)
      .where(and(inArray(episodes.projectId, ids), isNull(episodes.deletedAt)))
      .groupBy(episodes.projectId);
    const assetRows = await this.db.select({ projectId: projectAssetRefs.projectId, value: count() }).from(projectAssetRefs)
      .where(and(inArray(projectAssetRefs.projectId, ids), isNull(projectAssetRefs.deletedAt)))
      .groupBy(projectAssetRefs.projectId);
    for (const row of episodeRows) map.set(row.projectId, { episodes: row.value, assets: 0 });
    for (const row of assetRows) {
      const entry = map.get(row.projectId) ?? { episodes: 0, assets: 0 };
      entry.assets = row.value;
      map.set(row.projectId, entry);
    }
    return map;
  }

  async getProject(id: string): Promise<ProjectRow | undefined> {
    const rows = await this.db.select().from(projects)
      .where(and(eq(projects.id, id), isNull(projects.deletedAt))).limit(1);
    return rows[0];
  }

  async createProject(input: ProjectWriteInput & { ownerUserId: string; name: string }): Promise<ProjectRow> {
    const now = new Date();
    const rows = await this.db.insert(projects).values({
      id: crypto.randomUUID(),
      ownerUserId: input.ownerUserId,
      name: input.name,
      description: input.description ?? null,
      status: "active",
      ...projectGenerationConfigColumns(input),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    }).returning();
    return requiredRow(rows[0], "project");
  }

  async updateProject(id: string, input: ProjectWriteInput): Promise<ProjectRow> {
    const { generationConfig, ...projectFields } = input;
    const rows = await this.db.update(projects).set({
      ...projectFields,
      ...projectGenerationConfigColumns({ generationConfig }),
      updatedAt: new Date(),
    })
      .where(and(eq(projects.id, id), isNull(projects.deletedAt))).returning();
    return requiredRow(rows[0], "project");
  }

  async softDeleteProject(id: string, userId: string): Promise<void> {
    await this.db.update(projects).set({ deletedAt: new Date(), deletedByUserId: userId, updatedAt: new Date() })
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)));
  }

  listEpisodes(projectId: string): Promise<EpisodeRow[]> {
    return this.db.select().from(episodes)
      .where(and(eq(episodes.projectId, projectId), isNull(episodes.deletedAt)))
      .orderBy(asc(episodes.sortOrder), asc(episodes.episodeNo));
  }

  async getEpisode(id: string): Promise<EpisodeAccess | undefined> {
    const rows = await this.db.select({ episode: episodes, ownerUserId: projects.ownerUserId })
      .from(episodes)
      .innerJoin(projects, eq(episodes.projectId, projects.id))
      .where(and(eq(episodes.id, id), isNull(episodes.deletedAt), isNull(projects.deletedAt)))
      .limit(1);
    return rows[0];
  }

  async createEpisode(input: {
    projectId: string;
    episodeNo: number;
    name?: string | null;
    sortOrder: number;
  }): Promise<EpisodeRow> {
    const now = new Date();
    const rows = await this.db.insert(episodes).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      episodeNo: input.episodeNo,
      name: input.name ?? null,
      sortOrder: input.sortOrder,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    }).returning();
    return requiredRow(rows[0], "episode");
  }

  async updateEpisode(id: string, input: {
    episodeNo?: number;
    name?: string | null;
    synopsis?: string | null;
    sortOrder?: number;
    status?: string;
  }): Promise<EpisodeRow> {
    const rows = await this.db.update(episodes).set({ ...input, updatedAt: new Date() })
      .where(and(eq(episodes.id, id), isNull(episodes.deletedAt))).returning();
    return requiredRow(rows[0], "episode");
  }

  async softDeleteEpisode(id: string, userId: string): Promise<void> {
    await this.db.update(episodes).set({ deletedAt: new Date(), deletedByUserId: userId, updatedAt: new Date() })
      .where(and(eq(episodes.id, id), isNull(episodes.deletedAt)));
  }

  listScenes(episodeId: string): Promise<SceneRow[]> {
    return this.db.select().from(scenes)
      .where(and(eq(scenes.episodeId, episodeId), isNull(scenes.deletedAt)))
      .orderBy(asc(scenes.sortOrder), asc(scenes.sceneNo));
  }

  async getScene(id: string): Promise<SceneAccess | undefined> {
    const rows = await this.db.select({
      scene: scenes,
      projectId: episodes.projectId,
      ownerUserId: projects.ownerUserId,
    }).from(scenes)
      .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
      .innerJoin(projects, eq(episodes.projectId, projects.id))
      .where(and(
        eq(scenes.id, id),
        isNull(scenes.deletedAt),
        isNull(episodes.deletedAt),
        isNull(projects.deletedAt),
      ))
      .limit(1);
    return rows[0];
  }

  async createScene(input: {
    episodeId: string;
    sceneNo: number;
    name?: string | null;
    description?: string | null;
    sortOrder: number;
  }): Promise<SceneRow> {
    const now = new Date();
    const rows = await this.db.insert(scenes).values({
      id: crypto.randomUUID(),
      episodeId: input.episodeId,
      sceneNo: input.sceneNo,
      name: input.name ?? null,
      description: input.description ?? null,
      sortOrder: input.sortOrder,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    }).returning();
    return requiredRow(rows[0], "scene");
  }

  async updateScene(id: string, input: {
    sceneNo?: number;
    name?: string | null;
    description?: string | null;
    sortOrder?: number;
  }): Promise<SceneRow> {
    const rows = await this.db.update(scenes).set({ ...input, updatedAt: new Date() })
      .where(and(eq(scenes.id, id), isNull(scenes.deletedAt))).returning();
    return requiredRow(rows[0], "scene");
  }

  async softDeleteScene(id: string, userId: string): Promise<void> {
    await this.db.update(scenes).set({ deletedAt: new Date(), deletedByUserId: userId, updatedAt: new Date() })
      .where(and(eq(scenes.id, id), isNull(scenes.deletedAt)));
  }

  listShots(episodeId: string): Promise<ShotRow[]> {
    return this.db.select().from(shots)
      .where(and(eq(shots.episodeId, episodeId), isNull(shots.deletedAt)))
      .orderBy(asc(shots.sortOrder), asc(shots.shotCode));
  }

  /**
   * 把 reference_asset_snapshots 里的 (asset_entity_id, variant_id) 解析为可展示的
   * 主图 URL。纯读投影,不写库。候选 = 上传图(asset_media image 未软删)+ 生成图兜底
   * (media_results image,target null 归第一变体,与版本轨同口径)。
   * 排序:变体精确匹配优先,其次上传主图(is_primary),再次上传优先于生成,最后任意其余图。
   * key = `${assetEntityId}::${variantId ?? "asset"}`,避免 (entity,null) 与
   * (entity,"asset" 字面量) 撞键。快照缺 asset_entity_id 的行跳过。
   */
  async resolveSnapshotImages(
    snapshots: readonly Record<string, unknown>[],
  ): Promise<Map<string, string>> {
    const pairs = new Map<string, { assetEntityId: string; variantId: string | null }>();
    for (const snap of snapshots) {
      const entityId = typeof snap.asset_entity_id === "string" ? snap.asset_entity_id : null;
      if (!entityId) continue;
      const variantId = typeof snap.variant_id === "string" ? snap.variant_id : null;
      pairs.set(`${entityId}::${variantId ?? "asset"}`, { assetEntityId: entityId, variantId });
    }
    if (pairs.size === 0) return new Map();
    const entityIds = [...new Set([...pairs.values()].map((pair) => pair.assetEntityId))];
    const rows = await this.db.select({
      assetEntityId: assetMedia.assetEntityId,
      assetVariantId: assetMedia.assetVariantId,
      storageUrl: assetMedia.storageUrl,
      isPrimary: assetMedia.isPrimary,
    }).from(assetMedia).where(and(
      inArray(assetMedia.assetEntityId, entityIds),
      eq(assetMedia.mediaKind, "image"),
      isNull(assetMedia.deletedAt),
    ));
    /* 生成图兜底:与版本轨同口径(target null 归第一变体)。 */
    const firstVariantByEntity = new Map<string, string>();
    const variantRows = await this.db.select({
      id: assetVariants.id,
      assetEntityId: assetVariants.assetEntityId,
    }).from(assetVariants).where(and(
      inArray(assetVariants.assetEntityId, entityIds),
      isNull(assetVariants.deletedAt),
    )).orderBy(asc(assetVariants.sortOrder));
    for (const row of variantRows) if (!firstVariantByEntity.has(row.assetEntityId)) firstVariantByEntity.set(row.assetEntityId, row.id);
    const aiRows = await this.db.select({
      assetEntityId: generationRequests.targetAssetEntityId,
      targetVariantId: generationRequests.targetAssetVariantId,
      storageUrl: mediaResults.storageUrl,
    }).from(mediaResults)
      .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
      .where(and(
        inArray(generationRequests.targetAssetEntityId, entityIds),
        eq(mediaResults.mediaKind, "image"),
        isNull(mediaResults.deletedAt),
      ));
    type Candidate = { assetEntityId: string | null; assetVariantId: string | null; storageUrl: string | null; isPrimary: boolean; uploaded: boolean };
    const candidates: Candidate[] = [
      ...rows.map((row) => ({ ...row, uploaded: true })),
      ...aiRows.map((row) => ({
        assetEntityId: row.assetEntityId,
        assetVariantId: row.targetVariantId ?? (row.assetEntityId ? firstVariantByEntity.get(row.assetEntityId) ?? null : null),
        storageUrl: row.storageUrl,
        isPrimary: false,
        uploaded: false,
      })),
    ];
    const images = new Map<string, string>();
    for (const [key, pair] of pairs) {
      const [winner] = candidates
        .filter((row) => row.assetEntityId === pair.assetEntityId)
        .sort((left, right) => {
          const leftExact = pair.variantId !== null && left.assetVariantId === pair.variantId;
          const rightExact = pair.variantId !== null && right.assetVariantId === pair.variantId;
          if (leftExact !== rightExact) return leftExact ? -1 : 1;
          if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
          if (left.uploaded !== right.uploaded) return left.uploaded ? -1 : 1;
          return 0;
        });
      if (winner?.storageUrl) images.set(key, winner.storageUrl);
    }
    return images;
  }

  /**
   * 把 reference_asset_snapshots 里的 variant_id 解析为变体展示名(asset_variants.name)。
   * 纯读投影,不写库;与 resolveSnapshotImages 同链路。已选资产行据此显示「变体 · 名称」,
   * 区分同资产的多条引用(资产级 + 变体级、或多个变体),避免展示成"两个一样的资产"。
   * key = variant_id;软删变体、缺 variant_id 的快照跳过。
   */
  async resolveSnapshotVariantNames(
    snapshots: readonly Record<string, unknown>[],
  ): Promise<Map<string, string>> {
    const variantIds = [...new Set(
      snapshots
        .map((snap) => (typeof snap.variant_id === "string" ? snap.variant_id : null))
        .filter((id): id is string => id !== null),
    )];
    if (variantIds.length === 0) return new Map();
    const rows = await this.db.select({
      id: assetVariants.id,
      name: assetVariants.name,
    }).from(assetVariants).where(and(
      inArray(assetVariants.id, variantIds),
      isNull(assetVariants.deletedAt),
    ));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async getShot(id: string): Promise<ShotAccess | undefined> {
    const rows = await this.db.select({
      shot: shots,
      projectId: episodes.projectId,
      ownerUserId: projects.ownerUserId,
    }).from(shots)
      .innerJoin(episodes, eq(shots.episodeId, episodes.id))
      .innerJoin(projects, eq(episodes.projectId, projects.id))
      .where(and(
        eq(shots.id, id),
        isNull(shots.deletedAt),
        isNull(episodes.deletedAt),
        isNull(projects.deletedAt),
      ))
      .limit(1);
    return rows[0];
  }

  async createShot(input: {
    episodeId: string;
    sceneId?: string | null;
    shotCode: string;
    title?: string | null;
    scriptText?: string | null;
    breakdownElements?: ShotRow["breakdownElements"];
    directorPrompt?: string | null;
    imagePrompt?: string | null;
    videoPrompt?: string | null;
    durationSeconds?: number | null;
    sortOrder: number;
  }): Promise<ShotRow> {
    const now = new Date();
    const rows = await this.db.insert(shots).values({
      id: crypto.randomUUID(),
      episodeId: input.episodeId,
      sceneId: input.sceneId ?? null,
      shotCode: input.shotCode,
      title: input.title ?? null,
      scriptText: input.scriptText ?? null,
      breakdownElements: input.breakdownElements ?? null,
      directorPrompt: input.directorPrompt ?? null,
      imagePrompt: input.imagePrompt ?? null,
      videoPrompt: input.videoPrompt ?? null,
      durationSeconds: input.durationSeconds ?? null,
      sortOrder: input.sortOrder,
      referenceAssetSnapshots: [],
      selectedImageResultId: null,
      selectedVideoResultId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    }).returning();
    return requiredRow(rows[0], "shot");
  }

  async updateShot(id: string, input: {
    sceneId?: string | null;
    shotCode?: string;
    title?: string | null;
    scriptText?: string | null;
    breakdownElements?: ShotRow["breakdownElements"];
    directorPrompt?: string | null;
    imagePrompt?: string | null;
    videoPrompt?: string | null;
    durationSeconds?: number | null;
    sortOrder?: number;
    metadata?: ShotRow["metadata"];
  }): Promise<ShotRow> {
    const rows = await this.db.update(shots).set({ ...input, updatedAt: new Date() })
      .where(and(eq(shots.id, id), isNull(shots.deletedAt))).returning();
    return requiredRow(rows[0], "shot");
  }

  async softDeleteShot(id: string, userId: string): Promise<void> {
    await this.db.update(shots).set({ deletedAt: new Date(), deletedByUserId: userId, updatedAt: new Date() })
      .where(and(eq(shots.id, id), isNull(shots.deletedAt)));
  }

  /** 分镜-资产引用(v1.4,迁移 065):可编辑引用真值,只回活动行。
      缩略图取 ref 锁定的媒体,未锁媒体时兜底实体主媒体。 */
  async listShotAssetRefs(shotId: string): Promise<ShotAssetRefView[]> {
    const rows = await this.db.select({
      ref: shotAssetRefs,
      entity: assetEntities,
      variant: assetVariants,
      media: assetMedia,
    }).from(shotAssetRefs)
      .innerJoin(assetEntities, eq(shotAssetRefs.assetEntityId, assetEntities.id))
      .leftJoin(assetVariants, and(
        eq(shotAssetRefs.assetVariantId, assetVariants.id),
        isNull(assetVariants.deletedAt),
      ))
      .leftJoin(assetMedia, and(
        eq(shotAssetRefs.assetMediaId, assetMedia.id),
        isNull(assetMedia.deletedAt),
      ))
      .where(and(
        eq(shotAssetRefs.shotId, shotId),
        isNull(shotAssetRefs.deletedAt),
        isNull(assetEntities.deletedAt),
      ))
      .orderBy(asc(shotAssetRefs.sortOrder), asc(shotAssetRefs.createdAt));

    const entityIds = [...new Set(rows.map((row) => row.entity.id))];
    const primaryMediaRows = entityIds.length === 0 ? [] : await this.db.select({
      entityId: assetMedia.assetEntityId,
      storageUrl: assetMedia.storageUrl,
    }).from(assetMedia)
      .where(and(
        inArray(assetMedia.assetEntityId, entityIds),
        eq(assetMedia.isPrimary, true),
        isNull(assetMedia.deletedAt),
      ))
      .orderBy(asc(assetMedia.sortOrder));
    const primaryThumbByEntity = new Map(
      primaryMediaRows.map((row) => [row.entityId, row.storageUrl] as const),
    );
    return rows.map((row) => toShotAssetRefView(row, primaryThumbByEntity.get(row.entity.id) ?? null));
  }

  /** 校验资产实体属于该分镜所属项目,并锁定/返回其变体与媒体;不符合任一即抛 NotFound。 */
  async requireShotProjectAsset(
    projectId: string,
    assetEntityId: string,
    assetVariantId?: string | null,
    assetMediaId?: string | null,
  ): Promise<void> {
    const entities = await this.db.select({ id: assetEntities.id }).from(assetEntities)
      .where(and(
        eq(assetEntities.id, assetEntityId),
        eq(assetEntities.sourceProjectId, projectId),
        isNull(assetEntities.deletedAt),
      )).limit(1);
    if (!entities[0]) throw new NotFoundError("项目资产不存在或不属于当前项目");
    if (assetVariantId) {
      const variants = await this.db.select({ id: assetVariants.id }).from(assetVariants)
        .where(and(
          eq(assetVariants.id, assetVariantId),
          eq(assetVariants.assetEntityId, assetEntityId),
          isNull(assetVariants.deletedAt),
        )).limit(1);
      if (!variants[0]) throw new NotFoundError("资产变体不存在或不属于该资产");
    }
    if (assetMediaId) {
      const medias = await this.db.select({ id: assetMedia.id }).from(assetMedia)
        .where(and(
          eq(assetMedia.id, assetMediaId),
          eq(assetMedia.assetEntityId, assetEntityId),
          isNull(assetMedia.deletedAt),
        )).limit(1);
      if (!medias[0]) throw new NotFoundError("资产媒体不存在或不属于该资产");
    }
  }

  async createShotAssetRef(input: {
    shotId: string;
    assetEntityId: string;
    assetVariantId?: string | null;
    assetMediaId?: string | null;
    usageMode?: string | null;
    enabled?: boolean;
    sortOrder: number;
  }): Promise<ShotAssetRefRow> {
    const now = new Date();
    const rows = await this.db.insert(shotAssetRefs).values({
      id: crypto.randomUUID(),
      shotId: input.shotId,
      assetEntityId: input.assetEntityId,
      assetVariantId: input.assetVariantId ?? null,
      assetMediaId: input.assetMediaId ?? null,
      usageMode: input.usageMode ?? null,
      enabled: input.enabled ?? true,
      sortOrder: input.sortOrder,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    }).returning();
    return requiredRow(rows[0], "shot_asset_ref");
  }

  async updateShotAssetRef(id: string, input: {
    assetVariantId?: string | null;
    assetMediaId?: string | null;
    usageMode?: string | null;
    enabled?: boolean;
    sortOrder?: number;
  }): Promise<ShotAssetRefRow> {
    const rows = await this.db.update(shotAssetRefs).set({ ...input, updatedAt: new Date() })
      .where(and(eq(shotAssetRefs.id, id), isNull(shotAssetRefs.deletedAt))).returning();
    return requiredRow(rows[0], "shot_asset_ref");
  }

  async softDeleteShotAssetRef(id: string, userId: string): Promise<void> {
    await this.db.update(shotAssetRefs).set({ deletedAt: new Date(), deletedByUserId: userId, updatedAt: new Date() })
      .where(and(eq(shotAssetRefs.id, id), isNull(shotAssetRefs.deletedAt)));
  }

  async getShotAssetRef(id: string): Promise<ShotAssetRefRow | undefined> {
    const rows = await this.db.select().from(shotAssetRefs)
      .where(and(eq(shotAssetRefs.id, id), isNull(shotAssetRefs.deletedAt))).limit(1);
    return rows[0];
  }
}

export interface ProjectGenerationConfigInput {
  defaultRatio?: string;
  defaultImageResolution?: string;
  defaultVideoResolution?: string;
  imageStyleDescription?: string | null;
  videoStyleDescription?: string | null;
  imageStyleReferenceMediaIds?: string[];
  videoStyleReferenceMediaIds?: string[];
  imagePromptTemplate?: string | null;
  videoPromptTemplate?: string | null;
}

export interface ProjectWriteInput {
  name?: string;
  description?: string | null;
  status?: string;
  generationConfig?: ProjectGenerationConfigInput;
}

function projectGenerationConfigColumns(input: Pick<ProjectWriteInput, "generationConfig">) {
  const config = input.generationConfig;
  if (!config) return {};
  return {
    ...(config.defaultRatio !== undefined ? { defaultRatio: config.defaultRatio } : {}),
    ...(config.defaultImageResolution !== undefined ? { defaultImageResolution: config.defaultImageResolution } : {}),
    ...(config.defaultVideoResolution !== undefined ? { defaultVideoResolution: config.defaultVideoResolution } : {}),
    ...(config.imageStyleDescription !== undefined ? { imageStyleDescription: config.imageStyleDescription } : {}),
    ...(config.videoStyleDescription !== undefined ? { videoStyleDescription: config.videoStyleDescription } : {}),
    ...(config.imageStyleReferenceMediaIds !== undefined ? { imageStyleReferenceMediaIds: config.imageStyleReferenceMediaIds } : {}),
    ...(config.videoStyleReferenceMediaIds !== undefined ? { videoStyleReferenceMediaIds: config.videoStyleReferenceMediaIds } : {}),
    ...(config.imagePromptTemplate !== undefined ? { imagePromptTemplate: config.imagePromptTemplate } : {}),
    ...(config.videoPromptTemplate !== undefined ? { videoPromptTemplate: config.videoPromptTemplate } : {}),
  };
}

function requiredRow<T>(row: T | undefined, name: string): T {
  if (!row) throw new Error(`Failed to write ${name}`);
  return row;
}

/** 分镜-资产引用详情视图(含水合出的资产展示信息),供 production 详情与列表响应。 */
export interface ShotAssetRefView {
  id: string;
  shot_id: string;
  asset_entity_id: string;
  asset_variant_id: string | null;
  asset_media_id: string | null;
  usage_mode: string | null;
  enabled: boolean;
  sort_order: number;
  asset_name: string;
  asset_display_name: string | null;
  asset_role: string | null;
  asset_kind: string;
  variant_name: string | null;
  media_title: string | null;
  thumb_url: string | null;
  created_at: string;
  updated_at: string;
}

function toShotAssetRefView(
  row: {
    ref: typeof shotAssetRefs.$inferSelect;
    entity: typeof assetEntities.$inferSelect;
    variant: typeof assetVariants.$inferSelect | null;
    media: typeof assetMedia.$inferSelect | null;
  },
  entityPrimaryThumbUrl: string | null,
): ShotAssetRefView {
  const { ref, entity, variant, media } = row;
  return {
    id: ref.id,
    shot_id: ref.shotId,
    asset_entity_id: ref.assetEntityId,
    asset_variant_id: ref.assetVariantId,
    asset_media_id: ref.assetMediaId,
    usage_mode: ref.usageMode,
    enabled: ref.enabled,
    sort_order: ref.sortOrder,
    asset_name: entity.name,
    asset_display_name: entity.displayName,
    asset_role: entity.role,
    asset_kind: entity.assetKind,
    variant_name: variant?.name ?? null,
    media_title: media?.title ?? null,
    thumb_url: media?.storageUrl ?? entityPrimaryThumbUrl,
    created_at: ref.createdAt.toISOString(),
    updated_at: ref.updatedAt.toISOString(),
  };
}
