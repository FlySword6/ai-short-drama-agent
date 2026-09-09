import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/client.js";
import { settings } from "../../../config/env.js";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import { publicStoredMessage } from "../../../shared/errors.js";
import { requireAdministrator } from "../../auth/admin.js";
import { DrizzleAdminGenerationsRepository, type AdminGenerationsRepository } from "./repository.js";
import { ADMIN_GENERATION_STATUSES, type AdminGenerationListItem, type AdminGenerationListResult, type AdminGenerationStats } from "./types.js";

const mediaKinds = ["image", "video"] as const;

const listQuerySchema = z.object({
  status: z.enum(ADMIN_GENERATION_STATUSES).optional(),
  media_kind: z.enum(mediaKinds).optional(),
  created_from: z.coerce.date().optional(),
  created_to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
}).refine(
  (query) => !query.created_from || !query.created_to || query.created_from.getTime() <= query.created_to.getTime(),
  { message: "查询生成记录没成：开始时间不能晚于结束时间，请调整筛选时间。", path: ["created_from"] },
);

export interface AdminGenerationsRouteDependencies {
  createRepository?: () => AdminGenerationsRepository;
  /** Defaults to `settings.adminUsernames`; overridable so tests do not depend on process env. */
  adminUsernames?: readonly string[];
}

/**
 * Read-only, cross-project admin oversight of generation tasks. Every route
 * here requires both an authenticated session and membership in
 * `settings.adminUsernames`; there is no write path in this module.
 */
export async function registerAdminGenerationRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AdminGenerationsRouteDependencies = {},
): Promise<void> {
  const repository = () => dependencies.createRepository?.() ?? new DrizzleAdminGenerationsRepository(getDatabase());
  const adminUsernames = dependencies.adminUsernames ?? settings.adminUsernames;

  app.get("/api/v1/admin/generations", async (request) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user, adminUsernames);
    const query = parseRequest(listQuerySchema, request.query);
    const result = await repository().list({
      status: query.status,
      mediaKind: query.media_kind,
      createdFrom: query.created_from,
      createdTo: query.created_to,
      limit: query.limit,
      offset: query.offset,
    });
    return success(toListResponse(result));
  });

  app.get("/api/v1/admin/generations/stats", async (request) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user, adminUsernames);
    const stats = await repository().stats();
    return success(toStatsResponse(stats));
  });
}

function toListResponse(result: AdminGenerationListResult) {
  const nextOffset = result.offset + result.items.length < result.total ? result.offset + result.items.length : null;
  return {
    items: result.items.map(toListItemResponse),
    count: result.items.length,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    next_offset: nextOffset,
  };
}

function toListItemResponse(item: AdminGenerationListItem) {
  const displayReason = generationDisplayReason(item.failureReason, item.mediaKind);
  return {
    generation_request_id: item.requestId,
    project_id: item.projectId,
    project_name: item.projectName,
    user_id: item.userId,
    username: item.username,
    media_kind: item.mediaKind,
    status: item.status,
    phase: item.phase,
    attempt_no: item.attemptNo,
    model: item.model,
    estimated_cost_fen: item.estimatedCostFen,
    failure_reason: item.failureReason,
    display_reason: displayReason,
    provider_task_id: item.providerTaskId,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}

function toStatsResponse(stats: AdminGenerationStats) {
  return {
    by_status: stats.byStatus.map((row) => ({ status: row.status, count: row.count })),
    top_failure_reasons: stats.topFailureReasons.map((row) => ({
      failure_reason: row.failureReason,
      display_reason: generationDisplayReason(row.failureReason),
      count: row.count,
    })),
    daily_cost_fen: stats.dailyCostFen.map((row) => ({ date: row.date, estimated_cost_fen: row.estimatedCostFen })),
    window_days: stats.windowDays,
    notice: "预估消耗，非云平台实际账单",
  };
}

function generationDisplayReason(
  failureReason: string | null,
  mediaKind?: AdminGenerationListItem["mediaKind"],
): string | null {
  if (!failureReason) return null;
  if (/积分|余额|预算/u.test(failureReason)) {
    return "生成没成：可用积分不足，请充值或选择较低档位后重试。";
  }
  if (/审核|合规|敏感/u.test(failureReason)) {
    return "生成没成：内容没有通过审核，请调整提示词或参考素材后重试。";
  }
  return publicStoredMessage(
    failureReason,
    `${mediaKind === "video" ? "视频" : mediaKind === "image" ? "图片" : "内容"}生成没成：生成服务暂时没响应，请稍后重试。`,
  );
}
