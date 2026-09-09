import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  directorTemplateSchema,
  type DirectorTemplate,
  type TemplateCategory,
} from "./types.js";
import { validateTemplateDefinition } from "./validate.js";

export interface TemplateSummary {
  id: string;
  name: string;
  category: TemplateCategory;
  tags: string[];
  characterCount: number;
  mood: string[];
  cameraCount: number;
  dataSource: string;
}

export interface TemplateRegistry {
  list(): TemplateSummary[];
  get(id: string): DirectorTemplate | undefined;
  size(): number;
}

/** 模版目录默认取仓库根下 assets/director/templates（服务与测试均从仓库根启动）。 */
export function defaultTemplatesDirectory(): string {
  return process.env.DIRECTOR_TEMPLATES_DIR ?? path.resolve("assets", "director", "templates");
}

/**
 * 读取目录下全部 *.json 模版，逐条过 zod schema 与静态结构校验。
 * 任一文件损坏即抛错（fail fast：模版是随仓库版本化的资产，不应带病启动）。
 */
export function createTemplateRegistry(directory = defaultTemplatesDirectory()): TemplateRegistry {
  const templates = new Map<string, DirectorTemplate>();
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(path.join(directory, file), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`模版文件 ${file} 不是合法 JSON: ${(error as Error).message}`);
    }
    const result = directorTemplateSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`模版文件 ${file} 不符合 schema: ${issues}`);
    }
    const template = result.data;
    const expectedId = file.replace(/\.json$/, "");
    if (template.id !== expectedId) {
      throw new Error(`模版文件 ${file} 的 id ${template.id} 与文件名不一致`);
    }
    validateTemplateDefinition(template);
    if (templates.has(template.id)) throw new Error(`模版 id ${template.id} 重复`);
    templates.set(template.id, template);
  }

  return {
    list: () =>
      [...templates.values()].map((template) => ({
        id: template.id,
        name: template.name,
        category: template.category,
        tags: template.tags,
        characterCount: template.characterCount,
        mood: template.mood,
        cameraCount: template.cameras.length,
        dataSource: template.dataSource,
      })),
    get: (id) => templates.get(id),
    size: () => templates.size,
  };
}

let sharedRegistry: TemplateRegistry | undefined;

/** 进程内共享的 registry（懒加载一次）；测试请用 createTemplateRegistry 自建实例。 */
export function getTemplateRegistry(): TemplateRegistry {
  sharedRegistry ??= createTemplateRegistry();
  return sharedRegistry;
}
