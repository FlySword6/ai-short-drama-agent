import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Database } from "../../db/client.js";
import type { AuthenticatedUser } from "../../http/authenticate.js";
import { toHttpErrorResponse } from "../../http/errorResponse.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { registerDirectorRoutes, type DirectorRouteDependencies } from "./routes.js";

/**
 * director 模块测试脚手架：自建 Fastify 实例注册 registerDirectorRoutes，
 * 不依赖 src/app.ts 与中央路由；鉴权用 token→用户的假实现，可覆盖 401 语义。
 */

export const directorTestUser: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "director-tester",
  displayName: "导演测试",
};

export const otherTestUser: AuthenticatedUser = {
  id: "99999999-9999-4999-8999-999999999999",
  username: "intruder",
  displayName: "旁观者",
};

export const TEST_TOKEN = "director-test-token";

/** 与生产语义一致的假鉴权：无 Bearer/未知 token → 401；合法 → 写入 authUser。 */
export function createFakeAuthenticate(
  tokens: Record<string, AuthenticatedUser> = { [TEST_TOKEN]: directorTestUser },
): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    const match = request.headers.authorization?.match(/^Bearer\s+([^\s]+)$/i);
    const user = match?.[1] ? tokens[match[1]] : undefined;
    if (!user) throw new UnauthorizedError();
    request.authUser = user;
    request.authSessionId = "test-session-id";
  };
}

export const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

export const dummyDatabase = {} as Database;

/**
 * 复刻 src/app.ts 的错误处理器语义（{ok:false,error:{code,...}} 信封），
 * 让测试自建实例与生产行为一致；app.ts 本身不修改。
 */
function setTestErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toHttpErrorResponse(error);
    return reply.code(statusCode).send({ ok: false, error: body });
  });
}

export interface DirectorTestAppOptions extends DirectorRouteDependencies {
  /** 置 false 可完全不注入鉴权（测 401 边界之外的场景一般不需要）。 */
  withAuth?: boolean;
}

export async function createDirectorTestApp(options: DirectorTestAppOptions = {}): Promise<FastifyInstance> {
  const { withAuth = true, ...dependencies } = options;
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  setTestErrorHandler(app);
  await registerDirectorRoutes(app, () => dummyDatabase, {
    ...(withAuth ? { authenticate: createFakeAuthenticate() } : {}),
    ...dependencies,
  });
  return app;
}
