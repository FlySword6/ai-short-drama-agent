import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { DrizzleTrashRepository } from "./repository.js";
import { TrashService } from "./service.js";
import { settings } from "../../config/env.js";

const id = z.string().uuid();
const trashParams = z.object({ kind: z.enum(["project", "asset"]), id });
const listQuery = z.object({ kind: z.enum(["project", "asset"]).optional() });

export async function registerTrashRoutes(app: FastifyInstance, getDatabase: () => Database): Promise<void> {
  const service = () => new TrashService(new DrizzleTrashRepository(getDatabase()));

  app.get("/api/v1/trash", async (request) => {
    const user = requireCurrentUser(request);
    const query = parseRequest(listQuery, request.query);
    const items = (await service().list(user.id)).filter((item) => !query.kind || item.kind === query.kind);
    return success({ items: items.map(toResponse), count: items.length, retention_days: settings.trashRetentionDays });
  });

  app.post("/api/v1/trash/:kind/:id/restore", async (request) => {
    const user = requireCurrentUser(request);
    const params = parseRequest(trashParams, request.params);
    const restored = await service().restore({ actorId: user.id, kind: params.kind, id: params.id });
    return success({ restored: true, item: toResponse(restored) });
  });

  app.delete("/api/v1/trash/:kind/:id", async (request) => {
    const user = requireCurrentUser(request);
    const params = parseRequest(trashParams, request.params);
    await service().permanentlyDelete({ actorId: user.id, kind: params.kind, id: params.id });
    return success({ permanently_deleted: true, id: params.id, kind: params.kind });
  });
}

function toResponse(item: Awaited<ReturnType<TrashService["restore"]>>) {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    owner_user_id: item.ownerUserId,
    deleted_at: item.deletedAt.toISOString(),
    expires_at: new Date(item.deletedAt.getTime() + settings.trashRetentionDays * 24 * 60 * 60 * 1000).toISOString(),
  };
}
