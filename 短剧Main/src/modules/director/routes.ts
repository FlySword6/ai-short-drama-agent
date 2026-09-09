import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "../../db/client.js";
import { createDirectorAuthHook } from "./auth.js";
import { registerDirectorTemplateRoutes } from "./templates/routes.js";
import { registerDirectorSceneRoutes, type SceneRouteDependencies } from "./scene/routes.js";
import { registerDirectorCaptureRoutes, type CaptureRouteDependencies } from "./captures/routes.js";
import { registerDirectorCommandRoutes, type CommandRouteDependencies } from "./commands/routes.js";

/**
 * 导演台模块总插件：自带鉴权（AUTH-04 无匿名接口），不依赖中央路由注册。
 * 集成者在 src/http/routes.ts 的 registerRoutes 中加一行：
 *   await registerDirectorRoutes(app, options.getDatabase);
 * 即可接入；生产环境全局 preHandler 已鉴权时本插件的钩子直接放行（见 auth.ts）。
 */

export interface DirectorRouteDependencies {
  /** 测试注入的鉴权实现；默认复用 src/http/authenticate.ts 的 session 校验。 */
  authenticate?: (request: FastifyRequest) => Promise<void>;
  scene?: SceneRouteDependencies;
  captures?: CaptureRouteDependencies;
  commands?: CommandRouteDependencies;
}

export async function registerDirectorRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: DirectorRouteDependencies = {},
): Promise<void> {
  await app.register(async (director) => {
    director.addHook(
      "preHandler",
      dependencies.authenticate ?? createDirectorAuthHook(getDatabase),
    );
    await registerDirectorTemplateRoutes(director);
    await registerDirectorSceneRoutes(director, getDatabase, dependencies.scene);
    await registerDirectorCaptureRoutes(director, getDatabase, dependencies.captures);
    await registerDirectorCommandRoutes(director, getDatabase, dependencies.commands);
  });
}
