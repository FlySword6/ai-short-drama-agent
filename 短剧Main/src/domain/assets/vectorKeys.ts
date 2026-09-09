export const ASSET_VECTOR_SOURCE_TABLES = ["asset_entities", "asset_variants", "asset_media"] as const;
export type AssetVectorSourceTable = (typeof ASSET_VECTOR_SOURCE_TABLES)[number];

/**
 * `full` is the single-vector runtime projection. The other facets are the
 * deterministic multi-vector rebuild projection. Keeping the complete set
 * here lets permanent deletion remove both generations of keys.
 */
export const ASSET_VECTOR_FACETS = ["identity", "profile", "style", "full"] as const;
export type AssetVectorFacet = (typeof ASSET_VECTOR_FACETS)[number];

export const REBUILD_ASSET_VECTOR_FACETS = ["identity", "profile", "style"] as const;
export type RebuildAssetVectorFacet = (typeof REBUILD_ASSET_VECTOR_FACETS)[number];

export interface ParsedAssetVectorId {
  sourceTable: AssetVectorSourceTable;
  sourceId: string;
  facet: string | null;
}

/**
 * The only constructor for asset vector primary keys.
 *
 * A facet-less compound key is retained only for cleanup compatibility. New
 * writes must always provide a facet.
 */
export function buildAssetVectorId(
  sourceTable: AssetVectorSourceTable,
  sourceId: string,
  facet?: string,
): string {
  const normalizedSourceId = sourceId.trim();
  if (!normalizedSourceId) throw new Error("Asset vector source ID must not be empty");
  const normalizedFacet = facet?.trim();
  return normalizedFacet
    ? `${sourceTable}:${normalizedSourceId}:${normalizedFacet}`
    : `${sourceTable}:${normalizedSourceId}`;
}

/**
 * Includes both historical formats (bare UUID and facet-less compound key)
 * plus every canonical facet key that this repository knows how to write.
 */
export function buildAssetVectorDeletionIds(
  sourceTable: AssetVectorSourceTable,
  sourceId: string,
): string[] {
  const normalizedSourceId = sourceId.trim();
  if (!normalizedSourceId) return [];
  return [
    normalizedSourceId,
    buildAssetVectorId(sourceTable, normalizedSourceId),
    ...ASSET_VECTOR_FACETS.map((facet) => buildAssetVectorId(sourceTable, normalizedSourceId, facet)),
  ];
}

export function parseAssetVectorId(vectorId: string): ParsedAssetVectorId | null {
  const match = /^(asset_entities|asset_variants|asset_media):([^:]+)(?::([^:]+))?$/.exec(vectorId.trim());
  if (!match?.[1] || !match[2]) return null;
  return {
    sourceTable: match[1] as AssetVectorSourceTable,
    sourceId: match[2],
    facet: match[3] ?? null,
  };
}
