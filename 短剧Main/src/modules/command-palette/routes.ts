import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { DrizzleCommandPaletteRepository } from "./repository.js";
import { CommandPaletteService } from "./service.js";
import type { CommandPaletteRepository } from "./types.js";

const searchQuery = z.object({
  q: z.string().trim().min(1).max(64),
}).strict();

export interface RegisterCommandPaletteRoutesOptions {
  createRepository?: () => CommandPaletteRepository;
}

/**
 * ⌘K 命令面板搜索(S30)。登录可读;命中集在 SQL 层就按角色裁过,
 * 前端不拿全量再过滤。集成方在 src/http/routes.ts 注册一次。
 */
export async function registerCommandPaletteRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  options: RegisterCommandPaletteRoutesOptions = {},
): Promise<void> {
  const createRepository = options.createRepository
    ?? (() => new DrizzleCommandPaletteRepository(getDatabase()));

  app.get("/api/v1/command-palette/search", async (request) => {
    const user = requireCurrentUser(request);
    const query = parseRequest(searchQuery, request.query);
    const results = await new CommandPaletteService(createRepository())
      .search({ id: user.id, role: user.role }, query.q);
    return success({ results });
  });
}
