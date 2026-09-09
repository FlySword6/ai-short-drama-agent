import type { GenerationDefaultStrategy, GenerationMediaKind, PromptTemplate } from "./types";

/** 模板内容上限：与后端 zod + prompt_templates.content CHECK 一致（5000）。 */
export const PROMPT_TEMPLATE_CONTENT_MAX = 5000;
/** 模板名上限：与后端 zod + 数据库 CHECK 一致（80）。 */
export const PROMPT_TEMPLATE_NAME_MAX = 80;

export interface EffectivePromptTemplate {
  source: "template" | "system_default";
  content: string;
  /** 引用 id 在库里找不到（软删/跨项目）时置位，页面可提示「已回落系统默认」。 */
  missingTemplateId?: string;
}

/** 策略 parameters 里的模板引用键（缺省/非串 → null）。 */
export function promptTemplateIdOf(strategy: GenerationDefaultStrategy | null): string | null {
  const value = strategy?.parameters.prompt_template_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 解析某媒介策略引用的生效模板内容（docs/design/prd-v2/lite-model-defaults.md §4.3）。
 * 生成期拼接与模板表无关：客户端把命中模板的内容作为 supplement_prompt 提交，
 * 服务端不读 prompt_templates 表；id 缺失/软删/跨项目统一回落系统默认（content=""）。
 */
export function effectivePromptTemplate(
  strategy: GenerationDefaultStrategy | null,
  library: readonly PromptTemplate[],
  kind: GenerationMediaKind,
): EffectivePromptTemplate {
  const id = promptTemplateIdOf(strategy);
  if (!id) return { source: "system_default", content: "" };
  const found = library.find((template) => template.id === id && template.media_kind === kind);
  if (found) return { source: "template", content: found.content };
  return { source: "system_default", content: "", missingTemplateId: id };
}

export interface AssembleAssetImagePromptOptions {
  /** 项目默认风格模板内容(已解析;可为空字符串=系统默认空内容)。 */
  template: string;
  /** 资产名称。 */
  name: string;
  /** 资产描述(intro)。 */
  intro?: string | null;
  /** 资产备注(metadata.lite.notes)。 */
  notes?: string | null;
}

/**
 * 资产生图提示词拼接合同:
 *   最终提示词 = 项目默认风格模板 + 资产名称/描述/备注
 * 两段各自 trim 后非空才保留,段间换行符连接。弹窗 A(新建资产)与弹窗 B(加图/新建变体)
 * 共用本函数保证拼接一致。
 */
export function assembleAssetImagePrompt(opts: AssembleAssetImagePromptOptions): string {
  const assetInfo = [opts.name, opts.intro, opts.notes]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join("，");
  return [opts.template, assetInfo].filter(Boolean).join("\n");
}
