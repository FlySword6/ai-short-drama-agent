import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetVariants,
  castingTasks,
  episodes,
  referenceLaneVocabulary,
  scenes,
  shots,
  users,
  type CastingTaskRow,
} from "../../db/schema.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import type {
  CastingTask,
  CastingTaskStore,
  CreateCastingTaskInput,
  ListCastingTasksFilter,
  UpdateCastingTaskInput,
} from "./types.js";

export class CastingTaskRepository implements CastingTaskStore {
  private readonly access: ProjectAccessService;

  constructor(private readonly db: Database) {
    this.access = ProjectAccessService.fromDatabase(new ProjectAccessRepository(db));
  }

  async create(
    actor: ProjectAccessActor,
    projectId: string,
    input: CreateCastingTaskInput,
  ): Promise<CastingTask> {
    await this.requireAccess(actor, projectId, "create");
    await this.assertLaneKnown(input.lane);
    if (input.sceneId) await this.assertSceneInProject(projectId, input.sceneId);
    if (input.shotId) await this.assertShotInProject(projectId, input.shotId, input.sceneId);
    await this.assertTargetAsset(input.targetAssetEntityId, input.targetAssetVariantId);
    if (input.assigneeUserId) await this.assertUserExists(input.assigneeUserId);
    const now = new Date();
    const row: CastingTaskRow = {
      id: randomUUID(),
      projectId,
      sceneId: input.sceneId ?? null,
      shotId: input.shotId ?? null,
      lane: input.lane,
      targetAssetEntityId: input.targetAssetEntityId ?? null,
      targetAssetVariantId: input.targetAssetVariantId ?? null,
      title: input.title,
      brief: input.brief ?? null,
      createdByUserId: actor.id,
      assigneeUserId: input.assigneeUserId ?? null,
      status: "open",
      referenceTestId: null,
      deliveredAssetMediaId: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(castingTasks).values(row);
    return toCastingTask(row);
  }

  async list(
    actor: ProjectAccessActor,
    projectId: string,
    filter: ListCastingTasksFilter,
  ): Promise<CastingTask[]> {
    await this.requireAccess(actor, projectId, "read");
    const conditions = [eq(castingTasks.projectId, projectId)];
    if (filter.status !== undefined) conditions.push(eq(castingTasks.status, filter.status));
    if (filter.assigneeUserId !== undefined) {
      conditions.push(eq(castingTasks.assigneeUserId, filter.assigneeUserId));
    }
    if (filter.shotId !== undefined) conditions.push(eq(castingTasks.shotId, filter.shotId));
    const rows = await this.db.select().from(castingTasks)
      .where(and(...conditions))
      .orderBy(desc(castingTasks.createdAt), desc(castingTasks.id));
    return rows.map(toCastingTask);
  }

  async get(actor: ProjectAccessActor, id: string): Promise<CastingTask> {
    const row = await this.findTask(id);
    await this.requireAccess(actor, row.projectId, "read");
    return toCastingTask(row);
  }

  async update(
    actor: ProjectAccessActor,
    id: string,
    input: UpdateCastingTaskInput,
  ): Promise<CastingTask> {
    const row = await this.findTask(id);
    await this.requireAccess(actor, row.projectId, "create");
    if (input.assigneeUserId) await this.assertUserExists(input.assigneeUserId);
    const updates: Partial<CastingTaskRow> = { updatedAt: new Date() };
    if (input.title !== undefined) updates.title = input.title;
    if (input.brief !== undefined) updates.brief = input.brief;
    if (input.assigneeUserId !== undefined) updates.assigneeUserId = input.assigneeUserId;
    const updated = await this.db.update(castingTasks)
      .set(updates)
      .where(eq(castingTasks.id, id))
      .returning();
    const result = updated[0];
    if (!result) throw new NotFoundError("抽卡任务不存在");
    return toCastingTask(result);
  }

  /**
   * 鉴权全部落在既有项目能力矩阵上，不新增谓词。与 operations 的 404 隐藏口径不同，
   * 抽卡任务按本卡约定把「非成员/项目不存在」统一答成 403——读单的人要么有成员
   * 身份，要么连项目是否存在都不必知道，但状态码语义保持「没有权限」。
   */
  private async requireAccess(
    actor: ProjectAccessActor,
    projectId: string,
    action: ProjectAccessAction,
  ): Promise<void> {
    try {
      await this.access.require(actor, projectId, action);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ForbiddenError("项目不存在或你没有访问权限");
      }
      throw error;
    }
  }

