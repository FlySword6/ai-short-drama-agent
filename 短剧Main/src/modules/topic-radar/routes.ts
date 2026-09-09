import type { FastifyInstance } from "fastify";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { success } from "../../http/response.js";
import { AppError, ForbiddenError } from "../../shared/errors.js";
import { isAdministrator } from "../auth/types.js";
import { createTopicRadarService } from "./service.js";
import type { TopicRadarResource, TopicRadarServicePort } from "./types.js";

const MAX_RANKING_ID_LENGTH = 256;

export interface TopicRadarRouteDependencies {
  createService?: () => TopicRadarServicePort;
}

export async function registerTopicRadarRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: TopicRadarRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.() ?? createTopicRadarService(getDatabase());

  app.get("/api/v1/topic-radar/rankings", async (request) => (
    success(toResponse(await service().listRankings(requireCurrentUser(request))))
  ));

  app.get<{ Params: { ranking_id: string }; Querystring: { page?: string; sub_ranking_id?: string } }>(
    "/api/v1/topic-radar/rankings/:ranking_id/items",
    async (request) => {
      const rankingId = requiredOpaqueId(request.params.ranking_id, "榜单编号");
      const subRankingId = optionalOpaqueId(request.query.sub_ranking_id, "子榜单编号");
      const page = request.query.page === undefined ? 1 : parsePage(request.query.page);
      return success(toResponse(await service().getRankingPage(requireCurrentUser(request), {
        rankingId,
        ...(subRankingId ? { subRankingId } : {}),
        page,
      })));
    },
  );

  app.post<{ Body: { target?: string; ranking_id?: string; sub_ranking_id?: string; page?: unknown } }>(
    "/api/v1/admin/topic-radar/refresh",
    async (request) => {
      const actor = requireCurrentUser(request);
      if (!isAdministrator(actor.role)) throw new ForbiddenError("只有管理员可以手动刷新选题雷达");
      return success(toResponse(await service().forceRefresh(actor, parseRefreshTarget(request.body))));
    },
  );
}

function parseRefreshTarget(body: { target?: string; ranking_id?: string; sub_ranking_id?: string; page?: unknown } | undefined): TopicRadarResource {
  if (body?.target === "rankings") return { kind: "rankings" };
  if (body?.target !== "ranking_page") {
    throw new AppError(400, "topic_radar_invalid_refresh_target", "刷新目标无效，请选择榜单目录或指定榜单页");
  }
  const rankingId = requiredOpaqueId(body.ranking_id, "榜单编号");
  const subRankingId = optionalOpaqueId(body.sub_ranking_id, "子榜单编号");
  return {
    kind: "ranking_page",
    rankingId,
    ...(subRankingId ? { subRankingId } : {}),
    page: body.page === undefined ? 1 : parsePage(body.page),
  };
}

function requiredOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(400, "topic_radar_invalid_ranking_id", `${label}不能为空`);
  }
  return opaqueId(value, label);
}

function optionalOpaqueId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(400, "topic_radar_invalid_ranking_id", `${label}不能为空`);
  }
  return opaqueId(value, label);
}

function opaqueId(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length > MAX_RANKING_ID_LENGTH) {
    throw new AppError(400, "topic_radar_invalid_ranking_id", `${label}长度不能超过 ${MAX_RANKING_ID_LENGTH} 个字符`);
  }
  return normalized;
}

function parsePage(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new AppError(400, "topic_radar_invalid_page", "页码必须是整数");
  }
  const page = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(page)) throw new AppError(400, "topic_radar_invalid_page", "页码必须是整数");
  return page;
}

function toResponse(value: Awaited<ReturnType<TopicRadarServicePort["listRankings"]>> | Awaited<ReturnType<TopicRadarServicePort["getRankingPage"]>>) {
  const base = {
    data_date: value.dataDate,
    fetched_at: value.fetchedAt?.toISOString() ?? null,
    freshness: value.freshness,
    commercial_display_status: "pending_vendor_written_approval" as const,
  };
  if ("rankings" in value) {
    return {
      rankings: value.rankings.map((ranking) => ({
        id: ranking.id,
        name: ranking.name,
        sub_rankings: ranking.subRankings.map((subRanking) => ({ id: subRanking.id, name: subRanking.name })),
      })),
      ...base,
    };
  }
  return {
    ranking_id: value.rankingId,
    ...(value.subRankingId ? { sub_ranking_id: value.subRankingId } : {}),
    page: value.page,
    items: value.items,
    next_page: value.nextPage,
    end_reached: value.endReached,
    ...base,
  };
}
