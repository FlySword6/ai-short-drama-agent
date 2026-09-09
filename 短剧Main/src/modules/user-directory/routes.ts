import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { UserDirectoryRepository, USER_DIRECTORY_RESULT_LIMIT } from "./repository.js";
import type { UserDirectoryStore } from "./types.js";

const directoryQuerySchema = z.object({
  // 空 q 返回前 N 个活跃用户（选人框聚焦即展示）；非空 q 做模糊匹配。
  // 上限 20 条，避免被当作全组织导出。
  q: z.string().trim().max(64).optional().default(""),
}).strict();

export interface UserDirectoryRouteDependencies {
  createStore?: () => UserDirectoryStore;
}

/**
 * A login-readable, privacy-minimal directory for the project member picker.
 * The response intentionally exposes only the fields the picker needs.
 */
export async function registerUserDirectoryRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: UserDirectoryRouteDependencies = {},
): Promise<void> {
  const store = () => dependencies.createStore?.() ?? new UserDirectoryRepository(getDatabase());

  app.get("/api/v1/users/directory", async (request) => {
    requireCurrentUser(request);
    const input = parseRequest(directoryQuerySchema, request.query);
    const items = await store().searchActiveUsers(input.q, USER_DIRECTORY_RESULT_LIMIT);
    return success({ items, count: items.length });
  });
}
