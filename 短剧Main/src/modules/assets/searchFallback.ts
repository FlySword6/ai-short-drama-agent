import type { AssetSearchItem, JsonObject } from "../../domain/assets/types.js";
import { AssetCatalogService } from "./catalog.js";

export interface AssetPostgresSearchPort {
  list(
    actorId: string,
    filters: { scope: "personal" | "common"; query?: string; status?: string },
  ): Promise<Record<string, unknown>[]>;
}

/**
 * PostgreSQL is the formal asset source. This deliberately small recall path
 * is used when the rebuildable Milvus projection (or its embedding provider)
 * cannot serve a request. It uses the same access-filtered catalog query as
 * the ordinary asset list, so a vector outage cannot broaden visibility.
 */
export class AssetPostgresFallbackSearchService {
  private readonly catalog: AssetPostgresSearchPort;

  constructor(catalog: AssetPostgresSearchPort) {
    this.catalog = catalog;
  }

  async search(actorId: string, query: string, limit: number): Promise<AssetSearchItem[]> {
    const candidates = new Map<string, Record<string, unknown>>();
    for (const term of postgresSearchTerms(query)) {
      for (const scope of ["personal", "common"] as const) {
        const rows = await this.catalog.list(actorId, {
          scope,
          query: term,
          ...(scope === "common" ? { status: "approved" } : {}),
        });
        for (const row of rows) {
          const id = stringValue(row.id);
          if (id && !candidates.has(id)) candidates.set(id, row);
        }
      }
    }
    return [...candidates.values()].slice(0, limit).map(toFallbackSearchItem);
  }
}

export function createAssetPostgresFallbackSearch(catalog: AssetCatalogService): AssetPostgresFallbackSearchService {
  return new AssetPostgresFallbackSearchService(catalog);
}

/**
 * Keep the original expression first, then add CJK n-grams. This is not a
 * replacement for semantic search; it is a bounded, deterministic fallback
 * for natural-language queries such as "红斗篷少女" in PostgreSQL ILIKE.
 */
export function postgresSearchTerms(query: string): string[] {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  const compact = normalized.replace(/[\s，。！？、；：,!.?;:]/g, "");
  // Intent prefixes help a person phrase a search but are poor ILIKE anchors.
  // Remove them only for the bounded n-gram expansion; retain the full query.
  const searchable = compact.replace(/^(想找|搜索|查找|找|需要)/, "");
  const values = [normalized];
  // Short CJK phrases carry the most useful SQL fallback anchors. Preserve
  // them before longer n-grams, otherwise a long sentence can exhaust the
  // bounded query budget before terms such as "红斗篷" or "少女" are reached.
  for (const length of [2, 3, 4]) {
    for (let start = 0; start + length <= searchable.length; start += 1) {
      values.push(searchable.slice(start, start + length));
    }
  }
  return [...new Set(values)].slice(0, 12);
}

function toFallbackSearchItem(row: Record<string, unknown>): AssetSearchItem {
  const metadata = jsonObject(row.metadata);
  const primaryImage = jsonObject(metadata.primaryImage);
  return {
    score: null,
    sourceTable: "asset_entities",
    sourceId: stringValue(row.id),
    assetKind: nullableString(row.assetKind),
    name: nullableString(row.name),
    displayName: nullableString(row.displayName),
    parentEntityId: null,
    parentEntityName: null,
    intro: nullableString(row.intro),
    appearance: nullableString(row.appearance),
    description: null,
    usageContext: null,
    visualPrompt: null,
    sourceFileUrl: nullableString(row.sourceFileUrl) ?? nullableString(row.storageUrl),
    metadata: {
      ...metadata,
      ...(Object.keys(primaryImage).length ? { primary_image: primaryImage } : {}),
      search_mode: "postgres_fallback",
    },
    vectorText: null,
  };
}

function jsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
