import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { ObjectContextService } from "./service.js";
import { OBJECT_KINDS, type ObjectContextQuery, type ProductionGraphQuery } from "./types.js";

const id = z.string().uuid();
const objectParams = z.object({
  object_kind: z.enum(OBJECT_KINDS),
  object_id: id,
});
const projectParams = z.object({ project_id: id });

const contextQuery = z.object({
  include: z.preprocess(toIncludeValues, z.array(z.enum(["origin", "usage", "next_actions"])).min(1))
    .default(["origin", "usage", "next_actions"]),
  project_context_id: id.optional(),
  origin_depth: z.coerce.number().int().min(1).max(5).default(2),
  usage_cursor: z.string().min(1).max(4_096).optional(),
  usage_page_size: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const productionGraphQuery = z.object({
  scope_kind: z.enum(["project", "episode", "scene"]).default("project"),
  scope_id: id.optional(),
  preset: z.enum(["pipeline", "canvas"]).default("pipeline"),
}).strict().superRefine((value, context) => {
  if ((value.scope_kind === "episode" || value.scope_kind === "scene") && !value.scope_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope_id"],
      message: "按分集或场查看时必须提供 scope_id",
    });
  }
});

export interface ObjectContextRouteDependencies {
  createService?: (database: Database) => Pick<
    ObjectContextService,
    "context" | "productionGraph" | "episodeProductionStatus" | "sceneProductionStatus"
  >;
}

/**
 * Object context is a read projection.  The route intentionally accepts only
 * the five approved subject kinds; higher-level nodes (episode/scene) are
 * available through the project production graph rather than as new subjects.
 */
export async function registerObjectContextRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ObjectContextRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase()) ?? new ObjectContextService(getDatabase());

  app.get("/api/v1/objects/:object_kind/:object_id/context", async (request) => {
    const params = parseRequest(objectParams, request.params);
    const query = parseRequest(contextQuery, request.query);
    const actor = requireCurrentUser(request);
    const input: ObjectContextQuery = {
      include: new Set(query.include),
      projectContextId: query.project_context_id,
      originDepth: query.origin_depth,
      usageCursor: query.usage_cursor,
      usagePageSize: query.usage_page_size,
    };
    return success(await service().context(actor, params.object_kind, params.object_id, input));
  });

  app.get("/api/v1/projects/:project_id/production-graph", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const query = parseRequest(productionGraphQuery, request.query);
    const actor = requireCurrentUser(request);
    const input: ProductionGraphQuery = {
      scopeKind: query.scope_kind,
      scopeId: query.scope_id,
      preset: query.preset,
    };
    return success(await service().productionGraph(actor, params.project_id, input));
  });

  app.get("/api/v1/episodes/:episode_id/production-status", async (request) => {
    const params = parseRequest(z.object({ episode_id: id }), request.params);
    return success(await service().episodeProductionStatus(requireCurrentUser(request), params.episode_id));
  });

  app.get("/api/v1/scenes/:scene_id/production-status", async (request) => {
    const params = parseRequest(z.object({ scene_id: id }), request.params);
    return success(await service().sceneProductionStatus(requireCurrentUser(request), params.scene_id));
  });
}

function toIncludeValues(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}
