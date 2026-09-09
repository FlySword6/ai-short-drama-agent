export const promptTemplateMediaKinds = ["image", "video"] as const;
export type PromptTemplateMediaKind = (typeof promptTemplateMediaKinds)[number];

export const PROMPT_TEMPLATE_NAME_MAX = 80;
export const PROMPT_TEMPLATE_CONTENT_MAX = 5000;

/** 用户自建提示词模板行（系统默认模板是代码常量，不入库）。 */
export interface PromptTemplate {
  id: string;
  projectId: string;
  mediaKind: PromptTemplateMediaKind;
  name: string;
  content: string;
  createdByUserId: string;
  deletedByUserId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromptTemplateInput {
  mediaKind: PromptTemplateMediaKind;
  name: string;
  content: string;
}
