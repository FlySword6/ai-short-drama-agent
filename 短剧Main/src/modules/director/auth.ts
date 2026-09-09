import type { FastifyRequest } from "fastify";
import type { Database } from "../../db/client.js";
import { createAuthenticationHook } from "../../http/authenticate.js";

/**
 * 导演台模块的插件级鉴权（AUTH-04：无匿名接口，未登录 401）。
 * 直接复用 src/http/authenticate.ts 的 Bearer/session 校验逻辑，不复制实现。
 * 生产环境 app.ts 的全局 preHandler 先于本钩子执行并写入 request.authUser，
 * 此时直接放行，避免每个请求重复查 sessions 表；测试或独立注册时本钩子
 * 自己完成鉴权，保证模块不依赖中央注册即可闭合鉴权语义。
 */
export function createDirectorAuthHook(getDatabase: () => Database) {
  const authenticate = createAuthenticationHook(getDatabase);
  return async function authenticateDirectorRequest(request: FastifyRequest): Promise<void> {
    if (request.authUser) return;
    await authenticate(request);
  };
}
