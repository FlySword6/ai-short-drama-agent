import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseRequest } from "../../../http/response.js";
import { NotFoundError } from "../../../shared/errors.js";
import { instantiateTemplate } from "./instantiate.js";
import { getTemplateRegistry } from "./registry.js";
import { applyOptionsSchema } from "./types.js";

const templateParams = z.object({ template_id: z.string().min(1) });

/**
 * 导演台模版包 API。数据是静态资产 + 纯函数实例化，无用户态读写。
 * 它不是项目级写入口：任何已登录用户都可读和预览；真正把实例化结果
 * 保存为项目场景仍须经过 PUT /projects/:project_id/director/scene 的 create
 * 权限。项目级模版治理尚无持久化合同，不能在这里伪造第二套权限事实。
 * 鉴权（AUTH-04 无匿名接口）由 director 总插件的 preHandler 统一完成
 * （见 src/modules/director/routes.ts），本文件不再依赖中央白名单。
 * 注意：模版与场景 JSON 是导演台的 camelCase 数据契约，不走 success() 的
 * snake_case 转换，错误仍由全局错误处理器统一返回 {ok:false,error}。
 */
export async function registerDirectorTemplateRoutes(app: FastifyInstance): Promise<void> {
  const registry = getTemplateRegistry();

  app.get("/api/v1/director/templates", async () => ({
    ok: true,
    data: { templates: registry.list() },
  }));

  app.get("/api/v1/director/templates/:template_id", async (request) => {
    const params = parseRequest(templateParams, request.params);
    const template = registry.get(params.template_id);
    if (!template) throw new NotFoundError("导演模版不存在");
    return { ok: true, data: template };
  });

  app.post("/api/v1/director/templates/:template_id/apply", async (request) => {
    const params = parseRequest(templateParams, request.params);
    const template = registry.get(params.template_id);
    if (!template) throw new NotFoundError("导演模版不存在");
    const options = parseRequest(applyOptionsSchema, request.body ?? {});
    const scene = instantiateTemplate(template, options);
    return { ok: true, data: scene };
  });
}
