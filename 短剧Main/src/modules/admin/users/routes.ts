import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/client.js";
import { uiModes } from "../../../db/schema.js";
import { requireCurrentSessionId, requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import { ForbiddenError } from "../../../shared/errors.js";
import { PLATFORM_ROLES, isAdministrator } from "../../auth/types.js";
import { PostgresAdminUserRepository } from "./repository.js";
import { AdminUserService } from "./service.js";
import type { AdminActor } from "./types.js";

const userIdParams = z.object({ id: z.string().uuid() });
const createUserSchema = z.object({
  username: z.string(),
  display_name: z.string().max(128).optional(),
  role: z.enum(PLATFORM_ROLES).default("member"),
  // 缺省不落库为 lite：业务账号必须由管理员显式指定（红线 R2）。
  ui_mode: z.enum(uiModes).optional(),
}).strict();
const updateUserSchema = z.object({ role: z.enum(PLATFORM_ROLES) }).strict();
const updateUiModeSchema = z.object({ ui_mode: z.enum(uiModes) }).strict();

export type AdminUserServicePort = Pick<
  AdminUserService,
  "listUsers" | "createUser" | "disableUser" | "resetPassword"
  | "updateRole" | "updateUiMode"
>;

export interface AdminUserRouteDependencies {
  createService?: () => AdminUserServicePort;
  /** @deprecated migration 016 moved runtime authorization to users.role. */
  adminUsernames?: readonly string[];
}

/**
 * Integration owner wires one line in src/http/routes.ts:
 * `await registerAdminUserRoutes(app, dependencies.getDatabase);`
 */
export async function registerAdminUserRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AdminUserRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.()
    ?? new AdminUserService(new PostgresAdminUserRepository(getDatabase()));
  // Kept only so older callers compile; admin authority is always DB-backed.
  void dependencies.adminUsernames;

  app.get("/api/v1/admin/users", async (request) => {
    const actor = requireAdminActor(request);
    const items = await service().listUsers(actor);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/admin/users", async (request, reply) => {
    const actor = requireAdminActor(request);
    const input = parseRequest(createUserSchema, request.body);
    const result = await service().createUser(actor, {
      username: input.username,
      displayName: input.display_name,
      role: input.role,
      uiMode: input.ui_mode,
    });
    return reply.code(201).send(success(result));
  });

  app.post("/api/v1/admin/users/:id/disable", async (request) => {
    const actor = requireAdminActor(request);
    const params = parseRequest(userIdParams, request.params);
    return success(await service().disableUser(actor, params.id));
  });

  app.post("/api/v1/admin/users/:id/reset-password", async (request) => {
    const actor = requireAdminActor(request);
    const params = parseRequest(userIdParams, request.params);
    return success(await service().resetPassword(actor, params.id));
  });

  app.patch("/api/v1/admin/users/:id", async (request) => {
    const actor = requireAdminActor(request);
    const params = parseRequest(userIdParams, request.params);
    const input = parseRequest(updateUserSchema, request.body);
    return success({ user: await service().updateRole(actor, params.id, input.role) });
  });

  app.patch("/api/v1/admin/users/:id/ui-mode", async (request) => {
    const actor = requireAdminActor(request);
    const params = parseRequest(userIdParams, request.params);
    const input = parseRequest(updateUiModeSchema, request.body);
    return success({ user: await service().updateUiMode(actor, params.id, input.ui_mode) });
  });
}

function requireAdminActor(request: FastifyRequest): AdminActor {
  const user = requireCurrentUser(request);
  if (!isAdministrator(user.role)) {
    throw new ForbiddenError("管理用户没成：当前账号没有权限，请联系管理员处理。");
  }
  return { userId: user.id, sessionId: requireCurrentSessionId(request) };
}
