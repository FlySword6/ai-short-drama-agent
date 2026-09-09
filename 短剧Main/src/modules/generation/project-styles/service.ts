import { BadRequestError } from "../../../shared/errors.js";
import { PROJECT_STYLE_CONTENT_MAX, PROJECT_STYLE_NAME_MAX } from "./types.js";
import type { ProjectStyle, ProjectStyleInput, ProjectStyleMediaKind } from "./types.js";
import type { ProjectStyleRepository } from "./repository.js";

export interface ProjectStyleStore {
  listForActor(
    actorId: string,
    projectId: string,
    mediaKind?: ProjectStyleMediaKind,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle[]>;
  createForActor(
    actorId: string,
    projectId: string,
    input: ProjectStyleInput,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle>;
  updateForActor(
    actorId: string,
    projectId: string,
    styleId: string,
    input: ProjectStyleInput,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle>;
  softDeleteForActor(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<void>;
  /** 设/换默认（可逆，D1 2026-08-17 修订）：事务内旧默认让位 + 置位 + 镜像写 projects.style* 列。 */
  setDefaultForActor(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle>;
  /** 取消默认（可逆）：置 is_default=false + 镜像清空，回「无默认」空态。 */
  unsetDefaultForActor(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle>;
}

/** 风格库是纯配置读写，不触发任何付费动作；上限与数据库 CHECK 一致。 */
export class ProjectStyleService {
  constructor(private readonly repository: ProjectStyleStore) {}

  async list(
    actorId: string,
    projectId: string,
    mediaKind?: ProjectStyleMediaKind,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle[]> {
    return this.repository.listForActor(actorId, projectId, mediaKind, authorizedProjectId);
  }

  async create(
    actorId: string,
    projectId: string,
    input: ProjectStyleInput,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle> {
    const normalized = normalizeStyleInput(input);
    return this.repository.createForActor(actorId, projectId, normalized, authorizedProjectId);
  }

  async update(
    actorId: string,
    projectId: string,
    styleId: string,
    input: ProjectStyleInput,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle> {
    const normalized = normalizeStyleInput(input);
    return this.repository.updateForActor(actorId, projectId, styleId, normalized, authorizedProjectId);
  }

  async softDelete(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<void> {
    return this.repository.softDeleteForActor(actorId, projectId, styleId, authorizedProjectId);
  }

  async setDefault(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle> {
    return this.repository.setDefaultForActor(actorId, projectId, styleId, authorizedProjectId);
  }

  async unsetDefault(
    actorId: string,
    projectId: string,
    styleId: string,
    authorizedProjectId?: string,
  ): Promise<ProjectStyle> {
    return this.repository.unsetDefaultForActor(actorId, projectId, styleId, authorizedProjectId);
  }
}

export function createProjectStyleService(repository: ProjectStyleRepository): ProjectStyleService {
  return new ProjectStyleService(repository);
}

function normalizeStyleInput(input: ProjectStyleInput): ProjectStyleInput {
  const name = input.name.trim();
  const content = input.content.trim();
  if (name.length < 1 || name.length > PROJECT_STYLE_NAME_MAX) {
    throw new BadRequestError(`风格名称需为 1-${PROJECT_STYLE_NAME_MAX} 个字符`);
  }
  if (content.length < 1 || content.length > PROJECT_STYLE_CONTENT_MAX) {
    throw new BadRequestError(`风格内容需为 1-${PROJECT_STYLE_CONTENT_MAX} 个字符`);
  }
  return { mediaKind: input.mediaKind, name, content };
}
