import type { ProjectAccessActor } from "../project-access/types.js";

/**
 * 抽卡任务：一件缺失参考的工单——这一镜（或这一场）缺哪件资产、要什么样子、
 * 派给谁去做（main#292「表与读」段）。本卡只产生 open；领单/交单/验收的状态
 * 转换属于下一张卡。
 */
export type CastingTaskStatus = "open";

export interface CastingTask {
  id: string;
  projectId: string;
  sceneId: string | null;
  shotId: string | null;
  lane: string;
  targetAssetEntityId: string | null;
  targetAssetVariantId: string | null;
  title: string;
  brief: string | null;
  createdByUserId: string;
  assigneeUserId: string | null;
  status: CastingTaskStatus;
  referenceTestId: string | null;
  deliveredAssetMediaId: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 场级单只填 sceneId；镜级单 sceneId + shotId 都填；两个都不填是纯补图单
 * （只认 targetAssetEntityId）。shots.scene_id 本来就可空,所以镜级单不强制带场。
 */
export interface CreateCastingTaskInput {
  sceneId?: string;
  shotId?: string;
  lane: string;
  targetAssetEntityId?: string;
  targetAssetVariantId?: string;
  title: string;
  brief?: string;
  assigneeUserId?: string;
}

export interface ListCastingTasksFilter {
  status?: string;
  assigneeUserId?: string;
  shotId?: string;
}

/**
 * 本卡只允许改要求说明与派单对象。assigneeUserId 传 null 表示改回待认领；
 * 字段缺省表示不动。
 */
export interface UpdateCastingTaskInput {
  title?: string;
  brief?: string | null;
  assigneeUserId?: string | null;
}

export interface CastingTaskStore {
  create(
    actor: ProjectAccessActor,
    projectId: string,
    input: CreateCastingTaskInput,
  ): Promise<CastingTask>;
  list(
    actor: ProjectAccessActor,
    projectId: string,
    filter: ListCastingTasksFilter,
  ): Promise<CastingTask[]>;
  get(actor: ProjectAccessActor, id: string): Promise<CastingTask>;
  update(
    actor: ProjectAccessActor,
    id: string,
    input: UpdateCastingTaskInput,
  ): Promise<CastingTask>;
}
