import { BadRequestError } from "../../../shared/errors.js";
import { PROMPT_TEMPLATE_CONTENT_MAX, PROMPT_TEMPLATE_NAME_MAX } from "./types.js";
import type { PromptTemplate, PromptTemplateInput, PromptTemplateMediaKind } from "./types.js";
import type { PromptTemplateRepository } from "./repository.js";

export interface PromptTemplateStore {
  listForActor(
    actorId: string,
    projectId: string,
    mediaKind?: PromptTemplateMediaKind,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate[]>;
  getForActor(
    actorId: string,
    projectId: string,
    templateId: string,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate>;
  createForActor(
    actorId: string,
    projectId: string,
    input: PromptTemplateInput,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate>;
  updateForActor(
    actorId: string,
    projectId: string,
    templateId: string,
    input: PromptTemplateInput,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate>;
  softDeleteForActor(
    actorId: string,
    projectId: string,
    templateId: string,
    authorizedProjectId?: string,
  ): Promise<void>;
}

/** 模板库是纯配置读写，不触发任何付费动作；上限与数据库 CHECK 一致。 */
export class PromptTemplateService {
  constructor(private readonly repository: PromptTemplateStore) {}

  async list(
    actorId: string,
    projectId: string,
    mediaKind?: PromptTemplateMediaKind,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate[]> {
    return this.repository.listForActor(actorId, projectId, mediaKind, authorizedProjectId);
  }

  async get(
    actorId: string,
    projectId: string,
    templateId: string,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate> {
    return this.repository.getForActor(actorId, projectId, templateId, authorizedProjectId);
  }

  async create(
    actorId: string,
    projectId: string,
    input: PromptTemplateInput,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate> {
    const normalized = normalizeTemplateInput(input);
    return this.repository.createForActor(actorId, projectId, normalized, authorizedProjectId);
  }

  async update(
    actorId: string,
    projectId: string,
    templateId: string,
    input: PromptTemplateInput,
    authorizedProjectId?: string,
  ): Promise<PromptTemplate> {
    const normalized = normalizeTemplateInput(input);
    return this.repository.updateForActor(actorId, projectId, templateId, normalized, authorizedProjectId);
  }

  async softDelete(
    actorId: string,
    projectId: string,
    templateId: string,
    authorizedProjectId?: string,
  ): Promise<void> {
    return this.repository.softDeleteForActor(actorId, projectId, templateId, authorizedProjectId);
  }
}

export function createPromptTemplateService(repository: PromptTemplateRepository): PromptTemplateService {
  return new PromptTemplateService(repository);
}

function normalizeTemplateInput(input: PromptTemplateInput): PromptTemplateInput {
  const name = input.name.trim();
  const content = input.content.trim();
  if (name.length < 1 || name.length > PROMPT_TEMPLATE_NAME_MAX) {
    throw new BadRequestError(`模板名称需为 1-${PROMPT_TEMPLATE_NAME_MAX} 个字符`);
  }
  if (content.length < 1 || content.length > PROMPT_TEMPLATE_CONTENT_MAX) {
    throw new BadRequestError(`模板内容需为 1-${PROMPT_TEMPLATE_CONTENT_MAX} 个字符`);
  }
  return { mediaKind: input.mediaKind, name, content };
}
