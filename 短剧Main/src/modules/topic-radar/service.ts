import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AppError, ForbiddenError } from "../../shared/errors.js";
import { isAdministrator } from "../auth/types.js";
import { FiftyTwoApiTopicRadarProvider, type FiftyTwoApiTopicRadarConfiguration } from "./provider.js";
import { TopicRadarRepository } from "./repository.js";
import {
  TOPIC_RADAR_SOURCE,
  type TopicRadarActor,
  type TopicRadarPageView,
  type TopicRadarProvider,
  type TopicRadarRankingsView,
  type TopicRadarResource,
  type TopicRadarServicePort,
  type TopicRadarSnapshot,
  type TopicRadarStore,
} from "./types.js";

export class TopicRadarService implements TopicRadarServicePort {
  constructor(
    private readonly store: TopicRadarStore,
    private readonly provider: TopicRadarProvider,
    private readonly now = () => new Date(),
    private readonly options: { allowStaleFallback: boolean } = { allowStaleFallback: false },
  ) {}

  async listRankings(actor: TopicRadarActor): Promise<TopicRadarRankingsView> {
    return this.read(actor, { kind: "rankings" }) as Promise<TopicRadarRankingsView>;
  }

  async getRankingPage(
    actor: TopicRadarActor,
    input: { rankingId: string; subRankingId?: string; page: number },
  ): Promise<TopicRadarPageView> {
    assertPage(input.page);
    return this.read(actor, { kind: "ranking_page", ...input }) as Promise<TopicRadarPageView>;
  }

  async forceRefresh(
    actor: TopicRadarActor,
    target: TopicRadarResource,
  ): Promise<TopicRadarRankingsView | TopicRadarPageView> {
    if (!isAdministrator(actor.role)) throw new ForbiddenError("只有管理员可以手动刷新选题雷达");
    if (target.kind === "ranking_page") assertPage(target.page);
    return this.read(actor, target, "manual");
  }

