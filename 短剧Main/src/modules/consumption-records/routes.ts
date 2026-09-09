import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { DrizzleConsumptionRecordsRepository, type ConsumptionRecordsRepository } from "./repository.js";
import { ConsumptionRecordsService } from "./service.js";
import {
  CONSUMPTION_TASK_TYPES,
  type ConsumptionRecordFilter,
  type ConsumptionRecordPage,
} from "./types.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id });
const sceneParams = z.object({ project_id: id, scene_id: id });
const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  task_type: z.enum(CONSUMPTION_TASK_TYPES).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
}).refine(
  (query) => !query.from || !query.to || query.from.getTime() <= query.to.getTime(),
  { message: "开始时间不能晚于结束时间", path: ["from"] },
);

export interface ConsumptionRecordsRouteDependencies {
  createRepository?: () => ConsumptionRecordsRepository;
}

/**
 * Integration owner wires this module once in src/http/routes.ts.
 * It intentionally owns no shared route registry file.
 */
export async function registerConsumptionRecordRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ConsumptionRecordsRouteDependencies = {},
): Promise<void> {
  const service = () => new ConsumptionRecordsService(
    dependencies.createRepository?.() ?? new DrizzleConsumptionRecordsRepository(getDatabase()),
  );
  const repo = () => dependencies.createRepository?.() ?? new DrizzleConsumptionRecordsRepository(getDatabase());

  app.get("/api/v1/projects/:project_id/consumption/records", async (request) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(projectParams, request.params);
    const query = parseRequest(querySchema, request.query);
    const result = await service().list(actor.id, toFilter(query, params.project_id));
    return success(toResponse(result, false));
  });

  app.get("/api/v1/projects/:project_id/scenes/:scene_id/consumption-summary", async (request) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(sceneParams, request.params);
    const summary = await repo().getSceneConsumptionSummary(actor.id, params.project_id, params.scene_id);
    return success({
      total_cost_points: summary.totalCostPoints,
      request_count: summary.requestCount,
      breakdown_by_kind: summary.breakdownByKind.map((item) => ({
        kind: item.kind,
        model: item.model,
        charged_points: item.chargedPoints,
        request_count: item.requestCount,
      })),
    });
  });

  app.get("/api/v1/consumption/records", async (request) => {
    const actor = requireCurrentUser(request);
    const query = parseRequest(querySchema, request.query);
    const result = await service().list(actor.id, toFilter(query));
    return success(toResponse(result, true));
  });
}

function toFilter(query: z.infer<typeof querySchema>, projectId?: string): ConsumptionRecordFilter {
  return {
    projectId,
    from: query.from,
    to: query.to,
    taskType: query.task_type,
    model: query.model,
    page: query.page,
    pageSize: query.page_size,
  };
}

function toResponse(result: ConsumptionRecordPage, includeProjectName: boolean) {
  return {
    cost_source: "cost_entries",
    compatibility_gaps: result.compatibilityGaps,
    records: result.records.map((record) => ({
      created_at: record.createdAt.toISOString(),
      task_type: record.taskType,
      model_display_name: record.modelDisplayName,
      episode_no: record.episodeNo,
      prompt_excerpt: record.promptExcerpt,
      task_id: record.taskId,
      points: record.points,
      source_table: record.sourceTable,
      source_id: record.sourceId,
      is_unpriced: record.isUnpriced,
      ...(includeProjectName ? { project_name: record.projectName } : {}),
    })),
    total: result.total,
    page: result.page,
    page_size: result.pageSize,
  };
}
