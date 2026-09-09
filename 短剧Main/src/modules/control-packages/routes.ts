import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { ControlPackageService } from "./service.js";
import type { ControlPackageStore } from "./types.js";

const id = z.string().uuid();
const shotParams = z.object({ shot_id: id });
const refParams = z.object({ ref_id: id });
const readyBody = z.object({ ready: z.boolean() });
const refBody = z.object({
  // Migration 020 opens lanes to the reference_lane_vocabulary registry; the
  // store validates membership and answers unknown/inactive lanes with 422.
  lane: z.string().trim().min(1).max(24),
  asset_media_id: id.optional(),
  media_result_id: id.optional(),
  note: z.string().trim().min(1).max(512).optional(),
}).superRefine((value, context) => {
  if ((value.asset_media_id === undefined) === (value.media_result_id === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "请只选择一项素材" });
  }
});

export interface ControlPackageRouteDependencies {
  createControlPackageService?: (db: Database) => Pick<
    ControlPackageStore,
    "get" | "setReady" | "addRef" | "deleteRef"
  >;
}

export async function registerControlPackageRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ControlPackageRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createControlPackageService?.(getDatabase())
    ?? new ControlPackageService(getDatabase());

  app.get("/api/v1/shots/:shot_id/control-package", async (request) => {
    const params = parseRequest(shotParams, request.params);
    return success(await service().get(requireCurrentUser(request), params.shot_id));
  });

  app.put("/api/v1/shots/:shot_id/control-package/ready", async (request) => {
    const params = parseRequest(shotParams, request.params);
    const input = parseRequest(readyBody, request.body);
    return success(await service().setReady(requireCurrentUser(request), params.shot_id, input.ready));
  });

  app.post("/api/v1/shots/:shot_id/control-package/refs", async (request, reply) => {
    const params = parseRequest(shotParams, request.params);
    const input = parseRequest(refBody, request.body);
    const data = await service().addRef(requireCurrentUser(request), params.shot_id, {
      lane: input.lane,
      assetMediaId: input.asset_media_id,
      mediaResultId: input.media_result_id,
      note: input.note,
    });
    return reply.code(201).send(success(data));
  });

  app.delete("/api/v1/control-package-refs/:ref_id", async (request) => {
    const params = parseRequest(refParams, request.params);
    await service().deleteRef(requireCurrentUser(request), params.ref_id);
    return success({ deleted: true, id: params.ref_id });
  });
}