  private async read(
    actor: TopicRadarActor,
    resource: TopicRadarResource,
    requestKind: "daily" | "manual" = "daily",
  ): Promise<TopicRadarRankingsView | TopicRadarPageView> {
    const now = this.now();
    const cacheDate = chinaDate(now);
    try {
      this.provider.assertReady?.();
    } catch (error) {
      if (isNotConfigured(error)) return this.unconfigured(resource);
      throw error;
    }
    const claim = await this.store.claimFetch({
      source: TOPIC_RADAR_SOURCE,
      resource,
      cacheDate,
      actorId: actor.id,
      now,
      requestKind,
    });
    if (claim.kind === "existing") {
      return this.existing(resource, claim.call.snapshotId, claim.call.status, claim.call.requestKind, cacheDate);
    }

    try {
      if (resource.kind === "rankings") {
        const result = await this.provider.fetchRankings();
        const snapshot = await this.store.completeCallSuccess({
          call: claim.call,
          // rank_date is non-null in the existing storage schema. The
          // normalized_data_date envelope below remains the public truth and
          // is null when the supplier did not provide a date.
          rankDate: result.rankDate ?? cacheDate,
          fetchedAt: this.now(),
          rawPayload: {
            provider: result.rawPayload,
            normalized_data_date: result.rankDate,
            rankings: result.rankings,
          },
          items: [],
        });
        return this.view(resource, snapshot, cacheDate);
      }
      const result = await this.provider.fetchRankingPage(resource);
      const snapshot = await this.store.completeCallSuccess({
        call: claim.call,
        rankDate: result.rankDate ?? cacheDate,
        fetchedAt: this.now(),
        rawPayload: {
          provider: result.rawPayload,
          normalized_data_date: result.rankDate,
        },
        items: result.items,
      });
      return this.view(resource, snapshot, cacheDate);
    } catch (error) {
      const failure = error instanceof AppError
        ? { code: error.code, message: error.message }
        : { code: "topic_radar_upstream_unavailable", message: "选题雷达来源暂时不可用，请稍后再试" };
      await this.store.completeCallFailure({
        call: claim.call,
        completedAt: this.now(),
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      if (!this.options.allowStaleFallback) throw error;
      if (requestKind === "manual") {
        if (error instanceof AppError) throw error;
        throw new AppError(502, failure.code, "选题榜单暂时不可用，请稍后再试。", true);
      }
      const fallback = await this.store.getLatestSnapshot(TOPIC_RADAR_SOURCE, resource);
      if (fallback) return this.view(resource, fallback, cacheDate, "stale");
      if (error instanceof AppError) throw error;
      throw new AppError(502, failure.code, "选题榜单暂时不可用，请稍后再试。", true);
    }
  }

  private async existing(
    resource: TopicRadarResource,
    snapshotId: string | null,
    status: string,
    requestKind: "daily" | "manual",
    cacheDate: string,
  ): Promise<TopicRadarRankingsView | TopicRadarPageView> {
    const snapshot = snapshotId ? await this.store.getSnapshot(snapshotId) : null;
    if (snapshot) return this.view(resource, snapshot, cacheDate);
    // A manual claim has its own once-per-day result/status. A daily snapshot
    // must never masquerade as that manual outcome.
    if (requestKind !== "manual" && this.options.allowStaleFallback) {
      const fallback = await this.store.getLatestSnapshot(TOPIC_RADAR_SOURCE, resource);
      if (fallback) return this.view(resource, fallback, cacheDate, "stale");
    }
    if (status === "fetching") throw new AppError(503, "topic_radar_refreshing", "选题雷达正在更新，请稍后再试", true);
    throw new AppError(503, "topic_radar_unavailable", "选题雷达暂时没有可用数据，请稍后再试", true);
  }

  private view(
    resource: TopicRadarResource,
    snapshot: TopicRadarSnapshot,
    cacheDate: string,
    freshnessOverride?: "stale",
  ): TopicRadarRankingsView | TopicRadarPageView {
    const freshness = freshnessOverride
      ?? (snapshot.cacheDate === cacheDate ? "fresh" as const : "stale" as const);
    const dataDate = snapshotDataDate(snapshot);
    if (resource.kind === "rankings") {
      const payload = snapshot.rawPayload as { rankings?: unknown };
      return {
        rankings: Array.isArray(payload.rankings) ? payload.rankings as TopicRadarRankingsView["rankings"] : [],
        dataDate,
        fetchedAt: snapshot.fetchedAt,
        freshness,
      };
    }
    const endReached = snapshot.items.length === 0;
    return {
      rankingId: resource.rankingId,
      ...(resource.subRankingId ? { subRankingId: resource.subRankingId } : {}),
      page: resource.page,
      items: snapshot.items,
      nextPage: endReached || resource.page === 50 ? null : resource.page + 1,
      endReached,
      dataDate,
      fetchedAt: snapshot.fetchedAt,
      freshness,
    };
  }

  private unconfigured(
    resource: TopicRadarResource,
  ): TopicRadarRankingsView | TopicRadarPageView {
    if (resource.kind === "rankings") {
      return {
        rankings: [],
        dataDate: null,
        fetchedAt: null,
        freshness: "unconfigured",
      };
    }
    return {
      rankingId: resource.rankingId,
      ...(resource.subRankingId ? { subRankingId: resource.subRankingId } : {}),
      page: resource.page,
      items: [],
      nextPage: null,
      endReached: true,
      dataDate: null,
      fetchedAt: null,
      freshness: "unconfigured",
    };
  }
}

export function createTopicRadarService(
  db: Database,
  dependencies: {
    store?: TopicRadarStore;
    provider?: TopicRadarProvider;
    now?: () => Date;
    allowStaleFallback?: boolean;
  } = {},
): TopicRadarService {
  return new TopicRadarService(
    dependencies.store ?? new TopicRadarRepository(db),
    dependencies.provider ?? new FiftyTwoApiTopicRadarProvider(topicRadarConfiguration()),
    dependencies.now,
    {
      allowStaleFallback: dependencies.allowStaleFallback
        ?? settings.appEnvironment === "production",
    },
  );
}

export function topicRadarConfiguration(
  source: Pick<typeof settings, "topicRadar52ApiEnabled" | "topicRadar52ApiKey" | "topicRadar52ApiTimeoutMs"> = settings,
): FiftyTwoApiTopicRadarConfiguration {
  return { enabled: source.topicRadar52ApiEnabled, apiKey: source.topicRadar52ApiKey, timeoutMs: source.topicRadar52ApiTimeoutMs };
}

function assertPage(page: number): void {
  if (!Number.isInteger(page) || page < 1 || page > 50) {
    throw new AppError(400, "topic_radar_page_out_of_range", "页码超出范围，请选择 1 到 50 页");
  }
}

function chinaDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function isNotConfigured(error: unknown): boolean {
  return error instanceof AppError && error.code === "topic_radar_not_configured";
}

function snapshotDataDate(snapshot: TopicRadarSnapshot): string | null {
  if (
    snapshot.rawPayload
    && typeof snapshot.rawPayload === "object"
    && !Array.isArray(snapshot.rawPayload)
    && Object.hasOwn(snapshot.rawPayload, "normalized_data_date")
  ) {
    const value = (snapshot.rawPayload as Record<string, unknown>).normalized_data_date;
    if (value === null) return null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return null;
  }
  // Compatibility for snapshots written before the normalized envelope.
  return snapshot.rankDate;
}
