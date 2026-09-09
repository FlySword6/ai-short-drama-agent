import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { projects, promptDefaultTemplates } from "../../db/schema.js";
import { DEFAULT_IMAGE_PROMPT_TEMPLATE, DEFAULT_VIDEO_PROMPT_TEMPLATE } from "./promptCompiler.js";
import { PostgresGenerationRepository } from "./repository.js";

const projectId = "22222222-2222-4222-8222-222222222222";

/** 构造只 mock select 链的 PostgresGenerationRepository：真实 DB 查询一律按表名返回 rows。 */
function repositoryFor(rows: Map<object, unknown[]>): PostgresGenerationRepository {
  return new PostgresGenerationRepository({
    select: () => ({
      from: (table: object) => ({
        where: () => ({
          limit: async () => rows.get(table) ?? [],
        }),
      }),
    }),
  } as unknown as Database, 1_000);
}

const noTemplateProjectRow = {
  defaultRatio: null,
  defaultImageResolution: null,
  defaultVideoResolution: null,
  imageStyleDescription: null,
  videoStyleDescription: null,
  imageStyleReferenceMediaIds: [],
  videoStyleReferenceMediaIds: [],
  imagePromptTemplate: null,
  videoPromptTemplate: null,
};

test("resolveProjectGenerationConfig 模板回落：项目模板 > 平台系统模板 > 代码常量", async (context) => {
  const projectImageTemplate = "项目图片模板";
  const projectVideoTemplate = "项目视频模板";
  const platformImage = "# ⚠️ 资产生图提示词规范（平台 image 默认）";
  const platformVideo = "Seedance 视频规范（平台 video 默认）";

  await context.test("项目模板非空：image/video 各用各列", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{
      ...noTemplateProjectRow,
      imagePromptTemplate: projectImageTemplate,
      videoPromptTemplate: projectVideoTemplate,
    }]);
    const repo = repositoryFor(rows);
    assert.equal((await repo.resolveProjectGenerationConfig(projectId, "image")).promptTemplate, projectImageTemplate);
    assert.equal((await repo.resolveProjectGenerationConfig(projectId, "video")).promptTemplate, projectVideoTemplate);
  });

  await context.test("image 无项目模板：platform_default 读 prompt_default_templates 表", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ ...noTemplateProjectRow }]);
    rows.set(promptDefaultTemplates, [{ content: platformImage }]);
    const repo = repositoryFor(rows);
    const config = await repo.resolveProjectGenerationConfig(projectId, "image");
    assert.equal(config.promptTemplate, platformImage);
    assert.equal(config.promptTemplateSource, "platform_default");
  });

  await context.test("video 无项目模板：platform_default 读 prompt_default_templates 表", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ ...noTemplateProjectRow }]);
    rows.set(promptDefaultTemplates, [{ content: platformVideo }]);
    const repo = repositoryFor(rows);
    const config = await repo.resolveProjectGenerationConfig(projectId, "video");
    assert.equal(config.promptTemplate, platformVideo);
    assert.equal(config.promptTemplateSource, "platform_default");
  });

  await context.test("项目无模板且平台表缺行：终极回落代码常量", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ ...noTemplateProjectRow }]);
    rows.set(promptDefaultTemplates, []);
    const repo = repositoryFor(rows);
    assert.equal((await repo.resolveProjectGenerationConfig(projectId, "image")).promptTemplate, DEFAULT_IMAGE_PROMPT_TEMPLATE);
    assert.equal((await repo.resolveProjectGenerationConfig(projectId, "video")).promptTemplate, DEFAULT_VIDEO_PROMPT_TEMPLATE);
  });
});
