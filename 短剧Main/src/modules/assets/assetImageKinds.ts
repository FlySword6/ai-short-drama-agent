import {
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

/**
 * Asset-media image roles.
 *
 * `media_kind` predates the current separation between physical media type and
 * an image's business role. Excel imports therefore store role-specific values
 * in the same column. All asset display/search/repair readers must use this
 * single definition instead of treating only the literal `image` as a picture.
 */
export const ASSET_IMAGE_MEDIA_KINDS = [
  "image",
  "character_final",
  "character_reference",
  "character_turnaround",
  "costume_reference",
  "scene_final",
  "scene_multi_view",
  "scene_reference",
  "animal_reference",
  "cinematography_reference",
  "video_reference",
  "other",
] as const;

export type AssetImageMediaKind = typeof ASSET_IMAGE_MEDIA_KINDS[number];

const assetImageMediaKinds = new Set<string>(ASSET_IMAGE_MEDIA_KINDS);

export function isAssetImageMediaKind(
  value: string | null | undefined,
): value is AssetImageMediaKind {
  return typeof value === "string" && assetImageMediaKinds.has(value);
}

/** Parameterized PostgreSQL predicate derived from the same image-role list. */
export function assetImageMediaKindSql(column: SQLWrapper): SQL {
  const values = sql.join(
    ASSET_IMAGE_MEDIA_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql`${column} in (${values})`;
}