  private async findTask(id: string): Promise<CastingTaskRow> {
    const rows = await this.db.select().from(castingTasks)
      .where(eq(castingTasks.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("抽卡任务不存在");
    return row;
  }

  /**
   * Lanes come from the reference_lane_vocabulary registry (migration 020). Follow
   * the control-packages convention: unknown/inactive lanes are a human 422, not a
   * raw 23503.
   */
  private async assertLaneKnown(lane: string): Promise<void> {
    const rows = await this.db.select({
      id: referenceLaneVocabulary.id,
      active: referenceLaneVocabulary.active,
    }).from(referenceLaneVocabulary)
      .where(eq(referenceLaneVocabulary.id, lane))
      .limit(1);
    const entry = rows[0];
    if (!entry) throw new UnprocessableEntityError("这个参考栏暂不可用，请换一个再试");
    if (!entry.active) throw new UnprocessableEntityError("这个参考栏已停用，请换一个再试");
  }

  private async assertSceneInProject(projectId: string, sceneId: string): Promise<void> {
    const rows = await this.db.select({ id: scenes.id })
      .from(scenes)
      .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
      .where(and(
        eq(scenes.id, sceneId),
        eq(episodes.projectId, projectId),
        isNull(scenes.deletedAt),
        isNull(episodes.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) throw new BadRequestError("场景不存在或不属于当前项目");
  }

  /**
   * 镜头必须属于当前项目。场只有在开单时明确指定了才比对——`shots.scene_id` 可空,
   * 无场镜头照样能开单（docs/agents/domain.md 已把这条记为数据事实）。
   */
  private async assertShotInProject(
    projectId: string,
    shotId: string,
    sceneId: string | undefined,
  ): Promise<void> {
    const rows = await this.db.select({ sceneId: shots.sceneId })
      .from(shots)
      .innerJoin(episodes, eq(shots.episodeId, episodes.id))
      .where(and(
        eq(shots.id, shotId),
        eq(episodes.projectId, projectId),
        isNull(shots.deletedAt),
        isNull(episodes.deletedAt),
      ))
      .limit(1);
    const shot = rows[0];
    if (!shot) throw new BadRequestError("镜头不存在或不属于当前项目");
    if (sceneId && shot.sceneId !== sceneId) throw new BadRequestError("镜头不属于指定的场");
  }

  private async assertTargetAsset(
    assetEntityId: string | undefined,
    assetVariantId: string | undefined,
  ): Promise<void> {
    if (assetVariantId && !assetEntityId) {
      throw new BadRequestError("给资产补变体时必须同时指定目标资产");
    }
    if (assetEntityId) {
      const rows = await this.db.select({ id: assetEntities.id })
        .from(assetEntities)
        .where(and(eq(assetEntities.id, assetEntityId), isNull(assetEntities.deletedAt)))
        .limit(1);
      if (!rows[0]) throw new BadRequestError("目标资产不存在");
    }
    if (assetVariantId) {
      const rows = await this.db.select({ assetEntityId: assetVariants.assetEntityId })
        .from(assetVariants)
        .where(and(eq(assetVariants.id, assetVariantId), isNull(assetVariants.deletedAt)))
        .limit(1);
      const variant = rows[0];
      if (!variant || variant.assetEntityId !== assetEntityId) {
        throw new BadRequestError("目标资产变体不属于指定资产");
      }
    }
  }

  /**
   * 承接人就是一个普通用户 ID：不查成员身份、不看角色，只把用户是否存在这件事
   * 从 FK 的 23503 翻成一句人话。「谁是抽卡师」等于「谁被派了抽卡任务」,
   * 系统里不需要第三处定义。
   */
  private async assertUserExists(userId: string): Promise<void> {
    const rows = await this.db.select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!rows[0]) throw new BadRequestError("指定的承接人不存在");
  }
}

function toCastingTask(row: CastingTaskRow): CastingTask {
  return {
    id: row.id,
    projectId: row.projectId,
    sceneId: row.sceneId,
    shotId: row.shotId,
    lane: row.lane,
    targetAssetEntityId: row.targetAssetEntityId,
    targetAssetVariantId: row.targetAssetVariantId,
    title: row.title,
    brief: row.brief,
    createdByUserId: row.createdByUserId,
    assigneeUserId: row.assigneeUserId,
    status: row.status as CastingTask["status"],
    referenceTestId: row.referenceTestId,
    deliveredAssetMediaId: row.deliveredAssetMediaId,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
