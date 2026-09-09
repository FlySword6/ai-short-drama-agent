import type { AssetSearchItem } from "../../domain/assets/types.js";
import { VectorProjectionUnavailableError, type AssetSearchService } from "../../services/searchService.js";
import { ExternalServiceError } from "../../shared/errors.js";
import type { AssetPostgresFallbackSearchService } from "./searchFallback.js";

/**
 * One application-level boundary for the rebuildable semantic projection.
 * PostgreSQL remains the source of record, so an unavailable embedding or
 * Milvus projection falls back to the access-filtered catalog search. This
 * deliberately has no HTTP dependency: route handlers, Pi tools, and AI
 * services must share the same behaviour.
 */
export interface AssetSearchFailoverResult {
  items: AssetSearchItem[];
  mode: "hybrid" | "structured_fallback";
  /** A stable public signal; never expose raw vendor failure text. */
  degradedReason?: "semantic_search_unavailable";
}

export async function searchWithPostgresFailoverResult(
  semantic: Pick<AssetSearchService, "search">,
  fallback: Pick<AssetPostgresFallbackSearchService, "search">,
  actorId: string,
  query: string,
  limit: number,
): Promise<AssetSearchFailoverResult> {
  try {
    return { items: await semantic.search(query, limit, actorId), mode: "hybrid" };
  } catch (error) {
    // Do not turn malformed input, permission failures, LLM failures, or
    // PostgreSQL failures into a misleading empty search. Only the rebuildable
    // vector projection is allowed to fall back.
    if (!isRebuildableSearchDependencyFailure(error)) throw error;
    return {
      items: await fallback.search(actorId, query, limit),
      mode: "structured_fallback",
      degradedReason: "semantic_search_unavailable",
    };
  }
}

export async function searchWithPostgresFailover(
  semantic: Pick<AssetSearchService, "search">,
  fallback: Pick<AssetPostgresFallbackSearchService, "search">,
  actorId: string,
  query: string,
  limit: number,
): Promise<AssetSearchItem[]> {
  return (await searchWithPostgresFailoverResult(semantic, fallback, actorId, query, limit)).items;
}

/**
 * `ExternalServiceError` is also used by Ark, so it is intentionally not a
 * blanket retry/fallback signal. The compatibility path recognises only the
 * pre-existing projection adapter service labels until every adapter emits the
 * typed VectorProjectionUnavailableError directly.
 */
export function isRebuildableSearchDependencyFailure(error: unknown): boolean {
  if (error instanceof VectorProjectionUnavailableError) return true;
  if (!(error instanceof ExternalServiceError)) return false;

  const service = error.message.split(":", 1)[0]?.trim().toLowerCase() ?? "";
  return service === "milvus"
    || service === "embedding"
    || service === "doubao embedding"
    || service === "资产语义索引";
}
