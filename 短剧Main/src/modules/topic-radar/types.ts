import { createHash } from "node:crypto";
import type { PlatformRole } from "../auth/types.js";

export const TOPIC_RADAR_SOURCE = "52api_hongguo_ranking" as const;
export type TopicRadarSource = typeof TOPIC_RADAR_SOURCE;
export type TopicRadarRequestKind = "daily" | "manual";
export type TopicRadarCallStatus = "fetching" | "succeeded" | "failed";
export type TopicRadarFreshness = "fresh" | "stale" | "unconfigured";

export type TopicRadarResource =
  | { kind: "rankings" }
  | { kind: "ranking_page"; rankingId: string; subRankingId?: string; page: number };

export interface TopicRadarActor {
  id: string;
  role?: PlatformRole;
}

export interface TopicRadarItem {
  rank: number | null;
  title: string;
  heat: string | null;
  link: string | null;
}

export interface TopicRadarRanking {
  id: string;
  name: string;
  subRankings: Array<{ id: string; name: string }>;
}

export interface TopicRadarSnapshot {
  id: string;
  source: TopicRadarSource;
  resourceScope: string;
  cacheDate: string;
  rankDate: string;
  fetchedAt: Date;
  items: TopicRadarItem[];
  rawPayload: unknown;
}

export interface TopicRadarUpstreamCall {
  id: string;
  source: TopicRadarSource;
  resourceScope: string;
  cacheDate: string;
  requestKind: TopicRadarRequestKind;
  status: TopicRadarCallStatus;
  snapshotId: string | null;
  startedAt: Date;
}

export interface TopicRadarProviderResult {
  rankDate: string | null;
  items: Array<TopicRadarItem & { rawItem: unknown }>;
  rawPayload: unknown;
}

export interface TopicRadarRankingsProviderResult {
  rankDate: string | null;
  rankings: TopicRadarRanking[];
  rawPayload: unknown;
}

export interface TopicRadarProvider {
  assertReady?(): void;
  fetchRankings(): Promise<TopicRadarRankingsProviderResult>;
  fetchRankingPage(input: {
    rankingId: string;
    subRankingId?: string;
    page: number;
  }): Promise<TopicRadarProviderResult>;
}

export type FetchClaim = {
  kind: "claimed" | "existing";
  call: TopicRadarUpstreamCall;
};

export interface TopicRadarStore {
  claimFetch(input: {
    source: TopicRadarSource;
    resource: TopicRadarResource;
    cacheDate: string;
    actorId: string;
    now: Date;
    requestKind: TopicRadarRequestKind;
  }): Promise<FetchClaim>;
  completeCallSuccess(input: {
    call: TopicRadarUpstreamCall;
    rankDate: string;
    fetchedAt: Date;
    rawPayload: unknown;
    items: Array<TopicRadarItem & { rawItem: unknown }>;
  }): Promise<TopicRadarSnapshot>;
  completeCallFailure(input: {
    call: TopicRadarUpstreamCall;
    completedAt: Date;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
  getSnapshot(id: string): Promise<TopicRadarSnapshot | null>;
  getLatestSnapshot(source: TopicRadarSource, resource: TopicRadarResource): Promise<TopicRadarSnapshot | null>;
}

export interface TopicRadarRankingsView {
  rankings: TopicRadarRanking[];
  dataDate: string | null;
  fetchedAt: Date | null;
  freshness: TopicRadarFreshness;
}

export interface TopicRadarPageView {
  rankingId: string;
  subRankingId?: string;
  page: number;
  items: TopicRadarItem[];
  nextPage: number | null;
  endReached: boolean;
  dataDate: string | null;
  fetchedAt: Date | null;
  freshness: TopicRadarFreshness;
}

export interface TopicRadarServicePort {
  listRankings(actor: TopicRadarActor): Promise<TopicRadarRankingsView>;
  getRankingPage(actor: TopicRadarActor, input: {
    rankingId: string;
    subRankingId?: string;
    page: number;
  }): Promise<TopicRadarPageView>;
  forceRefresh(actor: TopicRadarActor, target: TopicRadarResource): Promise<TopicRadarRankingsView | TopicRadarPageView>;
}

export function resourceScope(resource: TopicRadarResource): string {
  if (resource.kind === "rankings") return "rankings";
  const encoded = JSON.stringify([resource.rankingId, resource.subRankingId ?? null, resource.page]);
  return `ranking_page:${createHash("sha256").update(encoded).digest("hex")}`;
}
