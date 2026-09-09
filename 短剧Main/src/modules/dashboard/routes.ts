import type { FastifyInstance } from "fastify";
import type { Database } from "../../db/client.js";
import { settings } from "../../config/env.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { success } from "../../http/response.js";
import { AppError } from "../../shared/errors.js";
import { requireAdministrator } from "../auth/admin.js";
import { DrizzleDashboardRepository, type UnitPriceRecord } from "./repository.js";
import { DashboardService } from "./service.js";

/* 单价写入 2026-07 起统一走 /api/v1/admin/pricing-rules（乐观锁+留痕）；
   本文件的 PUT 只剩 410 停用响应，不再解析请求体，随之删掉入参 schema。 */

export async function registerDashboardRoutes(app: FastifyInstance, getDatabase: () => Database): Promise<void> {
  const service = () => new DashboardService(new DrizzleDashboardRepository(getDatabase()));

  app.get("/api/v1/dashboard/summary", async (request) => {
    const user = requireCurrentUser(request);
    const summary = await service().getSummary(user.id);
    return success({ data: summary.data, costs: toSummaryResponse(summary.costs) });
  });

  /**
   * Project-level costs belong exclusively to the v0.2 operations route:
   * GET /api/v1/projects/:project_id/costs.
   *
   * It uses the same `cost_entries` view but additionally exposes the
   * contract's grouping, access policy and CSV semantics.  Do not re-register
   * the legacy dashboard path here: Fastify would reject duplicate routes and
   * two response contracts would inevitably drift.
   */

  app.get("/api/v1/cost-settings/unit-prices", async (request) => {
    requireCurrentUser(request);
    const items = await service().listUnitPrices();
    return success({ items: items.map(toPriceResponse), count: items.length });
  });

  app.put("/api/v1/cost-settings/unit-prices", async (request) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user, settings.adminUsernames);
    // 写价统一走 admin 模型计费模块（乐观锁 + 留痕），本入口停用防绕过
    // expected_active_rule_id 保护。读入口保留。
    throw new AppError(
      410,
      "unit_price_write_moved",
      "单价设置入口已调整，请到后台的计费规则中修改。",
      false,
    );
  });
}

function toSummaryResponse(summary: ReturnType<typeof import("./summary.js")["buildDashboardSummary"]>) {
  return {
    notice: summary.notice,
    cost_source: "cost_entries",
    charged_points: summary.totalChargedPoints,
    unpriced_count: summary.unpricedCount,
    compatibility_gaps: summary.compatibilityGaps,
    total_tasks: summary.totalTasks,
    succeeded_tasks: summary.succeededTasks,
    active_tasks: summary.activeTasks,
    failed_tasks: summary.failedTasks,
    image_estimated_cost_fen: summary.imageEstimatedCostFen,
    video_estimated_cost_fen: summary.videoEstimatedCostFen,
    total_estimated_cost_fen: summary.totalEstimatedCostFen,
    by_project: summary.byProject.map((item) => ({
      project_id: item.projectId,
      project_name: item.projectName,
      tasks: item.tasks,
      succeeded: item.succeeded,
      failed: item.failed,
      estimated_cost_fen: item.estimatedCostFen,
      charged_points: item.chargedPoints,
      unpriced_count: item.unpricedCount,
    })),
    by_user: summary.byUser.map((item) => ({
      user_id: item.userId,
      user_name: item.userName,
      image_estimated_cost_fen: item.imageEstimatedCostFen,
      video_estimated_cost_fen: item.videoEstimatedCostFen,
      total_estimated_cost_fen: item.totalEstimatedCostFen,
      charged_points: item.chargedPoints,
      unpriced_count: item.unpricedCount,
    })),
    by_date: summary.byDate.map((item) => ({
      date: item.date,
      tasks: item.tasks,
      estimated_cost_fen: item.estimatedCostFen,
      charged_points: item.chargedPoints,
      unpriced_count: item.unpricedCount,
    })),
  };
}

function toPriceResponse(item: UnitPriceRecord) {
  return {
    id: item.id,
    provider: item.provider,
    model: item.model,
    media_kind: item.mediaKind,
    billing_unit: item.billingUnit,
    unit_price_fen: item.unitPriceFen,
    currency: item.currency,
    source: item.source,
    active: item.active,
    effective_from: item.effectiveFrom.toISOString(),
    effective_to: item.effectiveTo?.toISOString() ?? null,
    metadata: item.metadata,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}
